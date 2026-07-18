import { type BudgetState } from "@family-budget/domain";
import { type CreateIfAbsentResult } from "@family-budget/storage";
import { parseMoney } from "../money";

export type OnboardingStep = 1 | 2 | 3 | 4;
export type HouseholdComposition = "self" | "couple" | "family";

export const HOUSEHOLD_COMPOSITION_LABELS: Readonly<Record<HouseholdComposition, string>> = {
  self: "Для себя",
  couple: "Для пары",
  family: "Для семьи",
};

export interface EverydayCategoryDraft {
  readonly key: string;
  readonly name: string;
  readonly limit: string;
}

export interface OnboardingDraft {
  readonly composition: HouseholdComposition;
  readonly householdLabel: string;
  readonly accountLabel: string;
  readonly currency: "RUB";
  readonly periodStart: string;
  readonly monthlyIncome: string;
  readonly mandatoryName: string;
  readonly mandatoryAmount: string;
  readonly categories: readonly EverydayCategoryDraft[];
}

export interface OnboardingStepValidation {
  readonly valid: boolean;
  readonly errors: Readonly<Record<string, string>>;
}

export type IdFactory = () => string;
export const MAX_ONBOARDING_PERIOD_START = "9997-12-01";

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL_MAX_LENGTH = 80;
const FORBIDDEN_FORMATTING_PATTERN = /[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;
const LABEL_SCRIPT_PATTERNS = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
] as const;

