import { indexState, validateTransactionReferences } from "./calculate.js";
import { isWithinDateWindow, monthEndDate, monthIndex, monthStartDate } from "./calendar.js";
import { baseAmountOf } from "./currency.js";
import type {
  AccountId,
  BudgetState,
  CategoryId,
  CurrencyCode,
  LocalDate,
  MinorUnits,
  TagId,
  TagMetrics,
  Transaction,
} from "./types.js";

/*
 * ─────────────────────────── Reports: a calendar period ───────────────────────────
 *
 * The figures of «Отчёты» and of the «Расходы» total of «Обзор». Every figure here belongs to a
 * calendar period — the days `from` … `to`, both included, by the date of the operation — and to
 * nothing else.
 *
 * A budget has a window of its own (`startDate` … `endDate`), and `calculateBudget` counts the
 * operations of that window: its limits, «Можно тратить» and the status of a category are about the
 * plan, and the plan is what the window bounds. A report is about the calendar: «сколько ушло в
 * октябре», «за квартал», «с 1 по 15 октября». The two meet exactly when the window is the
 * calendar month, which is every plan the app itself opens (onboarding and `carryBudgetForward`
 * write the first and the last day of a month). A window that is not a calendar month — one that
 * arrived in a backup or through the family journal — still bounds the plan, and the report still
 * counts the calendar: the two figures then differ, and each is right about its own question.
 *
 * Counted, as in the budget: posted incomes, expenses and refunds, each by the base-currency
 * snapshot it carries (so a new rate never revalues the past), refunds netted against the
 * category they return to. Transfers, goal contributions and debt movements are neither income nor
 * expense (rule 4 of the contracts) and count in no figure here, tags included. An operation with
 * two tags counts in both, so tag figures do not add up to the total and their shares may exceed
 * one hundred per cent.
 *
 * Every transaction is validated whatever its date and status, as in `calculateTagExpenses`, so a
 * report is never drawn from a state the main calculation refuses.
 */

/** The days of a report, both included, and the accounts it looks at. */
export interface PeriodQuery {
  readonly from: LocalDate;
  readonly to: LocalDate;
  /**
   * Only the operations of these accounts. Omitted — every account. An empty list matches nothing:
   * a filter that names no account is not «all accounts».
   */
  readonly accountIds?: readonly AccountId[];
}

/** One category's movement in the period, in the base currency. */
export interface PeriodCategoryAmount {
  /** The category; `null` — income without a category (D-026). */
  readonly categoryId: CategoryId | null;
  /** Expenses (on the expense side) or incomes (on the income side). */
  readonly grossMinor: MinorUnits;
  /** Refunds into the category; always zero on the income side. */
  readonly refundMinor: MinorUnits;
  /** gross − refund: negative when the refunds of the period exceed its expenses. */
  readonly netMinor: MinorUnits;
  /** Posted operations counted for the category. */
  readonly transactionCount: number;
}

export interface PeriodSide {
  /** Net: gross − refunds. */
  readonly totalMinor: MinorUnits;
  readonly grossMinor: MinorUnits;
  readonly refundsMinor: MinorUnits;
  /**
   * Every category that moved in the period, by net amount from the largest; ties keep the order
   * of `state.categories`, and income without a category comes after the categories it ties with.
   */
  readonly categories: readonly PeriodCategoryAmount[];
}

export interface PeriodBreakdown {
  readonly from: LocalDate;
  readonly to: LocalDate;
  readonly baseCurrency: CurrencyCode;
  readonly expense: PeriodSide;
  readonly income: PeriodSide;
  /** Every tag of the state in declaration order, archived ones included, zeros included. */
  readonly tags: readonly TagMetrics[];
  /** Posted incomes, expenses and refunds counted. */
  readonly transactionCount: number;
}

export interface MonthlySeriesOptions {
  readonly accountIds?: readonly AccountId[];
}

