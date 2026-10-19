import {
  baseAmountOf,
  baseCurrencyOf,
  calculateBudget,
  calculateHoldings,
  findBudgetForMonth,
  monthEndDate,
  monthOfDate,
  shiftMonth,
  type Account,
  type BudgetState,
  type CurrencyCode,
} from "@family-budget/domain";
import { accountIcon, categoryVisual, type CategoryVisual } from "../../category-visual";
import type { IconName } from "../../components/Icon";
import { percentStep } from "../../reach";

/**
 * Данные «Обзора» за один месяц (план волны 2, §1.1): плитки доходов, счетов и расходов, «Всего на
 * счетах» и «Потрачено N из M». Чистая функция бюджета, месяца и сегодняшнего дня — экран ничего не
 * считает сам, и проверки сверяют числа здесь, а не по разметке.
 *
 * Месяц календарный. Его лимиты — строки бюджета этого месяца (`findBudgetForMonth`), их расход —
 * тот же расчёт, что у плана (`calculateBudget`); у месяца без бюджета лимитов нет, а расход
 * считается по операциям его дней. Суммы бюджета — в базовой валюте, по снимку каждой операции.
 */

/** Состояние лимита на плитке: цвет — третий носитель после глифа и цифр (DESIGN §9). */
export type LimitStatus = "none" | "normal" | "near" | "over";

export interface CategoryTile {
  readonly id: string;
  readonly name: string;
  readonly visual: CategoryVisual;
  /** Расход месяца за вычетом возвратов, в базовой валюте; бывает отрицательным при лишнем возврате. */
  readonly spentMinor: number;
  /** Лимит месяца — строка бюджета этого месяца; `null` — лимита нет. */
  readonly limitMinor: number | null;
  readonly status: LimitStatus;
  /** Заливка полосы шагом 5 % (`data-fill`): CSP запрещает инлайновый стиль. */
  readonly fill: number;
}

export interface IncomeTile {
  /** Категория дохода; `null` — «Без категории» (D-026). */
  readonly id: string | null;
  readonly name: string;
  readonly icon: IconName;
  readonly amountMinor: number;
}

export interface AccountTile {
  readonly id: string;
  readonly name: string;
  readonly currency: CurrencyCode;
  readonly icon: IconName;
  /** Остаток на конец показанного дня в валюте счёта; `null` — не представим. */
  readonly balanceMinor: number | null;
  /** Счёт оценён в базовой валюте и входит в итог. */
  readonly inTotal: boolean;
  /** Счёт в другой валюте без курса — итог его не видит, и экран говорит это словами. */
  readonly unvalued: boolean;
  readonly includeInTotal: boolean;
}

export interface OverviewModel {
  readonly month: string;
  readonly baseCurrency: CurrencyCode;
  /** День, на который считаются остатки: сегодня или последний день прошедшего месяца. */
  readonly asOf: string;
  /** «Всего на счетах» — `calculateHoldings(...).totalInBaseMinor` (решение по умолчанию, §6). */
  readonly totalInBaseMinor: number;
  /** Счета, которые итог не смог оценить: нет курса или сумма не представима. */
  readonly unvaluedAccounts: readonly AccountTile[];
  /** «Потрачено N из M»: N — расход категорий с лимитом, M — сумма их лимитов; `null` — лимитов нет. */
  readonly spentWithLimitMinor: number;
  readonly limitsMinor: number | null;
  /** Весь расход месяца — когда лимитов нет, «Потрачено» называет его. */
  readonly spentMinor: number;
  readonly incomes: readonly IncomeTile[];
  readonly accounts: readonly AccountTile[];
  readonly categories: readonly CategoryTile[];
  /** Основной счёт: с него записывается расход, если счёт не выбран. */
  readonly defaultAccountId: string | null;
}

/** Название дохода без категории — плитка D-026. */
export const UNCATEGORIZED_INCOME_NAME = "Без категории";

function bySortOrder<T extends { readonly sortOrder?: number }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => (left.item.sortOrder ?? 0) - (right.item.sortOrder ?? 0) || left.index - right.index)
    .map(({ item }) => item);
}

/**
 * Основной счёт: первый активный в базовой валюте по порядку списка, иначе первый активный. Счёт в
 * другой валюте основным не назначается, пока есть рублёвый: расход по нему просит курс.
 */
export function defaultAccountOf(state: BudgetState): Account | null {
  const active = bySortOrder(state.accounts.filter((account) => account.active));
  const base = baseCurrencyOf(state);
  return active.find((account) => account.currency === base) ?? active[0] ?? null;
}

export function limitStatus(spentMinor: number, limitMinor: number | null, warningThreshold: number): LimitStatus {
  if (limitMinor === null) return "none";
  if (spentMinor > limitMinor) return "over";
  if (limitMinor === 0) return spentMinor > 0 ? "over" : "normal";
  return spentMinor / limitMinor >= warningThreshold ? "near" : "normal";
}

function inMonth(date: string, month: string): boolean {
  return monthOfDate(date) === month;
}

/** Последний день месяца или сегодня — что раньше: остатки прошлого месяца — на его конец. */
function asOfFor(month: string, today: string): string {
  const end = monthEndDate(month);
  return end < today ? end : today;
}

