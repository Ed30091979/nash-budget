/**
 * The journal integrity anchor — `SYNC_ARCHITECTURE.md` 3.6.
 *
 * The scenario the whole section exists for, and the one the first test here reproduces on
 * concrete values: the server deletes the tail of the journal and renumbers what is left. A
 * second device joins by invite code and fetches the journal from the beginning. The `seq` run
 * from `1` to the cut is continuous, every envelope decrypts, and the device shows a truncated
 * budget without a word. The continuity check of 3.4 cannot see it by construction — a range
 * truncated at the end is continuous — which is why the anchor is a separate mechanism.
 */
import {
  createEmptyJournal,
  type JournalSnapshot,
  type SyncedBudgetState,
} from "@family-budget/sync-protocol";
import { IndexedDbBudgetRepository } from "@family-budget/storage";
import { afterEach, describe, expect, it } from "vitest";

import type { CheckpointLink } from "../src/checkpoint.js";
import { SyncEngine } from "../src/engine.js";
import { applyDelivery } from "../src/intake.js";
import type { DeliveredEnvelope, OutgoingEnvelope, SyncCursor } from "../src/types.js";
import {
  checkpointRecord,
  createFamilyKey,
  databaseName,
  deleteDatabases,
  DEVICE_A,
  DEVICE_B,
  FAMILY_ID,
  FakeSyncServer,
  FIRST_EPOCH,
  sealCheckpoint,
  sealOperation,
  stampDrafts,
} from "./support.js";

afterEach(deleteDatabases);

const START: SyncCursor = { keyEpoch: FIRST_EPOCH, seq: 0 };
/** Identifiers for the checkpoint envelopes themselves; they never enter any set (3.6). */
const ANCHOR_OP_IDS = [
  "0000000c-0000-4000-8000-0000000000c1",
  "0000000c-0000-4000-8000-0000000000c2",
  "0000000c-0000-4000-8000-0000000000c3",
];

function numbered(envelopes: readonly OutgoingEnvelope[], from = 1): DeliveredEnvelope[] {
  return envelopes.map((envelope, index) => ({
    ...envelope,
    seq: from + index,
    receivedAt: from + index,
  }));
}

/** `n` operations of the peer device, in the order it wrote them. */
function peerOperations(count: number) {
  return stampDrafts(
    DEVICE_B,
    Array.from({ length: count }, (_unused, index) => ({
      entity: "category" as const,
      action: "create" as const,
      targetId: `73333333-3333-4333-8333-3333${index.toString(16).padStart(8, "0")}`,
      fields: {
        name: `категория ${index}`,
        type: "expense" as const,
        group: "быт",
        active: true,
        sortOrder: index,
      },
    })),
  );
}

interface Anchor {
  readonly journalOpIds: readonly string[];
  readonly chain: readonly CheckpointLink[];
}

async function apply(
  familyKey: CryptoKey,
  envelopes: readonly DeliveredEnvelope[],
  anchor: Anchor = { journalOpIds: [], chain: [] },
  snapshot: JournalSnapshot = createEmptyJournal(),
  cursor: SyncCursor = START,
) {
  return applyDelivery({
    envelopes,
    cursor,
    acceptedEpoch: FIRST_EPOCH,
    familyKey,
    familyId: FAMILY_ID,
    deviceId: DEVICE_A,
    snapshot,
    journalOpIds: anchor.journalOpIds,
    chain: anchor.chain,
  });
}

