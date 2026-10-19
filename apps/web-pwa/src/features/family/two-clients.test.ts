/**
 * Приёмка фазы S6, как тест: два клиента, одна семья, одна операция, одно имя автора.
 *
 * «Операция `4 000 ₽` по «Транспорту» от 9 июля 2026, введённая на первом, появляется у второго
 * с именем автора» — это здесь и проверяется, и проверяется целиком тем же путём, каким идёт
 * приложение: координатор записи из `app/budget-store.ts`, тот же `createBudgetJournalWriter`, тот же
 * `SyncEngine`, те же запечатанные конверты. Подменён только транспорт — журнальная половина
 * сервера, переписанная по 3.3 и 3.4, потому что настоящий сервер нельзя честно попросить
 * доставить пакет ровно тогда, когда этого хочет тест.
 *
 * Ничего в этом файле не сравнивает состояния «через приложение»: сходство доказывается суммой,
 * датой, названием категории и именем участника, то есть теми четырьмя величинами, которые видит
 * человек на экране второго устройства.
 */
import "fake-indexeddb/auto";
import {
  calculateBudget,
  carriedBudgetId,
  carryBudgetForward,
  makeSeedBudget,
  SEED_IDS,
  type BudgetState,
  type Transaction,
} from "@family-budget/domain";
import { SyncEngine, SyncServerError } from "@family-budget/sync-client";
import type {
  DeliveredEnvelope,
  FetchQuery,
  FetchResult,
  KeysResult,
  OutgoingEnvelope,
  SubmitResult,
  SyncTransport,
} from "@family-budget/sync-client";
import { familyKeyFingerprint, generateFamilyKey, toHex } from "@family-budget/sync-crypto";
import { afterEach, describe, expect, it } from "vitest";

import { BUDGET_WRITE_CONFLICT_MESSAGE, createAppBudgetSaveCoordinator } from "../../app/budget-store";
import { prepareBudgetState } from "../../backup";
import { createBudgetRepository } from "../../storage-repository";
import {
  acceptsJournalState,
  createBudgetJournalWriter,
  JOURNAL_ORIGIN_KEY,
  missingLocalMember,
  runSyncRound,
  type JournalOrigin,
} from "./controller";
import { membersById, transactionAuthorLabel } from "./model";
import { toOperationsErrorView } from "../operations/model";
import { BudgetWriteRefusal, WRITE_REFUSAL_TEXT } from "../../write-refusal";

const FAMILY_ID = "0f000000-0000-4000-8000-00000000fa11";
const DEVICE_ANNA = "0000000a-0000-4000-8000-000000000001";
const DEVICE_BORIS = "0000000b-0000-4000-8000-000000000002";
const MEMBER_ANNA = "0000000a-0000-4000-8000-00000000aaaa";
const MEMBER_BORIS = "0000000b-0000-4000-8000-00000000bbbb";
const FIRST_EPOCH = 1;

/** Операция приёмки: 4 000 ₽ — это 400 000 копеек. */
const TRANSPORT_4000: Transaction = {
  id: "55555555-5555-4555-8555-55555555aaaa",
  occurredOn: "2026-07-09",
  status: "posted",
  kind: "expense",
  amountMinor: 400_000,
  accountId: SEED_IDS.accounts.main,
  categoryId: SEED_IDS.categories.transport,
  memberId: MEMBER_ANNA,
};

const databaseNames = new Set<string>();

function databaseName(label: string): string {
  const value = `family-two-clients-${label}-${crypto.randomUUID()}`;
  databaseNames.add(value);
  return value;
}

afterEach(async () => {
  for (const name of databaseNames) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
  databaseNames.clear();
});

/** Журнальная половина сервера: нумерует принятое и отдаёт всё, что после курсора. */
class JournalServer implements SyncTransport {
  private readonly envelopes: DeliveredEnvelope[] = [];
  private received = 0;

  get stored(): readonly DeliveredEnvelope[] {
    return this.envelopes;
  }

  async submit(familyId: string, envelopes: readonly OutgoingEnvelope[]): Promise<SubmitResult> {
    if (familyId !== FAMILY_ID) throw new SyncServerError(403, "forbidden");
    const accepted: { opId: string; seq: number }[] = [];
    for (const envelope of envelopes) {
      const existing = this.envelopes.find(
        (stored) => stored.keyEpoch === envelope.keyEpoch && stored.opId === envelope.opId,
      );
      if (existing !== undefined) {
        accepted.push({ opId: envelope.opId, seq: existing.seq });
        continue;
      }
      this.received += 1;
      this.envelopes.push({ ...envelope, seq: this.envelopes.length + 1, receivedAt: this.received });
      accepted.push({ opId: envelope.opId, seq: this.envelopes.length });
    }
    return { keyEpoch: FIRST_EPOCH, accepted };
  }

  async fetch(familyId: string, query: FetchQuery): Promise<FetchResult> {
    if (familyId !== FAMILY_ID) throw new SyncServerError(403, "forbidden");
    const matching = this.envelopes
      .filter((envelope) => envelope.keyEpoch === query.keyEpoch && envelope.seq > query.after)
      .sort((left, right) => left.seq - right.seq);
    const page = matching.slice(0, query.limit);
    return { keyEpoch: query.keyEpoch, hasMore: matching.length > page.length, envelopes: page };
  }

