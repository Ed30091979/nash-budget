/**
 * 5.4 and 5.4.1: what it takes for this device to accept a new family key.
 */
import {
  computeEpochConfirm,
  deviceKeyFingerprint,
  exportDevicePublicKey,
  familyKeyFingerprint,
  generateDeviceKeyPair,
  generateFamilyKey,
  toHex,
  wrapFamilyKey,
} from "@family-budget/sync-crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { toBase64 } from "../src/base64.js";
import { resolveEpochChain, type PinState } from "../src/epoch-chain.js";
import type { KeyWrapRecord } from "../src/transport.js";
import { DEVICE_A, DEVICE_B, FAMILY_ID } from "./support.js";

interface Party {
  readonly pair: CryptoKeyPair;
  readonly spki: Uint8Array;
  readonly fingerprint: Uint8Array;
  readonly deviceId: string;
}

async function party(deviceId: string): Promise<Party> {
  const pair = await generateDeviceKeyPair();
  const spki = await exportDevicePublicKey(pair.publicKey);
  return { pair, spki, fingerprint: await deviceKeyFingerprint(spki), deviceId };
}

let owner: Party;
let receiver: Party;
let intruder: Party;

beforeAll(async () => {
  owner = await party(DEVICE_A);
  receiver = await party(DEVICE_B);
  intruder = await party("0000000e-0000-4000-8000-00000000000e");
});

function rotationId(index: number): string {
  return `0000${index.toString(16).padStart(4, "0")}-0000-4000-8000-000000000000`;
}

async function makeWrap(
  key: CryptoKey,
  keyEpoch: number,
  previous: CryptoKey | null,
  attempt = keyEpoch,
  sender: Party = owner,
): Promise<KeyWrapRecord> {
  const wrap = await wrapFamilyKey({
    familyKey: key,
    senderPrivateKey: sender.pair.privateKey,
    senderSpki: sender.spki,
    senderDeviceId: sender.deviceId,
    recipientSpki: receiver.spki,
    recipientDeviceId: receiver.deviceId,
    pinnedRecipientFingerprint: receiver.fingerprint,
    familyId: FAMILY_ID,
    keyEpoch,
    rotationId: rotationId(attempt),
  });
  const confirm =
    previous === null
      ? null
      : await computeEpochConfirm({
          previousFamilyKey: previous,
          familyId: FAMILY_ID,
          keyEpoch,
          rotationId: rotationId(attempt),
          nextFamilyKey: key,
        });
  return {
    keyEpoch,
    deviceId: receiver.deviceId,
    senderDeviceId: sender.deviceId,
    rotationId: rotationId(attempt),
    salt: toBase64(wrap.salt),
    iv: toBase64(wrap.iv),
    ciphertext: toBase64(wrap.ciphertext),
    rotateConfirm: confirm === null ? null : toBase64(confirm),
    confirmRotationId: confirm === null ? null : rotationId(attempt),
  };
}

function pinnedTo(fingerprint: Uint8Array): (deviceId: string) => PinState {
  return () => ({ state: "pinned", fingerprint });
}

async function walk(
  wraps: readonly KeyWrapRecord[],
  accepted: { keyEpoch: number; key: CryptoKey } | null,
  overrides: Partial<Parameters<typeof resolveEpochChain>[0]> = {},
) {
  return resolveEpochChain({
    familyId: FAMILY_ID,
    deviceId: receiver.deviceId,
    deviceSpki: receiver.spki,
    devicePrivateKey: receiver.pair.privateKey,
    wraps,
    accepted,
    pin: pinnedTo(owner.fingerprint),
    senderSpki: () => owner.spki,
    ...overrides,
  });
}

