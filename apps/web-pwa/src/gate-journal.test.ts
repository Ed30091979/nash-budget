/**
 * Всё, что принимает шлюз копии, обязан нести журнал семьи.
 *
 * Шлюз (`prepareBudgetState`) и кодек журнала проверяют одни и те же поля, каждый своим кодом. Если
 * шлюз пропускает значение, которое кодек отвергает, семья сохраняет его у себя, а первая же
 * синхронизация бросает на каждой записи: значение застревает на устройстве, которое его записало.
 * Так было со сроком цели в 2200 году и порядком счёта 1 000 001. Проверка ниже перебирает краевые
 * значения каждого поля волны и требует одного: принятое шлюзом проходит `budgetJournalDrafts` и
 * `createLocalOperation`, то есть настоящий кодек.
 */
import {
  HOUSEHOLD_ID,
  makePlanningSeed,
  MAX_LOCAL_DATE,
  MAX_MONEY_MINOR,
  MAX_SORT_ORDER,
  MIN_LOCAL_DATE,
  RATE_PART_MAX,
  type BudgetState,
} from "@family-budget/domain";
import { createClock, createLocalOperation } from "@family-budget/sync-protocol";
import { G002, toDomainBudgetState } from "@family-budget/test-fixtures";
import { describe, expect, it } from "vitest";

import { prepareBudgetState } from "./backup";
import { budgetJournalDrafts } from "./features/family/journal";

const DEVICE = "0000000a-0000-4000-8000-000000000001";
const TAG_ID = "c1111111-1111-4111-8111-111111111111";

type Mutation = readonly [string, (state: BudgetState) => unknown];

function stampAll(state: BudgetState): number {
  let clock = createClock(DEVICE, 0);
  let count = 0;
  for (const draft of budgetJournalDrafts(null, state)) {
    clock = createLocalOperation(clock, draft).clock;
    count += 1;
  }
  return count;
}

function firstAccount(state: BudgetState, change: Record<string, unknown>): unknown {
  return { ...state, accounts: state.accounts.map((item, index) => (index === 0 ? { ...item, ...change } : item)) };
}

function firstCategory(state: BudgetState, change: Record<string, unknown>): unknown {
  return { ...state, categories: state.categories.map((item, index) => (index === 0 ? { ...item, ...change } : item)) };
}

function firstGoal(state: BudgetState, change: Record<string, unknown>): unknown {
  return { ...state, goals: state.goals.map((item, index) => (index === 0 ? { ...item, ...change } : item)) };
}

function tagged(state: BudgetState, name: string, change: Record<string, unknown> = {}): unknown {
  return {
    ...state,
    tags: [{ id: TAG_ID, name, active: true }],
    transactions: state.transactions.map((item, index) => (index === 0 ? { ...item, tagIds: [TAG_ID], ...change } : item)),
  };
}

function noted(state: BudgetState, note: unknown): unknown {
  return { ...state, transactions: state.transactions.map((item, index) => (index === 0 ? { ...item, note } : item)) };
}

const DOLLARS = "c5555555-5555-4555-8555-555555555551";
const RATE_ID = "c5555555-5555-4555-8555-555555555553";

/** Долларовый счёт, курс и покупка по нему: поля шага 8, все разом, с правкой поверх. */
function dollars(state: BudgetState, expense: Record<string, unknown> = {}, rate: Record<string, unknown> = {}): unknown {
  const categoryId = state.categories.find((item) => item.type === "expense")!.id;
  return {
    ...state,
    household: { id: HOUSEHOLD_ID, baseCurrency: "RUB" },
    exchangeRates: [{ id: RATE_ID, currency: "USD", baseCurrency: "RUB", date: "2026-06-30", rate: { baseMinor: 9_000, quoteMinor: 100 }, ...rate }],
    accounts: [...state.accounts, { id: DOLLARS, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true }],
    transactions: [...state.transactions, {
      id: "c5555555-5555-4555-8555-555555555552", occurredOn: "2026-07-10", status: "posted", kind: "expense", amountMinor: 4_000,
      accountId: DOLLARS, categoryId, baseAmountMinor: 360_000, baseCurrency: "RUB", rate: { baseMinor: 9_000, quoteMinor: 100 }, ...expense,
    }],
  };
}

/** Долг шага 10 с правкой поверх. */
function indebted(state: BudgetState, change: Record<string, unknown> = {}): unknown {
  return {
    ...state,
    debts: [{ id: "c7777777-7777-4777-8777-777777777771", counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 300_000, active: true, ...change }],
  };
}

