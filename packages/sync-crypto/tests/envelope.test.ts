import { describe, expect, it } from "vitest";

import {
  ENVELOPE_IV_BYTES,
  ENVELOPE_TAG_BYTES,
  ENVELOPE_VERSION,
  enc,
  envelopeAad,
  exportFamilyKey,
  generateFamilyKey,
  importFamilyKey,
  openEnvelope,
  sealEnvelope,
  SyncCryptoError,
  toHex,
  type EnvelopeHeader,
  type SealedEnvelope,
} from "../src/index.js";
import {
  DEVICE_A,
  DEVICE_B,
  FAMILY_ID,
  OP_ID,
  samplePlaintext,
  withCiphertextByteFlipped,
  withIvByteFlipped,
} from "./support.js";

const HEADER: EnvelopeHeader = {
  envelopeVersion: ENVELOPE_VERSION,
  kind: "operation",
  familyId: FAMILY_ID,
  opId: OP_ID,
  deviceId: DEVICE_A,
  keyEpoch: 1,
};

async function sealed(header: EnvelopeHeader = HEADER): Promise<{
  key: CryptoKey;
  envelope: SealedEnvelope;
  plaintext: Uint8Array;
}> {
  const key = await generateFamilyKey();
  const plaintext = samplePlaintext();
  return { key, envelope: await sealEnvelope(key, header, plaintext), plaintext };
}

describe("the envelope of 5.2", () => {
  it("carries a fresh 96-bit IV and a ciphertext that includes the 128-bit tag", async () => {
    const { envelope, plaintext } = await sealed();
    expect(ENVELOPE_IV_BYTES).toBe(12);
    expect(ENVELOPE_TAG_BYTES).toBe(16);
    expect(envelope.iv).toHaveLength(ENVELOPE_IV_BYTES);
    expect(envelope.ciphertext).toHaveLength(plaintext.length + ENVELOPE_TAG_BYTES);
  });

  it("never reuses an IV, and never repeats a ciphertext for the same plaintext", async () => {
    const key = await generateFamilyKey();
    const plaintext = samplePlaintext();
    const ivs = new Set<string>();
    const ciphertexts = new Set<string>();
    for (let index = 0; index < 32; index += 1) {
      const envelope = await sealEnvelope(key, HEADER, plaintext);
      ivs.add(toHex(envelope.iv));
      ciphertexts.add(toHex(envelope.ciphertext));
    }
    expect(ivs.size).toBe(32);
    expect(ciphertexts.size).toBe(32);
  });

  it("round-trips the plaintext byte for byte and does not re-serialise it", async () => {
    const { key, envelope, plaintext } = await sealed();
    expect([...(await openEnvelope(key, envelope))]).toEqual([...plaintext]);
  });

  it("keeps the header in the clear and holds exactly the six AAD fields", async () => {
    const { envelope } = await sealed();
    expect(envelope.familyId).toBe(FAMILY_ID);
    expect(envelope.opId).toBe(OP_ID);
    expect(envelope.deviceId).toBe(DEVICE_A);
    expect(envelope.keyEpoch).toBe(1);
    expect(toHex(envelopeAad(HEADER))).toBe(
      toHex(enc(ENVELOPE_VERSION, "operation", FAMILY_ID, OP_ID, DEVICE_A, 1)),
    );
  });

  it("leaves seq and receivedAt out of the AAD, because the server stamps them afterwards", async () => {
    const { key, envelope } = await sealed();
    // Whatever the server attaches, the envelope still opens: the two fields are outside the tag
    // by construction, and 2.2 records the consequence — numbering and ordering stay the server's,
    // and the client answers with the continuity check of 3.4, not with cryptography.
    const stamped = { ...envelope, seq: 41, receivedAt: "2026-08-11T09:00:00Z" } as SealedEnvelope;
    await expect(openEnvelope(key, stamped)).resolves.toBeDefined();
  });
});

