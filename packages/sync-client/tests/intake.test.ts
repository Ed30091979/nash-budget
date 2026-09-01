import {
  createEmptyJournal,
  MAX_LAMPORT,
  MAX_LAMPORT_SKEW,
  parseOperation,
  type JournalSnapshot,
} from "@family-budget/sync-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { applyDelivery } from "../src/intake.js";
import type { DeliveredEnvelope, OutgoingEnvelope, SyncCursor } from "../src/types.js";
import {
  createFamilyKey,
  deleteDatabases,
  DEVICE_A,
  DEVICE_B,
  FAMILY_ID,
  FIRST_EPOCH,
  sealCheckpoint,
  sealOperation,
  sealRaw,
  stampDrafts,
} from "./support.js";

afterEach(deleteDatabases);

const START: SyncCursor = { keyEpoch: FIRST_EPOCH, seq: 0 };

function numbered(envelopes: readonly OutgoingEnvelope[], from = 1): DeliveredEnvelope[] {
  return envelopes.map((envelope, index) => ({
    ...envelope,
    seq: from + index,
    receivedAt: from + index,
  }));
}

function expense(index: number, deviceId = DEVICE_B) {
  return stampDrafts(deviceId, [
    {
      entity: "transaction",
      action: "create",
      targetId: `7bbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`,
      fields: {
        kind: "expense",
        occurredOn: "2026-07-20",
        status: "posted",
        amountMinor: 400_000,
        accountId: "22222222-2222-4222-8222-222222222221",
        categoryId: "73333333-3333-4333-8333-333333333335",
      },
    },
  ])[0]!;
}

async function apply(
  familyKey: CryptoKey,
  envelopes: readonly DeliveredEnvelope[],
  cursor: SyncCursor = START,
  snapshot: JournalSnapshot = createEmptyJournal(),
  priorAttempts = 0,
) {
  return applyDelivery({
    envelopes,
    cursor,
    acceptedEpoch: FIRST_EPOCH,
    familyKey,
    deviceId: DEVICE_A,
    snapshot,
    priorAttempts,
  });
}