describe("сверка чекпойнта (3.6)", () => {
  it("не поднимает тревогу на неповреждённом журнале", async () => {
    const family = await createFamilyKey();
    const operations = peerOperations(4);
    const envelopes = numbered([
      ...(await Promise.all(operations.map((operation) => sealOperation(family.key, operation)))),
      await sealCheckpoint(
        family.key,
        ANCHOR_OP_IDS[0]!,
        DEVICE_B,
        await checkpointRecord({ opIds: operations.map((operation) => operation.opId) }),
      ),
    ]);

    const result = await apply(family.key, envelopes);

    expect(result.stop).toBeNull();
    expect(result.applied).toBe(4);
    expect(result.checkpoints).toBe(1);
    expect(result.alarms).toEqual([]);
    expect(result.journalOpIds).toEqual(operations.map((operation) => operation.opId));
  });

  it("обнаруживает усечение журнала с конца и называет недостачу", async () => {
    const family = await createFamilyKey();
    // The peer applied seven operations and wrote a checkpoint over all seven. The server hands
    // this device the first four and renumbers, so the run `1 … 5` is continuous and nothing
    // decrypts wrongly: the only trace of the missing three is the count inside the checkpoint.
    const operations = peerOperations(7);
    const truncated = operations.slice(0, 4);
    const envelopes = numbered([
      ...(await Promise.all(truncated.map((operation) => sealOperation(family.key, operation)))),
      await sealCheckpoint(
        family.key,
        ANCHOR_OP_IDS[0]!,
        DEVICE_B,
        await checkpointRecord({ opIds: operations.map((operation) => operation.opId) }),
      ),
    ]);

    const result = await apply(family.key, envelopes);

    // No stop: 3.6 is explicit that a divergence neither blocks work nor rewinds state.
    expect(result.stop).toBeNull();
    expect(result.applied).toBe(4);
    expect(result.alarms).toHaveLength(1);
    expect(result.alarms[0]).toMatchObject({
      reason: "journal_diverged",
      deviceId: DEVICE_B,
      index: 1,
      ownCount: 4,
      checkpointCount: 7,
      missingHere: 3,
      missingThere: 0,
    });
  });

  it("не поднимает тревогу на отставшем устройстве, написавшем чекпойнт по своему префиксу", async () => {
    const family = await createFamilyKey();
    const operations = peerOperations(6);
    // The checkpoint covers the first two only — a device that came back after a week, caught up
    // that far and anchored what it had. Measuring it against this device's complete set would
    // call an ordinary family member a truncated journal.
    const envelopes = numbered([
      ...(await Promise.all(operations.map((operation) => sealOperation(family.key, operation)))),
      await sealCheckpoint(
        family.key,
        ANCHOR_OP_IDS[0]!,
        DEVICE_B,
        await checkpointRecord({ opIds: operations.slice(0, 2).map((operation) => operation.opId) }),
      ),
    ]);

    const result = await apply(family.key, envelopes);

    expect(result.alarms).toEqual([]);
  });

  it("расхождение множеств — тревога, а не тихая починка", async () => {
    const family = await createFamilyKey();
    const mine = peerOperations(3);
    const theirs = peerOperations(5).slice(3);
    // Same count, different members: the checkpoint hashes two identifiers this device holds and
    // one it has never seen. Nothing about the state may change over that — the set comparison
    // produces a warning, never a repair.
    const envelopes = numbered([
      ...(await Promise.all(mine.map((operation) => sealOperation(family.key, operation)))),
      await sealCheckpoint(
        family.key,
        ANCHOR_OP_IDS[0]!,
        DEVICE_B,
        await checkpointRecord({
          opIds: [mine[0]!.opId, mine[1]!.opId, theirs[0]!.opId],
        }),
      ),
    ]);

    const result = await apply(family.key, envelopes);

    expect(result.stop).toBeNull();
    expect(result.applied).toBe(3);
    expect(result.alarms).toHaveLength(1);
    expect(result.alarms[0]).toMatchObject({
      reason: "journal_diverged",
      ownCount: 3,
      checkpointCount: 3,
    });
    // The three operations that were delivered are still applied, and the journal still holds
    // exactly them: the alarm is a signal, not an edit.
    expect(result.journalOpIds).toEqual(mine.map((operation) => operation.opId));
    expect(result.snapshot.state.categories).toHaveLength(3);
  });

  it("прощает то, что чекпойнт объявил пропущенным (S_T формулы :292)", async () => {
    const family = await createFamilyKey();
    const operations = peerOperations(4);
    // The peer quarantined the second envelope and says so. Its set is the other three, and this
    // device — which did apply all four — must not read that as a divergence.
    const skipped = operations[1]!.opId;
    const envelopes = numbered([
      ...(await Promise.all(operations.map((operation) => sealOperation(family.key, operation)))),
      await sealCheckpoint(
        family.key,
        ANCHOR_OP_IDS[0]!,
        DEVICE_B,
        await checkpointRecord({
          opIds: operations.filter((operation) => operation.opId !== skipped).map((o) => o.opId),
          skipped: [skipped],
        }),
      ),
    ]);

    const result = await apply(family.key, envelopes);

    expect(result.alarms).toEqual([]);
  });

  it("повторное применение того же журнала ничего не меняет", async () => {
    const family = await createFamilyKey();
    const operations = peerOperations(3);
    const envelopes = numbered([
      ...(await Promise.all(operations.map((operation) => sealOperation(family.key, operation)))),
      await sealCheckpoint(
        family.key,
        ANCHOR_OP_IDS[0]!,
        DEVICE_B,
        await checkpointRecord({ opIds: operations.map((operation) => operation.opId) }),
      ),
    ]);

    const once = await apply(family.key, envelopes);
    // 5.5 step 8 replays the whole journal after a rotation, and 3.5 requires the replay to be
    // idempotent. The anchor is replayed with it: the same set, the same chain, no alarm.
    const twice = await apply(
      family.key,
      envelopes,
      { journalOpIds: [], chain: [] },
      createEmptyJournal(),
      START,
    );

    expect(twice.journalOpIds).toEqual(once.journalOpIds);
    expect(twice.chain).toEqual(once.chain);
    expect(twice.alarms).toEqual([]);
    expect(twice.cursor).toEqual(once.cursor);
  });
});

