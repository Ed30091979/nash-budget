import { baseCurrencyOf } from "./currency.js";
import { monthOfDate, shiftMonth } from "./calendar.js";
import { HOUSEHOLD_ID } from "./identity.js";
import type { BudgetState, LocalDate } from "./types.js";

/*
 * ─────────────────────────── Paydays ───────────────────────────
 *
 * The days of the month money arrives on, as the family named them: «5-го и 20-го». An optional
 * field of the household, exactly as `tags` was an optional collection of the state (D-039): a
 * household written before it existed has none, and the reach clock then derives its paydays from
 * the dates of recorded income, as it always did. Nothing is counted from it — no figure of
 * `BudgetMetrics` or of the plan reads it; it only puts the payday mark on the reach line.
 *
 * Stored as one to four distinct days, 1 to 31, in ascending order. Four is the longest real
 * schedule (an advance and a salary, twice over); a day past the end of a short month is that
 * month's last day, so «30-го» is the 28th in February and «31-го» the 30th in April.
 */

export const MAX_PAYDAYS = 4;
export const MIN_PAYDAY = 1;
export const MAX_PAYDAY = 31;

export type PaydayErrorCode = "empty" | "too_many" | "out_of_range";

/** Refusal a person is meant to read: `code` for the caller, `message` for the screen. */
export class PaydayValidationError extends Error {
  readonly code: PaydayErrorCode;
  readonly field = "paydays" as const;

  constructor(code: PaydayErrorCode, message: string) {
    super(message);
    this.name = "PaydayValidationError";
    this.code = code;
  }
}

function isPayday(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_PAYDAY && value <= MAX_PAYDAY;
}

/**
 * Is this a payday list as it is stored: one to {@link MAX_PAYDAYS} integers from 1 to 31, strictly
 * ascending — so no repeats. The domain, the backup gate and the journal codec ask this one rule.
 */
export function isPaydayList(value: unknown): value is readonly number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PAYDAYS) return false;
  let previous = 0;
  for (const day of value) {
    if (!isPayday(day) || day <= previous) return false;
    previous = day;
  }
  return true;
}

/** What the person picked, as it will be stored: repeats dropped, ascending; or a refusal. */
export function normalizePaydays(days: readonly number[]): readonly number[] {
  if (days.some((day) => !isPayday(day))) {
    throw new PaydayValidationError("out_of_range", `Число месяца — от ${MIN_PAYDAY} до ${MAX_PAYDAY}.`);
  }
  const unique = [...new Set(days)].sort((left, right) => left - right);
  if (unique.length === 0) throw new PaydayValidationError("empty", "Выберите хотя бы одно число.");
  if (unique.length > MAX_PAYDAYS) {
    throw new PaydayValidationError("too_many", `Не больше ${MAX_PAYDAYS} выплат в месяц.`);
  }
  return unique;
}

/** The paydays the family named, or an empty list when it named none. */
export function householdPaydays(state: Pick<BudgetState, "household">): readonly number[] {
  return state.household?.paydays ?? [];
}

/**
 * Names the paydays, or clears them with `null` («Нет постоянной»). A household that does not exist
 * yet is written with the base currency the state already counts in, so naming paydays never moves
 * the base; clearing them on a state without a household changes nothing. The same list returns the
 * very same state, so a repeated answer writes nothing to the journal.
 */
export function setHouseholdPaydays(state: BudgetState, days: readonly number[] | null): BudgetState {
  const current = state.household;
  if (days === null) {
    if (current?.paydays === undefined) return state;
    const { paydays: _cleared, ...rest } = current;
    return { ...state, household: rest };
  }
  const paydays = normalizePaydays(days);
  const stored = current?.paydays;
  if (stored !== undefined && stored.length === paydays.length && stored.every((day, index) => day === paydays[index])) return state;
  return {
    ...state,
    household: { ...(current ?? {}), id: HOUSEHOLD_ID, baseCurrency: baseCurrencyOf(state), paydays },
  };
}

/** The date a payday falls on in a month (`YYYY-MM`): a day past the month's end is its last day. */
export function paydayDate(month: string, day: number): LocalDate {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/**
 * The first payday strictly after `today`: later this month, or in the next one. Today's own payday
 * is behind — the money of today has arrived, and the reach line measures to the next. `null` for an
 * empty list.
 */
export function nextPaydayAfter(paydays: readonly number[], today: LocalDate): LocalDate | null {
  if (paydays.length === 0) return null;
  const month = monthOfDate(today);
  for (const candidateMonth of [month, shiftMonth(month, 1, "payday month")]) {
    for (const day of paydays) {
      const date = paydayDate(candidateMonth, day);
      if (date > today) return date;
    }
  }
  return null;
}
