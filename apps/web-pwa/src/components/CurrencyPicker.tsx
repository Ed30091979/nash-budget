import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SUPPORTED_CURRENCIES, type CurrencyCode } from "@family-budget/domain";
import { plural } from "../plural";
import { Icon } from "./Icon";

/**
 * Выбор валюты счёта, курса или базы (дизайн 5.0, макет 12): чипы частых валют и «Другая», которая
 * раскрывает на месте поиск по всему списку. Системного `<select>` нет.
 *
 * Названия берёт платформа (`Intl.DisplayNames` для ru): «Доллар США», «Казахстанский тенге» — и
 * код рядом, потому что код — то, что видно на плитке и в курсе. Список — коды
 * `SUPPORTED_CURRENCIES`, и только они: валюту не набирают руками, и чужой строки в данных счёта не
 * бывает. Платформа без названий отдаёт сам код — выбор от этого не ломается.
 *
 * Чипы — радиогруппа: Tab входит в неё один раз, на выбранный чип, стрелки выбирают соседний,
 * Home и End — крайний. Поиск — комбобокс над списком (`role="listbox"`): стрелки ходят по
 * найденному, Enter выбирает, Esc сворачивает поиск и возвращает фокус на «Другая», а лист вокруг
 * не закрывает. Выбранная из списка валюта встаёт чипом, и фокус приходит на него.
 */

/** Валюты, которые семья в России держит чаще всего, — первыми, в этом порядке. */
export const FREQUENT_CURRENCIES: readonly CurrencyCode[] = [
  "RUB", "USD", "EUR", "CNY", "KZT", "BYN", "TRY", "GEL", "AMD", "UZS", "KGS", "AED", "GBP", "THB",
];

/** Сколько частых валют стоит чипами до «Другая» (макет 12: рубль, доллар, евро, юань, тенге). */
export const CURRENCY_CHIP_COUNT = 5;

/**
 * Короткие имена чипов — там, где короткое имя однозначно в семье валют приложения. Прочие чипы
 * называются полным именем платформы: «Белорусский рубль» — не «рубль».
 */
const SHORT_NAMES: Readonly<Partial<Record<CurrencyCode, string>>> = {
  RUB: "Рубль",
  USD: "Доллар",
  EUR: "Евро",
  CNY: "Юань",
  KZT: "Тенге",
  GBP: "Фунт",
  TRY: "Лира",
  GEL: "Лари",
  AMD: "Драм",
  UZS: "Сум",
  KGS: "Сом",
  AED: "Дирхам",
  THB: "Бат",
  JPY: "Иена",
};

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

/** «Доллар» на чипе; без короткого имени — полное имя платформы. */
export function currencyShortName(code: CurrencyCode): string {
  return SHORT_NAMES[code] ?? currencyName(code);
}

/**
 * Знак валюты на чипе — узкий, как его пишут от руки: «₽», «$», «¥», «₸». Знак, которого у платформы
 * нет (она отдаёт код), на чипе не повторяется: код и так в доступном имени и в поиске.
 */
