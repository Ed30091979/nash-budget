/**
 * Готовое состояние журнала семьи всегда открывается шлюзом приложения.
 *
 * Второе ревью волны 1: задержка документа (`rejected_by_app`) должна быть только расхождением
 * версий. Всё, что журнал может распознать как негодное сам, он удерживает — детерминированно и
 * видимо, — и тогда для этой сборки верно свойство: `integrity.ready === true ⇒
 * prepareBudgetState(snapshot.state)` не бросает. Здесь оно проверяется на тысячах журналов,
 * собранных из честных и враждебных операций всех видов сущностей с краевыми значениями полей:
 * чужие и несуществующие ссылки, один идентификатор у двух видов, идентификаторы не вида UUID,
 * суммы у потолка, даты у краёв окна, валюты с разной точностью, снимки точные и неточные,
 * удаления и активации чего угодно. Операция, которую отвергает кодек, в журнал не попадает и
 * здесь отбрасывается так же.
 *
 * Найденное нарушение закрывается в журнале (удержанием) или делает шлюз терпимым к состоянию из
 * журнала (с отчётом), но никогда наоборот.
 *
 * Генератор — расширенный ревьюером третьего круга: пять идентификаторов на вид, до 123 операций на
 * журнал, базовая валюта хозяйства RUB, USD, KWD или JPY, чаще правки хозяйства, счетов и курсов.
 * В наборе тестов он идёт по фиксированным зёрнам (`FUZZ_OFFSET` = 0, `FUZZ_N` = 3 000), чтобы
 * прогон был одинаковым на каждой машине и укладывался в секунды. Большую случайную партию
 * запускают локально, например:
 *
 *   FUZZ_N=100000 FUZZ_OFFSET=$RANDOM$RANDOM npx vitest run src/journal-gate-property.test.ts
 *
 * Найденное зерно воспроизводится той же парой переменных и переносится в набор отдельным тестом.
 */
import {
  convertMinor,
  HOUSEHOLD_ID,
  MAX_MONEY_MINOR,
  MAX_RECURRENCE_INTERVAL,
  MAX_SORT_ORDER,
  RATE_PART_MAX,
} from "@family-budget/domain";
import {
  applyJournal,
  ENTITY_KINDS,
  MAX_LOCAL_DATE,
  MIN_LOCAL_DATE,
  parseOperation,
  type EntityKind,
  type Operation,
} from "@family-budget/sync-protocol";
import { describe, expect, it } from "vitest";

import { prepareBudgetState } from "./backup";

/** Сколько журналов собирается, с какого зерна — и какая доля обязана оказаться готовой, чтобы свойство что-то значило. */
const JOURNALS = Number(process.env.FUZZ_N ?? 3_000);
const OFFSET = Number(process.env.FUZZ_OFFSET ?? 0);
const MIN_READY_SHARE = 0.5;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const uuid = (lead: number, tail: number): string =>
  `${lead.toString(16).padStart(8, "0")}-0000-4000-8000-${tail.toString(16).padStart(12, "0")}`;

const DEVICES = [uuid(0xd1, 1), uuid(0xd2, 2), uuid(0xd3, 3)] as const;

/**
 * Идентификаторы, из которых собираются журналы: по пять на вид, общий набор, на который могут
 * претендовать два вида сразу, и два идентификатора не вида UUID — для старых видов, которым кодек
 * их позволяет.
 */
function poolOf(kind: EntityKind): readonly string[] {
  return kind === "household" ? [HOUSEHOLD_ID] : [1, 2, 3, 4, 5].map((n) => uuid(0x100 + ENTITY_KINDS.indexOf(kind), n));
}
const POOLS: Readonly<Record<EntityKind, readonly string[]>> = {
  account: poolOf("account"),
  category: poolOf("category"),
  budget: poolOf("budget"),
  budgetLine: poolOf("budgetLine"),
  goal: poolOf("goal"),
  annualCommitment: poolOf("annualCommitment"),
  scheduledExpense: poolOf("scheduledExpense"),
  transaction: poolOf("transaction"),
  member: poolOf("member"),
  tag: poolOf("tag"),
  exchangeRate: poolOf("exchangeRate"),
  household: poolOf("household"),
  debt: poolOf("debt"),
  recurringRule: poolOf("recurringRule"),
};
const SHARED = [uuid(0x5ab, 1), uuid(0x5ab, 2)];
const READABLE = ["account-1", "member-anna"];

