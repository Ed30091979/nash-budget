/**
 * Приём новой эпохи вторым устройством — 5.4.1, оба правила, которые легко потерять.
 *
 * Ротация без этой половины не работает вовсе: владелец сменил бы ключ, а все остальные устройства
 * семьи остались бы навсегда в «ошибка синхронизации». Поэтому здесь проверяется не то, что вызов
 * есть, а то, что он принимает и что отвергает — на настоящих обёртках и настоящем подтверждении
 * преемственности.
 */
import { toBase64, type KeysResult, type KeyWrapRecord } from "@family-budget/sync-client";
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
import { beforeEach, describe, expect, it } from "vitest";

import type { DeviceRecord } from "./api";
import { takeIncomingEpoch } from "./epoch-intake";

const FAMILY_ID = "0f000000-0000-4000-8000-00000000fa11";
const OWNER_DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PEER_DEVICE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const ROTATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const FIRST_EPOCH = 1;
const NEXT_EPOCH = 2;

interface World {
  readonly firstKey: CryptoKey;
  readonly secondKey: CryptoKey;
  readonly ownerKeys: CryptoKeyPair;
  readonly ownerSpki: Uint8Array;
  readonly peerKeys: CryptoKeyPair;
  readonly peerSpki: Uint8Array;
  readonly ownerPin: Uint8Array;
  readonly wrap: KeyWrapRecord;
  readonly confirm: string;
  readonly devices: readonly DeviceRecord[];
}

async function world(): Promise<World> {
  const firstKey = await generateFamilyKey();
  const secondKey = await generateFamilyKey();
  const ownerKeys = await generateDeviceKeyPair();
  const ownerSpki = await exportDevicePublicKey(ownerKeys.publicKey);
  const peerKeys = await generateDeviceKeyPair();
  const peerSpki = await exportDevicePublicKey(peerKeys.publicKey);
  const peerPin = await deviceKeyFingerprint(peerSpki);

  const made = await wrapFamilyKey({
    familyKey: secondKey,
    senderPrivateKey: ownerKeys.privateKey,
    senderSpki: ownerSpki,
    senderDeviceId: OWNER_DEVICE,
    recipientSpki: peerSpki,
    recipientDeviceId: PEER_DEVICE,
    pinnedRecipientFingerprint: peerPin,
    familyId: FAMILY_ID,
    keyEpoch: NEXT_EPOCH,
    rotationId: ROTATION_ID,
  });
  const confirm = await computeEpochConfirm({
    previousFamilyKey: firstKey,
    familyId: FAMILY_ID,
    keyEpoch: NEXT_EPOCH,
    rotationId: ROTATION_ID,
    nextFamilyKey: secondKey,
  });

  return {
    firstKey,
    secondKey,
    ownerKeys,
    ownerSpki,
    peerKeys,
    peerSpki,
    ownerPin: await deviceKeyFingerprint(ownerSpki),
    wrap: {
      keyEpoch: NEXT_EPOCH,
      deviceId: PEER_DEVICE,
      senderDeviceId: OWNER_DEVICE,
      rotationId: ROTATION_ID,
      salt: toBase64(made.salt),
      iv: toBase64(made.iv),
      ciphertext: toBase64(made.ciphertext),
      rotateConfirm: toBase64(confirm),
      confirmRotationId: ROTATION_ID,
    },
    confirm: toBase64(confirm),
    devices: [
      {
        deviceId: OWNER_DEVICE,
        memberId: "ffffffff-ffff-4fff-8fff-fffffffffff1",
        publicKey: toBase64(ownerSpki),
        bindProof: null,
        inviteId: null,
        createdAt: 1,
        lastSeenAt: 2,
        revokedAt: null,
      },
    ],
  };
}

let stage: World;

beforeEach(async () => {
  stage = await world();
});

