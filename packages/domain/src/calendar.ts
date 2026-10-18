import type { LocalDate } from "./types.js";

/**
 * Calendar arithmetic on months, shared by everything that has to name one.
 *
 * A month is `YYYY-MM` and a date is `YYYY-MM-DD`, both as plain text: the domain never builds a
 * `Date` for a calendar question, because a `Date` carries a time zone and a budget does not. The
 * only place a `Date` appears is the length of a month, where the platform's own calendar is the
 * authority, and it is asked in UTC so the answer cannot depend on where the family lives.
 *
 * These functions used to live inside `calculate.ts` as private helpers. Carrying a plan into the
 * next month needs the same arithmetic, and two copies of "which month is this" is exactly how a
 * budget ends up disagreeing with itself.
 */

const LOCAL_MONTH_PATTERN = /^\d{4}-\d{2}$/;

/** December of year 9999: the last month the four-digit calendar can name. */
export const MAX_LOCAL_MONTH_INDEX = 9999 * 12 + 11;

/** Count of months since year 0, so that month arithmetic is integer arithmetic. */
export function monthIndex(value: string, label = "month"): number {
  if (!LOCAL_MONTH_PATTERN.test(value)) {
    throw new Error(`${label} must use YYYY-MM`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  if (!Number.isSafeInteger(year) || month < 1 || month > 12) {
    throw new Error(`${label} must be a valid calendar month`);
  }
  return year * 12 + month - 1;
}

export function monthFromIndex(value: number): string {
  const year = Math.floor(value / 12);
  const month = value - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** The month a date falls in. */
export function monthOfDate(date: LocalDate): string {
  return date.slice(0, 7);
}

/** The same month `offset` months later; a negative offset moves back. */
export function shiftMonth(month: string, offset: number, label = "month"): string {
  const index = monthIndex(month, label) + offset;
  if (index < 0 || index > MAX_LOCAL_MONTH_INDEX) {
    throw new Error(`${label} moves outside the supported calendar range`);
  }
  return monthFromIndex(index);
}

/**
 * How many days the month has, February of a leap year included.
 *
 * Counted by the Gregorian rule rather than by asking a `Date`: `Date.UTC` reads a year below
 * 100 as nineteen-hundred-and-that, so year 0096 would have been told the leap years of 1996.
 */
export function daysInMonth(month: string, label = "month"): number {
  const index = monthIndex(month, label);
  const year = Math.floor(index / 12);
  const calendarMonth = index - year * 12 + 1;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][calendarMonth - 1]!;
}

export function monthStartDate(month: string, label = "month"): LocalDate {
  monthIndex(month, label);
  return `${month}-01`;
}

export function monthEndDate(month: string, label = "month"): LocalDate {
  return `${month}-${String(daysInMonth(month, label)).padStart(2, "0")}`;
}

/**
 * The same day of the month, `offset` months away, clipped to the month that receives it.
 *
 * The 31st of a month moved to a 30-day month lands on the 30th, exactly like a payment due on
 * the 31st: a shifted scene must stay a calendar, not become a set of impossible dates.
 */
export function shiftDate(date: LocalDate, monthOffset: number, label = "date"): LocalDate {
  const month = shiftMonth(monthOfDate(date), monthOffset, label);
  const day = Math.min(Number(date.slice(8, 10)), daysInMonth(month, label));
  return `${month}-${String(day).padStart(2, "0")}`;
}

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Day index of 0000-01-01 and of 9999-12-31: the range the four-digit calendar can name. */
const MIN_DAY_INDEX = -719_528;
const MAX_DAY_INDEX = 2_932_896;

/**
 * Count of days since 1970-01-01, so that day arithmetic is integer arithmetic.
 *
 * Days from civil, the proleptic Gregorian count — the same arithmetic a `Date` performs, done
 * here without one, for the reason the top of this file gives: a `Date` carries a time zone, and a
 * payment due on the 31st must not move to the 30th because the device is in Vladivostok.
 */
export function dayIndex(date: LocalDate, label = "date"): number {
  if (!LOCAL_DATE_PATTERN.test(date)) throw new Error(`${label} must use YYYY-MM-DD`);
  const month = monthOfDate(date);
  const day = Number(date.slice(8, 10));
  if (day < 1 || day > daysInMonth(month, label)) throw new Error(`${label} must be a valid calendar date`);
  const calendarMonth = Number(date.slice(5, 7));
  // The year is counted from March, so the leap day is the last day of the year it belongs to.
  const year = Number(date.slice(0, 4)) - (calendarMonth <= 2 ? 1 : 0);
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const dayOfYear = Math.floor((153 * (calendarMonth + (calendarMonth > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The date `index` days after 1970-01-01; the inverse of {@link dayIndex}. */
export function dateFromDayIndex(index: number, label = "date"): LocalDate {
  if (!Number.isSafeInteger(index) || index < MIN_DAY_INDEX || index > MAX_DAY_INDEX) {
    throw new Error(`${label} moves outside the supported calendar range`);
  }
  const shifted = index + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthFromMarch = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthFromMarch + 2) / 5) + 1;
  const calendarMonth = monthFromMarch < 10 ? monthFromMarch + 3 : monthFromMarch - 9;
  const year = yearOfEra + era * 400 + (calendarMonth <= 2 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(calendarMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The date `days` days later; a negative count moves back. */
export function addDays(date: LocalDate, days: number, label = "date"): LocalDate {
  if (!Number.isSafeInteger(days)) throw new Error(`${label} offset must be an integer number of days`);
  return dateFromDayIndex(dayIndex(date, label) + days, label);
}
