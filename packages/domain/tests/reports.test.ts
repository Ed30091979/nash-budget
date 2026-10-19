import { describe, expect, it } from "vitest";
import { G003, toDomainBudgetState } from "@family-budget/test-fixtures";

import {
  calculateBudget,
  calculateMonthlySeries,
  calculatePeriodBreakdown,
  calculateTagExpenses,
  materializeRecurring,
  type BudgetState,
  type ExchangeRate,
} from "../src/index.js";

/**
 * Reports on G-003 (plan of wave 2, §4 «2d»): August 2026 in two currencies, with a refund, debts,
 * a transfer, tags and a recurring rule that writes two water deliveries. The canonical figures
 * come from the fixture's own expectations, so a disagreement is a disagreement with the contract:
 * C1 «Продукты» 1 550 000, C2 «Путешествия» fact 506 338 (expenses 596 338 − refund 90 000),
 * T1 «Отпуск» 506 338, T2 «Дом» 1 550 000, T3 «Старое» — income 12 000 000.
 */
const expected = G003.expected;
const [food, travel, salary] = G003.state.categories;
const [card, dollars, piggy] = G003.state.accounts;
const [vacation, home, old] = G003.state.tags!;
const AUGUST = { from: "2026-08-01", to: "2026-08-31" } as const;

function materialized(): BudgetState {
  return materializeRecurring(toDomainBudgetState(G003), G003.materializeThrough).state;
}

describe("calculatePeriodBreakdown — G-003, August as a calendar month", () => {
  it("names the canonical figures: C1 1 550 000, C2 fact 506 338; T1 506 338, T2 1 550 000, T3 12 000 000", () => {
    const report = calculatePeriodBreakdown(materialized(), AUGUST);
    const byCategory = new Map(report.expense.categories.map((row) => [row.categoryId, row]));
    expect(byCategory.get(food!.id)).toEqual({ categoryId: food!.id, grossMinor: 1_550_000, refundMinor: 0, netMinor: 1_550_000, transactionCount: 3 });
    expect(byCategory.get(travel!.id)).toEqual({ categoryId: travel!.id, grossMinor: 596_338, refundMinor: 90_000, netMinor: 506_338, transactionCount: 3 });
    // The fixture says the same about the budget's categories.
    expect(expected.budget.categories.map((row) => row.actualMinor)).toEqual([1_550_000, 506_338]);

    const byTag = new Map(report.tags.map((row) => [row.tagId, row]));
    expect(byTag.get(vacation!.id)?.actualMinor).toBe(506_338);
    expect(byTag.get(home!.id)?.actualMinor).toBe(1_550_000);
    expect(byTag.get(old!.id)?.incomeMinor).toBe(12_000_000);
    expect(byTag.get(old!.id)?.actualMinor).toBe(0);
    // An archived tag is listed like the others, and the order is the state's.
    expect(report.tags.map((row) => row.tagId)).toEqual([vacation!.id, home!.id, old!.id]);
    expect(report.tags).toEqual(expected.tags);
  });

  it("totals: refunds netted, in roubles by the snapshots, transfers and debts left out", () => {
    const report = calculatePeriodBreakdown(materialized(), AUGUST);
    expect(report.baseCurrency).toBe("RUB");
    expect(report.expense.grossMinor).toBe(expected.budget.grossExpensesMinor);
    expect(report.expense.refundsMinor).toBe(expected.budget.refundsMinor);
    expect(report.expense.totalMinor).toBe(expected.budget.expensesMinor);
    expect(report.expense.totalMinor).toBe(2_056_338);
    expect(report.income.totalMinor).toBe(expected.budget.incomeMinor);
    expect(report.income.categories).toEqual([{ categoryId: salary!.id, grossMinor: 12_000_000, refundMinor: 0, netMinor: 12_000_000, transactionCount: 1 }]);
    // Largest first: «Продукты» before «Путешествия».
    expect(report.expense.categories.map((row) => row.categoryId)).toEqual([food!.id, travel!.id]);
    // 1 income + 3 food (one by hand, two by the rule) + 2 travel expenses + 1 refund.
    expect(report.transactionCount).toBe(7);
  });

  it("is the budget, figure for figure, when the budget's window is the calendar month", () => {
    const state = materialized();
    const report = calculatePeriodBreakdown(state, AUGUST);
    const budget = calculateBudget(state);
    expect(report.expense.totalMinor).toBe(budget.expensesMinor);
    expect(report.income.totalMinor).toBe(budget.incomeMinor);
    for (const row of report.expense.categories) expect(row.netMinor).toBe(budget.categoryMetrics[row.categoryId!]?.actualMinor);
    expect(report.tags).toEqual(calculateTagExpenses(state).tags);
  });

  it("counts the calendar, not a budget window that is not a calendar month — and says so by its figures", () => {
    // A plan of 5–20 August, as a backup or another device may bring: the budget counts its window,
    // the report counts the whole of August. The water of 4 August and the purchase of 3 August
    // are outside the window and inside the month.
    const state = materialized();
    const narrow: BudgetState = { ...state, budgets: state.budgets.map((budget) => ({ ...budget, startDate: "2026-08-05", endDate: "2026-08-20" })) };
    expect(calculateBudget(narrow).categoryMetrics[food!.id]?.actualMinor).toBe(150_000);
    expect(calculatePeriodBreakdown(narrow, AUGUST).expense.categories.find((row) => row.categoryId === food!.id)?.netMinor).toBe(1_550_000);
    // And a calendar period inside the month is just those days.
    const firstWeek = calculatePeriodBreakdown(state, { from: "2026-08-01", to: "2026-08-07" });
    expect(firstWeek.expense.totalMinor).toBe(1_250_000 + 150_000);
    expect(firstWeek.income.totalMinor).toBe(12_000_000);
  });

  it("looks at the accounts asked for: the dollar account alone holds the trip, its refund included", () => {
    const state = materialized();
    const dollarsOnly = calculatePeriodBreakdown(state, { ...AUGUST, accountIds: [dollars!.id] });
    expect(dollarsOnly.expense.categories).toEqual([{ categoryId: travel!.id, grossMinor: 596_338, refundMinor: 90_000, netMinor: 506_338, transactionCount: 3 }]);
    expect(dollarsOnly.income.totalMinor).toBe(0);
    expect(dollarsOnly.tags.find((row) => row.tagId === home!.id)?.actualMinor).toBe(0);
    const cardOnly = calculatePeriodBreakdown(state, { ...AUGUST, accountIds: [card!.id] });
    expect(cardOnly.expense.totalMinor).toBe(1_550_000);
    expect(cardOnly.income.totalMinor).toBe(12_000_000);
    // The piggy bank has no income or expense — and an empty filter is nothing, not everything.
    expect(calculatePeriodBreakdown(state, { ...AUGUST, accountIds: [piggy!.id] }).transactionCount).toBe(0);
    expect(calculatePeriodBreakdown(state, { ...AUGUST, accountIds: [] }).transactionCount).toBe(0);
  });

  it("keeps the snapshot: a changed rate revalues nothing in a report", () => {
    const state = materialized();
    const rates = state.exchangeRates!.map((rate): ExchangeRate => ({ ...rate, rate: { baseMinor: 10_000, quoteMinor: 100 } }));
    expect(calculatePeriodBreakdown({ ...state, exchangeRates: rates }, AUGUST)).toEqual(calculatePeriodBreakdown(state, AUGUST));
  });

  it("an operation with two tags counts in both: tag shares may exceed the total", () => {
    const state = materialized();
    const tagged: BudgetState = {
      ...state,
      transactions: state.transactions.map((item) => (item.id === "85555555-5555-4555-8555-555555555502" ? { ...item, tagIds: [home!.id, vacation!.id] } : item)),
    };
    const report = calculatePeriodBreakdown(tagged, AUGUST);
    const tags = report.tags.reduce((sum, row) => sum + row.actualMinor, 0);
    expect(report.tags.find((row) => row.tagId === vacation!.id)?.actualMinor).toBe(506_338 + 1_250_000);
    expect(tags).toBeGreaterThan(report.expense.totalMinor);
  });

  it("excess refunds stay negative in their category; pending operations count nowhere", () => {
    const state = materialized();
    const refunded: BudgetState = {
      ...state,
      transactions: [
        ...state.transactions,
        { id: "85555555-5555-4555-8555-555555555590", occurredOn: "2026-09-02", status: "posted", kind: "refund", amountMinor: 300_000, accountId: card!.id, categoryId: food!.id, originalTransactionId: "85555555-5555-4555-8555-555555555502" },
        { id: "85555555-5555-4555-8555-555555555591", occurredOn: "2026-09-03", status: "pending", kind: "expense", amountMinor: 900_000, accountId: card!.id, categoryId: travel!.id },
      ],
    };
    const september = calculatePeriodBreakdown(refunded, { from: "2026-09-01", to: "2026-09-30" });
    expect(september.expense.categories).toEqual([{ categoryId: food!.id, grossMinor: 0, refundMinor: 300_000, netMinor: -300_000, transactionCount: 1 }]);
    expect(september.expense.totalMinor).toBe(-300_000);
  });

  it("refuses a period that is not one: reversed, outside the calendar, not a day", () => {
    const state = materialized();
    expect(() => calculatePeriodBreakdown(state, { from: "2026-08-31", to: "2026-08-01" })).toThrow();
    expect(() => calculatePeriodBreakdown(state, { from: "2026-02-30", to: "2026-03-01" })).toThrow();
    expect(() => calculatePeriodBreakdown(state, { from: "1899-12-31", to: "2026-03-01" })).toThrow();
    expect(() => calculatePeriodBreakdown(state, { from: "август", to: "2026-03-01" })).toThrow();
  });
});

