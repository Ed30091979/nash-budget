import {
  calculateAnnualPlan,
  calculateBudget,
  type BudgetState,
} from "@family-budget/domain";
import {
  ValidatedBackupCodec,
  type SerializeBackupOptions,
} from "@family-budget/storage";

export const MAX_BACKUP_FILE_BYTES = 5 * 1024 * 1024;
export const BACKUP_LIMITS = {
  accounts: 100,
  categories: 500,
  budgets: 240,
  goals: 200,
  annualCommitments: 1_000,
  scheduledExpenses: 1_000,
  transactions: 50_000,
  linesPerBudget: 500,
  totalBudgetLines: 10_000,
  selectedMonths: 12,
  idLength: 128,
  nameLength: 200,
  textLength: 500,
} as const;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LegacyBudgetState = Omit<BudgetState, "annualCommitments" | "scheduledExpenses"> &
  Partial<Pick<BudgetState, "annualCommitments" | "scheduledExpenses">>;

interface BackupFile {
  readonly size: number;
  text(): Promise<string>;
}

export interface PreparedBudgetBackup {
  readonly text: string;
  readonly createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label}: ожидался объект.`);
  return value;
}

function requireArray(value: unknown, label: string, maxLength = Number.MAX_SAFE_INTEGER): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}: ожидался список.`);
  if (value.length > maxLength) throw new Error(`${label}: допускается не более ${maxLength} элементов.`);
  return value;
}

function requireString(
  value: unknown,
  label: string,
  nonEmpty = false,
  maxLength: number = BACKUP_LIMITS.textLength,
): string {
  if (typeof value !== "string" || (nonEmpty && value.trim().length === 0)) {
    throw new Error(`${label}: ожидалась${nonEmpty ? " непустая" : ""} строка.`);
  }
  if (value.length > maxLength) throw new Error(`${label}: строка длиннее ${maxLength} символов.`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label}: ожидалось логическое значение.`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label}: ожидалось число.`);
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label}: недопустимое значение.`);
  }
  return value as T;
}

function requireOptionalNumber(value: unknown, label: string): void {
  if (value !== undefined) requireNumber(value, label);
}

function requireLocalDate(value: string, label: string): void {
  if (!LOCAL_DATE_PATTERN.test(value)) throw new Error(`${label}: дата должна иметь формат YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label}: невозможная календарная дата.`);
  }
}

function requireUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label}: некорректный UUID.`);
}

function validateBudgetStateUuids(state: BudgetState): void {
  requireUuid(state.activeBudgetId, "activeBudgetId");
  state.accounts.forEach((item, index) => requireUuid(item.id, `accounts[${index}].id`));
  state.categories.forEach((item, index) => requireUuid(item.id, `categories[${index}].id`));
  state.budgets.forEach((budget, budgetIndex) => {
    requireUuid(budget.id, `budgets[${budgetIndex}].id`);
    budget.lines.forEach((line, lineIndex) => requireUuid(line.id, `budgets[${budgetIndex}].lines[${lineIndex}].id`));
  });
  state.goals.forEach((item, index) => requireUuid(item.id, `goals[${index}].id`));
  state.annualCommitments.forEach((item, index) => requireUuid(item.id, `annualCommitments[${index}].id`));
  state.scheduledExpenses.forEach((item, index) => requireUuid(item.id, `scheduledExpenses[${index}].id`));
  state.transactions.forEach((item, index) => requireUuid(item.id, `transactions[${index}].id`));
}

function requireSafeMinor(value: number, label: string, allowNegative = false): void {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new Error(`${label}: некорректная сумма в minor units.`);
  }
}

