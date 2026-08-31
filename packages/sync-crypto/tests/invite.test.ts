import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  computeBindProof,
  deriveInviteMaster,
  INVITE_PAYLOAD_VERSION,
  deriveInviteSecrets,
  enc,
  exportFamilyKey,
  generateFamilyKey,
  generateInviteCode,
  INVITE_CODE_LENGTH,
  inviteAuthTokenDigest,
  normalizeInviteCode,
  openInvite,
  sealInvite,
  SyncCryptoError,
  toHex,
  verifyBindProof,
  deviceKeyFingerprint,
  type InviteWireRecord,
  type OpenInviteParams,
  type SealedInvite,
} from "../src/index.js";
import {
  DEVICE_A,
  DEVICE_B,
  FAMILY_ID,
  INVITE_ID,
  MEMBER_A,
  bufferSource,
  flipByte,
  makeDevice,
} from "./support.js";

const CODE = "ABCDEFGHJKMN";

async function issueInvite(
  overrides: { readonly senderRole?: "owner" | "member"; readonly code?: string } = {},
): Promise<{
  readonly invite: SealedInvite;
  readonly familyKey: CryptoKey;
  readonly ownerSpki: Uint8Array;
  readonly code: string;
}> {
  const owner = await makeDevice(DEVICE_A);
  const familyKey = await generateFamilyKey();
  const code = overrides.code ?? CODE;
  const invite = await sealInvite({
    code,
    familyId: FAMILY_ID,
    keyEpoch: 1,
    inviteId: INVITE_ID,
    familyKey,
    senderDeviceId: DEVICE_A,
    senderSpki: owner.spki,
    senderRole: overrides.senderRole ?? "owner",
    senderMemberId: MEMBER_A,
  });
  return { invite, familyKey, ownerSpki: owner.spki, code };
}

/**
 * The label of the invite box AAD, written out here as 5.3 writes it rather than imported from the
 * source. A label the two sides disagree on shows up as nothing but a failed tag check, which 5.3
 * says will be read as "wrong code", so the literal is worth pinning where a reader can compare it
 * against the document.
 */
const INVITE_BOX_LABEL = "nash-budget/invite-box/v1";

/**
 * A box sealed by hand under the right code, carrying a payload this package's writer would never
 * produce. Not an artificial case: anyone who knows the code can seal whatever he likes — the
 * inviter himself, or a successful offline search — so the reader has to have an answer for every
 * payload, not only for its own.
 */
async function sealByHand(
  payload: Uint8Array,
  label: string = INVITE_BOX_LABEL,
): Promise<OpenInviteParams> {
  const master = await deriveInviteMaster(CODE);
  const kek = await crypto.subtle.importKey(
    "raw",
    master.slice(0, 32),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: bufferSource(enc(label, FAMILY_ID, 1, INVITE_ID)),
        tagLength: 128,
      },
      kek,
      bufferSource(payload),
    ),
  );
  return { code: CODE, familyId: FAMILY_ID, keyEpoch: 1, inviteId: INVITE_ID, iv, ciphertext };
}

describe("the invite code of 5.3", () => {
  it("is twelve Crockford symbols, sixty bits", () => {
    for (let index = 0; index < 20; index += 1) {
      const code = generateInviteCode();
      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      expect(normalizeInviteCode(code)).toBe(code);
    }
  });

  it("is drawn fresh every time", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateInviteCode()));
    expect(codes.size).toBe(200);
  });

  it("accepts a code as a human writes it down and refuses one that is not a code", () => {
    expect(normalizeInviteCode("abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
    expect(normalizeInviteCode("abcd efgh jkln")).toBe("ABCDEFGHJK1N");
    expect(() => normalizeInviteCode("ABCDEFGHJKM")).toThrow(SyncCryptoError);
    expect(() => normalizeInviteCode("ABCDEFGHJKMNP")).toThrow(SyncCryptoError);
    expect(() => normalizeInviteCode("ABCDEFGHJKMU")).toThrow(SyncCryptoError);
  });
});