describe("calculateMonthlySeries — G-003", () => {
  it("July, August, September: August is the breakdown of August; months without operations are zeros", () => {
    const state = materialized();
    const series = calculateMonthlySeries(state, ["2026-07", "2026-08", "2026-09"]);
    expect(series.baseCurrency).toBe("RUB");
    expect(series.months.map((row) => row.month)).toEqual(["2026-07", "2026-08", "2026-09"]);
    const august = series.months[1]!;
    expect(august).toEqual({
      month: "2026-08", from: "2026-08-01", to: "2026-08-31",
      expenseMinor: 2_056_338, grossExpensesMinor: 2_146_338, refundsMinor: 90_000, incomeMinor: 12_000_000,
    });
    expect(series.months[0]).toMatchObject({ expenseMinor: 0, incomeMinor: 0, to: "2026-07-31" });
    expect(series.months[2]).toMatchObject({ expenseMinor: 0, to: "2026-09-30" });
    const breakdown = calculatePeriodBreakdown(state, AUGUST);
    expect(august.expenseMinor).toBe(breakdown.expense.totalMinor);
    expect(august.incomeMinor).toBe(breakdown.income.totalMinor);
  });

  it("filters by account like the breakdown, and refuses a month that is not one", () => {
    const state = materialized();
    expect(calculateMonthlySeries(state, ["2026-08"], { accountIds: [dollars!.id] }).months[0]?.expenseMinor).toBe(506_338);
    expect(() => calculateMonthlySeries(state, ["2026-13"])).toThrow();
    expect(() => calculateMonthlySeries(state, ["август"])).toThrow();
  });
});
