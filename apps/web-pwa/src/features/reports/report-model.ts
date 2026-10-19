import {
  addDays,
  calculateMonthlySeries,
  calculatePeriodBreakdown,
  currencyExponent,
  dayIndex,
  monthEndDate,
  monthOfDate,
  monthStartDate,
  shiftMonth,
  type BudgetState,
  type CurrencyCode,
  type PeriodBreakdown,
} from "@family-budget/domain";
import { categoryVisual, type CategoryTone } from "../../category-visual";
import type { OperationsFilterFields, ReportPeriod, ReportsFields, ReportView } from "../../navigation/routes";
import { plural } from "../../plural";
import { monthLabel, periodLabel } from "../feed/feed-model";

/**
 * Модель «Отчётов» (подволна 2d, план волны 2, §1.4): период из адреса, итоги, сравнение с прошлым
 * периодом, сектора кольца, таблица, столбцы по месяцам и метки. Числа — из домена
 * (`calculatePeriodBreakdown`, `calculateMonthlySeries`), здесь только выбор периода и слова.
 *
 * Периоды календарные: месяц — с первого по последнее число, квартал — три месяца, год — с 1 января
 * по 31 декабря, свой период — дни из адреса. Окно плана в отчёт не входит (`packages/domain/src/
 * reports.ts`), поэтому итог месяца здесь — ровно итог «Расходы» на «Обзоре» за тот же месяц: оба
 * считает одна функция (ревью 2b, MEDIUM-8).
 */

/** Секторов кольца — не больше шести, остальное — одним сектором «Остальное». */
export const DONUT_TOP = 6;

export interface ReportPeriodModel {
  readonly kind: ReportPeriod;
  readonly from: string;
  readonly to: string;
  /** Подпись чипа и заголовка: «Октябрь», «IV квартал», «2026 год», «1–15 октября». */
  readonly label: string;
  /** «за октябрь», «за IV квартал», «за 2026 год», «за 1–15 октября». */
  readonly forWords: string;
  /** Прошлый период той же длины — с чем сравнивать. */
  readonly previous: { readonly from: string; readonly to: string; readonly inWords: string };
  /** Сегодня внутри периода: период ещё не кончился. */
  readonly ongoing: boolean;
  /** Месяцы столбцов «По месяцам». */
  readonly months: readonly string[];
}

const MONTH_PREPOSITIONAL = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"] as const;
const MONTH_ACCUSATIVE = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"] as const;
const ROMAN = ["I", "II", "III", "IV"] as const;

function monthNumber(month: string): number {
  return Number(month.slice(5, 7));
}

function quarterStartMonth(month: string): string {
  const start = Math.floor((monthNumber(month) - 1) / 3) * 3 + 1;
  return `${month.slice(0, 4)}-${String(start).padStart(2, "0")}`;
}

function quarterWords(startMonth: string, today: string): { readonly label: string; readonly prepositional: string } {
  const roman = ROMAN[Math.floor((monthNumber(startMonth) - 1) / 3)]!;
  const year = startMonth.slice(0, 4);
  const sameYear = year === today.slice(0, 4);
  return { label: sameYear ? `${roman} квартал` : `${roman} квартал ${year}`, prepositional: sameYear ? `${roman} квартале` : `${roman} квартале ${year}` };
}

function monthsBetween(first: string, last: string): string[] {
  const months: string[] = [];
  for (let month = first; month <= last; month = shiftMonth(month, 1)) months.push(month);
  return months;
}

function lastMonths(last: string, count: number): string[] {
  return monthsBetween(shiftMonth(last, -(count - 1)), last);
}

function yearAccusative(month: string, today: string): string {
  return month.slice(0, 4) === today.slice(0, 4) ? MONTH_ACCUSATIVE[monthNumber(month) - 1]! : `${MONTH_ACCUSATIVE[monthNumber(month) - 1]!} ${month.slice(0, 4)}`;
}

function yearPrepositional(month: string, today: string): string {
  return month.slice(0, 4) === today.slice(0, 4) ? `в ${MONTH_PREPOSITIONAL[monthNumber(month) - 1]!}` : `в ${MONTH_PREPOSITIONAL[monthNumber(month) - 1]!} ${month.slice(0, 4)}`;
}

/**
 * Период из адреса. Без `period` — месяц; у месяца, квартала и года `from` — день внутри него (без
 * него — сегодня); свой период без обоих дней — тот же месяц, что без `period`.
 */
