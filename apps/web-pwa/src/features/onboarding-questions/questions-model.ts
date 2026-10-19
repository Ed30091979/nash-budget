import {
  CATEGORY_SUGGESTIONS,
  categoriesInListOrder,
  categoryNameKey,
  type BudgetState,
  type CategoryGroup,
} from "@family-budget/domain";
import { categoryVisual, type CategoryTone } from "../../category-visual";
import type { IconName } from "../../components/Icon";
import { ALWAYS_ACTIVE_EXPENSE, ARCHIVED_STARTERS, PRESET_EXPENSES } from "../../onboarding/model";
import { daysBetween } from "../../reach";
import { archiveCategoryWithLimits } from "../categories/category-model";
import { createOperationCategory, restoreCategory } from "../operations/model";
import { QUESTION_IDS, type FirstRunState, type QuestionId, type QuestionRecord } from "./memory";

/*
 * Вопросы первого запуска (§e, пп. 3–5): какой задать сейчас и что сделает ответ. Чистые функции —
 * экран ничего не решает сам, и проверки сверяют правила здесь.
 */

/** Отложенный вопрос возвращается один раз — через неделю; отложенный дважды больше не спрашивается. */
export const LATER_RETURN_DAYS = 7;
export const LATER_LIMIT = 2;

/** Набор этого устройства: вопросы, подсказка и всё остальное §e начинаются отсюда. */
export function beginFirstRun(today: string): FirstRunState {
  const pending: QuestionRecord = { status: "pending", on: today, postponed: 0 };
  return {
    startedOn: today,
    questions: Object.fromEntries(QUESTION_IDS.map((id) => [id, pending])),
    coach: "pending",
    closedHints: [],
  };
}

/** Можно ли задать этот вопрос сегодня. */
export function questionDue(record: QuestionRecord | undefined, today: string): boolean {
  if (record === undefined) return false;
  if (record.status === "pending" || record.status === "asked") return true;
  if (record.status === "later") {
    const waited = daysBetween(record.on, today);
    return record.postponed < LATER_LIMIT && Number.isFinite(waited) && waited >= LATER_RETURN_DAYS;
  }
  return false;
}

/**
 * Вопрос, который задать сейчас: первый по порядку, которому пора, — или `null`. По одному за раз:
 * следующий появляется, когда на прежний ответили или его отложили. Без набора на этом устройстве
 * (`startedOn === null`) — ничего: у того, кто открыл демо или вёл бюджет раньше, вопросов нет.
 */
export function nextQuestion(state: FirstRunState, today: string): QuestionId | null {
  if (state.startedOn === null) return null;
  return QUESTION_IDS.find((id) => questionDue(state.questions[id], today)) ?? null;
}

function withQuestion(state: FirstRunState, id: QuestionId, record: QuestionRecord): FirstRunState {
  return { ...state, questions: { ...state.questions, [id]: record } };
}

/** Лист показан: если его закроют перезагрузкой, он покажется снова. */
export function markAsked(state: FirstRunState, id: QuestionId, today: string): FirstRunState {
  const current = state.questions[id];
  if (current === undefined || current.status !== "pending") return state;
  return withQuestion(state, id, { ...current, status: "asked", on: today });
}

export function markAnswered(state: FirstRunState, id: QuestionId, today: string): FirstRunState {
  const current = state.questions[id] ?? { status: "pending", on: today, postponed: 0 };
  return withQuestion(state, id, { ...current, status: "answered", on: today });
}

/** Крестик «Спросить позже»: набор остаётся как есть, вопрос вернётся по правилу выше. */
export function markLater(state: FirstRunState, id: QuestionId, today: string): FirstRunState {
  const current = state.questions[id] ?? { status: "pending", on: today, postponed: 0 };
  return withQuestion(state, id, { status: "later", on: today, postponed: current.postponed + 1 });
}

/* ───────────── «На что вы тратите?» ───────────── */

/** Три подсказки домена, которые лист предлагает рядом с оставшимися стартовыми (03). */
export const OFFERED_SUGGESTIONS: readonly string[] = ["Автомобиль", "Питомцы", "Отпуск и поездки"];

export interface CategoryChip {
  /** Ключ имени (`categoryNameKey`): по нему выбор переживает перерисовку. */
  readonly key: string;
  readonly name: string;
  /** Активная категория бюджета, архивная стартовая или подсказка, которой в бюджете нет. */
  readonly source: "active" | "archived" | "suggestion";
  readonly categoryId: string | null;
  readonly group: CategoryGroup;
  readonly icon: IconName;
  readonly tone: CategoryTone;
}

export interface CategoryChips {
  /** «Частые — уже отмечены»: активные категории расходов, кроме «Прочего», которое есть всегда. */
  readonly frequent: readonly CategoryChip[];
  /** «Добавить»: оставшиеся стартовые (в архиве), убранные в архив частые и три подсказки домена. */
  readonly more: readonly CategoryChip[];
}

