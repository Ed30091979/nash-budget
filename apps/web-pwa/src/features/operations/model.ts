import {
  calculateBudget,
  type BudgetMetrics,
  type BudgetState,
  type Transaction,
  type TransactionStatus,
} from "@family-budget/domain";
import { BACKUP_LIMITS } from "../../backup";
import { parseMoney } from "../../money";

export const OPERATIONS_LIMITS = {
  accounts: BACKUP_LIMITS.accounts,
  categories: BACKUP_LIMITS.categories,
  budgets: BACKUP_LIMITS.budgets,
  linesPerBudget: BACKUP_LIMITS.linesPerBudget,
  totalBudgetLines: BACKUP_LIMITS.totalBudgetLines,
  goals: BACKUP_LIMITS.goals,
  commitments: BACKUP_LIMITS.annualCommitments,
  schedules: BACKUP_LIMITS.scheduledExpenses,
  transactions: BACKUP_LIMITS.transactions,
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: readonly TransactionStatus[] = ["posted", "pending", "draft"];

export type OperationsIdFactory = () => string;

interface CommonTransactionDraft {
  readonly occurredOn: string;
  readonly status: TransactionStatus;
  readonly amount: string;
}

export interface IncomeDraft extends CommonTransactionDraft {
  readonly kind: "income";
  readonly accountId: string;
}

export interface ExpenseDraft extends CommonTransactionDraft {
  readonly kind: "expense";
  readonly accountId: string;
  readonly categoryId: string;
}

export interface RefundDraft extends CommonTransactionDraft {
  readonly kind: "refund";
  readonly accountId: string;
  readonly originalTransactionId: string;
}

export interface TransferDraft extends CommonTransactionDraft {
  readonly kind: "transfer";
  readonly fromAccountId: string;
  readonly toAccountId: string;
}

export interface GoalContributionDraft extends CommonTransactionDraft {
  readonly kind: "goal_contribution";
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly goalId: string;
}

export type TransactionDraft =
  | IncomeDraft
  | ExpenseDraft
  | RefundDraft
  | TransferDraft
  | GoalContributionDraft;

export class OperationsValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "OperationsValidationError";
    this.field = field;
  }
}

function fail(field: string, message: string): never {
  throw new OperationsValidationError(field, message);
}

function assertIdentifier(id: string, field = "id"): string {
  if (!UUID_PATTERN.test(id)) fail(field, "Некорректный идентификатор.");
  return id;
}

