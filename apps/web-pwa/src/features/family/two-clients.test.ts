/**
 * Приёмка фазы S6, как тест: два клиента, одна семья, одна операция, одно имя автора.
 *
 * «Операция `4 000 ₽` по «Транспорту» от 9 июля 2026, введённая на первом, появляется у второго
 * с именем автора» — это здесь и проверяется, и проверяется целиком тем же путём, каким идёт
 * приложение: координатор записи из `App.tsx`, тот же `createBudgetJournalWriter`, тот же
 * `SyncEngine`, те же запечатанные конверты. Подменён только транспорт — журнальная половина
 * сервера, переписанная по 3.3 и 3.4, потому что настоящий сервер нельзя честно попросить
 * доставить пакет ровно тогда, когда этого хочет тест.
 *
 * Ничего в этом файле не сравнивает состояния «через приложение»: сходство доказывается суммой,
 * датой, названием категории и именем участника, то есть теми четырьмя величинами, которые видит
 * человек на экране второго устройства.
 */
import "fake-indexeddb/auto";
import { makeSeedBudget, SEED_IDS, type BudgetState, type Transaction } from "@family-budget/domain";
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

import { createAppBudgetSaveCoordinator } from "../../App";
import { prepareBudgetState } from "../../backup";
import { createBudgetRepository } from "../../storage-repository";
import {
  createBudgetJournalWriter,
  JOURNAL_ORIGIN_KEY,
  type JournalOrigin,
} from "./controller";
import { membersById, transactionAuthorLabel } from "./model";

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
  /** Приём чужих операций и показ того, что они записали, — ровно как это делает `App.tsx`. */
  readonly receive: () => Promise<{ readonly applied: number; readonly stopped: boolean }>;
}

async function makeClient(
  label: string,
  transport: SyncTransport,
  deviceId: string,
  memberId: string,
  familyKey: CryptoKey,
  origin: JournalOrigin,
): Promise<Client> {
  const repository = createBudgetRepository({ databaseName: databaseName(label) });
  const created = await repository.createIfAbsent(prepareBudgetState(makeSeedBudget()));
  const engine = new SyncEngine({
    repository: repository as never,
    transport,
    familyId: FAMILY_ID,
    deviceId,
    familyKey,
    keyEpoch: FIRST_EPOCH,
    keyDigest: toHex(await familyKeyFingerprint(familyKey)),
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

  return {
    repository,
    engine,
    apply: (change) => coordinator.apply(change),
    shown: () => shown,
    receive: async () => {
      const result = await engine.pull();
      if (result.applied > 0 && !coordinator.locked) {
        const stored = await repository.loadVersioned();
        if (stored !== null) {
          shown = prepareBudgetState(stored.value);
          revision = stored.revision;
        }
      }
      return { applied: result.applied, stopped: result.stop !== null };
    },
    /** Гонит очередь до конца: `push` отправляет пакетами, а посев больше одного пакета. */
    drain: async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = await engine.push();
        if (result.pending === 0) return;
      }
      throw new Error("the outgoing queue did not drain");
    },
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
    expect(joined.members?.map((member) => member.name)).toEqual(["Анна"]);

    // И теперь — сама операция приёмки.
    await anna.apply((state) => ({ ...state, transactions: [...state.transactions, TRANSPORT_4000] }));
    expect(await anna.repository.countOutbox()).toBe(1);
    await anna.drain();

    const delivery = await boris.receive();
    expect(delivery.stopped).toBe(false);
    expect(delivery.applied).toBe(1);

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

    // Второй называет себя — и это тоже обычное изменение бюджета, идущее журналом.
    await boris.apply((state) => ({
      ...state,
      members: [...(state.members ?? []), { id: MEMBER_BORIS, name: "Борис", role: "member", active: true }],
    }));
    await boris.drain();
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