export function currencySymbol(code: CurrencyCode): string | null {
  try {
    const part = new Intl.NumberFormat("ru-RU", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
      .formatToParts(0)
      .find((piece) => piece.type === "currency")?.value.trim();
    // Сокращение буквами («р.», «Br») — не знак: у такой валюты чип называет её словом.
    return part === undefined || part === "" || part.length > 2 || part === code || /^[\p{L}.]+$/u.test(part) ? null : part;
  } catch {
    return null;
  }
}

/**
 * Отказ суммы в базовой валюте — с её названием: «в рублях» у рубля, «в валюте «Евро»» у прочих
 * (склонять названия всех валют не из чего; ревью 2c, LOW-7 — прежде всегда «в рублях»).
 */
export function positiveAmountMessage(base: CurrencyCode): string {
  const where = base === "RUB" ? "в рублях" : `в валюте «${currencyName(base)}»`;
  return `Введите положительную сумму ${where}, не более двух знаков после запятой.`;
}

/** «Доллар США — USD»: подпись строки, где валюта названа целиком. */
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

const allowed = (code: CurrencyCode, skip: ReadonlySet<CurrencyCode>) => Object.hasOwn(SUPPORTED_CURRENCIES, code) && !skip.has(code);

/**
 * Чипы выбора: сначала валюты семьи (`preferred`), затем частые — не больше
 * {@link CURRENCY_CHIP_COUNT}; выбранная валюта стоит чипом всегда — последней, если её нет среди
 * них: выбор не прячется за «Другая».
 */
export function currencyChips(value: CurrencyCode, preferred: readonly CurrencyCode[] = [], exclude: readonly CurrencyCode[] = []): readonly CurrencyCode[] {
  const skip = new Set(exclude);
  const chips = [...new Set([...preferred, ...FREQUENT_CURRENCIES])].filter((code) => allowed(code, skip)).slice(0, CURRENCY_CHIP_COUNT);
  return chips.includes(value) || !allowed(value, skip) ? chips : [...chips, value];
}

/** Набранное — без регистра, «ё» как «е», без краевых пробелов. */
function searchKey(text: string): string {
  return text.trim().toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
}

/**
 * Поиск по всему списку: по коду с начала («us», «KZT») и по русскому названию в любом месте
 * («тенге», «фунт»). Пустой запрос — весь список: частые первыми, остальные по алфавиту.
 */
export function searchCurrencies(query: string, exclude: readonly CurrencyCode[] = []): readonly CurrencyCode[] {
  const { frequent, others } = currencyChoices(exclude);
  const all = [...frequent, ...others];
  const key = searchKey(query);
  if (key === "") return all;
  return all.filter((code) => code.toLocaleLowerCase("ru-RU").startsWith(key) || searchKey(currencyName(code)).includes(key));
}

/** Доступное имя чипа: видимое слово первым (WCAG 2.5.3) и код — «Доллар — USD». */
export function currencyChipName(code: CurrencyCode): string {
  const short = currencyShortName(code);
  return short === code ? code : `${short} — ${code}`;
}

export interface CurrencyPickerProps {
  /** Основа идентификаторов: группа — `id`, чип — `id-USD`, поиск — `id-query`. */
  readonly id: string;
  /** Видимая подпись группы («Валюта»): по ней группу называет диктор. */
  readonly labelledBy: string;
  readonly value: CurrencyCode;
  readonly onChange: (code: CurrencyCode) => void;
  /** Запись идёт: чипы молчат, а не выключаются — выключенный теряет фокус. */
  readonly disabled?: boolean;
  /** Валюту не сменить (на счёт ссылаются): чипы говорят «нет», «Другой» нет, причина — в `describedBy`. */
  readonly locked?: boolean;
  /** Подсказка, причина или отказ рядом с группой. */
  readonly describedBy?: string;
  /** Чего в выборе быть не должно. */
  readonly exclude?: readonly CurrencyCode[];
  /** Валюты, которые стоит показать первыми, — те, что у семьи уже есть. */
  readonly preferred?: readonly CurrencyCode[];
}

export function CurrencyPicker({ id, labelledBy, value, onChange, disabled = false, locked = false, describedBy, exclude = [], preferred = [] }: CurrencyPickerProps) {
  const chips = currencyChips(value, preferred, exclude);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const focusTarget = useRef<string | null>(null);
  const inactive = disabled || locked;
  const results = open ? searchCurrencies(query, exclude) : [];
  const activeCode = results[Math.min(active, results.length - 1)] ?? null;
  const chipId = (code: CurrencyCode) => `${id}-${code}`;
  const optionId = (code: CurrencyCode) => `${id}-opt-${code}`;

  // Фокус после отрисовки: на чип выбранной из списка валюты, на поле поиска, на «Другая».
  useEffect(() => {
    const target = focusTarget.current;
    if (target === null) return;
    focusTarget.current = null;
    document.getElementById(target)?.focus({ preventScroll: false });
  });
  // Найденное под стрелкой — в поле зрения списка.
  useEffect(() => {
    if (activeCode !== null) document.getElementById(optionId(activeCode))?.scrollIntoView?.({ block: "nearest" });
  }, [activeCode]);

  const choose = (code: CurrencyCode) => {
    if (inactive) return;
    if (code !== value) onChange(code);
  };
  const onGroupKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (inactive) return;
    const at = chips.indexOf(value);
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (at + 1) % chips.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (at - 1 + chips.length) % chips.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = chips.length - 1;
    if (next === null) return;
    event.preventDefault();
    const code = chips[next]!;
    choose(code);
    focusTarget.current = chipId(code);
  };
  const openSearch = () => {
    if (inactive) return;
    if (open) {
      setOpen(false);
      return;
    }
    setQuery("");
    setActive(0);
    setOpen(true);
    focusTarget.current = `${id}-query`;
  };
  const pick = (code: CurrencyCode) => {
    choose(code);
    setOpen(false);
    setQuery("");
    focusTarget.current = chipId(code);
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) return;
      const at = Math.min(active, results.length - 1);
      setActive(event.key === "ArrowDown" ? Math.min(at + 1, results.length - 1) : Math.max(at - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      // Enter в поиске выбирает, а не отправляет форму вокруг.
      event.preventDefault();
      if (activeCode !== null) pick(activeCode);
      return;
    }
    if (event.key === "Escape") {
      // Esc сворачивает поиск, а лист вокруг не закрывает.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      focusTarget.current = `${id}-other`;
    }
  };

  return (
    <div className="cur-picker">
      <div
        id={id}
        className="cur-chips"
        role="radiogroup"
        tabIndex={-1}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-disabled={inactive || undefined}
        onKeyDown={onGroupKey}
      >
        {chips.map((code) => {
          const checked = code === value;
          const symbol = currencySymbol(code);
          return (
            <button
              key={code}
              id={chipId(code)}
              className="chip cur-chip"
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={currencyChipName(code)}
              aria-disabled={inactive || undefined}
              tabIndex={checked ? 0 : -1}
              onClick={() => choose(code)}
            >
              <span className="chip-face">{symbol === null ? null : <span className="cur-sym" aria-hidden="true">{symbol}</span>}{currencyShortName(code)}</span>
            </button>
          );
        })}
      </div>
      {locked ? null : (
        <button
          id={`${id}-other`}
          className="chip cur-other"
          type="button"
          aria-expanded={open}
          aria-controls={open ? `${id}-search` : undefined}
          aria-disabled={disabled || undefined}
          onClick={openSearch}
        >
          <span className="chip-face"><Icon name="search" size={20} />Другая</span>
        </button>
      )}
      {open ? (
        <div className="cur-search" id={`${id}-search`}>
          <label className="cur-search-label" htmlFor={`${id}-query`}>Найти валюту</label>
          <div className="cur-search-field">
            <Icon name="search" size={20} />
            <input
              id={`${id}-query`}
              type="text"
              role="combobox"
              autoComplete="off"
              enterKeyHint="done"
              placeholder="Название или код: тенге, KZT"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={activeCode === null ? undefined : optionId(activeCode)}
              aria-describedby={`${id}-found`}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActive(0); }}
              onKeyDown={onSearchKey}
            />
          </div>
          <ul className="cur-list" id={`${id}-list`} role="listbox" aria-label="Валюты">
            {results.map((code) => (
              <li
                key={code}
                id={optionId(code)}
                className="cur-option"
                role="option"
                aria-selected={code === activeCode}
                // Касание выбирает, а фокус остаётся в поле до выбора: список не крадёт его у клавиатуры.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(code)}
              >
                <span className="cur-option-name">{currencyName(code)}</span>
                <span className="cur-option-code">{code}</span>
                {/* Текущая валюта — галочкой для глаза и словом для слуха: `aria-selected` занят вариантом под стрелкой. */}
                {code === value ? <><Icon name="check" size={20} /><span className="sr-only">, текущая</span></> : null}
              </li>
            ))}
          </ul>
          <p className="cur-found" id={`${id}-found`} role="status">
            {results.length === 0 ? "Ничего не нашлось. Попробуйте код: USD, KZT." : `Найдено: ${plural(results.length, ["валюта", "валюты", "валют"])}`}
          </p>
        </div>
      ) : null}
    </div>
  );
}
