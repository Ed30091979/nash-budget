import {
  addDays,
  baseAmountOf,
  baseCurrencyOf,
  currencyExponent,
  isSupportedCurrency,
  monthEndDate,
  monthOfDate,
  monthStartDate,
  type BudgetState,
  type CurrencyCode,
  type Transaction,
} from "@family-budget/domain";
import { categoryVisual, type CategoryTone } from "../../category-visual";
import type { IconName } from "../../components/Icon";
import { FEED_FILTER_KEYS, type FeedKind, type FeedPeriod, type OperationsFilterFields } from "../../navigation/routes";
import { debtVerb, kindLabels, kindSign, operationLabel, transactionCurrency } from "../operations/transaction-words";

/**
 * Модель «Операций» (подволна 2d, план волны 2, §1.3): фильтры, индекс поиска, группы по дням с
 * итогами и слова строк. Чистые функции бюджета — экран ничего не считает сам, и проверки сверяют
 * числа здесь.
 *
 * Индекс строится один раз на бюджет и помнится по ссылке на него (`WeakMap`): каждое нажатие клавиши
 * в поиске идёт по готовым строкам, а не собирает их заново (`feed-model.test.ts` считает сборки на
 * пятидесяти тысячах операций). Новый бюджет — новая ссылка — новый индекс.
 */

/** Сколько строк показывает страница ленты; «Показать ещё» добавляет столько же. */
export const FEED_PAGE_SIZE = 50;

/**
 * Фильтры ленты. Адрес несёт по одному значению на ключ; модель принимает и списки. Без периода и
 * без дней лента — текущий месяц (`feedScope`), `period: "all"` — вся история.
 */
export interface FeedFilters {
  /** `all` — вся история; дни тогда не задаются. */
  readonly period?: FeedPeriod;
  /** Первый день, включительно. */
  readonly from?: string;
  /** Последний день, включительно. */
  readonly to?: string;
  /** Операция касается хотя бы одного из счетов: у перевода — любого из двух. */
  readonly accountIds?: readonly string[];
  readonly categoryIds?: readonly string[];
  /** Операция несёт хотя бы одну из меток. */
  readonly tagIds?: readonly string[];
  readonly memberId?: string;
  readonly kind?: FeedKind;
}

/** Фильтры из адреса «Операций» — как они записаны: месяц по умолчанию подставляет `feedScope`. */
export function filtersOfRoute(route: OperationsFilterFields): FeedFilters {
  return {
    ...(route.period === undefined ? {} : { period: route.period }),
    ...(route.from === undefined ? {} : { from: route.from }),
    ...(route.to === undefined ? {} : { to: route.to }),
    ...(route.acc === undefined ? {} : { accountIds: [route.acc] }),
    ...(route.cat === undefined ? {} : { categoryIds: [route.cat] }),
    ...(route.tag === undefined ? {} : { tagIds: [route.tag] }),
    ...(route.member === undefined ? {} : { memberId: route.member }),
    ...(route.kind === undefined ? {} : { kind: route.kind }),
  };
}

/** Ключи фильтра для адреса: только закрытые типы, по одному значению — строки поиска здесь нет. */
export function routeOfFilters(filters: FeedFilters): OperationsFilterFields {
  const first = (values: readonly string[] | undefined) => values?.[0];
  const fields: Record<string, string | undefined> = {
    period: filters.period,
    from: filters.from,
    to: filters.to,
    acc: first(filters.accountIds),
    cat: first(filters.categoryIds),
    tag: first(filters.tagIds),
    member: filters.memberId,
    kind: filters.kind,
  };
  const route: Record<string, string> = {};
  for (const key of FEED_FILTER_KEYS) {
    const value = fields[key];
    if (value !== undefined) route[key] = value;
  }
  return route as OperationsFilterFields;
}