describe("цепочка (deviceId, index) (3.6)", () => {
  it("пропуск номера — тревога: сервер удалил чекпойнт", async () => {
    const family = await createFamilyKey();
    const operations = peerOperations(2);
    const opIds = operations.map((operation) => operation.opId);
    const first = await checkpointRecord({ opIds: opIds.slice(0, 1) });
    // Index 3 where 2 was due: the second link of the chain was deleted on the way.
    const third = await checkpointRecord({ opIds, index: 3, prevDigest: first.digest });
    const envelopes = numbered([
      await sealOperation(family.key, operations[0]!),
      await sealCheckpoint(family.key, ANCHOR_OP_IDS[0]!, DEVICE_B, first),
      await sealOperation(family.key, operations[1]!),
      await sealCheckpoint(family.key, ANCHOR_OP_IDS[1]!, DEVICE_B, third),
    ]);

    const result = await apply(family.key, envelopes);

    expect(result.alarms).toHaveLength(1);
    expect(result.alarms[0]).toMatchObject({ reason: "chain_broken", deviceId: DEVICE_B, index: 3 });
  });

  it("prevDigest, не совпавший с предыдущим звеном, — та же тревога", async () => {
    const family = await createFamilyKey();
    const operations = peerOperations(2);
    const opIds = operations.map((operation) => operation.opId);
    const first = await checkpointRecord({ opIds: opIds.slice(0, 1) });
    const second = await checkpointRecord({
      opIds,
      index: 2,
      // Anything but the digest of the link before it.
      prevDigest: "f".repeat(64),
    });
    const envelopes = numbered([
      await sealOperation(family.key, operations[0]!),
      await sealCheckpoint(family.key, ANCHOR_OP_IDS[0]!, DEVICE_B, first),
      await sealOperation(family.key, operations[1]!),
      await sealCheckpoint(family.key, ANCHOR_OP_IDS[1]!, DEVICE_B, second),
    ]);

    const result = await apply(family.key, envelopes);

    expect(result.alarms).toHaveLength(1);
    expect(result.alarms[0]).toMatchObject({ reason: "chain_broken", index: 2 });
  });

  it("первое звено обязано выходить из затравки эпохи, а не из произвольного значения", async () => {
    const family = await createFamilyKey();
    const operations = peerOperations(1);
    const envelopes = numbered([
      await sealOperation(family.key, operations[0]!),
      await sealCheckpoint(
        family.key,
        ANCHOR_OP_IDS[0]!,
        DEVICE_B,
        await checkpointRecord({
          opIds: [operations[0]!.opId],
          prevDigest: "0".repeat(64),
        }),
      ),
    ]);

    const result = await apply(family.key, envelopes);

    expect(result.alarms).toHaveLength(1);
    expect(result.alarms[0]).toMatchObject({ reason: "chain_broken", index: 1 });
  });

  it("собственный чекпойнт проверяется по цепочке и не сверяется по множеству", async () => {
    const family = await createFamilyKey();
    const operations = peerOperations(2);
    // Written by this very device, and over a set it does not hold: comparing it would only ask
    // whether this device agrees with itself. The chain is what carries information here — a
    // deleted own checkpoint is a deleted checkpoint like any other.
    const envelopes = numbered([
      ...(await Promise.all(operations.map((operation) => sealOperation(family.key, operation)))),
      await sealCheckpoint(
        family.key,
        ANCHOR_OP_IDS[0]!,
        DEVICE_A,
        await checkpointRecord({ opIds: peerOperations(9).map((o) => o.opId), deviceId: DEVICE_A }),
      ),
    ]);

    const result = await apply(family.key, envelopes);

    expect(result.alarms).toEqual([]);
    expect(result.chain).toEqual([expect.objectContaining({ deviceId: DEVICE_A, index: 1 })]);
  });

  it("несортированный skipped — не запись этой схемы, а не запись с оговоркой", async () => {
    const family = await createFamilyKey();
    const operations = peerOperations(2);
    const record = await checkpointRecord({ opIds: operations.map((o) => o.opId) });
    const envelopes = numbered([
      await sealCheckpoint(family.key, ANCHOR_OP_IDS[0]!, DEVICE_B, {
        ...record,
        // Descending, so the one shape the digest is defined on is not the shape delivered.
        skipped: [...operations.map((o) => o.opId)].sort().reverse(),
        opCount: 0,
      }),
    ]);

    const result = await apply(family.key, envelopes);

    expect(result.stop).toMatchObject({ reason: "update_required", seq: 1 });
  });

  it("нечитаемый чекпойнт останавливает доставку, а не проходит молча", async () => {
    const family = await createFamilyKey();
    const envelopes = numbered([
      await sealCheckpoint(family.key, ANCHOR_OP_IDS[0]!, DEVICE_B, {
        index: 1,
        opCount: 1,
        skipped: [],
        inheritedGaps: [],
        prevDigest: "00",
        digest: "11",
      }),
    ]);

    const result = await apply(family.key, envelopes);

    expect(result.stop).toMatchObject({ reason: "update_required", seq: 1 });
    expect(result.cursor).toEqual(START);
  });
});

