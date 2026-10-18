import type {
  BudgetState,
  CurrencyCode,
  ExchangeRate,
  ExchangeRateValue,
  ExpenseTransaction,
  IncomeTransaction,
  LocalDate,
  MinorUnits,
  RefundTransaction,
} from "./types.js";

/*
 * ─────────────────────────── Currencies ───────────────────────────
 *
 * Money is an integer count of a currency's minor unit, and the currency decides how many minor
 * units a major one has. Two numbers in two currencies are never added here: the budget adds the
 * base-currency value every operation carries with it (a snapshot), and only the holdings of a
 * later step convert a balance at a rate — and say so when a rate is missing.
 */

/** The base currency of a state that names none: every state written before one could be named. */
export const DEFAULT_BASE_CURRENCY: CurrencyCode = "RUB";

/** The bounds of either part of a rate: one minor unit, and a trillion of them. */
export const RATE_PART_MIN = 1;
export const RATE_PART_MAX = 10 ** 12;

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/**
 * Every currency an account may be kept in, with the number of digits of its minor unit.
 *
 * ISO 4217 as it stood when this table was written, without the X-codes (precious metals, drawing
 * rights, testing and the regional units filed under X) and without the fund codes (BOV, CHE, CHW,
 * CLF, COU, MXV, USN, UYI, UYW), which are units of account rather than money a family holds.
 *
 * Frozen in two senses. The object cannot be changed at run time, and the table may only ever grow:
 * an amount stored in minor units means a different sum the moment its exponent changes, so an
 * exponent is never edited and a code is never removed — a test holds this list to that. A
 * currency ISO withdraws stays here, because the accounts kept in it still exist.
 */
export const SUPPORTED_CURRENCIES: Readonly<Record<CurrencyCode, number>> = Object.freeze({
  AED: 2, AFN: 2, ALL: 2, AMD: 2, AOA: 2, ARS: 2, AUD: 2, AWG: 2, AZN: 2,
  BAM: 2, BBD: 2, BDT: 2, BGN: 2, BHD: 3, BIF: 0, BMD: 2, BND: 2, BOB: 2, BRL: 2, BSD: 2, BTN: 2,
  BWP: 2, BYN: 2, BZD: 2,
  CAD: 2, CDF: 2, CHF: 2, CLP: 0, CNY: 2, COP: 2, CRC: 2, CUP: 2, CVE: 2, CZK: 2,
  DJF: 0, DKK: 2, DOP: 2, DZD: 2,
  EGP: 2, ERN: 2, ETB: 2, EUR: 2,
  FJD: 2, FKP: 2,
  GBP: 2, GEL: 2, GHS: 2, GIP: 2, GMD: 2, GNF: 0, GTQ: 2, GYD: 2,
  HKD: 2, HNL: 2, HTG: 2, HUF: 2,
  IDR: 2, ILS: 2, INR: 2, IQD: 3, IRR: 2, ISK: 0,
  JMD: 2, JOD: 3, JPY: 0,
  KES: 2, KGS: 2, KHR: 2, KMF: 0, KPW: 2, KRW: 0, KWD: 3, KYD: 2, KZT: 2,
  LAK: 2, LBP: 2, LKR: 2, LRD: 2, LSL: 2, LYD: 3,
  MAD: 2, MDL: 2, MGA: 2, MKD: 2, MMK: 2, MNT: 2, MOP: 2, MRU: 2, MUR: 2, MVR: 2, MWK: 2, MXN: 2,
  MYR: 2, MZN: 2,
  NAD: 2, NGN: 2, NIO: 2, NOK: 2, NPR: 2, NZD: 2,
  OMR: 3,
  PAB: 2, PEN: 2, PGK: 2, PHP: 2, PKR: 2, PLN: 2, PYG: 0,
  QAR: 2,
  RON: 2, RSD: 2, RUB: 2, RWF: 0,
  SAR: 2, SBD: 2, SCR: 2, SDG: 2, SEK: 2, SGD: 2, SHP: 2, SLE: 2, SOS: 2, SRD: 2, SSP: 2, STN: 2,
  SVC: 2, SYP: 2, SZL: 2,
  THB: 2, TJS: 2, TMT: 2, TND: 3, TOP: 2, TRY: 2, TTD: 2, TWD: 2, TZS: 2,
  UAH: 2, UGX: 0, USD: 2, UYU: 2, UZS: 2,
  VED: 2, VES: 2, VND: 0, VUV: 0,
  WST: 2,
  YER: 2,
  ZAR: 2, ZMW: 2, ZWG: 2,
});

