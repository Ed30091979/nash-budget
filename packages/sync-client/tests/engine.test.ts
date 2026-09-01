import { calculateAnnualPlan } from "@family-budget/domain";
import { G002 } from "@family-budget/test-fixtures";
import { type SyncedBudgetState } from "@family-budget/sync-protocol";
import { IndexedDbBudgetRepository } from "@family-budget/storage";
import { afterEach, describe, expect, it } from "vitest";

import { SyncEngine } from "../src/engine.js";
import { SyncClientError, SyncServerError } from "../src/errors.js";
import {
  createFamilyKey,
  databaseName,
  deleteDatabases,
  DEVICE_A,
  DEVICE_B,
  FAMILY_ID,
  FakeSyncServer,
  FIRST_EPOCH,
  g002Drafts,
  sealOperation,
  stampDrafts,
} from "./support.js";

afterEach(deleteDatabases);

const JULY_RESERVE_MINOR = 1_980_900;
const JULY_SPENDABLE_MINOR = 4_419_100;

function plan(state: SyncedBudgetState) {
  return calculateAnnualPlan(state, G002.startMonth, 12).currentMonth;
}

interface Rig {
  readonly engine: SyncEngine;
  readonly repository: IndexedDbBudgetRepository<SyncedBudgetState>;
  readonly name: string;
}

async function rig(
  server: FakeSyncServer,
  familyKey: CryptoKey,
  keyDigest: string,
  deviceId: string,
  label: string,
  name = databaseName(label),
): Promise<Rig> {
  const repository = new IndexedDbBudgetRepository<SyncedBudgetState>({ databaseName: name });
  return {
    name,
    repository,
    engine: new SyncEngine({
      repository,
      transport: server,
      familyId: FAMILY_ID,
      deviceId,
      familyKey,
      keyEpoch: FIRST_EPOCH,
      keyDigest,
    }),
  };
}

/** The same budget line both devices edit at once, so LWW has something real to settle. */
function productsLimit(plannedMinor: number) {
  return {
    entity: "budgetLine" as const,
    action: "update" as const,
    targetId: "74444444-4444-4444-8444-444444444451",
    fields: {
      budgetId: "74444444-4444-4444-8444-444444444441",
      categoryId: "73333333-3333-4333-8333-333333333335",
      plannedMinor,
    },
  };
}

