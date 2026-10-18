import { describe, expect, it } from "vitest";
import { G000, G001, G002, toDomainBudgetState } from "@family-budget/test-fixtures";

import {
  calculateAnnualPlan,
  calculateBudget,
  calculateMemberExpenses,
  HOUSEHOLD_ID,
  makePlanningSeed,
  MAX_LOCAL_DATE,
  MAX_MONEY_MINOR,
  MAX_SORT_ORDER,
  MIN_LOCAL_DATE,
  makeSeedBudget,
  normalizeScheduledDueDate,
  PLANNING_IDS,
  SEED_IDS,
  type Account,
  type BudgetState,
  type Category,
  type ExchangeRate,
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

const TAG_HOLIDAY = "8a000000-0000-4000-8000-0000000000a1";
const TAG_HOME = "8a000000-0000-4000-8000-0000000000a2";
const TAG_OLD = "8a000000-0000-4000-8000-0000000000a3";

/** Every new optional field at once: display fields, tags, notes. None of them is money. */
function withEverythingLabelled(state: BudgetState): BudgetState {
  return {
    ...state,
    tags: [
      { id: TAG_HOLIDAY, name: "Отпуск", active: true },
      { id: TAG_HOME, name: "Дом", active: true },
      { id: TAG_OLD, name: "Старое", active: false },
    ],
    accounts: state.accounts.map((account, index) => ({
      ...account,
      sortOrder: (index + 1) * 10,
      icon: "banknote",
      color: "sage",
      includeInTotal: index === 0,
    })),
    categories: state.categories.map((category) => ({ ...category, icon: "shopping-basket", color: "mint" })),
    goals: state.goals.map((goal) => ({ ...goal, deadline: "2027-06-01", icon: "plane" })),
    transactions: state.transactions.map((transaction, index) => ({
      ...transaction,
      note: `Заметка ${index + 1}`,
      tagIds: index % 2 === 0 ? [TAG_HOLIDAY, TAG_OLD] : [TAG_HOME],
    })),
  };
}

function withTransaction(state: BudgetState, change: (transaction: Transaction) => Transaction): BudgetState {
  const labelled = withEverythingLabelled(state);
  return { ...labelled, transactions: [change(labelled.transactions[0]!), ...labelled.transactions.slice(1)] };
}

describe("labels and display fields", () => {
  it("leave every canonical G-000, G-001 and G-002 figure exactly where it was", () => {
    for (const fixture of [G000, G001, G002]) {
      const plain = toDomainBudgetState(fixture) as BudgetState;
      const labelled = withEverythingLabelled(plain);
      expect(calculateBudget(labelled), fixture.fixtureId).toEqual(calculateBudget(plain));
      expect(calculateMemberExpenses(labelled), fixture.fixtureId).toEqual(calculateMemberExpenses(plain));
    }
    const g002 = toDomainBudgetState(G002) as BudgetState;
    expect(calculateAnnualPlan(withEverythingLabelled(g002), G002.startMonth, 24))
      .toEqual(calculateAnnualPlan(g002, G002.startMonth, 24));
  });

  it("does not let includeInTotal touch capital", () => {
    const seed = makeSeedBudget();
    const excluded: BudgetState = { ...seed, accounts: seed.accounts.map((account) => ({ ...account, includeInTotal: false })) };
    expect(calculateBudget(excluded).capitalMinor).toBe(calculateBudget(seed).capitalMinor);
  });

  it("accepts an archived tag on an operation, as an archived category is accepted", () => {
    const state = withTransaction(makeSeedBudget(), (transaction) => ({ ...transaction, tagIds: [TAG_OLD] }));
    expect(() => calculateBudget(state)).not.toThrow();
  });

  it("refuses a dangling tag, a repeated one, an empty list and more than ten, on every operation", () => {
    const seed = makeSeedBudget();
    const tagged = (tagIds: readonly string[]) => withTransaction(seed, (transaction) => ({ ...transaction, tagIds }));
    const many = Array.from({ length: 11 }, (_, index) => `8a000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`);
    const manyTags: BudgetState = {
      ...tagged(many),
      tags: [...(withEverythingLabelled(seed).tags ?? []), ...many.map((id, index) => ({ id, name: `Метка ${index}`, active: true }))],
    };
    const firstId = seed.transactions[0]!.id;

    expect(() => calculateBudget(tagged(["8a000000-0000-4000-8000-0000000000ff"])))
      .toThrow(new RegExp(`transaction ${firstId} tagIds references unknown id`));
    expect(() => calculateBudget(tagged([TAG_HOME, TAG_HOME]))).toThrow(/tagIds repeats tag/);
    expect(() => calculateBudget(tagged([]))).toThrow(/tagIds must list from 1 to 10 tags/);
    expect(() => calculateBudget(manyTags)).toThrow(/tagIds must list from 1 to 10 tags/);
    expect(() => calculateBudget({ ...manyTags, transactions: [{ ...manyTags.transactions[0]!, tagIds: many.slice(0, 10) }, ...manyTags.transactions.slice(1)] }))
      .not.toThrow();
    // Checked on a draft outside the window too, by the plan and the split as much as the budget.
    const draft: Transaction = { ...seed.transactions[1]!, id: "55555555-5555-4555-8555-5555555555ff", status: "draft", occurredOn: "2027-01-01", tagIds: ["8a000000-0000-4000-8000-0000000000ff"] };
    const withDraft: BudgetState = { ...withEverythingLabelled(seed), transactions: [...withEverythingLabelled(seed).transactions, draft] };
    expect(() => calculateBudget(withDraft)).toThrow(/tagIds references unknown id/);
    expect(() => calculateAnnualPlan(withDraft, "2026-07", 12)).toThrow(/tagIds references unknown id/);
    expect(() => calculateMemberExpenses(withDraft)).toThrow(/tagIds references unknown id/);
  });

  it("refuses a note that is not stored the way normalizeNote stores one", () => {
    const seed = makeSeedBudget();
    for (const note of ["", " Пятёрочка", "Пятёрочка\nу дома", "Пятёрочка\u202e", "я".repeat(501)]) {
      const state = withTransaction(seed, (transaction) => ({ ...transaction, note }));
      expect(() => calculateBudget(state), JSON.stringify(note)).toThrow(/note must be one trimmed line of stored text of at most 500 characters/);
    }
  });

  it("refuses a recurring-rule label while no recurring rule can exist", () => {
    const state = withTransaction(makeSeedBudget(), (transaction) => ({ ...transaction, recurringRuleId: "8b000000-0000-4000-8000-000000000001" }));
    expect(() => calculateBudget(state)).toThrow(/recurringRuleId references unknown id 8b000000-0000-4000-8000-000000000001/);
  });

  it("refuses a tag with a malformed name, a non-boolean flag or a repeated identifier", () => {
    const seed = withEverythingLabelled(makeSeedBudget());
    const withTags = (tags: unknown): BudgetState => ({ ...seed, tags } as BudgetState);
    expect(() => calculateBudget(withTags([{ id: TAG_HOLIDAY, name: " Отпуск", active: true }])))
      .toThrow(new RegExp(`tag ${TAG_HOLIDAY} name must be stored text`));
    expect(() => calculateBudget(withTags([{ id: TAG_HOLIDAY, name: "я".repeat(41), active: true }])))
      .toThrow(/name must be stored text of at most 40 characters/);
    expect(() => calculateBudget(withTags([{ id: TAG_HOLIDAY, name: "Отпуск", active: "yes" }])))
      .toThrow(/active must be a boolean/);
    expect(() => calculateBudget({ ...seed, tags: [...(seed.tags ?? []), seed.tags![0]!] }))
      .toThrow(/tags contains duplicate id/);
  });

  it("refuses a display key that is not a design token and a sort order that is not an integer", () => {
    const seed = makeSeedBudget();
    const account = (change: Record<string, unknown>): BudgetState => ({
      ...seed,
      accounts: [{ ...seed.accounts[0]!, ...change } as BudgetState["accounts"][number], ...seed.accounts.slice(1)],
    });
    expect(() => calculateBudget(account({ icon: "#00ff00" }))).toThrow(/account .* icon must be a display key/);
    expect(() => calculateBudget(account({ color: "Sage" }))).toThrow(/account .* color must be a display key/);
    expect(() => calculateBudget(account({ sortOrder: 1.5 }))).toThrow(/account .* sortOrder must be an integer/);
    expect(() => calculateBudget(account({ includeInTotal: "no" }))).toThrow(/includeInTotal must be a boolean/);
    expect(() => calculateAnnualPlan(account({ icon: "icon.svg" }), "2026-07", 12)).toThrow(/icon must be a display key/);
    expect(() => calculateBudget({ ...seed, categories: [{ ...seed.categories[0]!, color: "" }, ...seed.categories.slice(1)] }))
      .toThrow(/category .* color must be a display key/);
    expect(() => calculateBudget({ ...seed, goals: [{ ...seed.goals[0]!, icon: "Plane" }] }))
      .toThrow(/goal .* icon must be a display key/);
    expect(() => calculateBudget({ ...seed, goals: [{ ...seed.goals[0]!, deadline: "2027-02-29" }] }))
      .toThrow(/goal .* deadline must be a valid calendar date/);
  });
});

const USD_ACCOUNT = "8c000000-0000-4000-8000-0000000000a2";
const RATE_JULY = "8e000000-0000-4000-8000-000000000001";
const RATE_AUGUST = "8e000000-0000-4000-8000-000000000002";
const USD_EXPENSE = "8d000000-0000-4000-8000-000000000003";
const USD_REFUND = "8d000000-0000-4000-8000-000000000004";

const USD_RATES: readonly ExchangeRate[] = [
  { id: RATE_JULY, currency: "USD", baseCurrency: "RUB", date: "2026-06-30", rate: { baseMinor: 9_000, quoteMinor: 100 } },
  { id: RATE_AUGUST, currency: "USD", baseCurrency: "RUB", date: "2026-07-15", rate: { baseMinor: 9_250, quoteMinor: 100 } },
];

/**
 * The seed with a dollar account beside the rouble ones: 500,00 $ opening, a 40,00 $ purchase of
 * food worth 3 600 ₽ that day and a 10,00 $ refund of it worth 900 ₽ — the shape of G-003.
 */
function withDollars(state: BudgetState = makeSeedBudget(), foodId: string = SEED_IDS.categories.food): BudgetState {
  const usd: Account = { id: USD_ACCOUNT, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true };
  const snapshot = (baseAmountMinor: number) => ({ baseAmountMinor, baseCurrency: "RUB", rate: { baseMinor: 9_000, quoteMinor: 100 } });
  return {
    ...state,
    exchangeRates: USD_RATES,
    accounts: [...state.accounts, usd],
    transactions: [
      ...state.transactions,
      { id: USD_EXPENSE, occurredOn: "2026-07-10", status: "posted", kind: "expense", amountMinor: 4_000, accountId: USD_ACCOUNT, categoryId: foodId, ...snapshot(360_000) },
      { id: USD_REFUND, occurredOn: "2026-07-12", status: "posted", kind: "refund", amountMinor: 1_000, accountId: USD_ACCOUNT, categoryId: foodId, originalTransactionId: USD_EXPENSE, ...snapshot(90_000) },
    ],
  };
}

function replaceTransaction(state: BudgetState, id: string, change: (transaction: Transaction) => Transaction): BudgetState {
  return { ...state, transactions: state.transactions.map((item) => (item.id === id ? change(item) : item)) };
}

function withoutSnapshot(transaction: Transaction): Transaction {
  if (transaction.kind !== "income" && transaction.kind !== "expense" && transaction.kind !== "refund") return transaction;
  const { baseAmountMinor: _amount, baseCurrency: _currency, rate: _rate, ...plain } = transaction;
  return plain;
}

describe("several currencies", () => {
  it("counts a foreign operation in the budget by its snapshot and on its account by its amount", () => {
    const seed = calculateBudget(makeSeedBudget());
    const metrics = calculateBudget(withDollars());
    const food = metrics.categoryMetrics[SEED_IDS.categories.food]!;

    expect(metrics.grossExpensesMinor).toBe(seed.grossExpensesMinor + 360_000);
    expect(metrics.refundsMinor).toBe(seed.refundsMinor + 90_000);
    expect(metrics.expensesMinor).toBe(seed.expensesMinor + 270_000);
    expect(food.expenseMinor).toBe(3_150_000 + 360_000);
    expect(food.refundMinor).toBe(90_000);
    expect(food.actualMinor).toBe(3_150_000 + 270_000);
    // The account moves in dollars: 500 − 40 + 10.
    expect(metrics.accountBalancesMinor[USD_ACCOUNT]).toBe(47_000);
  });

  it("leaves capital to the accounts in the base currency", () => {
    const seed = calculateBudget(makeSeedBudget());
    const metrics = calculateBudget(withDollars());
    expect(metrics.capitalMinor).toBe(seed.capitalMinor);
    // Mixing the units would have added 470 dollars to the roubles as 470 kopecks.
    expect(metrics.capitalMinor).not.toBe(seed.capitalMinor + 47_000);
  });

  it("does not let a new rate revalue an operation of the past", () => {
    const state = withDollars();
    const revalued: BudgetState = {
      ...state,
      exchangeRates: state.exchangeRates!.map((rate) => ({ ...rate, rate: { baseMinor: 9_500, quoteMinor: 100 } })),
    };
    expect(calculateBudget(revalued)).toEqual(calculateBudget(state));
    expect(calculateMemberExpenses(revalued)).toEqual(calculateMemberExpenses(state));
    expect(calculateBudget({ ...state, exchangeRates: [] })).toEqual(calculateBudget(state));
  });

  it("refuses a foreign operation without a snapshot, with part of one, or with one in another base", () => {
    const state = withDollars();
    expect(() => calculateBudget(replaceTransaction(state, USD_EXPENSE, withoutSnapshot)))
      .toThrow(new RegExp(`transaction ${USD_EXPENSE} on an account in USD must carry baseAmountMinor, baseCurrency and rate together`));
    expect(() => calculateBudget(replaceTransaction(state, USD_EXPENSE, (item) => {
      const { rate: _rate, ...partial } = item as Extract<Transaction, { kind: "expense" }>;
      return partial;
    }))).toThrow(/must carry baseAmountMinor, baseCurrency and rate together/);
    expect(() => calculateBudget(replaceTransaction(state, USD_EXPENSE, (item) => ({ ...item, baseCurrency: "EUR" }))))
      .toThrow(/snapshot must be in the base currency RUB/);
    expect(() => calculateBudget(replaceTransaction(state, USD_EXPENSE, (item) => ({ ...item, baseAmountMinor: 0 }))))
      .toThrow(/baseAmountMinor must be greater than zero/);
    expect(() => calculateBudget(replaceTransaction(state, USD_EXPENSE, (item) => ({ ...item, rate: { baseMinor: 0, quoteMinor: 100 } }))))
      .toThrow(/rate parts must be integers from 1 to 1000000000000/);
    // A draft outside the window is held to it as well, by every calculation.
    const draft = replaceTransaction(state, USD_REFUND, (item) => ({ ...withoutSnapshot(item), status: "draft", occurredOn: "2027-01-01" }));
    expect(() => calculateBudget(draft)).toThrow(/must carry baseAmountMinor/);
    expect(() => calculateMemberExpenses(draft)).toThrow(/must carry baseAmountMinor/);
    expect(() => calculateAnnualPlan(draft, "2026-07", 12)).toThrow(/must carry baseAmountMinor/);
  });

  it("refuses a snapshot on an operation in the base currency", () => {
    const seed = makeSeedBudget();
    const doubled = replaceTransaction(seed, SEED_IDS.transactions.food, (item) => ({
      ...item, baseAmountMinor: 3_150_000, baseCurrency: "RUB", rate: { baseMinor: 1, quoteMinor: 1 },
    }));
    expect(() => calculateBudget(doubled))
      .toThrow(new RegExp(`transaction ${SEED_IDS.transactions.food} is in the base currency and must not carry a base-currency snapshot`));
  });

  it("asks a transfer between two currencies for the amount that arrived, and only then", () => {
    const state = withDollars();
    const transfer: Transaction = {
      id: "8d000000-0000-4000-8000-000000000006", occurredOn: "2026-07-05", status: "posted", kind: "transfer",
      amountMinor: 1_800_000, fromAccountId: SEED_IDS.accounts.main, toAccountId: USD_ACCOUNT, toAmountMinor: 20_000,
    };
    const metrics = calculateBudget({ ...state, transactions: [...state.transactions, transfer] });
    expect(metrics.accountBalancesMinor[USD_ACCOUNT]).toBe(47_000 + 20_000);
    expect(metrics.accountBalancesMinor[SEED_IDS.accounts.main]).toBe(calculateBudget(state).accountBalancesMinor[SEED_IDS.accounts.main]! - 1_800_000);
    // A transfer is not income or expense in any currency.
    expect(metrics.expensesMinor).toBe(calculateBudget(state).expensesMinor);

    const { toAmountMinor: _arrived, ...missing } = transfer;
    expect(() => calculateBudget({ ...state, transactions: [...state.transactions, missing] }))
      .toThrow(/moves from RUB to USD and must carry toAmountMinor/);
    const inRoubles: Transaction = { ...transfer, toAccountId: SEED_IDS.accounts.savings };
    expect(() => calculateBudget({ ...state, transactions: [...state.transactions, inRoubles] }))
      .toThrow(/moves within one currency and must not carry toAmountMinor/);
    expect(() => calculateBudget({ ...state, transactions: [...state.transactions, { ...transfer, toAmountMinor: -1 }] }))
      .toThrow(/toAmountMinor must be greater than zero/);
  });

  it("keeps a goal contribution inside one currency", () => {
    const state = withDollars();
    const contribution = replaceTransaction(state, SEED_IDS.transactions.goal, (item) => ({ ...item, fromAccountId: USD_ACCOUNT }));
    expect(() => calculateBudget(contribution)).toThrow(/must move between two accounts in one currency/);
  });

  it("keeps goals, large payments and schedules on accounts in the base currency", () => {
    const state = withDollars(makePlanningSeed(), PLANNING_IDS.categories.food);
    expect(() => calculateAnnualPlan(state, "2026-07", 12)).not.toThrow();
    const goal: BudgetState = { ...state, goals: state.goals.map((item) => ({ ...item, linkedAccountId: USD_ACCOUNT })) };
    expect(() => calculateBudget(goal)).toThrow(/goal .* must use an account in the base currency RUB/);
    expect(() => calculateAnnualPlan(goal, "2026-07", 12)).toThrow(/goal .* must use an account in the base currency RUB/);
    const commitment: BudgetState = {
      ...state,
      annualCommitments: state.annualCommitments.map((item, index) => (index === 0 ? { ...item, accountId: USD_ACCOUNT } : item)),
    };
    expect(() => calculateAnnualPlan(commitment, "2026-07", 12)).toThrow(/annual commitment .* must use an account in the base currency RUB/);
    const schedule: BudgetState = {
      ...state,
      scheduledExpenses: state.scheduledExpenses.map((item, index) => (index === 0 ? { ...item, accountId: USD_ACCOUNT } : item)),
    };
    expect(() => calculateAnnualPlan(schedule, "2026-07", 12)).toThrow(/scheduled expense .* must use an account in the base currency RUB/);
    // The budget itself does not read plans, and its errors stay what they were.
    expect(() => calculateBudget(commitment)).not.toThrow();
  });

  it("splits foreign expenses by participant in the base currency, and the split still adds up", () => {
    const state = withDollars();
    const member = "8f000000-0000-4000-8000-000000000001";
    const attributed: BudgetState = {
      ...replaceTransaction(state, USD_EXPENSE, (item) => ({ ...item, memberId: member })),
      members: [{ id: member, name: "Анна", role: "owner", active: true }],
    };
    const split = calculateMemberExpenses(attributed);
    expect(split.byMember[member]?.expenseMinor).toBe(360_000);
    expect(split.attributedMinor + split.unattributed.actualMinor).toBe(split.expensesMinor);
    expect(split.expensesMinor).toBe(calculateBudget(attributed).expensesMinor);
  });

  it("counts everything in the household's base currency when it names one", () => {
    const state = withDollars();
    const inDollars: BudgetState = { ...state, household: { id: HOUSEHOLD_ID, baseCurrency: "USD" } };
    // Now the rouble accounts are the foreign ones: the goal on one is a plan in another currency,
    // and their operations carry no snapshot.
    expect(() => calculateBudget(inDollars)).toThrow(/goal .* must use an account in the base currency USD/);
    expect(() => calculateMemberExpenses(inDollars)).toThrow(/on an account in RUB must carry baseAmountMinor/);
    expect(() => calculateBudget({ ...state, household: { id: HOUSEHOLD_ID, baseCurrency: "RUB" } })).not.toThrow();
    expect(calculateBudget({ ...state, household: { id: HOUSEHOLD_ID, baseCurrency: "RUB" } })).toEqual(calculateBudget(state));
  });

  it("refuses a household under another identifier or in a currency it does not know", () => {
    const seed = makeSeedBudget();
    expect(() => calculateBudget({ ...seed, household: { id: "8f000000-0000-4000-8000-0000000000ff", baseCurrency: "RUB" } }))
      .toThrow(new RegExp(`household id must be ${HOUSEHOLD_ID}`));
    expect(() => calculateMemberExpenses({ ...seed, household: { id: HOUSEHOLD_ID, baseCurrency: "XYZ" } }))
      .toThrow(/household baseCurrency has unknown value XYZ/);
  });

  it("refuses an account in a currency it does not know", () => {
    const seed = makeSeedBudget();
    const unknown: BudgetState = { ...seed, accounts: seed.accounts.map((item, index) => (index === 1 ? { ...item, currency: "XYZ" } : item)) };
    expect(() => calculateBudget(unknown)).toThrow(/account .* currency has unknown value XYZ/);
    expect(() => calculateBudget({ ...seed, accounts: seed.accounts.map((item) => ({ ...item, currency: "rub" })) }))
      .toThrow(/currency has unknown value rub/);
  });

  it("refuses an exchange rate that values a currency in itself, in nothing, or by a part it does not store", () => {
    const state = withDollars();
    const withRate = (change: Partial<ExchangeRate>): BudgetState => ({ ...state, exchangeRates: [{ ...USD_RATES[0]!, ...change }] });
    expect(() => calculateBudget(withRate({ currency: "RUB" }))).toThrow(/must value one currency in another/);
    expect(() => calculateBudget(withRate({ currency: "XYZ" }))).toThrow(/exchange rate .* currency has unknown value XYZ/);
    expect(() => calculateBudget(withRate({ baseCurrency: "rub" }))).toThrow(/baseCurrency has unknown value rub/);
    expect(() => calculateBudget(withRate({ date: "2026-02-30" }))).toThrow(/exchange rate .* date must be a valid calendar date/);
    expect(() => calculateBudget(withRate({ rate: { baseMinor: 9_000, quoteMinor: 10 ** 12 + 1 } }))).toThrow(/rate parts must be integers/);
    expect(() => calculateBudget({ ...state, exchangeRates: [USD_RATES[0]!, USD_RATES[0]!] })).toThrow(/exchangeRates contains duplicate id/);
    // A rate against another base is kept and simply never chosen.
    expect(() => calculateBudget(withRate({ baseCurrency: "EUR" }))).not.toThrow();
  });
});

describe("bounds shared with the journal", () => {
  it("holds the new fields to the window and the ceilings the codec carries, and no further", () => {
    const seed = makeSeedBudget();
    const account = (sortOrder: number): BudgetState => ({
      ...seed,
      accounts: [{ ...seed.accounts[0]!, sortOrder }, ...seed.accounts.slice(1)],
    });
    expect(() => calculateBudget(account(MAX_SORT_ORDER))).not.toThrow();
    expect(() => calculateBudget(account(-MAX_SORT_ORDER))).not.toThrow();
    expect(() => calculateBudget(account(MAX_SORT_ORDER + 1))).toThrow(/sortOrder must be from -1000000 to 1000000/);
    expect(() => calculateBudget(account(-MAX_SORT_ORDER - 1))).toThrow(/sortOrder must be from -1000000 to 1000000/);

    const deadline = (value: string): BudgetState => ({ ...seed, goals: [{ ...seed.goals[0]!, deadline: value }] });
    expect(() => calculateBudget(deadline(MIN_LOCAL_DATE))).not.toThrow();
    expect(() => calculateBudget(deadline(MAX_LOCAL_DATE))).not.toThrow();
    expect(() => calculateBudget(deadline("2200-01-01"))).toThrow(/deadline must be from 1900-01-01 to 2199-12-31/);
    expect(() => calculateBudget(deadline("1899-12-31"))).toThrow(/deadline must be from 1900-01-01 to 2199-12-31/);

    const state = withDollars();
    const rateOn = (date: string): BudgetState => ({ ...state, exchangeRates: [{ ...USD_RATES[0]!, date }] });
    expect(() => calculateBudget(rateOn("2200-01-01"))).toThrow(/exchange rate .* date must be from 1900-01-01 to 2199-12-31/);
    expect(() => calculateBudget(replaceTransaction(state, USD_EXPENSE, (item) => ({ ...item, baseAmountMinor: MAX_MONEY_MINOR }))))
      .not.toThrow();
    expect(() => calculateBudget(replaceTransaction(state, USD_EXPENSE, (item) => ({ ...item, baseAmountMinor: MAX_MONEY_MINOR + 1 }))))
      .toThrow(/baseAmountMinor must be at most 10000000000/);
    const transfer: Transaction = {
      id: "8d000000-0000-4000-8000-000000000006", occurredOn: "2026-07-05", status: "posted", kind: "transfer",
      amountMinor: 1_800_000, fromAccountId: SEED_IDS.accounts.main, toAccountId: USD_ACCOUNT, toAmountMinor: MAX_MONEY_MINOR + 1,
    };
    expect(() => calculateBudget({ ...state, transactions: [...state.transactions, transfer] }))
      .toThrow(/toAmountMinor must be at most 10000000000/);
  });

  it("leaves the fields that existed before the window as they were, so an old document still opens", () => {
    // A 1.0.0 document may hold an operation dated outside the window and a category sorted past the
    // bound; the codec refuses them on the wire, the domain keeps reading them.
    const seed = makeSeedBudget();
    const old: BudgetState = {
      ...seed,
      categories: seed.categories.map((item, index) => (index === 0 ? { ...item, sortOrder: 2_000_000 } : item)),
      transactions: [...seed.transactions, { ...seed.transactions[2]!, id: "55555555-5555-4555-8555-5555555555aa", status: "draft", occurredOn: "2250-01-01" }],
    };
    expect(() => calculateBudget(old)).not.toThrow();
  });
});
