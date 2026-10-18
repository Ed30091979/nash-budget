import { describe, expect, it } from "vitest";
import { G003, toDomainBudgetState } from "@family-budget/test-fixtures";

import {
  calculateBudget,
  calculateDebts,
  calculateHoldings,
  calculateMemberExpenses,
  calculateTagExpenses,
  currencyExponent,
  HOUSEHOLD_ID,
  materializeRecurring,
  recurringOccurrenceId,
  type BudgetState,
  type ExchangeRate,
} from "../src/index.js";

/**
 * G-003: one August in two currencies, with debts, tags and a recurring rule (plan 5.2). Every figure
 * below is read from the fixture and none is written here, so a disagreement is a disagreement with
 * the contract.
 */
const expected = G003.expected;

function initial(): BudgetState {
  return toDomainBudgetState(G003);
}

function materialized(): BudgetState {
  return materializeRecurring(initial(), G003.materializeThrough).state;
}

/** Half-up basis points of a ratio, by rule 9 of contracts/README.md, in integers. */
function basisPoints(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.floor((numerator * 20_000 + denominator) / (2 * denominator));
}

function withRate(state: BudgetState, id: string, rate: ExchangeRate["rate"]): BudgetState {
  return { ...state, exchangeRates: state.exchangeRates!.map((item) => (item.id === id ? { ...item, rate } : item)) };
}