function currentMonthStart(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

export function createInitialOnboardingDraft(startDate = currentMonthStart()): OnboardingDraft {
  return {
    composition: "family",
    householdLabel: "Наш бюджет",
    accountLabel: "Основной счёт",
    currency: "RUB",
    periodStart: startDate,
    monthlyIncome: "",
    mandatoryName: "Жильё и счета",
    mandatoryAmount: "",
    categories: [
      { key: "everyday-1", name: "Продукты", limit: "" },
      { key: "everyday-2", name: "Транспорт", limit: "" },
      { key: "everyday-3", name: "Дом и мелкие покупки", limit: "" },
    ],
  };
}

export function normalizeOnboardingLabel(value: string): string {
  return value.normalize("NFC").trim();
}

function labelError(value: string, label: string): string | null {
  const trimmed = normalizeOnboardingLabel(value);
  if (!trimmed) return `Укажите ${label}.`;
  if (trimmed.length > LABEL_MAX_LENGTH) return `Не более ${LABEL_MAX_LENGTH} символов.`;
  if (/\p{Cc}/u.test(trimmed) || FORBIDDEN_FORMATTING_PATTERN.test(trimmed)) {
    return "Уберите скрытые или служебные символы.";
  }
  if (LABEL_SCRIPT_PATTERNS.filter((pattern) => pattern.test(trimmed)).length > 1) {
    return "Не смешивайте визуально похожие символы разных алфавитов в одной подписи.";
  }
  return null;
}

function comparisonLabel(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
}

function moneyError(value: string): string | null {
  try {
    parseMoney(value);
    return null;
  } catch {
    return "Введите положительную сумму в рублях, не более двух знаков после запятой.";
  }
}

function isCalendarDate(value: string): boolean {
  if (!LOCAL_DATE_PATTERN.test(value)) return false;
  if (value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateOnboardingStep(
  draft: OnboardingDraft,
  step: OnboardingStep,
): OnboardingStepValidation {
  const errors: Record<string, string> = {};

  if (step === 1) {
    if (!Object.hasOwn(HOUSEHOLD_COMPOSITION_LABELS, draft.composition)) {
      errors.composition = "Выберите, для кого создаётся план.";
    }
    const household = labelError(draft.householdLabel, "название плана");
    const account = labelError(draft.accountLabel, "название счёта");
    if (household) errors.householdLabel = household;
    if (account) errors.accountLabel = account;
  }

  if (step === 2) {
    if (draft.currency !== "RUB") errors.currency = "В этой версии бюджет ведётся в рублях.";
    if (!isCalendarDate(draft.periodStart)) {
      errors.periodStart = "Выберите календарную дату.";
    } else if (draft.periodStart > MAX_ONBOARDING_PERIOD_START) {
      errors.periodStart = `Начало периода — не позднее ${MAX_ONBOARDING_PERIOD_START}.`;
    } else if (!draft.periodStart.endsWith("-01")) {
      errors.periodStart = "Бюджетный период начинается с первого числа месяца.";
    }
  }

  if (step === 3) {
    const income = moneyError(draft.monthlyIncome);
    const mandatoryName = labelError(draft.mandatoryName, "название обязательного платежа");
    const mandatoryAmount = moneyError(draft.mandatoryAmount);
    if (income) errors.monthlyIncome = income;
    if (mandatoryName) errors.mandatoryName = mandatoryName;
    if (mandatoryAmount) errors.mandatoryAmount = mandatoryAmount;
  }

  if (step === 4) {
    if (draft.categories.length < 3 || draft.categories.length > 5) {
      errors.categories = "Добавьте от 3 до 5 повседневных категорий.";
    }
    const names = new Set<string>();
    draft.categories.forEach((category, index) => {
      const name = labelError(category.name, "название категории");
      const limit = moneyError(category.limit);
      if (name) errors[`category-${index}-name`] = name;
      if (limit) errors[`category-${index}-limit`] = limit;
      const normalized = comparisonLabel(category.name);
      if (normalized && names.has(normalized)) {
        errors[`category-${index}-name`] = "Названия категорий не должны повторяться.";
      }
      if (normalized) names.add(normalized);
    });
    const mandatory = comparisonLabel(draft.mandatoryName);
    const duplicateMandatory = draft.categories.findIndex(
      (category) => comparisonLabel(category.name) === mandatory,
    );
    if (mandatory && duplicateMandatory >= 0) {
      errors[`category-${duplicateMandatory}-name`] = "Это название уже используется для обязательного платежа.";
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export function moveOnboardingStep(
  step: OnboardingStep,
  direction: "back" | "forward",
): OnboardingStep {
  const delta = direction === "forward" ? 1 : -1;
  return Math.min(4, Math.max(1, step + delta)) as OnboardingStep;
}

export function validateCompleteOnboarding(draft: OnboardingDraft): OnboardingStepValidation {
  const errors: Record<string, string> = {};
  for (const step of [1, 2, 3, 4] as const) {
    Object.assign(errors, validateOnboardingStep(draft, step).errors);
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

function endOfMonth(startDate: string): string {
  const year = Number(startDate.slice(0, 4));
  const month = Number(startDate.slice(5, 7));
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${startDate.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

function safeSum(values: readonly number[], label: string): number {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result)) throw new Error(`${label}: итоговая сумма слишком велика.`);
  return result;
}

export function buildOnboardingBudgetState(
  draft: OnboardingDraft,
  makeId: IdFactory = () => crypto.randomUUID(),
): BudgetState {
  const validation = validateCompleteOnboarding(draft);
  if (!validation.valid) throw new Error("Заполните все шаги перед созданием бюджета.");

  const issuedIds = new Set<string>();
  const id = (): string => {
    const next = makeId();
    if (!UUID_PATTERN.test(next) || issuedIds.has(next)) throw new Error("Не удалось создать уникальные идентификаторы.");
    issuedIds.add(next);
    return next;
  };

  const accountId = id();
  const budgetId = id();
  const mandatoryCategoryId = id();
  const everyday = draft.categories.map((category) => ({
    id: id(),
    lineId: id(),
    name: normalizeOnboardingLabel(category.name),
    limitMinor: parseMoney(category.limit),
  }));
  const everydayTotalMinor = safeSum(everyday.map((category) => category.limitMinor), "Повседневные лимиты");
  const plannedIncomeMinor = parseMoney(draft.monthlyIncome);
  const mandatoryAmountMinor = parseMoney(draft.mandatoryAmount);
  safeSum([everydayTotalMinor, mandatoryAmountMinor], "План на месяц");

  return {
    activeBudgetId: budgetId,
    accounts: [{
      id: accountId,
      name: `${HOUSEHOLD_COMPOSITION_LABELS[draft.composition]} · ${normalizeOnboardingLabel(draft.householdLabel)} · ${normalizeOnboardingLabel(draft.accountLabel)}`,
      type: "current",
      currency: "RUB",
      openingBalanceMinor: 0,
      active: true,
    }],
    categories: [
      {
        id: mandatoryCategoryId,
        name: normalizeOnboardingLabel(draft.mandatoryName),
        type: "expense",
        group: "Обязательные",
        active: true,
        sortOrder: 10,
      },
      ...everyday.map((category, index) => ({
        id: category.id,
        name: category.name,
        type: "expense" as const,
        group: "Повседневные",
        active: true,
        sortOrder: (index + 2) * 10,
      })),
    ],
    budgets: [{
      id: budgetId,
      startDate: draft.periodStart,
      endDate: endOfMonth(draft.periodStart),
      status: "open",
      plannedIncomeMinor,
      warningThreshold: 0.8,
      lines: everyday.map((category) => ({
        id: category.lineId,
        categoryId: category.id,
        plannedMinor: category.limitMinor,
      })),
    }],
    goals: [],
    annualCommitments: [],
    scheduledExpenses: [{
      id: id(),
      name: normalizeOnboardingLabel(draft.mandatoryName),
      categoryId: mandatoryCategoryId,
      accountId,
      amountMinor: mandatoryAmountMinor,
      dueDay: 1,
      mode: "monthly",
      active: true,
    }],
    transactions: [],
  };
}

export interface OnboardingRepository {
  createIfAbsent(state: BudgetState): Promise<CreateIfAbsentResult<BudgetState>>;
}

/** Publishes the atomic winner only after create-if-empty has completed successfully. */
export async function persistCompletedOnboarding(
  repository: OnboardingRepository,
  state: BudgetState,
  prepare: (state: BudgetState) => BudgetState,
  publish: (state: BudgetState) => void,
): Promise<CreateIfAbsentResult<BudgetState>> {
  const result = await repository.createIfAbsent(state);
  const value = prepare(result.value);
  const preparedResult: CreateIfAbsentResult<BudgetState> = { status: result.status, value };
  publish(value);
  return preparedResult;
}

export interface AsyncOperationLock {
  readonly locked: boolean;
  run(operation: () => Promise<void>): Promise<boolean>;
}

export type OnboardingFailureKind = "save" | "demo";

/** User-facing failures never interpolate storage, browser, or validation exception details. */
export function onboardingFailureMessage(kind: OnboardingFailureKind): string {
  return kind === "save"
    ? "Не удалось сохранить бюджет."
    : "Не удалось загрузить демонстрационные данные.";
}

/** A synchronous acquire gate prevents two UI events from starting overlapping writes. */
export function createAsyncOperationLock(): AsyncOperationLock {
  let locked = false;
  return {
    get locked() {
      return locked;
    },
    async run(operation) {
      if (locked) return false;
      locked = true;
      try {
        await operation();
        return true;
      } finally {
        locked = false;
      }
    },
  };
}
