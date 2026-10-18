import {
  makeSeedBudget,
  materializeRecurring,
  SEED_IDS,
  type BudgetState,
  type RecurringRule,
  type Transaction,
} from "@family-budget/domain";
import type { JournalEntry } from "@family-budget/sync-protocol";
import { describe, expect, it } from "vitest";

import { formatMoney } from "../../money";
import { membersById } from "./model";
import {
  authorsOfTransactions,
  familyNewsLines,
  familyNewsSince,
  transactionIds,
  type OwnAuthor,
} from "./news";

const DEVICE_ANNA = "0000000a-0000-4000-8000-000000000001";
const DEVICE_ANNA_PHONE = "0000000a-0000-4000-8000-000000000003";
const DEVICE_BORIS = "0000000b-0000-4000-8000-000000000002";
const MEMBER_ANNA = "0000000a-0000-4000-8000-00000000aaaa";
const MEMBER_BORIS = "0000000b-0000-4000-8000-00000000bbbb";

const ANNA: OwnAuthor = { deviceId: DEVICE_ANNA, memberId: MEMBER_ANNA };

function expense(id: string, amountMinor: number, occurredOn = "2026-07-09"): Transaction {
  return {
    id,
    occurredOn,
    status: "posted",
    kind: "expense",
    amountMinor,
    accountId: SEED_IDS.accounts.main,
    categoryId: SEED_IDS.categories.food,
  };
}

function income(id: string, amountMinor: number): Transaction {
  return {
    id,
    occurredOn: "2026-07-05",
    status: "posted",
    kind: "income",
    amountMinor,
    accountId: SEED_IDS.accounts.main,
  };
}

/** Заголовок выигравшей операции журнала: кто и с какого устройства её записал. */
function entry(
  targetId: string,
  deviceId: string,
  memberId: string | undefined,
  action: "create" | "update" | "delete" = "create",
): JournalEntry {
  return {
    opId: `op-${targetId}-${action}`,
    deviceId,
    lamport: 1,
    ...(memberId === undefined ? {} : { memberId }),
    entity: "transaction",
    action,
    targetId,
    fields: {},
  } as unknown as JournalEntry;
}

function withMembers(state: BudgetState, transactions: readonly Transaction[]): BudgetState {
  return {
    ...state,
    members: [
      { id: MEMBER_ANNA, name: "Анна", role: "owner", active: true },
      { id: MEMBER_BORIS, name: "Борис", role: "member", active: true },
    ],
    transactions: [...state.transactions, ...transactions],
  };
}

