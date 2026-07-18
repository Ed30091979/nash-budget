import {
  calculateAnnualPlan,
  type AnnualCommitment,
  type BudgetLine,
  type BudgetState,
  type CommitmentRecurrence,
  type ScheduleMode,
  type ScheduledExpense,
} from "@family-budget/domain";
import { parseMoney } from "../../money";

export const PLANNING_LIMITS = {
  nameLength: 80,
  accounts: 100,
  categories: 500,
  budgets: 120,
  goals: 1_000,
  commitments: 500,
  schedules: 500,
  budgetLines: 500,
  transactions: 10_000,
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FORBIDDEN_FORMATTING_PATTERN = /[\p{Cc}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;
const LABEL_SCRIPT_PATTERNS = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
] as const;

export type PlanningIdFactory = () => string;

export interface CommitmentDraft {
  readonly name: string;
  readonly categoryId: string;
  readonly accountId: string;
  readonly dueDate: string;
  readonly amount: string;
  readonly reserved: string;
  readonly recurrence: CommitmentRecurrence;
}

export interface ScheduleDraft {
  readonly name: string;
  readonly categoryId: string;
  readonly accountId: string;
  readonly amount: string;
  readonly dueDay: string;
  readonly mode: ScheduleMode;
  readonly months: readonly number[];
}

export interface FlexibleDraft {
  readonly name: string;
  readonly amount: string;
}

export class PlanningValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "PlanningValidationError";
    this.field = field;
  }
}

function fail(field: string, message: string): never {
  throw new PlanningValidationError(field, message);
}

function normalizeName(value: string, field = "name"): string {
  if (value.length > PLANNING_LIMITS.nameLength * 4) {
    fail(field, `Не более ${PLANNING_LIMITS.nameLength} символов.`);
  }
  const normalized = value.normalize("NFC").trim();
  if (!normalized) fail(field, "Укажите название.");
  if (normalized.length > PLANNING_LIMITS.nameLength) {
    fail(field, `Не более ${PLANNING_LIMITS.nameLength} символов.`);
  }
  if (FORBIDDEN_FORMATTING_PATTERN.test(normalized)) {
    fail(field, "Уберите скрытые или служебные символы.");
  }
  if (LABEL_SCRIPT_PATTERNS.filter((pattern) => pattern.test(normalized)).length > 1) {
    fail(field, "Не смешивайте похожие символы разных алфавитов.");
  }
  return normalized;
}

function normalizedComparison(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
}

function parsePositiveMoney(value: string, field: string): number {
  try {
    return parseMoney(value);
  } catch {
    return fail(field, "Введите положительную сумму в рублях, не более двух знаков после запятой.");
  }
}

function parseReserved(value: string): number {
  if (value.length > 24) return fail("reserved", "Сумма превышает максимально допустимое значение.");
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (normalized === "" || normalized === "0" || normalized === "0.0" || normalized === "0.00") return 0;
  return parsePositiveMoney(value, "reserved");
}

