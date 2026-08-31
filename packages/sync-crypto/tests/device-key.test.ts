import { describe, expect, it } from "vitest";

import {
  computeOwnerAnnounce,
  deviceKeyFingerprint,
  exportFamilyKey,
  FINGERPRINT_SYMBOLS,
  formatKeyFingerprint,
  generateDeviceKeyPair,
  generateFamilyKey,
  exportDevicePublicKey,
  SyncCryptoError,
  toHex,
  unwrapFamilyKey,
  verifyOwnerAnnounce,
  wrapFamilyKey,
  WRAP_SALT_BYTES,
  type KeyWrap,
} from "../src/index.js";
import {
  DEVICE_A,
  DEVICE_B,
  DEVICE_C,
  FAMILY_ID,
  ROTATION_ID,
  ROTATION_ID_2,
  flipByte,
  makeDevice,
  type Device,
} from "./support.js";

interface Pair {
  readonly owner: Device;
  readonly member: Device;
  readonly familyKey: CryptoKey;
}

async function pair(): Promise<Pair> {
  return {
    owner: await makeDevice(DEVICE_A),
    member: await makeDevice(DEVICE_B),
    familyKey: await generateFamilyKey(),
  };
}

async function wrapFor(
  context: Pair,
  overrides: {
    readonly keyEpoch?: number;
    readonly rotationId?: string;
    readonly pinnedRecipientFingerprint?: Uint8Array;
  } = {},
): Promise<KeyWrap> {
  return wrapFamilyKey({
    familyKey: context.familyKey,
    senderPrivateKey: context.owner.keyPair.privateKey,
    senderSpki: context.owner.spki,
    senderDeviceId: context.owner.deviceId,
    recipientSpki: context.member.spki,
    recipientDeviceId: context.member.deviceId,
    pinnedRecipientFingerprint:
      overrides.pinnedRecipientFingerprint ?? (await deviceKeyFingerprint(context.member.spki)),
    familyId: FAMILY_ID,
    keyEpoch: overrides.keyEpoch ?? 2,
    rotationId: overrides.rotationId ?? ROTATION_ID,
  });
}

async function unwrapWith(
  context: Pair,
  wrap: KeyWrap,
  overrides: {
    readonly senderSpki?: Uint8Array;
    readonly pinnedSenderFingerprint?: Uint8Array;
  } = {},
): Promise<CryptoKey> {
  return unwrapFamilyKey({
    wrap,
    recipientPrivateKey: context.member.keyPair.privateKey,
    recipientSpki: context.member.spki,
    senderSpki: overrides.senderSpki ?? context.owner.spki,
    pinnedSenderFingerprint:
      overrides.pinnedSenderFingerprint ?? (await deviceKeyFingerprint(context.owner.spki)),
  });
}

/** The code of the refusal a call produced, and a failure if it produced no refusal at all. */
async function refusalCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SyncCryptoError);
    return (error as SyncCryptoError).code;
  }
  throw new Error("expected a refusal, got a value");
}

describe("the device key of 5.4", () => {
  it("is ECDH P-256 with a private half that cannot be exported", async () => {
    const keyPair = await generateDeviceKeyPair();
    expect((keyPair.publicKey.algorithm as EcKeyAlgorithm).namedCurve).toBe("P-256");
    expect(keyPair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).rejects.toThrow();
    expect(await exportDevicePublicKey(keyPair.publicKey)).toBeInstanceOf(Uint8Array);
  });

  it("fingerprints the SPKI with SHA-256 and shows a hundred bits of it", async () => {
    const device = await makeDevice(DEVICE_A);
    const fingerprint = await deviceKeyFingerprint(device.spki);
    expect(fingerprint).toHaveLength(32);

    const shown = formatKeyFingerprint(fingerprint);
    expect(FINGERPRINT_SYMBOLS).toBe(20);
    expect(shown).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/u);
    expect(shown.replaceAll("-", "")).toHaveLength(20);
  });

  it("shows a different value for a different key", async () => {
    const first = await makeDevice(DEVICE_A);
    const second = await makeDevice(DEVICE_B);
    expect(formatKeyFingerprint(await deviceKeyFingerprint(first.spki))).not.toBe(
      formatKeyFingerprint(await deviceKeyFingerprint(second.spki)),
    );
  });
});