function requireBaseShape(value: unknown): asserts value is LegacyBudgetState {
  const state = requireRecord(value, "Бюджет");
  requireString(state.activeBudgetId, "activeBudgetId", true, BACKUP_LIMITS.idLength);

  requireArray(state.accounts, "accounts", BACKUP_LIMITS.accounts).forEach((item, index) => {
    const account = requireRecord(item, `accounts[${index}]`);
    requireString(account.id, `accounts[${index}].id`, true, BACKUP_LIMITS.idLength);
    requireString(account.name, `accounts[${index}].name`, false, BACKUP_LIMITS.nameLength);
    requireEnum(account.type, ["current", "cash", "savings", "reserve"], `accounts[${index}].type`);
    requireString(account.currency, `accounts[${index}].currency`, true);
    requireNumber(account.openingBalanceMinor, `accounts[${index}].openingBalanceMinor`);
    requireBoolean(account.active, `accounts[${index}].active`);
  });

  requireArray(state.categories, "categories", BACKUP_LIMITS.categories).forEach((item, index) => {
    const category = requireRecord(item, `categories[${index}]`);
    requireString(category.id, `categories[${index}].id`, true, BACKUP_LIMITS.idLength);
    requireString(category.name, `categories[${index}].name`, false, BACKUP_LIMITS.nameLength);
    requireEnum(category.type, ["income", "expense"], `categories[${index}].type`);
    requireString(category.group, `categories[${index}].group`);
    requireBoolean(category.active, `categories[${index}].active`);
    requireNumber(category.sortOrder, `categories[${index}].sortOrder`);
  });

  let totalBudgetLines = 0;
  requireArray(state.budgets, "budgets", BACKUP_LIMITS.budgets).forEach((item, index) => {
    const budget = requireRecord(item, `budgets[${index}]`);
    requireString(budget.id, `budgets[${index}].id`, true, BACKUP_LIMITS.idLength);
    requireString(budget.startDate, `budgets[${index}].startDate`, false, 10);
    requireString(budget.endDate, `budgets[${index}].endDate`, false, 10);
    requireEnum(budget.status, ["draft", "open", "closed"], `budgets[${index}].status`);
    requireNumber(budget.plannedIncomeMinor, `budgets[${index}].plannedIncomeMinor`);
    requireNumber(budget.warningThreshold, `budgets[${index}].warningThreshold`);
    const lines = requireArray(budget.lines, `budgets[${index}].lines`, BACKUP_LIMITS.linesPerBudget);
    totalBudgetLines += lines.length;
    if (totalBudgetLines > BACKUP_LIMITS.totalBudgetLines) {
      throw new Error(`budget lines: допускается не более ${BACKUP_LIMITS.totalBudgetLines} элементов суммарно.`);
    }
    lines.forEach((lineValue, lineIndex) => {
      const line = requireRecord(lineValue, `budgets[${index}].lines[${lineIndex}]`);
      requireString(line.id, `budgets[${index}].lines[${lineIndex}].id`, true, BACKUP_LIMITS.idLength);
      requireString(line.categoryId, `budgets[${index}].lines[${lineIndex}].categoryId`, true, BACKUP_LIMITS.idLength);
      requireNumber(line.plannedMinor, `budgets[${index}].lines[${lineIndex}].plannedMinor`);
      requireOptionalNumber(line.rolloverMinor, `budgets[${index}].lines[${lineIndex}].rolloverMinor`);
      requireOptionalNumber(line.adjustmentMinor, `budgets[${index}].lines[${lineIndex}].adjustmentMinor`);
    });
  });

  requireArray(state.goals, "goals", BACKUP_LIMITS.goals).forEach((item, index) => {
    const goal = requireRecord(item, `goals[${index}]`);
    requireString(goal.id, `goals[${index}].id`, true, BACKUP_LIMITS.idLength);
    requireString(goal.name, `goals[${index}].name`, false, BACKUP_LIMITS.nameLength);
    requireString(goal.linkedAccountId, `goals[${index}].linkedAccountId`, true, BACKUP_LIMITS.idLength);
    requireNumber(goal.targetMinor, `goals[${index}].targetMinor`);
    requireNumber(goal.openingContributedMinor, `goals[${index}].openingContributedMinor`);
    requireNumber(goal.plannedContributionMinor, `goals[${index}].plannedContributionMinor`);
    requireEnum(goal.status, ["active", "completed", "cancelled"], `goals[${index}].status`);
  });

  requireArray(state.transactions, "transactions", BACKUP_LIMITS.transactions).forEach((item, index) => {
    const transaction = requireRecord(item, `transactions[${index}]`);
    requireString(transaction.id, `transactions[${index}].id`, true, BACKUP_LIMITS.idLength);
    requireString(transaction.occurredOn, `transactions[${index}].occurredOn`, false, 10);
    requireEnum(transaction.status, ["posted", "pending", "draft"], `transactions[${index}].status`);
    const kind = requireEnum(transaction.kind, ["income", "expense", "refund", "transfer", "goal_contribution"], `transactions[${index}].kind`);
    requireNumber(transaction.amountMinor, `transactions[${index}].amountMinor`);
    if (kind === "income" || kind === "expense" || kind === "refund") {
      requireString(transaction.accountId, `transactions[${index}].accountId`, true, BACKUP_LIMITS.idLength);
    }
    if (kind === "expense" || kind === "refund") {
      requireString(transaction.categoryId, `transactions[${index}].categoryId`, true, BACKUP_LIMITS.idLength);
    }
    if (kind === "transfer" || kind === "goal_contribution") {
      requireString(transaction.fromAccountId, `transactions[${index}].fromAccountId`, true, BACKUP_LIMITS.idLength);
      requireString(transaction.toAccountId, `transactions[${index}].toAccountId`, true, BACKUP_LIMITS.idLength);
    }
    if (kind === "goal_contribution") {
      requireString(transaction.goalId, `transactions[${index}].goalId`, true, BACKUP_LIMITS.idLength);
    }
    if (kind === "refund" && transaction.originalTransactionId !== undefined) {
      requireString(transaction.originalTransactionId, `transactions[${index}].originalTransactionId`, true, BACKUP_LIMITS.idLength);
    }
  });

  if (state.annualCommitments !== undefined) requireArray(state.annualCommitments, "annualCommitments", BACKUP_LIMITS.annualCommitments);
  if (state.scheduledExpenses !== undefined) requireArray(state.scheduledExpenses, "scheduledExpenses", BACKUP_LIMITS.scheduledExpenses);
}