function assertLocalDate(value: string): string {
  if (!LOCAL_DATE_PATTERN.test(value) || value.startsWith("0000-")) {
    return fail("dueDate", "Выберите календарную дату.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return fail("dueDate", "Выберите существующую календарную дату.");
  }
  return value;
}

function assertDueDay(value: string): number {
  if (!/^\d{1,2}$/.test(value)) return fail("dueDay", "Укажите день от 1 до 31.");
  const day = Number(value);
  if (day < 1 || day > 31) return fail("dueDay", "Укажите день от 1 до 31.");
  return day;
}

function allDocumentIds(state: BudgetState): Set<string> {
  const ids = new Set<string>();
  const accept = (id: string): void => {
    if (!UUID_PATTERN.test(id)) fail("id", "Документ содержит некорректный идентификатор.");
    if (ids.has(id)) fail("id", "Документ содержит повторяющийся идентификатор.");
    ids.add(id);
  };
  state.accounts.forEach((item) => accept(item.id));
  state.categories.forEach((item) => accept(item.id));
  state.budgets.forEach((item) => {
    accept(item.id);
    item.lines.forEach((line) => accept(line.id));
  });
  state.goals.forEach((item) => accept(item.id));
  state.annualCommitments.forEach((item) => accept(item.id));
  state.scheduledExpenses.forEach((item) => accept(item.id));
  state.transactions.forEach((item) => accept(item.id));
  return ids;
}

function nextId(ids: Set<string>, makeId: PlanningIdFactory): string {
  const id = makeId();
  if (!UUID_PATTERN.test(id) || ids.has(id)) fail("id", "Не удалось создать уникальный идентификатор.");
  ids.add(id);
  return id;
}

function validateLimits(state: BudgetState): void {
  if (state.accounts.length > PLANNING_LIMITS.accounts) fail("accounts", "Слишком много счетов.");
  if (state.categories.length > PLANNING_LIMITS.categories) fail("categories", "Слишком много категорий.");
  if (state.budgets.length > PLANNING_LIMITS.budgets) fail("budgets", "Слишком много бюджетных периодов.");
  if (state.goals.length > PLANNING_LIMITS.goals) fail("goals", "Слишком много целей.");
  if (state.annualCommitments.length > PLANNING_LIMITS.commitments) fail("commitments", "Слишком много крупных платежей.");
  if (state.scheduledExpenses.length > PLANNING_LIMITS.schedules) fail("schedules", "Слишком много регулярных платежей.");
  if (state.transactions.length > PLANNING_LIMITS.transactions) fail("transactions", "Слишком много операций для одного локального документа.");
  const lines = state.budgets.reduce((count, budget) => count + budget.lines.length, 0);
  if (lines > PLANNING_LIMITS.budgetLines) fail("lines", "Слишком много повседневных лимитов.");
}

function activeAccount(state: BudgetState, id: string): void {
  if (!state.accounts.some((item) => item.id === id && item.active)) {
    fail("accountId", "Выберите активный счёт.");
  }
}

function activeExpenseCategory(state: BudgetState, id: string): void {
  if (!state.categories.some((item) => item.id === id && item.active && item.type === "expense")) {
    fail("categoryId", "Выберите активную категорию расходов.");
  }
}

function validateResult(state: BudgetState): BudgetState {
  validateLimits(state);
  allDocumentIds(state);
  const activeBudget = state.budgets.find((budget) => budget.id === state.activeBudgetId);
  calculateAnnualPlan(state, activeBudget?.startDate.slice(0, 7), 24);
  return state;
}

function uniqueActiveName(state: BudgetState, name: string, exceptCategoryId?: string): void {
  const key = normalizedComparison(name);
  if (state.categories.some((item) => item.id !== exceptCategoryId && item.active && normalizedComparison(item.name) === key)) {
    fail("name", "Активная категория с таким названием уже существует.");
  }
}

export function createCommitment(
  state: BudgetState,
  draft: CommitmentDraft,
  makeId: PlanningIdFactory = () => crypto.randomUUID(),
): BudgetState {
  validateLimits(state);
  if (state.annualCommitments.length >= PLANNING_LIMITS.commitments) fail("commitments", "Достигнут лимит крупных платежей.");
  activeAccount(state, draft.accountId);
  activeExpenseCategory(state, draft.categoryId);
  const amountMinor = parsePositiveMoney(draft.amount, "amount");
  const reservedMinor = parseReserved(draft.reserved);
  if (reservedMinor > amountMinor) fail("reserved", "Уже накоплено не может превышать сумму платежа.");
  if (draft.recurrence !== "annual" && draft.recurrence !== "one_time") fail("recurrence", "Выберите тип повтора.");
  const ids = allDocumentIds(state);
  const item: AnnualCommitment = {
    id: nextId(ids, makeId),
    name: normalizeName(draft.name),
    categoryId: draft.categoryId,
    accountId: draft.accountId,
    dueDate: assertLocalDate(draft.dueDate),
    amountMinor,
    reservedMinor,
    recurrence: draft.recurrence,
    active: true,
  };
  return validateResult({ ...state, annualCommitments: [...state.annualCommitments, item] });
}

export function editCommitment(state: BudgetState, id: string, draft: CommitmentDraft): BudgetState {
  validateLimits(state);
  const current = state.annualCommitments.find((item) => item.id === id);
  if (!current) fail("id", "Крупный платёж не найден.");
  activeAccount(state, draft.accountId);
  activeExpenseCategory(state, draft.categoryId);
  const amountMinor = parsePositiveMoney(draft.amount, "amount");
  const reservedMinor = parseReserved(draft.reserved);
  if (reservedMinor > amountMinor) fail("reserved", "Уже накоплено не может превышать сумму платежа.");
  if (draft.recurrence !== "annual" && draft.recurrence !== "one_time") fail("recurrence", "Выберите тип повтора.");
  return validateResult({
    ...state,
    annualCommitments: state.annualCommitments.map((item) => item.id === id ? {
      ...item,
      name: normalizeName(draft.name),
      categoryId: draft.categoryId,
      accountId: draft.accountId,
      dueDate: assertLocalDate(draft.dueDate),
      amountMinor,
      reservedMinor,
      recurrence: draft.recurrence,
    } : item),
  });
}

export function setCommitmentActive(state: BudgetState, id: string, active: boolean): BudgetState {
  validateLimits(state);
  const current = state.annualCommitments.find((item) => item.id === id);
  if (!current) fail("id", "Крупный платёж не найден.");
  if (active) {
    activeAccount(state, current.accountId);
    activeExpenseCategory(state, current.categoryId);
  }
  return validateResult({ ...state, annualCommitments: state.annualCommitments.map((item) => item.id === id ? { ...item, active } : item) });
}

function normalizedMonths(mode: ScheduleMode, months: readonly number[]): readonly number[] | undefined {
  if (mode === "monthly") return undefined;
  if (months.length > 12) fail("months", "Можно выбрать не более 12 календарных месяцев.");
  const unique = [...new Set(months)].sort((left, right) => left - right);
  if (unique.length === 0 || unique.some((month) => !Number.isSafeInteger(month) || month < 1 || month > 12)) {
    fail("months", "Выберите хотя бы один календарный месяц.");
  }
  return unique;
}

export function createSchedule(
  state: BudgetState,
  draft: ScheduleDraft,
  makeId: PlanningIdFactory = () => crypto.randomUUID(),
): BudgetState {
  validateLimits(state);
  if (state.scheduledExpenses.length >= PLANNING_LIMITS.schedules) fail("schedules", "Достигнут лимит регулярных платежей.");
  activeAccount(state, draft.accountId);
  activeExpenseCategory(state, draft.categoryId);
  if (draft.mode !== "monthly" && draft.mode !== "selected_months") fail("mode", "Выберите тип расписания.");
  const ids = allDocumentIds(state);
  const item: ScheduledExpense = {
    id: nextId(ids, makeId),
    name: normalizeName(draft.name),
    categoryId: draft.categoryId,
    accountId: draft.accountId,
    amountMinor: parsePositiveMoney(draft.amount, "amount"),
    dueDay: assertDueDay(draft.dueDay),
    mode: draft.mode,
    months: normalizedMonths(draft.mode, draft.months),
    active: true,
  };
  return validateResult({ ...state, scheduledExpenses: [...state.scheduledExpenses, item] });
}

export function editSchedule(state: BudgetState, id: string, draft: ScheduleDraft): BudgetState {
  validateLimits(state);
  if (!state.scheduledExpenses.some((item) => item.id === id)) fail("id", "Регулярный платёж не найден.");
  activeAccount(state, draft.accountId);
  activeExpenseCategory(state, draft.categoryId);
  if (draft.mode !== "monthly" && draft.mode !== "selected_months") fail("mode", "Выберите тип расписания.");
  return validateResult({
    ...state,
    scheduledExpenses: state.scheduledExpenses.map((item) => item.id === id ? {
      ...item,
      name: normalizeName(draft.name),
      categoryId: draft.categoryId,
      accountId: draft.accountId,
      amountMinor: parsePositiveMoney(draft.amount, "amount"),
      dueDay: assertDueDay(draft.dueDay),
      mode: draft.mode,
      months: normalizedMonths(draft.mode, draft.months),
    } : item),
  });
}

export function setScheduleActive(state: BudgetState, id: string, active: boolean): BudgetState {
  validateLimits(state);
  const current = state.scheduledExpenses.find((item) => item.id === id);
  if (!current) fail("id", "Регулярный платёж не найден.");
  if (active) {
    activeAccount(state, current.accountId);
    activeExpenseCategory(state, current.categoryId);
  }
  return validateResult({ ...state, scheduledExpenses: state.scheduledExpenses.map((item) => item.id === id ? { ...item, active } : item) });
}

function activeBudget(state: BudgetState) {
  const budget = state.budgets.find((item) => item.id === state.activeBudgetId);
  if (!budget) fail("budget", "Активный бюджет не найден.");
  return budget;
}

export function createFlexibleLine(
  state: BudgetState,
  draft: FlexibleDraft,
  makeId: PlanningIdFactory = () => crypto.randomUUID(),
): BudgetState {
  validateLimits(state);
  const budget = activeBudget(state);
  const name = normalizeName(draft.name);
  const matchingCategory = state.categories.find((item) => item.active && item.type === "expense" && normalizedComparison(item.name) === normalizedComparison(name));
  const matchingLine = matchingCategory
    ? budget.lines.find((line) => line.categoryId === matchingCategory.id)
    : undefined;
  if (matchingLine) {
    if (matchingLine.active !== false) fail("name", "Активная категория с таким названием уже существует.");
    return reactivateFlexibleLine(
      editFlexibleLine(state, matchingLine.id, { name, amount: draft.amount }),
      matchingLine.id,
    );
  }
  if (budget.lines.length >= PLANNING_LIMITS.budgetLines) fail("lines", "Достигнут лимит повседневных категорий.");
  if (!matchingCategory && state.categories.length >= PLANNING_LIMITS.categories) fail("categories", "Достигнут лимит категорий.");
  const ids = allDocumentIds(state);
  const categoryId = matchingCategory?.id ?? nextId(ids, makeId);
  const line: BudgetLine = { id: nextId(ids, makeId), categoryId, plannedMinor: parsePositiveMoney(draft.amount, "amount"), active: true };
  const sortOrder = Math.max(0, ...state.categories.map((item) => item.sortOrder)) + 10;
  if (!Number.isSafeInteger(sortOrder)) fail("categories", "Порядок категорий слишком велик.");
  return validateResult({
    ...state,
    categories: matchingCategory ? state.categories : [...state.categories, { id: categoryId, name, type: "expense", group: "Повседневные", active: true, sortOrder }],
    budgets: state.budgets.map((item) => item.id === budget.id ? { ...item, lines: [...item.lines, line] } : item),
  });
}

export function editFlexibleLine(state: BudgetState, lineId: string, draft: FlexibleDraft): BudgetState {
  validateLimits(state);
  const budget = activeBudget(state);
  const line = budget.lines.find((item) => item.id === lineId);
  if (!line) fail("id", "Повседневный лимит не найден.");
  const category = state.categories.find((item) => item.id === line.categoryId);
  if (!category || category.type !== "expense") fail("categoryId", "Категория лимита не найдена.");
  const name = normalizeName(draft.name);
  uniqueActiveName(state, name, category.id);
  const amountMinor = parsePositiveMoney(draft.amount, "amount");
  return validateResult({
    ...state,
    categories: state.categories.map((item) => item.id === category.id ? { ...item, name } : item),
    budgets: state.budgets.map((item) => item.id === budget.id ? { ...item, lines: item.lines.map((candidate) => candidate.id === lineId ? { ...candidate, plannedMinor: amountMinor } : candidate) } : item),
  });
}

export function archiveFlexibleLine(state: BudgetState, lineId: string): BudgetState {
  validateLimits(state);
  const budget = activeBudget(state);
  const line = budget.lines.find((item) => item.id === lineId);
  if (!line) fail("id", "Повседневный лимит не найден.");
  return validateResult({
    ...state,
    budgets: state.budgets.map((item) => item.id === budget.id ? {
      ...item,
      lines: item.lines.map((candidate) => candidate.id === lineId ? { ...candidate, active: false } : candidate),
    } : item),
  });
}

export function reactivateFlexibleLine(
  state: BudgetState,
  lineId: string,
): BudgetState {
  validateLimits(state);
  const budget = activeBudget(state);
  const line = budget.lines.find((item) => item.id === lineId && item.active === false);
  if (!line) fail("id", "Архивный повседневный лимит не найден.");
  const category = state.categories.find((item) => item.id === line.categoryId && item.type === "expense" && item.active);
  if (!category) fail("categoryId", "Для возврата лимита нужна активная категория расходов.");
  uniqueActiveName(state, category.name, category.id);
  return validateResult({
    ...state,
    budgets: state.budgets.map((item) => item.id === budget.id ? {
      ...item,
      lines: item.lines.map((candidate) => candidate.id === lineId ? { ...candidate, active: true } : candidate),
    } : item),
  });
}

export interface PlanningRepository {
  save(state: BudgetState): Promise<void>;
}

export interface PlanningSaveCoordinator {
  apply(change: (current: BudgetState) => BudgetState): Promise<BudgetState>;
  readonly locked: boolean;
}

/** Serializes edits, validates them, saves first, then publishes the durable state. */
export function createPlanningSaveCoordinator(options: {
  readonly repository: PlanningRepository;
  readonly getCurrent: () => BudgetState;
  readonly prepare: (state: BudgetState) => BudgetState;
  readonly publish: (state: BudgetState) => void;
}): PlanningSaveCoordinator {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    get locked() { return pending > 0; },
    async apply(change) {
      pending += 1;
      let resolveResult!: (state: BudgetState) => void;
      let rejectResult!: (reason: unknown) => void;
      const result = new Promise<BudgetState>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      tail = tail.catch(() => undefined).then(async () => {
        try {
          const next = options.prepare(validateResult(change(options.getCurrent())));
          validateResult(next);
          await options.repository.save(next);
          options.publish(next);
          resolveResult(next);
        } catch (error) {
          rejectResult(error);
        } finally {
          pending -= 1;
        }
      });
      return result;
    },
  };
}

export interface PlanningErrorView {
  readonly field: string;
  readonly message: string;
}

export function planningError(error: unknown): PlanningErrorView {
  if (error instanceof PlanningValidationError) {
    return { field: error.field, message: error.message };
  }
  return { field: "form", message: "Не удалось сохранить изменение." };
}