describe("the key wrap of 5.4", () => {
  it("delivers the family key to the recipient device", async () => {
    const context = await pair();
    const wrap = await wrapFor(context);
    const delivered = await unwrapWith(context, wrap);
    expect(toHex(await exportFamilyKey(delivered))).toBe(toHex(await exportFamilyKey(context.familyKey)));
  });

  it("carries a fresh 32-byte salt and a fresh IV on every wrap", async () => {
    const context = await pair();
    const salts = new Set<string>();
    const ivs = new Set<string>();
    for (let index = 0; index < 8; index += 1) {
      const wrap = await wrapFor(context);
      expect(wrap.salt).toHaveLength(WRAP_SALT_BYTES);
      salts.add(toHex(wrap.salt));
      ivs.add(toHex(wrap.iv));
    }
    // The case this closes is real: a rotation is interrupted, the epoch stays the same, and the
    // owner derives a wrap for the same pair of devices again. A static ECDH pair gives always the
    // same shared secret, so a fixed salt would repeat the wrapping key — and a repeated IV under a
    // repeated AES-GCM key destroys both confidentiality and integrity.
    expect(salts.size).toBe(8);
    expect(ivs.size).toBe(8);
  });

  it("refuses a wrap whose sender key does not hash to the pinned fingerprint", async () => {
    // The scenario 5.4 spells out: the server mints its own pair and its own FK*, wraps FK* for the
    // genuine pubB and presents its pubM as the owner's key. Everything downstream would verify.
    const context = await pair();
    const server = await makeDevice(DEVICE_C);
    const forged = await wrapFamilyKey({
      familyKey: await generateFamilyKey(),
      senderPrivateKey: server.keyPair.privateKey,
      senderSpki: server.spki,
      senderDeviceId: context.owner.deviceId,
      recipientSpki: context.member.spki,
      recipientDeviceId: context.member.deviceId,
      pinnedRecipientFingerprint: await deviceKeyFingerprint(context.member.spki),
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
    });
    await expect(unwrapWith(context, forged, { senderSpki: server.spki })).rejects.toMatchObject({
      code: "sender_key_mismatch",
    });
  });

  it("refuses to wrap onto a recipient key that does not hash to the pin", async () => {
    // The mirror of the test above, and the direction that gives the key away rather than merely
    // refusing one. A server that answers the device list with its own SPKI in place of B's gets,
    // from a caller that wraps whatever the list contained, a wrap it can open itself — the family
    // key handed over by the owner's own device, and every check further down still passing.
    const context = await pair();
    const server = await makeDevice(DEVICE_C);
    await expect(
      wrapFamilyKey({
        familyKey: context.familyKey,
        senderPrivateKey: context.owner.keyPair.privateKey,
        senderSpki: context.owner.spki,
        senderDeviceId: context.owner.deviceId,
        recipientSpki: server.spki,
        recipientDeviceId: context.member.deviceId,
        pinnedRecipientFingerprint: await deviceKeyFingerprint(context.member.spki),
        familyId: FAMILY_ID,
        keyEpoch: 2,
        rotationId: ROTATION_ID,
      }),
    ).rejects.toMatchObject({ code: "recipient_key_mismatch" });
  });

  it("names the wrap side apart from the unwrap side", async () => {
    // Two codes, not one. "I was handed a key I do not trust" and "I was about to wrap the family
    // key onto a key I do not trust" are different sentences to the user and different reactions
    // in the caller, and a single code would erase the difference exactly where it matters.
    const context = await pair();
    const server = await makeDevice(DEVICE_C);
    const wrapCode = await refusalCode(
      wrapFor(context, { pinnedRecipientFingerprint: await deviceKeyFingerprint(server.spki) }),
    );
    const unwrapCode = await refusalCode(
      unwrapWith(context, await wrapFor(context), { senderSpki: server.spki }),
    );
    expect(wrapCode).toBe("recipient_key_mismatch");
    expect(unwrapCode).toBe("sender_key_mismatch");
    expect(wrapCode).not.toBe(unwrapCode);
  });

  it("refuses before the delivered recipient key is parsed at all", async () => {
    // Same order as the unwrap side: hash, compare in constant time, and only then use. A
    // structurally invalid SPKI has to come back as a mismatch and not as whatever the WebCrypto
    // importer throws, because the importer running at all means the unpinned bytes were used.
    const context = await pair();
    await expect(
      wrapFamilyKey({
        familyKey: context.familyKey,
        senderPrivateKey: context.owner.keyPair.privateKey,
        senderSpki: context.owner.spki,
        senderDeviceId: context.owner.deviceId,
        recipientSpki: new Uint8Array([1, 2, 3]),
        recipientDeviceId: context.member.deviceId,
        pinnedRecipientFingerprint: await deviceKeyFingerprint(context.member.spki),
        familyId: FAMILY_ID,
        keyEpoch: 2,
        rotationId: ROTATION_ID,
      }),
    ).rejects.toMatchObject({ code: "recipient_key_mismatch" });
  });

  it("compares the fingerprint before it touches the delivered key at all", async () => {
    // "Derive on the pinned key" would be unimplementable — what is pinned is the fingerprint, and
    // the full SPKI still arrives from the server. So the hash check has to come first, and a
    // structurally invalid SPKI must fail as a mismatch rather than as a parse error.
    const context = await pair();
    const wrap = await wrapFor(context);
    await expect(
      unwrapWith(context, wrap, { senderSpki: new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({ code: "sender_key_mismatch" });
  });

  it("refuses a wrap addressed to another device", async () => {
    const context = await pair();
    const stranger = await makeDevice(DEVICE_C);
    const wrap = await wrapFamilyKey({
      familyKey: context.familyKey,
      senderPrivateKey: context.owner.keyPair.privateKey,
      senderSpki: context.owner.spki,
      senderDeviceId: context.owner.deviceId,
      recipientSpki: stranger.spki,
      recipientDeviceId: stranger.deviceId,
      pinnedRecipientFingerprint: await deviceKeyFingerprint(stranger.spki),
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
    });
    await expect(unwrapWith(context, wrap)).rejects.toMatchObject({ code: "key_wrap_open_failed" });
  });

  it.each([
    ["familyId", { familyId: "00000000-0000-4000-8000-000000000000" }],
    ["keyEpoch", { keyEpoch: 3 }],
    ["rotationId", { rotationId: ROTATION_ID_2 }],
    ["senderDeviceId", { senderDeviceId: DEVICE_C }],
    ["recipientDeviceId", { recipientDeviceId: DEVICE_C }],
  ])("refuses a wrap whose %s the server rewrote", async (_field, patch) => {
    const context = await pair();
    const wrap = await wrapFor(context);
    await expect(unwrapWith(context, { ...wrap, ...patch })).rejects.toThrow(SyncCryptoError);
  });

  it("refuses one flipped bit of the salt, the IV or the ciphertext", async () => {
    const context = await pair();
    const wrap = await wrapFor(context);
    for (const patch of [
      { salt: flipByte(wrap.salt, 0) },
      { iv: flipByte(wrap.iv, 0) },
      { ciphertext: flipByte(wrap.ciphertext, 0) },
    ]) {
      await expect(unwrapWith(context, { ...wrap, ...patch })).rejects.toMatchObject({
        code: "key_wrap_open_failed",
      });
    }
  });

  it("binds the rotation attempt, so two attempts of one epoch cannot be mixed", async () => {
    // Without `rotationId` an aborted attempt and the successful one that follows share the epoch
    // number, and a server could hand one device the wrap of the first and another the wrap of the
    // second. Both are genuine, both were made by the owner, and the family splits onto two keys of
    // one epoch with no symptom at all.
    const context = await pair();
    const first = await wrapFor(context, { rotationId: ROTATION_ID });
    const second = await wrapFor(context, { rotationId: ROTATION_ID_2 });
    await expect(
      unwrapWith(context, { ...first, rotationId: second.rotationId }),
    ).rejects.toMatchObject({ code: "key_wrap_open_failed" });
  });

  it("issues a wrap of the current epoch the same way, for a device that has no key yet", async () => {
    // 5.5: a device bound by comparison *after* the last key change — a second phone, a reinstall —
    // does not wait for the next rotation. Same construction, `keyEpoch` instead of `keyEpoch'`,
    // and the `rotationId` that produced the live epoch. Refusing it when the device already holds
    // the key of that epoch is a rule of the sync engine (5.4.1), enforced against the stored
    // `SHA-256(FK)` rather than here.
    const context = await pair();
    const wrap = await wrapFor(context, { keyEpoch: 1, rotationId: ROTATION_ID });
    expect(toHex(await exportFamilyKey(await unwrapWith(context, wrap)))).toBe(
      toHex(await exportFamilyKey(context.familyKey)),
    );
  });
});

describe("the owner successor announcement of 5.4.1", () => {
  it("verifies for the recipient it was made for", async () => {
    const context = await pair();
    const successor = await makeDevice(DEVICE_C);
    const params = {
      familyId: FAMILY_ID,
      keyEpoch: 1,
      senderDeviceId: context.owner.deviceId,
      recipientDeviceId: context.member.deviceId,
      successorDeviceId: successor.deviceId,
      successorSpki: successor.spki,
    };
    const announce = await computeOwnerAnnounce({
      ...params,
      senderPrivateKey: context.owner.keyPair.privateKey,
      senderSpki: context.owner.spki,
      recipientSpki: context.member.spki,
      pinnedRecipientFingerprint: await deviceKeyFingerprint(context.member.spki),
    });
    expect(
      await verifyOwnerAnnounce({
        ...params,
        recipientPrivateKey: context.member.keyPair.privateKey,
        recipientSpki: context.member.spki,
        senderSpki: context.owner.spki,
        pinnedSenderFingerprint: await deviceKeyFingerprint(context.owner.spki),
        announce,
      }),
    ).toBe(true);
  });

  it("cannot be made by another device of the family, only by the pinned owner device", async () => {
    // Authenticating this with the family key was the tempting shape and it is exactly wrong: every
    // device holds that key, including a stolen one that has not been revoked, so the cure for a
    // theft would be switched off by the theft.
    const context = await pair();
    const other = await makeDevice(DEVICE_C);
    const successor = await makeDevice(DEVICE_C);
    const params = {
      familyId: FAMILY_ID,
      keyEpoch: 1,
      senderDeviceId: context.owner.deviceId,
      recipientDeviceId: context.member.deviceId,
      successorDeviceId: successor.deviceId,
      successorSpki: successor.spki,
    };
    const forged = await computeOwnerAnnounce({
      ...params,
      senderPrivateKey: other.keyPair.privateKey,
      senderSpki: context.owner.spki,
      recipientSpki: context.member.spki,
      pinnedRecipientFingerprint: await deviceKeyFingerprint(context.member.spki),
    });
    expect(
      await verifyOwnerAnnounce({
        ...params,
        recipientPrivateKey: context.member.keyPair.privateKey,
        recipientSpki: context.member.spki,
        senderSpki: context.owner.spki,
        pinnedSenderFingerprint: await deviceKeyFingerprint(context.owner.spki),
        announce: forged,
      }),
    ).toBe(false);
  });

  it("refuses to verify against an unpinned sender key", async () => {
    const context = await pair();
    const successor = await makeDevice(DEVICE_C);
    const params = {
      familyId: FAMILY_ID,
      keyEpoch: 1,
      senderDeviceId: context.owner.deviceId,
      recipientDeviceId: context.member.deviceId,
      successorDeviceId: successor.deviceId,
      successorSpki: successor.spki,
    };
    const announce = await computeOwnerAnnounce({
      ...params,
      senderPrivateKey: context.owner.keyPair.privateKey,
      senderSpki: context.owner.spki,
      recipientSpki: context.member.spki,
      pinnedRecipientFingerprint: await deviceKeyFingerprint(context.member.spki),
    });
    await expect(
      verifyOwnerAnnounce({
        ...params,
        recipientPrivateKey: context.member.keyPair.privateKey,
        recipientSpki: context.member.spki,
        senderSpki: context.owner.spki,
        pinnedSenderFingerprint: await deviceKeyFingerprint(successor.spki),
        announce,
      }),
    ).rejects.toMatchObject({ code: "sender_key_mismatch" });
  });

  it("refuses to announce onto a recipient key that does not hash to the pin", async () => {
    // The announcement decides which key the family will treat as the owner's next one. Computed
    // onto a key the server substituted, it is verifiable by the server and by nobody else — not a
    // message lost but a succession stolen — so the pin is checked here before any derivation too.
    const context = await pair();
    const server = await makeDevice(DEVICE_C);
    const successor = await makeDevice(DEVICE_C);
    await expect(
      computeOwnerAnnounce({
        familyId: FAMILY_ID,
        keyEpoch: 1,
        senderDeviceId: context.owner.deviceId,
        recipientDeviceId: context.member.deviceId,
        successorDeviceId: successor.deviceId,
        successorSpki: successor.spki,
        senderPrivateKey: context.owner.keyPair.privateKey,
        senderSpki: context.owner.spki,
        recipientSpki: server.spki,
        pinnedRecipientFingerprint: await deviceKeyFingerprint(context.member.spki),
      }),
    ).rejects.toMatchObject({ code: "recipient_key_mismatch" });
  });

  it("refuses an announcement that is not bytes with an error of this package", async () => {
    // The guard `verifyEpochConfirm` and `verifyBindProof` already carry. A caller that arrives
    // with nothing — a column the server omitted, a row read back as `undefined` — must still get
    // a refusal that carries a code, so that "every refusal of this package is an error of this
    // package" holds on this path as well as on theirs.
    const context = await pair();
    const successor = await makeDevice(DEVICE_C);
    await expect(
      verifyOwnerAnnounce({
        familyId: FAMILY_ID,
        keyEpoch: 1,
        senderDeviceId: context.owner.deviceId,
        recipientDeviceId: context.member.deviceId,
        successorDeviceId: successor.deviceId,
        successorSpki: successor.spki,
        recipientPrivateKey: context.member.keyPair.privateKey,
        recipientSpki: context.member.spki,
        senderSpki: context.owner.spki,
        pinnedSenderFingerprint: await deviceKeyFingerprint(context.owner.spki),
        announce: undefined as unknown as Uint8Array,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("does not verify for a different successor or a different epoch", async () => {
    const context = await pair();
    const successor = await makeDevice(DEVICE_C);
    const impostor = await makeDevice(DEVICE_C);
    const params = {
      familyId: FAMILY_ID,
      keyEpoch: 1,
      senderDeviceId: context.owner.deviceId,
      recipientDeviceId: context.member.deviceId,
      successorDeviceId: successor.deviceId,
      successorSpki: successor.spki,
    };
    const announce = await computeOwnerAnnounce({
      ...params,
      senderPrivateKey: context.owner.keyPair.privateKey,
      senderSpki: context.owner.spki,
      recipientSpki: context.member.spki,
      pinnedRecipientFingerprint: await deviceKeyFingerprint(context.member.spki),
    });
    const verify = async (patch: Partial<typeof params>): Promise<boolean> =>
      verifyOwnerAnnounce({
        ...params,
        ...patch,
        recipientPrivateKey: context.member.keyPair.privateKey,
        recipientSpki: context.member.spki,
        senderSpki: context.owner.spki,
        pinnedSenderFingerprint: await deviceKeyFingerprint(context.owner.spki),
        announce,
      });
    expect(await verify({ successorSpki: impostor.spki })).toBe(false);
    expect(await verify({ keyEpoch: 2 })).toBe(false);
    expect(await verify({ successorDeviceId: DEVICE_B })).toBe(false);
  });
});
