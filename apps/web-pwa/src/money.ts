import { currencyExponent, DEFAULT_BASE_CURRENCY, isSupportedCurrency, type CurrencyCode } from "@family-budget/domain";

/**
 * One formatter per currency, made on first use: `Intl.NumberFormat` is costly to build and a
 * screen formats the same two or three currencies hundreds of times.
 */
const integerFormatters = new Map<CurrencyCode, Intl.NumberFormat>();

function integerFormatter(currency: CurrencyCode): Intl.NumberFormat {
  let formatter = integerFormatters.get(currency);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    integerFormatters.set(currency, formatter);
  }
  return formatter;
}

/**
 * Digits of the minor unit: the domain's table for every currency an account may be kept in. A code
 * outside it never reaches a screen through the domain's gates; if one does, it is shown with two
 * digits rather than not at all.
 */
function exponentOf(currency: CurrencyCode): number {
  return isSupportedCurrency(currency) ? currencyExponent(currency) : 2;
}

const decimalSeparator =
  new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
    .formatToParts(1.1)
    .find((part) => part.type === "decimal")?.value ?? ",";

const NO_BREAK_SPACE = "\u00a0";
const maxSafeMinor = BigInt(Number.MAX_SAFE_INTEGER);
const maxNormalizedMoneyLength = (maxSafeMinor / 100n).toString().length + 3;
const maxRawMoneyLength = 24;
const moneyOverflowMessage = "Сумма превышает максимально допустимое значение.";

export type MoneyScale = "s" | "m" | "l";

/**
 * Ступень денежной лестницы (DESIGN §7.2): чем длиннее число, тем раньше компонент
 * понижает типографическую ступень. Обрезать сумму нельзя, поэтому размер выбирается
 * по фактической длине строки, а порог ширины задаёт CSS через @container.
 */
export function moneyScale(text: string): MoneyScale {
  let digits = 0;
  for (const character of text) {
    if (character >= "0" && character <= "9") digits += 1;
  }
  if (digits <= 5) return "s";
  if (digits <= 7) return "m";
  return "l";
}

/**
 * Типографский минус U+2212 (DESIGN §7.6). В табличном режиме он равен ширине цифры, поэтому
 * столбец с отрицательной суммой не съезжает; дефис-минус в этой роли и уже, и читается как
 * перенос. Знак — только про показ: ввод и разбор минус не принимают вовсе.
 */
export const MINUS_SIGN = "−";

/**
 * Сумма, разобранная на части для вёрстки (DESIGN §7.7).
 *
 * Разбор делает `Intl.NumberFormat.formatToParts`, а не регулярное выражение по готовой строке:
 * разделитель разрядов и отбивка перед знаком валюты — неразрывные пробелы, и рука ошибается на
 * них раньше, чем платформа. `currency` приходит вместе со своей отбивкой, поэтому вёрстка не
 * дописывает пробел от себя и не теряет его.
 */
export interface MoneyParts {
  /** `−` для отрицательной суммы, иначе пустая строка. */
  readonly sign: string;
  /** Разряды и дробная часть без знака валюты: `1 234,56`. */
  readonly value: string;
  /** Неразрывный пробел вместе со знаком валюты: ` ₽`, ` $`. */
  readonly currency: string;
}

export function moneyParts(minor: number, currency: CurrencyCode = DEFAULT_BASE_CURRENCY): MoneyParts {
  if (!Number.isSafeInteger(minor)) {
    throw new Error("Денежная сумма должна храниться целым числом минимальных единиц.");
  }

  const exactMinor = BigInt(minor);
  const absoluteMinor = exactMinor < 0n ? -exactMinor : exactMinor;
  const exponent = exponentOf(currency);
  const scale = 10n ** BigInt(exponent);
  const whole = absoluteMinor / scale;
  const rest = absoluteMinor % scale;
  const parts = integerFormatter(currency).formatToParts(whole);

  // The currency sign comes with the spacing `Intl` puts beside it, and both belong to the sign:
  // they leave together and move together. In ru-RU every currency follows the number; a sign the
  // platform puts in front is moved behind it, so the money rule of the app (§7.1: the number, then
  // the sign) holds whatever the currency.
  const firstInteger = parts.findIndex((part) => part.type === "integer");
  let lastInteger = -1;
  parts.forEach((part, index) => {
    if (part.type === "integer") lastInteger = index;
  });
  // Zero minor units of the fraction are not shown, as with kopecks (§7.1): «40 $», «40,50 $».
  const fraction = rest === 0n ? "" : `${decimalSeparator}${rest.toString().padStart(exponent, "0")}`;

  let value = "";
  let symbol = "";
  let spacing = "";
  parts.forEach((part, index) => {
    if (part.type === "currency") symbol += part.value;
    else if (part.type === "literal" && (index < firstInteger || index > lastInteger)) spacing ||= part.value;
    else if (part.type === "integer" || part.type === "group") value += index === lastInteger ? `${part.value}${fraction}` : part.value;
  });

  return {
    sign: exactMinor < 0n && absoluteMinor > 0n ? MINUS_SIGN : "",
    value,
    currency: `${spacing || NO_BREAK_SPACE}${symbol}`,
  };
}

/** Сумма строкой — ровно то, что набирает `Money`: «1 500 ₽», «−40,50 $», «1 500 ¥». */
export function formatMoney(minor: number, currency: CurrencyCode = DEFAULT_BASE_CURRENCY): string {
  const parts = moneyParts(minor, currency);
  return `${parts.sign}${parts.value}${parts.currency}`;
}

/**
 * Сумма из поля — в целые минимальные единицы, без плавающей точки. `exponent` — число знаков
 * дробной части у валюты суммы: 2 у рубля и доллара, 0 у иены, 3 у динара; по умолчанию — как у
 * рубля.
 */
export function parseMoney(value: string, exponent = 2): number {
  if (value.length > maxRawMoneyLength) {
    throw new Error(moneyOverflowMessage);
  }
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (normalized.length > maxNormalizedMoneyLength) {
    throw new Error(moneyOverflowMessage);
  }
  const pattern = exponent === 0 ? /^\d+$/u : new RegExp(`^\\d+(?:\\.\\d{1,${exponent}})?$`, "u");
  if (!pattern.test(normalized)) {
    throw new Error(exponent === 0
      ? "Введите положительную сумму целым числом."
      : `Введите положительную сумму, не более ${exponent === 2 ? "двух" : exponent === 3 ? "трёх" : exponent} знаков после запятой.`);
  }
  const separatorIndex = normalized.indexOf(".");
  const whole = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  const fraction = separatorIndex === -1 ? "" : normalized.slice(separatorIndex + 1);
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, "0") || "0");
  if (minor <= 0n) {
    throw new Error("Сумма должна быть больше нуля.");
  }
  if (minor > maxSafeMinor) {
    throw new Error(moneyOverflowMessage);
  }
  return Number(minor);
}