describe("an altered envelope is refused, not silently mis-read", () => {
  it("refuses one flipped bit anywhere in the ciphertext", async () => {
    const { key, envelope } = await sealed();
    for (const index of [0, 1, Math.floor(envelope.ciphertext.length / 2), envelope.ciphertext.length - 1]) {
      await expect(openEnvelope(key, withCiphertextByteFlipped(envelope, index))).rejects.toThrow(
        SyncCryptoError,
      );
    }
  });

  it("refuses one flipped bit anywhere in the IV", async () => {
    const { key, envelope } = await sealed();
    for (let index = 0; index < ENVELOPE_IV_BYTES; index += 1) {
      await expect(openEnvelope(key, withIvByteFlipped(envelope, index))).rejects.toThrow(
        SyncCryptoError,
      );
    }
  });

  it("refuses a truncated ciphertext and a stripped tag", async () => {
    const { key, envelope } = await sealed();
    const truncated = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -1) };
    const tagless = { ...envelope, ciphertext: envelope.ciphertext.slice(0, ENVELOPE_TAG_BYTES - 1) };
    await expect(openEnvelope(key, truncated)).rejects.toThrow(SyncCryptoError);
    await expect(openEnvelope(key, tagless)).rejects.toThrow(SyncCryptoError);
  });

  it("refuses an IV of the wrong length rather than letting the mode decide", async () => {
    const { key, envelope } = await sealed();
    await expect(
      openEnvelope(key, { ...envelope, iv: envelope.iv.slice(0, 8) }),
    ).rejects.toThrow(SyncCryptoError);
  });

  it.each([
    ["envelopeVersion", { envelopeVersion: 2 }],
    ["kind", { kind: "checkpoint" as const }],
    ["familyId", { familyId: "00000000-0000-4000-8000-000000000000" }],
    ["opId", { opId: "11111111-1111-4111-8111-111111111111" }],
    ["deviceId", { deviceId: DEVICE_B }],
    ["keyEpoch", { keyEpoch: 2 }],
  ])("refuses a change to the AAD field %s", async (_field, patch) => {
    const { key, envelope } = await sealed();
    await expect(openEnvelope(key, { ...envelope, ...patch })).rejects.toThrow(SyncCryptoError);
  });

  it("refuses every single-byte change to every AAD field, one identifier byte at a time", async () => {
    const { key, envelope } = await sealed();
    for (let index = 0; index < FAMILY_ID.length; index += 1) {
      const character = FAMILY_ID[index]!;
      if (character === "-") continue;
      const swapped = character === "0" ? "1" : "0";
      const familyId = FAMILY_ID.slice(0, index) + swapped + FAMILY_ID.slice(index + 1);
      if (familyId === FAMILY_ID) continue;
      await expect(openEnvelope(key, { ...envelope, familyId })).rejects.toThrow(SyncCryptoError);
    }
  });

  it("refuses the family key of another family", async () => {
    const { envelope } = await sealed();
    const strangerKey = await generateFamilyKey();
    await expect(openEnvelope(strangerKey, envelope)).rejects.toThrow(SyncCryptoError);
  });

  it("refuses a key that differs in a single byte", async () => {
    const { key, envelope } = await sealed();
    const raw = await exportFamilyKey(key);
    raw[0] = raw[0]! ^ 0x01;
    await expect(openEnvelope(await importFamilyKey(raw), envelope)).rejects.toThrow(SyncCryptoError);
  });

  it("reports a refusal with the code that names the class and never the value", async () => {
    const { key, envelope } = await sealed();
    await expect(openEnvelope(key, withCiphertextByteFlipped(envelope))).rejects.toMatchObject({
      name: "SyncCryptoError",
      code: "envelope_open_failed",
    });
  });
});

describe("sealing refuses a header that could never be written", () => {
  it.each([
    ["a zero epoch", { keyEpoch: 0 }],
    ["a fractional epoch", { keyEpoch: 1.5 }],
    ["a zero version", { envelopeVersion: 0 }],
    ["an unknown kind", { kind: "snapshot" }],
    ["an empty familyId", { familyId: "" }],
    ["an over-long opId", { opId: "x".repeat(129) }],
  ])("refuses %s", async (_case, patch) => {
    const key = await generateFamilyKey();
    await expect(sealEnvelope(key, { ...HEADER, ...patch }, samplePlaintext())).rejects.toThrow(
      SyncCryptoError,
    );
  });

  it("does not apply those checks on the way in, because 3.4 forbids an early header verdict", async () => {
    // An envelope whose header the server altered fails the tag — that is the whole answer. Were
    // the reader to whitelist `envelopeVersion` before decrypting, a server could raise "update
    // your application" for the whole family by flipping one open byte, which is exactly the class
    // of move 3.4 orders out of existence by fixing the order of the checks.
    const key = await generateFamilyKey();
    const envelope = await sealEnvelope(key, HEADER, samplePlaintext());
    const rejection = await openEnvelope(key, { ...envelope, envelopeVersion: 99 }).catch(
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(SyncCryptoError);
    expect((rejection as SyncCryptoError).code).toBe("envelope_open_failed");
  });
});