/** Задан ли хоть один фильтр — и «вся история» тоже: она отличается от ленты по умолчанию. */
export function hasFilters(filters: FeedFilters): boolean {
  return Object.keys(routeOfFilters(filters)).length > 0;
}

/**
 * Что лента показывает на самом деле: без периода и без дней — текущий месяц (лента по умолчанию —
 * месяц с итогами дней и строкой итогов, ревью 2d, LOW-11), «вся история» — без границ, свои дни —
 * как заданы.
 */
export function feedScope(filters: FeedFilters, today: string): FeedFilters {
  if (filters.period === "all") {
    const { period: _period, from: _from, to: _to, ...rest } = filters;
    return rest;
  }
  if (filters.from !== undefined || filters.to !== undefined) return filters;
  const month = monthOfDate(today);
  return { ...filters, from: monthStartDate(month), to: monthEndDate(month) };
}

/** Подпись чипа периода: «Октябрь» по умолчанию, «Весь период», свои дни словами. */
export function feedPeriodLabel(filters: FeedFilters, today: string): string {
  if (filters.period === "all") return "Весь период";
  if (filters.from === undefined && filters.to === undefined) return monthLabel(monthOfDate(today), today);
  return periodLabel(filters.from, filters.to, today);
}

/** Меньше стольких найденных за месяц или свои дни — рядом «Искать за всё время». */
export const FEW_FOUND = 5;

/**
 * Предложить ли «Искать за всё время»: идёт поиск, период — не вся история, а найдено мало или
 * ничего. Набранное при этом остаётся в памяти экрана, меняется только период в адресе.
 */
export function offersAllTime(search: FeedSearch, filters: FeedFilters, found: number): boolean {
  return search.kind !== "none" && filters.period !== "all" && found < FEW_FOUND;
}

/**
 * Перемена фильтров ленты: ключи из `change` поверх прежних, `undefined` снимает ключ. Период — либо
 * словом, либо днями: новые дни снимают «всю историю», «вся история» снимает дни.
 */
export function patchFilters(
  route: OperationsFilterFields,
  change: Partial<Record<keyof OperationsFilterFields, string | undefined>>,
): OperationsFilterFields {
  const merged: Record<string, string | undefined> = { ...routeOfFilters(filtersOfRoute(route)), ...change };
  if (change.from !== undefined || change.to !== undefined) merged.period = undefined;
  if (change.period !== undefined) {
    merged.from = undefined;
    merged.to = undefined;
  }
  const next: Record<string, string> = {};
  for (const key of FEED_FILTER_KEYS) {
    const value = merged[key];
    if (value !== undefined) next[key] = value;
  }
  return next as OperationsFilterFields;
}

/**
 * Счета листа «Счёт» — в «Операциях» и в «Отчётах» одни и те же (ревью 2d, LOW-8): активные по
 * порядку списка, за ними архивные, по которым есть операции, и выбранный, даже если операций по
 * нему нет. Архивный счёт с историей должен находиться: его операции в ленте и в отчёте остались.
 */
export function listedAccounts(state: BudgetState, selected: string | undefined): readonly BudgetState["accounts"][number][] {
  const used = new Set(state.transactions.flatMap((item) => (item.kind === "transfer" || item.kind === "goal_contribution" ? [item.fromAccountId, item.toAccountId] : [item.accountId])).map((id) => id.toLowerCase()));
  const order = state.accounts
    .map((account, index) => ({ account, index }))
    .sort((left, right) => (left.account.sortOrder ?? 0) - (right.account.sortOrder ?? 0) || left.index - right.index)
    .map(({ account }) => account);
  const chosen = (id: string) => selected !== undefined && id.toLowerCase() === selected.toLowerCase();
  return [...order.filter((item) => item.active), ...order.filter((item) => !item.active && (used.has(item.id.toLowerCase()) || chosen(item.id)))];
}

/* ───────────────────────────── Индекс ───────────────────────────── */

