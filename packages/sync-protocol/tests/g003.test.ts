import {
  calculateBudget,
  calculateDebts,
  calculateHoldings,
  calculateTagExpenses,
  materializeRecurring,
  type BudgetState,
} from "@family-budget/domain";
import { G003, toDomainBudgetState } from "@family-budget/test-fixtures";
import { describe, expect, it } from "vitest";

import {
  applyJournal,
  createClock,
  createLocalOperation,
  restoreJournal,
  type JournalSnapshot,
  type Operation,
  type OperationDraft,
} from "../src/index.js";
import { DEVICE_A, DEVICE_B, DEVICE_C, opUuid } from "./samples.js";

/**
 * G-003 through the family journal: the same August, written as operations by one device and
 * merged in any order, gives the figures of the contract (plan 5.2, 6).
 */
const expected = G003.expected;

function withoutId<T extends { readonly id: string }>(entity: T): Omit<T, "id"> {
  const { id: _id, ...fields } = entity;
  return fields;
}

/** Every entity of `state` as a create, the active budget as an activation. */
function ledgerDrafts(state: BudgetState): OperationDraft[] {
  const drafts: OperationDraft[] = [];
  const create = (entity: OperationDraft["entity"], targetId: string, fields: unknown): void => {
    drafts.push({ entity, action: "create", targetId, fields } as OperationDraft);
  };
  if (state.household !== undefined) create("household", state.household.id, withoutId(state.household));
  for (const tag of state.tags ?? []) create("tag", tag.id, withoutId(tag));
  for (const rate of state.exchangeRates ?? []) create("exchangeRate", rate.id, withoutId(rate));
  for (const debt of state.debts ?? []) create("debt", debt.id, withoutId(debt));
  for (const account of state.accounts) create("account", account.id, withoutId(account));
  for (const category of state.categories) create("category", category.id, withoutId(category));
  for (const budget of state.budgets) {
    const { id, lines, ...fields } = budget;
    create("budget", id, fields);
    for (const line of lines) create("budgetLine", line.id, { budgetId: id, ...withoutId(line) });
  }
  for (const goal of state.goals) create("goal", goal.id, withoutId(goal));
  for (const rule of state.recurringRules ?? []) create("recurringRule", rule.id, withoutId(rule));
  for (const transaction of state.transactions) create("transaction", transaction.id, withoutId(transaction));
  drafts.push({ entity: "budget", action: "activate", targetId: state.activeBudgetId });
  return drafts;
}

let nextOp = 80_000;

function stamp(drafts: readonly OperationDraft[], device: string, from = 0): Operation[] {
  let clock = createClock(device, from);
  return drafts.map((draft) => {
    nextOp += 1;
    const local = createLocalOperation(clock, { ...draft, opId: opUuid(nextOp) });
    clock = local.clock;
    return local.operation;
  });
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

/** The figures of the contract, read off a journal's state. */
function assertContractFigures(snapshot: JournalSnapshot): void {
  const state = snapshot.state;
  const budget = calculateBudget(state);
  expect(budget.incomeMinor).toBe(expected.budget.incomeMinor);
  expect(budget.grossExpensesMinor).toBe(expected.budget.grossExpensesMinor);
  expect(budget.refundsMinor).toBe(expected.budget.refundsMinor);
  expect(budget.expensesMinor).toBe(expected.budget.expensesMinor);
  expect(budget.capitalMinor).toBe(expected.budget.capitalMinor);
  for (const { accountId, balanceMinor } of expected.budget.accountBalances) expect(budget.accountBalancesMinor[accountId]).toBe(balanceMinor);
  for (const category of expected.budget.categories) {
    expect(budget.categoryMetrics[category.categoryId]).toMatchObject({ actualMinor: category.actualMinor, status: category.status });
  }

  const debts = calculateDebts(state, G003.asOf);
  expect(debts.receivableInBaseMinor).toBe(expected.debts.receivableInBaseMinor);
  expect(debts.payableInBaseMinor).toBe(expected.debts.payableInBaseMinor);
  for (const debt of expected.debts.debts) expect(debts.byDebt[debt.debtId]).toMatchObject(debt);

  const holdings = calculateHoldings(state, G003.asOf);
  expect(holdings.totalInBaseMinor).toBe(expected.holdings.totalInBaseMinor);
  expect(holdings.netWorthInBaseMinor).toBe(expected.holdings.netWorthInBaseMinor);
  for (const account of expected.holdings.accounts) expect(holdings.accountBalancesInBaseMinor[account.accountId]).toBe(account.balanceInBaseMinor);

  const tags = calculateTagExpenses(state);
  for (const tag of expected.tags) expect(tags.byTag[tag.tagId]).toEqual(tag);
}

describe("G-003 through the journal", () => {
  const materialized = materializeRecurring(toDomainBudgetState(G003) as BudgetState, G003.materializeThrough);

  it("gives the contract's figures, in any order and after a restore", () => {
    const operations = stamp(ledgerDrafts(materialized.state), DEVICE_A);
    const reference = applyJournal(operations);
    expect(reference.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    assertContractFigures(reference);
    expect(reference.state.recurringRules.map((rule) => rule.materializedThrough)).toEqual([G003.materializeThrough]);

    const random = mulberry32(0x6003);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const shuffled = applyJournal(shuffle(operations, random));
      expect(shuffled.state).toEqual(reference.state);
      expect(shuffled.integrity).toEqual(reference.integrity);
    }
    const restored = restoreJournal(JSON.parse(JSON.stringify(reference)) as unknown);
    expect(restored.state).toEqual(reference.state);
  });

  it("meets the same occurrences written by two devices that never met as one", () => {
    // The family's ledger without the occurrences, then two devices each materialising August.
    const ledger = stamp(ledgerDrafts(toDomainBudgetState(G003) as BudgetState), DEVICE_A);
    const written = (device: string): Operation[] => stamp([
      ...materialized.created.map((transaction): OperationDraft => ({
        entity: "transaction", action: "create", targetId: transaction.id, fields: withoutId(transaction),
      } as OperationDraft)),
      ...(materialized.state.recurringRules ?? []).map((rule): OperationDraft => ({
        entity: "recurringRule", action: "update", targetId: rule.id, fields: withoutId(rule),
      } as OperationDraft)),
    ], device, 100);
    const merged = applyJournal([...ledger, ...written(DEVICE_B), ...written(DEVICE_C)]);
    expect(merged.integrity.withheld).toEqual([]);
    for (const occurrence of expected.materialization.occurrences) {
      expect(merged.state.transactions.filter((item) => item.id === occurrence.id)).toHaveLength(1);
    }
    assertContractFigures(merged);
  });
});