/**
 * Whether `value` is a currency of {@link SUPPORTED_CURRENCIES}. An own key of the table and
 * nothing else: `toString` and `constructor` are not currencies because the table inherits them.
 */
export function isSupportedCurrency(value: unknown): value is CurrencyCode {
  return typeof value === "string" && CURRENCY_CODE_PATTERN.test(value) && Object.hasOwn(SUPPORTED_CURRENCIES, value);
}

/** Digits of the minor unit of a supported currency: 2 for the rouble, 0 for the yen, 3 for the dinar. */
export function currencyExponent(code: CurrencyCode): number {
  if (!isSupportedCurrency(code)) throw new Error(`currency ${String(code)} is not supported`);
  return SUPPORTED_CURRENCIES[code]!;
}

/** The currency a state counts its budget in: the household's, or roubles when it names none. */
export function baseCurrencyOf(state: Pick<BudgetState, "household">): CurrencyCode {
  return state.household?.baseCurrency ?? DEFAULT_BASE_CURRENCY;
}

/** Whether `value` is a rate the model stores: two safe integers from one to a trillion. */
export function isExchangeRateValue(value: unknown): value is ExchangeRateValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { baseMinor, quoteMinor } = value as Record<string, unknown>;
  return [baseMinor, quoteMinor].every(
    (part) => typeof part === "number" && Number.isSafeInteger(part) && part >= RATE_PART_MIN && part <= RATE_PART_MAX,
  );
}

const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * `amountMinor` minor units of a quoted currency in minor units of the base one, at `rate`.
 *
 * Exact integer arithmetic in BigInt — the product of an amount and a rate part leaves the safe
 * integer range long before the result does — and one rounding at the end: half-up, to the nearest
 * minor unit, the rule the contracts already use for basis points (rule 9 of `contracts/README.md`).
 * A negative amount rounds as the positive one does and keeps its sign, so a debt converted and an
 * overpayment converted are the same number apart from the sign.
 *
 * A result outside the safe integer range is refused rather than rounded into one: a figure that
 * cannot be represented exactly is not a figure.
 */
export function convertMinor(amountMinor: MinorUnits, rate: ExchangeRateValue): MinorUnits {
  if (!Number.isSafeInteger(amountMinor)) throw new Error("amountMinor must be an integer minor-unit amount");
  if (!isExchangeRateValue(rate)) {
    throw new Error(`rate parts must be integers from ${RATE_PART_MIN} to ${RATE_PART_MAX}`);
  }
  const numerator = BigInt(amountMinor) * BigInt(rate.baseMinor);
  const denominator = BigInt(rate.quoteMinor);
  const magnitude = numerator < 0n ? -numerator : numerator;
  let quotient = magnitude / denominator;
  if ((magnitude % denominator) * 2n >= denominator) quotient += 1n;
  if (quotient > SAFE_MAX) throw new Error("converted amount leaves the safe integer range");
  return Number(numerator < 0n ? -quotient : quotient);
}

/**
 * The rate that values `currency` in `baseCurrency` on `onDate`: the latest one dated on or before
 * that day.
 *
 * Rates carry drawn identifiers, so two devices may each record one for the same currency and day,
 * and both survive the merge. The choice between them must not depend on the order a list happens
 * to arrive in, so a tie on the date goes to the larger identifier. A rate against another base is
 * not a candidate at all: it values the currency in something this household does not count in.
 */
export function findRate(
  rates: readonly ExchangeRate[],
  currency: CurrencyCode,
  baseCurrency: CurrencyCode,
  onDate: LocalDate,
): ExchangeRate | undefined {
  let best: ExchangeRate | undefined;
  for (const rate of rates) {
    if (rate.currency !== currency || rate.baseCurrency !== baseCurrency || rate.date > onDate) continue;
    if (best === undefined || rate.date > best.date || (rate.date === best.date && rate.id > best.id)) best = rate;
  }
  return best;
}

/**
 * What an income, an expense or a refund is worth in the base currency: its own amount when the
 * account is kept in the base currency, the snapshot it carries otherwise. The domain guarantees one
 * or the other before anything reads this (`validateTransactionReferences`), so the fallback is not
 * a guess: an operation without a snapshot is one in the base currency.
 */
export function baseAmountOf(transaction: IncomeTransaction | ExpenseTransaction | RefundTransaction): MinorUnits {
  return transaction.baseAmountMinor ?? transaction.amountMinor;
}