function requirePlanningShape(state: BudgetState): void {
  state.annualCommitments.forEach((itemValue, index) => {
    const item = requireRecord(itemValue, `annualCommitments[${index}]`);
    requireString(item.id, `annualCommitments[${index}].id`, true, BACKUP_LIMITS.idLength);
    requireString(item.name, `annualCommitments[${index}].name`, false, BACKUP_LIMITS.nameLength);
    requireString(item.categoryId, `annualCommitments[${index}].categoryId`, true, BACKUP_LIMITS.idLength);
    requireString(item.accountId, `annualCommitments[${index}].accountId`, true, BACKUP_LIMITS.idLength);
    requireString(item.dueDate, `annualCommitments[${index}].dueDate`, false, 10);
    requireNumber(item.amountMinor, `annualCommitments[${index}].amountMinor`);
    requireNumber(item.reservedMinor, `annualCommitments[${index}].reservedMinor`);
    requireEnum(item.recurrence, ["annual", "one_time"], `annualCommitments[${index}].recurrence`);
    requireBoolean(item.active, `annualCommitments[${index}].active`);
  });

  state.scheduledExpenses.forEach((itemValue, index) => {
    const item = requireRecord(itemValue, `scheduledExpenses[${index}]`);
    requireString(item.id, `scheduledExpenses[${index}].id`, true, BACKUP_LIMITS.idLength);
    requireString(item.name, `scheduledExpenses[${index}].name`, false, BACKUP_LIMITS.nameLength);
    requireString(item.categoryId, `scheduledExpenses[${index}].categoryId`, true, BACKUP_LIMITS.idLength);
    requireString(item.accountId, `scheduledExpenses[${index}].accountId`, true, BACKUP_LIMITS.idLength);
    requireNumber(item.amountMinor, `scheduledExpenses[${index}].amountMinor`);
    requireNumber(item.dueDay, `scheduledExpenses[${index}].dueDay`);
    requireEnum(item.mode, ["monthly", "selected_months"], `scheduledExpenses[${index}].mode`);
    if (item.months !== undefined) {
      requireArray(item.months, `scheduledExpenses[${index}].months`, BACKUP_LIMITS.selectedMonths).forEach((month, monthIndex) => {
        requireNumber(month, `scheduledExpenses[${index}].months[${monthIndex}]`);
      });
    }
    requireBoolean(item.active, `scheduledExpenses[${index}].active`);
  });
}