describe("G-003 ledger fixture", () => {
  it("lists the exponent the domain holds for every currency it uses, and derives the household", () => {
    for (const { code, exponent } of G003.currencies) expect(currencyExponent(code), code).toBe(exponent);
    expect(G003.state.household?.id).toBe(HOUSEHOLD_ID);
  });

  it("materialises the water delivery on 4 and 18 August, and nothing on a second call", () => {
    const result = materializeRecurring(initial(), G003.materializeThrough);
    expect(result.created.map((item) => ({ id: item.id, recurringRuleId: item.recurringRuleId, occurredOn: item.occurredOn })))
      .toEqual(expected.materialization.occurrences);
    for (const occurrence of expected.materialization.occurrences) {
      expect(occurrence.id).toBe(recurringOccurrenceId(occurrence.recurringRuleId, occurrence.occurredOn));
    }
    expect(result.skipped.map((item) => ({ recurringRuleId: item.ruleId, date: item.date, reason: item.reason })))
      .toEqual(expected.materialization.skipped);
    expect((result.state.recurringRules ?? []).map((rule) => ({ recurringRuleId: rule.id, date: rule.materializedThrough })))
      .toEqual(expected.materialization.materializedThrough);
    // Every occurrence is the template's operation: posted, on the rule's account and category, labelled.
    for (const occurrence of result.created) {
      expect(occurrence).toMatchObject({ kind: "expense", status: "posted", amountMinor: 150_000, note: "Доставка воды" });
    }

    const repeated = materializeRecurring(result.state, G003.materializeThrough);
    expect(repeated.created).toHaveLength(expected.materialization.createdOnRepeat);
    expect(repeated.state).toBe(result.state);
  });

  it("counts the budget in roubles, the dollars by the snapshots they carry", () => {
    const metrics = calculateBudget(materialized());
    const budget = expected.budget;
    expect(metrics.budgetId).toBe(budget.budgetId);
    expect(metrics.incomeMinor).toBe(budget.incomeMinor);
    expect(metrics.grossExpensesMinor).toBe(budget.grossExpensesMinor);
    expect(metrics.refundsMinor).toBe(budget.refundsMinor);
    expect(metrics.expensesMinor).toBe(budget.expensesMinor);
    expect(metrics.plannedExpenseMinor).toBe(budget.plannedExpenseMinor);
    expect(basisPoints(metrics.expensesMinor, metrics.plannedExpenseMinor)).toBe(budget.executionBasisPoints);
    expect(metrics.capitalMinor).toBe(budget.capitalMinor);
    for (const { accountId, balanceMinor } of budget.accountBalances) {
      expect(metrics.accountBalancesMinor[accountId], accountId).toBe(balanceMinor);
    }
    for (const category of budget.categories) {
      const actual = metrics.categoryMetrics[category.categoryId]!;
      expect({
        categoryId: actual.categoryId,
        availableMinor: actual.availableMinor,
        expenseMinor: actual.expenseMinor,
        refundMinor: actual.refundMinor,
        actualMinor: actual.actualMinor,
        remainingMinor: actual.remainingMinor,
        usageBasisPoints: basisPoints(actual.actualMinor, actual.availableMinor),
        status: actual.status,
      }, category.categoryId).toEqual(category);
    }
    for (const { goalId, contributedMinor } of budget.goalContributions) {
      expect(metrics.goalContributionsMinor[goalId] ?? 0, goalId).toBe(contributedMinor);
    }
    // The split by participant still adds up to the same total.
    expect(calculateMemberExpenses(materialized()).expensesMinor).toBe(budget.expensesMinor);
  });

  it("would read a dollar as a kopeck without the snapshots: the reason they exist", () => {
    // Travel by raw amounts: 40,00 + 25,55 − 10,00 $ — 5 555 minor units, 93 basis points, «normal».
    const travel = G003.state.transactions.filter((item) => item.kind !== "transfer" && "categoryId" in item && item.categoryId === expected.budget.categories[1]!.categoryId);
    const raw = travel.reduce((total, item) => total + (item.kind === "refund" ? -item.amountMinor : item.amountMinor), 0);
    expect(raw).toBe(5_555);
    expect(expected.budget.categories[1]!.status).toBe("near_limit");
    // And capital by raw balances would add cents to kopecks.
    const mixed = expected.budget.accountBalances.reduce((total, item) => total + item.balanceMinor, 0);
    expect(mixed).toBe(14_961_945);
    expect(mixed).not.toBe(expected.budget.capitalMinor);
  });

  it("values the debts on the day at the latest rate", () => {
    const debts = calculateDebts(materialized(), G003.asOf);
    expect(debts.debts.map(({ debtId, outMinor, inMinor, balanceMinor, balanceInBaseMinor, overdue }) => ({ debtId, outMinor, inMinor, balanceMinor, balanceInBaseMinor, overdue })))
      .toEqual(expected.debts.debts);
    expect(debts.receivableInBaseMinor).toBe(expected.debts.receivableInBaseMinor);
    expect(debts.payableInBaseMinor).toBe(expected.debts.payableInBaseMinor);
    expect(debts.netInBaseMinor).toBe(expected.debts.netInBaseMinor);
    expect(debts.unvaluedDebtIds).toEqual(expected.debts.unvaluedDebtIds);
  });

  it("values the holdings on the day, leaving the piggy bank out of the total", () => {
    const holdings = calculateHoldings(materialized(), G003.asOf);
    expect(G003.state.accounts.map((account) => ({
      accountId: account.id,
      balanceMinor: holdings.accountBalancesMinor[account.id],
      balanceInBaseMinor: holdings.accountBalancesInBaseMinor[account.id],
    }))).toEqual(expected.holdings.accounts);
    expect(holdings.totalInBaseMinor).toBe(expected.holdings.totalInBaseMinor);
    expect(holdings.unvaluedAccountIds).toEqual(expected.holdings.unvaluedAccountIds);
    expect(holdings.netWorthInBaseMinor).toBe(expected.holdings.netWorthInBaseMinor);
    expect(holdings.debts).toEqual(calculateDebts(materialized(), G003.asOf));
  });

  it("splits the budget by tag, an archived tag included", () => {
    expect(calculateTagExpenses(materialized()).tags).toEqual(expected.tags);
  });

  it("does not let a rate revalue the past: the budget keeps its snapshots, the holdings move", () => {
    const [julyRate, augustRate] = G003.state.exchangeRates!;
    const reference = materialized();

    const julyChanged = withRate(reference, julyRate!.id, { baseMinor: 9_500, quoteMinor: 100 });
    expect(calculateBudget(julyChanged)).toEqual(calculateBudget(reference));
    expect(calculateTagExpenses(julyChanged)).toEqual(calculateTagExpenses(reference));
    // On 31 August the July rate values nothing: the August one is later.
    expect(calculateHoldings(julyChanged, G003.asOf)).toEqual(calculateHoldings(reference, G003.asOf));

    const augustChanged = withRate(reference, augustRate!.id, { baseMinor: 10_000, quoteMinor: 100 });
    expect(calculateBudget(augustChanged)).toEqual(calculateBudget(reference));
    const holdings = calculateHoldings(augustChanged, G003.asOf);
    expect(holdings.accountBalancesInBaseMinor[G003.state.accounts[1]!.id]).toBe(7_444_500);
    expect(holdings.debts.payableInBaseMinor).toBe(500_000);
    expect(holdings.netWorthInBaseMinor).toBe(12_887_500 + 7_444_500 + 300_000 - 500_000);
  });

  it("is a state the domain accepts before the rule writes, too", () => {
    expect(() => calculateBudget(initial())).not.toThrow();
    expect(calculateBudget(initial()).expensesMinor).toBe(expected.budget.expensesMinor - 300_000);
  });
});