/** Сумма, по которой ищет число: минимальные единицы и сколько из них — дробная часть. */
export interface AmountKey {
  readonly minor: number;
  readonly exponent: number;
}

export interface FeedEntry {
  readonly transaction: Transaction;
  /** Место операции в бюджете: у операций одного дня позже записанная стоит выше. */
  readonly order: number;
  /** Счета, которых касается операция; у перевода и взноса — оба. */
  readonly accountIds: readonly string[];
  readonly categoryId: string | null;
  readonly tagIds: readonly string[];
  /** Текст поиска, приведённый к одному виду: заметка, метки, категория, счета, контрагент, цель, вид. */
  readonly text: string;
  /** Имена меток в том же виде — для «#метка». */
  readonly tagNames: readonly string[];
  /** Суммы операции: в валюте счёта, а у операции не в базовой валюте — ещё и снимок в базовой. */
  readonly amounts: readonly AmountKey[];
  /**
   * Вклад в итог дня в базовой валюте со знаком: доход и возврат — плюс, расход — минус. Перевод,
   * взнос в цель и движение по долгу — не доход и не расход (правило 4 контрактов): ноль.
   */
  readonly baseDelta: number;
  /** Проведённые доход, расход или возврат: только они входят в итоги. */
  readonly counted: boolean;
}

export interface FeedIndex {
  /** Сначала новые: по дню операции, внутри дня — позже записанная выше. */
  readonly entries: readonly FeedEntry[];
}

const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/gu;
const SPACES = /[\s\u00a0\u2007\u202f]+/gu;

/** Текст для поиска: строчные, «ё» как «е», без невидимых знаков, пробелы одним обычным. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").replace(INVISIBLE, "").toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(SPACES, " ").trim();
}

function exponentOf(currency: string): number {
  return isSupportedCurrency(currency) ? currencyExponent(currency as CurrencyCode) : 2;
}

function accountsOf(transaction: Transaction): readonly string[] {
  switch (transaction.kind) {
    case "transfer":
    case "goal_contribution":
      return [transaction.fromAccountId, transaction.toAccountId];
    default:
      return [transaction.accountId];
  }
}

function categoryOf(transaction: Transaction): string | null {
  return transaction.kind === "expense" || transaction.kind === "refund" || transaction.kind === "income" ? transaction.categoryId ?? null : null;
}

let builds = 0;

/**
 * Сколько раз индекс ленты собирался с начала работы модуля. Память индекса проверяется этим
 * счётом, а не временем второго вызова: время на общей машине проверок скачет, а счёт — нет (ревью
 * 2d, LOW-4).
 */
export function feedIndexBuilds(): number {
  return builds;
}

