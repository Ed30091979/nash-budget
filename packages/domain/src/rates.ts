import { dayIndex, isWithinDateWindow } from "./calendar.js";
import {
  baseCurrencyOf,
  convertMinor,
  isExchangeRateValue,
  isSupportedCurrency,
  RATE_PART_MAX,
  RATE_PART_MIN,
  type RateIndex,
} from "./currency.js";
import { documentIds, isUuid } from "./identity.js";
import { COLLECTION_LIMITS, MAX_MONEY_MINOR } from "./limits.js";
import type {
  BudgetState,
  CurrencyCode,
  ExchangeRate,
  ExchangeRateId,
  ExchangeRateValue,
  LocalDate,
  MinorUnits,
} from "./types.js";

/*
 * ─────────────────────────── Exchange rates and snapshots ───────────────────────────
 *
 * A rate is entered by hand (D-031): the family writes «1 USD = 92,50 ₽ on 15 October», and from
 * then on an operation on a dollar account dated that day or later is valued at it when it is
 * written. The value is fixed on the operation (a snapshot), so a rate added, corrected or deleted
 * later never revalues the past — which is why deleting a rate needs no check of the operations.
 */

/** The value of an income, an expense or a refund in the base currency, fixed when it is written. */
export interface BaseSnapshot {
  readonly baseAmountMinor: MinorUnits;
  readonly baseCurrency: CurrencyCode;
  readonly rate: ExchangeRateValue;
}

/**
 * The snapshot of `amountMinor` of `currency` on `date`, at the rate the index chooses for that day
 * (the latest on or before it), or null without a usable rate: none at all, a conversion outside the
 * safe range, or a value that comes to nothing or past a field's ceiling.
 *
 * One rule for everything that writes a foreign operation — the entry sheet and the occurrences of a
 * recurring rule — so the two never disagree about what «the rate of the day» is.
 */
export function baseSnapshot(
  amountMinor: MinorUnits,
  currency: CurrencyCode,
  baseCurrency: CurrencyCode,
  rates: RateIndex,
  date: LocalDate,
): BaseSnapshot | null {
  const rate = rates.find(currency, baseCurrency, date);
  if (rate === undefined) return null;
  return snapshotAt(amountMinor, baseCurrency, rate.rate);
}

/** The snapshot of `amountMinor` at a given rate, or null when that rate cannot value it. */
export function snapshotAt(amountMinor: MinorUnits, baseCurrency: CurrencyCode, rate: ExchangeRateValue): BaseSnapshot | null {
  let baseAmountMinor: MinorUnits;
  try {
    baseAmountMinor = convertMinor(amountMinor, rate);
  } catch {
    return null;
  }
  if (baseAmountMinor < 1 || baseAmountMinor > MAX_MONEY_MINOR) return null;
  return { baseAmountMinor, baseCurrency, rate: { baseMinor: rate.baseMinor, quoteMinor: rate.quoteMinor } };
}

/**
 * The snapshot of a base-currency sum the family typed by hand («списали 1 157 ₽»): the exact rate
 * `{ baseMinor: base, quoteMinor: amount }`, at which the amount converts to that sum without a
 * rounding (D-031), so the domain's check that the snapshot is the amount at its rate holds exactly.
 * Null when either sum is outside what a rate part or a money field may hold.
 */
export function manualSnapshot(amountMinor: MinorUnits, baseAmountMinor: MinorUnits, baseCurrency: CurrencyCode): BaseSnapshot | null {
  for (const part of [amountMinor, baseAmountMinor]) {
    if (!Number.isSafeInteger(part) || part < RATE_PART_MIN || part > RATE_PART_MAX || part > MAX_MONEY_MINOR) return null;
  }
  return snapshotAt(amountMinor, baseCurrency, { baseMinor: baseAmountMinor, quoteMinor: amountMinor });
}

