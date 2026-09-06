import { type BudgetState, type CategoryType } from "@family-budget/domain";
import {
  createTransactions,
  deleteTransactions,
  type OperationsIdFactory,
  type TransactionDraft,
} from "../operations/model";
import type { ClassifiedOperation, MerchantMemoryEntry } from "./classify";

/**
 * План импорта: что именно попадёт в бюджет, если человек нажмёт «Добавить».
 *
 * План считается заново на каждое изменение выбора и показывается **до** записи: ошибка импорта,
 * которую нельзя отменить, хуже отсутствия импорта, поэтому сначала предпросмотр, потом запись,
 * и запись одним изменением состояния — тем же координатором, что и ручной ввод, — чтобы её можно
 * было отменить одним же изменением.
 */
export type Assignment =
  | { readonly kind: "category"; readonly categoryId: string }
  | { readonly kind: "no-category" }
  | { readonly kind: "skip" };

export interface ImportChoices {
  /** Счёт, по которому выгружена выписка. */
  readonly accountId: string;
  /** Второй счёт для переводов между своими; `null` — переводы себе не добавляются. */
  readonly transferAccountId: string | null;
  /** Назначения незнакомым продавцам, по ключу продавца. */
  readonly assignments: Readonly<Record<string, Assignment>>;
  readonly includeDuplicates: boolean;
}

export type PlannedReason =
  | "included"
  | "unassigned"
  | "skipped"
  | "self-transfer-excluded"
  | "duplicate";

export interface PlannedRow {
  readonly row: ClassifiedOperation;
  readonly draft: TransactionDraft | null;
  readonly reason: PlannedReason;
}

export interface ImportPlanCounts {
  readonly included: number;
  readonly expenses: number;
  readonly incomes: number;
  readonly transfers: number;
  readonly unassigned: number;
  readonly skipped: number;
  readonly selfTransfersExcluded: number;
  /** Не добавленные как похожие на уже записанные. */
  readonly duplicates: number;
  /** Все похожие на уже записанные — и отложенные, и добавленные по просьбе: по ним показывается переключатель. */
  readonly duplicateCandidates: number;
  /** Записи с датой вне месяца плана: попадут в историю, конверты не тронут. */
  readonly outsidePeriod: number;
}

export interface ImportPlanTotals {
  readonly expenseMinor: number;
  readonly incomeMinor: number;
  readonly transferMinor: number;
  /** Сумма переводов себе, не вошедших в план: цифра для предпросмотра, чтобы их не искали в тратах. */
  readonly selfTransferExcludedMinor: number;
}

export interface ImportPlan {
  readonly rows: readonly PlannedRow[];
  readonly drafts: readonly TransactionDraft[];
  readonly counts: ImportPlanCounts;
  readonly totals: ImportPlanTotals;
  /** Что запомнить после подтверждения: назначения незнакомым продавцам. */
  readonly memoryUpdates: readonly MerchantMemoryEntry[];
}

/** «123456» копеек → «1234.56»: строка, которую принимает `parseMoney` без потерь. */
export function amountInput(minor: number): string {
  const rubles = Math.floor(minor / 100);
  const kopecks = minor % 100;
  return kopecks === 0 ? String(rubles) : `${rubles}.${String(kopecks).padStart(2, "0")}`;
}

function duplicateKey(kind: string, occurredOn: string, amountMinor: number, accountId: string): string {
  return `${kind}|${occurredOn}|${amountMinor}|${accountId}`;
}

/**
 * Похожие на уже записанные: та же дата, та же сумма, тот же вид и счёт. Выписку часто грузят
 * дважды — за перекрывающиеся периоды, — и без этой проверки каждая покупка удвоилась бы молча.
 */
export function existingTransactionKeys(state: Pick<BudgetState, "transactions">): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const transaction of state.transactions) {
    if (transaction.status !== "posted") continue;
    if (transaction.kind === "expense" || transaction.kind === "income") {
      keys.add(duplicateKey(transaction.kind, transaction.occurredOn, transaction.amountMinor, transaction.accountId));
    } else if (transaction.kind === "transfer") {
      keys.add(duplicateKey("transfer", transaction.occurredOn, transaction.amountMinor, transaction.fromAccountId));
    }
  }
  return keys;
}

