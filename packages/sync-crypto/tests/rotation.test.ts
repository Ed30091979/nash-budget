import { describe, expect, it } from "vitest";

import {
  computeEpochConfirm,
  ENVELOPE_VERSION,
  exportFamilyKey,
  familyKeyFingerprint,
  generateFamilyKey,
  openEnvelope,
  reencryptEnvelope,
  reencryptJournal,
  sealEnvelope,
  SyncCryptoError,
  toHex,
  verifyEpochConfirm,
  type EnvelopeHeader,
  type SealedEnvelope,
} from "../src/index.js";
import {
  DEVICE_A,
  DEVICE_B,
  FAMILY_ID,
  OP_ID,
  OP_ID_2,
  ROTATION_ID,
  ROTATION_ID_2,
  flipByte,
  samplePlaintext,
} from "./support.js";

function header(overrides: Partial<EnvelopeHeader> = {}): EnvelopeHeader {
  return {
    envelopeVersion: ENVELOPE_VERSION,
    kind: "operation",
    familyId: FAMILY_ID,
    opId: OP_ID,
    deviceId: DEVICE_A,
    keyEpoch: 1,
    ...overrides,
  };
}

async function journal(key: CryptoKey): Promise<readonly SealedEnvelope[]> {
  return [
    await sealEnvelope(key, header(), samplePlaintext(100)),
    await sealEnvelope(key, header({ opId: OP_ID_2, deviceId: DEVICE_B }), samplePlaintext(200)),
    await sealEnvelope(
      key,
      header({ opId: "a1b2c3d4-1111-4222-8333-444455556666", kind: "checkpoint" }),
      samplePlaintext(300),
    ),
  ];
}

describe("the epoch continuity confirmation of 5.4", () => {
  it("verifies on the key of the previous epoch", async () => {
    const previous = await generateFamilyKey();
    const next = await generateFamilyKey();
    const params = {
      previousFamilyKey: previous,
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
      nextFamilyKey: next,
    };
    const confirm = await computeEpochConfirm(params);
    expect(confirm).toHaveLength(32);
    expect(await verifyEpochConfirm(params, confirm)).toBe(true);
  });

  it("does not verify for anyone who lacks the previous key — the server included", async () => {
    const previous = await generateFamilyKey();
    const next = await generateFamilyKey();
    const params = {
      previousFamilyKey: previous,
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
      nextFamilyKey: next,
    };
    const confirm = await computeEpochConfirm(params);
    // A server that invents its own FK* has no previous key to confirm it with, which is the whole
    // reason this second line exists: it does not depend on device keys at all.
    const invented = await generateFamilyKey();
    expect(
      await verifyEpochConfirm({ ...params, previousFamilyKey: invented }, confirm),
    ).toBe(false);
  });

  it("is bound to the family, the new epoch number, the attempt and the new key", async () => {
    const previous = await generateFamilyKey();
    const next = await generateFamilyKey();
    const other = await generateFamilyKey();
    const params = {
      previousFamilyKey: previous,
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
      nextFamilyKey: next,
    };
    const confirm = await computeEpochConfirm(params);
    expect(await verifyEpochConfirm({ ...params, familyId: OP_ID }, confirm)).toBe(false);
    expect(await verifyEpochConfirm({ ...params, keyEpoch: 3 }, confirm)).toBe(false);
    expect(await verifyEpochConfirm({ ...params, rotationId: ROTATION_ID_2 }, confirm)).toBe(false);
    expect(await verifyEpochConfirm({ ...params, nextFamilyKey: other }, confirm)).toBe(false);
  });

  it("refuses a confirmation altered in one byte, and one of the wrong length", async () => {
    const previous = await generateFamilyKey();
    const next = await generateFamilyKey();
    const params = {
      previousFamilyKey: previous,
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
      nextFamilyKey: next,
    };
    const confirm = await computeEpochConfirm(params);
    expect(await verifyEpochConfirm(params, flipByte(confirm, 31))).toBe(false);
    expect(await verifyEpochConfirm(params, confirm.slice(0, 16))).toBe(false);
  });

  it("names the new key by its hash, which is what a device stores for the epoch it accepted", async () => {
    const key = await generateFamilyKey();
    const fingerprint = await familyKeyFingerprint(key);
    expect(fingerprint).toHaveLength(32);
    expect(toHex(fingerprint)).not.toBe(toHex(await exportFamilyKey(key)));
    expect(toHex(await familyKeyFingerprint(key))).toBe(toHex(fingerprint));
  });
});

