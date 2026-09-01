import { describe, expect, it } from "vitest";
import { G000, G001, G002, toDomainBudgetState } from "@family-budget/test-fixtures";

import {
  calculateAnnualPlan,
  calculateBudget,
  calculateMemberExpenses,
  makePlanningSeed,
  makeSeedBudget,
  normalizeScheduledDueDate,
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
    const plan = calculateAnnualPlan(toDomainBudgetState(G002), G002.startMonth, 12);

    expect(plan.months).toHaveLength(12);
    expect(plan.currentMonth).toMatchObject({
      month: "2026-07",
      plannedIncomeMinor: 18_000_000,
      scheduledExpenseMinor: 5_300_000,
      seasonalExpenseMinor: 0,
      flexiblePlanMinor: 5_300_000,
      annualReserveMinor: 1_980_900,
      goalPlanMinor: 1_000_000,
      spendableAfterPlanMinor: 4_419_100,
    });
    expect(plan.months[2]).toMatchObject({
      month: "2026-09",
      scheduledExpenseMinor: 8_400_000,
      seasonalExpenseMinor: 3_100_000,
      spendableAfterPlanMinor: 1_319_100,
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
    const state = toDomainBudgetState(G002);
    const plan = calculateAnnualPlan(state, G002.startMonth, 24);
    expect(plan.months.slice(0, 12)).toEqual(calculateAnnualPlan(state, G002.startMonth, 12).months);

    expect(plan.months[18]).toMatchObject({ month: "2028-01", annualDueMinor: 7_200_000 });
    expect(plan.months[23]).toMatchObject({ month: "2028-06", annualDueMinor: 0 });
  });

  it("rolls annual commitment metrics and upcoming order to the next anniversary", () => {
    const state = makePlanningSeed();
    const insuranceId = PLANNING_IDS.commitments.carInsurance;
    const houseId = PLANNING_IDS.commitments.countryHouse;
    const campId = PLANNING_IDS.commitments.summerCamp;

    const february = calculateAnnualPlan(state, "2027-02", 12);
    expect(february.commitments[insuranceId]).toMatchObject({
      monthsUntilDue: 12,
      remainingToReserveMinor: 7_200_000,
      monthlyReserveMinor: 600_000,
      status: "on_track",
    });
    expect(february.months[11]).toMatchObject({
      month: "2028-01",
      annualDueMinor: 7_200_000,
    });
    expect(february.upcomingCommitmentIds).toEqual([houseId, campId, insuranceId]);

    const december = calculateAnnualPlan(state, "2027-12", 2);
    expect(december.commitments[insuranceId]).toMatchObject({
      monthsUntilDue: 2,
      monthlyReserveMinor: 3_600_000,
      status: "due_soon",
    });
    expect(december.commitments[campId]).toMatchObject({
      monthsUntilDue: -5,
      monthlyReserveMinor: 0,
      status: "overdue",
    });
    expect(december.currentMonth.annualReserveMinor).toBe(4_200_000);
    expect(december.months[1]).toMatchObject({
      month: "2028-01",
      annualReserveMinor: 4_200_000,
      annualDueMinor: 7_200_000,
    });
    expect(december.upcomingCommitmentIds).toEqual([insuranceId, houseId]);

    const january = calculateAnnualPlan(state, "2028-01", 13);
    expect(january.commitments[insuranceId]).toMatchObject({
      monthsUntilDue: 1,
      monthlyReserveMinor: 7_200_000,
      status: "due_soon",
    });
    expect(january.commitments[campId]).toMatchObject({
      monthsUntilDue: -6,
      monthlyReserveMinor: 0,
      status: "overdue",
    });
    expect(january.upcomingCommitmentIds).toEqual([insuranceId, houseId]);
    expect(january.months[12]).toMatchObject({
      month: "2029-01",
      annualDueMinor: 7_200_000,
    });
  });

  it("carries the explicit unspent reserve balance across an annual anniversary", () => {
    const seed = makePlanningSeed();
    const insuranceId = PLANNING_IDS.commitments.carInsurance;
    const withInsuranceReserve = (reservedMinor: number): BudgetState => ({
      ...seed,
      annualCommitments: seed.annualCommitments.map((item) =>
        item.id === insuranceId ? { ...item, reservedMinor } : item,
      ),
    });

    expect(calculateAnnualPlan(withInsuranceReserve(7_200_000), "2027-02", 12).commitments[insuranceId]).toMatchObject({
      monthsUntilDue: 12,
      remainingToReserveMinor: 0,
      monthlyReserveMinor: 0,
      status: "funded",
    });
    expect(calculateAnnualPlan(withInsuranceReserve(1_200_000), "2027-02", 12).commitments[insuranceId]).toMatchObject({
      monthsUntilDue: 12,
      remainingToReserveMinor: 6_000_000,
      monthlyReserveMinor: 500_000,
      status: "on_track",
    });
    expect(calculateAnnualPlan(withInsuranceReserve(0), "2027-02", 12).commitments[insuranceId]).toMatchObject({
      monthsUntilDue: 12,
      remainingToReserveMinor: 7_200_000,
      monthlyReserveMinor: 600_000,
      status: "on_track",
    });
  });

  it("orders same-month upcoming commitments by due day and then stable id", () => {
    const state = makePlanningSeed();
    const template = state.annualCommitments[0]!;
    const late = { ...template, id: "same-month-late", dueDate: "2027-01-25" };
    const earlyB = { ...template, id: "same-date-b", dueDate: "2027-01-05" };
    const earlyA = { ...template, id: "same-date-a", dueDate: "2027-01-05" };

    const plan = calculateAnnualPlan(
      { ...state, annualCommitments: [late, earlyB, earlyA] },
      "2027-02",
      12,
    );

    expect(plan.upcomingCommitmentIds).toEqual([earlyA.id, earlyB.id, late.id]);
  });

  it("keeps horizons and annual recurrences inside the four-digit calendar", () => {
    const state = { ...makePlanningSeed(), annualCommitments: [] };

    expect(() => calculateAnnualPlan(state, "9999-12", 2)).toThrow(
      "planning horizon exceeds supported calendar range",
    );
    expect(() => calculateAnnualPlan(makePlanningSeed(), "9999-12", 1)).toThrow(
      "annual recurrence exceeds supported calendar range",
    );

    const boundary = calculateAnnualPlan(state, "9999-12", 1);
    expect(boundary.months).toHaveLength(1);
    expect(boundary.currentMonth.month).toBe("9999-12");
  });

  it("matches every canonical G-002 checkpoint", () => {
    const plan = calculateAnnualPlan(toDomainBudgetState(G002), G002.startMonth, G002.horizonMonths);
    for (const expected of G002.expected.months) {
      expect(plan.months.find((month) => month.month === expected.month)).toMatchObject(expected);
    }
    for (const expected of G002.expected.commitments) {
      expect(plan.commitments[expected.commitmentId]).toEqual(expected);
    }
  });

  it("normalizes due days on local calendar boundaries without timezone arithmetic", () => {
    expect(normalizeScheduledDueDate("2024-02", 31)).toBe("2024-02-29");
    expect(normalizeScheduledDueDate("2025-02", 29)).toBe("2025-02-28");
    expect(normalizeScheduledDueDate("2026-04", 31)).toBe("2026-04-30");
    expect(normalizeScheduledDueDate("2026-12", 30)).toBe("2026-12-30");
    expect(() => calculateAnnualPlan({ ...makePlanningSeed(), annualCommitments: [{ ...makePlanningSeed().annualCommitments[0]!, dueDate: "2025-02-29" }] }, "2026-07", 12)).toThrow(/valid calendar date/);
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
    const metrics = calculateBudget(toDomainBudgetState(G001));

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

  it("matches canonical G-000 and G-001 headline values", () => {
    for (const fixture of [G000, G001]) {
      const metrics = calculateBudget(toDomainBudgetState(fixture));
      expect(metrics.incomeMinor).toBe(fixture.expected.incomeMinor);
      expect(metrics.expensesMinor).toBe(fixture.expected.expenseMinor);
      expect(metrics.capitalMinor).toBe(fixture.expected.netWorthMinor);
      for (const expected of fixture.expected.accountBalances) expect(metrics.accountBalancesMinor[expected.accountId]).toBe(expected.balanceMinor);
    }
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

  it("keeps threshold and zero-plan boundaries exact", () => {
    const seed = makeSeedBudget();
    const category = SEED_IDS.categories.transport;
    const expense = (id: string, amountMinor: number): Transaction => ({ id, occurredOn: "2026-07-15", status: "posted", kind: "expense", amountMinor, accountId: SEED_IDS.accounts.main, categoryId: category });
    for (const [amount, status] of [[300_000, "near_limit"], [500_000, "exhausted"], [500_001, "over_limit"]] as const) {
      expect(calculateBudget({ ...seed, transactions: [...seed.transactions, expense(`edge-${amount}`, amount)] }).categoryMetrics[category]?.status).toBe(status);
    }
    const noPlan = { ...seed, budgets: [{ ...seed.budgets[0]!, lines: seed.budgets[0]!.lines.filter((line) => line.categoryId !== category) }] };
    expect(calculateBudget(noPlan).categoryMetrics[category]?.status).toBe("over_limit");
  });

  it("soft-archives a category without losing its budget line or transaction history", () => {
    const seed = makeSeedBudget();
    const housingId = SEED_IDS.categories.housing;
    const housingLine = seed.budgets[0]!.lines.find((line) => line.categoryId === housingId)!;
    const active = {
      ...seed,
      budgets: [{ ...seed.budgets[0]!, lines: [housingLine] }],
    };

    expect(calculateBudget(active).plannedExpenseMinor).toBe(4_000_000);
    expect(calculateAnnualPlan(active).currentMonth.flexiblePlanMinor).toBe(4_000_000);

    const archived = {
      ...active,
      categories: active.categories.map((category) =>
        category.id === housingId ? { ...category, active: false } : category,
      ),
    };
    const archivedBudget = calculateBudget(archived);
    expect(archivedBudget.plannedExpenseMinor).toBe(0);
    expect(archivedBudget.categoryMetrics[housingId]).toMatchObject({
      availableMinor: 0,
      expenseMinor: 4_000_000,
      actualMinor: 4_000_000,
      status: "over_limit",
    });
    expect(calculateAnnualPlan(archived).currentMonth.flexiblePlanMinor).toBe(0);
    expect(archived.budgets[0]!.lines[0]).toEqual(housingLine);

    const reactivated = {
      ...archived,
      categories: archived.categories.map((category) =>
        category.id === housingId ? { ...category, active: true } : category,
      ),
    };
    expect(calculateBudget(reactivated).plannedExpenseMinor).toBe(4_000_000);
    expect(calculateAnnualPlan(reactivated).currentMonth.flexiblePlanMinor).toBe(4_000_000);
    expect(reactivated.budgets[0]!.lines[0]).toEqual(housingLine);
  });

  it("soft-archives one flexible line without disabling a shared category", () => {
    const seed = makePlanningSeed();
    const childrenId = PLANNING_IDS.categories.children;
    const archivedLine = {
      id: "74444444-4444-4444-8444-444444444455",
      categoryId: childrenId,
      plannedMinor: 900_000,
      rolloverMinor: 200_000,
      adjustmentMinor: -100_000,
      active: false,
    } as const;
    const historicalExpense: Transaction = {
      id: "75555555-5555-4555-8555-555555555559",
      occurredOn: "2026-07-10",
      status: "posted",
      kind: "expense",
      amountMinor: 120_000,
      accountId: SEED_IDS.accounts.main,
      categoryId: childrenId,
    };
    const archived: BudgetState = {
      ...seed,
      budgets: [{
        ...seed.budgets[0]!,
        lines: [...seed.budgets[0]!.lines, archivedLine],
      }],
      transactions: [...seed.transactions, historicalExpense],
    };

    const archivedBudget = calculateBudget(archived);
    expect(archivedBudget.plannedExpenseMinor).toBe(5_300_000);
    expect(archivedBudget.categoryMetrics[childrenId]).toMatchObject({
      availableMinor: 0,
      expenseMinor: 120_000,
      actualMinor: 120_000,
      status: "over_limit",
    });

    const archivedPlan = calculateAnnualPlan(archived, "2026-09", 12);
    expect(archivedPlan.currentMonth).toMatchObject({
      flexiblePlanMinor: 5_300_000,
      scheduledExpenseMinor: 8_400_000,
      seasonalExpenseMinor: 3_100_000,
    });
    expect(archivedPlan.commitments[PLANNING_IDS.commitments.summerCamp]).toMatchObject({
      remainingToReserveMinor: 7_500_000,
      monthlyReserveMinor: 750_000,
    });
    expect(archived.scheduledExpenses.filter((item) => item.categoryId === childrenId)).toEqual(
      seed.scheduledExpenses.filter((item) => item.categoryId === childrenId),
    );
    expect(archived.annualCommitments.find((item) => item.id === PLANNING_IDS.commitments.summerCamp)).toEqual(
      seed.annualCommitments.find((item) => item.id === PLANNING_IDS.commitments.summerCamp),
    );
    expect(archived.budgets[0]!.lines.at(-1)).toEqual(archivedLine);

    const editedRelatedItems: BudgetState = {
      ...archived,
      scheduledExpenses: archived.scheduledExpenses.map((item) =>
        item.name === "Обучение детей" ? { ...item, amountMinor: 2_600_000 } : item,
      ),
      annualCommitments: archived.annualCommitments.map((item) =>
        item.id === PLANNING_IDS.commitments.summerCamp
          ? { ...item, amountMinor: 9_100_000 }
          : item,
      ),
    };
    const editedPlan = calculateAnnualPlan(editedRelatedItems, "2026-09", 12);
    expect(editedPlan.currentMonth.scheduledExpenseMinor).toBe(8_500_000);
    expect(editedPlan.commitments[PLANNING_IDS.commitments.summerCamp]).toMatchObject({
      remainingToReserveMinor: 7_600_000,
      monthlyReserveMinor: 760_000,
    });

    const reactivated: BudgetState = {
      ...archived,
      budgets: [{
        ...archived.budgets[0]!,
        lines: archived.budgets[0]!.lines.map((line) =>
          line.id === archivedLine.id ? { ...line, active: true } : line,
        ),
      }],
    };
    expect(calculateBudget(reactivated).plannedExpenseMinor).toBe(6_300_000);
    expect(calculateAnnualPlan(reactivated, "2026-09", 12).currentMonth.flexiblePlanMinor).toBe(6_300_000);
    expect(reactivated.budgets[0]!.lines.at(-1)).toMatchObject({
      id: archivedLine.id,
      plannedMinor: archivedLine.plannedMinor,
      rolloverMinor: archivedLine.rolloverMinor,
      adjustmentMinor: archivedLine.adjustmentMinor,
      active: true,
    });
  });

  it("treats an omitted budget-line active flag as active and rejects invalid runtime values", () => {
    const seed = makeSeedBudget();
    const firstLine = seed.budgets[0]!.lines[0]!;
    expect(firstLine.active).toBeUndefined();
    expect(calculateBudget(seed).categoryMetrics[firstLine.categoryId]?.availableMinor).toBe(
      firstLine.plannedMinor,
    );

    const invalidLine = { ...firstLine, active: "false" } as unknown as typeof firstLine;
    const invalid: BudgetState = {
      ...seed,
      budgets: [{
        ...seed.budgets[0]!,
        lines: [invalidLine, ...seed.budgets[0]!.lines.slice(1)],
      }],
    };
    expect(() => calculateBudget(invalid)).toThrow(/active must be a boolean/);

    const inactiveInvalidAmount = {
      ...firstLine,
      plannedMinor: -1,
      active: false,
    };
    expect(() => calculateBudget({
      ...seed,
      budgets: [{
        ...seed.budgets[0]!,
        lines: [inactiveInvalidAmount, ...seed.budgets[0]!.lines.slice(1)],
      }],
    })).toThrow(/plannedMinor must not be negative/);

    expect(() => calculateBudget({
      ...seed,
      budgets: [{
        ...seed.budgets[0]!,
        lines: [firstLine, { ...firstLine, id: "duplicate-inactive-line", active: false }],
      }],
    })).toThrow(/multiple lines for category/);
  });

  it("keeps an excess refund as explicit negative net actual and aggregate expense", () => {
    const seed = makeSeedBudget();
    const refund: Transaction = { id: "refund-large", occurredOn: "2026-07-15", status: "posted", kind: "refund", amountMinor: 4_000_000, accountId: SEED_IDS.accounts.main, categoryId: SEED_IDS.categories.food, originalTransactionId: SEED_IDS.transactions.food };
    const metrics = calculateBudget({ ...seed, transactions: [...seed.transactions, refund] });
    expect(metrics.grossExpensesMinor).toBe(7_650_000);
    expect(metrics.refundsMinor).toBe(4_000_000);
    expect(metrics.categoryMetrics[SEED_IDS.categories.food]).toMatchObject({
      actualMinor: -850_000,
      overMinor: 0,
      status: "normal",
    });
    expect(metrics.expensesMinor).toBe(3_650_000);
  });

  it("requires every refund to reference a posted expense in the same category", () => {
    const seed = makeSeedBudget();
    const base = { id: "refund", occurredOn: "2026-07-15", status: "posted", kind: "refund", amountMinor: 100, accountId: SEED_IDS.accounts.main, categoryId: SEED_IDS.categories.food } as const;
    const missing = base as unknown as Transaction;
    const income = { ...base, originalTransactionId: SEED_IDS.transactions.income } as Transaction;
    const wrongCategory = { ...base, originalTransactionId: SEED_IDS.transactions.housing } as Transaction;
    expect(() => calculateBudget({ ...seed, transactions: [...seed.transactions, missing] })).toThrow(/unknown id/);
    expect(() => calculateBudget({ ...seed, transactions: [...seed.transactions, income] })).toThrow(/posted expense/);
    expect(() => calculateBudget({ ...seed, transactions: [...seed.transactions, wrongCategory] })).toThrow(/original expense category/);
  });

  it("rejects a refund dated before its original expense", () => {
    const seed = makeSeedBudget();
    const predatingRefund: Transaction = {
      id: "refund-before-expense",
      occurredOn: "2026-07-04",
      status: "posted",
      kind: "refund",
      amountMinor: 100,
      accountId: SEED_IDS.accounts.main,
      categoryId: SEED_IDS.categories.food,
      originalTransactionId: SEED_IDS.transactions.food,
    };

    expect(() =>
      calculateBudget({ ...seed, transactions: [...seed.transactions, predatingRefund] }),
    ).toThrow(/must not occur before the original expense/);
  });

  it("accepts a refund dated on the same day as its original expense", () => {
    const seed = makeSeedBudget();
    const sameDayRefund: Transaction = {
      id: "refund-same-day",
      occurredOn: "2026-07-05",
      status: "posted",
      kind: "refund",
      amountMinor: 100,
      accountId: SEED_IDS.accounts.main,
      categoryId: SEED_IDS.categories.food,
      originalTransactionId: SEED_IDS.transactions.food,
    };

    const metrics = calculateBudget({
      ...seed,
      transactions: [...seed.transactions, sameDayRefund],
    });

    expect(metrics.refundsMinor).toBe(100);
    expect(metrics.categoryMetrics[SEED_IDS.categories.food]?.refundMinor).toBe(100);
  });

  it("rejects same-account transfer, duplicate IDs, unknown references, and safe-integer overflow", () => {
    const seed = makeSeedBudget();
    const transfer: Transaction = { id: "same", occurredOn: "2026-07-15", status: "posted", kind: "transfer", amountMinor: 1, fromAccountId: SEED_IDS.accounts.main, toAccountId: SEED_IDS.accounts.main };
    expect(() => calculateBudget({ ...seed, transactions: [...seed.transactions, transfer] })).toThrow(/different accounts/);
    expect(() => calculateBudget({ ...seed, accounts: [...seed.accounts, seed.accounts[0]!] })).toThrow(/duplicate id/);
    const unknown: Transaction = { id: "unknown", occurredOn: "2026-07-15", status: "posted", kind: "income", amountMinor: 1, accountId: "missing" };
    const overflow: Transaction = { id: "overflow", occurredOn: "2026-07-15", status: "posted", kind: "income", amountMinor: 1, accountId: SEED_IDS.accounts.main };
    expect(() => calculateBudget({ ...seed, transactions: [unknown] })).toThrow(/unknown id/);
    expect(() => calculateBudget({ ...seed, accounts: [{ ...seed.accounts[0]!, openingBalanceMinor: Number.MAX_SAFE_INTEGER }, seed.accounts[1]!], transactions: [overflow] })).toThrow(/integer minor-unit amount/);
  });

  it("rejects duplicate planning goals and transactions plus unknown runtime enums", () => {
    const seed = makePlanningSeed();
    expect(() => calculateAnnualPlan({ ...seed, goals: [...seed.goals, seed.goals[0]!] }, "2026-07", 12)).toThrow(/duplicate id/);
    expect(() => calculateAnnualPlan({ ...seed, transactions: [...seed.transactions, seed.transactions[0]!] }, "2026-07", 12)).toThrow(/duplicate id/);
    const badStatus = { ...seed.transactions[0]!, status: "posted " } as unknown as Transaction;
    const badKind = { ...seed.transactions[0]!, kind: "__proto__" } as unknown as Transaction;
    expect(() => calculateBudget({ ...seed, transactions: [badStatus] })).toThrow(/status has unknown value/);
    expect(() => calculateBudget({ ...seed, transactions: [badKind] })).toThrow(/kind has unknown value/);
  });

  it("validates every account and category before annual planning", () => {
    const seed = makePlanningSeed();
    const badAccountType = { ...seed.accounts[0]!, type: "__proto__" } as unknown as BudgetState["accounts"][number];
    const badCategoryType = { ...seed.categories[0]!, type: "__proto__" } as unknown as BudgetState["categories"][number];
    expect(() => calculateAnnualPlan({ ...seed, accounts: [badAccountType, ...seed.accounts.slice(1)] }, "2026-07", 12)).toThrow(/type has unknown value/);
    expect(() => calculateAnnualPlan({ ...seed, categories: [badCategoryType, ...seed.categories.slice(1)] }, "2026-07", 12)).toThrow(/type has unknown value/);
    expect(() => calculateAnnualPlan({ ...seed, accounts: [{ ...seed.accounts[0]!, openingBalanceMinor: Number.MAX_SAFE_INTEGER + 1 }, ...seed.accounts.slice(1)] }, "2026-07", 12)).toThrow(/integer minor-unit amount/);
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

const G002_OWNER_ID = "71111111-1111-4111-8111-111111111111";
const G002_PARTNER_ID = "71111111-1111-4111-8111-111111111112";

/** A budget exactly as it was written before members existed: no list, no labels anywhere. */
function withoutMembers(state: BudgetState): BudgetState {
  const { members: _members, ...rest } = state;
  return {
    ...rest,
    transactions: state.transactions.map((transaction) => {
      const { memberId: _memberId, ...plain } = transaction;
      return plain as Transaction;
    }),
  };
}

/** Round-trips through JSON the way a restored backup file does. */
function throughBackup(state: BudgetState): BudgetState {
  return JSON.parse(JSON.stringify(state)) as BudgetState;
}

function makeMemberBudget(): BudgetState {
  return {
    activeBudgetId: "budget",
    members: [
      { id: "member-a", name: "Аня", role: "owner", active: true },
      { id: "member-b", name: "Борис", role: "member", active: true },
      { id: "member-c", name: "Вера", role: "member", active: false },
    ],
    accounts: [
      { id: "account", name: "Main", type: "current", currency: "RUB", openingBalanceMinor: 10_000_000, active: true },
    ],
    categories: [
      { id: "food", name: "Food", type: "expense", group: "Daily", active: true, sortOrder: 10 },
      { id: "salary", name: "Salary", type: "income", group: "Income", active: true, sortOrder: 20 },
    ],
    budgets: [{
      id: "budget",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      status: "open",
      plannedIncomeMinor: 10_000_000,
      warningThreshold: 0.8,
      lines: [{ id: "line", categoryId: "food", plannedMinor: 5_000_000 }],
    }],
    goals: [],
    annualCommitments: [],
    scheduledExpenses: [],
    transactions: [
      { id: "t-1", occurredOn: "2026-07-02", status: "posted", kind: "expense", amountMinor: 1_500_000, accountId: "account", categoryId: "food", memberId: "member-a" },
      { id: "t-2", occurredOn: "2026-07-03", status: "posted", kind: "expense", amountMinor: 900_000, accountId: "account", categoryId: "food", memberId: "member-b" },
      { id: "t-3", occurredOn: "2026-07-04", status: "posted", kind: "refund", amountMinor: 100_000, accountId: "account", categoryId: "food", originalTransactionId: "t-2", memberId: "member-b" },
      { id: "t-4", occurredOn: "2026-07-05", status: "posted", kind: "expense", amountMinor: 600_000, accountId: "account", categoryId: "food" },
      { id: "t-5", occurredOn: "2026-07-06", status: "pending", kind: "expense", amountMinor: 7_000_000, accountId: "account", categoryId: "food", memberId: "member-a" },
      { id: "t-6", occurredOn: "2026-08-01", status: "posted", kind: "expense", amountMinor: 8_000_000, accountId: "account", categoryId: "food", memberId: "member-a" },
      { id: "t-7", occurredOn: "2026-07-07", status: "posted", kind: "income", amountMinor: 9_000_000, accountId: "account", memberId: "member-b" },
    ],
  };
}

describe("calculateMemberExpenses", () => {
  it("splits the canonical G-002 July expenses between two members and the unlabelled rest", () => {
    const state = toDomainBudgetState(G002);
    const breakdown = calculateMemberExpenses(state);

    expect(state.members?.map((member) => member.id)).toEqual([G002_OWNER_ID, G002_PARTNER_ID]);
    expect(breakdown.budgetId).toBe(state.activeBudgetId);
    expect(breakdown.expensesMinor).toBe(7_100_000);
    expect(breakdown.attributedMinor).toBe(6_700_000);
    expect(breakdown.byMember[G002_OWNER_ID]).toEqual({
      memberId: G002_OWNER_ID,
      expenseMinor: 4_500_000,
      refundMinor: 0,
      actualMinor: 4_500_000,
      transactionCount: 1,
      share: 4_500_000 / 7_100_000,
    });
    expect(breakdown.byMember[G002_PARTNER_ID]?.actualMinor).toBe(2_200_000);
    expect(breakdown.byMember[G002_PARTNER_ID]?.transactionCount).toBe(1);
    // The 4 000 ₽ transport operation of 9 July carries no label and stays unattributed.
    expect(breakdown.unattributed).toEqual({
      expenseMinor: 400_000,
      refundMinor: 0,
      actualMinor: 400_000,
      transactionCount: 1,
      share: 400_000 / 7_100_000,
    });
    expect(breakdown.attributedMinor + breakdown.unattributed.actualMinor).toBe(
      calculateBudget(state).expensesMinor,
    );
    // Income carries a member too, and the expense breakdown must not see a kopeck of it.
    expect(breakdown.members.reduce((total, item) => total + item.expenseMinor, 0)).toBe(6_700_000);
  });

  it("leaves every canonical G-000, G-001 and G-002 figure untouched when the labels are removed", () => {
    for (const fixture of [G000, G001, G002]) {
      const labelled = toDomainBudgetState(fixture);
      const legacy = throughBackup(withoutMembers(labelled));

      expect(legacy.members).toBeUndefined();
      expect(legacy.transactions.some((transaction) => transaction.memberId !== undefined)).toBe(false);
      expect(calculateBudget(legacy)).toEqual(calculateBudget(labelled));
      expect(calculateAnnualPlan(legacy, "2026-07", 24)).toEqual(
        calculateAnnualPlan(labelled, "2026-07", 24),
      );
    }

    const canonical = calculateBudget(toDomainBudgetState(G000));
    expect(canonical.incomeMinor).toBe(10_000_000);
    expect(canonical.expensesMinor).toBe(7_650_000);
    expect(canonical.capitalMinor).toBe(2_350_000);

    const july = calculateAnnualPlan(toDomainBudgetState(G002), "2026-07", 24).currentMonth;
    expect(july.annualReserveMinor).toBe(1_980_900);
    expect(july.spendableAfterPlanMinor).toBe(4_419_100);
  });

  it("restores a backup written before members existed and reports everything as unattributed", () => {
    const legacy = throughBackup(withoutMembers(toDomainBudgetState(G002)));
    const breakdown = calculateMemberExpenses(legacy);

    expect(breakdown.members).toEqual([]);
    expect(breakdown.byMember).toEqual({});
    expect(breakdown.attributedMinor).toBe(0);
    expect(breakdown.expensesMinor).toBe(7_100_000);
    expect(breakdown.unattributed).toEqual({
      expenseMinor: 7_100_000,
      refundMinor: 0,
      actualMinor: 7_100_000,
      transactionCount: 3,
      share: 1,
    });
  });

  it("counts posted expenses and refunds only, and keeps a declared member without spending", () => {
    const state = makeMemberBudget();
    const breakdown = calculateMemberExpenses(state);

    expect(breakdown.expensesMinor).toBe(2_900_000);
    expect(breakdown.members.map((item) => item.memberId)).toEqual(["member-a", "member-b", "member-c"]);
    expect(breakdown.byMember["member-a"]).toMatchObject({ expenseMinor: 1_500_000, refundMinor: 0, actualMinor: 1_500_000, transactionCount: 1 });
    expect(breakdown.byMember["member-b"]).toMatchObject({ expenseMinor: 900_000, refundMinor: 100_000, actualMinor: 800_000, transactionCount: 2 });
    // Archived participants keep their history: the metric never hides spent money.
    expect(breakdown.byMember["member-c"]).toMatchObject({ actualMinor: 0, transactionCount: 0, share: 0 });
    expect(breakdown.attributedMinor).toBe(2_300_000);
    expect(breakdown.unattributed).toMatchObject({ actualMinor: 600_000, transactionCount: 1 });
    expect(breakdown.attributedMinor + breakdown.unattributed.actualMinor).toBe(breakdown.expensesMinor);
    expect(breakdown.expensesMinor).toBe(calculateBudget(state).expensesMinor);
  });

  it("does not move a kopeck of the budget metrics when labels are added or changed", () => {
    const labelled = makeMemberBudget();
    const plain = withoutMembers(labelled);
    const relabelled: BudgetState = {
      ...labelled,
      members: [
        { id: "member-a", name: "Анна Ивановна", role: "member", active: false },
        { id: "member-b", name: "Борис", role: "owner", active: true },
        { id: "member-c", name: "Вера", role: "member", active: false },
      ],
      transactions: labelled.transactions.map((transaction) => ({ ...transaction, memberId: "member-b" })),
    };

    expect(calculateBudget(labelled)).toEqual(calculateBudget(plain));
    expect(calculateBudget(relabelled)).toEqual(calculateBudget(plain));
    expect(calculateAnnualPlan(relabelled, "2026-07", 12)).toEqual(calculateAnnualPlan(plain, "2026-07", 12));
    expect(calculateMemberExpenses(relabelled).byMember["member-b"]?.actualMinor).toBe(2_900_000);
    expect(calculateMemberExpenses(relabelled).unattributed.actualMinor).toBe(0);
  });

  it("keeps an excess refund negative and reports no share when nothing net was spent", () => {
    const base = makeMemberBudget();
    const state: BudgetState = {
      ...base,
      transactions: [
        { id: "t-1", occurredOn: "2026-07-02", status: "posted", kind: "expense", amountMinor: 1_000_000, accountId: "account", categoryId: "food", memberId: "member-a" },
        { id: "t-2", occurredOn: "2026-07-03", status: "posted", kind: "refund", amountMinor: 1_000_000, accountId: "account", categoryId: "food", originalTransactionId: "t-1", memberId: "member-b" },
      ],
    };
    const breakdown = calculateMemberExpenses(state);

    expect(breakdown.expensesMinor).toBe(0);
    expect(breakdown.byMember["member-a"]).toEqual({ memberId: "member-a", expenseMinor: 1_000_000, refundMinor: 0, actualMinor: 1_000_000, transactionCount: 1, share: null });
    expect(breakdown.byMember["member-b"]).toEqual({ memberId: "member-b", expenseMinor: 0, refundMinor: 1_000_000, actualMinor: -1_000_000, transactionCount: 1, share: null });
    expect(breakdown.attributedMinor).toBe(0);
    expect(breakdown.unattributed.share).toBeNull();
  });

  it("rejects an unknown member, a duplicate member and an invalid role", () => {
    const base = makeMemberBudget();

    expect(() => calculateMemberExpenses({
      ...base,
      transactions: [{ id: "t-1", occurredOn: "2026-07-02", status: "posted", kind: "expense", amountMinor: 1_000, accountId: "account", categoryId: "food", memberId: "ghost" }],
    })).toThrow(/transaction t-1 memberId references unknown id ghost/);

    expect(() => calculateMemberExpenses({
      ...base,
      members: [...(base.members ?? []), { id: "member-a", name: "Двойник", role: "member", active: true }],
    })).toThrow(/members contains duplicate id member-a/);

    expect(() => calculateMemberExpenses({
      ...base,
      members: [{ id: "member-a", name: "Аня", role: "admin" as unknown as "owner", active: true }],
    })).toThrow(/member member-a role has unknown value admin/);

    expect(() => calculateMemberExpenses({
      ...base,
      members: [{ id: "member-a", name: 7 as unknown as string, role: "owner", active: true }],
    })).toThrow(/member member-a name must be a string/);

    expect(() => calculateMemberExpenses(base, "missing")).toThrow(/calculateMemberExpenses references unknown id missing/);
  });

  it("checks the label on every transaction, not only on the ones this budget counts", () => {
    const base = makeMemberBudget();
    // A transfer and a goal contribution need a second account, so the state carries one.
    const withOperation = (transaction: Transaction): BudgetState => ({
      ...base,
      accounts: [
        ...base.accounts,
        { id: "savings", name: "Savings", type: "savings", currency: "RUB", openingBalanceMinor: 0, active: true },
      ],
      goals: [{ id: "goal", name: "Подушка", linkedAccountId: "savings", targetMinor: 5_000_000, openingContributedMinor: 0, plannedContributionMinor: 0, status: "active" }],
      transactions: [...base.transactions, transaction],
    });
    // None of these five is a posted expense or refund inside July, so none of them moves a
    // kopeck of the breakdown — and every one of them still has to have its label checked.
    const unseen: readonly Transaction[] = [
      { id: "t-8", occurredOn: "2026-07-08", status: "posted", kind: "income", amountMinor: 1_000, accountId: "account", memberId: "ghost" },
      { id: "t-8", occurredOn: "2026-07-08", status: "posted", kind: "transfer", amountMinor: 1_000, fromAccountId: "account", toAccountId: "savings", memberId: "ghost" },
      { id: "t-8", occurredOn: "2026-07-08", status: "posted", kind: "goal_contribution", amountMinor: 1_000, fromAccountId: "account", toAccountId: "savings", goalId: "goal", memberId: "ghost" },
      { id: "t-8", occurredOn: "2026-07-08", status: "draft", kind: "expense", amountMinor: 1_000, accountId: "account", categoryId: "food", memberId: "ghost" },
      { id: "t-8", occurredOn: "2026-09-08", status: "posted", kind: "expense", amountMinor: 1_000, accountId: "account", categoryId: "food", memberId: "ghost" },
    ];

    for (const transaction of unseen) {
      const state = withOperation(transaction);
      expect(() => calculateBudget(state)).not.toThrow();
      expect(() => calculateMemberExpenses(state)).toThrow(/transaction t-8 memberId references unknown id ghost/);
      // The same operation with a declared label is accepted and still changes nothing.
      const { memberId: _ghost, ...plain } = transaction;
      const labelled = withOperation({ ...transaction, memberId: "member-a" } as Transaction);
      expect(calculateMemberExpenses(labelled)).toEqual(calculateMemberExpenses(withOperation(plain as Transaction)));
    }

    expect(() => calculateMemberExpenses(withOperation({
      id: "t-8", occurredOn: "2026-07-08", status: "pending", kind: "expense", amountMinor: 1_000, accountId: "account", categoryId: "food", memberId: "   ",
    }))).toThrow(/transaction t-8 memberId must have a non-empty stable id/);
  });

  it("rejects the transaction references the main calculation rejects, instead of measuring them", () => {
    const base = makeMemberBudget();
    const broken: BudgetState = {
      ...base,
      transactions: [
        { id: "t-1", occurredOn: "2026-07-02", status: "posted", kind: "expense", amountMinor: 1_000_000, accountId: "ghost-account", categoryId: "food", memberId: "member-a" },
      ],
    };
    const income: BudgetState = {
      ...base,
      transactions: [
        { id: "t-1", occurredOn: "2026-07-02", status: "posted", kind: "expense", amountMinor: 1_000_000, accountId: "account", categoryId: "salary", memberId: "member-a" },
      ],
    };

    expect(() => calculateBudget(broken)).toThrow(/transaction t-1 references unknown id ghost-account/);
    expect(() => calculateMemberExpenses(broken)).toThrow(/transaction t-1 references unknown id ghost-account/);
    expect(() => calculateBudget(income)).toThrow(/transaction t-1 must reference an expense category/);
    expect(() => calculateMemberExpenses(income)).toThrow(/transaction t-1 must reference an expense category/);
  });

  it("reports no share when the window ends below zero, not only when it ends at zero", () => {
    const base = makeMemberBudget();
    // The expense is posted in June, outside the July window; only its refund lands inside,
    // so the net expense of the budget is negative rather than merely zero.
    const state: BudgetState = {
      ...base,
      transactions: [
        { id: "t-1", occurredOn: "2026-06-30", status: "posted", kind: "expense", amountMinor: 1_000_000, accountId: "account", categoryId: "food", memberId: "member-a" },
        { id: "t-2", occurredOn: "2026-07-03", status: "posted", kind: "refund", amountMinor: 1_000_000, accountId: "account", categoryId: "food", originalTransactionId: "t-1", memberId: "member-b" },
      ],
    };
    const breakdown = calculateMemberExpenses(state);

    expect(breakdown.expensesMinor).toBe(-1_000_000);
    expect(breakdown.expensesMinor).toBe(calculateBudget(state).expensesMinor);
    expect(breakdown.byMember["member-a"]).toEqual({ memberId: "member-a", expenseMinor: 0, refundMinor: 0, actualMinor: 0, transactionCount: 0, share: null });
    expect(breakdown.byMember["member-b"]).toEqual({ memberId: "member-b", expenseMinor: 0, refundMinor: 1_000_000, actualMinor: -1_000_000, transactionCount: 1, share: null });
    expect(breakdown.unattributed.share).toBeNull();
    expect(breakdown.members.every((item) => item.share === null)).toBe(true);
  });

  it("keeps special member IDs as own keys on a null-prototype record", () => {
    const base = makeMemberBudget();
    const breakdown = calculateMemberExpenses({
      ...base,
      members: [
        { id: "__proto__", name: "Аня", role: "owner", active: true },
        { id: "constructor", name: "Борис", role: "member", active: true },
      ],
      transactions: [
        { id: "t-1", occurredOn: "2026-07-02", status: "posted", kind: "expense", amountMinor: 1_200_000, accountId: "account", categoryId: "food", memberId: "__proto__" },
        { id: "t-2", occurredOn: "2026-07-03", status: "posted", kind: "expense", amountMinor: 800_000, accountId: "account", categoryId: "food", memberId: "constructor" },
      ],
    });

    expect(Object.getPrototypeOf(breakdown.byMember)).toBeNull();
    expect(Object.keys(breakdown.byMember)).toEqual(["__proto__", "constructor"]);
    expect(breakdown.byMember["__proto__"]?.actualMinor).toBe(1_200_000);
    expect(breakdown.byMember["constructor"]?.actualMinor).toBe(800_000);
  });
});