describe("the three thirds", () => {
  it("gives the same three values on both sides for the same code", async () => {
    const first = await deriveInviteSecrets(CODE);
    const second = await deriveInviteSecrets("abcd-efgh-jkmn");
    expect(toHex(first.authToken)).toBe(toHex(second.authToken));
    expect(toHex(first.bindKey)).toBe(toHex(second.bindKey));
  });

  it("gives entirely different values for a code one symbol away", async () => {
    const near = await deriveInviteSecrets("ABCDEFGHJKMP");
    const exact = await deriveInviteSecrets(CODE);
    expect(toHex(near.authToken)).not.toBe(toHex(exact.authToken));
    expect(toHex(near.bindKey)).not.toBe(toHex(exact.bindKey));
  });

  it("keeps the server's copy of the token one-way", async () => {
    const secrets = await deriveInviteSecrets(CODE);
    const digest = await inviteAuthTokenDigest(secrets.authToken);
    expect(digest).toHaveLength(32);
    expect(toHex(digest)).not.toBe(toHex(secrets.authToken));
  });
});

describe("the invite box", () => {
  it("delivers the family key and the owner's pinned fingerprint to the joining device", async () => {
    const { invite, familyKey, ownerSpki } = await issueInvite();
    const opened = await openInvite({ ...invite.record, code: CODE });
    expect(toHex(await exportFamilyKey(opened.familyKey))).toBe(toHex(await exportFamilyKey(familyKey)));
    expect(toHex(opened.senderKeyFingerprint)).toBe(toHex(await deviceKeyFingerprint(ownerSpki)));
    expect(opened.senderDeviceId).toBe(DEVICE_A);
    expect(opened.senderMemberId).toBe(MEMBER_A);
    expect(opened.senderRole).toBe("owner");
  });

  it("does not reveal the family key to the server, which holds only the box", async () => {
    const { invite, familyKey } = await issueInvite();
    const raw = toHex(await exportFamilyKey(familyKey));
    expect(toHex(invite.record.ciphertext)).not.toContain(raw);
  });

  it("refuses a wrong code", async () => {
    const { invite } = await issueInvite();
    await expect(
      openInvite({ ...invite.record, code: "ABCDEFGHJKMP" }),
    ).rejects.toMatchObject({ code: "invite_open_failed" });
  });

  it.each([
    ["familyId", { familyId: "00000000-0000-4000-8000-000000000000" }],
    ["keyEpoch", { keyEpoch: 2 }],
    ["inviteId", { inviteId: "00000000-0000-4000-8000-000000000001" }],
  ])("refuses a change to the AAD field %s", async (_field, patch) => {
    const { invite } = await issueInvite();
    await expect(openInvite({ ...invite.record, code: CODE, ...patch })).rejects.toMatchObject({
      code: "invite_open_failed",
    });
  });

  it("refuses one flipped bit of the box or of its IV", async () => {
    const { invite } = await issueInvite();
    await expect(
      openInvite({ ...invite.record, code: CODE, ciphertext: flipByte(invite.record.ciphertext, 3) }),
    ).rejects.toMatchObject({ code: "invite_open_failed" });
    await expect(
      openInvite({ ...invite.record, code: CODE, iv: flipByte(invite.record.iv, 3) }),
    ).rejects.toMatchObject({ code: "invite_open_failed" });
  });

  it("refuses the whole invite when the sender is not the owner", async () => {
    // 5.3 wants two independent checks. This is the second one — the joining device's own — and it
    // refuses the invite entirely: the key is not unwrapped and the join does not happen. The role
    // here is self-declared, so on its own it proves nothing; the caller still has to cross-check
    // `senderMemberId` against the role in the server's member list.
    const { invite } = await issueInvite({ senderRole: "member" });
    await expect(openInvite({ ...invite.record, code: CODE })).rejects.toMatchObject({
      code: "invite_sender_not_owner",
    });
  });

  it("refuses a payload with the wrong number of fields instead of defaulting the rest", async () => {
    // A payload of the version this build knows, so the count is the only thing wrong with it: the
    // reader must not accept a shorter list and fill the missing fields in with something
    // reasonable.
    const box = await sealByHand(
      enc(INVITE_PAYLOAD_VERSION, new Uint8Array(32), DEVICE_A, new Uint8Array(32)),
    );
    await expect(openInvite(box)).rejects.toMatchObject({ code: "invite_payload_invalid" });
  });

  it("is bound to the labelled purpose of 5.3, not to a bare word", async () => {
    // The box used to be the one construction of the scheme whose AAD carried a bare `"invite"`.
    // A box sealed under the old label must not open under the new one — otherwise the label was
    // never really part of the binding.
    const owner = await makeDevice(DEVICE_A);
    const familyKey = await generateFamilyKey();
    const payload = enc(
      INVITE_PAYLOAD_VERSION,
      await exportFamilyKey(familyKey),
      DEVICE_A,
      await deviceKeyFingerprint(owner.spki),
      "owner",
      MEMBER_A,
    );
    await expect(openInvite(await sealByHand(payload, "invite"))).rejects.toMatchObject({
      code: "invite_open_failed",
    });
    // The same payload under the label 5.3 prescribes opens, which also pins the field order.
    const opened = await openInvite(await sealByHand(payload));
    expect(toHex(await exportFamilyKey(opened.familyKey))).toBe(
      toHex(await exportFamilyKey(familyKey)),
    );
    expect(opened.senderMemberId).toBe(MEMBER_A);
  });

  it("names a payload from a newer version for what it is, rather than blaming the code", async () => {
    // The reason `inviteVersion` exists at all (5.3). A payload from a later version of the scheme
    // has a different number of fields, so the strict count would call it malformed and the user
    // would read that as "wrong code" — a mistake he did not make, with no way to find the cause.
    // The version is therefore read first, and this refusal is distinct from both of the others.
    const box = await sealByHand(
      enc(
        INVITE_PAYLOAD_VERSION + 1,
        new Uint8Array(32),
        DEVICE_A,
        new Uint8Array(32),
        "owner",
        MEMBER_A,
        "a field this version has never heard of",
      ),
    );
    await expect(openInvite(box)).rejects.toMatchObject({ code: "invite_version_unsupported" });
  });

  it("refuses a first field that is no version at all as a malformed payload", async () => {
    // The other side of the same coin: nothing ever wrote a version that is not a plain decimal
    // integer, so such a payload is broken rather than new, and it must not be reported as one
    // this build is merely too old to read.
    const box = await sealByHand(
      enc("v2", new Uint8Array(32), DEVICE_A, new Uint8Array(32), "owner", MEMBER_A),
    );
    await expect(openInvite(box)).rejects.toMatchObject({ code: "invite_payload_invalid" });
  });

  it("keeps the wrapping key non-extractable, so the code's third never leaves as bytes", async () => {
    const secrets = await deriveInviteSecrets(CODE);
    await expect(crypto.subtle.exportKey("raw", secrets.wrappingKey)).rejects.toThrow();
  });
});

