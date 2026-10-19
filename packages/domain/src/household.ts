import { baseCurrencyOf, isSupportedCurrency } from "./currency.js";
import { HOUSEHOLD_ID } from "./identity.js";
import type { BudgetState, CurrencyCode } from "./types.js";

/*
 * ─────────────────────────── The base currency ───────────────────────────
 *
 * The base currency is what every budget figure is counted in: limits, planned income, the
 * snapshot of every foreign operation, every plan. It is set once (D-031) — while the household
 * holds nothing counted in it — and is fixed from then on: a new base under recorded money would
 * read every rouble figure as a dollar one, and the journal would hold every operation and plan of
 * the old base with `currency_mismatch` on every device of the family.
 */

/** Why the base currency can no longer change, in the order it is checked. */
export type BaseCurrencyLock = "has_operations" | "has_plans" | "has_debts" | "foreign_accounts" | "has_rates";

export type BaseCurrencyErrorCode = "unknown_currency" | BaseCurrencyLock;

/** Refusal a person is meant to read: `code` for the caller, `message` for the screen. */
export class BaseCurrencyValidationError extends Error {
  readonly code: BaseCurrencyErrorCode;
  readonly field = "currency" as const;

  constructor(code: BaseCurrencyErrorCode, message: string) {
    super(message);
    this.name = "BaseCurrencyValidationError";
    this.code = code;
  }
}

/** The words of each lock: what holds the base in place, and that it is set once. */
export const BASE_CURRENCY_LOCK_WORDS: Readonly<Record<BaseCurrencyLock, string>> = {
  has_operations: "Базовую валюту не сменить: уже записаны операции. Она задаётся один раз, пока бюджет пуст.",
  has_plans: "Базовую валюту не сменить: в бюджете есть лимиты, план дохода, платежи или цели. Она задаётся один раз, пока бюджет пуст.",
  has_debts: "Базовую валюту не сменить: в бюджете есть долги.",
  foreign_accounts: "Базовую валюту не сменить: есть счета в другой валюте.",
  has_rates: "Базовую валюту не сменить: заданы курсы к нынешней базовой валюте. Удалите их сначала.",
};

/**
 * What keeps the base currency where it is, or `null` while it may still change: any operation, any
 * plan — a limit, a planned income, a large payment, a schedule, a goal, a recurring rule — any debt,
 * an account kept in another currency, or a rate against the present base.
 */
export function baseCurrencyLock(state: BudgetState): BaseCurrencyLock | null {
  if (state.transactions.length > 0) return "has_operations";
  const planned = state.budgets.some((budget) => budget.lines.length > 0 || budget.plannedIncomeMinor !== 0)
    || state.annualCommitments.length > 0
    || state.scheduledExpenses.length > 0
    || state.goals.length > 0
    || (state.recurringRules ?? []).length > 0;
  if (planned) return "has_plans";
  if ((state.debts ?? []).length > 0) return "has_debts";
  const base = baseCurrencyOf(state);
  if (state.accounts.some((account) => account.currency !== base)) return "foreign_accounts";
  if ((state.exchangeRates ?? []).length > 0) return "has_rates";
  return null;
}

/**
 * Sets the household's base currency. Refuses an unsupported code and every state
 * {@link baseCurrencyLock} names. The accounts — every one of them kept in the old base, and none
 * named by anything — move to the new base with it: an opening balance is the only amount they hold,
 * and an account the family thinks of as «the main one» must not turn foreign under it. The base the
 * state already has changes nothing and returns the very same state.
 */
export function setBaseCurrency(state: BudgetState, code: CurrencyCode): BudgetState {
  if (!isSupportedCurrency(code)) throw new BaseCurrencyValidationError("unknown_currency", "Выберите валюту из списка.");
  const base = baseCurrencyOf(state);
  if (code === base) return state;
  const lock = baseCurrencyLock(state);
  if (lock !== null) throw new BaseCurrencyValidationError(lock, BASE_CURRENCY_LOCK_WORDS[lock]);
  return {
    ...state,
    household: { id: HOUSEHOLD_ID, baseCurrency: code },
    accounts: state.accounts.map((account) => ({ ...account, currency: code })),
  };
}
