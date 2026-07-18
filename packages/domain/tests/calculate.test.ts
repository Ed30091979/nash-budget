import { describe, expect, it } from "vitest";

import {
  calculateAnnualPlan,
  calculateBudget,
  makePlanningSeed,
  makeSeedBudget,
  PLANNING_IDS,
  SEED_IDS,
  type BudgetState,
  type Category,
  type Transaction,
} from "../src/index.js";

function makeSpecialIdBudget(): BudgetState {
  return {
    activeBudgetId: "budget",
    accounts: [
      { id: "__proto__", name: "Main", type: "current", currency: "RUB", openingBalanceMinor: 12_300, active: true },
      { id: "constructor", name: "Reserve", type: "reserve", currency: "RUB", openingBalanceMinor: 45_600, active: true },
    ],
    categories: [
      { id: "__proto__", name: "Food", type: "expense", group: "Daily", active: true, sortOrder: 10 },
      { id: "constructor", name: "Home", type: "expense", group: "Fixed", active: true, sortOrder: 20 },
    ],
    budgets: [{
      id: "budget",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      status: "open",
      plannedIncomeMinor: 100_000,
      warningThreshold: 0.8,
      lines: [
        { id: "line-1", categoryId: "__proto__", plannedMinor: 20_000 },
        { id: "line-2", categoryId: "constructor", plannedMinor: 30_000 },
      ],
    }],
    goals: [{
      id: "prototype",
      name: "Reserve",
      linkedAccountId: "constructor",
      targetMinor: 100_000,
      openingContributedMinor: 7_800,
      plannedContributionMinor: 1_000,
      status: "active",
    }],
    annualCommitments: [
      { id: "__proto__", name: "Insurance", categoryId: "__proto__", accountId: "__proto__", dueDate: "2026-12-15", amountMinor: 12_000, reservedMinor: 0, recurrence: "annual", active: true },
      { id: "constructor", name: "House", categoryId: "constructor", accountId: "constructor", dueDate: "2027-01-15", amountMinor: 24_000, reservedMinor: 0, recurrence: "annual", active: true },
      { id: "prototype", name: "Camp", categoryId: "__proto__", accountId: "__proto__", dueDate: "2027-02-15", amountMinor: 36_000, reservedMinor: 0, recurrence: "one_time", active: true },
    ],
    scheduledExpenses: [],
    transactions: [],
  };
}

describe("calculateAnnualPlan", () => {
  it("separates monthly, seasonal, flexible and annual-reserve layers", () => {
    const plan = calculateAnnualPlan(makePlanningSeed(), "2026-07", 12);

    expect(plan.months).toHaveLength(12);
    expect(plan.currentMonth).toMatchObject({
      month: "2026-07",
      plannedIncomeMinor: 18_000_000,
      scheduledExpenseMinor: 5_300_000,
      flexiblePlanMinor: 5_300_000,
      annualReserveMinor: 1_980_845,
      goalPlanMinor: 1_000_000,
      spendableAfterPlanMinor: 4_419_155,
    });
    expect(plan.months[2]).toMatchObject({
      month: "2026-09",
      scheduledExpenseMinor: 8_400_000,
      spendableAfterPlanMinor: 1_319_155,
    });
    expect(plan.months[6]?.annualDueMinor).toBe(7_200_000);
    expect(plan.months[11]?.annualDueMinor).toBe(9_000_000);
    expect(plan.commitments[PLANNING_IDS.commitments.summerCamp]).toMatchObject({
      monthsUntilDue: 12,
      remainingToReserveMinor: 7_500_000,
      monthlyReserveMinor: 625_000,
      status: "on_track",
    });
  });

  it("supports a 24-month horizon and repeats annual payments", () => {
    const plan = calculateAnnualPlan(makePlanningSeed(), "2026-07", 24);

    expect(plan.months[18]).toMatchObject({ month: "2028-01", annualDueMinor: 7_200_000 });
    expect(plan.months[23]).toMatchObject({ month: "2028-06", annualDueMinor: 0 });
  });

  it("keeps special commitment IDs as own keys on a null-prototype record", () => {
    const plan = calculateAnnualPlan(makeSpecialIdBudget(), "2026-07", 12);

    expect(Object.getPrototypeOf(plan.commitments)).toBeNull();
    for (const id of ["__proto__", "constructor", "prototype"] as const) {
      expect(Object.hasOwn(plan.commitments, id)).toBe(true);
      expect(plan.commitments[id]?.commitmentId).toBe(id);
    }
  });
});