/** Краевые значения: по обе стороны каждой границы и то, что граница должна отвергнуть. */
const MUTATIONS: readonly Mutation[] = [
  ...[0, 1, -1, MAX_SORT_ORDER, -MAX_SORT_ORDER, MAX_SORT_ORDER + 1, -MAX_SORT_ORDER - 1, Number.MAX_SAFE_INTEGER, 1.5]
    .map((sortOrder): Mutation => [`account.sortOrder ${sortOrder}`, (state) => firstAccount(state, { sortOrder })]),
  ...["sage", "shopping-basket", "a", "x".repeat(40), "x".repeat(41), "Sage", "#00ff00", "icon.svg", ""]
    .flatMap((key): Mutation[] => [
      [`account.icon ${key}`, (state) => firstAccount(state, { icon: key })],
      [`account.color ${key}`, (state) => firstAccount(state, { color: key })],
      [`category.icon ${key}`, (state) => firstCategory(state, { icon: key })],
      [`goal.icon ${key}`, (state) => firstGoal(state, { icon: key })],
    ]),
  ...[true, false, "yes"].map((value): Mutation => [`account.includeInTotal ${String(value)}`, (state) => firstAccount(state, { includeInTotal: value })]),
  ...[MIN_LOCAL_DATE, MAX_LOCAL_DATE, "1899-12-31", "2200-01-01", "9999-12-31", "2027-02-28", "2027-02-29", "0001-01-01"]
    .map((deadline): Mutation => [`goal.deadline ${deadline}`, (state) => firstGoal(state, { deadline })]),
  ...["Пятёрочка у дома", "я".repeat(500), "я".repeat(501), " Пятёрочка", "Кофе в Starbucks", "Цветы \u2764", "A\u030a", "\u00c5",
    "Пятёрочка\u202e", "Пятёрочка\nу дома", "мягкий\u00adперенос", "\u{1f334} пальма", ""]
    .map((note): Mutation => [`note ${JSON.stringify(note)}`, (state) => noted(state, note)]),
  ...["Дом", "Отпуск 2027", "я".repeat(40), "я".repeat(41), "Дом ", " Дом", "Дом Home", "Чаи\u0306", "Ча\u0439"]
    .map((name): Mutation => [`tag.name ${JSON.stringify(name)}`, (state) => tagged(state, name)]),
  ["dollars", (state) => dollars(state)],
  ...[1, MAX_MONEY_MINOR, MAX_MONEY_MINOR + 1, 0, 1.5]
    .map((baseAmountMinor): Mutation => [`baseAmountMinor ${baseAmountMinor}`, (state) => dollars(state, { baseAmountMinor })]),
  ...[1, RATE_PART_MAX, RATE_PART_MAX + 1, 0]
    .flatMap((part): Mutation[] => [
      [`snapshot rate ${part}`, (state) => dollars(state, { rate: { baseMinor: part, quoteMinor: 100 } })],
      [`exchange rate ${part}`, (state) => dollars(state, {}, { rate: { baseMinor: 9_000, quoteMinor: part } })],
    ]),
  ...[MIN_LOCAL_DATE, MAX_LOCAL_DATE, "1899-12-31", "2200-01-01"]
    .map((date): Mutation => [`exchange rate date ${date}`, (state) => dollars(state, {}, { date })]),
  ...["RUB", "EUR", "XYZ", "rub"].map((baseCurrency): Mutation => [`snapshot baseCurrency ${baseCurrency}`, (state) => dollars(state, { baseCurrency })]),
  ...["USD", "JPY", "KWD", "XYZ"].map((currency): Mutation => [`exchange rate currency ${currency}`, (state) => dollars(state, {}, { currency })]),
  ["debt", (state) => indebted(state)],
  ...["Петя", "я".repeat(80), "я".repeat(81), " Петя", "Петя Smith", "Пе\u00adтя", "???"]
    .map((counterparty): Mutation => [`debt.counterparty ${JSON.stringify(counterparty)}`, (state) => indebted(state, { counterparty })]),
  ...[0, MAX_MONEY_MINOR, MAX_MONEY_MINOR + 1, -1]
    .map((openingMinor): Mutation => [`debt.openingMinor ${openingMinor}`, (state) => indebted(state, { openingMinor })]),
  ...[MIN_LOCAL_DATE, MAX_LOCAL_DATE, "2200-01-01", "1899-12-31"]
    .map((dueDate): Mutation => [`debt.dueDate ${dueDate}`, (state) => indebted(state, { dueDate })]),
  ...["USD", "XYZ"].map((currency): Mutation => [`debt.currency ${currency}`, (state) => indebted(state, { currency })]),
  ...[{}, { debtAmountMinor: 5_000 }, { debtAmountMinor: MAX_MONEY_MINOR + 1 }, { kind: "debt_in" }, { debtId: "c7777777-7777-4777-8777-7777777777ff" }]
    .flatMap((change): Mutation[] => ["RUB", "USD"].map((currency): Mutation => [
      `debt movement ${JSON.stringify(change)} on a debt in ${currency}`,
      (state) => {
        const withDebt = indebted(state, { currency }) as BudgetState;
        return {
          ...withDebt,
          transactions: [...withDebt.transactions, {
            id: "c7777777-7777-4777-8777-777777777772", kind: "debt_out", status: "posted", occurredOn: "2026-07-09",
            amountMinor: 500_000, accountId: withDebt.accounts[0]!.id, debtId: "c7777777-7777-4777-8777-777777777771", ...change,
          }],
        };
      },
    ])),
];

describe("шлюз копии и журнал семьи", () => {
  it.each([
    ["G-002", () => toDomainBudgetState(G002) as BudgetState],
    ["makePlanningSeed", makePlanningSeed],
  ] as const)("принятое шлюзом проходит кодек журнала: %s", (_label, base) => {
    let accepted = 0;
    let refused = 0;
    for (const [label, mutate] of MUTATIONS) {
      let prepared: BudgetState;
      try {
        prepared = prepareBudgetState(mutate(base()));
      } catch {
        refused += 1;
        continue;
      }
      accepted += 1;
      expect(() => stampAll(prepared), label).not.toThrow();
    }
    // Не пустая проверка: значения по обе стороны каждой границы.
    expect(accepted).toBeGreaterThan(25);
    expect(refused).toBeGreaterThan(25);
  });
});
