import { categoriesInListOrder, categoryNameKey, type BudgetState } from "@family-budget/domain";
import { daysBetween } from "../../reach";
import { HINT_IDS, type FirstRunState, type HintId } from "./memory";

/*
 * Подсказка на первую трату и карточки-подсказки «Обзора» (DIRECTION §e, пп. 6–7): когда что
 * показывать. Чистые функции — экран ничего не решает сам.
 */

/** Категория, на которую смотрит подсказка на первую трату: «Продукты», без них — первая плитка расходов. */
export function coachCategoryId(budget: BudgetState): string | null {
  const active = categoriesInListOrder(budget.categories, "expense");
  const food = active.find((category) => categoryNameKey(category.name) === categoryNameKey("Продукты"));
  return (food ?? active[0])?.id ?? null;
}

/**
 * Показывать ли подсказку на первую трату: набор создан на этом устройстве, подсказку не закрывали,
 * записей ещё нет и ни один вопрос не ждёт ответа. По времени она не пропадает никогда (WCAG 2.2.1):
 * только после первой записи или «Понятно».
 */
export function coachVisible(state: FirstRunState | null, budget: BudgetState, questionPending: boolean): boolean {
  return state !== null
    && state.startedOn !== null
    && state.coach === "pending"
    && budget.transactions.length === 0
    && !questionPending;
}

/** Первая запись сделана — подсказка больше не нужна: это и есть её «Понятно». */
export function coachDone(state: FirstRunState | null, budget: BudgetState): boolean {
  return state !== null && state.coach === "pending" && budget.transactions.length > 0;
}

export function finishCoach(state: FirstRunState): FirstRunState {
  return state.coach === "done" ? state : { ...state, coach: "done" };
}

/** Карточка закрыта крестиком — навсегда, на этом устройстве. */
export function closeHint(state: FirstRunState, id: HintId): FirstRunState {
  return state.closedHints.includes(id) ? state : { ...state, closedHints: HINT_IDS.filter((item) => item === id || state.closedHints.includes(item)) };
}

/** Больше двух карточек сразу «Обзор» не показывает (§e, п. 7). */
export const MAX_HINTS = 2;
/** «Сделайте копию данных» — после десяти записей или недели с начала. */
export const BACKUP_AFTER_RECORDS = 10;
export const BACKUP_AFTER_DAYS = 7;
/** «Поставьте цель» — когда записи уже вошли в привычку. */
export const GOAL_AFTER_RECORDS = 10;
/** «Ведёте бюджет вдвоём?» — поздняя карточка: через месяц записей или две недели. */
export const FAMILY_AFTER_RECORDS = 30;
export const FAMILY_AFTER_DAYS = 14;

export interface HintInput {
  readonly state: FirstRunState;
  readonly budget: BudgetState;
  readonly today: string;
  /** «На счетах» — `calculateHoldings(...).totalInBaseMinor`. */
  readonly totalInBaseMinor: number;
  /** Последняя успешная копия; `null` — копии на этом устройстве ещё не было. */
  readonly lastSuccessfulBackup: string | null;
  readonly inFamily: boolean;
}

/**
 * С какого дня считать «неделю с начала»: день набора на этом устройстве, а у бюджета, заведённого
 * раньше, — день первой записи.
 */
function startedOn(input: HintInput): string {
  if (input.state.startedOn !== null) return input.state.startedOn;
  const first = input.budget.transactions.reduce<string | null>((earliest, item) => (earliest === null || item.occurredOn < earliest ? item.occurredOn : earliest), null);
  return first !== null && first < input.today ? first : input.today;
}

/** Каждая карточка — когда она к месту. */
export function hintEligible(id: HintId, input: HintInput): boolean {
  const records = input.budget.transactions.length;
  const days = daysBetween(startedOn(input), input.today);
  const waited = (limit: number) => Number.isFinite(days) && days >= limit;
  switch (id) {
    case "opening-balance":
      return input.totalInBaseMinor === 0 && input.budget.accounts.some((account) => account.active);
    case "backup":
      return input.lastSuccessfulBackup === null && (records >= BACKUP_AFTER_RECORDS || waited(BACKUP_AFTER_DAYS));
    case "import":
      return records > 0;
    case "goal":
      return input.budget.goals.length === 0 && records >= GOAL_AFTER_RECORDS;
    case "family":
      return !input.inFamily && (records >= FAMILY_AFTER_RECORDS || waited(FAMILY_AFTER_DAYS));
  }
}

/** Карточки, которые стоят в конце «Обзора» сейчас: по важности, не закрытые, не больше двух. */
export function visibleHints(input: HintInput): readonly HintId[] {
  return HINT_IDS.filter((id) => !input.state.closedHints.includes(id) && hintEligible(id, input)).slice(0, MAX_HINTS);
}