describe("догоняющая цепочка эпох (5.4.1)", () => {
  it("проходит две ротации подряд и не считает пропуск номера разрывом", async () => {
    const first = await generateFamilyKey();
    const third = await generateFamilyKey();
    const seventh = await generateFamilyKey();
    // Epoch 4 was a cancelled attempt: its number is gone for ever and no link exists for it.
    const wraps = [await makeWrap(seventh, 7, third), await makeWrap(third, 3, first)];

    const result = await walk(wraps, { keyEpoch: 1, key: first });

    expect(result.refusal).toBeNull();
    expect(result.advanced).toBe(2);
    expect(result.epoch?.keyEpoch).toBe(7);
    expect(result.epoch?.keyDigest).toBe(toHex(await familyKeyFingerprint(seventh)));
  });

  it("останавливается на звене без подтверждения, сохранив прежний ключ", async () => {
    const first = await generateFamilyKey();
    const second = await generateFamilyKey();
    const wraps = [await makeWrap(second, 2, null)];

    const result = await walk(wraps, { keyEpoch: 1, key: first });

    expect(result.refusal).toEqual({ reason: "missing_confirmation", keyEpoch: 2 });
    expect(result.epoch?.keyEpoch).toBe(1);
    expect(result.key).toBe(first);
  });

  it("отвергает подтверждение, выведенное не из ключа удерживаемой эпохи", async () => {
    const first = await generateFamilyKey();
    const stranger = await generateFamilyKey();
    const second = await generateFamilyKey();
    const wraps = [await makeWrap(second, 2, stranger)];

    const result = await walk(wraps, { keyEpoch: 1, key: first });

    expect(result.refusal).toEqual({ reason: "confirmation_failed", keyEpoch: 2 });
    expect(result.epoch?.keyEpoch).toBe(1);
  });

  it("эпоха ниже принятой — тревога и в цепочку не входит", async () => {
    const first = await generateFamilyKey();
    const third = await generateFamilyKey();
    const wraps = [await makeWrap(first, 1, null)];

    const result = await walk(wraps, { keyEpoch: 3, key: third });

    expect(result.refusal).toEqual({ reason: "epoch_below_accepted", keyEpoch: 1 });
    expect(result.advanced).toBe(0);
    expect(result.epoch?.keyEpoch).toBe(3);
  });

  it("обёртка своей эпохи с другим ключом — подмена, а не переиздание", async () => {
    const held = await generateFamilyKey();
    const substitute = await generateFamilyKey();
    const wraps = [await makeWrap(substitute, 2, null)];

    const result = await walk(wraps, { keyEpoch: 2, key: held });

    expect(result.refusal).toEqual({ reason: "key_substituted", keyEpoch: 2 });
    expect(result.key).toBe(held);
  });

  it("обёртка своей эпохи с тем же ключом просто игнорируется", async () => {
    const held = await generateFamilyKey();
    const wraps = [await makeWrap(held, 2, null)];

    const result = await walk(wraps, { keyEpoch: 2, key: held });

    expect(result.refusal).toBeNull();
    expect(result.ignored).toBe(1);
    expect(result.advanced).toBe(0);
    expect(result.epoch?.keyEpoch).toBe(2);
  });

  it("без закреплённого отпечатка отправителя ключ не принимается", async () => {
    const first = await generateFamilyKey();
    const second = await generateFamilyKey();
    const wraps = [await makeWrap(second, 2, first)];

    const absent = await walk(wraps, { keyEpoch: 1, key: first }, { pin: () => ({ state: "absent" }) });
    expect(absent.refusal).toEqual({ reason: "sender_not_pinned", keyEpoch: 2 });

    const repin = await walk(
      wraps,
      { keyEpoch: 1, key: first },
      { pin: () => ({ state: "repin_required" }) },
    );
    expect(repin.refusal).toEqual({ reason: "sender_not_pinned", keyEpoch: 2 });
    expect(repin.epoch?.keyEpoch).toBe(1);
  });

  it("подставленный сервером ключ отправителя отвергается до всякого вывода", async () => {
    const first = await generateFamilyKey();
    const second = await generateFamilyKey();
    // The server makes a wrap with its own pair and offers its own SPKI as the owner's.
    const wraps = [await makeWrap(second, 2, first, 2, intruder)];

    const result = await walk(
      wraps,
      { keyEpoch: 1, key: first },
      { senderSpki: () => intruder.spki, pin: pinnedTo(owner.fingerprint) },
    );

    expect(result.refusal).toEqual({ reason: "sender_key_changed", keyEpoch: 2 });
    expect(result.key).toBe(first);
  });

  it("впервые допускаемое устройство принимает первую обёртку без цепочки", async () => {
    const first = await generateFamilyKey();
    const wraps = [await makeWrap(first, 1, null)];

    const result = await walk(wraps, null);

    expect(result.refusal).toBeNull();
    expect(result.advanced).toBe(1);
    expect(result.epoch?.keyEpoch).toBe(1);
    expect(result.epoch?.live).toBe(false);
  });

  it("берёт только обёртки, адресованные этому устройству", async () => {
    const first = await generateFamilyKey();
    const second = await generateFamilyKey();
    const foreign = { ...(await makeWrap(second, 2, first)), deviceId: intruder.deviceId };

    const result = await walk([foreign], { keyEpoch: 1, key: first });

    expect(result.refusal).toBeNull();
    expect(result.advanced).toBe(0);
    expect(result.epoch?.keyEpoch).toBe(1);
  });
});
