/** Shared fixtures. Two devices, one family, and the values the scheme binds them with. */
import {
  exportDevicePublicKey,
  generateDeviceKeyPair,
  type SealedEnvelope,
} from "../src/index.js";

export const FAMILY_ID = "9f1c0e4a-6b2d-4a51-8f3e-0c7d21b48a90";
export const DEVICE_A = "3f2a51c8-4d0b-4d7e-9a1f-2c6b8e05d413";
export const DEVICE_B = "7c8e15b2-9a3d-4f61-bc2e-51d0a7f93b64";
export const DEVICE_C = "b41d70e6-2c95-4a08-8d3f-6e1b09c4a752";
export const MEMBER_A = "1a5c93d7-8e40-4b26-9f71-0d3a6c8b52e4";
export const OP_ID = "5d2b8c14-7f36-4e09-a8b5-3c0e91d47a26";
export const OP_ID_2 = "e07a3f65-1c48-4b9d-82a1-6f5d3e0c7b19";
export const OP_ID_3 = "0142f8a9-3b57-4c60-9e2d-8a4f16c0b735";
export const INVITE_ID = "c3081f74-5b6a-4d29-91e0-8a7c25f4b3d6";
export const ROTATION_ID = "2e9b74c0-3a15-4d86-b7f2-9c08e15d6a34";
export const ROTATION_ID_2 = "8a41f0d3-6c72-495b-8e10-4f2b7d09c536";

export interface Device {
  readonly deviceId: string;
  readonly keyPair: CryptoKeyPair;
  readonly spki: Uint8Array;
}

export async function makeDevice(deviceId: string): Promise<Device> {
  const keyPair = await generateDeviceKeyPair();
  return { deviceId, keyPair, spki: await exportDevicePublicKey(keyPair.publicKey) };
}

/** A canonical-JSON-shaped payload. The crypto layer never parses it; it only moves the bytes. */
export function samplePlaintext(amountMinor = 123_456): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      action: "create",
      entity: "transaction",
      fields: { amountMinor, note: "секретная сумма за июль" },
      targetId: "tx-0001",
    }),
  );
}

/** Flips one bit of one byte. Nothing subtler is needed to break an AES-GCM tag. */
export function flipByte(bytes: Uint8Array, index: number): Uint8Array {
  const copy = bytes.slice();
  copy[index] = copy[index]! ^ 0x01;
  return copy;
}

export function withCiphertextByteFlipped(envelope: SealedEnvelope, index = 0): SealedEnvelope {
  return { ...envelope, ciphertext: flipByte(envelope.ciphertext, index) };
}

export function withIvByteFlipped(envelope: SealedEnvelope, index = 0): SealedEnvelope {
  return { ...envelope, iv: flipByte(envelope.iv, index) };
}

/**
 * Narrowing at the WebCrypto boundary — the test-side twin of `source` in `src/webcrypto.ts`.
 *
 * `enc` and friends return a plain `Uint8Array`, which TypeScript widens to
 * `Uint8Array<ArrayBufferLike>`: a type that also admits a view over a `SharedArrayBuffer`, and so
 * is not a `BufferSource`. Nothing in this package ever builds one. The few tests that reach past
 * the package and call `crypto.subtle` themselves narrow here rather than casting at the call site.
 */
export function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}
