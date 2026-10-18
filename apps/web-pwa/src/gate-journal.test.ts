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
  makePlanningSeed,
  MAX_LOCAL_DATE,
  MAX_SORT_ORDER,
  MIN_LOCAL_DATE,
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