describe("семейная новость: что пришло с прошлого раза", () => {
  const seed = makeSeedBudget();
  const seen = transactionIds(seed);

  it("срабатывает только при количестве больше нуля: без чужих записей списка нет", () => {
    // Свои записи — не новость: их человек сделал сам.
    const own = withMembers(seed, [expense("t-own", 120_000)]);
    const authors = authorsOfTransactions([entry("t-own", DEVICE_ANNA, MEMBER_ANNA)]);
    expect(familyNewsSince(seen, own, authors, ANNA)).toEqual([]);
    // Ничего нового вообще.
    expect(familyNewsSince(seen, seed, new Map(), ANNA)).toEqual([]);
  });

  it("в одиночном режиме не срабатывает никогда — даже при чужих метках в бюджете", () => {
    const state = withMembers(seed, [expense("t-boris", 150_000)]);
    const authors = authorsOfTransactions([entry("t-boris", DEVICE_BORIS, MEMBER_BORIS)]);
    // Синхронизация не настроена или входа нет: `own` равен `null`, и это первая же проверка.
    expect(familyNewsSince(new Set(), state, authors, null)).toEqual([]);
    expect(familyNewsSince(seen, state, authors, null)).toEqual([]);
  });

  it("называет чужие проведённые операции, которых не было в прошлый раз", () => {
    const state = withMembers(seed, [expense("t-boris", 150_000), expense("t-anna", 90_000)]);
    const authors = authorsOfTransactions([
      entry("t-boris", DEVICE_BORIS, MEMBER_BORIS),
      entry("t-anna", DEVICE_ANNA, MEMBER_ANNA),
    ]);
    const news = familyNewsSince(seen, state, authors, ANNA);
    expect(news.map((item) => item.transaction.id)).toEqual(["t-boris"]);
    expect(news[0]?.memberId).toBe(MEMBER_BORIS);
  });

  it("не возвращается за тем же: увиденное входит в «прошлый раз»", () => {
    const state = withMembers(seed, [expense("t-boris", 150_000)]);
    const authors = authorsOfTransactions([entry("t-boris", DEVICE_BORIS, MEMBER_BORIS)]);
    expect(familyNewsSince(seen, state, authors, ANNA)).toHaveLength(1);
    // Человек увидел — «прошлый раз» стал нынешним состоянием.
    const seenNow = transactionIds(state);
    expect(familyNewsSince(seenNow, state, authors, ANNA)).toEqual([]);
    // И следующая чужая запись — снова новость, но только она одна.
    const later = withMembers(seed, [expense("t-boris", 150_000), expense("t-boris-2", 30_000)]);
    const laterAuthors = authorsOfTransactions([
      entry("t-boris", DEVICE_BORIS, MEMBER_BORIS),
      entry("t-boris-2", DEVICE_BORIS, MEMBER_BORIS),
    ]);
    expect(familyNewsSince(seenNow, later, laterAuthors, ANNA).map((item) => item.transaction.id)).toEqual(["t-boris-2"]);
  });

  it("второе устройство того же участника — не «второй участник»", () => {
    const state = withMembers(seed, [expense("t-phone", 50_000)]);
    const authors = authorsOfTransactions([entry("t-phone", DEVICE_ANNA_PHONE, MEMBER_ANNA)]);
    expect(familyNewsSince(seen, state, authors, ANNA)).toEqual([]);
    // Без участника в заголовке решает устройство: чужое устройство — новость.
    const nameless = authorsOfTransactions([entry("t-phone", DEVICE_BORIS, undefined)]);
    expect(familyNewsSince(seen, state, nameless, ANNA)).toHaveLength(1);
  });

  it("операцию без автора в журнале и непроведённую операцию новостью не считает", () => {
    const state = withMembers(seed, [
      expense("t-unknown", 10_000),
      { ...expense("t-planned", 20_000), status: "planned" as Transaction["status"] },
    ]);
    const authors = authorsOfTransactions([entry("t-planned", DEVICE_BORIS, MEMBER_BORIS)]);
    expect(familyNewsSince(seen, state, authors, ANNA)).toEqual([]);
  });

  it("автор — выигравшая запись: правка другого участника переводит операцию на него", () => {
    const authors = authorsOfTransactions([
      entry("t-1", DEVICE_ANNA, MEMBER_ANNA, "create"),
      entry("t-1", DEVICE_BORIS, MEMBER_BORIS, "update"),
      entry("t-2", DEVICE_BORIS, MEMBER_BORIS, "delete"),
    ]);
    expect(authors.get("t-1")).toEqual({ deviceId: DEVICE_BORIS, memberId: MEMBER_BORIS });
    expect(authors.has("t-2")).toBe(false);
  });
});

