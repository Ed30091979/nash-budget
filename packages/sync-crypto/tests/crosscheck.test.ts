/**
 * Cross-checks against a second, independent implementation.
 *
 * Everything in this package except Argon2id comes from WebCrypto, and a vector that a package
 * computes and then compares against its own earlier output proves only that it has not changed.
 * Node's `node:crypto` is a different implementation of the same standards — RFC 5869 for HKDF,
 * FIPS 198 for HMAC, SP 800-38D for GCM — so agreeing with it is evidence of the construction
 * being what the document describes rather than merely being stable.
 *
 * `node:crypto` appears **only here**. The package itself must run unchanged in the browser and in
 * the Capacitor shell, and the last test in this file is what keeps it that way.
 */
import { readdirSync, readFileSync } from "node:fs";
import {
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_DIGEST_LABEL,
  CHECKPOINT_PREV_LABEL,
  checkpointDigest,
  checkpointSeedDigest,
  computeBindProof,
  computeEpochConfirm,
  deriveInviteSecrets,
  deviceKeyFingerprint,
  ENVELOPE_VERSION,
  envelopeAad,
  exportFamilyKey,
  generateFamilyKey,
  inviteSalt,
  sealEnvelope,
  toHex,
  wrapFamilyKey,
  type EnvelopeHeader,
} from "../src/index.js";
import {
  DEVICE_A,
  DEVICE_B,
  FAMILY_ID,
  INVITE_ID,
  OP_ID,
  OP_ID_2,
  OP_ID_3,
  ROTATION_ID,
  makeDevice,
} from "./support.js";