function transport(wraps: readonly KeyWrapRecord[], calls: string[] = []) {
  return {
    async keys(familyId: string): Promise<KeysResult> {
      // 5.4.1: запрос не несёт ни одного параметра сверх семьи. «Какую эпоху я принял» — локальное
      // состояние, и сервер, которому его сообщили, начинал бы цепочку там, где устройство слабее.
      calls.push(`keys(${familyId})`);
      return { keyEpoch: NEXT_EPOCH, wraps };
    },
  };
}

function intake(overrides: Partial<Parameters<typeof takeIncomingEpoch>[0]> = {}) {
  return takeIncomingEpoch({
    transport: transport([stage.wrap]),
    familyId: FAMILY_ID,
    deviceId: PEER_DEVICE,
    deviceSpki: stage.peerSpki,
    devicePrivateKey: stage.peerKeys.privateKey,
    familyKey: stage.firstKey,
    keyEpoch: FIRST_EPOCH,
    live: true,
    pins: new Map([[OWNER_DEVICE, stage.ownerPin]]),
    devices: stage.devices,
    ...overrides,
  });
}

describe("второе устройство принимает эпоху цепочкой, а не по слову сервера", () => {
  it("обёртка с подтверждением на ключе прошлой эпохи принимается", async () => {
    const outcome = await intake();
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") return;
    expect(outcome.keyEpoch).toBe(NEXT_EPOCH);
    expect(outcome.advanced).toBe(1);
    // Именно тот ключ, который изготовил владелец: развёрнутый, а не пересказанный сервером.
    expect(outcome.keyDigest).toBe(toHex(await familyKeyFingerprint(stage.secondKey)));
  });

  it("обёртка без подтверждения преемственности — отказ, устройство остаётся на своей эпохе", async () => {
    const outcome = await intake({
      transport: transport([{ ...stage.wrap, rotateConfirm: null }]),
    });
    expect(outcome).toEqual({
      kind: "refused",
      reason: "missing_confirmation",
      keyEpoch: NEXT_EPOCH,
    });
  });

  it("подтверждение, посчитанное не на ключе прошлой эпохи, не сходится", async () => {
    const strayKey = await generateFamilyKey();
    const forged = await computeEpochConfirm({
      previousFamilyKey: strayKey,
      familyId: FAMILY_ID,
      keyEpoch: NEXT_EPOCH,
      rotationId: ROTATION_ID,
      nextFamilyKey: stage.secondKey,
    });
    const outcome = await intake({
      transport: transport([{ ...stage.wrap, rotateConfirm: toBase64(forged) }]),
    });
    expect(outcome).toEqual({
      kind: "refused",
      reason: "confirmation_failed",
      keyEpoch: NEXT_EPOCH,
    });
  });

  it("сервер подменил открытый ключ владельца в списке устройств — отказ по отпечатку", async () => {
    const substituted = await exportDevicePublicKey((await generateDeviceKeyPair()).publicKey);
    const outcome = await intake({
      devices: [{ ...stage.devices[0]!, publicKey: toBase64(substituted) }],
    });
    expect(outcome).toEqual({
      kind: "refused",
      reason: "sender_key_changed",
      keyEpoch: NEXT_EPOCH,
    });
  });

  it("отправитель не закреплён — ключ не принимается, нужна церемония", async () => {
    const outcome = await intake({ pins: new Map() });
    expect(outcome).toEqual({
      kind: "refused",
      reason: "sender_not_pinned",
      keyEpoch: NEXT_EPOCH,
    });
  });

  it("обёрток нет — ничего не меняется и ни на что не жалуется", async () => {
    const outcome = await intake({ transport: transport([]) });
    expect(outcome).toEqual({ kind: "unchanged" });
  });

  it("запрос обёрток не несёт номера принятой эпохи", async () => {
    const calls: string[] = [];
    await intake({ transport: transport([stage.wrap], calls) });
    expect(calls).toEqual([`keys(${FAMILY_ID})`]);
  });
});