describe("calculateBudget", () => {
  it("matches the G-001 seed in integer minor units", () => {
    const metrics = calculateBudget(makeSeedBudget());

    expect(metrics.incomeMinor).toBe(10_000_000);
    expect(metrics.expensesMinor).toBe(7_650_000);
    expect(metrics.capitalMinor).toBe(2_350_000);
    expect(metrics.accountBalancesMinor[SEED_IDS.accounts.main]).toBe(1_350_000);
    expect(metrics.accountBalancesMinor[SEED_IDS.accounts.savings]).toBe(1_000_000);
    expect(metrics.goalContributionMinor).toBe(1_000_000);
    expect(metrics.goalContributionsMinor[SEED_IDS.goal]).toBe(1_000_000);
    expect(metrics.categoryMetrics[SEED_IDS.categories.food]).toMatchObject({
      actualMinor: 3_150_000,
      overMinor: 150_000,
      status: "over_limit",
    });
    expect(metrics.aggregateExecution).toBeCloseTo(0.95625, 10);

    expect(metrics.categoryMetrics[SEED_IDS.categories.housing]?.status).toBe("exhausted");
    expect(metrics.categoryMetrics[SEED_IDS.categories.transport]?.status).toBe("normal");
  });

  it("ignores pending and draft transactions", () => {
    const seed = makeSeedBudget();
    const ignored: readonly Transaction[] = [
      {
        id: "99999999-9999-4999-8999-999999999991",
        occurredOn: "2026-07-11",
        status: "pending",
        kind: "expense",
        amountMinor: 9_000_000,
        accountId: SEED_IDS.accounts.main,
        categoryId: SEED_IDS.categories.food,
      },
      {
        id: "99999999-9999-4999-8999-999999999992",
        occurredOn: "2026-07-12",
        status: "draft",
        kind: "income",
        amountMinor: 9_000_000,
        accountId: SEED_IDS.accounts.main,
      },
    ];

    const metrics = calculateBudget({
      ...seed,
      transactions: [...seed.transactions, ...ignored],
    });

    expect(metrics.incomeMinor).toBe(10_000_000);
    expect(metrics.expensesMinor).toBe(7_650_000);
    expect(metrics.accountBalancesMinor[SEED_IDS.accounts.main]).toBe(1_350_000);
  });

  it("distinguishes no-plan, near-limit, exhausted, and over-limit statuses", () => {
    const seed = makeSeedBudget();
    const emptyCategory: Category = {
      id: "33333333-3333-4333-8333-333333333334",
      name: "Без плана",
      type: "expense",
      group: "Прочее",
      active: true,
      sortOrder: 40,
    };
    const nearLimitExpense: Transaction = {
      id: "99999999-9999-4999-8999-999999999993",
      occurredOn: "2026-07-13",
      status: "posted",
      kind: "expense",
      amountMinor: 300_000,
      accountId: SEED_IDS.accounts.main,
      categoryId: SEED_IDS.categories.transport,
    };

    const state: BudgetState = {
      ...seed,
      categories: [...seed.categories, emptyCategory],
      transactions: [...seed.transactions, nearLimitExpense],
    };
    const metrics = calculateBudget(state);

    expect(metrics.categoryMetrics[emptyCategory.id]?.status).toBe("no_plan");
    expect(metrics.categoryMetrics[SEED_IDS.categories.transport]?.status).toBe("near_limit");
    expect(metrics.categoryMetrics[SEED_IDS.categories.housing]?.status).toBe("exhausted");
    expect(metrics.categoryMetrics[SEED_IDS.categories.food]?.status).toBe("over_limit");
  });

  it("rejects fractional minor-unit amounts", () => {
    const seed = makeSeedBudget();
    const invalidTransaction: Transaction = {
      id: "99999999-9999-4999-8999-999999999994",
      occurredOn: "2026-07-14",
      status: "posted",
      kind: "expense",
      amountMinor: 1.5,
      accountId: SEED_IDS.accounts.main,
      categoryId: SEED_IDS.categories.food,
    };

    expect(() =>
      calculateBudget({
        ...seed,
        transactions: [...seed.transactions, invalidTransaction],
      }),
    ).toThrow(/integer minor-unit amount/);
  });

  it("keeps special account, category, and goal IDs as own keys on null-prototype records", () => {
    const metrics = calculateBudget(makeSpecialIdBudget());

    expect(Object.getPrototypeOf(metrics.accountBalancesMinor)).toBeNull();
    expect(Object.getPrototypeOf(metrics.categoryMetrics)).toBeNull();
    expect(Object.getPrototypeOf(metrics.goalContributionsMinor)).toBeNull();

    expect(Object.hasOwn(metrics.accountBalancesMinor, "__proto__")).toBe(true);
    expect(Object.hasOwn(metrics.accountBalancesMinor, "constructor")).toBe(true);
    expect(metrics.accountBalancesMinor["__proto__"]).toBe(12_300);
    expect(metrics.accountBalancesMinor["constructor"]).toBe(45_600);

    expect(Object.hasOwn(metrics.categoryMetrics, "__proto__")).toBe(true);
    expect(Object.hasOwn(metrics.categoryMetrics, "constructor")).toBe(true);
    expect(metrics.categoryMetrics["__proto__"]?.categoryId).toBe("__proto__");
    expect(metrics.categoryMetrics["constructor"]?.categoryId).toBe("constructor");

    expect(Object.hasOwn(metrics.goalContributionsMinor, "prototype")).toBe(true);
    expect(metrics.goalContributionsMinor["prototype"]).toBe(7_800);
  });
});