/** One calendar month of a series, in the base currency. */
export interface MonthlyAmount {
  /** `ГГГГ-ММ`. */
  readonly month: string;
  readonly from: LocalDate;
  readonly to: LocalDate;
  /** Net expenses: expenses − refunds. */
  readonly expenseMinor: MinorUnits;
  readonly grossExpensesMinor: MinorUnits;
  readonly refundsMinor: MinorUnits;
  readonly incomeMinor: MinorUnits;
}

export interface MonthlySeries {
  readonly baseCurrency: CurrencyCode;
  /** In the order the months were asked for. */
  readonly months: readonly MonthlyAmount[];
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function assertPeriodDate(value: unknown, label: string): asserts value is LocalDate {
  if (typeof value !== "string" || !LOCAL_DATE.test(value) || !isWithinDateWindow(value)) {
    throw new Error(`${label} must be a date YYYY-MM-DD inside the calendar window`);
  }
  // A real day of its month: 2026-02-30 is not a period edge.
  if (value > monthEndDate(value.slice(0, 7), label)) throw new Error(`${label} is not a day of its month`);
}

function add(left: MinorUnits, right: MinorUnits, label: string): MinorUnits {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error(`${label} leaves the safe integer range`);
  return sum;
}

type Counted = Extract<Transaction, { readonly kind: "income" | "expense" | "refund" }>;

function isCounted(transaction: Transaction): transaction is Counted {
  return transaction.kind === "income" || transaction.kind === "expense" || transaction.kind === "refund";
}

function accountFilter(accountIds: readonly AccountId[] | undefined): (transaction: Counted) => boolean {
  if (accountIds === undefined) return () => true;
  const wanted = new Set(accountIds);
  return (transaction) => wanted.has(transaction.accountId);
}

interface Totals { gross: MinorUnits; refund: MinorUnits; count: number }

function sideOf(
  totals: ReadonlyMap<CategoryId | null, Totals>,
  order: ReadonlyMap<CategoryId, number>,
  label: string,
): PeriodSide {
  let grossMinor = 0;
  let refundsMinor = 0;
  const categories: PeriodCategoryAmount[] = [];
  for (const [categoryId, value] of totals) {
    grossMinor = add(grossMinor, value.gross, `${label} grossMinor`);
    refundsMinor = add(refundsMinor, value.refund, `${label} refundsMinor`);
    categories.push({
      categoryId,
      grossMinor: value.gross,
      refundMinor: value.refund,
      netMinor: add(value.gross, -value.refund, `${label} netMinor`),
      transactionCount: value.count,
    });
  }
  const rank = (id: CategoryId | null) => (id === null ? Number.MAX_SAFE_INTEGER : order.get(id) ?? Number.MAX_SAFE_INTEGER - 1);
  categories.sort((left, right) => right.netMinor - left.netMinor || rank(left.categoryId) - rank(right.categoryId));
  return { totalMinor: add(grossMinor, -refundsMinor, `${label} totalMinor`), grossMinor, refundsMinor, categories };
}

/**
 * The calendar period `from` … `to` by category and by tag: expenses with refunds netted, incomes
 * with «without a category», every tag, and the totals — in the base currency, posted operations
 * only. See the header of this module for how a calendar period relates to a budget's window.
 */
export function calculatePeriodBreakdown(state: BudgetState, query: PeriodQuery): PeriodBreakdown {
  assertPeriodDate(query.from, "period from");
  assertPeriodDate(query.to, "period to");
  if (query.from > query.to) throw new Error("period from must not be after period to");
  const index = indexState(state);
  const onAccount = accountFilter(query.accountIds);
  const order = new Map(state.categories.map((category, position) => [category.id, position]));

  const expense = new Map<CategoryId | null, Totals>();
  const income = new Map<CategoryId | null, Totals>();
  interface TagTotals { income: MinorUnits; expense: MinorUnits; refund: MinorUnits; count: number }
  const tags = new Map<TagId, TagTotals>();
  for (const tag of index.tags.values()) tags.set(tag.id, { income: 0, expense: 0, refund: 0, count: 0 });
  let transactionCount = 0;

  for (const transaction of state.transactions) {
    validateTransactionReferences(transaction, index);
    if (transaction.status !== "posted" || !isCounted(transaction)) continue;
    if (transaction.occurredOn < query.from || transaction.occurredOn > query.to || !onAccount(transaction)) continue;
    const baseMinor = baseAmountOf(transaction);
    transactionCount += 1;
    const side = transaction.kind === "income" ? income : expense;
    const key = transaction.categoryId ?? null;
    const current = side.get(key) ?? { gross: 0, refund: 0, count: 0 };
    side.set(key, transaction.kind === "refund"
      ? { gross: current.gross, refund: add(current.refund, baseMinor, "category refundMinor"), count: current.count + 1 }
      : { gross: add(current.gross, baseMinor, "category grossMinor"), refund: current.refund, count: current.count + 1 });
    for (const tagId of transaction.tagIds ?? []) {
      const tag = tags.get(tagId)!;
      tags.set(tagId, {
        income: transaction.kind === "income" ? add(tag.income, baseMinor, "tag incomeMinor") : tag.income,
        expense: transaction.kind === "expense" ? add(tag.expense, baseMinor, "tag expenseMinor") : tag.expense,
        refund: transaction.kind === "refund" ? add(tag.refund, baseMinor, "tag refundMinor") : tag.refund,
        count: tag.count + 1,
      });
    }
  }

  return {
    from: query.from,
    to: query.to,
    baseCurrency: index.baseCurrency,
    expense: sideOf(expense, order, "expense"),
    income: sideOf(income, order, "income"),
    tags: [...tags].map(([tagId, value]) => ({
      tagId,
      incomeMinor: value.income,
      expenseMinor: value.expense,
      refundMinor: value.refund,
      actualMinor: add(value.expense, -value.refund, "tag actualMinor"),
      transactionCount: value.count,
    })),
    transactionCount,
  };
}

/**
 * Calendar months side by side — «По месяцам» of «Отчёты»: for each month asked, its net expenses
 * and its incomes by the same rules as {@link calculatePeriodBreakdown}, in one pass over the
 * operations. Each month is the whole calendar month, whatever window a budget gives it.
 */
export function calculateMonthlySeries(
  state: BudgetState,
  months: readonly string[],
  options: MonthlySeriesOptions = {},
): MonthlySeries {
  for (const month of months) monthIndex(month, "series month");
  const index = indexState(state);
  const onAccount = accountFilter(options.accountIds);
  interface MonthTotals { expense: MinorUnits; refund: MinorUnits; income: MinorUnits }
  const totals = new Map<string, MonthTotals>();
  for (const month of months) totals.set(month, { expense: 0, refund: 0, income: 0 });

  for (const transaction of state.transactions) {
    validateTransactionReferences(transaction, index);
    if (transaction.status !== "posted" || !isCounted(transaction) || !onAccount(transaction)) continue;
    const current = totals.get(transaction.occurredOn.slice(0, 7));
    if (current === undefined) continue;
    const baseMinor = baseAmountOf(transaction);
    if (transaction.kind === "income") current.income = add(current.income, baseMinor, "month incomeMinor");
    else if (transaction.kind === "expense") current.expense = add(current.expense, baseMinor, "month grossExpensesMinor");
    else current.refund = add(current.refund, baseMinor, "month refundsMinor");
  }

  return {
    baseCurrency: index.baseCurrency,
    months: months.map((month) => {
      const value = totals.get(month)!;
      return {
        month,
        from: monthStartDate(month),
        to: monthEndDate(month),
        expenseMinor: add(value.expense, -value.refund, "month expenseMinor"),
        grossExpensesMinor: value.expense,
        refundsMinor: value.refund,
        incomeMinor: value.income,
      };
    }),
  };
}