/** One extra expense, so a test can queue twenty distinguishable operations. */
function extraExpense(index: number) {
  return {
    entity: "transaction" as const,
    action: "create" as const,
    targetId: `7aaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    fields: {
      kind: "expense" as const,
      occurredOn: "2026-07-20",
      status: "posted" as const,
      amountMinor: 1_000,
      accountId: "22222222-2222-4222-8222-222222222221",
      categoryId: "73333333-3333-4333-8333-333333333335",
    },
  };
}

describe("движок синхронизации", () => {
  it("кладёт конверт в очередь той же транзакцией, что и состояние", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { engine, repository } = await rig(server, family.key, family.digest, DEVICE_A, "same-tx");

    const result = await engine.enqueue(g002Drafts());

    expect(result.queued).toBe(g002Drafts().length);
    expect(await repository.countOutbox()).toBe(result.queued);
    expect(await repository.loadVersioned()).not.toBeNull();
    expect(plan(result.snapshot.state).annualReserveMinor).toBe(JULY_RESERVE_MINOR);
    expect(plan(result.snapshot.state).spendableAfterPlanMinor).toBe(JULY_SPENDABLE_MINOR);
    expect(server.submissions).toBe(0);
  });

  it("после разрыва сети доставляет 20 операций без дублей и потерь", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const first = await rig(server, family.key, family.digest, DEVICE_A, "offline");

    await first.engine.enqueue(g002Drafts());
    const seeded = await first.engine.push();
    expect(seeded.pending).toBe(0);
    const baseline = server.stored.length;

    server.offline = true;
    for (let index = 1; index <= 20; index += 1) {
      await first.engine.enqueue([extraExpense(index)]);
      await expect(first.engine.push()).rejects.toBeInstanceOf(SyncClientError);
    }
    expect(await first.repository.countOutbox()).toBe(20);

    // The device is restarted: a new repository handle over the same database, a new engine.
    const restarted = await rig(server, family.key, family.digest, DEVICE_A, "offline", first.name);
    expect(await restarted.repository.countOutbox()).toBe(20);

    server.offline = false;
    const delivered = await restarted.engine.push();

    expect(delivered.confirmed).toBe(20);
    expect(delivered.pending).toBe(0);
    expect(server.stored.length).toBe(baseline + 20);
    const opIds = server.stored.map((envelope) => envelope.opId);
    expect(new Set(opIds).size).toBe(opIds.length);
    const seqs = server.stored.map((envelope) => envelope.seq).sort((left, right) => left - right);
    expect(seqs).toEqual(Array.from({ length: baseline + 20 }, (_, index) => index + 1));

    // And the whole thing arrives at a second device with every sum intact.
    const other = await rig(server, family.key, family.digest, DEVICE_B, "offline-peer");
    const pulled = await other.engine.pull();
    expect(pulled.stop).toBeNull();
    expect(pulled.applied).toBe(baseline + 20);
    const state = (await other.repository.load())!;
    expect(state.transactions).toHaveLength(24);
    expect(plan(state).annualReserveMinor).toBe(JULY_RESERVE_MINOR);
  });

  it("потерянный ответ сервера не создаёт дубля и не теряет операции", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { engine, repository } = await rig(server, family.key, family.digest, DEVICE_A, "lost-answer");

    await engine.enqueue([extraExpense(1), extraExpense(2)]);
    server.dropNextAnswer = true;
    await expect(engine.push()).rejects.toBeInstanceOf(SyncClientError);

    // 3.3: the queue is cleared by a confirmed `seq` and by nothing else.
    expect(await repository.countOutbox()).toBe(2);
    expect(server.stored).toHaveLength(2);

    const retried = await engine.push();
    expect(retried.confirmed).toBe(2);
    expect(server.stored).toHaveLength(2);
    expect(server.stored.map((envelope) => envelope.seq)).toEqual([1, 2]);
  });

  it("отказ 409 очередь не очищает", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { engine, repository } = await rig(server, family.key, family.digest, DEVICE_A, "conflict-409");

    await engine.enqueue([extraExpense(1)]);
    server.keyEpoch = FIRST_EPOCH + 1;

    await expect(engine.push()).rejects.toMatchObject({ serverCode: "epoch_mismatch" });
    expect(await repository.countOutbox()).toBe(1);
    expect(server.stored).toHaveLength(0);
  });

  it("не удаляет из очереди по чужому идентификатору в ответе сервера", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { engine, repository } = await rig(server, family.key, family.digest, DEVICE_A, "foreign-ack");
    await engine.enqueue([extraExpense(1)]);

    const lying = {
      submit: async () => ({ keyEpoch: FIRST_EPOCH, accepted: [{ opId: crypto.randomUUID(), seq: 1 }] }),
      fetch: server.fetch.bind(server),
      keys: server.keys.bind(server),
    };
    const engineWithLiar = new SyncEngine({
      repository,
      transport: lying,
      familyId: FAMILY_ID,
      deviceId: DEVICE_A,
      familyKey: family.key,
      keyEpoch: FIRST_EPOCH,
      keyDigest: family.digest,
    });

    const result = await engineWithLiar.push();
    expect(result.confirmed).toBe(0);
    expect(await repository.countOutbox()).toBe(1);
  });

  it("локальная запись не теряется при одновременном приходе чужих операций", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { engine, repository } = await rig(server, family.key, family.digest, DEVICE_A, "cas");

    // A shared history both devices already hold.
    await engine.enqueue(g002Drafts());
    await engine.push();
    await engine.pull();

    // The peer writes an expense of 4 000 ₽ and it is already in the journal.
    const peerOperations = stampDrafts(DEVICE_B, [extraExpense(99)], 10_000);
    for (const operation of peerOperations) server.seed(await sealOperation(family.key, operation));

    // The local device writes at the same moment. The write is slipped in between the fetch and
    // the commit by wrapping the transport, which is exactly the race 3.4 step 10 is about.
    let raced = false;
    const racing = {
      submit: server.submit.bind(server),
      keys: server.keys.bind(server),
      fetch: async (familyId: string, query: Parameters<typeof server.fetch>[1]) => {
        const answer = await server.fetch(familyId, query);
        if (!raced) {
          raced = true;
          await engine.enqueue([extraExpense(100)]);
        }
        return answer;
      },
    };
    const racingEngine = new SyncEngine({
      repository,
      transport: racing,
      familyId: FAMILY_ID,
      deviceId: DEVICE_A,
      familyKey: family.key,
      keyEpoch: FIRST_EPOCH,
      keyDigest: family.digest,
    });

    const pulled = await racingEngine.pull();
    expect(raced).toBe(true);
    expect(pulled.stop).toBeNull();

    const state = (await repository.load())!;
    const ids = state.transactions.map((transaction) => transaction.id);
    expect(ids).toContain(extraExpense(99).targetId);
    expect(ids).toContain(extraExpense(100).targetId);
    expect(await repository.countOutbox()).toBe(1);
  });

  it("свои конверты, вернувшиеся с сервера, только двигают курсор", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { engine, repository } = await rig(server, family.key, family.digest, DEVICE_A, "own-echo");

    await engine.enqueue(g002Drafts());
    await engine.push();
    const before = (await repository.load())!;

    const pulled = await engine.pull();
    expect(pulled.stop).toBeNull();
    expect(pulled.cursor.seq).toBe(server.stored.length);
    expect(await repository.load()).toEqual(before);
    expect(await repository.countOutbox()).toBe(0);
  });

  it("конец журнала определяется коротким ответом, а не признаком сервера", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const repository = new IndexedDbBudgetRepository<SyncedBudgetState>({
      databaseName: databaseName("has-more"),
    });
    const liar = {
      submit: server.submit.bind(server),
      keys: server.keys.bind(server),
      fetch: async (familyId: string, query: Parameters<typeof server.fetch>[1]) => ({
        ...(await server.fetch(familyId, query)),
        // A server that says "there is more" for ever.
        hasMore: true,
      }),
    };
    const engine = new SyncEngine({
      repository,
      transport: liar,
      familyId: FAMILY_ID,
      deviceId: DEVICE_B,
      familyKey: family.key,
      keyEpoch: FIRST_EPOCH,
      keyDigest: family.digest,
      fetchLimit: 8,
    });

    for (const operation of stampDrafts(DEVICE_A, [extraExpense(1), extraExpense(2)])) {
      server.seed(await sealOperation(family.key, operation));
    }

    const pulled = await engine.pull();
    expect(pulled.applied).toBe(2);
    expect(pulled.requests).toBe(1);
  });

  it("постранично вычитывает журнал длиннее одного ответа", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const repository = new IndexedDbBudgetRepository<SyncedBudgetState>({
      databaseName: databaseName("paging"),
    });
    const engine = new SyncEngine({
      repository,
      transport: server,
      familyId: FAMILY_ID,
      deviceId: DEVICE_B,
      familyKey: family.key,
      keyEpoch: FIRST_EPOCH,
      keyDigest: family.digest,
      fetchLimit: 5,
    });

    const drafts = g002Drafts();
    for (const operation of stampDrafts(DEVICE_A, drafts)) {
      server.seed(await sealOperation(family.key, operation));
    }

    const pulled = await engine.pull();
    expect(pulled.stop).toBeNull();
    expect(pulled.applied).toBe(drafts.length);
    expect(pulled.requests).toBeGreaterThan(1);
    expect(plan((await repository.load())!).spendableAfterPlanMinor).toBe(JULY_SPENDABLE_MINOR);
  });

  it("подтверждённая отправка доказывает живость эпохи", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { engine } = await rig(server, family.key, family.digest, DEVICE_A, "liveness");

    expect((await engine.status()).epoch.live).toBe(false);
    await engine.enqueue([extraExpense(1)]);
    await engine.push();
    const status = await engine.status();
    expect(status.epoch).toEqual({ keyEpoch: FIRST_EPOCH, keyDigest: family.digest, live: true });
  });

  it("пропуск номера останавливает курсор и лечится, когда сервер отдаёт удержанное", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { engine, repository } = await rig(server, family.key, family.digest, DEVICE_B, "gap");

    const drafts = g002Drafts();
    for (const operation of stampDrafts(DEVICE_A, drafts)) {
      server.seed(await sealOperation(family.key, operation));
    }
    const held = server.withhold(2)!;

    const stopped = await engine.pull();
    expect(stopped.applied).toBe(1);
    expect(stopped.stop).toMatchObject({ reason: "journal_incomplete", seq: 3 });
    expect((await engine.status()).cursor).toEqual({ keyEpoch: FIRST_EPOCH, seq: 1 });
    expect((await engine.status()).stop).toMatchObject({ reason: "journal_incomplete" });

    server.reinstate(held);
    const healed = await engine.pull();
    expect(healed.stop).toBeNull();
    expect(healed.applied).toBe(drafts.length - 1);
    expect((await engine.status()).cursor).toEqual({ keyEpoch: FIRST_EPOCH, seq: drafts.length });
    const state = (await repository.load())!;
    expect(state.transactions).toHaveLength(4);
    expect(plan(state).annualReserveMinor).toBe(JULY_RESERVE_MINOR);
    expect(plan(state).spendableAfterPlanMinor).toBe(JULY_SPENDABLE_MINOR);
  });

  it("навязанный ключ останавливает курсор навсегда и переживает перезапуск", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const imposed = await createFamilyKey();
    const first = await rig(server, family.key, family.digest, DEVICE_B, "imposed");

    // A genuine envelope of a key this device does not hold: the one loud symptom of 5.4.
    for (const operation of stampDrafts(DEVICE_A, [extraExpense(1), extraExpense(2)])) {
      server.seed(await sealOperation(imposed.key, operation));
    }

    for (let round = 1; round <= 12; round += 1) {
      const pulled = await first.engine.pull();
      expect(pulled.applied).toBe(0);
      expect(pulled.stop).toMatchObject({ reason: "key_mismatch", seq: 1, attempts: round });
      expect(pulled.cursor).toEqual({ keyEpoch: FIRST_EPOCH, seq: 0 });
    }

    // Twelve rounds and the cursor has not moved by one: 3.4 forbids the automatic skip outright.
    const restarted = await rig(server, family.key, family.digest, DEVICE_B, "imposed", first.name);
    const status = await restarted.engine.status();
    expect(status.cursor).toEqual({ keyEpoch: FIRST_EPOCH, seq: 0 });
    expect(status.stop).toMatchObject({ reason: "key_mismatch", attempts: 12 });
    expect(await restarted.repository.load()).toBeNull();
  });

  it("два устройства, работавшие офлайн, сходятся до копейки", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const alpha = await rig(server, family.key, family.digest, DEVICE_A, "converge-a");
    const beta = await rig(server, family.key, family.digest, DEVICE_B, "converge-b");

    await alpha.engine.enqueue(g002Drafts());
    await alpha.engine.sync();
    await beta.engine.pull();

    // Both go offline and both keep working.
    server.offline = true;
    await alpha.engine.enqueue([extraExpense(11), productsLimit(3_000_000)]);
    await beta.engine.enqueue([extraExpense(12), productsLimit(3_500_000)]);
    await expect(alpha.engine.push()).rejects.toBeInstanceOf(SyncClientError);
    await expect(beta.engine.push()).rejects.toBeInstanceOf(SyncClientError);

    server.offline = false;
    await alpha.engine.sync();
    await beta.engine.sync();
    await alpha.engine.pull();
    await beta.engine.pull();

    const left = (await alpha.repository.load())!;
    const right = (await beta.repository.load())!;
    expect(left).toEqual(right);
    expect(left.transactions).toHaveLength(6);
    expect(plan(left)).toEqual(plan(right));
    expect(await alpha.repository.countOutbox()).toBe(0);
    expect(await beta.repository.countOutbox()).toBe(0);
    // One journal, one order: every envelope carries one number and no number is used twice.
    const seqs = server.stored.map((envelope) => envelope.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("устаревший курсор эпохи получает 409 и не двигается", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { engine } = await rig(server, family.key, family.digest, DEVICE_A, "stale-epoch");
    server.keyEpoch = FIRST_EPOCH + 2;

    const failure = await engine.pull().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SyncServerError);
    expect((failure as SyncServerError).serverCode).toBe("epoch_mismatch");
    expect((await engine.status()).cursor).toEqual({ keyEpoch: FIRST_EPOCH, seq: 0 });
  });
});