/** Validates every budget and line in linear time before invoking domain calculations. */
function validateAllBudgets(state: BudgetState): void {
  const categories = new Map(state.categories.map((category) => [category.id, category]));

  for (const budget of state.budgets) {
    requireLocalDate(budget.startDate, `budget ${budget.id} startDate`);
    requireLocalDate(budget.endDate, `budget ${budget.id} endDate`);
    if (budget.startDate > budget.endDate) throw new Error(`budget ${budget.id}: startDate позже endDate.`);
    requireSafeMinor(budget.plannedIncomeMinor, `budget ${budget.id} plannedIncomeMinor`);
    if (!Number.isFinite(budget.warningThreshold) || budget.warningThreshold < 0 || budget.warningThreshold >= 1) {
      throw new Error(`budget ${budget.id}: warningThreshold должен быть в диапазоне [0, 1).`);
    }

    const lineIds = new Set<string>();
    const categoryIds = new Set<string>();
    for (const line of budget.lines) {
      if (lineIds.has(line.id)) throw new Error(`budget ${budget.id}: повторяющийся id строки ${line.id}.`);
      lineIds.add(line.id);
      if (categoryIds.has(line.categoryId)) throw new Error(`budget ${budget.id}: несколько строк категории ${line.categoryId}.`);
      categoryIds.add(line.categoryId);
      const category = categories.get(line.categoryId);
      if (!category) throw new Error(`budget line ${line.id}: неизвестная категория ${line.categoryId}.`);
      if (category.type !== "expense") throw new Error(`budget line ${line.id}: категория должна быть расходной.`);
      requireSafeMinor(line.plannedMinor, `budget line ${line.id} plannedMinor`);
      requireSafeMinor(line.rolloverMinor ?? 0, `budget line ${line.id} rolloverMinor`);
      requireSafeMinor(line.adjustmentMinor ?? 0, `budget line ${line.id} adjustmentMinor`, true);
      const available = line.plannedMinor + (line.rolloverMinor ?? 0) + (line.adjustmentMinor ?? 0);
      if (!Number.isSafeInteger(available) || available < 0) {
        throw new Error(`budget line ${line.id}: некорректная доступная сумма.`);
      }
    }
  }
}

/** Adds only newly introduced planning collections; all legacy user data remains untouched. */
export function normalizeBudgetState(value: LegacyBudgetState): BudgetState {
  return {
    ...value,
    annualCommitments: Array.isArray(value.annualCommitments) ? value.annualCommitments : [],
    scheduledExpenses: Array.isArray(value.scheduledExpenses) ? value.scheduledExpenses : [],
  };
}

/** Structural validation followed by all domain calculations that enforce model invariants. */
export function prepareBudgetState(value: unknown): BudgetState {
  requireBaseShape(value);
  const state = normalizeBudgetState(value);
  requirePlanningShape(state);
  validateBudgetStateUuids(state);

  const activeBudget = state.budgets.find((budget) => budget.id === state.activeBudgetId);
  if (!activeBudget) throw new Error("activeBudgetId ссылается на неизвестный бюджет.");
  validateAllBudgets(state);
  calculateBudget(state);
  calculateAnnualPlan(state, activeBudget.startDate.slice(0, 7), 12);
  return state;
}

export function parseAndValidateBudgetBackup(text: string): BudgetState {
  return new ValidatedBackupCodec(prepareBudgetState).parse(text);
}

/** Serializes first and records metadata only when the complete backup is valid. */
export async function createBudgetBackup(
  state: BudgetState,
  persistLastSuccessfulBackup: (createdAt: string) => Promise<void>,
  options: SerializeBackupOptions = {},
): Promise<PreparedBudgetBackup> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const text = new ValidatedBackupCodec(prepareBudgetState).serialize(state, {
    ...options,
    createdAt,
  });
  await persistLastSuccessfulBackup(createdAt);
  return { text, createdAt };
}

export async function restoreBudgetBackup(
  file: BackupFile,
  save: (state: BudgetState) => Promise<void>,
  publish: (state: BudgetState) => void,
): Promise<BudgetState> {
  if (file.size > MAX_BACKUP_FILE_BYTES) {
    throw new Error("Резервная копия больше допустимых 5 МБ.");
  }
  const next = parseAndValidateBudgetBackup(await file.text());
  await save(next);
  publish(next);
  return next;
}