interface Draw {
  readonly random: () => number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

function draw(seed: number): Draw {
  const random = mulberry32(seed);
  return {
    random,
    pick: <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!,
    chance: (probability: number) => random() < probability,
  };
}

function idOf(d: Draw, kind: EntityKind): string {
  if (d.chance(0.06)) return d.pick(SHARED);
  if (d.chance(0.03)) return d.pick(READABLE);
  return d.pick(POOLS[kind]);
}

/** A reference: usually to the kind it names, sometimes to another kind, to nothing, or malformed. */
function refOf(d: Draw, kind: EntityKind): string {
  if (d.chance(0.05)) return idOf(d, d.pick(ENTITY_KINDS));
  if (d.chance(0.03)) return uuid(0xdead, Math.floor(d.random() * 4));
  return idOf(d, kind);
}

const CURRENCIES = ["RUB", "RUB", "RUB", "USD", "KWD", "JPY"] as const;
const DATES = ["2026-07-01", "2026-07-15", "2026-07-31", "2026-08-10", "2025-12-31", "1900-01-01", "2199-12-31", MIN_LOCAL_DATE, MAX_LOCAL_DATE, "2026-02-30"];
const MONEY = [0, 1, 100, 99_999, 1_000_000, MAX_MONEY_MINOR - 1, MAX_MONEY_MINOR, MAX_MONEY_MINOR + 1];
const SIGNED = [...MONEY, -1, -MAX_MONEY_MINOR];
const NAMES = ["Счёт", "Продукты", "", " ", "А".repeat(80), "А".repeat(81), " с пробелом ", "a\u200bb"];
const SORT_ORDERS = [0, 10, MAX_SORT_ORDER, -MAX_SORT_ORDER, MAX_SORT_ORDER + 1];
const RATE_PARTS = [1, 100, 9_000, RATE_PART_MAX, RATE_PART_MAX + 1, 0];

function money(d: Draw): number {
  return d.pick(MONEY);
}

function rate(d: Draw): { baseMinor: number; quoteMinor: number } {
  return { baseMinor: d.pick(RATE_PARTS), quoteMinor: d.pick(RATE_PARTS) };
}

/** The foundation's account in dollars: operations on it carry a snapshot most of the time. */
const DOLLAR_ACCOUNT = POOLS.account[1]!;

/** A base-currency snapshot: exact, off by one, partial or absent — exact, mostly, on the dollar account. */
function snapshot(d: Draw, amountMinor: number, accountId: string): Record<string, unknown> {
  const roll = accountId === DOLLAR_ACCOUNT ? 0.45 + d.random() * 0.55 : d.random();
  if (roll < 0.45) return {};
  const value = rate(d);
  let base: number;
  try {
    base = convertMinor(amountMinor, value);
  } catch {
    base = MAX_MONEY_MINOR + 1;
  }
  if (roll < 0.8) return { baseAmountMinor: base, baseCurrency: d.pick(["RUB", "RUB", "USD"]), rate: value };
  if (roll < 0.92) return { baseAmountMinor: base + 1, baseCurrency: "RUB", rate: value };
  return { baseAmountMinor: base };
}

function labels(d: Draw): Record<string, unknown> {
  return {
    ...(d.chance(0.25) ? { memberId: d.chance(0.2) ? d.pick(READABLE) : refOf(d, "member") } : {}),
    ...(d.chance(0.2) ? { tagIds: [refOf(d, "tag"), ...(d.chance(0.3) ? [refOf(d, "tag")] : [])] } : {}),
    ...(d.chance(0.15) ? { recurringRuleId: refOf(d, "recurringRule") } : {}),
    ...(d.chance(0.15) ? { note: d.pick(["Заметка", "", " край ", "x".repeat(600)]) } : {}),
  };
}

function transactionFields(d: Draw): Record<string, unknown> {
  const amountMinor = money(d);
  const base = { occurredOn: d.pick(DATES), status: d.pick(["posted", "posted", "pending", "draft"]), amountMinor, ...labels(d) };
  switch (d.pick(["income", "expense", "expense", "refund", "transfer", "goal_contribution", "debt_out", "debt_in"] as const)) {
    case "income": {
      const accountId = refOf(d, "account");
      return { ...base, kind: "income", accountId, ...(d.chance(0.5) ? { categoryId: refOf(d, "category") } : {}), ...snapshot(d, amountMinor, accountId) };
    }
    case "expense": {
      const accountId = refOf(d, "account");
      return { ...base, kind: "expense", accountId, categoryId: refOf(d, "category"), ...snapshot(d, amountMinor, accountId) };
    }
    case "refund": {
      const accountId = refOf(d, "account");
      return { ...base, kind: "refund", accountId, categoryId: refOf(d, "category"), originalTransactionId: refOf(d, "transaction"), ...snapshot(d, amountMinor, accountId) };
    }
    case "transfer":
      return { ...base, kind: "transfer", fromAccountId: refOf(d, "account"), toAccountId: refOf(d, "account"), ...(d.chance(0.4) ? { toAmountMinor: money(d) } : {}) };
    case "goal_contribution":
      return { ...base, kind: "goal_contribution", fromAccountId: refOf(d, "account"), toAccountId: refOf(d, "account"), goalId: refOf(d, "goal") };
    case "debt_out":
      return { ...base, kind: "debt_out", accountId: refOf(d, "account"), debtId: refOf(d, "debt"), ...(d.chance(0.4) ? { debtAmountMinor: money(d) } : {}) };
    case "debt_in":
      return { ...base, kind: "debt_in", accountId: refOf(d, "account"), debtId: refOf(d, "debt"), ...(d.chance(0.4) ? { debtAmountMinor: money(d) } : {}) };
  }
}

function templateOf(d: Draw): Record<string, unknown> {
  const extra = {
    ...(d.chance(0.2) ? { tagIds: [refOf(d, "tag")] } : {}),
    ...(d.chance(0.2) ? { note: "Шаблон" } : {}),
  };
  switch (d.pick(["expense", "income", "transfer"] as const)) {
    case "expense":
      return { kind: "expense", amountMinor: money(d), accountId: refOf(d, "account"), categoryId: refOf(d, "category"), ...extra };
    case "income":
      return { kind: "income", amountMinor: money(d), accountId: refOf(d, "account"), ...(d.chance(0.5) ? { categoryId: refOf(d, "category") } : {}), ...extra };
    case "transfer":
      return { kind: "transfer", amountMinor: money(d), fromAccountId: refOf(d, "account"), toAccountId: refOf(d, "account"), ...(d.chance(0.4) ? { toAmountMinor: money(d) } : {}), ...extra };
  }
}

function fieldsOf(d: Draw, kind: EntityKind): Record<string, unknown> {
  switch (kind) {
    case "account":
      return {
        name: d.pick(NAMES), type: d.pick(["current", "cash", "savings", "reserve"]), currency: d.pick(CURRENCIES),
        openingBalanceMinor: d.pick(SIGNED), active: d.chance(0.85),
        ...(d.chance(0.3) ? { sortOrder: d.pick(SORT_ORDERS) } : {}),
        ...(d.chance(0.2) ? { icon: d.pick(["wallet", "banknote", "Not A Key"]), color: d.pick(["sage", "blue"]) } : {}),
        ...(d.chance(0.2) ? { includeInTotal: d.chance(0.5) } : {}),
      };
    case "category":
      return {
        name: d.pick(NAMES), type: d.chance(0.75) ? "expense" : "income",
        group: d.pick(["everyday", "mandatory", "personal", "other", "income", "Повседневные", ""]),
        active: d.chance(0.85), sortOrder: d.pick(SORT_ORDERS),
      };
    case "budget": {
      const start = d.pick(["2026-07-01", "2026-08-01", "2026-06-01", "1900-01-01", "2199-12-01"]);
      return {
        startDate: start, endDate: d.chance(0.85) ? `${start.slice(0, 8)}28` : d.pick(DATES),
        status: d.pick(["open", "open", "closed", "draft"]), plannedIncomeMinor: money(d),
        warningThreshold: d.pick([0.8, 0, 1, 0.5, 1.5]),
      };
    }
    case "budgetLine":
      return {
        budgetId: refOf(d, "budget"), categoryId: refOf(d, "category"), plannedMinor: money(d),
        ...(d.chance(0.2) ? { active: d.chance(0.5) } : {}),
        ...(d.chance(0.2) ? { rolloverMinor: money(d) } : {}),
        ...(d.chance(0.2) ? { adjustmentMinor: d.pick(SIGNED) } : {}),
      };
    case "goal":
      return {
        name: d.pick(NAMES), linkedAccountId: refOf(d, "account"), targetMinor: money(d), openingContributedMinor: money(d),
        plannedContributionMinor: money(d), status: d.pick(["active", "completed", "cancelled"]),
        ...(d.chance(0.3) ? { deadline: d.pick(DATES) } : {}),
      };
    case "annualCommitment":
      return {
        name: d.pick(NAMES), categoryId: refOf(d, "category"), accountId: refOf(d, "account"), dueDate: d.pick(DATES),
        amountMinor: money(d), reservedMinor: money(d), recurrence: d.pick(["annual", "one_time"]), active: d.chance(0.8),
      };
    case "scheduledExpense": {
      const mode = d.pick(["monthly", "selected_months"]);
      return {
        name: d.pick(NAMES), categoryId: refOf(d, "category"), accountId: refOf(d, "account"), amountMinor: money(d),
        dueDay: d.pick([1, 15, 28, 31, 0, 32]), mode, ...(mode === "selected_months" ? { months: d.pick([[1, 7], [12], [], [13]]) } : {}),
        active: d.chance(0.8),
      };
    }
    case "transaction":
      return transactionFields(d);
    case "member":
      return { name: d.pick(NAMES), role: d.pick(["owner", "member"]), active: d.chance(0.9) };
    case "tag":
      return { name: d.pick(["Дом", "Отпуск", "", "x".repeat(41)]), active: d.chance(0.9) };
    case "exchangeRate":
      return { currency: d.pick(["USD", "KWD", "JPY", "RUB"]), baseCurrency: d.pick(["RUB", "RUB", "USD"]), date: d.pick(DATES), rate: rate(d) };
    case "household":
      return { baseCurrency: d.pick(["RUB", "USD", "KWD", "JPY"]) };
    case "debt":
      return {
        counterparty: d.pick(["Петя", "", "Сосед"]), direction: d.pick(["i_owe", "owed_to_me"]), currency: d.pick(CURRENCIES),
        openingMinor: d.pick(SIGNED), active: d.chance(0.85), ...(d.chance(0.3) ? { dueDate: d.pick(DATES) } : {}),
      };
    case "recurringRule":
      return {
        ...(d.chance(0.5) ? { name: d.pick(NAMES) } : {}), template: templateOf(d),
        frequency: d.pick(["daily", "weekly", "monthly", "yearly"]), interval: d.pick([1, 2, MAX_RECURRENCE_INTERVAL, 0]),
        startDate: d.pick(DATES), ...(d.chance(0.3) ? { endDate: d.pick(DATES) } : {}),
        ...(d.chance(0.3) ? { materializedThrough: d.pick(DATES) } : {}), active: d.chance(0.7),
      };
  }
}

/** A coherent family to start from — or nothing, so the journals that are only noise are tried too. */
function foundation(d: Draw): Record<string, unknown>[] {
  if (d.chance(0.15)) return [];
  const account = POOLS.account[0]!;
  const category = POOLS.category[0]!;
  const income = POOLS.category[1]!;
  const budget = POOLS.budget[0]!;
  return [
    { entity: "account", action: "create", targetId: account, fields: { name: "Основной", type: "current", currency: "RUB", openingBalanceMinor: 1_000_000, active: true } },
    { entity: "category", action: "create", targetId: category, fields: { name: "Продукты", type: "expense", group: "everyday", active: true, sortOrder: 10 } },
    { entity: "category", action: "create", targetId: income, fields: { name: "Зарплата", type: "income", group: "income", active: true, sortOrder: 20 } },
    { entity: "budget", action: "create", targetId: budget, fields: { startDate: "2026-07-01", endDate: "2026-07-31", status: "open", plannedIncomeMinor: 10_000_000, warningThreshold: 0.8 } },
    { entity: "budgetLine", action: "create", targetId: POOLS.budgetLine[0]!, fields: { budgetId: budget, categoryId: category, plannedMinor: 3_000_000 } },
    { entity: "budget", action: "activate", targetId: budget },
    // The kinds of wave 1, so that the operations below have something of theirs to land on: a
    // dollar account and its rate, a debt, a participant, a tag and a rule.
    { entity: "account", action: "create", targetId: DOLLAR_ACCOUNT, fields: { name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 10_000, active: true } },
    { entity: "exchangeRate", action: "create", targetId: POOLS.exchangeRate[0]!, fields: { currency: "USD", baseCurrency: "RUB", date: "2026-07-01", rate: { baseMinor: 9_000, quoteMinor: 100 } } },
    { entity: "debt", action: "create", targetId: POOLS.debt[0]!, fields: { counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 50_000, active: true } },
    { entity: "member", action: "create", targetId: POOLS.member[0]!, fields: { name: "Анна", role: "owner", active: true } },
    { entity: "tag", action: "create", targetId: POOLS.tag[0]!, fields: { name: "Дом", active: true } },
    // An expense to refund and a goal to contribute to, so refunds and contributions are not all
    // dangling: the operations below draw the same identifiers.
    { entity: "transaction", action: "create", targetId: POOLS.transaction[0]!, fields: { kind: "expense", occurredOn: "2026-07-10", status: "posted", amountMinor: 500_000, accountId: account, categoryId: category } },
    { entity: "goal", action: "create", targetId: POOLS.goal[0]!, fields: { name: "Подушка", linkedAccountId: POOLS.account[2]!, targetMinor: 1_000_000, openingContributedMinor: 0, plannedContributionMinor: 10_000, status: "active" } },
    { entity: "account", action: "create", targetId: POOLS.account[2]!, fields: { name: "Резерв", type: "reserve", currency: "RUB", openingBalanceMinor: 0, active: true } },
    {
      entity: "recurringRule", action: "create", targetId: POOLS.recurringRule[0]!,
      fields: { template: { kind: "expense", amountMinor: 50_000, accountId: account, categoryId: category }, frequency: "monthly", interval: 1, startDate: "2026-07-05", active: true },
    },
  ];
}

function randomDraft(d: Draw): Record<string, unknown> {
  // Хозяйство, счета и курсы — чаще: именно их правки меняют валюты всего остального.
  const entity = d.chance(0.1) ? d.pick(["household", "account", "exchangeRate"] as const) : d.pick(ENTITY_KINDS);
  const roll = d.random();
  if (entity === "budget" && roll < 0.12) return { entity, action: "activate", targetId: d.chance(0.8) ? idOf(d, "budget") : uuid(0xdead, 9) };
  if (roll < 0.15) return { entity, action: "delete", targetId: idOf(d, entity) };
  return { entity, action: roll < 0.6 ? "create" : "update", targetId: idOf(d, entity), fields: fieldsOf(d, entity) };
}

interface Generated {
  readonly operations: readonly Operation[];
  readonly refused: number;
}

function generate(seed: number): Generated {
  const d = draw(seed);
  const drafts = [...foundation(d), ...Array.from({ length: 4 + Math.floor(d.random() * 120) }, () => randomDraft(d))];
  const operations: Operation[] = [];
  let refused = 0;
  drafts.forEach((draft, index) => {
    try {
      operations.push(parseOperation({
        opId: uuid(seed + 1, index),
        deviceId: d.pick(DEVICES),
        // Mostly in writing order, sometimes a tie or an older stamp, so the merge has conflicts to settle.
        lamport: 1 + index + (d.chance(0.2) ? -Math.min(index, 3) : 0),
        ...draft,
      }));
    } catch {
      // The codec refuses it, so no journal ever holds it.
      refused += 1;
    }
  });
  return { operations, refused };
}

describe("готовое состояние журнала открывается шлюзом приложения", () => {
  it(`на ${JOURNALS} журналах из честных и враждебных операций всех видов`, () => {
    let ready = 0;
    let operations = 0;
    let refused = 0;
    const reasons = new Set<string>();
    const counterexamples: string[] = [];
    for (let seed = OFFSET + 1; seed <= OFFSET + JOURNALS; seed += 1) {
      const generated = generate(seed);
      operations += generated.operations.length;
      refused += generated.refused;
      const snapshot = applyJournal(generated.operations);
      for (const entry of snapshot.integrity.withheld) reasons.add(entry.reason);
      if (!snapshot.integrity.ready) continue;
      ready += 1;
      try {
        prepareBudgetState(snapshot.state, undefined, "document");
      } catch (error) {
        counterexamples.push(`seed ${seed}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // The property, over every journal that came out ready.
    expect(counterexamples.slice(0, 10)).toEqual([]);
    // And the run meant something: most journals were ready, the codec let most operations through,
    // and the gate's withholding rules — the new one included — all had journals to act on.
    expect(ready).toBeGreaterThanOrEqual(Math.floor(JOURNALS * MIN_READY_SHARE));
    expect(operations).toBeGreaterThan(refused);
    for (const reason of ["invalid_id", "unknown_reference", "identifier_claimed_twice", "currency_mismatch", "snapshot_mismatch", "duplicate_budget_line"]) {
      expect(reasons.has(reason), reason).toBe(true);
    }
  }, 300_000);
});