  async keys(): Promise<KeysResult> {
    return { keyEpoch: FIRST_EPOCH, wraps: [] };
  }
}

interface Client {
  readonly repository: ReturnType<typeof createBudgetRepository>;
  readonly engine: SyncEngine;
  readonly apply: (change: (state: BudgetState) => BudgetState) => Promise<BudgetState>;
  readonly shown: () => BudgetState;
  readonly drain: () => Promise<void>;
  /** Приём чужих операций и показ того, что они записали, — ровно как это делает оболочка (`app/AppShell.tsx`). */
  readonly receive: () => Promise<{ readonly applied: number; readonly stopped: boolean }>;
}

/** Адрес, из которого приложение выводит имя участника (`memberNameFromEmail`): «анна» — «Анна». */
const EMAIL_OF: Readonly<Record<string, string>> = {
  [MEMBER_ANNA]: "анна@example.com",
  [MEMBER_BORIS]: "борис@example.com",
};

async function makeClient(
  label: string,
  transport: SyncTransport,
  deviceId: string,
  memberId: string,
  familyKey: CryptoKey,
  origin: JournalOrigin,
  accepts?: (state: BudgetState) => boolean,
  initial?: BudgetState,
): Promise<Client> {
  const repository = createBudgetRepository({ databaseName: databaseName(label) });
  const created = await repository.createIfAbsent(prepareBudgetState(initial ?? makeSeedBudget()));
  const engine = new SyncEngine({
    repository: repository as never,
    transport,
    familyId: FAMILY_ID,
    deviceId,
    familyKey,
    keyEpoch: FIRST_EPOCH,
    keyDigest: toHex(await familyKeyFingerprint(familyKey)),
    // The gate the application gives its engine (controller.ts), where a test asks for it — on
    // top of a rule of the test's own, standing in for an older build that does not open a record.
    ...(accepts === undefined ? {} : { acceptsState: (state: BudgetState) => acceptsJournalState(state) && accepts(state) }),
    // As controller.ts: the founder's budget is the family's from the first write.
    foundedDocument: origin === "local",
  });
  await repository.writeSyncState([{ key: JOURNAL_ORIGIN_KEY, value: origin }]);

  const writer = createBudgetJournalWriter({
    engineFor: async () => engine,
    store: repository as never,
    memberId: () => memberId,
    saveIfRevision: (revision, value) =>
      repository.saveIfRevision(revision, value as BudgetState) as never,
  });

  let shown = prepareBudgetState(created.value);
  let revision: string | null = null;
  const coordinator = createAppBudgetSaveCoordinator({
    repository: repository as never,
    getCurrent: () => shown,
    getRevision: () => revision,
    setRevision: (value) => {
      revision = value;
    },
    publish: (next, value) => {
      shown = next;
      revision = value;
    },
    journalWrite: () => writer,
  });

  const session = { email: EMAIL_OF[memberId] ?? "участник@example.com", familyId: FAMILY_ID, memberId, role: origin === "local" ? "owner" as const : "member" as const };
  /** Гонит очередь до конца: `push` отправляет пакетами, а посев больше одного пакета. */
  const drain = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await engine.push();
      if (result.pending === 0) return;
    }
    throw new Error("the outgoing queue did not drain");
  };

  return {
    repository,
    engine,
    apply: (change) => coordinator.apply(change),
    shown: () => shown,
    receive: async () => {
      const result = await engine.pull();
      // Как `useFamily`: показ — когда приём что-то сложил или снял задержку.
      if ((result.applied > 0 || result.settled) && !coordinator.locked) {
        const stored = await repository.loadVersioned();
        if (stored !== null) {
          shown = prepareBudgetState(stored.value);
          revision = stored.revision;
        }
      }
      // И, как он же, вписывает участника этого устройства, как только документ семьи пришёл, —
      // тем же путём записи, что и всякое изменение, и отправляет, как `afterWrite` приложения.
      const member = missingLocalMember(shown, await engine.documentStatus(), session);
      if (member !== null) {
        await coordinator.apply((state) => ({ ...state, members: [...(state.members ?? []).filter((item) => item.id !== member.id), member] }));
        await drain();
      }
      return { applied: result.applied, stopped: result.stop !== null };
    },
    drain,
  };
}

async function documentOf(client: Client): Promise<BudgetState> {
  const stored = await client.repository.loadVersioned();
  expect(stored).not.toBeNull();
  return prepareBudgetState(stored!.value);
}

