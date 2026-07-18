const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatMoney(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new Error("Денежная сумма должна храниться целым числом минимальных единиц.");
  }
  return moneyFormatter.format(minor / 100);
}

export function parseMoney(value: string): number {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Введите положительную сумму, не более двух знаков после запятой.");
  }
  const minor = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new Error("Сумма должна быть больше нуля.");
  }
  return minor;
}