/**
 * The same record rendered the ways a record actually gets rendered: `JSON.stringify` as it comes,
 * `JSON.stringify` with the byte fields hexed the way a wire codec would hex them, and a debug
 * dump. Serialising the whole object is the point of the type, so the check is made against
 * serialisation itself rather than against a list of field names that a later edit could grow.
 */
function dumps(record: InviteWireRecord): string {
  return [
    JSON.stringify(record),
    JSON.stringify(record, (_key, value) => (value instanceof Uint8Array ? toHex(value) : value)),
    inspect(record, { depth: null, maxArrayLength: null }),
  ].join(" ");
}

/** Every representation 32 secret bytes could plausibly be written in. */
function renderings(bytes: Uint8Array): readonly string[] {
  return [
    toHex(bytes),
    toHex(bytes).toUpperCase(),
    Buffer.from(bytes).toString("base64"),
    Buffer.from(bytes).toString("base64url"),
    Buffer.from(bytes).toString("latin1"),
    JSON.stringify(bytes),
    [...bytes].join(","),
    [...bytes].join(", "),
    [...bytes].join(" "),
  ];
}

describe("what the server is given and what stays with the issuer (5.3)", () => {
  it("puts on the wire exactly the row 5.3 lists, the token's hash standing in for the token", async () => {
    const { invite, code } = await issueInvite();
    const thirds = await deriveInviteSecrets(code);
    expect(Object.keys(invite.record).sort()).toEqual([
      "authTokenDigest",
      "ciphertext",
      "familyId",
      "inviteId",
      "iv",
      "keyEpoch",
    ]);
    expect(toHex(invite.record.authTokenDigest)).toBe(
      toHex(await inviteAuthTokenDigest(thirds.authToken)),
    );
    expect(toHex(invite.issuerSecrets.authToken)).toBe(toHex(thirds.authToken));
    expect(toHex(invite.issuerSecrets.bindKey)).toBe(toHex(thirds.bindKey));
  });

  it("serialises whole without taking the token or the bind key along", async () => {
    // The property the two records exist for. 5.3 lets the server keep `SHA-256(authToken)` and
    // never the token; `bindKey` it may not hold in any form, because with it the server forges a
    // joining device's `bindProof` and the automatic half of two-way key authentication (5.4) is
    // gone. While both sat in one object, one `JSON.stringify` on the server-facing path handed
    // over both, and only a comment said not to.
    const { invite } = await issueInvite();
    const text = dumps(invite.record);
    const forbidden = [
      ...renderings(invite.issuerSecrets.authToken),
      ...renderings(invite.issuerSecrets.bindKey),
    ];
    for (const secret of forbidden) {
      expect(secret.length).toBeGreaterThan(3);
      expect(text).not.toContain(secret);
    }
  });
});

