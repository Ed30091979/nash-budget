import {
  CATEGORY_GROUPS,
  CATEGORY_NAME_MAX_LENGTH,
  categoriesInGroupOrder,
  CategoryValidationError,
  monthOfDate,
  resolveCategoryGroup,
  updateCategory,
  type BudgetLine,
  type BudgetState,
  type Category,
  type CategoryGroup,
  type CategoryPatch,
  type CategoryType,
} from "@family-budget/domain";
import { categoryVisual, iconOfKey, toneOfKey, type CategoryTone, type CategoryVisual } from "../../category-visual";
import type { IconName } from "../../components/Icon";
import { monthName } from "../../date-words";
import { writeFailureText } from "../../write/useBudgetWrite";
import { archiveCategory, OperationsValidationError, restoreCategory } from "../operations/model";
import {
  archiveFlexibleLine,
  createFlexibleLine,
  editFlexibleLine,
  PlanningValidationError,
  reactivateFlexibleLine,
} from "../planning/model";

/**
 * Категории и источники дохода (план волны 2, §1.7): данные списка и формы, без React. Имя,
 * группа, иконка и тон — домен (`updateCategory`, `moveCategory`); лимит текущего месяца — те же
 * переходы, что у «Плана месяца» (`createFlexibleLine`, `editFlexibleLine`, `archiveFlexibleLine`,
 * `reactivateFlexibleLine`); архив и возврат — те же, что у формы операции. Удаления нет (D-030).
 */

export { CATEGORY_NAME_MAX_LENGTH };

/** Строка бюджета месяца плана для категории — какая есть, активная или в архиве. */
function activeBudgetOf(state: BudgetState) {
  return state.budgets.find((budget) => budget.id === state.activeBudgetId);
}

function lineOf(state: BudgetState, categoryId: string) {
  return activeBudgetOf(state)?.lines.find((line) => line.categoryId === categoryId);
}

/** Лимит категории в месяце плана: план строки, пока она активна; иначе лимита нет. */
export function categoryLimit(state: BudgetState, categoryId: string): number | null {
  const line = lineOf(state, categoryId);
  return line === undefined || line.active === false ? null : line.plannedMinor;
}

/** «октябрь» — месяц плана, в котором лимит действует; `null` — плана нет. */
export function planMonthWord(state: BudgetState): string | null {
  const budget = activeBudgetOf(state);
  return budget === undefined ? null : monthName(monthOfDate(budget.startDate));
}

export interface CategoryCard {
  readonly category: Category;
  readonly visual: CategoryVisual;
  readonly limitMinor: number | null;
}

export interface CategoryGroupView {
  readonly key: CategoryGroup;
  readonly title: string;
  readonly cards: readonly CategoryCard[];
}

export interface CategoriesView {
  readonly groups: readonly CategoryGroupView[];
  readonly archived: readonly CategoryCard[];
}

/** Список одного вида: группы в их порядке, внутри — порядок группы; архив — отдельно, по имени. */
export function categoriesView(state: BudgetState, type: CategoryType): CategoriesView {
  const card = (category: Category): CategoryCard => ({
    category,
    visual: categoryVisual(category),
    limitMinor: type === "expense" && category.active ? categoryLimit(state, category.id) : null,
  });
  const groups = CATEGORY_GROUPS.filter((group) => group.type === type).map((group) => ({
    key: group.key,
    title: group.title,
    cards: categoriesInGroupOrder(state.categories, type, group.key).map(card),
  }));
  const archived = state.categories
    .filter((category) => category.type === type && !category.active)
    .sort((left, right) => left.name.localeCompare(right.name, "ru"))
    .map(card);
  return { groups, archived };
}

/** Место категории в её группе — для «Выше / Ниже»; у архивной — ноль. */
export function categoryPosition(state: BudgetState, category: Category): { readonly position: number; readonly count: number } {
  if (!category.active) return { position: 0, count: 0 };
  const members = categoriesInGroupOrder(state.categories, category.type, resolveCategoryGroup(category));
  return { position: members.findIndex((item) => item.id === category.id) + 1, count: members.length };
}

/** Форма категории так, как её набирают. */
export interface CategoryFormDraft {
  readonly name: string;
  readonly group: CategoryGroup;
  /** Иконка; `null` — «Авто», по имени и группе. */
  readonly icon: IconName | null;
  /** Тон; `null` — «Авто». */
  readonly tone: CategoryTone | null;
  /** Лимит месяца плана текстом; пусто — без лимита. Только у расходов. */
  readonly limit: string;
}

/** Сумма лимита текстом поля: «30000», «1250,50». */
function limitText(minor: number | null): string {
  if (minor === null) return "";
  const whole = Math.trunc(minor / 100);
  const fraction = minor % 100;
  return fraction === 0 ? String(whole) : `${whole},${String(fraction).padStart(2, "0")}`;
}

export function categoryDraftOf(state: BudgetState, category: Category): CategoryFormDraft {
  return {
    name: category.name,
    group: resolveCategoryGroup(category),
    icon: iconOfKey(Object.hasOwn(category, "icon") ? category.icon : undefined),
    tone: toneOfKey(Object.hasOwn(category, "color") ? category.color : undefined),
    limit: category.type === "expense" ? limitText(categoryLimit(state, category.id)) : "",
  };
}

function normalLimit(text: string): string {
  return text.replace(/\s/gu, "").replace(".", ",").replace(/,0*$/u, "").replace(/(,\d*?)0+$/u, "$1");
}