function allDocumentIds(state: BudgetState): Set<string> {
  const ids = new Set<string>();
  const accept = (id: string): void => {
    assertIdentifier(id, "document");
    if (ids.has(id)) fail("document", "Документ содержит повторяющийся идентификатор.");
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

function validateLimits(state: BudgetState): void {
  if (state.accounts.length > OPERATIONS_LIMITS.accounts) fail("document", "Слишком много счетов.");
  if (state.categories.length > OPERATIONS_LIMITS.categories) fail("document", "Слишком много категорий.");
  if (state.budgets.length > OPERATIONS_LIMITS.budgets) fail("document", "Слишком много бюджетных периодов.");
  if (state.goals.length > OPERATIONS_LIMITS.goals) fail("document", "Слишком много целей.");
  if (state.annualCommitments.length > OPERATIONS_LIMITS.commitments) fail("document", "Слишком много крупных платежей.");
  if (state.scheduledExpenses.length > OPERATIONS_LIMITS.schedules) fail("document", "Слишком много регулярных платежей.");
  if (state.transactions.length > OPERATIONS_LIMITS.transactions) fail("document", "Слишком много операций.");
  if (state.budgets.some((budget) => budget.lines.length > OPERATIONS_LIMITS.linesPerBudget)) {
    fail("document", "Слишком много бюджетных лимитов в одном периоде.");
  }
  const lines = state.budgets.reduce((count, budget) => count + budget.lines.length, 0);
  if (lines > OPERATIONS_LIMITS.totalBudgetLines) fail("document", "Слишком много бюджетных лимитов.");
}

function validateState(state: BudgetState): BudgetMetrics {
  try {
    validateLimits(state);
    allDocumentIds(state);
    validateRefundRelations(state);
    return calculateBudget(state);
  } catch (error) {
    if (error instanceof OperationsValidationError) throw error;
    return fail("document", "Документ бюджета повреждён или содержит несогласованные связи.");
  }
}

function nextId(ids: Set<string>, makeId: OperationsIdFactory): string {
  const id = makeId();
  if (!UUID_PATTERN.test(id) || ids.has(id)) fail("id", "Не удалось создать уникальный идентификатор.");
  ids.add(id);
  return id;
}

function assertLocalDate(value: string): string {
  if (!LOCAL_DATE_PATTERN.test(value) || value.startsWith("0000-")) {
    return fail("occurredOn", "Выберите календарную дату.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return fail("occurredOn", "Выберите существующую календарную дату.");
  }
  return value;
}

function parsePositiveMoney(value: string): number {
  try {
    return parseMoney(value);
  } catch {
    return fail("amount", "Введите положительную сумму в рублях, не более двух знаков после запятой.");
  }
}

function assertStatus(value: TransactionStatus): TransactionStatus {
  if (!STATUSES.includes(value)) fail("status", "Выберите статус операции.");
  return value;
}

function accountFor(
  state: BudgetState,
  id: string,
  field: string,
  allowedArchivedId?: string,
): void {
  assertIdentifier(id, field);
  const account = state.accounts.find((item) => item.id === id);
  if (!account || (!account.active && id !== allowedArchivedId)) fail(field, "Выберите активный счёт.");
}

function expenseCategoryFor(
  state: BudgetState,
  id: string,
  allowedArchivedId?: string,
): void {
  assertIdentifier(id, "categoryId");
  const category = state.categories.find((item) => item.id === id);
  if (!category || category.type !== "expense" || (!category.active && id !== allowedArchivedId)) {
    fail("categoryId", "Выберите активную категорию расходов.");
  }
}

function goalFor(state: BudgetState, id: string, allowedHistoricalId?: string) {
  assertIdentifier(id, "goalId");
  const goal = state.goals.find((item) => item.id === id);
  if (!goal || (goal.status !== "active" && id !== allowedHistoricalId)) {
    return fail("goalId", "Выберите активную цель.");
  }
  return goal;
}

function accountIds(transaction: Transaction): readonly string[] {
  if (transaction.kind === "income" || transaction.kind === "expense" || transaction.kind === "refund") {
    return [transaction.accountId];
  }
  return [transaction.fromAccountId, transaction.toAccountId];
}

function makeTransaction(
  state: BudgetState,
  id: string,
  draft: TransactionDraft,
  current?: Transaction,
): Transaction {
  const occurredOn = assertLocalDate(draft.occurredOn);
  const status = assertStatus(draft.status);
  const amountMinor = parsePositiveMoney(draft.amount);
  const oldAccounts = current?.kind === draft.kind ? accountIds(current) : [];

  switch (draft.kind) {
    case "income":
      accountFor(state, draft.accountId, "accountId", oldAccounts[0]);
      return { id, kind: "income", occurredOn, status, amountMinor, accountId: draft.accountId };
    case "expense": {
      accountFor(state, draft.accountId, "accountId", oldAccounts[0]);
      const oldCategoryId = current?.kind === "expense" ? current.categoryId : undefined;
      expenseCategoryFor(state, draft.categoryId, oldCategoryId);
      return { id, kind: "expense", occurredOn, status, amountMinor, accountId: draft.accountId, categoryId: draft.categoryId };
    }
    case "refund": {
      accountFor(state, draft.accountId, "accountId", oldAccounts[0]);
      assertIdentifier(draft.originalTransactionId, "originalTransactionId");
      const original = state.transactions.find((item) => item.id === draft.originalTransactionId);
      if (!original || original.kind !== "expense" || original.status !== "posted") {
        return fail("originalTransactionId", "Выберите исходный проведённый расход.");
      }
      if (occurredOn < original.occurredOn) {
        return fail("occurredOn", "Дата возврата не может быть раньше даты исходного расхода.");
      }
      return {
        id,
        kind: "refund",
        occurredOn,
        status,
        amountMinor,
        accountId: draft.accountId,
        categoryId: original.categoryId,
        originalTransactionId: original.id,
      };
    }
    case "transfer":
      accountFor(state, draft.fromAccountId, "fromAccountId", oldAccounts[0]);
      accountFor(state, draft.toAccountId, "toAccountId", oldAccounts[1]);
      if (draft.fromAccountId === draft.toAccountId) fail("toAccountId", "Выберите другой счёт назначения.");
      return { id, kind: "transfer", occurredOn, status, amountMinor, fromAccountId: draft.fromAccountId, toAccountId: draft.toAccountId };
    case "goal_contribution": {
      accountFor(state, draft.fromAccountId, "fromAccountId", oldAccounts[0]);
      accountFor(state, draft.toAccountId, "toAccountId", oldAccounts[1]);
      if (draft.fromAccountId === draft.toAccountId) fail("toAccountId", "Выберите другой счёт назначения.");
      const oldGoalId = current?.kind === "goal_contribution" ? current.goalId : undefined;
      const goal = goalFor(state, draft.goalId, oldGoalId);
      if (goal.linkedAccountId !== draft.toAccountId) {
        fail("toAccountId", "Счёт назначения должен совпадать со счётом цели.");
      }
      return {
        id,
        kind: "goal_contribution",
        occurredOn,
        status,
        amountMinor,
        fromAccountId: draft.fromAccountId,
        toAccountId: draft.toAccountId,
        goalId: draft.goalId,
      };
    }
    default:
      return fail("kind", "Выберите тип операции.");
  }
}

function validateRefundRelations(state: BudgetState): void {
  const expenses = new Map(
    state.transactions
      .filter((item): item is Extract<Transaction, { kind: "expense" }> => item.kind === "expense")
      .map((item) => [item.id, item]),
  );
  for (const transaction of state.transactions) {
    if (transaction.kind !== "refund") continue;
    const expense = expenses.get(transaction.originalTransactionId);
    if (!expense || expense.status !== "posted" || expense.categoryId !== transaction.categoryId) {
      fail("originalTransactionId", "Возврат потерял связь с исходным проведённым расходом.");
    }
  }
}

function validateResult(state: BudgetState): BudgetState {
  validateState(state);
  return state;
}

export function calculateOperationsMetrics(state: BudgetState): BudgetMetrics {
  return validateState(state);
}

export function createTransaction(
  state: BudgetState,
  draft: TransactionDraft,
  makeId: OperationsIdFactory = () => crypto.randomUUID(),
): BudgetState {
  validateState(state);
  if (state.transactions.length >= OPERATIONS_LIMITS.transactions) fail("transactions", "Достигнут лимит операций.");
  const id = nextId(allDocumentIds(state), makeId);
  const transaction = makeTransaction(state, id, draft);
  return validateResult({ ...state, transactions: [...state.transactions, transaction] });
}

export function editTransaction(state: BudgetState, id: string, draft: TransactionDraft): BudgetState {
  validateState(state);
  assertIdentifier(id);
  const current = state.transactions.find((item) => item.id === id);
  if (!current) fail("id", "Операция не найдена.");
  const dependentRefunds = state.transactions.filter(
    (item) => item.kind === "refund" && item.originalTransactionId === id,
  );
  if (
    current.kind === "expense" &&
    dependentRefunds.length > 0 &&
    (
      draft.kind !== "expense" ||
      draft.categoryId !== current.categoryId ||
      draft.status !== current.status
    )
  ) {
    fail("kind", "Нельзя изменить тип, категорию или статус расхода, пока с ним связаны возвраты.");
  }
  if (
    current.kind === "expense" &&
    dependentRefunds.length > 0 &&
    draft.occurredOn !== current.occurredOn
  ) {
    fail("occurredOn", "Нельзя изменить дату расхода, пока с ним связаны возвраты.");
  }
  const transaction = makeTransaction(state, id, draft, current);
  return validateResult({
    ...state,
    transactions: state.transactions.map((item) => item.id === id ? transaction : item),
  });
}

export function deleteTransaction(state: BudgetState, id: string): BudgetState {
  validateState(state);
  assertIdentifier(id);
  const current = state.transactions.find((item) => item.id === id);
  if (!current) fail("id", "Операция не найдена.");
  if (state.transactions.some((item) => item.kind === "refund" && item.originalTransactionId === id)) {
    fail("id", "Сначала удалите связанные возвраты.");
  }
  return validateResult({ ...state, transactions: state.transactions.filter((item) => item.id !== id) });
}

export function archiveCategory(state: BudgetState, id: string): BudgetState {
  validateState(state);
  assertIdentifier(id, "categoryId");
  const category = state.categories.find((item) => item.id === id);
  if (!category) fail("categoryId", "Категория не найдена.");
  const hasActiveLine = state.budgets.some((budget) =>
    budget.lines.some((line) => line.categoryId === id && line.active !== false),
  );
  const hasActiveSchedule = state.scheduledExpenses.some(
    (schedule) => schedule.categoryId === id && schedule.active,
  );
  const hasActiveCommitment = state.annualCommitments.some(
    (commitment) => commitment.categoryId === id && commitment.active,
  );
  if (hasActiveLine || hasActiveSchedule || hasActiveCommitment) {
    fail(
      "categoryId",
      "Сначала отключите активные лимиты и регулярные платежи этой категории.",
    );
  }
  return validateResult({
    ...state,
    categories: state.categories.map((item) => item.id === id ? { ...item, active: false } : item),
  });
}

export interface OperationsErrorView {
  readonly field: string;
  readonly message: string;
}

export function toOperationsErrorView(error: unknown): OperationsErrorView {
  if (error instanceof OperationsValidationError) {
    return { field: error.field, message: error.message };
  }
  return { field: "form", message: "Не удалось сохранить операцию." };
}

export interface OperationsSaveCoordinator {
  readonly locked: boolean;
  apply(change: (current: BudgetState) => BudgetState): Promise<BudgetState>;
}

/** Serializes mutations and re-evaluates every change against the latest durable state. */
export function createOperationsSaveCoordinator(options: {
  readonly repository: { save(state: BudgetState): Promise<void> };
  readonly getCurrent: () => BudgetState;
  readonly prepare: (state: BudgetState) => BudgetState;
  readonly publish: (state: BudgetState) => void;
}): OperationsSaveCoordinator {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    get locked() { return pending > 0; },
    async apply(change) {
      pending += 1;
      let resolveResult!: (state: BudgetState) => void;
      let rejectResult!: (reason: unknown) => void;
      const result = new Promise<BudgetState>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      tail = tail.catch(() => undefined).then(async () => {
        try {
          const current = options.getCurrent();
          validateState(current);
          const changed = validateResult(change(current));
          const next = options.prepare(changed);
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