function buildIndex(state: BudgetState): FeedIndex {
  builds += 1;
  const base = baseCurrencyOf(state);
  const accounts = new Map(state.accounts.map((account) => [account.id, account]));
  const categories = new Map(state.categories.map((category) => [category.id, category.name]));
  const tags = new Map((state.tags ?? []).map((tag) => [tag.id, normalizeSearchText(tag.name)]));
  const debts = new Map((state.debts ?? []).map((debt) => [debt.id, debt]));
  const goals = new Map(state.goals.map((goal) => [goal.id, goal.name]));
  const entries = state.transactions.map((transaction, order): FeedEntry => {
    const accountIds = accountsOf(transaction);
    const categoryId = categoryOf(transaction);
    const tagIds = transaction.tagIds ?? [];
    const tagNames = tagIds.map((id) => tags.get(id) ?? "");
    const currency = accounts.get(accountIds[0] ?? "")?.currency ?? base;
    const amounts: AmountKey[] = [{ minor: transaction.amountMinor, exponent: exponentOf(currency) }];
    const counted = transaction.status === "posted" && (transaction.kind === "income" || transaction.kind === "expense" || transaction.kind === "refund");
    let baseDelta = 0;
    if (transaction.kind === "income" || transaction.kind === "expense" || transaction.kind === "refund") {
      const baseMinor = baseAmountOf(transaction);
      if (currency !== base) amounts.push({ minor: baseMinor, exponent: exponentOf(base) });
      if (counted) baseDelta = transaction.kind === "expense" ? -baseMinor : baseMinor;
    }
    const words = [
      transaction.note ?? "",
      ...tagNames.map((name) => `#${name}`),
      categoryId === null ? "" : categories.get(categoryId) ?? "",
      ...accountIds.map((id) => accounts.get(id)?.name ?? ""),
      transaction.kind === "debt_out" || transaction.kind === "debt_in" ? debts.get(transaction.debtId)?.counterparty ?? "" : "",
      transaction.kind === "goal_contribution" ? goals.get(transaction.goalId) ?? "" : "",
      kindLabels[transaction.kind],
    ];
    return {
      transaction,
      order,
      accountIds,
      categoryId,
      tagIds,
      // Поля — строками: запрос не склеивает конец одного поля с началом следующего.
      text: words.filter((word) => word !== "").map(normalizeSearchText).join("\n"),
      tagNames,
      amounts,
      baseDelta,
      counted,
    };
  });
  entries.sort((left, right) => (
    left.transaction.occurredOn < right.transaction.occurredOn ? 1
      : left.transaction.occurredOn > right.transaction.occurredOn ? -1
        : right.order - left.order
  ));
  return { entries };
}

const indexes = new WeakMap<BudgetState, FeedIndex>();

/** Индекс ленты — один на бюджет, по ссылке на него. */
export function feedIndex(state: BudgetState): FeedIndex {
  let index = indexes.get(state);
  if (index === undefined) {
    index = buildIndex(state);
    indexes.set(state, index);
  }
  return index;
}

/* ───────────────────────────── Поиск ───────────────────────────── */

/**
 * Разобранная строка поиска. Число ищется по сумме в любом из видов, как его набирают: «1250»,
 * «1 250», «1250,00», «1 250.5» — это одна и та же сумма; «#дача» — по началу имени метки; всё
 * остальное — по вхождению в заметку, метки, категорию, счета, контрагента и цель.
 */
export type FeedSearch =
  | { readonly kind: "none" }
  | { readonly kind: "tag"; readonly prefix: string }
  | { readonly kind: "text"; readonly text: string; readonly amount: { readonly whole: string; readonly fraction: string | null } | null };

const NUMBER = /^[+\-−]?(\d{1,3}(?: \d{3})+|\d+)(?:[.,](\d*))?(?: ?[^\d\s.,]{1,3})?$/u;

export function parseSearch(raw: string): FeedSearch {
  const text = normalizeSearchText(raw);
  if (text === "") return { kind: "none" };
  if (text.startsWith("#")) return { kind: "tag", prefix: text.slice(1).trim() };
  const number = NUMBER.exec(text);
  const whole = number?.[1]?.replace(/ /gu, "").replace(/^0+(?=\d)/u, "");
  const fraction = number?.[2] === undefined || number[2] === "" ? null : number[2];
  return { kind: "text", text, amount: whole === undefined ? null : { whole, fraction } };
}

function amountMatches(key: AmountKey, amount: { readonly whole: string; readonly fraction: string | null }): boolean {
  const scale = 10 ** key.exponent;
  const whole = String(Math.floor(key.minor / scale));
  if (whole !== amount.whole) return false;
  if (amount.fraction === null) return true;
  const digits = String(key.minor % scale).padStart(key.exponent, "0");
  const asked = amount.fraction.padEnd(key.exponent, "0");
  // «1250,00» у иены — те же 1250: лишние нули дробной части ничего не меняют.
  return asked.slice(0, key.exponent) === digits && /^0*$/u.test(asked.slice(key.exponent));
}

