import { calculateBudget, makePlanningSeed, PLANNING_IDS, SEED_IDS, type BudgetState } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import {
  createDashboardModel,
  nextScheduledDate,
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

    // Вывод над графиком — вывод, а не пересказ таблицы (§4 исследования, пункт 23): он сам
    // называет самый тесный месяц и его сумму, и печатает месяц словами, а не как «2026-07».
    expect(twelve.tightest).toEqual({
      month: "2026-09",
      label: "сентябрь 2026",
      freeMinor: 1_319_100,
      shortfall: false,
      // Сентябрь–январь стоят на одной сумме: дно горизонта считается, а не назначается первому.
      count: 5,
    });
    expect(twelve.summary.replaceAll("\u00a0", " ")).toBe(
      "Плана хватает во все 12 месяцев: свободно от 13 191 ₽ в сентябре 2026 до 48 750 ₽ в июне 2027.",
    );
  });

  it("finds the nearest selected-month occurrence and normalizes its due day", () => {
    const source = makePlanningSeed();
    const tuition = { ...source.scheduledExpenses[2]!, dueDay: 31, months: [2] };

    expect(nextScheduledDate(tuition, "2027-01")).toBe("2027-02-28");
    expect(nextScheduledDate({ ...tuition, months: [2], dueDay: 5 }, "2027-03")).toBe("2028-02-05");
    expect(nextScheduledDate({ ...source.scheduledExpenses[0]!, dueDay: 31 }, "2026-09")).toBe("2026-09-30");
    expect(nextScheduledDate({ ...tuition, active: false }, "2027-01")).toBeNull();
  });

  it("names a shortfall month before anything else it could say about the horizon", () => {
    const source = makePlanningSeed();
    // Один месяц уходит в минус: плановый доход падает ниже уже запланированных расходов.
    const poor: BudgetState = {
      ...source,
      budgets: source.budgets.map((budget) => ({ ...budget, plannedIncomeMinor: 12_000_000 })),
    };
    const model = createDashboardModel(poor, "2026-07", 12);

    expect(model.tightest.shortfall).toBe(true);
    expect(model.summary).toContain("Плана больше дохода");
    expect(model.summary).not.toContain("хватает");
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
  });

  it("counts an operation on a foreign account by the value it carries in roubles, not by its cents", () => {
    const source = makePlanningSeed();
    const dollars = "85555555-5555-4555-8555-5555555555d1";
    const plain = createDashboardModel(source, "2026-07", 12).months[0]!;
    const state: BudgetState = {
      ...source,
      accounts: [...source.accounts, { id: dollars, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true }],
      transactions: [
        ...source.transactions,
        {
          id: "85555555-5555-4555-8555-5555555555d2", occurredOn: "2026-07-10", status: "posted", kind: "expense", amountMinor: 4_000,
          accountId: dollars, categoryId: PLANNING_IDS.categories.food, baseAmountMinor: 360_000, baseCurrency: "RUB", rate: { baseMinor: 9_000, quoteMinor: 100 },
        },
        {
          id: "85555555-5555-4555-8555-5555555555d3", occurredOn: "2026-07-12", status: "posted", kind: "refund", amountMinor: 1_000,
          accountId: dollars, categoryId: PLANNING_IDS.categories.food, originalTransactionId: "85555555-5555-4555-8555-5555555555d2",
          baseAmountMinor: 90_000, baseCurrency: "RUB", rate: { baseMinor: 9_000, quoteMinor: 100 },
        },
        {
          id: "85555555-5555-4555-8555-5555555555d4", occurredOn: "2026-07-15", status: "posted", kind: "income", amountMinor: 10_000,
          accountId: dollars, baseAmountMinor: 900_000, baseCurrency: "RUB", rate: { baseMinor: 9_000, quoteMinor: 100 },
        },
      ],
    };
    const month = createDashboardModel(state, "2026-07", 12).months[0]!;
    // 40 $ spent and 10 $ back, at 90 ₽: 2 700 ₽ more spent — never 30 ₽ — and 100 $ earned is 9 000 ₽.
    expect(month.totalExpenseFactMinor).toBe(plain.totalExpenseFactMinor + 270_000);
    expect(month.flexibleFactMinor).toBe(plain.flexibleFactMinor + 270_000);
    expect(month.totalIncomeFactMinor).toBe(plain.totalIncomeFactMinor + 900_000);
    expect(month.totalExpenseFactMinor - plain.totalExpenseFactMinor).toBe(calculateBudget(state).expensesMinor - calculateBudget(source).expensesMinor);
  });
});