describe("якорь в движке", () => {
  async function engineFor(
    server: FakeSyncServer,
    familyKey: CryptoKey,
    keyDigest: string,
    deviceId: string,
    options: { readonly now?: () => number } = {},
  ) {
    const repository = new IndexedDbBudgetRepository<SyncedBudgetState>({
      databaseName: databaseName("anchor"),
    });
    return new SyncEngine({
      repository,
      transport: server,
      familyId: FAMILY_ID,
      deviceId,
      familyKey,
      keyEpoch: FIRST_EPOCH,
      keyDigest,
      ...options,
    });
  }

  it("вступающее устройство видит усечённый журнал по чужому чекпойнту", async () => {
    const family = await createFamilyKey();
    const server = new FakeSyncServer();
    const operations = peerOperations(5);
    // The whole journal, as the peer wrote it — and then the server keeps only the first two and
    // renumbers, which is the one shape of truncation `seq` continuity cannot see.
    for (const operation of operations.slice(0, 2)) {
      server.seed(await sealOperation(family.key, operation));
    }
    server.seed(
      await sealCheckpoint(
        family.key,
        ANCHOR_OP_IDS[0]!,
        DEVICE_B,
        await checkpointRecord({ opIds: operations.map((operation) => operation.opId) }),
      ),
    );

    const engine = await engineFor(server, family.key, family.digest, DEVICE_A);
    const pulled = await engine.pull();

    expect(pulled.stop).toBeNull();
    expect(pulled.applied).toBe(2);
    expect(pulled.alarms).toHaveLength(1);
    const report = await engine.readCheckpointReport();
    expect(report.journalOpCount).toBe(2);
    expect(report.alarm).toMatchObject({
      reason: "journal_diverged",
      checkpointCount: 5,
      ownCount: 2,
      missingHere: 3,
    });
  });

  it("неповреждённый журнал: тревоги нет, и повторная выборка её не создаёт", async () => {
    const family = await createFamilyKey();
    const server = new FakeSyncServer();
    const operations = peerOperations(3);
    for (const operation of operations) server.seed(await sealOperation(family.key, operation));
    server.seed(
      await sealCheckpoint(
        family.key,
        ANCHOR_OP_IDS[0]!,
        DEVICE_B,
        await checkpointRecord({ opIds: operations.map((operation) => operation.opId) }),
      ),
    );

    const engine = await engineFor(server, family.key, family.digest, DEVICE_A);
    const first = await engine.pull();
    const again = await engine.pull();

    expect(first.alarms).toEqual([]);
    expect(again.alarms).toEqual([]);
    expect(again.applied).toBe(0);
    expect((await engine.readCheckpointReport()).alarm).toBeNull();
    expect((await engine.readCheckpointReport()).journalOpCount).toBe(3);
  });

  it("снимает тревогу, когда следующий чекпойнт сходится", async () => {
    const family = await createFamilyKey();
    const server = new FakeSyncServer();
    const operations = peerOperations(5);
    const opIds = operations.map((operation) => operation.opId);
    for (const operation of operations.slice(0, 2)) {
      server.seed(await sealOperation(family.key, operation));
    }
    const first = await checkpointRecord({ opIds });
    server.seed(await sealCheckpoint(family.key, ANCHOR_OP_IDS[0]!, DEVICE_B, first));

    const engine = await engineFor(server, family.key, family.digest, DEVICE_A);
    expect((await engine.pull()).alarms).toHaveLength(1);
    expect((await engine.readCheckpointReport()).alarm).not.toBeNull();

    // The server stops withholding and the peer anchors the same set again. The warning describes
    // the state of the journals now, so it goes.
    for (const operation of operations.slice(2)) {
      server.seed(await sealOperation(family.key, operation));
    }
    server.seed(
      await sealCheckpoint(
        family.key,
        ANCHOR_OP_IDS[1]!,
        DEVICE_B,
        await checkpointRecord({ opIds, index: 2, prevDigest: first.digest }),
      ),
    );

    const second = await engine.pull();

    expect(second.alarms).toEqual([]);
    expect(second.compared).toBe(1);
    expect((await engine.readCheckpointReport()).alarm).toBeNull();
  });

  it("пишет свой чекпойнт по правилам 3.6 и не чаще раза в десять минут", async () => {
    const family = await createFamilyKey();
    const server = new FakeSyncServer();
    const operations = peerOperations(200);
    for (const operation of operations) server.seed(await sealOperation(family.key, operation));

    let clock = 1_700_000_000_000;
    const engine = await engineFor(server, family.key, family.digest, DEVICE_A, {
      now: () => clock,
    });
    await engine.pull();

    expect(await engine.writeCheckpoint()).toBe(true);
    const queued = server.stored.length;
    await engine.push();
    expect(server.stored).toHaveLength(queued + 1);
    const written = server.stored[server.stored.length - 1]!;
    expect(written.kind).toBe("checkpoint");
    expect(written.deviceId).toBe(DEVICE_A);
    expect((await engine.readCheckpointReport()).ownIndex).toBe(1);

    // Nothing new has been folded, so there is nothing to anchor — and even asked to write one at
    // a background transition, the ten-minute floor of 3.6 refuses.
    expect(await engine.writeCheckpoint({ force: true })).toBe(false);
    await engine.pull();
    clock += 60_000;
    expect(await engine.writeCheckpoint({ force: true })).toBe(false);
  });

  it("чекпойнт этого устройства сходится у второго устройства семьи", async () => {
    const family = await createFamilyKey();
    const server = new FakeSyncServer();
    const operations = peerOperations(200);
    for (const operation of operations) server.seed(await sealOperation(family.key, operation));

    const writer = await engineFor(server, family.key, family.digest, DEVICE_A);
    await writer.pull();
    expect(await writer.writeCheckpoint()).toBe(true);
    await writer.push();

    // A third device reads the same journal, checkpoint included, and finds nothing wrong: the
    // digest one device computed over its set is the digest the other computes over its own.
    const reader = await engineFor(server, family.key, family.digest, DEVICE_B);
    const pulled = await reader.pull();

    expect(pulled.checkpoints).toBe(1);
    expect(pulled.alarms).toEqual([]);
    expect((await reader.readCheckpointReport()).alarm).toBeNull();
  });
});
