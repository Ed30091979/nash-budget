import {
  calculateAnnualPlan,
  normalizeScheduledDueDate,
  type BudgetState,
  type PlanningMonthMetrics,
  type Transaction,
} from "@family-budget/domain";
import { formatMoney } from "../../money";

export type DashboardHorizon = 12 | 24;

export interface DashboardMonth {
  readonly month: string;
  readonly plannedIncomeMinor: number;
  readonly scheduledExpenseMinor: number;
  readonly seasonalExpenseMinor: number;
  readonly flexiblePlanMinor: number;
  readonly flexibleFactMinor: number;
  readonly flexibleRemainingMinor: number;
  readonly annualReserveMinor: number;
  readonly annualDueMinor: number;
  readonly goalPlanMinor: number;
  readonly spendableAfterPlanMinor: number;
  readonly totalIncomeFactMinor: number;
  readonly totalExpenseFactMinor: number;
}

/**
 * Месяц, которым горизонт отвечает на вопрос «как мы его пройдём».
 *
 * Это единственное крупное число экрана «Год» (DESIGN §1): не сумма всех месяцев, которую не с чем
 * сравнить, а тот месяц, где после всех планов остаётся меньше всего.
 */
export interface DashboardTightestMonth {
  readonly month: string;
  /** Имя месяца словами: «сентябрь 2026». */
  readonly label: string;
  readonly freeMinor: number;
  /** Плана в этом месяце больше, чем дохода. */
  readonly shortfall: boolean;
  /**
   * Сколько месяцев горизонта делят этот остаток.
   *
   * Дно горизонта редко бывает одним месяцем: в каноническом наборе сентябрь–январь стоят на
   * одной сумме. Назвать один из них «самым тесным» и умолчать об остальных четырёх — соврать,
   * поэтому подпись героя считает их вслух.
   */
  readonly count: number;
}

export interface DashboardModel {
  readonly horizon: DashboardHorizon;
  readonly months: readonly DashboardMonth[];
  readonly tightest: DashboardTightestMonth;
  /**
   * Вывод над графиком, а не подпись осей.
   *
   * §4 исследования, пункт 23 (Apple): у графика обязан быть заголовок, который сам сообщает
   * вывод. «Горизонт: 12 месяцев. В 2026-07 план повседневных расходов…» выводом не был — он
   * пересказывал таблицу и печатал месяц машинным `2026-07`.
   */
  readonly summary: string;
  readonly verdict: HorizonVerdict;
}

export interface OperationSearchFilters {
  readonly query?: string;
  readonly kind?: Transaction["kind"] | "all";
  readonly categoryId?: string | "all";
  readonly status?: Transaction["status"] | "all";
}

export interface OperationSearchResult {
  readonly transaction: Transaction;
  readonly categoryName: string | null;
  readonly context: string;
}

export interface OperationSearchIndex {
  readonly entries: readonly OperationSearchResult[];
  readonly searchableById: ReadonlyMap<string, string>;
}

export const OPERATION_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 80;
const RUSSIAN_LOCALE = "ru-RU";

function addMinor(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error("Сумма операций выходит за поддерживаемый диапазон.");
  }
  return result;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase(RUSSIAN_LOCALE);
}

function normalizeQuery(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new Error(`Поиск ограничен ${MAX_QUERY_LENGTH} символами.`);
  }
  return normalizeSearchText(trimmed).slice(0, MAX_QUERY_LENGTH);
}

function monthFacts(
  state: BudgetState,
  month: string,
  activeFlexibleCategoryIds: ReadonlySet<string>,
): Pick<
  DashboardMonth,
  "flexibleFactMinor" | "totalIncomeFactMinor" | "totalExpenseFactMinor"
> {
  let flexibleFactMinor = 0;
  let totalIncomeFactMinor = 0;
  let totalExpenseFactMinor = 0;

  for (const transaction of state.transactions) {
    if (transaction.status !== "posted" || transaction.occurredOn.slice(0, 7) !== month) continue;
    if (transaction.kind === "income") {
      totalIncomeFactMinor = addMinor(totalIncomeFactMinor, transaction.amountMinor);
    } else if (transaction.kind === "expense") {
      totalExpenseFactMinor = addMinor(totalExpenseFactMinor, transaction.amountMinor);
      if (activeFlexibleCategoryIds.has(transaction.categoryId)) {
        flexibleFactMinor = addMinor(flexibleFactMinor, transaction.amountMinor);
      }
    } else if (transaction.kind === "refund") {
      totalExpenseFactMinor = addMinor(totalExpenseFactMinor, -transaction.amountMinor);
      if (activeFlexibleCategoryIds.has(transaction.categoryId)) {
        flexibleFactMinor = addMinor(flexibleFactMinor, -transaction.amountMinor);
      }
    }
  }

  return { flexibleFactMinor, totalIncomeFactMinor, totalExpenseFactMinor };
}

