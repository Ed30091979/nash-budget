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

export function formatMoney(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new Error("Денежная сумма должна храниться целым числом минимальных единиц.");
  }

  const exactMinor = BigInt(minor);
  const absoluteMinor = exactMinor < 0n ? -exactMinor : exactMinor;
  const rubles = absoluteMinor / 100n;
  const kopecks = absoluteMinor % 100n;
  const signedRubles: bigint | number =
    exactMinor < 0n ? (rubles === 0n ? -0 : -rubles) : rubles;
  const parts = integerMoneyFormatter.formatToParts(signedRubles);

  if (kopecks === 0n) {
    return parts.map((part) => part.value).join("");
  }

  let lastIntegerIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index]?.type === "integer") {
      lastIntegerIndex = index;
    }
  }
  const fraction = kopecks.toString().padStart(2, "0");
  return parts
    .map((part, index) =>
      index === lastIntegerIndex ? `${part.value}${decimalSeparator}${fraction}` : part.value,
    )
    .join("");
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