describe("два клиента одной семьи", () => {
  it("операция 4 000 ₽ по «Транспорту» от 9 июля 2026 приходит ко второму с именем автора", async () => {
    const transport = new JournalServer();
    const familyKey = await generateFamilyKey();

    // Первый создал семью: его бюджет и есть бюджет семьи, поэтому посев — с его стороны.
    const anna = await makeClient("anna", transport, DEVICE_ANNA, MEMBER_ANNA, familyKey, "local");
    // Второй вступил по коду: бюджет придёт журналом, посева у него нет и быть не может.
    const boris = await makeClient("boris", transport, DEVICE_BORIS, MEMBER_BORIS, familyKey, "family");

    // Запись участника — обычное изменение бюджета, и первое: оно уносит в журнал всё состояние.
    await anna.apply((state) => ({
      ...state,
      members: [{ id: MEMBER_ANNA, name: "Анна", role: "owner", active: true }],
    }));
    expect(await anna.repository.countOutbox()).toBeGreaterThan(1);
    await anna.drain();
    expect(await anna.repository.countOutbox()).toBe(0);

    // Второй забирает журнал семьи и с этого момента показывает бюджет семьи, а не свой прежний.
    const firstDelivery = await boris.receive();
    expect(firstDelivery.stopped).toBe(false);
    expect(firstDelivery.applied).toBeGreaterThan(1);
    const joined = await documentOf(boris);
    // Третье ревью, S4: вместе с бюджетом семьи в нём появляется и участник второго устройства —
    // приложение вписывает его само, как только документ стал семейным.
    expect(joined.members?.map((member) => member.name)).toEqual(["Анна", "Борис"]);

    // И теперь — сама операция приёмки.
    await anna.apply((state) => ({ ...state, transactions: [...state.transactions, TRANSPORT_4000] }));
    expect(await anna.repository.countOutbox()).toBe(1);
    await anna.drain();

    const delivery = await boris.receive();
    expect(delivery.stopped).toBe(false);
    // The purchase, and Boris's own participant coming back numbered from the server.
    expect(delivery.applied).toBe(2);

    const seen = await documentOf(boris);
    const arrived = seen.transactions.find((entry) => entry.id === TRANSPORT_4000.id);
    expect(arrived).toBeDefined();
    expect(arrived!.amountMinor).toBe(400_000);
    expect(arrived!.occurredOn).toBe("2026-07-09");
    expect(arrived!.kind).toBe("expense");
    const category = seen.categories.find(
      (entry) => entry.id === (arrived as { readonly categoryId: string }).categoryId,
    );
    expect(category?.name).toBe("Транспорт");
    // То, что читает человек в истории на втором устройстве.
    expect(transactionAuthorLabel(membersById(seen), arrived!.memberId)).toBe("Анна");

    // И это не «у второго вместо своего»: у первого та же операция и та же сумма.
    const origin = await documentOf(anna);
    expect(origin.transactions.find((entry) => entry.id === TRANSPORT_4000.id)?.amountMinor).toBe(
      400_000,
    );
  });

  it("изменение второго участника возвращается первому, и оба показывают одно и то же", async () => {
    const transport = new JournalServer();
    const familyKey = await generateFamilyKey();
    const anna = await makeClient("anna-2", transport, DEVICE_ANNA, MEMBER_ANNA, familyKey, "local");
    const boris = await makeClient("boris-2", transport, DEVICE_BORIS, MEMBER_BORIS, familyKey, "family");

    await anna.apply((state) => ({
      ...state,
      members: [{ id: MEMBER_ANNA, name: "Анна", role: "owner", active: true }],
    }));
    await anna.drain();
    await boris.receive();

    // Второго приложение вписало само, как только пришёл бюджет семьи (`missingLocalMember`), —
    // вручную его никто не регистрирует.
    expect(boris.shown().members?.map((member) => member.name)).toEqual(["Анна", "Борис"]);
    // Второй записывает свою операцию: она уходит с его меткой участника.
    await boris.apply((state) => ({
      ...state,
      transactions: [
        ...state.transactions,
        { ...TRANSPORT_4000, id: "55555555-5555-4555-8555-55555555bbbb", memberId: MEMBER_BORIS },
      ],
    }));
    await boris.drain();
    await anna.receive();

    const seen = await documentOf(anna);
    const arrived = seen.transactions.find(
      (entry) => entry.id === "55555555-5555-4555-8555-55555555bbbb",
    );
    expect(arrived?.amountMinor).toBe(400_000);
    expect(transactionAuthorLabel(membersById(seen), arrived?.memberId)).toBe("Борис");
  });

  it("правка и удаление доходят как правка и удаление, а не как новая запись", async () => {
    const transport = new JournalServer();
    const familyKey = await generateFamilyKey();
    const anna = await makeClient("anna-3", transport, DEVICE_ANNA, MEMBER_ANNA, familyKey, "local");
    const boris = await makeClient("boris-3", transport, DEVICE_BORIS, MEMBER_BORIS, familyKey, "family");

    await anna.apply((state) => ({
      ...state,
      members: [{ id: MEMBER_ANNA, name: "Анна", role: "owner", active: true }],
      transactions: [...state.transactions, TRANSPORT_4000],
    }));
    await anna.drain();
    await boris.receive();
    expect((await documentOf(boris)).transactions).toHaveLength(6);

    // Правка суммы — одна операция, а не пересылка всего бюджета.
    await anna.apply((state) => ({
      ...state,
      transactions: state.transactions.map((entry) =>
        entry.id === TRANSPORT_4000.id ? { ...entry, amountMinor: 250_000 } : entry,
      ),
    }));
    expect(await anna.repository.countOutbox()).toBe(1);
    await anna.drain();
    await boris.receive();
    expect(
      (await documentOf(boris)).transactions.find((entry) => entry.id === TRANSPORT_4000.id)
        ?.amountMinor,
    ).toBe(250_000);

    // Удаление — тоже одна операция, и после него запись не возвращается.
    await anna.apply((state) => ({
      ...state,
      transactions: state.transactions.filter((entry) => entry.id !== TRANSPORT_4000.id),
    }));
    expect(await anna.repository.countOutbox()).toBe(1);
    await anna.drain();
    await boris.receive();
    const afterDelete = await documentOf(boris);
    expect(afterDelete.transactions.some((entry) => entry.id === TRANSPORT_4000.id)).toBe(false);
    expect(afterDelete.transactions).toHaveLength(5);
  });

  it("два устройства, открывшие август порознь, сходятся к одному бюджету, а не к двум", async () => {
    const transport = new JournalServer();
    const familyKey = await generateFamilyKey();
    const anna = await makeClient("anna-5", transport, DEVICE_ANNA, MEMBER_ANNA, familyKey, "local");
    const boris = await makeClient("boris-5", transport, DEVICE_BORIS, MEMBER_BORIS, familyKey, "family");

    // Общая отправная точка: июльский бюджет семьи есть у обоих.
    await anna.apply((state) => ({
      ...state,
      members: [{ id: MEMBER_ANNA, name: "Анна", role: "owner", active: true }],
    }));
    await anna.drain();
    await boris.receive();
    expect((await documentOf(boris)).budgets).toHaveLength(1);

    // Июль кончился. Каждая нажимает «Открыть август» у себя, не зная о другой: обе офлайн, и
    // ни одна операция ещё не ушла на сервер.
    await anna.apply((state) => carryBudgetForward(state, "2026-08").state);
    await boris.apply((state) => carryBudgetForward(state, "2026-08").state);

    await anna.drain();
    await boris.drain();
    await anna.receive();
    await boris.receive();

    for (const client of [anna, boris]) {
      const seen = await documentOf(client);
      // Один август на двоих, а не два: имя месяца выведено из июльского бюджета и самого
      // месяца, поэтому обе назвали одно и то же, и журнал свёл две записи в одну.
      expect(seen.budgets).toHaveLength(2);
      const august = seen.budgets.find((budget) => budget.startDate === "2026-08-01");
      expect(august?.id).toBe(carriedBudgetId(SEED_IDS.budget, "2026-08"));
      expect(seen.activeBudgetId).toBe(august?.id);
      expect(august?.endDate).toBe("2026-08-31");
      // По одной строке на категорию — и остаток транспорта на месте: 10 000 плана, 5 000 факта.
      expect(august?.lines.map((line) => line.categoryId).sort()).toEqual(
        [SEED_IDS.categories.housing, SEED_IDS.categories.food, SEED_IDS.categories.transport].sort(),
      );
      const transportLine = august?.lines.find((line) => line.categoryId === SEED_IDS.categories.transport);
      expect(transportLine?.plannedMinor).toBe(1_000_000);
      expect(transportLine?.rolloverMinor).toBe(500_000);
      expect(calculateBudget(seen).categoryMetrics[SEED_IDS.categories.transport]?.availableMinor).toBe(1_500_000);
    }

    // И оба устройства показывают буквально одно и то же состояние.
    expect(await documentOf(boris)).toEqual(await documentOf(anna));
  });

  it("пока состояние семьи не открывается этой версией, устройство только читает и ничего не шлёт", async () => {
    // Второе ревью, MEDIUM-2 и MEDIUM-3: запись, сделанная на задержанном документе, собрана не из
    // состояния журнала и ушла бы семье целыми сущностями под меткой, перебивающей чужие правки.
    const transport = new JournalServer();
    const familyKey = await generateFamilyKey();
    // A peer's account this test's "older build" does not open. A UUID on purpose: the hold is a
    // version skew, and whatever the journal itself can tell is wrong it withholds instead.
    const STRANGER = "7bbbbbbb-bbbb-4bbb-8bbb-00000000beef";
    const olderBuild = (state: BudgetState) => state.accounts.every((account) => account.id !== STRANGER);
    const anna = await makeClient("anna-6", transport, DEVICE_ANNA, MEMBER_ANNA, familyKey, "local");
    const boris = await makeClient("boris-6", transport, DEVICE_BORIS, MEMBER_BORIS, familyKey, "family", olderBuild);

    await anna.apply((state) => ({
      ...state,
      members: [{ id: MEMBER_ANNA, name: "Анна", role: "owner", active: true }],
    }));
    await anna.drain();
    await boris.receive();
    expect((await boris.engine.status()).hold).toBeNull();

    await anna.engine.enqueue([{
      entity: "account",
      action: "create",
      targetId: STRANGER,
      fields: { name: "Чужой", type: "cash", currency: "RUB", openingBalanceMinor: 0, active: true },
    }]);
    await anna.drain();
    const before = await documentOf(boris);
    const delivery = await boris.receive();
    // The stranger account, and Boris's own participant coming back numbered.
    expect(delivery).toEqual({ applied: 2, stopped: false });

    // The document stays on what opened, and the device says so instead of saying nothing.
    expect(await documentOf(boris)).toEqual(before);
    expect((await boris.engine.status()).hold).toEqual({ reason: "rejected_by_app", document: "kept" });

    // Boris's expense is refused with words the form shows, and nothing is queued or written.
    const own = { ...TRANSPORT_4000, id: "55555555-5555-4555-8555-55555555cccc", memberId: MEMBER_BORIS };
    const revision = (await boris.repository.loadVersioned())!.revision;
    const refusal = await boris.apply((state) => ({ ...state, transactions: [...state.transactions, own] })).catch((failure: unknown) => failure);
    expect(refusal).toBeInstanceOf(BudgetWriteRefusal);
    expect((refusal as BudgetWriteRefusal).message).toBe(WRITE_REFUSAL_TEXT.held);
    expect(toOperationsErrorView(refusal).message).toBe(WRITE_REFUSAL_TEXT.held);
    expect(await boris.repository.countOutbox()).toBe(0);
    expect((await boris.repository.loadVersioned())!.revision).toBe(revision);
    expect(boris.shown().transactions.map((entry) => entry.id)).not.toContain(own.id);
    // Not even a save that changes no entity reaches the document past the hold.
    const reordered = await boris.apply((state) => ({ ...state, accounts: [...state.accounts].reverse() })).catch((failure: unknown) => failure);
    expect(reordered).toBeInstanceOf(BudgetWriteRefusal);
    expect((await boris.repository.loadVersioned())!.revision).toBe(revision);

    // The writer takes its account back; the state opens again, and Boris writes as before.
    await anna.engine.enqueue([{ entity: "account", action: "delete", targetId: STRANGER }]);
    await anna.drain();
    await boris.receive();
    expect((await boris.engine.status()).hold).toBeNull();
    await boris.apply((state) => ({ ...state, transactions: [...state.transactions, own] }));
    expect(await boris.repository.countOutbox()).toBe(1);
    await boris.drain();
    await anna.receive();
    expect(anna.shown().transactions.map((entry) => entry.id)).toContain(own.id);
    expect(anna.shown().members?.map((member) => member.name)).toEqual(["Анна", "Борис"]);
  });

  it("вступившее устройство не пишет семье из бюджета, который был у него до вступления", async () => {
    // Второе ревью, MEDIUM-3 (b): личные счета вступившего ушли бы семье как семейные.
    const transport = new JournalServer();
    const familyKey = await generateFamilyKey();
    const anna = await makeClient("anna-7", transport, DEVICE_ANNA, MEMBER_ANNA, familyKey, "local");
    const boris = await makeClient("boris-7", transport, DEVICE_BORIS, MEMBER_BORIS, familyKey, "family");
    await anna.apply((state) => ({
      ...state,
      members: [{ id: MEMBER_ANNA, name: "Анна", role: "owner", active: true }],
    }));
    await anna.drain();

    // Before the family's budget has reached Boris his own budget is on the device, and it is not
    // the family's: his edit is refused, nothing queued.
    expect((await boris.engine.status()).familyDocument).toBe(false);
    const refusal = await boris.apply((state) => ({ ...state, accounts: state.accounts.map((account) => ({ ...account, name: "Мой личный" })) })).catch((failure: unknown) => failure);
    expect(refusal).toBeInstanceOf(BudgetWriteRefusal);
    expect((refusal as BudgetWriteRefusal).message).toBe(WRITE_REFUSAL_TEXT.pending);
    expect(await boris.repository.countOutbox()).toBe(0);

    // The family's budget arrives, the document becomes the family's, and Boris writes.
    await boris.receive();
    expect((await boris.engine.status()).familyDocument).toBe(true);
    await boris.apply((state) => ({ ...state, transactions: [...state.transactions, { ...TRANSPORT_4000, memberId: MEMBER_BORIS }] }));
    await boris.drain();
    await anna.receive();
    expect(anna.shown().accounts.map((account) => account.name)).not.toContain("Мой личный");
    expect(anna.shown().transactions.map((entry) => entry.id)).toContain(TRANSPORT_4000.id);
  });

  it("сохранение, ничего не изменившее, не рассылает семье ни одной операции", async () => {
    const transport = new JournalServer();
    const familyKey = await generateFamilyKey();
    const anna = await makeClient("anna-4", transport, DEVICE_ANNA, MEMBER_ANNA, familyKey, "local");

    await anna.apply((state) => ({
      ...state,
      members: [{ id: MEMBER_ANNA, name: "Анна", role: "owner", active: true }],
    }));
    await anna.drain();

    // Тот же бюджет, только счета переставлены местами: для журнала это не изменение.
    await anna.apply((state) => ({ ...state, accounts: [...state.accounts].reverse() }));
    expect(await anna.repository.countOutbox()).toBe(0);
    expect(transport.stored.length).toBeGreaterThan(0);
  });
});

