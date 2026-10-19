import {
  baseAmountOf,
  baseCurrencyOf,
  currencyExponent,
  isSupportedCurrency,
  type BudgetState,
  type ExchangeRateValue,
  type Transaction,
  type TransactionKind,
} from "@family-budget/domain";
import { debtVerb } from "../operations/transaction-words";
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
  debt_out: "Долг: со счёта",
  debt_in: "Долг: на счёт",
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

/** Сумма в минимальных единицах словами таблицы: целая часть, запятая и столько знаков, сколько у валюты. */
function formatAmount(minor: number, exponent = 2): string {
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  if (exponent === 0) return `${sign}${absolute}`;
  const scale = 10 ** exponent;
  return `${sign}${Math.floor(absolute / scale)},${String(absolute % scale).padStart(exponent, "0")}`;
}

/** Знаков у валюты; для кода, которого сборка не знает, — два, как писала таблица всегда. */
function exponentOf(currency: string | undefined): number {
  return currency !== undefined && isSupportedCurrency(currency) ? currencyExponent(currency) : 2;
}

const RATE_DIGITS = 6n;

/**
 * Курс как его читает человек: сколько единиц базовой валюты стоит одна единица чужой — «90» или
 * «92,5». Точное деление целых, до шести знаков, половина вверх, без хвостовых нулей.
 */
function formatRate(rate: ExchangeRateValue, quoteCurrency: string, baseCurrency: string): string {
  const numerator = BigInt(rate.baseMinor) * 10n ** BigInt(exponentOf(quoteCurrency)) * 10n ** RATE_DIGITS;
  const denominator = BigInt(rate.quoteMinor) * 10n ** BigInt(exponentOf(baseCurrency));
  let scaled = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) scaled += 1n;
  const unit = 10n ** RATE_DIGITS;
  const fraction = String(scaled % unit).padStart(Number(RATE_DIGITS), "0").replace(/0+$/, "");
  return fraction === "" ? String(scaled / unit) : `${scaled / unit},${fraction}`;
}

function transactionContext(
  transaction: Transaction,
  accountNames: ReadonlyMap<string, string>,
  categoryNames: ReadonlyMap<string, string>,
  goalNames: ReadonlyMap<string, string>,
  counterparties: ReadonlyMap<string, string>,
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
    // Контрагент долга — в своём столбце «Долг», а не в столбце категории.
    case "debt_out":
    case "debt_in":
      return [account(transaction.accountId), "", ""];
  }
}

/** Счёт, с которого операция считается: единственный у дохода, расхода, возврата и долга, исходный у перевода. */
function sourceAccountId(transaction: Transaction): string {
  return transaction.kind === "transfer" || transaction.kind === "goal_contribution"
    ? transaction.fromAccountId
    : transaction.accountId;
}

/** Вид операции словами; у долга — один из четырёх глаголов по его направлению. */
function kindWord(transaction: Transaction, directions: ReadonlyMap<string, "i_owe" | "owed_to_me">): string {
  if (transaction.kind === "debt_out" || transaction.kind === "debt_in") {
    return debtVerb(transaction.kind, directions.get(transaction.debtId));
  }
  return kindLabels[transaction.kind];
}

/**
 * Столбцы выгрузки операций. Первые семь не меняются никогда: по ним человек строил свои таблицы,
 * и «Сумма, ₽» по-прежнему сумма в базовой валюте. Столбцы волны 1 дописаны в конец.
 */
export const OPERATIONS_CSV_HEADERS = [
  "Дата",
  "Тип",
  "Статус",
  "Сумма, ₽",
  "Счёт",
  "Категория или цель",
  "Связь с исходной операцией",
  "Валюта счёта",
  "Сумма в валюте счёта",
  "Курс",
  "Сумма зачисления",
  "Валюта зачисления",
  "Долг",
  "Комментарий",
  "Метки",
] as const;

export function createOperationsCsv(state: BudgetState): string {
  const accountNames = new Map(state.accounts.map((item) => [item.id, item.name]));
  const accountCurrencies = new Map(state.accounts.map((item) => [item.id, item.currency]));
  const categoryNames = new Map(state.categories.map((item) => [item.id, item.name]));
  const goalNames = new Map(state.goals.map((item) => [item.id, item.name]));
  const counterparties = new Map((state.debts ?? []).map((item) => [item.id, item.counterparty]));
  const debtCurrencies = new Map((state.debts ?? []).map((item) => [item.id, item.currency]));
  const directions = new Map((state.debts ?? []).map((item) => [item.id, item.direction]));
  const tagNames = new Map((state.tags ?? []).map((item) => [item.id, item.name]));
  const base = baseCurrencyOf(state);
  const rows = state.transactions.map((transaction) => {
    const [account, categoryOrGoal, relation] = transactionContext(
      transaction,
      accountNames,
      categoryNames,
      goalNames,
      counterparties,
    );
    const currency = accountCurrencies.get(sourceAccountId(transaction));
    // В базовой валюте: снимок у дохода, расхода и возврата; у перевода, взноса и долга — сумма,
    // если счёт-источник в базовой валюте, и пусто, если нет: курса на ней нет, и выдумывать его
    // таблица не берётся.
    let baseAmount = "";
    let rate = "";
    let arrived = "";
    let arrivedCurrency = "";
    let debt = "";
    switch (transaction.kind) {
      case "income":
      case "expense":
      case "refund":
        baseAmount = formatAmount(baseAmountOf(transaction), exponentOf(base));
        if (transaction.rate !== undefined && currency !== undefined) rate = formatRate(transaction.rate, currency, base);
        break;
      case "transfer":
        if (currency === base) baseAmount = formatAmount(transaction.amountMinor, exponentOf(base));
        if (transaction.toAmountMinor !== undefined) {
          arrivedCurrency = accountCurrencies.get(transaction.toAccountId) ?? "";
          arrived = formatAmount(transaction.toAmountMinor, exponentOf(arrivedCurrency));
        }
        break;
      case "goal_contribution":
        if (currency === base) baseAmount = formatAmount(transaction.amountMinor, exponentOf(base));
        break;
      case "debt_out":
      case "debt_in":
        if (currency === base) baseAmount = formatAmount(transaction.amountMinor, exponentOf(base));
        if (transaction.debtAmountMinor !== undefined) {
          arrivedCurrency = debtCurrencies.get(transaction.debtId) ?? "";
          arrived = formatAmount(transaction.debtAmountMinor, exponentOf(arrivedCurrency));
        }
        debt = counterparties.get(transaction.debtId) ?? "Неизвестный долг";
        break;
    }
    return [
      transaction.occurredOn,
      kindWord(transaction, directions),
      statusLabels[transaction.status],
      baseAmount,
      account,
      categoryOrGoal,
      relation,
      currency ?? "",
      formatAmount(transaction.amountMinor, exponentOf(currency)),
      rate,
      arrived,
      arrivedCurrency,
      debt,
      transaction.note ?? "",
      (transaction.tagIds ?? []).map((tagId) => tagNames.get(tagId) ?? "Неизвестная метка").join(", "),
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
