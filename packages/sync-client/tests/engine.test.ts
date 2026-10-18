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
  acceptsState?: (state: SyncedBudgetState) => boolean,
  foundedDocument?: boolean,
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
      ...(acceptsState === undefined ? {} : { acceptsState }),
      ...(foundedDocument === undefined ? {} : { foundedDocument }),
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

  it("подтверждает только то, что ушло в этой пачке, а не всё, что лежит в очереди", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const repository = new IndexedDbBudgetRepository<SyncedBudgetState>({
      databaseName: databaseName("batch-membership"),
    });
    const options = {
      repository,
      familyId: FAMILY_ID,
      deviceId: DEVICE_A,
      familyKey: family.key,
      keyEpoch: FIRST_EPOCH,
      keyDigest: family.digest,
      // One envelope per submission, so the second one is in the queue and out of the batch.
      batchSize: 1,
    };
    const honest = new SyncEngine({ ...options, transport: server });
    await honest.enqueue([extraExpense(1)]);
    await honest.enqueue([extraExpense(2)]);

    const queue = await repository.listOutbox();
    const held = (queue[1]!.envelope as { readonly opId: string }).opId;

    // The identifier exists — it is the *next* batch — and the server answers with it instead of
    // the one it was actually sent. The store would happily delete it: this is the engine's own
    // filter or nothing.
    const lying = {
      submit: async () => ({ keyEpoch: FIRST_EPOCH, accepted: [{ opId: held, seq: 1 }] }),
      fetch: server.fetch.bind(server),
      keys: server.keys.bind(server),
    };
    const result = await new SyncEngine({ ...options, transport: lying }).push();

    expect(result.confirmed).toBe(0);
    expect(result.pending).toBe(2);
    expect((await repository.listOutbox()).map((record) => record.opId)).toEqual(
      queue.map((record) => record.opId),
    );
  });

  it("номер, не являющийся номером, очередь не очищает", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { engine, repository } = await rig(server, family.key, family.digest, DEVICE_A, "zero-seq");
    await engine.enqueue([extraExpense(1)]);
    const queued = (await repository.listOutbox())[0]!.opId;

    // `seq` numbers from one (2.2): zero is the empty cursor and can never be the number of an
    // envelope. A server answering with it is claiming to have accepted something without
    // numbering it, and the queue is cleared against a number and nothing else.
    const lying = {
      submit: async () => ({ keyEpoch: FIRST_EPOCH, accepted: [{ opId: queued, seq: 0 }] }),
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
    // And nothing was proven live by a number that is not a number.
    expect((await engineWithLiar.status()).epoch.live).toBe(false);
  });

  it("неготовый снимок не стирает последнее показуемое состояние в документе", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const alpha = await rig(server, family.key, family.digest, DEVICE_A, "gate-a");
    const beta = await rig(server, family.key, family.digest, DEVICE_B, "gate-b");

    await alpha.engine.enqueue(g002Drafts());
    await alpha.engine.push();
    await beta.engine.pull();
    const shown = (await beta.repository.load())!;
    expect(shown.transactions).toHaveLength(4);

    // The peer deletes the active budget. The merge is right and the journal keeps it — but the
    // pointer now names a budget the journal does not hold, and every calculation over that state
    // throws. Decision 19: the document keeps the last state that could be shown.
    const [deletion] = stampDrafts(
      DEVICE_A,
      [{ entity: "budget", action: "delete", targetId: "74444444-4444-4444-8444-444444444441" }],
      100_000,
    );
    server.seed(await sealOperation(family.key, deletion!));

    const pulled = await beta.engine.pull();

    expect(pulled.stop).toBeNull();
    expect(pulled.applied).toBe(1);
    // The document is untouched, so the family goes on seeing July.
    expect(await beta.repository.load()).toEqual(shown);
    expect(plan((await beta.repository.load())!).annualReserveMinor).toBe(JULY_RESERVE_MINOR);
    // And the journal did move: the deletion is folded, and the cursor with it, so the operation
    // that repairs the state will land on top of it rather than be fetched again.
    expect((await beta.engine.status()).cursor.seq).toBe(server.stored.length);
  });

  /**
   * A peer's account that this test's application refuses to open — the stand-in for a newer
   * build's record that an older one does not understand. The identifier is a UUID on purpose:
   * the hold is a version skew, and everything the journal itself can tell is wrong it withholds.
   */
  const STRANGER = "7bbbbbbb-bbbb-4bbb-8bbb-000000000001";
  const refusesStranger = (state: SyncedBudgetState) => state.accounts.every((account) => account.id !== STRANGER);
  const strangerDraft = {
    entity: "account" as const,
    action: "create" as const,
    targetId: STRANGER,
    fields: { name: "Чужой", type: "cash" as const, currency: "RUB", openingBalanceMinor: 0, active: true },
  };
  const strangerAccount = (lamport: number) => stampDrafts(DEVICE_A, [strangerDraft], lamport)[0]!;
  const strangerGone = (lamport: number) =>
    stampDrafts(DEVICE_A, [{ entity: "account", action: "delete", targetId: STRANGER }], lamport)[0]!;

  /** Beta has the family's budget, then a peer's state its application refuses arrives. */
  async function heldBeta(label: string, accepts: (state: SyncedBudgetState) => boolean = refusesStranger) {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const alpha = await rig(server, family.key, family.digest, DEVICE_A, `${label}-a`);
    const beta = await rig(server, family.key, family.digest, DEVICE_B, `${label}-b`, undefined, accepts);
    await alpha.engine.enqueue(g002Drafts());
    await alpha.engine.push();
    await beta.engine.pull();
    server.seed(await sealOperation(family.key, strangerAccount(100_000)));
    await beta.engine.pull();
    return { server, family, alpha, beta };
  }

  it("состояние, которое шлюз приложения не принял бы, в документ не попадает", async () => {
    // The journal calls a state ready that the application refuses to store. Written to the
    // document, it would be refused on every load and every write; kept out, the family goes on
    // seeing the last state that passed.
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const alpha = await rig(server, family.key, family.digest, DEVICE_A, "accept-a");
    const beta = await rig(server, family.key, family.digest, DEVICE_B, "accept-b", undefined, refusesStranger);

    await alpha.engine.enqueue(g002Drafts());
    await alpha.engine.push();
    await beta.engine.pull();
    const shown = (await beta.repository.load())!;
    expect(shown.transactions).toHaveLength(4);

    server.seed(await sealOperation(family.key, strangerAccount(100_000)));
    const pulled = await beta.engine.pull();

    expect(pulled.stop).toBeNull();
    expect(pulled.applied).toBe(1);
    expect(await beta.repository.load()).toEqual(shown);
    expect((await beta.engine.status()).cursor.seq).toBe(server.stored.length);
    // Without the gate the same delivery reaches the document, as it always did.
    const gamma = await rig(server, family.key, family.digest, "0000000c-0000-4000-8000-000000000003", "accept-c");
    await gamma.engine.pull();
    expect((await gamma.repository.load())!.accounts.map((item) => item.id)).toContain(STRANGER);
  });

  it("отказ шлюза приложения записан и виден, переживает перезапуск и снимается исправлением", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const alpha = await rig(server, family.key, family.digest, DEVICE_A, "hold-a");
    const beta = await rig(server, family.key, family.digest, DEVICE_B, "hold-b", undefined, refusesStranger);
    await alpha.engine.enqueue(g002Drafts());
    await alpha.engine.push();
    await beta.engine.pull();
    expect((await beta.engine.status()).hold).toBeNull();

    server.seed(await sealOperation(family.key, strangerAccount(100_000)));
    const pulled = await beta.engine.pull();

    // The journal calls the state ready and the pull itself has nothing to say, as before — but the
    // refusal is no longer silent: it is recorded beside the journal and reported by the status.
    expect(pulled.stop).toBeNull();
    expect(pulled.applied).toBe(1);
    expect((await beta.engine.status()).hold).toEqual({ reason: "rejected_by_app", document: "kept" });
    const restarted = await rig(server, family.key, family.digest, DEVICE_B, "hold-b", beta.name, refusesStranger);
    expect((await restarted.engine.status()).hold).toEqual({ reason: "rejected_by_app", document: "kept" });

    // The peer takes the account away; the state is accepted again and the hold goes with it.
    server.seed(await sealOperation(family.key, strangerGone(100_001)));
    await restarted.engine.pull();
    expect((await restarted.engine.status()).hold).toBeNull();
    expect((await restarted.repository.load())!.accounts.map((account) => account.id)).not.toContain(STRANGER);
  });

  it("пока документ задержан, устройство только читает: запись отклонена, очередь и документ не тронуты", async () => {
    // Second review, MEDIUM-2 and MEDIUM-3: a write made on the held document is a write made on a
    // state that is not the journal's, and an update carries its entity whole under a stamp that
    // outranks the family's — a peer's rename would be undone by an edit of the balance. So the
    // device writes nothing until the journal's state opens again.
    const { server, family, alpha, beta } = await heldBeta("ro");
    const document = await beta.repository.loadVersioned();
    const journal = await beta.repository.readSyncState("journal");
    const queued = await beta.repository.countOutbox();

    const refusal = await beta.engine.enqueue([extraExpense(1)]).catch((failure: unknown) => failure);
    expect(refusal).toBeInstanceOf(SyncClientError);
    expect((refusal as SyncClientError).code).toBe("document_held");
    expect(await beta.repository.countOutbox()).toBe(queued);
    expect(await beta.repository.loadVersioned()).toEqual(document);
    expect(await beta.repository.readSyncState("journal")).toEqual(journal);
    // Nothing reaches the family either.
    await beta.engine.push();
    expect(server.stored.filter((envelope) => envelope.deviceId === DEVICE_B)).toHaveLength(0);

    // Once the state opens again the device writes as before, on the journal's own state.
    server.seed(await sealOperation(family.key, strangerGone(100_001)));
    await beta.engine.pull();
    const written = await beta.engine.enqueue([extraExpense(2)]);
    expect(written.queued).toBe(1);
    expect((await beta.repository.load())!.transactions.map((transaction) => transaction.id)).toContain(extraExpense(2).targetId);
    await beta.engine.push();
    await alpha.engine.pull();
    expect((await alpha.repository.load())!.transactions.map((transaction) => transaction.id)).toContain(extraExpense(2).targetId);
    expect((await alpha.repository.load())!.transactions.map((transaction) => transaction.id)).not.toContain(extraExpense(1).targetId);
  });

  it("запись, которая сама дала бы непринятое состояние, не уходит семье", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const beta = await rig(server, family.key, family.digest, DEVICE_B, "self-refused", undefined, refusesStranger);
    await beta.engine.enqueue(g002Drafts());
    const document = await beta.repository.loadVersioned();
    const queued = await beta.repository.countOutbox();

    const refusal = await beta.engine.enqueue([strangerDraft]).catch((failure: unknown) => failure);
    expect((refusal as SyncClientError).code).toBe("state_refused");
    expect(await beta.repository.countOutbox()).toBe(queued);
    expect(await beta.repository.loadVersioned()).toEqual(document);
    expect((await beta.engine.status()).hold).toBeNull();
  });

  it("сборка, которая открывает состояние, снимает задержку сама — без новых операций и без сети", async () => {
    // Second review, LOW-4: the fix for a version skew arrives as a new build, not as an
    // operation, and a pull with nothing to fetch used to write nothing — the hold stayed for ever.
    const { server, family, beta } = await heldBeta("fixed");
    expect((await beta.engine.status()).hold).not.toBeNull();
    const fixed = await rig(server, family.key, family.digest, DEVICE_B, "fixed-b", beta.name, () => true);

    // Offline: the round fails on the network, and the hold is lifted before it does.
    server.offline = true;
    await expect(fixed.engine.sync()).rejects.toThrow(SyncClientError);
    const status = await fixed.engine.status();
    expect(status.hold).toBeNull();
    expect(status.familyDocument).toBe(true);
    expect((await fixed.repository.load())!.accounts.map((account) => account.id)).toContain(STRANGER);

    // And the plain pull: nothing to fetch, the document rewritten, and the pull says so.
    const again = await heldBeta("fixed-pull");
    const repaired = await rig(again.server, again.family.key, again.family.digest, DEVICE_B, "fixed-pull-b", again.beta.name, () => true);
    const pulled = await repaired.engine.pull();
    expect(pulled.applied).toBe(0);
    expect(pulled.settled).toBe(true);
    expect((await repaired.engine.status()).hold).toBeNull();
    expect((await repaired.repository.load())!.accounts.map((account) => account.id)).toContain(STRANGER);
    // Settled once: the next pull has nothing to say.
    expect((await repaired.engine.pull()).settled).toBe(false);
  });

  it("устройство без документа не получает отвергнутое состояние и говорит об этом", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const alpha = await rig(server, family.key, family.digest, DEVICE_A, "fresh-a");
    await alpha.engine.enqueue([...g002Drafts()]);
    await alpha.engine.push();
    server.seed(await sealOperation(family.key, strangerAccount(100_000)));

    // A device that joins now has never held a document, and its first state is one its
    // application refuses. Before, that state became the document, refused on every launch.
    const fresh = await rig(server, family.key, family.digest, DEVICE_B, "fresh-b", undefined, refusesStranger);
    const pulled = await fresh.engine.pull();

    expect(pulled.applied).toBe(g002Drafts().length + 1);
    expect(await fresh.repository.loadVersioned()).toBeNull();
    const status = await fresh.engine.status();
    expect(status.hold).toEqual({ reason: "rejected_by_app", document: "empty" });
    expect(status.familyDocument).toBe(false);
    expect(status.cursor.seq).toBe(server.stored.length);
    // Nor does the bookkeeping that follows invent one: a checkpoint is anchored, the document is not.
    expect(await fresh.engine.writeCheckpoint({ force: true })).toBe(true);
    expect(await fresh.repository.loadVersioned()).toBeNull();
    expect(await fresh.repository.countOutbox()).toBe(1);

    server.seed(await sealOperation(family.key, strangerGone(100_001)));
    await fresh.engine.pull();
    expect(plan((await fresh.repository.load())!).annualReserveMinor).toBe(JULY_RESERVE_MINOR);
    expect((await fresh.engine.status()).hold).toBeNull();
    expect((await fresh.engine.status()).familyDocument).toBe(true);
  });

  it("личный бюджет вступившего устройства не выдаётся за семейный, а бюджет основателя — семейный с начала", async () => {
    // Second review, MEDIUM-3 (b): a device that joined holds the budget it had before, and a hold
    // used to call that budget «kept» — the family's, shown and written from as the family's.
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const alpha = await rig(server, family.key, family.digest, DEVICE_A, "own-a");
    await alpha.engine.enqueue([...g002Drafts()]);
    await alpha.engine.push();
    server.seed(await sealOperation(family.key, strangerAccount(100_000)));

    const personal = await rig(server, family.key, family.digest, DEVICE_B, "own-personal", undefined, refusesStranger);
    const own = (await alpha.repository.load())!;
    await personal.repository.save({ ...own, accounts: own.accounts.map((account) => ({ ...account, name: "Личный" })) });
    const before = await personal.repository.loadVersioned();
    expect((await personal.engine.status()).familyDocument).toBe(false);
    await personal.engine.pull();
    const status = await personal.engine.status();
    expect(status.hold).toEqual({ reason: "rejected_by_app", document: "empty" });
    expect(status.familyDocument).toBe(false);
    // The personal budget is not replaced by a refused state — and not promoted to the family's either.
    expect((await personal.repository.loadVersioned())!.value).toEqual(before!.value);

    // The founder's own budget is the family's from the start: its hold keeps it.
    const founder = await rig(server, family.key, family.digest, "0000000c-0000-4000-8000-000000000003", "own-founder", undefined, refusesStranger, true);
    await founder.repository.save(own);
    expect((await founder.engine.status()).familyDocument).toBe(true);
    await founder.engine.pull();
    expect((await founder.engine.status()).hold).toEqual({ reason: "rejected_by_app", document: "kept" });
  });

  it("запись о семейном документе, которой эта сборка не писала, — порча", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { engine, repository } = await rig(server, family.key, family.digest, DEVICE_A, "family-document-corrupt");
    for (const value of ["семья", { familyId: 7 }, []]) {
      await repository.writeSyncState([{ key: "family-document", value }]);
      await expect(engine.status(), JSON.stringify(value)).rejects.toThrow(/the stored family document is not a record of one/);
    }
    // A record of another family is not this family's document — a family this device left.
    await repository.writeSyncState([{ key: "family-document", value: { familyId: "11111111-1111-4111-8111-111111111111" } }]);
    expect((await engine.status()).familyDocument).toBe(false);
  });

  it("запись о задержке, которой эта сборка не писала, — порча, а не задержка", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { engine, repository } = await rig(server, family.key, family.digest, DEVICE_A, "hold-corrupt");
    for (const value of [{ reason: "nope", document: "kept" }, { reason: "rejected_by_app", document: "lost" }, "rejected_by_app"]) {
      await repository.writeSyncState([{ key: "hold", value }]);
      await expect(engine.status(), JSON.stringify(value)).rejects.toThrow(/the stored hold is not a hold/);
    }
  });

  it("упёршийся в потолок страниц отличим от вычитанного до конца журнала", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const repository = new IndexedDbBudgetRepository<SyncedBudgetState>({
      databaseName: databaseName("page-cap"),
    });
    const engine = new SyncEngine({
      repository,
      transport: server,
      familyId: FAMILY_ID,
      deviceId: DEVICE_B,
      familyKey: family.key,
      keyEpoch: FIRST_EPOCH,
      keyDigest: family.digest,
      // One envelope per page, so the cap of one call is reached long before the journal ends.
      fetchLimit: 1,
    });

    const drafts = Array.from({ length: 70 }, (_, index) => extraExpense(index + 1));
    for (const operation of stampDrafts(DEVICE_A, drafts)) {
      server.seed(await sealOperation(family.key, operation));
    }

    const first = await engine.pull();
    expect(first.stop).toBeNull();
    expect(first.pageLimitReached).toBe(true);
    expect(first.applied).toBeLessThan(drafts.length);

    // Nothing is wrong: the budget of one call is spent, and calling again finishes the journal.
    const second = await engine.pull();
    expect(second.pageLimitReached).toBe(false);
    expect(first.applied + second.applied).toBe(drafts.length);
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