export function resolveReportPeriod(fields: ReportsFields, today: string): ReportPeriodModel {
  const anchor = fields.from ?? today;
  const kind: ReportPeriod = fields.period === "custom" && (fields.from === undefined || fields.to === undefined) ? "month" : fields.period ?? "month";
  switch (kind) {
    case "quarter": {
      const first = quarterStartMonth(monthOfDate(anchor));
      const last = shiftMonth(first, 2);
      const previousFirst = shiftMonth(first, -3);
      const words = quarterWords(first, today);
      const from = monthStartDate(first);
      const to = monthEndDate(last);
      return {
        kind, from, to,
        label: words.label,
        forWords: `за ${words.label}`,
        previous: { from: monthStartDate(previousFirst), to: monthEndDate(shiftMonth(previousFirst, 2)), inWords: `в ${quarterWords(previousFirst, today).prepositional}` },
        ongoing: today >= from && today <= to,
        months: lastMonths(last, 6),
      };
    }
    case "year": {
      const year = anchor.slice(0, 4);
      const from = `${year}-01-01`;
      const to = `${year}-12-31`;
      const previousYear = String(Number(year) - 1).padStart(4, "0");
      return {
        kind, from, to,
        label: `${year} год`,
        forWords: `за ${year} год`,
        previous: { from: `${previousYear}-01-01`, to: `${previousYear}-12-31`, inWords: `в ${previousYear} году` },
        ongoing: today >= from && today <= to,
        months: monthsBetween(`${year}-01`, `${year}-12`),
      };
    }
    case "custom": {
      const from = fields.from!;
      const to = fields.to!;
      const days = dayIndex(to) - dayIndex(from) + 1;
      const previousTo = addDays(from, -1);
      const firstMonth = monthOfDate(from);
      const lastMonth = monthOfDate(to);
      const months = monthsBetween(firstMonth, lastMonth);
      const label = periodLabel(from, to, today);
      return {
        kind, from, to,
        label,
        forWords: `за ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
        previous: { from: addDays(previousTo, -(days - 1)), to: previousTo, inWords: `за ${days === 1 ? "предыдущий день" : `предыдущие ${plural(days, ["день", "дня", "дней"])}`}` },
        ongoing: today >= from && today <= to,
        months: months.length > 12 ? months.slice(-12) : months,
      };
    }
    case "month": {
      const month = monthOfDate(anchor);
      const from = monthStartDate(month);
      const to = monthEndDate(month);
      const previous = shiftMonth(month, -1);
      return {
        kind, from, to,
        label: monthLabel(month, today),
        forWords: `за ${yearAccusative(month, today)}`,
        previous: { from: monthStartDate(previous), to: monthEndDate(previous), inWords: yearPrepositional(previous, today) },
        ongoing: today >= from && today <= to,
        months: lastMonths(month, 6),
      };
    }
  }
}

/* ───────────────────────────── Адрес ───────────────────────────── */

/** Тот же период в другом виде: вкладка или счёт меняются, период остаётся. */
export function reportsFieldsWith(fields: ReportsFields, patch: { readonly view?: ReportView; readonly acc?: string | null }): ReportsFields {
  const view = patch.view ?? fields.view;
  const acc = patch.acc === undefined ? fields.acc : patch.acc ?? undefined;
  return {
    ...(view === undefined || view === "expense" ? {} : { view }),
    ...(fields.period === undefined ? {} : { period: fields.period }),
    ...(fields.from === undefined ? {} : { from: fields.from }),
    ...(fields.to === undefined ? {} : { to: fields.to }),
    ...(acc === undefined ? {} : { acc }),
  };
}

/**
 * День, от которого считается другой вид периода: сегодня, если он внутри показанного периода, иначе
 * первый день периода. Из года «Октябрь» — сегодняшний месяц, а не январь; из сентября прошлого года
 * «Квартал» — его III квартал.
 */
export function periodAnchor(fields: ReportsFields, today: string): string {
  const current = resolveReportPeriod(fields, today);
  return current.ongoing ? today : current.from;
}

/**
 * Другой вид периода — с той же опорой (`periodAnchor`): из сентября «Квартал» ведёт в III квартал,
 * «Год» — в его год. Опора, в которой сегодня, в адрес не пишется: «Отчёты» без ключей — это
 * сегодняшний месяц.
 */
export function reportsFieldsForPeriod(fields: ReportsFields, kind: Exclude<ReportPeriod, "custom">, today: string): ReportsFields {
  const anchor = periodAnchor(fields, today);
  let from: string;
  let ongoing: boolean;
  switch (kind) {
    case "month":
      from = monthStartDate(monthOfDate(anchor));
      ongoing = monthOfDate(today) === monthOfDate(anchor);
      break;
    case "quarter":
      from = monthStartDate(quarterStartMonth(monthOfDate(anchor)));
      ongoing = quarterStartMonth(monthOfDate(today)) === quarterStartMonth(monthOfDate(anchor));
      break;
    case "year":
      from = `${anchor.slice(0, 4)}-01-01`;
      ongoing = today.slice(0, 4) === anchor.slice(0, 4);
      break;
  }
  return {
    ...(fields.view === undefined ? {} : { view: fields.view }),
    ...(kind === "month" ? (ongoing ? {} : { period: "month" as const }) : { period: kind }),
    ...(ongoing ? {} : { from }),
    ...(fields.acc === undefined ? {} : { acc: fields.acc }),
  };
}

/** Свой период: дни из листа, вкладка и счёт — прежние. */
export function reportsFieldsForDays(fields: ReportsFields, from: string, to: string): ReportsFields {
  return {
    ...(fields.view === undefined ? {} : { view: fields.view }),
    period: "custom",
    from,
    to,
    ...(fields.acc === undefined ? {} : { acc: fields.acc }),
  };
}

/** «Отчёты» за месяц «Обзора»: текущий месяц — без ключей, другой — опорой на его первый день. */
export function reportsFieldsForMonth(month: string, today: string): ReportsFields {
  return month === monthOfDate(today) ? {} : { period: "month", from: monthStartDate(month) };
}

/* ───────────────────────────── Модель ───────────────────────────── */

export interface ReportSegment {
  /** Категория, `null` — доход без категории; у «Остального» — `"rest"`. */
  readonly key: string;
  readonly categoryId: string | null;
  readonly name: string;
  readonly amountMinor: number;
  /** Доля от суммы положительных величин периода, 0…1. */
  readonly share: number;
  /** Тон категории — цвет сектора и образца; у «Остального» — `null` (`--line`). */
  readonly tone: CategoryTone | null;
  readonly rest: boolean;
  /** Куда ведёт строка легенды: лента с фильтром периода; у «Остального» — таблица (`null`). */
  readonly feed: OperationsFilterFields | null;
}

export interface ReportTableRow {
  readonly key: string;
  readonly name: string;
  readonly archived: boolean;
  /** За вычетом возвратов; бывает отрицательной, когда возвратов больше трат. */
  readonly amountMinor: number;
  /** Доля от суммы положительных величин; `null` — у отрицательной суммы доли нет. */
  readonly share: number | null;
}

export interface ReportTagRow {
  readonly tagId: string;
  readonly name: string;
  readonly archived: boolean;
  /** Расходы с меткой за вычетом возвратов. */
  readonly expenseMinor: number;
  readonly incomeMinor: number;
  /** Доля расходов с меткой от всех расходов периода: операция с двумя метками входит в обе, сумма долей бывает больше 100 %. */
  readonly share: number | null;
  /** Длина полосы, 0…100: та же доля, прижатая к 100. */
  readonly bar: number;
  readonly feed: OperationsFilterFields;
}

export interface ReportBar {
  readonly month: string;
  readonly amountMinor: number;
  /** Высота столбца, 0…1, от самого высокого. */
  readonly height: number;
  /** Сегодняшний месяц: акцентом и жирной подписью. */
  readonly current: boolean;
}

export type ReportComparison =
  | { readonly kind: "less" | "more"; readonly differenceMinor: number }
  | { readonly kind: "same" }
  | { readonly kind: "nothing-before" };

export interface ReportModel {
  readonly view: ReportView;
  readonly period: ReportPeriodModel;
  readonly baseCurrency: CurrencyCode;
  readonly breakdown: PeriodBreakdown;
  /** Итог вкладки: расходы за вычетом возвратов, доходы или расходы с метками. */
  readonly totalMinor: number;
  readonly previousMinor: number;
  readonly comparison: ReportComparison;
  /** Заголовок-вывод карточки (DESIGN §6: график начинается с вывода); `null` — показать нечего. */
  readonly headline: string | null;
  readonly segments: readonly ReportSegment[];
  readonly table: readonly ReportTableRow[];
  readonly tags: readonly ReportTagRow[];
  readonly bars: readonly ReportBar[];
  /** Нечего показать: в периоде нет ни одной суммы этой вкладки. */
  readonly empty: boolean;
}

const UNCATEGORIZED = "Без категории";

function sideTotals(breakdown: PeriodBreakdown, view: ReportView): number {
  if (view === "income") return breakdown.income.totalMinor;
  if (view === "expense") return breakdown.expense.totalMinor;
  // Метки: сумма расходов с метками без двойного счёта операции с двумя метками неизвестна по
  // меткам, поэтому итог вкладки — расходы периода, а доли меток считаются от него.
  return breakdown.expense.totalMinor;
}

/**
 * Всё, что рисуют «Отчёты» за период из адреса. Пустая вкладка — `empty`: экран говорит, что в
 * периоде нет сумм, и не рисует ни кольца, ни нулей.
 */
export function reportModel(state: BudgetState, fields: ReportsFields, today: string): ReportModel {
  const view = fields.view ?? "expense";
  const period = resolveReportPeriod(fields, today);
  const accounts = fields.acc === undefined ? {} : { accountIds: [fields.acc] };
  const breakdown = calculatePeriodBreakdown(state, { from: period.from, to: period.to, ...accounts });
  const previous = calculatePeriodBreakdown(state, { from: period.previous.from, to: period.previous.to, ...accounts });
  const totalMinor = sideTotals(breakdown, view);
  const previousMinor = sideTotals(previous, view);
  const categories = new Map(state.categories.map((category) => [category.id, category]));
  const tags = new Map((state.tags ?? []).map((tag) => [tag.id, tag]));
  const days = { from: period.from, to: period.to, ...(fields.acc === undefined ? {} : { acc: fields.acc }) };

  const side = view === "income" ? breakdown.income : breakdown.expense;
  const positive = side.categories.filter((row) => row.netMinor > 0);
  const positiveSum = positive.reduce((sum, row) => sum + row.netMinor, 0);
  const nameOf = (id: string | null) => (id === null ? UNCATEGORIZED : categories.get(id)?.name ?? "Категория не найдена");
  const segmentOf = (row: (typeof positive)[number]): ReportSegment => {
    const category = row.categoryId === null ? undefined : categories.get(row.categoryId);
    return {
      key: row.categoryId ?? "uncategorized",
      categoryId: row.categoryId,
      name: nameOf(row.categoryId),
      amountMinor: row.netMinor,
      share: positiveSum === 0 ? 0 : row.netMinor / positiveSum,
      tone: category === undefined ? "neutral" : categoryVisual(category).tone,
      rest: false,
      feed: row.categoryId === null ? { ...days, kind: "income" } : { ...days, cat: row.categoryId },
    };
  };
  const top = positive.slice(0, DONUT_TOP).map(segmentOf);
  const restRows = positive.slice(top.length);
  const restMinor = restRows.reduce((sum, row) => sum + row.netMinor, 0);
  const segments = view === "tags" ? [] : restRows.length === 0 ? top : [
    ...top,
    { key: "rest", categoryId: null, name: "Остальное", amountMinor: restMinor, share: positiveSum === 0 ? 0 : restMinor / positiveSum, tone: null, rest: true, feed: null },
  ];

  const table: ReportTableRow[] = view === "tags" ? [] : side.categories
    .filter((row) => row.netMinor !== 0)
    .map((row) => ({
      key: row.categoryId ?? "uncategorized",
      name: nameOf(row.categoryId),
      archived: row.categoryId !== null && categories.get(row.categoryId)?.active === false,
      amountMinor: row.netMinor,
      share: row.netMinor > 0 && positiveSum > 0 ? row.netMinor / positiveSum : null,
    }));

  const expenseTotal = breakdown.expense.totalMinor;
  const tagRows: ReportTagRow[] = breakdown.tags
    .filter((row) => row.actualMinor !== 0 || row.incomeMinor !== 0)
    .map((row) => {
      const share = row.actualMinor > 0 && expenseTotal > 0 ? row.actualMinor / expenseTotal : null;
      return {
        tagId: row.tagId,
        name: tags.get(row.tagId)?.name ?? "метка",
        archived: tags.get(row.tagId)?.active === false,
        expenseMinor: row.actualMinor,
        incomeMinor: row.incomeMinor,
        share,
        bar: share === null ? 0 : Math.min(100, Math.round(share * 100)),
        feed: { ...days, tag: row.tagId },
      };
    })
    .sort((left, right) => right.expenseMinor - left.expenseMinor || right.incomeMinor - left.incomeMinor);

  const series = calculateMonthlySeries(state, period.months, accounts);
  const values = series.months.map((row) => (view === "income" ? row.incomeMinor : row.expenseMinor));
  const highest = Math.max(0, ...values);
  const thisMonth = monthOfDate(today);
  const bars: ReportBar[] = series.months.map((row, at) => ({
    month: row.month,
    amountMinor: values[at]!,
    height: highest === 0 ? 0 : Math.max(0, values[at]!) / highest,
    current: row.month === thisMonth,
  }));

  const empty = view === "tags" ? tagRows.length === 0 : positive.length === 0 && table.length === 0;
  const comparison: ReportComparison = previousMinor === 0
    ? { kind: "nothing-before" }
    : totalMinor === previousMinor ? { kind: "same" }
      : { kind: totalMinor < previousMinor ? "less" : "more", differenceMinor: Math.abs(totalMinor - previousMinor) };

  let headline: string | null = null;
  if (!empty) {
    if (view === "tags") {
      const first = tagRows.find((row) => row.expenseMinor > 0);
      headline = first === undefined ? "Траты с метками" : `Больше всего потрачено с меткой «${first.name}»`;
    } else {
      const first = segments.find((segment) => !segment.rest);
      if (first === undefined) headline = view === "income" ? "Доходы периода" : "Расходы периода";
      else if (view === "income") headline = first.categoryId === null ? "Больше всего пришло без категории" : `Больше всего пришло из источника «${first.name}»`;
      else headline = `Больше всего ушло на категорию «${first.name}»`;
    }
  }

  return {
    view,
    period,
    baseCurrency: breakdown.baseCurrency,
    breakdown,
    totalMinor,
    previousMinor,
    comparison,
    headline,
    segments,
    table,
    tags: tagRows,
    bars,
    empty,
  };
}

/* ───────────────────────────── Слова ───────────────────────────── */

const percentFormat = new Intl.NumberFormat("ru-RU", { style: "percent", maximumFractionDigits: 0 });

/** «63 %»; доля меньше процента — «меньше 1 %», а не «0 %». */
export function shareText(share: number | null): string {
  if (share === null) return "—";
  if (share > 0 && share < 0.005) return `меньше ${percentFormat.format(0.01)}`;
  return percentFormat.format(share);
}

const compactFormat = new Intl.NumberFormat("ru-RU", { notation: "compact", compactDisplay: "short" });

/** Подпись столбца: «76 тыс.», «1,6 млн» — в целых единицах базовой валюты, без знака валюты. */
export function compactAmount(minor: number, currency: CurrencyCode): string {
  return compactFormat.format(minor / 10 ** currencyExponent(currency));
}

const MONTH_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"] as const;
const MONTH_FULL = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"] as const;

/** «окт» — подпись оси; «октябрь» — имя столбца для слуха. */
export function monthShort(month: string): string {
  return MONTH_SHORT[monthNumber(month) - 1]!;
}

export function monthFull(month: string, today: string): string {
  const name = MONTH_FULL[monthNumber(month) - 1]!;
  return month.slice(0, 4) === today.slice(0, 4) ? name : `${name} ${month.slice(0, 4)}`;
}

/** Слова вкладки: «расходов», «доходов», «трат с метками». */
export function viewWords(view: ReportView): { readonly title: string; readonly genitive: string; readonly nominative: string } {
  switch (view) {
    case "income":
      return { title: "Доходы", genitive: "доходов", nominative: "доходы" };
    case "tags":
      return { title: "Метки", genitive: "трат с метками", nominative: "траты с метками" };
    case "expense":
      return { title: "Расходы", genitive: "расходов", nominative: "расходы" };
  }
}

/** Заголовок пустого состояния: «В октябре расходов нет», «В IV квартале доходов нет», «За 1–15 октября трат с метками нет». */
export function emptyTitle(period: ReportPeriodModel, view: ReportView, today: string): string {
  const what = viewWords(view).genitive;
  switch (period.kind) {
    case "month":
      return `${capitalize(yearPrepositional(monthOfDate(period.from), today))} ${what} нет`;
    case "quarter":
      return `В ${quarterWords(monthOfDate(period.from), today).prepositional} ${what} нет`;
    case "year":
      return `В ${period.from.slice(0, 4)} году ${what} нет`;
    case "custom":
      return `${capitalize(period.forWords)} ${what} нет`;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