describe("bindProof — the automatic half of binding, device to owner (5.4)", () => {
  it("verifies for the device that computed it", async () => {
    const joiner = await makeDevice(DEVICE_B);
    const secrets = await deriveInviteSecrets(CODE);
    const params = {
      familyId: FAMILY_ID,
      inviteId: INVITE_ID,
      deviceId: DEVICE_B,
      spki: joiner.spki,
    };
    const proof = await computeBindProof(secrets.bindKey, params);
    expect(proof).toHaveLength(32);
    expect(await verifyBindProof(secrets.bindKey, params, proof)).toBe(true);
  });

  it("fails when the SPKI is substituted", async () => {
    const joiner = await makeDevice(DEVICE_B);
    const impostor = await makeDevice(DEVICE_B);
    const secrets = await deriveInviteSecrets(CODE);
    const params = { familyId: FAMILY_ID, inviteId: INVITE_ID, deviceId: DEVICE_B, spki: joiner.spki };
    const proof = await computeBindProof(secrets.bindKey, params);
    expect(await verifyBindProof(secrets.bindKey, { ...params, spki: impostor.spki }, proof)).toBe(false);
  });

  it("fails when the deviceId, the inviteId or the familyId is substituted", async () => {
    const joiner = await makeDevice(DEVICE_B);
    const secrets = await deriveInviteSecrets(CODE);
    const params = { familyId: FAMILY_ID, inviteId: INVITE_ID, deviceId: DEVICE_B, spki: joiner.spki };
    const proof = await computeBindProof(secrets.bindKey, params);
    expect(await verifyBindProof(secrets.bindKey, { ...params, deviceId: DEVICE_A }, proof)).toBe(false);
    expect(
      await verifyBindProof(secrets.bindKey, { ...params, inviteId: FAMILY_ID }, proof),
    ).toBe(false);
    expect(
      await verifyBindProof(secrets.bindKey, { ...params, familyId: INVITE_ID }, proof),
    ).toBe(false);
  });

  it("cannot be produced without the code: the server holds only the token hash", async () => {
    const secrets = await deriveInviteSecrets(CODE);
    const guessed = await deriveInviteSecrets("ABCDEFGHJKMP");
    const joiner = await makeDevice(DEVICE_B);
    const params = { familyId: FAMILY_ID, inviteId: INVITE_ID, deviceId: DEVICE_B, spki: joiner.spki };
    const proof = await computeBindProof(guessed.bindKey, params);
    expect(await verifyBindProof(secrets.bindKey, params, proof)).toBe(false);
  });

  it("fails on a proof of the wrong length instead of comparing a prefix", async () => {
    const joiner = await makeDevice(DEVICE_B);
    const secrets = await deriveInviteSecrets(CODE);
    const params = { familyId: FAMILY_ID, inviteId: INVITE_ID, deviceId: DEVICE_B, spki: joiner.spki };
    const proof = await computeBindProof(secrets.bindKey, params);
    expect(await verifyBindProof(secrets.bindKey, params, proof.slice(0, 16))).toBe(false);
  });
});