/** Чипы листа по нынешнему бюджету: частые — в порядке набора, затем оставшиеся. */
export function categoryChips(state: BudgetState): CategoryChips {
  const expense = state.categories.filter((category) => category.type === "expense");
  const always = categoryNameKey(ALWAYS_ACTIVE_EXPENSE);
  const chip = (name: string, source: CategoryChip["source"], categoryId: string | null, group: CategoryGroup): CategoryChip => {
    const visual = categoryVisual({ name, type: "expense", group });
    return { key: categoryNameKey(name), name, source, categoryId, group, icon: visual.icon, tone: visual.tone };
  };
  // Порядок листа — порядок набора (§e: от «Продуктов» до «Подарков»); своё — следом, по месту в списке.
  const presetIndex = (name: string) => {
    const index = PRESET_EXPENSES.findIndex((preset) => categoryNameKey(preset) === categoryNameKey(name));
    return index === -1 ? PRESET_EXPENSES.length : index;
  };
  const frequent = categoriesInListOrder(expense, "expense")
    .filter((category) => categoryNameKey(category.name) !== always)
    .map((category, order) => ({ category, order }))
    .sort((left, right) => presetIndex(left.category.name) - presetIndex(right.category.name) || left.order - right.order)
    .map(({ category }) => chip(category.name, "active", category.id, category.group as CategoryGroup));
  const taken = new Set(frequent.map((item) => item.key));
  taken.add(always);
  const more: CategoryChip[] = [];
  // Частые из набора, убранные в архив прежним ответом, тоже здесь: вернуть их — одно касание.
  for (const name of [...ARCHIVED_STARTERS, ...PRESET_EXPENSES, ...OFFERED_SUGGESTIONS]) {
    const key = categoryNameKey(name);
    if (taken.has(key)) continue;
    taken.add(key);
    const archived = expense.find((category) => !category.active && categoryNameKey(category.name) === key);
    if (archived !== undefined) {
      more.push(chip(archived.name, "archived", archived.id, archived.group as CategoryGroup));
      continue;
    }
    if (PRESET_EXPENSES.some((item) => categoryNameKey(item) === key)) continue;
    const template = CATEGORY_SUGGESTIONS.find((item) => item.type === "expense" && categoryNameKey(item.name) === key);
    const starter = ARCHIVED_STARTERS.some((item) => categoryNameKey(item) === key);
    if (template !== undefined) more.push(chip(template.name, "suggestion", null, template.group ?? "other"));
    else if (starter) more.push(chip(name, "suggestion", null, "other"));
  }
  return { frequent, more };
}

/** Что отмечено, когда лист открылся: все частые, ни одного из «Добавить». */
export function initialChoice(chips: CategoryChips): ReadonlySet<string> {
  return new Set(chips.frequent.map((item) => item.key));
}

/**
 * «Готово»: неотмеченные частые уходят в архив (их лимиты открытых месяцев гаснут вместе с ними),
 * отмеченные архивные возвращаются, отмеченные подсказки заводятся. «Прочее» не трогается.
 * Каждый шаг — правило домена; отказ любого из них отменяет весь выбор, и бюджет остаётся прежним.
 */
export function applyCategoryChoice(
  state: BudgetState,
  chips: CategoryChips,
  chosen: ReadonlySet<string>,
  makeId?: () => string,
): BudgetState {
  let next = state;
  for (const item of chips.frequent) {
    if (chosen.has(item.key) || item.categoryId === null) continue;
    const current = next.categories.find((category) => category.id === item.categoryId);
    if (current?.active) next = archiveCategoryWithLimits(next, item.categoryId);
  }
  for (const item of chips.more) {
    if (!chosen.has(item.key)) continue;
    const present = next.categories.find((category) => category.type === "expense" && categoryNameKey(category.name) === item.key);
    if (present?.active) continue;
    if (present !== undefined) {
      next = restoreCategory(next, present.id);
      continue;
    }
    next = createOperationCategory(next, { name: item.name, type: "expense", group: item.group, limit: "" }, makeId).state;
  }
  return next;
}

/* ───────────── «Когда приходит зарплата?» ───────────── */

export type PaydayOption = "5-20" | "10-25" | "15-30" | "1-15" | "custom" | "none";

/** Варианты листа (04): готовые пары, «Другие числа» и «Нет постоянной». */
export const PAYDAY_OPTIONS: readonly { readonly id: PaydayOption; readonly label: string; readonly days: readonly number[] | null }[] = [
  { id: "5-20", label: "5-го и 20-го", days: [5, 20] },
  { id: "10-25", label: "10-го и 25-го", days: [10, 25] },
  { id: "15-30", label: "15-го и 30-го", days: [15, 30] },
  { id: "1-15", label: "1-го и 15-го", days: [1, 15] },
  { id: "custom", label: "Другие числа", days: null },
  { id: "none", label: "Нет постоянной", days: null },
];

/** Сколько чисел можно отметить в «Других числах» — столько же, сколько хранит хозяйство. */
export const MAX_CUSTOM_PAYDAYS = 4;

/** Ответ листа: дни выплат для `setHouseholdPaydays`, `null` — «Нет постоянной», `undefined` — ответа ещё нет. */
export function paydayAnswer(option: PaydayOption | null, custom: readonly number[]): readonly number[] | null | undefined {
  if (option === null) return undefined;
  if (option === "none") return null;
  if (option === "custom") return custom.length === 0 ? undefined : [...custom].sort((left, right) => left - right);
  return PAYDAY_OPTIONS.find((item) => item.id === option)?.days ?? undefined;
}

/** Отметить или снять число в «Других числах»: не больше четырёх, по возрастанию. */
export function toggleCustomPayday(days: readonly number[], day: number): readonly number[] {
  if (days.includes(day)) return days.filter((item) => item !== day);
  if (days.length >= MAX_CUSTOM_PAYDAYS) return days;
  return [...days, day].sort((left, right) => left - right);
}
