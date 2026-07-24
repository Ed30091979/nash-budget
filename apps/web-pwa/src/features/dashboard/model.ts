import {
  calculateAnnualPlan,
  calculateBudget,
  normalizeScheduledDueDate,
  type AnnualCommitment,
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

export interface UpcomingPayment {
  readonly id: string;
  readonly name: string;
  readonly dueDate: string;
  readonly amountMinor: number;
  readonly kind: "annual" | "one_time" | "scheduled";
}

export interface DashboardModel {
  readonly horizon: DashboardHorizon;
  readonly months: readonly DashboardMonth[];
  readonly totals: ReturnType<typeof calculateBudget>;
  readonly upcomingPayments: readonly UpcomingPayment[];
  readonly summary: string;
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

export interface OperationSearchPage {
  readonly results: readonly OperationSearchResult[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
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

function annualDateInYear(dueDate: string, year: number): string {
  if (year > 9999) throw new Error("Горизонт платежа выходит за поддерживаемый календарь.");
  const month = Number(dueDate.slice(5, 7));
  const day = Number(dueDate.slice(8, 10));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function effectiveAnnualDate(item: AnnualCommitment, startMonth: string): string | null {
  if (!item.active) return null;
  if (item.dueDate.slice(0, 7) >= startMonth) return item.dueDate;
  if (item.recurrence === "one_time") return null;

  const startYear = Number(startMonth.slice(0, 4));
  const dueYear = Number(item.dueDate.slice(0, 4));
  let year = dueYear + Math.ceil((startYear - dueYear) / 1);
  let candidate = annualDateInYear(item.dueDate, year);
  if (candidate.slice(0, 7) < startMonth) {
    year += 1;
    candidate = annualDateInYear(item.dueDate, year);
  }
  return candidate;
}

function nextAnnualDate(value: string, anniversaryDate: string): string {
  const year = Number(value.slice(0, 4)) + 1;
  return annualDateInYear(anniversaryDate, year);
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

function createUpcomingPayments(
  state: BudgetState,
  startMonth: string,
  endMonth: string,
): readonly UpcomingPayment[] {
  const annual: UpcomingPayment[] = state.annualCommitments.flatMap((item) => {
    const firstDate = effectiveAnnualDate(item, startMonth);
    if (firstDate === null || firstDate.slice(0, 7) > endMonth) return [];
    const dates = [firstDate];
    if (item.recurrence === "annual") {
      let date = firstDate;
      while (date.slice(0, 7) < endMonth) {
        date = nextAnnualDate(date, item.dueDate);
        if (date.slice(0, 7) <= endMonth) dates.push(date);
      }
    }
    return dates.map((dueDate) => ({
      id: item.id,
      name: item.name,
      dueDate,
      amountMinor: item.amountMinor,
      kind: item.recurrence,
    }));
  });

  const scheduled: UpcomingPayment[] = state.scheduledExpenses.flatMap((item) => {
    if (!item.active) return [];
    let dueMonth = startMonth;
    while (
      dueMonth <= endMonth
      && item.mode === "selected_months"
      && !item.months?.includes(Number(dueMonth.slice(5, 7)))
    ) {
      const year = Number(dueMonth.slice(0, 4));
      const month = Number(dueMonth.slice(5, 7));
      if (year === 9999 && month === 12) return [];
      dueMonth = month === 12
        ? `${String(year + 1).padStart(4, "0")}-01`
        : `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
    }
    if (dueMonth > endMonth) return [];
    return [{
      id: item.id,
      name: item.name,
      dueDate: normalizeScheduledDueDate(dueMonth, item.dueDay),
      amountMinor: item.amountMinor,
      kind: "scheduled" as const,
    }];
  });

  return [...annual, ...scheduled].sort((left, right) => (
    left.dueDate.localeCompare(right.dueDate, RUSSIAN_LOCALE)
      || left.name.localeCompare(right.name, RUSSIAN_LOCALE)
      || left.id.localeCompare(right.id)
  ));
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
  const current = months[0]!;

  return {
    horizon,
    months,
    totals: calculateBudget(state),
    upcomingPayments: createUpcomingPayments(state, startMonth, months.at(-1)!.month),
    summary: [
      `Горизонт: ${horizon} месяцев.`,
      `В ${current.month} план повседневных расходов ${formatMoney(current.flexiblePlanMinor)},`,
      `факт ${formatMoney(current.flexibleFactMinor)}, остаток ${formatMoney(current.flexibleRemainingMinor)}.`,
      `Всего по расписанию ${formatMoney(current.scheduledExpenseMinor)},`,
      `резерв ${formatMoney(current.annualReserveMinor)}, свободно ${formatMoney(current.spendableAfterPlanMinor)}.`,
    ].join(" "),
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

export function searchOperationPage(
  index: OperationSearchIndex,
  filters: OperationSearchFilters = {},
  requestedPage = 0,
  pageSize = OPERATION_PAGE_SIZE,
): OperationSearchPage {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > OPERATION_PAGE_SIZE) {
    throw new Error(`Страница поиска должна содержать от 1 до ${OPERATION_PAGE_SIZE} операций.`);
  }
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 0) {
    throw new Error("Номер страницы поиска должен быть неотрицательным целым числом.");
  }
  const matches = filterOperationSearchIndex(index, filters);
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const page = Math.min(requestedPage, pageCount - 1);
  const start = page * pageSize;
  return {
    results: matches.slice(start, start + pageSize),
    total: matches.length,
    page,
    pageSize,
    pageCount,
  };
}
