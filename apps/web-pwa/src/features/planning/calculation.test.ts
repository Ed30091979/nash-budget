import { calculateAnnualPlan, normalizeScheduledDueDate } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import { makeCanonicalPlanningState } from "./test-fixture";

describe("canonical long-horizon plan", () => {
  it("matches exact entities, July reserve, September seasonality and 12/24 overlap", () => {
    const state = makeCanonicalPlanningState();
    expect({ accounts: state.accounts.length, categories: state.categories.length, budgets: state.budgets.length, lines: state.budgets[0]?.lines.length, goals: state.goals.length, commitments: state.annualCommitments.length, schedules: state.scheduledExpenses.length, transactions: state.transactions.length }).toEqual({ accounts: 1, categories: 4, budgets: 1, lines: 3, goals: 0, commitments: 3, schedules: 3, transactions: 0 });
    expect(state.budgets[0]?.lines.reduce((sum, line) => sum + line.plannedMinor, 0)).toBe(5_300_000);
    const plan12 = calculateAnnualPlan(state, "2026-07", 12);
    const plan24 = calculateAnnualPlan(state, "2026-07", 24);
    expect(plan24.months.slice(0, 12)).toEqual(plan12.months);
    expect(plan12.months[0]).toMatchObject({ month: "2026-07", annualReserveMinor: 1_980_900, seasonalExpenseMinor: 0, spendableAfterPlanMinor: 5_419_100 });
    expect(plan12.months[2]).toMatchObject({ month: "2026-09", scheduledExpenseMinor: 8_400_000, seasonalExpenseMinor: 3_100_000, spendableAfterPlanMinor: 2_319_100 });
    expect(plan24.months.find((item) => item.month === "2027-01")?.annualDueMinor).toBe(7_200_000);
    expect(plan24.months.find((item) => item.month === "2028-01")?.annualDueMinor).toBe(7_200_000);
    expect(plan24.months.find((item) => item.month === "2027-06")?.annualDueMinor).toBe(9_000_000);
    expect(plan24.months.find((item) => item.month === "2028-06")?.annualDueMinor).toBe(0);
  });

  it("normalizes due day to month end for leap and non-leap calendars", () => {
    expect(normalizeScheduledDueDate("2024-02", 31)).toBe("2024-02-29");
    expect(normalizeScheduledDueDate("2025-02", 29)).toBe("2025-02-28");
    expect(normalizeScheduledDueDate("2026-04", 31)).toBe("2026-04-30");
    expect(normalizeScheduledDueDate("2026-12", 30)).toBe("2026-12-30");
  });
});