export type RateErrorCode =
  | "unknown_currency"
  | "base_currency"
  | "invalid_date"
  | "invalid_rate"
  | "limit_reached"
  | "id_required"
  | "duplicate_id"
  | "unknown_rate";

/** Refusal a person is meant to read: `code` for the caller, `message` for the screen. */
export class RateValidationError extends Error {
  readonly code: RateErrorCode;
  readonly field: "currency" | "date" | "rate" | "id";

  constructor(code: RateErrorCode, field: RateValidationError["field"], message: string) {
    super(message);
    this.name = "RateValidationError";
    this.code = code;
    this.field = field;
  }
}

function fail(code: RateErrorCode, field: RateValidationError["field"], message: string): never {
  throw new RateValidationError(code, field, message);
}

export interface ExchangeRateDraft {
  /** The quoted currency: any supported one except the base. */
  readonly currency: CurrencyCode;
  /** The day the rate holds from. */
  readonly date: LocalDate;
  readonly rate: ExchangeRateValue;
}

export interface ExchangeRateCreation {
  readonly state: BudgetState;
  readonly rate: ExchangeRate;
}

/**
 * Records a rate of `currency` against the household's base currency from `date` on.
 *
 * Refuses a currency the model does not know, the base currency itself, a date outside the window
 * the journal carries, a rate part outside one to a trillion, and a rate past
 * `COLLECTION_LIMITS.exchangeRates`. A second rate for the same currency and day is not a
 * duplicate: two devices may each record one offline, and `findRate` chooses between them the same
 * way on every device. Nothing else in the state moves — no operation is revalued.
 */
export function addExchangeRate(
  state: BudgetState,
  draft: ExchangeRateDraft,
  makeId: () => ExchangeRateId = () => crypto.randomUUID(),
): ExchangeRateCreation {
  const baseCurrency = baseCurrencyOf(state);
  if (!isSupportedCurrency(draft.currency)) fail("unknown_currency", "currency", "Выберите валюту из списка.");
  if (draft.currency === baseCurrency) fail("base_currency", "currency", "Курс задаётся для валюты, которая не базовая.");
  let validDay = true;
  try {
    dayIndex(draft.date, "date");
  } catch {
    validDay = false;
  }
  if (!validDay || !isWithinDateWindow(draft.date)) fail("invalid_date", "date", "Выберите существующую календарную дату.");
  if (!isExchangeRateValue(draft.rate)) {
    fail("invalid_rate", "rate", "Курс — положительное число, не больше триллиона в каждой части.");
  }
  const rates = state.exchangeRates ?? [];
  if (rates.length >= COLLECTION_LIMITS.exchangeRates) {
    fail("limit_reached", "rate", `Курсов уже ${COLLECTION_LIMITS.exchangeRates} — это предел. Удалите старые курсы.`);
  }
  const id = makeId();
  if (!isUuid(id)) fail("id_required", "id", "Не удалось создать идентификатор курса.");
  // Identifiers are unique across the whole document, not only among rates.
  if (documentIds(state).includes(id)) fail("duplicate_id", "id", "Не удалось создать уникальный идентификатор курса.");
  const rate: ExchangeRate = {
    id,
    currency: draft.currency,
    baseCurrency,
    date: draft.date,
    rate: { baseMinor: draft.rate.baseMinor, quoteMinor: draft.rate.quoteMinor },
  };
  return { state: { ...state, exchangeRates: [...rates, rate] }, rate };
}

/**
 * Deletes a rate. Operations already written at it keep their snapshot, so nothing else moves; an
 * occurrence of a recurring rule not yet written will be valued at whatever rate remains for its day.
 */
export function deleteExchangeRate(state: BudgetState, id: ExchangeRateId): BudgetState {
  const rates = state.exchangeRates ?? [];
  if (!rates.some((rate) => rate.id === id)) fail("unknown_rate", "id", "Курс не найден.");
  return { ...state, exchangeRates: rates.filter((rate) => rate.id !== id) };
}