export function matchesSearch(entry: FeedEntry, search: FeedSearch): boolean {
  switch (search.kind) {
    case "none":
      return true;
    case "tag":
      return search.prefix === "" ? entry.tagNames.length > 0 : entry.tagNames.some((name) => name.startsWith(search.prefix));
    case "text": {
      const { amount } = search;
      if (amount !== null && entry.amounts.some((key) => amountMatches(key, amount))) return true;
      return entry.text.includes(search.text);
    }
  }
}

/**
 * Фильтры, собранные один раз: множества идентификаторов строятся до прохода по ленте, а не на
 * каждой строке. Идентификаторы сравниваются без учёта регистра — адрес пишет UUID строчными, а
 * бюджет хранит их так, как они пришли.
 */
export function feedPredicate(filters: FeedFilters): (entry: FeedEntry) => boolean {
  const lower = (values: readonly string[] | undefined) => (values === undefined ? null : new Set(values.map((value) => value.toLowerCase())));
  const accounts = lower(filters.accountIds);
  const categories = lower(filters.categoryIds);
  const tags = lower(filters.tagIds);
  const member = filters.memberId?.toLowerCase();
  return (entry) => {
    const { transaction } = entry;
    if (filters.from !== undefined && transaction.occurredOn < filters.from) return false;
    if (filters.to !== undefined && transaction.occurredOn > filters.to) return false;
    if (filters.kind !== undefined && transaction.kind !== filters.kind) return false;
    if (member !== undefined && transaction.memberId?.toLowerCase() !== member) return false;
    if (accounts !== null && !entry.accountIds.some((id) => accounts.has(id.toLowerCase()))) return false;
    if (categories !== null && (entry.categoryId === null || !categories.has(entry.categoryId.toLowerCase()))) return false;
    if (tags !== null && !entry.tagIds.some((id) => tags.has(id.toLowerCase()))) return false;
    return true;
  };
}

export function matchesFilters(entry: FeedEntry, filters: FeedFilters): boolean {
  return feedPredicate(filters)(entry);
}

export interface FeedTotals {
  /** Расходы за вычетом возвратов, в базовой валюте. */
  readonly expenseMinor: number;
  readonly incomeMinor: number;
}

export interface FeedResult {
  readonly entries: readonly FeedEntry[];
  readonly totals: FeedTotals;
}

/** Лента под фильтрами и поиском — в порядке индекса, с итогами найденного. */
export function filterFeed(index: FeedIndex, filters: FeedFilters, search: FeedSearch): FeedResult {
  const passes = feedPredicate(filters);
  const entries = index.entries.filter((entry) => passes(entry) && matchesSearch(entry, search));
  let expenseMinor = 0;
  let incomeMinor = 0;
  for (const entry of entries) {
    if (!entry.counted) continue;
    if (entry.transaction.kind === "income") incomeMinor += entry.baseDelta;
    else expenseMinor -= entry.baseDelta;
  }
  return { entries, totals: { expenseMinor, incomeMinor } };
}

/* ───────────────────────────── Дни ───────────────────────────── */

export interface FeedDay {
  readonly date: string;
  /** Строки дня на видимой странице. */
  readonly entries: readonly FeedEntry[];
  /**
   * Итог дня в базовой валюте: доходы и возвраты минус расходы — всех найденных операций дня, а не
   * только видимой страницы. `null` — у дня нет ни дохода, ни расхода (одни переводы или ожидаемые).
   */
  readonly totalMinor: number | null;
  /** В этот день только ожидаемые операции: «ожидается» вместо итога. */
  readonly pendingOnly: boolean;
}