function draftFor(
  row: ClassifiedOperation,
  choices: ImportChoices,
  categoryTypeOf: (id: string) => CategoryType | undefined,
): { draft: TransactionDraft | null; reason: PlannedReason } {
  const { operation, placement } = row;
  const common = { status: "posted" as const, occurredOn: operation.occurredOn, amount: amountInput(operation.amountMinor) };
  if (placement.kind === "self-transfer") {
    if (choices.transferAccountId === null || choices.transferAccountId === choices.accountId) {
      return { draft: null, reason: "self-transfer-excluded" };
    }
    const [fromAccountId, toAccountId] = operation.direction === "out"
      ? [choices.accountId, choices.transferAccountId]
      : [choices.transferAccountId, choices.accountId];
    return { draft: { ...common, kind: "transfer", fromAccountId, toAccountId }, reason: "included" };
  }
  if (placement.kind === "expense") {
    return { draft: { ...common, kind: "expense", accountId: choices.accountId, categoryId: placement.categoryId }, reason: "included" };
  }
  if (placement.kind === "income") {
    return { draft: { ...common, kind: "income", accountId: choices.accountId, categoryId: placement.categoryId ?? "" }, reason: "included" };
  }
  const assignment = choices.assignments[row.merchantKey];
  if (assignment === undefined) return { draft: null, reason: "unassigned" };
  if (assignment.kind === "skip") return { draft: null, reason: "skipped" };
  // Один продавец может встретиться и в списании, и в зачислении (возврат от магазина): категория
  // не того вида к такой строке не применяется, и она остаётся ждать своего назначения, а не
  // роняет запись всего файла на проверке домена.
  const assignedType = assignment.kind === "category" ? categoryTypeOf(assignment.categoryId) : undefined;
  if (operation.direction === "out") {
    if (assignment.kind !== "category" || assignedType !== "expense") return { draft: null, reason: "unassigned" };
    return { draft: { ...common, kind: "expense", accountId: choices.accountId, categoryId: assignment.categoryId }, reason: "included" };
  }
  if (assignment.kind === "category" && assignedType !== "income") return { draft: null, reason: "unassigned" };
  return {
    draft: { ...common, kind: "income", accountId: choices.accountId, categoryId: assignment.kind === "category" ? assignment.categoryId : "" },
    reason: "included",
  };
}

export function buildImportPlan(
  rows: readonly ClassifiedOperation[],
  state: BudgetState,
  choices: ImportChoices,
  now: Date = new Date(),
): ImportPlan {
  const existing = existingTransactionKeys(state);
  const activeBudget = state.budgets.find((item) => item.id === state.activeBudgetId);
  const categoryById = new Map(state.categories.map((category) => [category.id, category]));
  const counts = { included: 0, expenses: 0, incomes: 0, transfers: 0, unassigned: 0, skipped: 0, selfTransfersExcluded: 0, duplicates: 0, duplicateCandidates: 0, outsidePeriod: 0 };
  const totals = { expenseMinor: 0, incomeMinor: 0, transferMinor: 0, selfTransferExcludedMinor: 0 };
  const drafts: TransactionDraft[] = [];
  const planned: PlannedRow[] = [];

  for (const row of rows) {
    const { draft, reason } = draftFor(row, choices, (id) => categoryById.get(id)?.type);
    if (draft === null) {
      if (reason === "unassigned") counts.unassigned += 1;
      else if (reason === "skipped") counts.skipped += 1;
      else if (reason === "self-transfer-excluded") {
        counts.selfTransfersExcluded += 1;
        totals.selfTransferExcludedMinor += row.operation.amountMinor;
      }
      planned.push({ row, draft: null, reason });
      continue;
    }
    const accountForKey = draft.kind === "expense" || draft.kind === "income" ? draft.accountId : draft.kind === "transfer" ? draft.fromAccountId : "";
    const duplicate = existing.has(duplicateKey(draft.kind, draft.occurredOn, row.operation.amountMinor, accountForKey));
    if (duplicate) counts.duplicateCandidates += 1;
    if (duplicate && !choices.includeDuplicates) {
      counts.duplicates += 1;
      planned.push({ row, draft: null, reason: "duplicate" });
      continue;
    }
    counts.included += 1;
    if (draft.kind === "expense") {
      counts.expenses += 1;
      totals.expenseMinor += row.operation.amountMinor;
    } else if (draft.kind === "income") {
      counts.incomes += 1;
      totals.incomeMinor += row.operation.amountMinor;
    } else {
      counts.transfers += 1;
      totals.transferMinor += row.operation.amountMinor;
    }
    if (activeBudget && (draft.occurredOn < activeBudget.startDate || draft.occurredOn > activeBudget.endDate)) {
      counts.outsidePeriod += 1;
    }
    drafts.push(draft);
    planned.push({ row, draft, reason: "included" });
  }

  const updatedAt = now.toISOString();
  const memoryUpdates: MerchantMemoryEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.placement.kind !== "unknown" || seen.has(row.merchantKey) || row.merchantKey === "") continue;
    const assignment = choices.assignments[row.merchantKey];
    if (assignment === undefined || assignment.kind === "skip") continue;
    const type: CategoryType = row.operation.direction === "out" ? "expense" : "income";
    if (assignment.kind === "no-category") {
      if (type === "income") {
        seen.add(row.merchantKey);
        memoryUpdates.push({ key: row.merchantKey, categoryName: null, type, updatedAt });
      }
      continue;
    }
    const category = categoryById.get(assignment.categoryId);
    if (!category || category.type !== type) continue;
    seen.add(row.merchantKey);
    memoryUpdates.push({ key: row.merchantKey, categoryName: category.name, type, updatedAt });
  }

  return { rows: planned, drafts, counts, totals, memoryUpdates };
}

export interface AppliedImport {
  readonly state: BudgetState;
  readonly ids: readonly string[];
}

/** Одно изменение состояния на весь файл: тем же путём, что ручная запись, только пачкой. */
export function applyImportPlan(
  state: BudgetState,
  drafts: readonly TransactionDraft[],
  makeId: OperationsIdFactory = () => crypto.randomUUID(),
): AppliedImport {
  return createTransactions(state, drafts, makeId);
}

/** Отмена: удаляются ровно те операции, которые добавил импорт, — по их идентификаторам. */
export function undoImport(state: BudgetState, ids: readonly string[]): BudgetState {
  return deleteTransactions(state, ids);
}