describe("приём чужих операций (3.4)", () => {
  it("применяет непрерывный диапазон и двигает курсор до последнего конверта", async () => {
    const family = await createFamilyKey();
    const envelopes = numbered([
      await sealOperation(family.key, expense(1)),
      await sealOperation(family.key, expense(2)),
      await sealOperation(family.key, expense(3)),
    ]);

    const result = await apply(family.key, envelopes);

    expect(result.stop).toBeNull();
    expect(result.applied).toBe(3);
    expect(result.cursor).toEqual({ keyEpoch: FIRST_EPOCH, seq: 3 });
  });

  it("останавливается на пропуске номера и курсор за разрыв не двигает", async () => {
    const family = await createFamilyKey();
    const [first, , third] = numbered([
      await sealOperation(family.key, expense(1)),
      await sealOperation(family.key, expense(2)),
      await sealOperation(family.key, expense(3)),
    ]);

    const result = await apply(family.key, [first!, third!]);

    expect(result.applied).toBe(1);
    expect(result.cursor).toEqual({ keyEpoch: FIRST_EPOCH, seq: 1 });
    expect(result.stop).toMatchObject({ reason: "journal_incomplete", seq: 3 });
  });

  it("требует, чтобы первым номером эпохи была единица", async () => {
    const family = await createFamilyKey();
    const envelopes = numbered([await sealOperation(family.key, expense(1))], 2);

    const result = await apply(family.key, envelopes);

    expect(result.applied).toBe(0);
    expect(result.cursor).toEqual(START);
    expect(result.stop).toMatchObject({ reason: "journal_incomplete", seq: 2 });
  });

  it("поднимает тревогу на первом же отказе тега в своей эпохе", async () => {
    const family = await createFamilyKey();
    const genuine = await sealOperation(family.key, expense(1));
    const tampered: OutgoingEnvelope = {
      ...genuine,
      ciphertext: `${genuine.ciphertext.slice(0, -4)}${genuine.ciphertext.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`,
    };
    const envelopes = numbered([tampered, await sealOperation(family.key, expense(2))]);

    const result = await apply(family.key, envelopes);

    expect(result.applied).toBe(0);
    expect(result.cursor).toEqual(START);
    expect(result.stop).toMatchObject({ reason: "key_mismatch", seq: 1, attempts: 1 });
  });

  it("считает попытки по одному конверту и никогда не пропускает его", async () => {
    const family = await createFamilyKey();
    const other = await createFamilyKey();
    // Sealed under a key this device does not hold: a genuine envelope of an imposed key.
    const foreign = numbered([await sealOperation(other.key, expense(1))]);

    let attempts = 0;
    for (let round = 0; round < 12; round += 1) {
      const result = await apply(family.key, foreign, START, createEmptyJournal(), attempts);
      expect(result.cursor).toEqual(START);
      expect(result.stop?.reason).toBe("key_mismatch");
      attempts = result.stop!.attempts;
    }
    expect(attempts).toBe(12);
  });

  it("чужой номер эпохи без объявленной смены обрабатывается как отказ тега", async () => {
    const family = await createFamilyKey();
    const operation = expense(1);
    const envelope = await sealRaw(
      family.key,
      { opId: operation.opId, deviceId: operation.deviceId, keyEpoch: FIRST_EPOCH + 1 },
      JSON.stringify(operation),
    );

    const result = await apply(family.key, numbered([envelope]));

    expect(result.stop).toMatchObject({ reason: "key_mismatch" });
    expect(result.cursor).toEqual(START);
  });

  it("неизвестная версия конверта останавливает применение только после проверки тега", async () => {
    const family = await createFamilyKey();
    const operation = expense(1);
    const envelope = await sealRaw(
      family.key,
      { envelopeVersion: 2, opId: operation.opId, deviceId: operation.deviceId },
      JSON.stringify(operation),
    );

    const result = await apply(family.key, numbered([envelope]));

    expect(result.stop).toMatchObject({ reason: "update_required", seq: 1 });
    expect(result.applied).toBe(0);
  });

  it("неизвестная сущность останавливает применение с предложением обновиться", async () => {
    const family = await createFamilyKey();
    const envelope = await sealRaw(
      family.key,
      { opId: "0000000c-0000-4000-8000-000000000001", deviceId: DEVICE_B },
      JSON.stringify({
        opId: "0000000c-0000-4000-8000-000000000001",
        deviceId: DEVICE_B,
        lamport: 5,
        entity: "spaceship",
        action: "create",
        targetId: "x",
        fields: {},
      }),
    );

    const result = await apply(family.key, numbered([envelope]));

    expect(result.stop).toMatchObject({ reason: "update_required" });
  });

  it("операция вне границы lamport уходит в карантин, а не в «обновите приложение»", async () => {
    const family = await createFamilyKey();
    const opId = "0000000c-0000-4000-8000-000000000002";
    const envelope = await sealRaw(
      family.key,
      { opId, deviceId: DEVICE_B },
      JSON.stringify({
        opId,
        deviceId: DEVICE_B,
        lamport: MAX_LAMPORT + 1,
        entity: "account",
        action: "create",
        targetId: "22222222-2222-4222-8222-222222222229",
        fields: { name: "Счёт", type: "current", currency: "RUB", openingBalanceMinor: 0, active: true },
      }),
    );

    const result = await apply(family.key, numbered([envelope]));

    expect(result.stop).toMatchObject({ reason: "quarantined" });
    expect(result.cursor).toEqual(START);
  });

  it("расхождение deviceId внутри операции и в заголовке — карантин", async () => {
    const family = await createFamilyKey();
    const operation = expense(1, DEVICE_B);
    const envelope = await sealRaw(
      family.key,
      { opId: operation.opId, deviceId: DEVICE_A },
      JSON.stringify(operation),
    );

    const result = await apply(family.key, numbered([envelope]));

    expect(result.stop).toMatchObject({ reason: "quarantined", seq: 1 });
    expect(result.applied).toBe(0);
  });

  it("чекпойнт двигает курсор и не считается операцией", async () => {
    const family = await createFamilyKey();
    const envelopes = numbered([
      await sealOperation(family.key, expense(1)),
      await sealCheckpoint(family.key, "0000000c-0000-4000-8000-000000000003", DEVICE_B, {
        index: 1,
        opCount: 1,
        skipped: [],
        inheritedGaps: [],
        prevDigest: "00",
        digest: "11",
      }),
      await sealOperation(family.key, expense(2)),
    ]);

    const result = await apply(family.key, envelopes);

    expect(result.stop).toBeNull();
    expect(result.applied).toBe(2);
    expect(result.checkpoints).toBe(1);
    expect(result.cursor).toEqual({ keyEpoch: FIRST_EPOCH, seq: 3 });
  });

  it("метка дальше горизонта применяется, но часы за ней не идут", async () => {
    const family = await createFamilyKey();
    const far = parseOperation({
      ...expense(7),
      lamport: MAX_LAMPORT_SKEW + 500,
    });
    const envelopes = numbered([await sealOperation(family.key, far)]);

    const result = await apply(family.key, envelopes);

    // 3.4 step 7: the operation is folded and ranks by its own stamp — only the adoption of it
    // into this device's clock is bounded, and the device is told whose stamp it was.
    expect(result.stop).toBeNull();
    expect(result.applied).toBe(1);
    expect(result.notices).toEqual([{ opId: far.opId, deviceId: DEVICE_B }]);
    expect(result.snapshot.lamport).toBeLessThan(far.lamport);
  });

  it("конверт другой семьи не открывается и попадает под то же правило тревоги", async () => {
    const family = await createFamilyKey();
    const operation = expense(1);
    const genuine = await sealOperation(family.key, operation);
    const relabelled: OutgoingEnvelope = { ...genuine, familyId: FAMILY_ID.replace("fa11", "fa12") };

    const result = await apply(family.key, numbered([relabelled]));

    expect(result.stop).toMatchObject({ reason: "key_mismatch" });
  });
});
