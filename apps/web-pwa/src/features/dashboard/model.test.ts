import { calculateBudget, makePlanningSeed, PLANNING_IDS, SEED_IDS, type BudgetState } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import {
  buildOperationSearchIndex,
  createDashboardModel,
  OPERATION_PAGE_SIZE,
  searchOperationPage,
  searchOperations,
} from "./model";

function makeSixOperationState(): BudgetState {
  const source = makePlanningSeed();
  return {
    ...source,
    transactions: [
      ...source.transactions,
      {
        id: "85555555-5555-4555-8555-555555555551",
        occurredOn: "2026-07-10",
        status: "posted",
        kind: "refund",
        amountMinor: 100_000,
        accountId: SEED_IDS.accounts.main,
        categoryId: PLANNING_IDS.categories.food,
        originalTransactionId: source.transactions[2]!.id,
      },
      {
        id: "85555555-5555-4555-8555-555555555552",
        occurredOn: "2026-07-11",
        status: "posted",
        kind: "transfer",
        amountMinor: 500_000,
        fromAccountId: SEED_IDS.accounts.main,
        toAccountId: SEED_IDS.accounts.savings,
      },
    ],
  };
}

describe("dashboard derived model", () => {
  it("matches canonical G-002 counts, 12/24 horizon and exact plan/fact values", () => {
    const state = makePlanningSeed();
    expect([
      state.accounts.length,
      state.categories.length,
      state.budgets.length,
      state.budgets[0]!.lines.length,
      state.goals.length,
      state.annualCommitments.length,
      state.scheduledExpenses.length,
      state.transactions.length,
    ]).toEqual([2, 7, 1, 4, 1, 3, 4, 4]);

    const twelve = createDashboardModel(state, "2026-07", 12);
    const twentyFour = createDashboardModel(state, "2026-07", 24);
    expect(twelve.months).toHaveLength(12);
    expect(twentyFour.months).toHaveLength(24);
    expect(twentyFour.months.slice(0, 12)).toEqual(twelve.months);
    expect(twelve.totals).toMatchObject({
      incomeMinor: 18_000_000,
      expensesMinor: 7_100_000,
      capitalMinor: 12_400_000,
    });
    expect(twelve.months[0]).toMatchObject({
      scheduledExpenseMinor: 5_300_000,
      flexiblePlanMinor: 5_300_000,
      annualReserveMinor: 1_980_900,
      goalPlanMinor: 1_000_000,
      spendableAfterPlanMinor: 4_419_100,
      totalIncomeFactMinor: 18_000_000,
      totalExpenseFactMinor: 7_100_000,
      flexibleFactMinor: 2_600_000,
      flexibleRemainingMinor: 2_700_000,
    });
    expect(twelve.months.find((item) => item.month === "2026-09")).toMatchObject({
      seasonalExpenseMinor: 3_100_000,
      scheduledExpenseMinor: 8_400_000,
      spendableAfterPlanMinor: 1_319_100,
    });
    expect(twentyFour.months.find((item) => item.month === "2027-01")?.annualDueMinor).toBe(7_200_000);
    expect(twentyFour.months.find((item) => item.month === "2027-06")?.annualDueMinor).toBe(9_000_000);
    expect(twentyFour.months.find((item) => item.month === "2028-01")?.annualDueMinor).toBe(7_200_000);
    expect(twentyFour.months.find((item) => item.month === "2028-06")?.annualDueMinor).toBe(0);

    expect(twentyFour.upcomingPayments).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Страхование автомобиля", dueDate: "2027-01-15", amountMinor: 7_200_000 }),
      expect.objectContaining({ name: "Страхование автомобиля", dueDate: "2028-01-15", amountMinor: 7_200_000 }),
      expect.objectContaining({ name: "Платёж за загородный дом", dueDate: "2027-05-01", amountMinor: 3_600_000 }),
      expect.objectContaining({ name: "Летний лагерь", dueDate: "2027-06-15", amountMinor: 9_000_000 }),
    ]));
    expect(twentyFour.upcomingPayments).not.toContainEqual(expect.objectContaining({ name: "Летний лагерь", dueDate: "2028-06-15" }));
    expect(twentyFour.upcomingPayments.slice(0, 5)).toEqual([
      expect.objectContaining({ name: "Аренда / ипотека", dueDate: "2026-07-05", amountMinor: 4_500_000 }),
      expect.objectContaining({ name: "ЖКХ, интернет и связь", dueDate: "2026-07-15", amountMinor: 800_000 }),
      expect.objectContaining({ name: "Обучение детей", dueDate: "2026-09-10", amountMinor: 2_500_000 }),
      expect.objectContaining({ name: "Секции", dueDate: "2026-09-12", amountMinor: 600_000 }),
      expect.objectContaining({ name: "Страхование автомобиля", dueDate: "2027-01-15", amountMinor: 7_200_000 }),
    ]);
    expect(twentyFour.upcomingPayments.filter((item) => item.kind === "scheduled")).toHaveLength(4);
  });

  it("finds the nearest selected-month occurrence and normalizes its due day", () => {
    const source = makePlanningSeed();
    const state: BudgetState = {
      ...source,
      scheduledExpenses: [{
        ...source.scheduledExpenses[2]!,
        dueDay: 31,
        months: [2],
      }],
    };
    expect(createDashboardModel(state, "2027-01", 12).upcomingPayments.find(
      (item) => item.kind === "scheduled",
    )).toMatchObject({
      name: "Обучение детей",
      dueDate: "2027-02-28",
      kind: "scheduled",
    });
  });

  it("clamps a recurring leap-day payment to the target year's month end", () => {
    const source = makePlanningSeed();
    const state: BudgetState = {
      ...source,
      annualCommitments: [{
        ...source.annualCommitments[0]!,
        dueDate: "2024-02-29",
        recurrence: "annual",
      }],
    };

    const annual = createDashboardModel(state, "2027-01", 24).upcomingPayments.filter(
      (payment) => payment.kind === "annual",
    );
    expect(annual).toEqual([
      expect.objectContaining({ dueDate: "2027-02-28", kind: "annual" }),
      expect.objectContaining({ dueDate: "2028-02-29", kind: "annual" }),
    ]);
  });

  it("compares flexible fact only with active flexible lines while keeping total metrics separate", () => {
    const source = makePlanningSeed();
    const archived: BudgetState = {
      ...source,
      budgets: source.budgets.map((budget) => ({
        ...budget,
        lines: budget.lines.map((line) => line.categoryId === PLANNING_IDS.categories.food
          ? { ...line, active: false }
          : line),
      })),
    };
    const model = createDashboardModel(archived, "2026-07", 12);
    expect(model.months[0]).toMatchObject({
      flexiblePlanMinor: 2_300_000,
      flexibleFactMinor: 400_000,
      flexibleRemainingMinor: 1_900_000,
      totalExpenseFactMinor: 7_100_000,
    });
    expect(model.totals.expensesMinor).toBe(7_100_000);
  });

  it("searches bounded normalized literal context immutably and leaves totals unchanged", () => {
    const state = makeSixOperationState();
    const snapshot = structuredClone(state);
    const totals = calculateBudget(state);
    const found = searchOperations(state, { query: "  П\u0440\u043E\u0434\u0443\u043A\u0442\u044B  " });
    expect(found).toHaveLength(2);
    expect(found.map((item) => item.transaction.kind).sort()).toEqual(["expense", "refund"]);
    expect(searchOperations(state)).toHaveLength(6);
    expect(state).toEqual(snapshot);
    expect(calculateBudget(state)).toEqual(totals);
    expect(() => searchOperations(state, { query: "x".repeat(81) })).toThrow("80");
    expect(() => searchOperations(state, { query: "\uFDFA".repeat(80) })).not.toThrow();
    expect(searchOperations(state, { query: "\uFDFA".repeat(80) })).toEqual([]);
    expect(() => searchOperations(state, { query: "[.*+?^${}()|\\]" })).not.toThrow();
  });

  it("sorts a copied result and provides category/refund context even when a category is archived", () => {
    const state = makeSixOperationState();
    const archived = {
      ...state,
      categories: state.categories.map((item) => item.id === PLANNING_IDS.categories.food ? { ...item, active: false } : item),
    };
    const result = searchOperations(archived, { query: "возврат расхода" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ categoryName: "Продукты" });
    expect(result[0]!.context).toContain("Продукты");
    expect(result[0]!.context).toContain("возврат расхода");
  });

  it("indexes 50k valid operations once and returns bounded deterministic pages with an exact total", () => {
    const source = makePlanningSeed();
    const transactions = Array.from({ length: 50_000 }, (_, index) => ({
      id: `a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      occurredOn: `2026-07-${String(index % 28 + 1).padStart(2, "0")}`,
      status: "posted" as const,
      kind: "income" as const,
      amountMinor: index + 1,
      accountId: SEED_IDS.accounts.main,
    }));
    const state: BudgetState = { ...source, transactions };
    const index = buildOperationSearchIndex(state);
    const rebuilt = buildOperationSearchIndex(state);
    const first = searchOperationPage(index);
    const second = searchOperationPage(index, {}, 1);

    expect(first.total).toBe(50_000);
    expect(first.results).toHaveLength(OPERATION_PAGE_SIZE);
    expect(second.results).toHaveLength(OPERATION_PAGE_SIZE);
    expect(first.results.map((item) => item.transaction.id))
      .toEqual(rebuilt.entries.slice(0, OPERATION_PAGE_SIZE).map((item) => item.transaction.id));
    expect(new Set([
      ...first.results.map((item) => item.transaction.id),
      ...second.results.map((item) => item.transaction.id),
    ]).size).toBe(OPERATION_PAGE_SIZE * 2);
    expect(state.transactions).toBe(transactions);
  });
});