/*
 * Третье ревью волны 1: сценарии S1–S6 ревьюера, перенесённые как регрессионные. Подготовка —
 * его; ожидания обращены к правильному поведению. Одно отличие подготовки: запись, которую сделала
 * бы «чужая» сборка или враждебное устройство (счёт, которого эта версия не открывает, удаление
 * активного бюджета), пишет третье устройство без документа семьи (`peer`), а не движок Анны: движок
 * устройства с документом семьи такую запись теперь сам не пропускает.
 */
const STRANGER_ACCOUNT_ID = "7bbbbbbb-bbbb-4bbb-8bbb-00000000beef";
const DEVICE_PEER = "0000000c-0000-4000-8000-000000000003";
const strangerAccount = {
  entity: "account" as const,
  action: "create" as const,
  targetId: STRANGER_ACCOUNT_ID,
  fields: { name: "Чужой", type: "current" as const, currency: "RUB", openingBalanceMinor: 0, active: true },
};
const activeBudgetGone = { entity: "budget" as const, action: "delete" as const, targetId: SEED_IDS.budget };
const olderBuildRefusesStranger = (state: BudgetState) => state.accounts.every((account) => account.id !== STRANGER_ACCOUNT_ID);

/** Устройство другой сборки или враждебное: пишет в журнал семьи что угодно и сразу отправляет. */
async function peerWrites(label: string, transport: SyncTransport, familyKey: CryptoKey, drafts: Parameters<SyncEngine["enqueue"]>[0]): Promise<void> {
  const repository = createBudgetRepository({ databaseName: databaseName(`peer-${label}`) });
  const engine = new SyncEngine({
    repository: repository as never,
    transport,
    familyId: FAMILY_ID,
    deviceId: DEVICE_PEER,
    familyKey,
    keyEpoch: FIRST_EPOCH,
    keyDigest: toHex(await familyKeyFingerprint(familyKey)),
  });
  await engine.enqueue(drafts);
  await engine.push();
}

