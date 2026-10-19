import {
  accountsInOrder,
  BaseCurrencyValidationError,
  baseCurrencyLock,
  baseCurrencyOf,
  BASE_CURRENCY_LOCK_WORDS,
  findRate,
  RateValidationError,
  type BudgetState,
  type CurrencyCode,
  type ExchangeRate,
  type ExchangeRateCreation,
} from "@family-budget/domain";
import { formatDay } from "../../date-words";
import { writeFailureText } from "../../write/useBudgetWrite";
import { currencySign } from "./RateQuickSheet";
import { formatRateValue, ratePer } from "./rate-input";

/**
 * «Курсы валют» (план волны 2, §1.6): что показать по каждой валюте семьи — последний курс на
 * сегодня, его дату и историю, — и словами, как его набирают: «1 USD = 92,50 ₽», «100 KZT = 18,40 ₽».
 * Курс задаётся вручную и не переоценивает записанное: у каждой операции — свой снимок (D-031).
 */

/** Валюта семьи на экране курсов: её курс сегодня, история и счета в ней. */
export interface CurrencyRates {
  readonly currency: CurrencyCode;
  /** За сколько единиц называют курс: 1 или 100 у слабых валют. */
  readonly per: 1 | 100;
  /** Курс, которым оценивается сегодняшний день (`findRate`), или `undefined`. */
  readonly current: ExchangeRate | undefined;
  /** Все курсы валюты к базе — от нового к старому, при равной дате — как выбирает `findRate`. */
  readonly history: readonly ExchangeRate[];
  /** Имена счетов в этой валюте — активных и архивных, по порядку списка. */
  readonly accountNames: readonly string[];
}

/**
 * Валюты, которые есть у семьи: валюты счетов не в базе — в порядке счетов, затем валюты, у которых
 * есть курс, а счёта уже нет, — по коду. Курсы к другой базе сюда не попадают: они ничего не
 * оценивают (`findRate` их пропускает), а база при них не меняется.
 */
export function familyCurrencies(state: BudgetState): readonly CurrencyCode[] {
  const base = baseCurrencyOf(state);
  const fromAccounts = accountsInOrder(state.accounts).map((account) => account.currency).filter((code) => code !== base);
  const fromRates = (state.exchangeRates ?? [])
    .filter((rate) => rate.baseCurrency === base && rate.currency !== base)
    .map((rate) => rate.currency)
    .sort();
  return [...new Set([...fromAccounts, ...fromRates])];
}

export function currencyRates(state: BudgetState, today: string): readonly CurrencyRates[] {
  const base = baseCurrencyOf(state);
  const rates = state.exchangeRates ?? [];
  return familyCurrencies(state).map((currency) => ({
    currency,
    per: ratePer(currency),
    current: findRate(rates, currency, base, today),
    history: rates
      .filter((rate) => rate.currency === currency && rate.baseCurrency === base)
      .sort((left, right) => (left.date === right.date ? (left.id < right.id ? 1 : -1) : left.date < right.date ? 1 : -1)),
    accountNames: accountsInOrder(state.accounts).filter((account) => account.currency === currency).map((account) => account.name),
  }));
}

/** «1 USD = 92,50 ₽», «100 KZT = 18,40 ₽» — курс так, как его набирают и читают вслух. */
export function rateWords(rate: ExchangeRate): string {
  const per = ratePer(rate.currency);
  return `${per} ${rate.currency} = ${formatRateValue(rate.rate, rate.currency, rate.baseCurrency, per)}\u00a0${currencySign(rate.baseCurrency)}`;
}

/**
 * Что сказать после записи курса. Курс валюты на день — одна запись (`addExchangeRate`): новый день —
 * «записан», тот же день — «исправлен» с прежним и новым значением, чтобы поправку было видно.
 */
export function rateSavedText({ rate, replaced }: ExchangeRateCreation): string {
  const per = ratePer(rate.currency);
  const value = (of: ExchangeRate) => formatRateValue(of.rate, of.currency, of.baseCurrency, per);
  if (replaced === null) return `Курс ${rate.currency} с ${formatDay(rate.date)} записан.`;
  const was = value(replaced);
  const now = value(rate);
  return was === now
    ? `Курс ${rate.currency} на ${formatDay(rate.date)} не изменился: ${now}.`
    : `Курс ${rate.currency} на ${formatDay(rate.date)} исправлен: был ${was}, стал ${now}.`;
}

/** Базовая валюта: что сказать о ней и можно ли её сменить. */
export interface BaseCurrencyState {
  readonly currency: CurrencyCode;
  /** Почему её не сменить — словами домена; `null` — пока можно. */
  readonly lockText: string | null;
}

export function baseCurrencyState(state: BudgetState): BaseCurrencyState {
  const lock = baseCurrencyLock(state);
  return { currency: baseCurrencyOf(state), lockText: lock === null ? null : BASE_CURRENCY_LOCK_WORDS[lock] };
}

/** Отказ записи курса или базы — словами домена; задержка, конфликт и сбой — общими словами записи. */
export function ratesErrorText(error: unknown): string {
  if (error instanceof RateValidationError || error instanceof BaseCurrencyValidationError) return error.message;
  return writeFailureText(error);
}

/** Подпись строки «Курсы валют» на «Ещё»: база и курс каждой валюты семьи на сегодня. */
export function ratesNote(state: BudgetState, today: string): string {
  const base = baseCurrencyOf(state);
  const parts = currencyRates(state, today).map((card) => (card.current === undefined ? `${card.currency} — нет курса` : `${card.per} ${card.currency} = ${formatRateValue(card.current.rate, card.currency, base, card.per)}`));
  return [`база ${base}`, ...(parts.length === 0 ? ["курсов нет"] : parts)].join(" · ");
}