function createMonth(
  state: BudgetState,
  month: PlanningMonthMetrics,
  activeFlexibleCategoryIds: ReadonlySet<string>,
): DashboardMonth {
  const facts = monthFacts(state, month.month, activeFlexibleCategoryIds);
  return {
    ...month,
    ...facts,
    flexibleRemainingMinor: addMinor(month.flexiblePlanMinor, -facts.flexibleFactMinor),
  };
}

/**
 * Ближайшее вхождение регулярного расхода, начиная с месяца `startMonth`.
 *
 * `null` — расход выключен или его выбранные месяцы кончились в пределах календаря. День платежа
 * нормализуется доменом: 31-е в коротком месяце становится последним календарным днём.
 */
export function nextScheduledDate(
  item: BudgetState["scheduledExpenses"][number],
  startMonth: string,
): string | null {
  if (!item.active) return null;
  let dueMonth = startMonth;
  while (item.mode === "selected_months" && !item.months?.includes(Number(dueMonth.slice(5, 7)))) {
    const year = Number(dueMonth.slice(0, 4));
    const month = Number(dueMonth.slice(5, 7));
    if (year === 9999 && month === 12) return null;
    dueMonth = month === 12
      ? `${String(year + 1).padStart(4, "0")}-01`
      : `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
  }
  return normalizeScheduledDueDate(dueMonth, item.dueDay);
}

/**
 * Названия месяцев в двух падежах.
 *
 * `Intl` даёт только именительный и приписывает «г.» к году, а вывод над графиком — русская фраза:
 * «свободно меньше всего в сентябре 2026». Два коротких списка честнее, чем фраза, построенная так,
 * чтобы обойтись без падежа.
 */
const MONTH_NAMES: readonly string[] = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];
const MONTH_NAMES_IN: readonly string[] = [
  "январе", "феврале", "марте", "апреле", "мае", "июне",
  "июле", "августе", "сентябре", "октябре", "ноябре", "декабре",
];

function monthWords(month: string, names: readonly string[]): string {
  const index = Number(month.slice(5, 7)) - 1;
  return `${names[index] ?? month} ${month.slice(0, 4)}`;
}

/** «сентябрь 2026» — как месяц зовут в подписи. */
export function monthName(month: string): string {
  return monthWords(month, MONTH_NAMES);
}

/** «в сентябре 2026» — как месяц зовут внутри фразы. */
export function monthNameIn(month: string): string {
  return monthWords(month, MONTH_NAMES_IN);
}

function tightestMonth(months: readonly DashboardMonth[]): DashboardTightestMonth {
  const tightest = months.reduce(
    (lowest, month) => (month.spendableAfterPlanMinor < lowest.spendableAfterPlanMinor ? month : lowest),
    months[0]!,
  );
  return {
    month: tightest.month,
    label: monthName(tightest.month),
    freeMinor: tightest.spendableAfterPlanMinor,
    shortfall: tightest.spendableAfterPlanMinor < 0,
    count: months.filter((month) => month.spendableAfterPlanMinor === tightest.spendableAfterPlanMinor).length,
  };
}

/**
 * Вывод, который лестница месяцев сообщает сама.
 *
 * Сначала беда, если она есть: месяц, где плана больше дохода, важнее любой другой мысли о
 * горизонте. Если беды нет — разброс: от самого тесного месяца до самого свободного. Числа названы
 * словами и не округляются. Заголовок короткий — это `h1` экрана, — а подробность стоит под ним;
 * `summary` склеивает их в одну фразу для чтения вслух.
 */
export interface HorizonVerdict {
  readonly title: string;
  readonly detail: string;
}

export function horizonVerdict(months: readonly DashboardMonth[]): HorizonVerdict {
  const shortfalls = months.filter((month) => month.spendableAfterPlanMinor < 0);
  if (shortfalls.length === 1) {
    const only = shortfalls[0]!;
    return {
      title: `Плана больше дохода в ${monthNameIn(only.month)}`,
      detail: `Сверх дохода ${formatMoney(-only.spendableAfterPlanMinor)}; остальные месяцы горизонта проходят.`,
    };
  }
  if (shortfalls.length > 1) {
    return {
      title: `Плана больше дохода в ${shortfalls.length} месяцах из ${months.length}`,
      detail: `Раньше всего — в ${monthNameIn(shortfalls[0]!.month)}: сверх дохода ${formatMoney(-shortfalls[0]!.spendableAfterPlanMinor)}.`,
    };
  }
  const lowest = tightestMonth(months);
  const highest = months.reduce(
    (top, month) => (month.spendableAfterPlanMinor > top.spendableAfterPlanMinor ? month : top),
    months[0]!,
  );
  if (highest.spendableAfterPlanMinor === lowest.freeMinor) {
    return {
      title: `Плана хватает во все ${months.length} месяцев`,
      detail: `Свободно ${formatMoney(lowest.freeMinor)} в каждом.`,
    };
  }
  return {
    title: `Плана хватает во все ${months.length} месяцев`,
    detail: `Свободно от ${formatMoney(lowest.freeMinor)} в ${monthNameIn(lowest.month)} до ${formatMoney(highest.spendableAfterPlanMinor)} в ${monthNameIn(highest.month)}.`,
  };
}

function horizonSummary(months: readonly DashboardMonth[]): string {
  const verdict = horizonVerdict(months);
  return `${verdict.title}: ${verdict.detail.charAt(0).toLowerCase()}${verdict.detail.slice(1)}`;
}

export function createDashboardModel(
  state: BudgetState,
  startMonth: string,
  horizon: DashboardHorizon,
): DashboardModel {
  const annualPlan = calculateAnnualPlan(state, startMonth, horizon);
  const activeBudget = state.budgets.find((budget) => budget.id === state.activeBudgetId);
  if (activeBudget === undefined) throw new Error("Активный бюджет не найден.");
  const activeFlexibleCategoryIds = new Set(
    activeBudget.lines.filter((line) => line.active !== false).map((line) => line.categoryId),
  );
  const months = annualPlan.months.map((month) => createMonth(state, month, activeFlexibleCategoryIds));

  return {
    horizon,
    months,
    tightest: tightestMonth(months),
    summary: horizonSummary(months),
    verdict: horizonVerdict(months),
  };
}

function transactionContext(
  transaction: Transaction,
  accountById: ReadonlyMap<string, string>,
  categoryById: ReadonlyMap<string, string>,
  goalById: ReadonlyMap<string, string>,
  transactionById: ReadonlyMap<string, Transaction>,
): { readonly categoryName: string | null; readonly context: string } {
  if (transaction.kind === "expense") {
    const category = categoryById.get(transaction.categoryId) ?? "Категория удалена";
    return { categoryName: category, context: `${category} ${accountById.get(transaction.accountId) ?? "Счёт удалён"}` };
  }
  if (transaction.kind === "refund") {
    const category = categoryById.get(transaction.categoryId) ?? "Категория удалена";
    const original = transactionById.get(transaction.originalTransactionId);
    const originalContext = original?.kind === "expense"
      ? categoryById.get(original.categoryId) ?? "Категория удалена"
      : "Исходный расход";
    return {
      categoryName: category,
      context: `${category} возврат расхода ${originalContext} ${accountById.get(transaction.accountId) ?? "Счёт удалён"}`,
    };
  }
  if (transaction.kind === "income") {
    return { categoryName: null, context: `Доход ${accountById.get(transaction.accountId) ?? "Счёт удалён"}` };
  }
  if (transaction.kind === "transfer") {
    return {
      categoryName: null,
      context: `Перевод ${accountById.get(transaction.fromAccountId) ?? "Счёт удалён"} ${accountById.get(transaction.toAccountId) ?? "Счёт удалён"}`,
    };
  }
  if (transaction.kind === "debt_out" || transaction.kind === "debt_in") {
    return { categoryName: null, context: `Долг ${accountById.get(transaction.accountId) ?? "Счёт удалён"}` };
  }
  return {
    categoryName: null,
    context: `Взнос в цель ${goalById.get(transaction.goalId) ?? "Цель удалена"} ${accountById.get(transaction.fromAccountId) ?? "Счёт удалён"} ${accountById.get(transaction.toAccountId) ?? "Счёт удалён"}`,
  };
}

export function searchOperations(
  state: BudgetState,
  filters: OperationSearchFilters = {},
): readonly OperationSearchResult[] {
  const index = buildOperationSearchIndex(state);
  return filterOperationSearchIndex(index, filters);
}

export function buildOperationSearchIndex(state: BudgetState): OperationSearchIndex {
  const accountById = new Map(state.accounts.map((item) => [item.id, item.name]));
  const categoryById = new Map(state.categories.map((item) => [item.id, item.name]));
  const goalById = new Map(state.goals.map((item) => [item.id, item.name]));
  const transactionById = new Map(state.transactions.map((item) => [item.id, item]));
  const entries = state.transactions
    .map((transaction) => {
      const context = transactionContext(transaction, accountById, categoryById, goalById, transactionById);
      return { transaction, ...context };
    })
    .sort((left, right) => (
      right.transaction.occurredOn.localeCompare(left.transaction.occurredOn)
        || right.transaction.id.localeCompare(left.transaction.id)
    ));
  return {
    entries,
    searchableById: new Map(entries.map((result) => [
      result.transaction.id,
      normalizeSearchText([
        result.transaction.occurredOn,
        result.transaction.kind,
        String(result.transaction.amountMinor),
        result.context,
      ].join(" ")),
    ])),
  };
}

function filterOperationSearchIndex(
  index: OperationSearchIndex,
  filters: OperationSearchFilters,
): readonly OperationSearchResult[] {
  const query = normalizeQuery(filters.query ?? "");
  return index.entries
    .filter((result) => {
      const transaction = result.transaction;
      if (filters.kind !== undefined && filters.kind !== "all" && transaction.kind !== filters.kind) return false;
      if (filters.status !== undefined && filters.status !== "all" && transaction.status !== filters.status) return false;
      if (filters.categoryId !== undefined && filters.categoryId !== "all") {
        if (!("categoryId" in transaction) || transaction.categoryId !== filters.categoryId) return false;
      }
      if (query.length === 0) return true;
      return index.searchableById.get(transaction.id)!.includes(query);
    });
}

/** Три буквы месяца — для оси лестницы и коротких подписей расписания. */
export const MONTH_SHORT: readonly string[] = [
  "янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек",
];

/**
 * Выбранные месяцы расписания одной фразой: «сентябрь — май» в списке, «сен–май» на оси.
 *
 * Девять сокращений подряд занимали две строки и читались шумом. Если месяцы идут подряд — хотя
 * бы через Новый год, — фраза называет края; иначе перечисляет, а сверх четырёх — считает.
 */
export function monthsSpan(months: readonly number[], form: "long" | "short" = "long"): string {
  const chosen = new Set(months.filter((month) => Number.isInteger(month) && month >= 1 && month <= 12));
  if (chosen.size === 0) return "месяцы не выбраны";
  if (chosen.size === 12) return "каждый месяц";
  const sorted = [...chosen].sort((left, right) => left - right);
  const names = form === "long" ? MONTH_NAMES : MONTH_SHORT;
  const previous = (month: number) => (month === 1 ? 12 : month - 1);
  const next = (month: number) => (month === 12 ? 1 : month + 1);
  const starts = sorted.filter((month) => !chosen.has(previous(month)));
  if (starts.length === 1) {
    const start = starts[0]!;
    let end = start;
    while (chosen.has(next(end))) end = next(end);
    if (start === end) return names[start - 1]!;
    return form === "long" ? `${names[start - 1]} — ${names[end - 1]}` : `${names[start - 1]}–${names[end - 1]}`;
  }
  if (sorted.length <= 4) return sorted.map((month) => MONTH_SHORT[month - 1]).join(", ");
  return `${sorted.length} месяцев в году`;
}

/**
 * Лестница месяцев: одна строка на месяц, длина полосы — деньги.
 *
 * Полоса — что остаётся от дохода после платежей, резервов и взносов в цели, то есть свободный
 * остаток вместе с конвертами. Насечка на ней — конверты повседневных лимитов: полоса, дотянувшая
 * до насечки, значит «конверты полны», всё за насечкой — запас. Насечка одна на всю лестницу —
 * сквозь неё проходит одна вертикаль, и видно, какой месяц до неё не дотягивает.
 *
 * Доли квантованы: CSP запрещает инлайновые стили, и положение едет атрибутом. Насечка — шагом
 * 1 %, заливка — шагом 5 %, и, как у линейки до выплаты, заливка прижимается к нужной стороне
 * насечки: месяц с запасом не остановится перед ней, месяц с нехваткой не дойдёт до неё.
 */
export type LadderState = "normal" | "tight" | "short" | "out";

export interface LadderRow {
  readonly month: string;
  readonly label: string;
  /** Первый месяц нового года — над ним лестница ставит год. */
  readonly yearBreak: boolean;
  readonly spendableMinor: number;
  readonly fill: number;
  readonly state: LadderState;
}

export interface LadderModel {
  readonly rows: readonly LadderRow[];
  /** Где стоит насечка конвертов, в процентах ширины полосы, шагом 1 %. */
  readonly markPercent: number;
  readonly envelopesMinor: number;
}

const LADDER_STEP = 5;

function ladderStep(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.round((Math.min(Math.max(ratio, 0), 1) * 100) / LADDER_STEP) * LADDER_STEP;
}

export function ladderModel(months: readonly DashboardMonth[], floorMinor: number): LadderModel {
  const envelopesMinor = months.reduce((top, month) => Math.max(top, month.flexiblePlanMinor), 0);
  const totals = months.map((month) => month.spendableAfterPlanMinor + month.flexiblePlanMinor);
  const scale = Math.max(envelopesMinor, ...totals, 1);
  const markPercent = Math.min(99, Math.max(0, Math.round((envelopesMinor / scale) * 100)));
  const markAbove = Math.ceil(markPercent / LADDER_STEP) * LADDER_STEP;
  const markBelow = Math.floor(markPercent / LADDER_STEP) * LADDER_STEP - LADDER_STEP;
  const rows = months.map((month, index): LadderRow => {
    const total = totals[index]!;
    const free = month.spendableAfterPlanMinor;
    const raw = ladderStep(total / scale);
    const state: LadderState = total <= 0 ? "out" : free < 0 ? "short" : free === floorMinor ? "tight" : "normal";
    const fill = state === "out"
      ? 0
      : free < 0
        ? Math.max(0, Math.min(markBelow, raw))
        : Math.min(100, Math.max(markAbove, raw));
    return {
      month: month.month,
      label: MONTH_SHORT[Number(month.month.slice(5, 7)) - 1] ?? month.month,
      yearBreak: index > 0 && month.month.slice(5, 7) === "01",
      spendableMinor: free,
      fill,
      state,
    };
  });
  return { rows, markPercent, envelopesMinor };
}

/**
 * Строй месяца: регулярные платежи на своих числах.
 *
 * Число месяца — то, по чему семья помнит платежи: «пятого — аренда, пятнадцатого — ЖКХ». Ось
 * 1…31 с выплатами и платежами на ней — тот самый календарь месяца, которого горизонту не
 * хватало. Подпись у поздних чисел идёт влево от насечки: справа ей уже негде поместиться.
 */
export interface ShapeRow {
  readonly key: string;
  readonly day: number;
  readonly name: string;
  readonly amountMinor: number;
  /** «сен–май» у сезонного расписания; пусто у ежемесячного. */
  readonly note: string;
  readonly side: "left" | "right";
}

const SHAPE_LABEL_LEFT_FROM = 17;

export function monthShape(state: Pick<BudgetState, "scheduledExpenses">): readonly ShapeRow[] {
  return state.scheduledExpenses
    .filter((item) => item.active)
    .map((item): ShapeRow => {
      const day = Math.min(31, Math.max(1, item.dueDay));
      return {
        key: item.id,
        day,
        name: item.name,
        amountMinor: item.amountMinor,
        note: item.mode === "monthly" ? "" : monthsSpan(item.months ?? [], "short"),
        side: day >= SHAPE_LABEL_LEFT_FROM ? "left" : "right",
      };
    })
    .sort((left, right) => left.day - right.day || left.name.localeCompare(right.name, "ru-RU"));
}

/** Строй месяца словами — для читающих с экрана: ось и метки на ней объявлены одной фразой. */
export function shapeAnnouncement(rows: readonly ShapeRow[], paydays: readonly number[]): string {
  const pay = paydays.length ? `выплаты ${paydays.map((day) => `${day}-го`).join(" и ")}` : "даты выплат пока не выведены";
  const items = rows.map((row) => `${row.name} ${row.day}-го, ${formatMoney(row.amountMinor)}${row.note ? ` (${row.note})` : ""}`);
  return `Числа месяца: ${pay}${items.length ? `; платежи: ${items.join(", ")}` : ""}.`;
}