async function seededFamily(label: string, borisAccepts?: (state: BudgetState) => boolean) {
  const transport = new JournalServer();
  const familyKey = await generateFamilyKey();
  const anna = await makeClient(`anna-${label}`, transport, DEVICE_ANNA, MEMBER_ANNA, familyKey, "local");
  const boris = await makeClient(`boris-${label}`, transport, DEVICE_BORIS, MEMBER_BORIS, familyKey, "family", borisAccepts);
  await anna.apply((state) => ({ ...state, members: [{ id: MEMBER_ANNA, name: "Анна", role: "owner", active: true }] }));
  await anna.drain();
  await boris.receive();
  await anna.receive();
  return { transport, familyKey, anna, boris };
}

const mainAccountOf = (state: BudgetState) => state.accounts.find((account) => account.id === SEED_IDS.accounts.main)!;
const renameMain = (name: string) => (state: BudgetState): BudgetState => ({
  ...state,
  accounts: state.accounts.map((account) => (account.id === SEED_IDS.accounts.main ? { ...account, name } : account)),
});
const raiseMainBalance = (state: BudgetState): BudgetState => ({
  ...state,
  accounts: state.accounts.map((account) => (account.id === SEED_IDS.accounts.main ? { ...account, openingBalanceMinor: account.openingBalanceMinor + 100 } : account)),
});

