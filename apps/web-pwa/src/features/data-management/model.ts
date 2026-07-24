import { type BudgetState, type Transaction, type TransactionKind } from "@family-budget/domain";
import {
  HUMAN_READABLE_CSV_NOTICE,
  serializeHumanReadableCsv,
} from "@family-budget/storage";

export const JSON_EXPORT_MEDIA_TYPE = "application/json;charset=utf-8";
export const CSV_EXPORT_MEDIA_TYPE = "text/csv;charset=utf-8";
export const MAX_RECOVERY_FILE_BYTES = 5 * 1024 * 1024;

export interface RecoveryFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  text(): Promise<string>;
}

export interface PreparedDownload {
  readonly filename: string;
  readonly mediaType: string;
  readonly text: string;
}

export class DataManagementError extends Error {
  readonly userMessage: string;

  constructor(userMessage: string) {
    super("Data-management input validation failed.");
    this.name = "DataManagementError";
    this.userMessage = userMessage;
  }
}

const kindLabels: Record<TransactionKind, string> = {
  income: "Доход",
  expense: "Расход",
  refund: "Возврат",
  transfer: "Перевод",
  goal_contribution: "Взнос в цель",
};

const statusLabels = {
  posted: "Проведена",
  pending: "Ожидает",
  draft: "Черновик",
} as const;

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** Uses the local calendar date so an evening iOS export is not named for the previous UTC day. */
export function localDateStamp(now: Date = new Date()): string {
  if (Number.isNaN(now.getTime())) throw new DataManagementError("Не удалось определить дату выгрузки.");
  return `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`;
}

export function prepareJsonDownload(text: string, now: Date = new Date()): PreparedDownload {
  return {
    filename: `family-budget-backup-${localDateStamp(now)}.json`,
    mediaType: JSON_EXPORT_MEDIA_TYPE,
    text,
  };
}

function formatAmount(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  return `${sign}${Math.floor(absolute / 100)},${String(absolute % 100).padStart(2, "0")}`;
}

function transactionContext(
  transaction: Transaction,
  accountNames: ReadonlyMap<string, string>,
  categoryNames: ReadonlyMap<string, string>,
  goalNames: ReadonlyMap<string, string>,
): readonly string[] {
  const account = (id: string) => accountNames.get(id) ?? "Неизвестный счёт";
  const category = (id: string) => categoryNames.get(id) ?? "Неизвестная категория";
  switch (transaction.kind) {
    case "income":
      return [account(transaction.accountId), "", ""];
    case "expense":
      return [account(transaction.accountId), category(transaction.categoryId), ""];
    case "refund":
      return [
        account(transaction.accountId),
        category(transaction.categoryId),
        transaction.originalTransactionId,
      ];
    case "transfer":
      return [
        `${account(transaction.fromAccountId)} → ${account(transaction.toAccountId)}`,
        "",
        "",
      ];
    case "goal_contribution":
      return [
        `${account(transaction.fromAccountId)} → ${account(transaction.toAccountId)}`,
        goalNames.get(transaction.goalId) ?? "Неизвестная цель",
        "",
      ];
  }
}

export const OPERATIONS_CSV_HEADERS = [
  "Дата",
  "Тип",
  "Статус",
  "Сумма, ₽",
  "Счёт",
  "Категория или цель",
  "Связь с исходной операцией",
] as const;

export function createOperationsCsv(state: BudgetState): string {
  const accountNames = new Map(state.accounts.map((item) => [item.id, item.name]));
  const categoryNames = new Map(state.categories.map((item) => [item.id, item.name]));
  const goalNames = new Map(state.goals.map((item) => [item.id, item.name]));
  const rows = state.transactions.map((transaction) => {
    const [account, categoryOrGoal, relation] = transactionContext(
      transaction,
      accountNames,
      categoryNames,
      goalNames,
    );
    return [
      transaction.occurredOn,
      kindLabels[transaction.kind],
      statusLabels[transaction.status],
      formatAmount(transaction.amountMinor),
      account,
      categoryOrGoal,
      relation,
    ];
  });
  return serializeHumanReadableCsv(OPERATIONS_CSV_HEADERS, rows);
}

export function prepareOperationsCsvDownload(
  state: BudgetState,
  now: Date = new Date(),
): PreparedDownload {
  return {
    filename: `family-budget-operations-${localDateStamp(now)}.csv`,
    mediaType: CSV_EXPORT_MEDIA_TYPE,
    text: createOperationsCsv(state),
  };
}

export function validateRecoveryFile(file: RecoveryFile): void {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_RECOVERY_FILE_BYTES) {
    throw new DataManagementError("Файл резервной копии должен быть не больше 5 МБ.");
  }
  if (!file.name.toLocaleLowerCase("ru-RU").endsWith(".json")) {
    throw new DataManagementError("Выберите файл резервной копии JSON.");
  }
  if (file.type !== "" && file.type !== "application/json") {
    throw new DataManagementError("Выберите JSON-файл из доверенного источника.");
  }
}

export function formatLastBackupDate(createdAt: string | null): string {
  if (!createdAt) return "резервная копия ещё не создавалась";
  const value = new Date(createdAt);
  if (Number.isNaN(value.getTime())) return "дата недоступна";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

export { HUMAN_READABLE_CSV_NOTICE };