describe("семейная новость словами", () => {
  const seed = makeSeedBudget();

  it("сообщает, а не поздравляет: имя, виды и суммы — без глагола и восклицаний", () => {
    const state = withMembers(seed, [
      expense("t-1", 300_000),
      expense("t-2", 150_000),
      income("t-3", 8_000_000),
    ]);
    const authors = authorsOfTransactions([
      entry("t-1", DEVICE_BORIS, MEMBER_BORIS),
      entry("t-2", DEVICE_BORIS, MEMBER_BORIS),
      entry("t-3", DEVICE_BORIS, MEMBER_BORIS),
    ]);
    const lines = familyNewsLines(familyNewsSince(transactionIds(seed), state, authors, ANNA), membersById(state));
    expect(lines).toEqual([`Борис: 2 покупки на ${formatMoney(450_000)} и 1 доход на ${formatMoney(8_000_000)}`]);
    for (const line of lines) {
      expect(line).not.toMatch(/!/u);
      expect(line).not.toMatch(/молодец|отлично|поздравля|ура/iu);
    }
  });

  it("по строке на участника, участники по имени", () => {
    const state = withMembers(seed, [expense("t-b", 100_000), expense("t-a", 200_000)]);
    const authors = authorsOfTransactions([
      entry("t-b", DEVICE_BORIS, MEMBER_BORIS),
      entry("t-a", DEVICE_ANNA_PHONE, "0000000c-0000-4000-8000-00000000cccc"),
    ]);
    const lines = familyNewsLines(familyNewsSince(transactionIds(seed), state, authors, ANNA), membersById(state));
    // Участник, которого в бюджете нет, назван честно, а не выдуман.
    expect(lines).toEqual([
      `Борис: 1 покупка на ${formatMoney(100_000)}`,
      `Участник не найден: 1 покупка на ${formatMoney(200_000)}`,
    ]);
  });

  it("склоняет счётные слова по видам операций", () => {
    const state = withMembers(seed, [
      expense("t-1", 100), expense("t-2", 100), expense("t-3", 100), expense("t-4", 100), expense("t-5", 100),
      { ...income("t-6", 100), kind: "transfer", fromAccountId: SEED_IDS.accounts.main, toAccountId: SEED_IDS.accounts.savings } as unknown as Transaction,
    ]);
    const authors = authorsOfTransactions(["t-1", "t-2", "t-3", "t-4", "t-5", "t-6"].map((id) => entry(id, DEVICE_BORIS, MEMBER_BORIS)));
    const lines = familyNewsLines(familyNewsSince(transactionIds(seed), state, authors, ANNA), membersById(state));
    expect(lines[0]).toContain("5 покупок на");
    expect(lines[0]).toContain("1 перевод на");
  });
});

describe("семейная новость о регулярных операциях", () => {
  const seed = makeSeedBudget();
  const WATER: RecurringRule = {
    id: "0000000d-0000-4000-8000-00000000d001",
    name: "Доставка воды",
    template: { kind: "expense", amountMinor: 150_000, accountId: SEED_IDS.accounts.main, categoryId: SEED_IDS.categories.food },
    frequency: "weekly",
    interval: 2,
    startDate: "2026-07-07",
    active: true,
  };

  it("вхождения правила — строка правила, а не участника, чьё устройство их записало", () => {
    const ruled = withMembers({ ...seed, recurringRules: [WATER] }, [expense("t-b", 100_000)]);
    const { state, created } = materializeRecurring(ruled, "2026-07-31");
    expect(created).toHaveLength(2);
    // Boris's device materialised both occurrences, so its header is on them in the journal.
    const authors = authorsOfTransactions([
      entry("t-b", DEVICE_BORIS, MEMBER_BORIS),
      ...created.map((transaction) => entry(transaction.id, DEVICE_BORIS, MEMBER_BORIS)),
    ]);
    const news = familyNewsSince(transactionIds(seed), state, authors, ANNA);
    expect(news).toHaveLength(3);
    expect(familyNewsLines(news, membersById(state), state)).toEqual([
      `Борис: 1 покупка на ${formatMoney(100_000)}`,
      `По правилу «Доставка воды»: 2 покупки на ${formatMoney(300_000)}`,
    ]);
  });

  it("правило без названия названо регулярной операцией, а не выдумано", () => {
    const { name: _name, ...nameless } = WATER;
    const { state, created } = materializeRecurring(withMembers({ ...seed, recurringRules: [nameless] }, []), "2026-07-31");
    const authors = authorsOfTransactions(created.map((transaction) => entry(transaction.id, DEVICE_BORIS, MEMBER_BORIS)));
    expect(familyNewsLines(familyNewsSince(transactionIds(seed), state, authors, ANNA), membersById(state), state))
      .toEqual([`По регулярной операции: 2 покупки на ${formatMoney(300_000)}`]);
  });

  it("свои вхождения новостью не являются, как и любая своя запись", () => {
    const { state, created } = materializeRecurring(withMembers({ ...seed, recurringRules: [WATER] }, []), "2026-07-31");
    const authors = authorsOfTransactions(created.map((transaction) => entry(transaction.id, DEVICE_ANNA, MEMBER_ANNA)));
    expect(familyNewsSince(transactionIds(seed), state, authors, ANNA)).toEqual([]);
  });
});