/** Первые `visible` строк, сложенные в дни; итог дня — по всем найденным операциям этого дня. */
export function groupByDay(entries: readonly FeedEntry[], visible: number): readonly FeedDay[] {
  const totals = new Map<string, { total: number; counted: number; pending: number; all: number }>();
  for (const entry of entries) {
    const date = entry.transaction.occurredOn;
    const day = totals.get(date) ?? { total: 0, counted: 0, pending: 0, all: 0 };
    day.all += 1;
    if (entry.counted) {
      day.total += entry.baseDelta;
      day.counted += 1;
    }
    if (entry.transaction.status !== "posted") day.pending += 1;
    totals.set(date, day);
  }
  const days: { date: string; entries: FeedEntry[] }[] = [];
  for (const entry of entries.slice(0, Math.max(0, visible))) {
    const last = days.at(-1);
    if (last !== undefined && last.date === entry.transaction.occurredOn) last.entries.push(entry);
    else days.push({ date: entry.transaction.occurredOn, entries: [entry] });
  }
  return days.map(({ date, entries: rows }) => {
    const day = totals.get(date)!;
    return { date, entries: rows, totalMinor: day.counted === 0 ? null : day.total, pendingOnly: day.pending === day.all };
  });
}

const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
const dayMonthYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: "UTC" });

function utc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** «19 октября» с неразрывным пробелом, год — если не этот. */
export function dayWords(date: string, today: string): string {
  const words = date.slice(0, 4) === today.slice(0, 4) ? dayMonth.format(utc(date)) : dayMonthYear.format(utc(date)).replace(/\s*г\.$/u, "");
  return words.replace(/ /gu, "\u00a0");
}

/** Заголовок дня: «Сегодня, 19 октября», «Вчера, 18 октября», «Завтра, 20 октября», «16 октября, пятница». */
export function dayHeading(date: string, today: string): string {
  const words = dayWords(date, today);
  if (date === today) return `Сегодня, ${words}`;
  if (date === addDays(today, -1)) return `Вчера, ${words}`;
  if (date === addDays(today, 1)) return `Завтра, ${words}`;
  return `${words}, ${weekday.format(utc(date))}`;
}

/* ───────────────────────────── Подписи чипов ───────────────────────────── */

const monthOnly = new Intl.DateTimeFormat("ru-RU", { month: "long", timeZone: "UTC" });

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** «Октябрь», «Октябрь 2025» — месяц словом, с годом, если он не этот. */
export function monthLabel(month: string, today: string): string {
  const name = capitalized(monthOnly.format(utc(`${month}-01`)));
  return month.slice(0, 4) === today.slice(0, 4) ? name : `${name} ${month.slice(0, 4)}`;
}

/**
 * Период словами — подпись чипа и заголовок: «Весь период», «Октябрь», «2026 год», «С 1 октября»,
 * «1–15 октября», «28 сентября – 3 октября».
 */