/** `enc` of 5.2, written out the long way with Node buffers. */
function encByHand(...values: ReadonlyArray<string | number | Uint8Array>): Buffer {
  const parts: Buffer[] = [];
  for (const value of values) {
    const bytes =
      typeof value === "string"
        ? Buffer.from(value, "utf8")
        : typeof value === "number"
          ? Buffer.from(String(value), "utf8")
          : Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

describe("the envelope is ordinary AES-256-GCM over the AAD the document names", () => {
  it("decrypts under node:crypto with the header as additional data", async () => {
    const familyKey = await generateFamilyKey();
    const raw = Buffer.from(await exportFamilyKey(familyKey));
    const plaintext = Buffer.from("операция в каноническом JSON", "utf8");
    const header: EnvelopeHeader = {
      envelopeVersion: ENVELOPE_VERSION,
      kind: "operation",
      familyId: FAMILY_ID,
      opId: OP_ID,
      deviceId: DEVICE_A,
      keyEpoch: 3,
    };
    const envelope = await sealEnvelope(familyKey, header, plaintext);

    const body = Buffer.from(envelope.ciphertext.slice(0, -16));
    const tag = Buffer.from(envelope.ciphertext.slice(-16));
    const decipher = createDecipheriv("aes-256-gcm", raw, Buffer.from(envelope.iv));
    decipher.setAAD(encByHand(ENVELOPE_VERSION, "operation", FAMILY_ID, OP_ID, DEVICE_A, 3));
    decipher.setAuthTag(tag);
    const opened = Buffer.concat([decipher.update(body), decipher.final()]);
    expect(opened.toString("utf8")).toBe(plaintext.toString("utf8"));
  });

  it("agrees with a hand-built AAD, byte for byte", () => {
    const header: EnvelopeHeader = {
      envelopeVersion: 1,
      kind: "checkpoint",
      familyId: FAMILY_ID,
      opId: OP_ID,
      deviceId: DEVICE_B,
      keyEpoch: 12,
    };
    expect(toHex(envelopeAad(header))).toBe(
      encByHand(1, "checkpoint", FAMILY_ID, OP_ID, DEVICE_B, 12).toString("hex"),
    );
  });

  it("refuses under node:crypto once one AAD byte is different", async () => {
    const familyKey = await generateFamilyKey();
    const raw = Buffer.from(await exportFamilyKey(familyKey));
    const header: EnvelopeHeader = {
      envelopeVersion: ENVELOPE_VERSION,
      kind: "operation",
      familyId: FAMILY_ID,
      opId: OP_ID,
      deviceId: DEVICE_A,
      keyEpoch: 3,
    };
    const envelope = await sealEnvelope(familyKey, header, Buffer.from("x"));
    const decipher = createDecipheriv("aes-256-gcm", raw, Buffer.from(envelope.iv));
    decipher.setAAD(encByHand(ENVELOPE_VERSION, "operation", FAMILY_ID, OP_ID, DEVICE_A, 4));
    decipher.setAuthTag(Buffer.from(envelope.ciphertext.slice(-16)));
    decipher.update(Buffer.from(envelope.ciphertext.slice(0, -16)));
    expect(() => decipher.final()).toThrow();
  });
});

describe("the derived values agree with node:crypto", () => {
  it("computes the invite salt as SHA-256 over the enc list", async () => {
    const code = "ABCDEFGHJKMN";
    expect(toHex(await inviteSalt(code))).toBe(
      createHash("sha256").update(encByHand("nash-budget/invite/v1", code)).digest("hex"),
    );
  });

  it("computes the checkpoint digest as SHA-256 over the labelled enc list (3.6)", async () => {
    // The identifiers go in sorted, and `opCount` goes in ahead of them — both spelled out here
    // rather than taken from the implementation, so the vector says what the document says.
    const sorted = [OP_ID, OP_ID_2, OP_ID_3].sort();
    expect(
      toHex(await checkpointDigest({ familyId: FAMILY_ID, keyEpoch: 7, opIds: [OP_ID_3, OP_ID, OP_ID_2] })),
    ).toBe(
      createHash("sha256")
        .update(encByHand(CHECKPOINT_DIGEST_LABEL, FAMILY_ID, 7, 3, ...sorted))
        .digest("hex"),
    );
  });

  it("computes the first prevDigest of a chain over family, epoch and device (3.6)", async () => {
    expect(
      toHex(await checkpointSeedDigest({ familyId: FAMILY_ID, keyEpoch: 4, deviceId: DEVICE_A })),
    ).toBe(
      createHash("sha256")
        .update(encByHand(CHECKPOINT_PREV_LABEL, FAMILY_ID, 4, DEVICE_A))
        .digest("hex"),
    );
  });

  it("computes rotateConfirm as HKDF then HMAC, exactly as 5.4 writes it", async () => {
    const previousFamilyKey = await generateFamilyKey();
    const nextFamilyKey = await generateFamilyKey();
    const confirm = await computeEpochConfirm({
      previousFamilyKey,
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
      nextFamilyKey,
    });

    const previousRaw = Buffer.from(await exportFamilyKey(previousFamilyKey));
    const nextRaw = Buffer.from(await exportFamilyKey(nextFamilyKey));
    const confirmKey = Buffer.from(
      hkdfSync(
        "sha256",
        previousRaw,
        Buffer.alloc(0),
        encByHand("nash-budget/rotate-confirm/v1", FAMILY_ID),
        32,
      ),
    );
    const expected = createHmac("sha256", confirmKey)
      .update(
        encByHand(
          FAMILY_ID,
          2,
          ROTATION_ID,
          createHash("sha256").update(nextRaw).digest(),
        ),
      )
      .digest("hex");
    expect(toHex(confirm)).toBe(expected);
  });

  it("computes bindProof as HMAC over the labelled enc list", async () => {
    const joiner = await makeDevice(DEVICE_B);
    const secrets = await deriveInviteSecrets("ABCDEFGHJKMN");
    const proof = await computeBindProof(secrets.bindKey, {
      familyId: FAMILY_ID,
      inviteId: INVITE_ID,
      deviceId: DEVICE_B,
      spki: joiner.spki,
    });
    const expected = createHmac("sha256", Buffer.from(secrets.bindKey))
      .update(encByHand("nash-budget/bind/v1", FAMILY_ID, INVITE_ID, DEVICE_B, joiner.spki))
      .digest("hex");
    expect(toHex(proof)).toBe(expected);
  });
});

describe("the key wrap of 5.4 is ECDH, then HKDF, then GCM — and nothing else", () => {
  it("is opened by node:crypto from the other side of the exchange", async () => {
    // The longest derivation in the package, and until here the only one checked against nothing
    // but itself: a static P-256 exchange, HKDF over the shared secret with the wrap's own salt and
    // an `info` that names both devices and both key fingerprints, then AES-GCM under a much
    // shorter AAD. Node is given the *recipient's* private key and the sender's public one, so it
    // walks the exchange from the opposite end — if the two ends did not agree on the shared secret
    // the HKDF output would differ and the tag would not verify.
    //
    // The pair is generated extractable here only so that Node can be handed the private half.
    // `generateDeviceKeyPair` makes its pairs non-extractable and real devices keep them that way;
    // `wrapFamilyKey` never exports a private key, so the difference does not reach the code under
    // test.
    const algorithm = { name: "ECDH", namedCurve: "P-256" } as const;
    const sender = (await crypto.subtle.generateKey(algorithm, true, ["deriveBits"])) as CryptoKeyPair;
    const recipient = (await crypto.subtle.generateKey(algorithm, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const senderSpki = new Uint8Array(await crypto.subtle.exportKey("spki", sender.publicKey));
    const recipientSpki = new Uint8Array(await crypto.subtle.exportKey("spki", recipient.publicKey));

    const familyKey = await generateFamilyKey();
    const wrap = await wrapFamilyKey({
      familyKey,
      senderPrivateKey: sender.privateKey,
      senderSpki,
      senderDeviceId: DEVICE_A,
      recipientSpki,
      recipientDeviceId: DEVICE_B,
      pinnedRecipientFingerprint: await deviceKeyFingerprint(recipientSpki),
      familyId: FAMILY_ID,
      keyEpoch: 7,
      rotationId: ROTATION_ID,
    });

    const shared = diffieHellman({
      privateKey: createPrivateKey({
        key: Buffer.from(await crypto.subtle.exportKey("pkcs8", recipient.privateKey)),
        format: "der",
        type: "pkcs8",
      }),
      publicKey: createPublicKey({ key: Buffer.from(senderSpki), format: "der", type: "spki" }),
    });
    const info = encByHand(
      "nash-budget/rotate/v1",
      FAMILY_ID,
      7,
      ROTATION_ID,
      DEVICE_A,
      DEVICE_B,
      createHash("sha256").update(senderSpki).digest(),
      createHash("sha256").update(recipientSpki).digest(),
    );
    const wrappingKey = Buffer.from(
      hkdfSync("sha256", shared, Buffer.from(wrap.salt), info, 32),
    );

    const decipher = createDecipheriv("aes-256-gcm", wrappingKey, Buffer.from(wrap.iv));
    decipher.setAAD(encByHand(FAMILY_ID, 7, ROTATION_ID, DEVICE_B));
    decipher.setAuthTag(Buffer.from(wrap.ciphertext.slice(-16)));
    const opened = Buffer.concat([
      decipher.update(Buffer.from(wrap.ciphertext.slice(0, -16))),
      decipher.final(),
    ]);
    expect(opened.toString("hex")).toBe(toHex(await exportFamilyKey(familyKey)));
  });
});

describe("the package stays runnable in a browser", () => {
  it("imports nothing but hash-wasm and its own modules", () => {
    // 5.2 and 5.3 together: AES-GCM, HKDF, ECDH and SHA-256 come from WebCrypto, and Argon2id from
    // exactly one pinned WASM package. A `node:` import here would compile and pass every test in
    // this repository and then fail in the PWA, where there is no second chance to notice.
    //
    // Every form that loads a module is looked for, not only `import … from`: a bare
    // `import "node:crypto"` taken for its side effects, a lazy `await import("node:fs")` and a
    // `require` left behind by a copy-paste all pull the module in just the same, and a check that
    // knew only the first form would wave the other three through. The walk recurses for the same
    // reason — `src` is flat today, and a scan that stops at the first subdirectory stops
    // protecting anything the moment somebody adds one.
    //
    // Where each of the two defences ends, stated plainly so that neither is trusted past it.
    // *This* one reads the source as text: it sees every literal specifier and cannot see one that
    // is computed, because there is no string in the file to read. The second one — `types: []` in
    // `tsconfig.src.json` — takes away the Node globals and the ambient `node:` declarations, so a
    // literal `import "node:fs"` fails to compile there; a computed specifier resolves at run time
    // and is typed `any`, so it passes that gate too. The overlap of the two is literal imports,
    // and the gap common to both is exactly the computed specifier. So the loop below does not try
    // to evaluate one — it refuses the form outright. The package has no dynamic import today and
    // no reason to acquire one, and if that ever changes this test is the right place to argue it.
    const sourceDir = fileURLToPath(new URL("../src/", import.meta.url));
    const offenders: string[] = [];
    let scanned = 0;

    const scan = (directory: string, prefix: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = `${directory}${entry.name}`;
        if (entry.isDirectory()) {
          scan(`${path}/`, `${prefix}${entry.name}/`);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        scanned += 1;
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/gu)) {
          const specifier = match[1]!;
          if (specifier.startsWith("./") || specifier === "hash-wasm") continue;
          offenders.push(`${prefix}${entry.name}: ${specifier}`);
        }
        for (const match of text.matchAll(/(?<![.\w$])(?:import|require)\s*\(\s*(?!["'])/gu)) {
          offenders.push(`${prefix}${entry.name}: computed specifier at ${match.index}`);
        }
      }
    };

    scan(sourceDir, "");
    expect(offenders).toEqual([]);

    // The arms above, aimed at text that is not in `src`, so that a scan which quietly matched
    // nothing could not pass for a scan that found nothing.
    const literal = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/gu;
    const computed = /(?<![.\w$])(?:import|require)\s*\(\s*(?!["'])/gu;
    expect(`import "node:crypto";`.match(literal)).not.toBeNull();
    expect(`const fs = await import(name);`.match(computed)).not.toBeNull();
    expect(`const fs = require(modules[0]);`.match(computed)).not.toBeNull();
    // And no false alarm on the shapes `src` actually contains.
    expect(`const url = import.meta.url;`.match(computed)).toBeNull();
    expect(`await importSpki(params.recipientSpki);`.match(computed)).toBeNull();
    expect(`await import("./encoding.js");`.match(computed)).toBeNull();
    // A mistyped path would make the walk above find nothing and pass, which is the one way this
    // test could stop guarding the package without ever turning red.
    expect(scanned).toBeGreaterThanOrEqual(5);
  });
});