export function overviewModel(state: BudgetState, month: string, today: string): OverviewModel {
  const baseCurrency = baseCurrencyOf(state);
  const budget = findBudgetForMonth(state, month);
  const metrics = budget === undefined ? null : calculateBudget(state, budget.id);
  const activeLines = new Set(budget?.lines.filter((line) => line.active !== false).map((line) => line.categoryId) ?? []);

  // Расход и доход месяца по операциям его дней — для месяца без бюджета и для доходов вообще.
  const spentByCategory = new Map<string, number>();
  const incomeByCategory = new Map<string | null, number>();
  for (const transaction of state.transactions) {
    if (transaction.status !== "posted" || !inMonth(transaction.occurredOn, month)) continue;
    if (transaction.kind === "expense" || transaction.kind === "refund") {
      const sign = transaction.kind === "expense" ? 1 : -1;
      spentByCategory.set(transaction.categoryId, (spentByCategory.get(transaction.categoryId) ?? 0) + sign * baseAmountOf(transaction));
    } else if (transaction.kind === "income") {
      const key = transaction.categoryId ?? null;
      incomeByCategory.set(key, (incomeByCategory.get(key) ?? 0) + baseAmountOf(transaction));
    }
  }

  const categories: CategoryTile[] = bySortOrder(state.categories.filter((category) => category.type === "expense" && category.active))
    .map((category) => {
      const metric = metrics?.categoryMetrics[category.id];
      const spentMinor = metric?.actualMinor ?? spentByCategory.get(category.id) ?? 0;
      const limitMinor = metric !== undefined && activeLines.has(category.id) ? metric.availableMinor : null;
      const status = limitStatus(spentMinor, limitMinor, budget?.warningThreshold ?? 1);
      return {
        id: category.id,
        name: category.name,
        visual: categoryVisual(category),
        spentMinor,
        limitMinor,
        status,
        fill: limitMinor === null || limitMinor <= 0 ? (spentMinor > 0 && limitMinor !== null ? 100 : 0) : percentStep(spentMinor / limitMinor),
      };
    });
  const limited = categories.filter((tile) => tile.limitMinor !== null);
  const spentMinor = metrics?.expensesMinor ?? [...spentByCategory.values()].reduce((sum, value) => sum + value, 0);

  const incomeCategories = bySortOrder(state.categories.filter((category) => category.type === "income"));
  const incomes: IncomeTile[] = incomeCategories
    .filter((category) => category.active || (incomeByCategory.get(category.id) ?? 0) !== 0)
    .map((category) => ({
      id: category.id,
      name: category.name,
      icon: categoryVisual(category).icon,
      amountMinor: incomeByCategory.get(category.id) ?? 0,
    }));
  // Доход без категории — законное состояние (D-026): у него своя плитка, когда он есть.
  if ((incomeByCategory.get(null) ?? 0) !== 0) {
    incomes.push({ id: null, name: UNCATEGORIZED_INCOME_NAME, icon: "banknote", amountMinor: incomeByCategory.get(null) ?? 0 });
  }

  const asOf = asOfFor(month, today);
  const holdings = calculateHoldings(state, asOf);
  const unvalued = new Set(holdings.unvaluedAccountIds);
  const accounts: AccountTile[] = bySortOrder(state.accounts.filter((account) => account.active)).map((account) => ({
    id: account.id,
    name: account.name,
    currency: account.currency,
    icon: accountIcon(account),
    balanceMinor: holdings.accountBalancesMinor[account.id] ?? null,
    includeInTotal: account.includeInTotal !== false,
    inTotal: account.includeInTotal !== false && !unvalued.has(account.id),
    unvalued: account.includeInTotal !== false && unvalued.has(account.id),
  }));

  return {
    month,
    baseCurrency,
    asOf,
    totalInBaseMinor: holdings.totalInBaseMinor,
    unvaluedAccounts: accounts.filter((tile) => tile.unvalued),
    spentWithLimitMinor: limited.reduce((sum, tile) => sum + tile.spentMinor, 0),
    limitsMinor: limited.length === 0 ? null : limited.reduce((sum, tile) => sum + (tile.limitMinor ?? 0), 0),
    spentMinor,
    incomes,
    accounts,
    categories,
    defaultAccountId: defaultAccountOf(state)?.id ?? null,
  };
}

/** Месяц соседний по стрелке. */
export function neighbourMonth(month: string, step: -1 | 1): string {
  return shiftMonth(month, step);
}

/** Месяц «Обзора» по умолчанию — тот, в котором сегодня. */
export function currentMonth(today: string): string {
  return monthOfDate(today);
}

/**
 * Строка «Можно на повседневные … · хватает до …» — наше отличие (решение по умолчанию, §6): та же
 * величина, что у прежнего героя «Сегодня», — лимиты повседневных категорий месяца плана минус
 * потраченное по ним, — и та же линейка до выплаты, сказанная словами. Месяц плана — активный
 * бюджет, а не месяц, на который смотрит «Обзор»: стрелки листают плитки, а не план.
 */
export interface ReachLineModel {
  /** Месяц плана, `ГГГГ-ММ`. */
  readonly planMonth: string;
  /** Остаток повседневных лимитов месяца плана. */
  readonly safeToSpendMinor: number;
  /** Потрачено по ним — для темпа в день. */
  readonly flexibleSpentMinor: number;
}

export function reachLineModel(state: BudgetState, flexiblePlanMinor: number): ReachLineModel {
  const budget = state.budgets.find((item) => item.id === state.activeBudgetId);
  const metrics = calculateBudget(state);
  const lines = new Set(budget?.lines.filter((line) => line.active !== false).map((line) => line.categoryId) ?? []);
  const flexibleSpentMinor = state.categories
    .filter((category) => category.active && category.type === "expense" && lines.has(category.id))
    .reduce((sum, category) => sum + (metrics.categoryMetrics[category.id]?.actualMinor ?? 0), 0);
  return {
    planMonth: budget === undefined ? "" : monthOfDate(budget.startDate),
    safeToSpendMinor: flexiblePlanMinor - flexibleSpentMinor,
    flexibleSpentMinor,
  };
}
