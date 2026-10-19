import { describe, expect, it } from "vitest";

import {
  addExchangeRate,
  BASE_CURRENCY_LOCK_WORDS,
  baseCurrencyLock,
  baseCurrencyOf,
  BaseCurrencyValidationError,
  calculateBudget,
  createAccount,
  HOUSEHOLD_ID,
  makeSeedBudget,
  setBaseCurrency,
  SEED_IDS,
  type BudgetState,
} from "../src/index.js";

const DOLLARS = "8c000000-0000-4000-8000-0000000000a1";
const RATE = "8c000000-0000-4000-8000-0000000000a2";
const DEBT = "8c000000-0000-4000-8000-0000000000a3";

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof BaseCurrencyValidationError) return error.code;
    throw error;
  }
}

/** The seed with nothing recorded and nothing planned: two rouble accounts and an empty budget. */
function empty(): BudgetState {
  const seed = makeSeedBudget();
  return {
    ...seed,
    transactions: [],
    goals: [],
    budgets: seed.budgets.map((budget) => ({ ...budget, lines: [], plannedIncomeMinor: 0 })),
  };
}

describe("setBaseCurrency", () => {
  it("sets the base of an empty household, and the accounts move with it", () => {
    const state = empty();
    expect(baseCurrencyLock(state)).toBeNull();
    const next = setBaseCurrency(state, "EUR");
    expect(next.household).toEqual({ id: HOUSEHOLD_ID, baseCurrency: "EUR" });
    expect(baseCurrencyOf(next)).toBe("EUR");
    expect(next.accounts.every((account) => account.currency === "EUR")).toBe(true);
    // The result is a state every calculation accepts, counted in the new base.
    expect(() => calculateBudget(next)).not.toThrow();
    expect(setBaseCurrency(next, "EUR")).toBe(next);
    expect(setBaseCurrency(state, "RUB")).toBe(state);
  });

  it("refuses an unsupported code", () => {
    expect(code(() => setBaseCurrency(empty(), "XAU"))).toBe("unknown_currency");
    expect(code(() => setBaseCurrency(empty(), "constructor"))).toBe("unknown_currency");
  });

  it("refuses once anything is recorded: operations, plans, debts, a foreign account, a rate", () => {
    const seed = makeSeedBudget();
    expect(baseCurrencyLock(seed)).toBe("has_operations");
    expect(code(() => setBaseCurrency(seed, "USD"))).toBe("has_operations");
    expect(() => setBaseCurrency(seed, "USD")).toThrow(BASE_CURRENCY_LOCK_WORDS.has_operations);

    const limited = { ...empty(), budgets: makeSeedBudget().budgets };
    expect(code(() => setBaseCurrency(limited, "USD"))).toBe("has_plans");
    const income: BudgetState = { ...empty(), budgets: empty().budgets.map((budget) => ({ ...budget, plannedIncomeMinor: 100 })) };
    expect(code(() => setBaseCurrency(income, "USD"))).toBe("has_plans");
    const goal: BudgetState = { ...empty(), goals: makeSeedBudget().goals };
    expect(code(() => setBaseCurrency(goal, "USD"))).toBe("has_plans");

    const debt: BudgetState = { ...empty(), debts: [{ id: DEBT, counterparty: "Петя", direction: "i_owe", currency: "RUB", openingMinor: 0, active: true }] };
    expect(code(() => setBaseCurrency(debt, "USD"))).toBe("has_debts");

    const foreign = createAccount(empty(), { name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 0 }, () => DOLLARS).state;
    expect(code(() => setBaseCurrency(foreign, "USD"))).toBe("foreign_accounts");

    const rated = addExchangeRate(empty(), { currency: "USD", date: "2026-07-01", rate: { baseMinor: 9_250, quoteMinor: 100 } }, () => RATE).state;
    expect(code(() => setBaseCurrency(rated, "EUR"))).toBe("has_rates");
    // Nothing of the refused state moved.
    expect(rated.accounts.find((item) => item.id === SEED_IDS.accounts.main)?.currency).toBe("RUB");
  });
});