/** Отличается ли форма от снимка при открытии. */
export function categoryDraftDiffers(left: CategoryFormDraft, right: CategoryFormDraft): boolean {
  return left.name.trim() !== right.name.trim() || left.group !== right.group || left.icon !== right.icon
    || left.tone !== right.tone || normalLimit(left.limit) !== normalLimit(right.limit);
}

/**
 * Одна запись по форме: имя, группа, иконка и тон — только изменённые (`updateCategory`), лимит —
 * переходом плана, только если он изменился: пусто снимает лимит, сумма — правит, возвращает из
 * архива или заводит строку месяца плана. Правка имени и лимита — одно изменение состояния.
 */
export function categorySave(category: Category, draft: CategoryFormDraft, pristine: CategoryFormDraft) {
  const patch: CategoryPatch = {
    ...(draft.name.trim() !== pristine.name.trim() ? { name: draft.name } : {}),
    ...(draft.group !== pristine.group ? { group: draft.group } : {}),
    ...(draft.icon !== pristine.icon ? { icon: draft.icon } : {}),
    ...(draft.tone !== pristine.tone ? { color: draft.tone } : {}),
  };
  const limitChanged = category.type === "expense" && normalLimit(draft.limit) !== normalLimit(pristine.limit);
  return (state: BudgetState): BudgetState => {
    let next = Object.keys(patch).length === 0 ? state : updateCategory(state, category.id, patch);
    const renamed = next.categories.find((item) => item.id === category.id) ?? category;
    // Лимит — только у активной категории: архивную по имени план не нашёл бы и завёл бы тёзку.
    if (!limitChanged || !renamed.active) return next;
    const amount = draft.limit.trim();
    const line = lineOf(next, category.id);
    if (amount === "") {
      return line === undefined || line.active === false ? next : archiveFlexibleLine(next, line.id);
    }
    if (line === undefined) return createFlexibleLine(next, { name: renamed.name, amount });
    next = editFlexibleLine(next, line.id, { name: renamed.name, amount });
    return line.active === false ? reactivateFlexibleLine(next, line.id) : next;
  };
}

/**
 * Архив категории с экрана категорий: её лимиты в открытых месяцах — месяце плана и черновиках
 * следующих — гаснут вместе с ней: у архивной категории доступно ноль, и строка лимита в плане
 * без категории на экране была бы призраком. Закрытые месяцы архив не трогает: их строки — прошлое,
 * и после «Вернуть» цифры прошлых месяцев те же, что до архива. Снятый лимит открытого месяца при
 * возврате не возвращается — его задают заново. Регулярный и крупный платёж по категории архив
 * по-прежнему не пропускают (`archiveCategory`).
 */
export function archiveCategoryWithLimits(state: BudgetState, categoryId: string): BudgetState {
  const withoutLines: BudgetState = {
    ...state,
    budgets: state.budgets.map((budget) => (
      budget.status !== "closed" && budget.lines.some((line) => holdsLimit(line, categoryId))
        ? { ...budget, lines: budget.lines.map((line) => (holdsLimit(line, categoryId) ? { ...line, active: false } : line)) }
        : budget
    )),
  };
  return archiveCategory(withoutLines, categoryId, { closedMonthsKeepLimits: true });
}

function holdsLimit(line: BudgetLine, categoryId: string): boolean {
  return line.categoryId === categoryId && line.active !== false;
}

/**
 * Что спросить перед архивом — ровно то, что он сделает: уйдёт с «Обзора» и из выбора, операции
 * останутся; лимиты открытых месяцев снимутся и при возврате не вернутся; закрытые месяцы — как были.
 */
export function categoryArchiveText(state: BudgetState, category: Category): string {
  const income = category.type === "income";
  const open = state.budgets
    .filter((budget) => budget.status !== "closed" && budget.lines.some((line) => holdsLimit(line, category.id)))
    .sort((left, right) => (left.startDate < right.startDate ? -1 : 1))
    .map((budget) => monthName(monthOfDate(budget.startDate)));
  const closed = state.budgets.some((budget) => budget.status === "closed" && budget.lines.some((line) => line.categoryId === category.id));
  const parts = [
    `${income ? "Источник уйдёт" : "Категория уйдёт"} с «Обзора» и из выбора при записи. Записанные операции останутся в «Операциях» и отчётах.`,
    open.length === 0 ? null : open.length === 1
      ? `Лимит на ${open[0]} снимется и при возврате не вернётся — его можно будет задать заново.`
      : `Лимиты на ${open.slice(0, -1).join(", ")} и ${open[open.length - 1]} снимутся и при возврате не вернутся — их можно будет задать заново.`,
    closed ? "Закрытые месяцы не меняются: их лимиты по ней останутся как были." : null,
    "Вернуть можно в любой момент.",
  ];
  return parts.filter((part) => part !== null).join(" ");
}

export { restoreCategory };

export type CategoryFormField = "name" | "group" | "icon" | "tone" | "limit" | "form";

export interface CategoryFormError {
  readonly field: CategoryFormField;
  readonly message: string;
}

/** Отказ записи — у своего поля: доменный, плана, формы операции; прочее — у формы. */
export function categoryFormError(error: unknown): CategoryFormError {
  if (error instanceof CategoryValidationError) {
    const field: CategoryFormField = error.field === "name" || error.field === "group" || error.field === "icon" ? error.field : error.field === "color" ? "tone" : "form";
    return { field, message: error.message };
  }
  if (error instanceof PlanningValidationError) {
    return { field: error.field === "amount" ? "limit" : error.field === "name" ? "name" : "form", message: error.message };
  }
  if (error instanceof OperationsValidationError) return { field: "form", message: error.message };
  return { field: "form", message: writeFailureText(error) };
}
