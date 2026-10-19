import { SUPPORTED_CURRENCIES, type CurrencyCode } from "@family-budget/domain";

/**
 * Выбор валюты счёта, курса или базы: частые — сверху, остальные — по алфавиту русских названий.
 *
 * Названия берёт платформа (`Intl.DisplayNames` для ru): «Доллар США», «Казахстанский тенге» — и
 * код рядом, потому что код — то, что видно на плитке и в курсе. Список — коды
 * `SUPPORTED_CURRENCIES`, и только они: валюту не набирают руками, и чужой строки в данных счёта не
 * бывает. Платформа без названий отдаёт сам код — выбор от этого не ломается.
 */

/** Валюты, которые семья в России держит чаще всего, — первыми, в этом порядке. */
export const FREQUENT_CURRENCIES: readonly CurrencyCode[] = [
  "RUB", "USD", "EUR", "CNY", "KZT", "BYN", "TRY", "GEL", "AMD", "UZS", "KGS", "AED", "GBP", "THB",
];

let displayNames: Intl.DisplayNames | null | undefined;

function names(): Intl.DisplayNames | null {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["ru"], { type: "currency", fallback: "code" });
    } catch {
      displayNames = null;
    }
  }
  return displayNames;
}

/** «Доллар США» — название валюты по-русски с прописной; без названия у платформы — сам код. */
export function currencyName(code: CurrencyCode): string {
  let name: string | undefined;
  try {
    name = names()?.of(code);
  } catch {
    name = undefined;
  }
  if (name === undefined || name === "" || name === code) return code;
  return name.charAt(0).toLocaleUpperCase("ru-RU") + name.slice(1);
}

/** «Доллар США — USD»: подпись варианта и строки, где валюта названа целиком. */
export function currencyLabel(code: CurrencyCode): string {
  const name = currencyName(code);
  return name === code ? code : `${name} — ${code}`;
}

export interface CurrencyChoices {
  readonly frequent: readonly CurrencyCode[];
  readonly others: readonly CurrencyCode[];
}

/** Частые и все прочие, без `exclude` (например, базовой валюты в выборе курса). */
export function currencyChoices(exclude: readonly CurrencyCode[] = []): CurrencyChoices {
  const skip = new Set(exclude);
  const frequent = FREQUENT_CURRENCIES.filter((code) => !skip.has(code));
  const shown = new Set(frequent);
  const others = (Object.keys(SUPPORTED_CURRENCIES) as CurrencyCode[])
    .filter((code) => !skip.has(code) && !shown.has(code))
    .map((code) => ({ code, name: currencyName(code) }))
    .sort((left, right) => left.name.localeCompare(right.name, "ru") || left.code.localeCompare(right.code))
    .map(({ code }) => code);
  return { frequent, others };
}

export interface CurrencySelectProps {
  readonly id: string;
  readonly value: CurrencyCode;
  readonly onChange: (code: CurrencyCode) => void;
  readonly disabled?: boolean;
  /** Подсказка или отказ рядом с полем. */
  readonly describedBy?: string;
  /** Чего в списке быть не должно. */
  readonly exclude?: readonly CurrencyCode[];
  /** Валюты, которые стоит показать первыми, — те, что у семьи уже есть. */
  readonly preferred?: readonly CurrencyCode[];
}

export function CurrencySelect({ id, value, onChange, disabled, describedBy, exclude = [], preferred = [] }: CurrencySelectProps) {
  const choices = currencyChoices(exclude);
  const skip = new Set(exclude);
  const first = [...new Set(preferred)].filter((code) => !skip.has(code) && Object.hasOwn(SUPPORTED_CURRENCIES, code));
  const firstSet = new Set(first);
  const frequent = choices.frequent.filter((code) => !firstSet.has(code));
  const others = choices.others.filter((code) => !firstSet.has(code));
  const option = (code: CurrencyCode) => <option key={code} value={code}>{currencyLabel(code)}</option>;
  return (
    <select id={id} value={value} disabled={disabled} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value as CurrencyCode)}>
      {first.length > 0 ? <optgroup label="Ваши валюты">{first.map(option)}</optgroup> : null}
      <optgroup label="Частые">{frequent.map(option)}</optgroup>
      <optgroup label="Все валюты">{others.map(option)}</optgroup>
    </select>
  );
}
