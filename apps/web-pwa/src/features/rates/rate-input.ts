import {
  currencyExponent,
  isSupportedCurrency,
  RATE_PART_MAX,
  RATE_PART_MIN,
  type CurrencyCode,
  type ExchangeRateValue,
} from "@family-budget/domain";

/**
 * Курс, набранный человеком, — в два целых числа модели (план волны 2, §1.6): «1 USD = 92,50 ₽»
 * значит, что 100 центов стоят 9 250 копеек. До шести знаков после запятой; для слабых валют курс
 * называют за сотню («100 KZT = 18,40 ₽»). Арифметика целочисленная, и пара сокращается на общий
 * делитель, поэтому одна и та же цифра пишется одним значением на каждом устройстве.
 */

export const RATE_FRACTION_DIGITS = 6;

/** Валюты, курс которых называют за сотню: единица стоит меньше копейки-другой. */
const PER_HUNDRED: ReadonlySet<CurrencyCode> = new Set(["JPY", "KRW", "KZT", "AMD", "UZS", "HUF", "IDR", "VND", "KGS"]);

/** За сколько единиц валюты называют курс: 1 или 100. */
export function ratePer(currency: CurrencyCode): 1 | 100 {
  return PER_HUNDRED.has(currency) ? 100 : 1;
}

function exponentOf(currency: CurrencyCode): number {
  return isSupportedCurrency(currency) ? currencyExponent(currency) : 2;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export type RateInput = { readonly kind: "rate"; readonly rate: ExchangeRateValue } | { readonly kind: "error"; readonly message: string };

/** «92,50» за `per` единиц `quote` в `base` — в курс модели, или отказ словами. */
export function parseRateInput(text: string, quote: CurrencyCode, base: CurrencyCode, per: number = ratePer(quote)): RateInput {
  const normalized = text.replace(/\s/gu, "").replace(".", ",");
  const match = new RegExp(`^(\\d{1,12})(?:,(\\d{1,${RATE_FRACTION_DIGITS}}))?$`, "u").exec(normalized);
  if (match === null) return { kind: "error", message: `Введите курс числом, не больше ${RATE_FRACTION_DIGITS} знаков после запятой.` };
  const fraction = match[2] ?? "";
  const digits = BigInt(`${match[1] ?? "0"}${fraction}`);
  if (digits === 0n) return { kind: "error", message: "Курс должен быть больше нуля." };
  // value = digits / 10^d базовых единиц за `per` единиц валюты.
  let baseMinor = digits * 10n ** BigInt(exponentOf(base));
  let quoteMinor = BigInt(per) * 10n ** BigInt(exponentOf(quote)) * 10n ** BigInt(fraction.length);
  const common = gcd(baseMinor, quoteMinor);
  baseMinor /= common;
  quoteMinor /= common;
  const bounds = (part: bigint) => part >= BigInt(RATE_PART_MIN) && part <= BigInt(RATE_PART_MAX);
  if (!bounds(baseMinor) || !bounds(quoteMinor)) return { kind: "error", message: "Такой курс модель не хранит: проверьте число." };
  return { kind: "rate", rate: { baseMinor: Number(baseMinor), quoteMinor: Number(quoteMinor) } };
}

/**
 * Курс модели — числом, как его набирают: «92,50» за `per` единиц `quote` в `base`. Точное деление
 * целых: не меньше двух знаков после запятой и не больше {@link RATE_FRACTION_DIGITS}, последний —
 * половиной вверх, лишние нули справа убраны. Что набрал человек, то и прочтёт: `parseRateInput`
 * этой строки даёт тот же курс.
 */
export function formatRateValue(rate: ExchangeRateValue, quote: CurrencyCode, base: CurrencyCode, per: number = ratePer(quote)): string {
  const scale = 10n ** BigInt(RATE_FRACTION_DIGITS);
  // value = baseMinor / 10^baseExp за quoteMinor / 10^quoteExp единиц, умноженное на `per`.
  const numerator = BigInt(rate.baseMinor) * BigInt(per) * 10n ** BigInt(exponentOf(quote)) * scale;
  const denominator = BigInt(rate.quoteMinor) * 10n ** BigInt(exponentOf(base));
  let scaled = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) scaled += 1n;
  const whole = scaled / scale;
  const fraction = String(scaled % scale).padStart(RATE_FRACTION_DIGITS, "0").replace(/0+$/u, "").padEnd(2, "0");
  const grouped = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(whole);
  return `${grouped},${fraction}`;
}