export function periodLabel(from: string | undefined, to: string | undefined, today: string): string {
  if (from === undefined && to === undefined) return "Весь период";
  if (from === undefined) return `По ${dayWords(to!, today)}`;
  if (to === undefined) return `С ${dayWords(from, today)}`;
  const month = from.slice(0, 7);
  if (from === monthStartDate(month) && to === monthEndDate(month)) return monthLabel(month, today);
  if (from.slice(5) === "01-01" && to.slice(5) === "12-31" && from.slice(0, 4) === to.slice(0, 4)) return `${from.slice(0, 4)} год`;
  if (from === to) return dayWords(from, today);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8, 10))}–${dayWords(to, today)}`;
  return `${dayWords(from, today)} – ${dayWords(to, today)}`;
}

/** Вид операции во множественном числе — подпись чипа категорий и строки выбора вида. */
export const KIND_PLURAL: Readonly<Record<FeedKind, string>> = {
  expense: "Расходы",
  income: "Доходы",
  refund: "Возвраты",
  transfer: "Переводы",
  goal_contribution: "Взносы в цели",
  debt_out: "Долги: со счёта",
  debt_in: "Долги: на счёт",
};

/* ───────────────────────────── Строка ───────────────────────────── */

export interface FeedRowView {
  readonly id: string;
  readonly title: string;
  /** Подпись: счёт · комментарий · #метка · повторяется · автор. */
  readonly meta: readonly { readonly text: string; readonly tag?: boolean; readonly own?: boolean }[];
  readonly icon: IconName;
  readonly tone: CategoryTone;
  /** Сумма в валюте счёта со знаком направления. */
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly sign: "+" | "−" | undefined;
  /** Снимок в базовой валюте у операции по счёту в другой валюте: «≈ 3 600 ₽» под суммой. */
  readonly baseMinor: number | null;
  /** Ожидаемая операция: ещё не проведена, в итоги не входит. */
  readonly pending: boolean;
  /** Доступное имя строки: что откроется и всё, что в ней видно. */
  readonly label: string;
}

/**
 * Слова строки операции. Название — категория, а без неё — вид («Перевод», «Дал в долг: Саша»);
 * подпись не повторяет название и пустых частей не держит (DESIGN §6, «Строка операции»).
 */
export function feedRowView(entry: FeedEntry, state: BudgetState, authors: { readonly show: boolean; readonly label: (memberId: string | undefined) => string }): FeedRowView {
  const { transaction } = entry;
  const accountName = (id: string) => state.accounts.find((account) => account.id === id)?.name ?? "Счёт не найден";
  const category = entry.categoryId === null ? undefined : state.categories.find((item) => item.id === entry.categoryId);
  const visual = category === undefined ? null : categoryVisual(category);
  const base = baseCurrencyOf(state);
  const currency = transactionCurrency(transaction, state) as CurrencyCode;
  let title: string;
  let icon: IconName;
  let place: string;
  switch (transaction.kind) {
    case "transfer":
      title = kindLabels.transfer;
      icon = "arrow-left-right";
      place = `${accountName(transaction.fromAccountId)} → ${accountName(transaction.toAccountId)}`;
      break;
    case "goal_contribution":
      title = kindLabels.goal_contribution;
      icon = "target";
      place = `${accountName(transaction.fromAccountId)} → ${state.goals.find((goal) => goal.id === transaction.goalId)?.name ?? "Цель не найдена"}`;
      break;
    case "debt_out":
    case "debt_in": {
      const debt = (state.debts ?? []).find((item) => item.id === transaction.debtId);
      title = debt === undefined ? debtVerb(transaction.kind, undefined) : `${debtVerb(transaction.kind, debt.direction)}: ${debt.counterparty}`;
      icon = "user-round";
      place = accountName(transaction.accountId);
      break;
    }
    default:
      title = category?.name ?? kindLabels[transaction.kind];
      icon = visual?.icon ?? (transaction.kind === "income" ? "banknote" : "inbox");
      place = transaction.kind === "refund" ? `возврат · ${accountName(transaction.accountId)}` : accountName(transaction.accountId);
  }
  const tags = new Map((state.tags ?? []).map((tag) => [tag.id, tag.name]));
  const meta: { text: string; tag?: boolean; own?: boolean }[] = [{ text: place }];
  if (transaction.note !== undefined) meta.push({ text: transaction.note, own: true });
  for (const id of entry.tagIds) meta.push({ text: `#${tags.get(id) ?? "метка"}`, tag: true, own: true });
  if (transaction.recurringRuleId !== undefined) meta.push({ text: "повторяется" });
  if (authors.show) meta.push({ text: authors.label(transaction.memberId) });
  const pending = transaction.status !== "posted";
  const foreign = currency !== base && (transaction.kind === "income" || transaction.kind === "expense" || transaction.kind === "refund");
  const baseMinor = foreign ? baseAmountOf(transaction) : null;
  const metaText = meta.map((part) => part.text).join(" · ");
  return {
    id: transaction.id,
    title,
    meta,
    icon,
    tone: visual?.tone ?? "neutral",
    amountMinor: transaction.amountMinor,
    currency,
    sign: kindSign(transaction.kind),
    baseMinor,
    pending,
    label: `Изменить операцию «${operationLabel(transaction, state)}»: ${title}, ${metaText}${pending ? ", ожидается" : ""}`,
  };
}