describe("re-encrypting the journal — step 4 of 5.5", () => {
  it("keeps opId, author deviceId, kind and version, and changes only iv, epoch and ciphertext", async () => {
    const previousFamilyKey = await generateFamilyKey();
    const nextFamilyKey = await generateFamilyKey();
    const before = await sealEnvelope(previousFamilyKey, header({ deviceId: DEVICE_B }), samplePlaintext());
    const after = await reencryptEnvelope({
      envelope: before,
      previousFamilyKey,
      nextFamilyKey,
      nextKeyEpoch: 2,
    });

    expect(after.opId).toBe(before.opId);
    expect(after.deviceId).toBe(DEVICE_B);
    expect(after.familyId).toBe(before.familyId);
    expect(after.kind).toBe(before.kind);
    expect(after.envelopeVersion).toBe(before.envelopeVersion);
    expect(after.keyEpoch).toBe(2);
    expect(toHex(after.iv)).not.toBe(toHex(before.iv));
    expect(toHex(after.ciphertext)).not.toBe(toHex(before.ciphertext));
  });

  it("moves the plaintext byte for byte, so lamport, memberId and the action survive", async () => {
    // The tiebreaker of the merge is a hash of the canonical text of the operation, so rewriting
    // even one byte of it would give the operation a different hash and let two devices disagree
    // in silence. Nothing here parses the plaintext, and that is deliberate.
    const previousFamilyKey = await generateFamilyKey();
    const nextFamilyKey = await generateFamilyKey();
    const plaintext = samplePlaintext(987_654);
    const before = await sealEnvelope(previousFamilyKey, header(), plaintext);
    const after = await reencryptEnvelope({
      envelope: before,
      previousFamilyKey,
      nextFamilyKey,
      nextKeyEpoch: 2,
    });
    expect([...(await openEnvelope(nextFamilyKey, after))]).toEqual([...plaintext]);
  });

  it("moves a whole journal, checkpoints and other devices' envelopes included", async () => {
    const previousFamilyKey = await generateFamilyKey();
    const nextFamilyKey = await generateFamilyKey();
    const before = await journal(previousFamilyKey);
    const after = await reencryptJournal({
      envelopes: before,
      previousFamilyKey,
      previousKeyEpoch: 1,
      nextFamilyKey,
      nextKeyEpoch: 2,
    });

    expect(after).toHaveLength(before.length);
    expect(after.map((envelope) => envelope.opId)).toEqual(before.map((envelope) => envelope.opId));
    // The owner uploads envelopes authored by every device in the family; that is why 3.3 forbids
    // the server to require that the header deviceId match the uploading device.
    expect(after.map((envelope) => envelope.deviceId)).toEqual(
      before.map((envelope) => envelope.deviceId),
    );
    expect(after.map((envelope) => envelope.kind)).toEqual(before.map((envelope) => envelope.kind));
    for (const [index, envelope] of after.entries()) {
      expect(envelope.keyEpoch).toBe(2);
      expect([...(await openEnvelope(nextFamilyKey, envelope))]).toEqual([
        ...(await openEnvelope(previousFamilyKey, before[index]!)),
      ]);
    }
  });

  it("refuses an envelope of another epoch instead of quietly carrying it over", async () => {
    const previousFamilyKey = await generateFamilyKey();
    const nextFamilyKey = await generateFamilyKey();
    const stray = await sealEnvelope(previousFamilyKey, header({ keyEpoch: 5 }), samplePlaintext());
    await expect(
      reencryptJournal({
        envelopes: [stray],
        previousFamilyKey,
        previousKeyEpoch: 1,
        nextFamilyKey,
        nextKeyEpoch: 2,
      }),
    ).rejects.toMatchObject({ code: "epoch_mismatch" });
  });

  it("refuses to move an envelope backwards or sideways in epoch numbering", async () => {
    const previousFamilyKey = await generateFamilyKey();
    const nextFamilyKey = await generateFamilyKey();
    const envelope = await sealEnvelope(previousFamilyKey, header({ keyEpoch: 4 }), samplePlaintext());
    for (const nextKeyEpoch of [3, 4, 4.5]) {
      await expect(
        reencryptEnvelope({ envelope, previousFamilyKey, nextFamilyKey, nextKeyEpoch }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("stops on an envelope that does not decrypt, rather than dropping it", async () => {
    // 5.5: an undecryptable envelope halts the rotation. Skipping it is a decision for the owner,
    // taken by hand, and its `seq` then goes into `inheritedGaps` of the first checkpoint of the
    // new epoch — so the family sees what was lost. There is no automatic path, and this function
    // offers none.
    const previousFamilyKey = await generateFamilyKey();
    const nextFamilyKey = await generateFamilyKey();
    const good = await sealEnvelope(previousFamilyKey, header(), samplePlaintext());
    const tampered = await sealEnvelope(previousFamilyKey, header({ opId: OP_ID_2 }), samplePlaintext());
    await expect(
      reencryptJournal({
        envelopes: [good, { ...tampered, ciphertext: flipByte(tampered.ciphertext, 0) }],
        previousFamilyKey,
        previousKeyEpoch: 1,
        nextFamilyKey,
        nextKeyEpoch: 2,
      }),
    ).rejects.toMatchObject({ code: "envelope_open_failed" });
  });

  it("refuses the journal of the wrong key", async () => {
    const previousFamilyKey = await generateFamilyKey();
    const nextFamilyKey = await generateFamilyKey();
    const strangerKey = await generateFamilyKey();
    const envelopes = await journal(previousFamilyKey);
    await expect(
      reencryptJournal({
        envelopes,
        previousFamilyKey: strangerKey,
        previousKeyEpoch: 1,
        nextFamilyKey,
        nextKeyEpoch: 2,
      }),
    ).rejects.toThrow(SyncCryptoError);
  });

  it("leaves the retired epoch unreadable under the new key and the reverse", async () => {
    const previousFamilyKey = await generateFamilyKey();
    const nextFamilyKey = await generateFamilyKey();
    const [before] = await journal(previousFamilyKey);
    const after = await reencryptEnvelope({
      envelope: before!,
      previousFamilyKey,
      nextFamilyKey,
      nextKeyEpoch: 2,
    });
    await expect(openEnvelope(nextFamilyKey, before!)).rejects.toThrow(SyncCryptoError);
    await expect(openEnvelope(previousFamilyKey, after)).rejects.toThrow(SyncCryptoError);
  });

  it("skips a gap in epoch numbers without complaint, because an aborted attempt takes its number", async () => {
    // 5.5: a repeat after an aborted attempt takes the *next* epoch number, never the same one, so
    // gaps in the numbering are normal and harmless. Reading them as a break is the quiet bug that
    // locks out every device that slept through an aborted rotation.
    const previousFamilyKey = await generateFamilyKey();
    const nextFamilyKey = await generateFamilyKey();
    const envelopes = await journal(previousFamilyKey);
    const moved = await reencryptJournal({
      envelopes,
      previousFamilyKey,
      previousKeyEpoch: 1,
      nextFamilyKey,
      nextKeyEpoch: 7,
    });
    expect(moved.every((envelope) => envelope.keyEpoch === 7)).toBe(true);
  });
});