describe("документ семьи после третьего ревью: экран, с которого пишут, — это документ", () => {
  it("S1: снятая задержка не даёт записать правку с задержанного экрана, и переименование другого участника не откатывается", async () => {
    let upgraded = false;
    const { transport, familyKey, anna, boris } = await seededFamily("s1", (state) => upgraded || olderBuildRefusesStranger(state));
    await peerWrites("s1", transport, familyKey, [strangerAccount]);
    await anna.receive();
    await anna.apply(renameMain("Переименован Анной"));
    await anna.drain();
    await boris.receive();
    expect((await boris.engine.status()).hold).toEqual({ reason: "rejected_by_app", document: "kept" });
    const staleName = mainAccountOf(boris.shown()).name;
    expect(staleName).not.toBe("Переименован Анной");

    // Boris installs the build that opens the state; his screen still shows the held document. The
    // write that lifts the hold does not go out on top of it: it is a conflict, the screen is given
    // the document, and nothing is queued.
    upgraded = true;
    const queued = await boris.repository.countOutbox();
    await expect(boris.apply(raiseMainBalance)).rejects.toThrow(BUDGET_WRITE_CONFLICT_MESSAGE);
    expect(await boris.repository.countOutbox()).toBe(queued);
    expect(mainAccountOf(boris.shown()).name).toBe("Переименован Анной");

    // Repeated on what the document holds, the edit keeps Anna's rename for the whole family.
    await boris.apply(raiseMainBalance);
    await boris.drain();
    await anna.receive();
    const annaMain = mainAccountOf(await documentOf(anna));
    expect(annaMain.name).toBe("Переименован Анной");
    expect(annaMain.openingBalanceMinor).toBe(mainAccountOf(makeSeedBudget()).openingBalanceMinor + 100);
  });

  it("S2: журнал без показуемого бюджета — только чтение: запись не «сохраняется» мимо экрана и не откатывает правку другого участника", async () => {
    const { transport, familyKey, anna, boris } = await seededFamily("s2");
    expect((await documentOf(anna)).budgets.map((budget) => budget.id)).toEqual([SEED_IDS.budget]);
    // One hostile (or partial) operation: the only activated budget is deleted.
    await peerWrites("s2", transport, familyKey, [activeBudgetGone]);
    await anna.receive();
    await boris.receive();
    const { restoreJournal } = await import("@family-budget/sync-protocol");
    expect(restoreJournal(await boris.repository.readSyncState("journal")).integrity.ready).toBe(false);
    expect((await boris.engine.status()).hold).toEqual({ reason: "journal_not_ready", document: "kept" });
    expect((await anna.engine.status()).hold).toEqual({ reason: "journal_not_ready", document: "kept" });
    expect((await boris.engine.documentStatus()).familyDocument).toBe(true);

    // Anna's rename is refused with words, not reported saved: nothing queued, nothing hidden.
    const annaQueued = await anna.repository.countOutbox();
    const rename = await anna.apply(renameMain("Переименован Анной")).catch((failure: unknown) => failure);
    expect((rename as BudgetWriteRefusal).message).toBe(WRITE_REFUSAL_TEXT.notReady);
    expect(await anna.repository.countOutbox()).toBe(annaQueued);

    // So are Boris's purchase and his edit of the same account from the stale view.
    const own = { ...TRANSPORT_4000, id: "55555555-5555-4555-8555-55555555dddd", memberId: MEMBER_BORIS };
    const borisQueued = await boris.repository.countOutbox();
    const purchase = await boris.apply((state) => ({ ...state, transactions: [...state.transactions, own] })).catch((failure: unknown) => failure);
    expect((purchase as BudgetWriteRefusal).message).toBe(WRITE_REFUSAL_TEXT.notReady);
    const stale = await boris.apply(raiseMainBalance).catch((failure: unknown) => failure);
    expect(stale).toBeInstanceOf(BudgetWriteRefusal);
    expect(await boris.repository.countOutbox()).toBe(borisQueued);

    // The family recovers with a new budget: the one write a not-ready journal lets through is the
    // one whose result can be shown — here «Открыть месяц», the screen's own way of making one.
    await anna.apply((state) => carryBudgetForward(state, "2026-08").state);
    await anna.drain();
    await boris.receive();
    expect((await anna.engine.status()).hold).toBeNull();
    expect((await boris.engine.status()).hold).toBeNull();
    expect((await documentOf(boris)).activeBudgetId).toBe(carriedBudgetId(SEED_IDS.budget, "2026-08"));

    // And then both write, each on the other's latest: the rename survives the balance edit.
    await anna.apply(renameMain("Переименован Анной"));
    await anna.drain();
    await boris.receive();
    await boris.apply(raiseMainBalance);
    await boris.drain();
    await anna.receive();
    const finalAnna = await documentOf(anna);
    expect(mainAccountOf(finalAnna).name).toBe("Переименован Анной");
    expect(finalAnna.transactions.some((entry) => entry.id === own.id)).toBe(false);
  });

  it("S2b: свёртка, после которой бюджет нельзя показать, не снимает задержку и не открывает записи с задержанного документа", async () => {
    const { transport, familyKey, boris } = await seededFamily("s2b", olderBuildRefusesStranger);
    await peerWrites("s2b-account", transport, familyKey, [strangerAccount]);
    await boris.receive();
    expect((await boris.engine.status()).hold).toEqual({ reason: "rejected_by_app", document: "kept" });
    await peerWrites("s2b-budget", transport, familyKey, [activeBudgetGone]);
    await boris.receive();
    expect((await boris.engine.status()).hold).toEqual({ reason: "rejected_by_app", document: "kept" });
    const before = await boris.repository.countOutbox();
    const refusal = await boris.apply(renameMain("Из задержанного")).catch((failure: unknown) => failure);
    expect((refusal as BudgetWriteRefusal).message).toBe(WRITE_REFUSAL_TEXT.held);
    expect(await boris.repository.countOutbox()).toBe(before);
  });

  it("S3: снятие задержки читает документ раньше журнала, и запись другой вкладки между ними не пропадает из документа", async () => {
    const { anna } = await seededFamily("s3");
    // A build that kept no record (first launch after the update): the record is absent.
    await anna.repository.writeSyncState([{ key: "family-document", value: null }]);
    const repository = anna.repository as unknown as Record<string, unknown>;
    let fired = false;
    const purchase = { ...TRANSPORT_4000, id: "55555555-5555-4555-8555-55555555eeee" };
    const proxy = new Proxy(repository, {
      get(target, property) {
        if (property === "readSyncState") {
          return async (key: string) => {
            const value = await (target.readSyncState as (key: string) => Promise<unknown>).call(target, key);
            if (key === "journal" && !fired) {
              fired = true;
              // The other tab writes now, between this tab's document read and its journal read.
              await anna.apply((state) => ({ ...state, transactions: [...state.transactions, purchase] }));
            }
            return value;
          };
        }
        const value = target[property as string];
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const familyKey = (anna.engine as unknown as { familyKey: CryptoKey }).familyKey;
    const tab = new SyncEngine({
      repository: proxy as never,
      transport: new JournalServer(),
      familyId: FAMILY_ID,
      deviceId: DEVICE_ANNA,
      familyKey,
      keyEpoch: FIRST_EPOCH,
      keyDigest: toHex(await familyKeyFingerprint(familyKey)),
      foundedDocument: true,
    });
    expect(fired).toBe(false);
    await tab.settleDocument();
    expect(fired).toBe(true);
    const document = await documentOf(anna);
    const { restoreJournal } = await import("@family-budget/sync-protocol");
    const journal = restoreJournal(await anna.repository.readSyncState("journal"));
    expect(journal.state.transactions.some((entry) => entry.id === purchase.id)).toBe(true);
    expect(document.transactions.some((entry) => entry.id === purchase.id)).toBe(true);
  });

  it("S4: участник вступившего устройства, которому до прихода бюджета семьи отказано, вписывается сам, как только бюджет пришёл", async () => {
    const transport = new JournalServer();
    const familyKey = await generateFamilyKey();
    const anna = await makeClient("anna-s4", transport, DEVICE_ANNA, MEMBER_ANNA, familyKey, "local");
    const boris = await makeClient("boris-s4", transport, DEVICE_BORIS, MEMBER_BORIS, familyKey, "family");
    await anna.apply((state) => ({ ...state, members: [{ id: MEMBER_ANNA, name: "Анна", role: "owner", active: true }] }));
    await anna.drain();
    // joinByCode → registerLocalMember, exactly as the app shell used to: an ordinary budget change, and
    // refused — the budget on the device is not the family's yet.
    const refusal = await boris.apply((state) => ({ ...state, members: [...(state.members ?? []).filter((item) => item.id !== MEMBER_BORIS), { id: MEMBER_BORIS, name: "Борис", role: "member", active: true }] })).catch((failure: unknown) => failure);
    expect((refusal as BudgetWriteRefusal).reason).toBe("pending");
    await boris.receive();
    const own = { ...TRANSPORT_4000, id: "55555555-5555-4555-8555-55555555ffff", memberId: MEMBER_BORIS };
    await boris.apply((state) => ({ ...state, transactions: [...state.transactions, own] }));
    await boris.drain();
    await anna.receive();
    const seen = await documentOf(anna);
    const arrived = seen.transactions.find((entry) => entry.id === own.id);
    expect(seen.members?.some((member) => member.id === MEMBER_BORIS)).toBe(true);
    expect(arrived?.memberId).toBe(MEMBER_BORIS);
    expect(transactionAuthorLabel(membersById(seen), arrived?.memberId)).toBe("Борис");
    // Once, not on every round.
    await boris.receive();
    expect((await documentOf(boris)).members?.filter((member) => member.id === MEMBER_BORIS)).toHaveLength(1);
    expect(await boris.repository.countOutbox()).toBe(0);
  });

  it("S5: круг без сети снимает задержку на диске и говорит экрану, что показывать новое", async () => {
    let upgraded = false;
    const { transport, familyKey, boris } = await seededFamily("s5", (state) => upgraded || olderBuildRefusesStranger(state));
    await peerWrites("s5", transport, familyKey, [strangerAccount]);
    await boris.receive();
    expect((await boris.engine.status()).hold).not.toBeNull();
    upgraded = true;
    const offline = new SyncEngine({
      repository: boris.repository as never,
      transport: { submit: async () => { throw new TypeError("Failed to fetch"); }, fetch: async () => { throw new TypeError("Failed to fetch"); }, keys: async () => { throw new TypeError("Failed to fetch"); } } as never,
      familyId: FAMILY_ID, deviceId: DEVICE_BORIS,
      familyKey: (boris.engine as unknown as { familyKey: CryptoKey }).familyKey,
      keyEpoch: FIRST_EPOCH,
      keyDigest: (boris.engine as unknown as { keyDigest: string }).keyDigest,
      acceptsState: (state) => acceptsJournalState(state),
    });
    const round = await runSyncRound(offline);
    expect(round.outcome).not.toBe("ok");
    expect(round.settled).toBe(true);
    expect((await offline.status()).hold).toBeNull();
  });

  it("S6: вступившее устройство, обновлённое офлайн под задержкой «empty», не выдаёт личный бюджет за семейный и не пишет его семье", async () => {
    let upgraded = false;
    const transport = new JournalServer();
    const familyKey = await generateFamilyKey();
    const PERSONAL = "22222222-2222-4222-8222-2222222299aa";
    const seed = makeSeedBudget();
    const personal: BudgetState = { ...seed, accounts: [...seed.accounts, { ...seed.accounts[0]!, id: PERSONAL, name: "Личная карта Бориса" }] };
    const anna = await makeClient("anna-s6", transport, DEVICE_ANNA, MEMBER_ANNA, familyKey, "local");
    const boris = await makeClient("boris-s6", transport, DEVICE_BORIS, MEMBER_BORIS, familyKey, "family", (state) => upgraded || olderBuildRefusesStranger(state), personal);
    await anna.apply((state) => ({ ...state, members: [{ id: MEMBER_ANNA, name: "Анна", role: "owner", active: true }] }));
    await anna.engine.enqueue([strangerAccount]);
    await anna.drain();
    await boris.receive();
    expect((await boris.engine.status()).hold).toEqual({ reason: "rejected_by_app", document: "empty" });
    expect((await boris.engine.status()).familyDocument).toBe(false);
    upgraded = true;
    // The round settles before the network and says so although the network fails.
    const round = await runSyncRound({ settleDocument: () => boris.engine.settleDocument(), sync: async () => { throw new TypeError("Failed to fetch"); } });
    expect(round.settled).toBe(true);
    const status = await boris.engine.status();
    expect(status.hold).toBeNull();
    expect(status.familyDocument).toBe(true);
    // What became the family's document is the family's state, never the personal budget.
    expect((await documentOf(boris)).accounts.some((account) => account.id === PERSONAL)).toBe(false);

    // A screen still on the personal budget cannot write the family from it: a conflict, the
    // family's document shown, nothing queued.
    expect(boris.shown().accounts.some((account) => account.id === PERSONAL)).toBe(true);
    const queued = await boris.repository.countOutbox();
    await expect(boris.apply((state) => ({ ...state, accounts: state.accounts.map((account) => (account.id === PERSONAL ? { ...account, name: "Личная карта Бориса (новая)" } : account)) })))
      .rejects.toThrow(BUDGET_WRITE_CONFLICT_MESSAGE);
    expect(await boris.repository.countOutbox()).toBe(queued);
    expect(boris.shown().accounts.some((account) => account.id === PERSONAL)).toBe(false);
    await boris.drain();
    await anna.receive();
    expect((await documentOf(anna)).accounts.some((account) => account.id === PERSONAL)).toBe(false);
  });
});
