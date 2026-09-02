const integerMoneyFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const decimalSeparator =
  new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
    .formatToParts(1.1)
    .find((part) => part.type === "decimal")?.value ?? ",";

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
  /** Разряды и копейки без знака валюты: `1 234,56`. */
  readonly value: string;
  /** Неразрывный пробел вместе со знаком валюты: ` ₽`. */
  readonly currency: string;
}

export function moneyParts(minor: number): MoneyParts {
  if (!Number.isSafeInteger(minor)) {
    throw new Error("Денежная сумма должна храниться целым числом минимальных единиц.");
  }

  const exactMinor = BigInt(minor);
  const absoluteMinor = exactMinor < 0n ? -exactMinor : exactMinor;
  const rubles = absoluteMinor / 100n;
  const kopecks = absoluteMinor % 100n;
  const parts = integerMoneyFormatter.formatToParts(rubles);

  // Отбивка перед знаком валюты принадлежит знаку: одна вместе с ним и пропадёт, и переедет.
  const currencyIndex = parts.findIndex((part) => part.type === "currency");
  let currencyStart = currencyIndex < 0 ? parts.length : currencyIndex;
  while (currencyStart > 0 && parts[currencyStart - 1]?.type === "literal") currencyStart -= 1;

  let lastIntegerIndex = -1;
  for (let index = 0; index < currencyStart; index += 1) {
    if (parts[index]?.type === "integer") lastIntegerIndex = index;
  }
  const fraction = kopecks === 0n ? "" : `${decimalSeparator}${kopecks.toString().padStart(2, "0")}`;

  let value = "";
  let currency = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (index >= currencyStart) currency += part.value;
    else value += index === lastIntegerIndex ? `${part.value}${fraction}` : part.value;
  }

  return { sign: exactMinor < 0n && absoluteMinor > 0n ? MINUS_SIGN : "", value, currency };
}

export function formatMoney(minor: number): string {
  const parts = moneyParts(minor);
  return `${parts.sign}${parts.value}${parts.currency}`;
}

export function parseMoney(value: string): number {
  if (value.length > maxRawMoneyLength) {
    throw new Error(moneyOverflowMessage);
  }
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (normalized.length > maxNormalizedMoneyLength) {
    throw new Error(moneyOverflowMessage);
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Введите положительную сумму, не более двух знаков после запятой.");
  }
  const separatorIndex = normalized.indexOf(".");
  const rubles = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  const kopecks = separatorIndex === -1 ? "" : normalized.slice(separatorIndex + 1);
  const minor = BigInt(rubles) * 100n + BigInt(kopecks.padEnd(2, "0"));
  if (minor <= 0n) {
    throw new Error("Сумма должна быть больше нуля.");
  }
  if (minor > maxSafeMinor) {
    throw new Error(moneyOverflowMessage);
  }
  return Number(minor);
}
