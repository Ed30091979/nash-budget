import { describe, expect, it } from "vitest";

import {
  calculateAnnualPlan,
  calculateBudget,
  HOUSEHOLD_ID,
  householdPaydays,
  isPaydayList,
  makePlanningSeed,
  makeSeedBudget,
  MAX_PAYDAYS,
  nextPaydayAfter,
  normalizePaydays,
  paydayDate,
  PaydayValidationError,
  setBaseCurrency,
  setHouseholdPaydays,
  type BudgetState,
} from "../src/index.js";

function refusal(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof PaydayValidationError) return error.code;
    throw error;
  }
}

/** The seed with nothing recorded and nothing planned, so the base currency may still change. */
function empty(): BudgetState {
  const seed = makeSeedBudget();
  return {
    ...seed,
    transactions: [],
    goals: [],
    budgets: seed.budgets.map((budget) => ({ ...budget, lines: [], plannedIncomeMinor: 0 })),
  };
}

describe("paydays: the stored rule", () => {
  it("accepts one to four distinct days 1…31 in ascending order — and nothing else", () => {
    expect(isPaydayList([5])).toBe(true);
    expect(isPaydayList([5, 20])).toBe(true);
    expect(isPaydayList([1, 10, 20, 31])).toBe(true);
    expect(MAX_PAYDAYS).toBe(4);
    for (const bad of [[], [1, 2, 3, 4, 5], [0], [32], [20, 5], [5, 5], [5.5], ["5"], [Number.NaN], null, undefined, "5", { 0: 5, length: 1 }]) {
      expect(isPaydayList(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("normalises a pick: repeats dropped, ascending; refuses empty, too many and out of range in words", () => {
    expect(normalizePaydays([20, 5, 20])).toEqual([5, 20]);
    expect(refusal(() => normalizePaydays([]))).toBe("empty");
    expect(refusal(() => normalizePaydays([1, 2, 3, 4, 5]))).toBe("too_many");
    expect(refusal(() => normalizePaydays([0, 5]))).toBe("out_of_range");
    expect(refusal(() => normalizePaydays([32]))).toBe("out_of_range");
    expect(refusal(() => normalizePaydays([2.5]))).toBe("out_of_range");
    expect(() => normalizePaydays([])).toThrow("Выберите хотя бы одно число.");
  });

  it("the domain refuses a state whose household carries a malformed list", () => {
    const state = setHouseholdPaydays(empty(), [5, 20]);
    expect(() => calculateBudget(state)).not.toThrow();
    for (const paydays of [[], [20, 5], [5, 5], [0], [1, 2, 3, 4, 5]]) {
      const broken = { ...state, household: { id: HOUSEHOLD_ID, baseCurrency: "RUB", paydays } } as BudgetState;
      expect(() => calculateBudget(broken), JSON.stringify(paydays)).toThrow(/household paydays must list/u);
    }
  });
});

describe("paydays on the household", () => {
  it("naming paydays on a state without a household writes one in the base it already counts in", () => {
    const state = empty();
    expect(state.household).toBeUndefined();
    expect(householdPaydays(state)).toEqual([]);
    const named = setHouseholdPaydays(state, [20, 5]);
    expect(named.household).toEqual({ id: HOUSEHOLD_ID, baseCurrency: "RUB", paydays: [5, 20] });
    expect(householdPaydays(named)).toEqual([5, 20]);
  });

  it("the same answer returns the very same state; «Нет постоянной» clears the field, and clearing nothing changes nothing", () => {
    const named = setHouseholdPaydays(empty(), [5, 20]);
    expect(setHouseholdPaydays(named, [20, 5])).toBe(named);
    const cleared = setHouseholdPaydays(named, null);
    expect(cleared.household).toEqual({ id: HOUSEHOLD_ID, baseCurrency: "RUB" });
    expect("paydays" in cleared.household!).toBe(false);
    const bare = empty();
    expect(setHouseholdPaydays(bare, null)).toBe(bare);
  });

  it("keeps the base currency, and a later base change keeps the paydays", () => {
    const euro = setBaseCurrency(empty(), "EUR");
    const named = setHouseholdPaydays(euro, [10, 25]);
    expect(named.household).toEqual({ id: HOUSEHOLD_ID, baseCurrency: "EUR", paydays: [10, 25] });
    const back = setBaseCurrency(named, "RUB");
    expect(back.household).toEqual({ id: HOUSEHOLD_ID, baseCurrency: "RUB", paydays: [10, 25] });
  });

  it("G-002: naming paydays moves no figure — the budget and the 24-month plan are the same to the kopeck", () => {
    const canonical = makePlanningSeed();
    const named = setHouseholdPaydays(canonical, [5, 20]);
    expect(calculateBudget(named)).toEqual(calculateBudget(canonical));
    expect(calculateAnnualPlan(named, "2026-07", 24)).toEqual(calculateAnnualPlan(canonical, "2026-07", 24));
    // «Можно на повседневные» — лимиты повседневных 53 000 минус потраченное по ним 26 000.
    expect(calculateAnnualPlan(named, "2026-07", 24).currentMonth.flexiblePlanMinor).toBe(5_300_000);
  });
});

describe("paydays on the calendar", () => {
  it("a day past the end of a month is its last day: 30 and 31 in February, 31 in a 30-day month", () => {
    expect(paydayDate("2026-10", 20)).toBe("2026-10-20");
    expect(paydayDate("2026-10", 31)).toBe("2026-10-31");
    expect(paydayDate("2026-11", 31)).toBe("2026-11-30");
    expect(paydayDate("2026-02", 30)).toBe("2026-02-28");
    expect(paydayDate("2026-02", 31)).toBe("2026-02-28");
    expect(paydayDate("2028-02", 30)).toBe("2028-02-29");
    expect(paydayDate("2028-02", 29)).toBe("2028-02-29");
    expect(paydayDate("2026-02", 1)).toBe("2026-02-01");
  });

  it("the next payday is strictly after today: today's own is behind, the month wraps", () => {
    expect(nextPaydayAfter([5, 20], "2026-10-19")).toBe("2026-10-20");
    expect(nextPaydayAfter([5, 20], "2026-10-20")).toBe("2026-11-05");
    expect(nextPaydayAfter([5, 20], "2026-12-25")).toBe("2027-01-05");
    expect(nextPaydayAfter([1, 15], "2026-10-31")).toBe("2026-11-01");
    expect(nextPaydayAfter([], "2026-10-19")).toBeNull();
  });

  it("clamped days in short months: «15-го и 30-го» in February, «31-го» across months", () => {
    expect(nextPaydayAfter([15, 30], "2026-02-16")).toBe("2026-02-28");
    expect(nextPaydayAfter([15, 30], "2026-02-28")).toBe("2026-03-15");
    expect(nextPaydayAfter([31], "2026-01-31")).toBe("2026-02-28");
    expect(nextPaydayAfter([31], "2026-04-29")).toBe("2026-04-30");
    expect(nextPaydayAfter([30, 31], "2026-02-27")).toBe("2026-02-28");
    expect(nextPaydayAfter([30, 31], "2026-03-30")).toBe("2026-03-31");
    expect(nextPaydayAfter([29], "2028-02-28")).toBe("2028-02-29");
  });
});
