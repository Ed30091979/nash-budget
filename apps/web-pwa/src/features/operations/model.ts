import {
  baseCurrencyOf,
  baseSnapshot,
  calculateBudget,
  categoryNameKey,
  createCategory,
  CategoryValidationError,
  currencyExponent,
  documentIds,
  indexRates,
  isSupportedCurrency,
  isWithinDateWindow,
  manualSnapshot,
  MAX_LOCAL_DATE,
  MAX_MONEY_MINOR,
  MAX_TAGS_PER_TRANSACTION,
  MIN_LOCAL_DATE,
  normalizeNote,
  normalizeTagIds,
  NOTE_MAX_LENGTH,
  snapshotAt,
  TextValidationError,
  type BaseSnapshot,
  type BudgetLine,
  type BudgetMetrics,
  type BudgetState,
  type CategoryGroup,
  type CategoryType,
  type ExchangeRate,
  type ExchangeRateValue,
  type Transaction,
  type TransactionStatus,
} from "@family-budget/domain";
import { BACKUP_LIMITS } from "../../backup";
import { parseMoney } from "../../money";
import { BudgetWriteRefusal } from "../../write-refusal";

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
  /** In the currency of the account the money moves from (or to, for an income and a refund). */
  readonly amount: string;
  /** A one-line note; empty or absent — no note. Normalised by the domain's input rule. */
  readonly note?: string;
  /** Tags of the operation; empty or absent — none. At most `MAX_TAGS_PER_TRANSACTION`. */
  readonly tagIds?: readonly string[];
}

/**
 * The value in the base currency of an income, an expense or a refund on a foreign account. Absent —
 * the rate of the operation's day (`baseSnapshot`); typed — that sum, written as the exact rate
 * «sum for sum» (D-031). On an account in the base currency it is ignored: the amount is the figure.
 */
interface ForeignValueDraft {
  readonly baseAmount?: string;
}

export interface IncomeDraft extends CommonTransactionDraft, ForeignValueDraft {
  readonly kind: "income";
  readonly accountId: string;
  /**
   * Категория дохода. Пустая строка — «без категории», и это законное состояние: домен объявил
   * поле необязательным, и доход, записанный без него, обязан сохраняться так же, как раньше.
   */
  readonly categoryId: string;
}

export interface ExpenseDraft extends CommonTransactionDraft, ForeignValueDraft {
  readonly kind: "expense";
  readonly accountId: string;
  readonly categoryId: string;
}

export interface RefundDraft extends CommonTransactionDraft, ForeignValueDraft {
  readonly kind: "refund";
  readonly accountId: string;
  readonly originalTransactionId: string;
}

export interface TransferDraft extends CommonTransactionDraft {
  readonly kind: "transfer";
  readonly fromAccountId: string;
  readonly toAccountId: string;
  /**
   * What arrived, in the receiving account's currency — only between two currencies, where it is
   * required; within one currency the amount is one amount and this is ignored.
   */
  readonly toAmount?: string;
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

/**
 * Every identifier of the document, through the domain's one census (`documentIds`), so that a
 * collection added to the model — participants, tags — is counted here the day it is added rather
 * than the day somebody remembers this copy. A new operation must not take an identifier any
 * entity of any kind already holds: a backup refuses such a file.
 */
function allDocumentIds(state: BudgetState): Set<string> {
  const ids = new Set<string>();
  for (const id of documentIds(state)) {
    assertIdentifier(id, "document");
    if (ids.has(id)) fail("document", "Документ содержит повторяющийся идентификатор.");
    ids.add(id);
  }
  return ids;
}

function totalBudgetLines(state: BudgetState): number {
  return state.budgets.reduce((count, budget) => count + budget.lines.length, 0);
}

/**
 * Проверка всего документа после правки — без пределов числа записей. Они ограничивают только рост:
 * новую запись вида, которого уже столько, сколько позволено, или больше, форма не создаёт (каждая
 * функция `create…` проверяет свой вид). Документ, в котором записей больше предела, — обычное
 * следствие того, что несколько устройств семьи добавляли записи офлайн, — правится и чистится как
 * любой другой: отказ здесь запрещал бы удалить лишнее и тем самым навсегда держал бы семью за
 * пределом, а не в нём.
 */
function validateState(state: BudgetState): BudgetMetrics {
  try {
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
  // Окно календаря, которое переносит журнал семьи: дату за его пределами запись приняла бы, а
  // синхронизация потом отвергла бы на каждом устройстве. Старые документы читаются как раньше.
  if (!isWithinDateWindow(value)) {
    return fail("occurredOn", `Выберите дату с ${MIN_LOCAL_DATE.slice(0, 4)} по ${MAX_LOCAL_DATE.slice(0, 4)} год.`);
  }
  return value;
}

/** Digits of the minor unit of an account's currency: two when the code is not one the model knows. */
function exponentOf(currency: string): number {
  return isSupportedCurrency(currency) ? currencyExponent(currency) : 2;
}

function amountRefusal(exponent: number): string {
  if (exponent === 0) return "Введите положительную сумму целым числом.";
  return `Введите положительную сумму, не более ${exponent === 3 ? "трёх" : "двух"} знаков после запятой.`;
}

function parsePositiveMoney(value: string, exponent = 2, field = "amount"): number {
  let minor: number;
  try {
    minor = parseMoney(value, exponent);
  } catch {
    return fail(field, amountRefusal(exponent));
  }
  if (minor > MAX_MONEY_MINOR) return fail(field, "Сумма превышает максимально допустимое значение.");
  return minor;
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
): BudgetState["accounts"][number] {
  assertIdentifier(id, field);
  const account = state.accounts.find((item) => item.id === id);
  if (!account || (!account.active && id !== allowedArchivedId)) return fail(field, "Выберите активный счёт.");
  return account;
}

/** «19 октября» — день, на который нет курса, словом. */
const dayWords = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });

/** Сообщение, когда операцию в другой валюте оценить нечем: название валюты, дня и выхода из положения. */
export function missingRateMessage(currency: string, baseCurrency: string, date: string): string {
  const day = dayWords.format(new Date(`${date}T00:00:00.000Z`)).replace(/ /gu, "\u00a0");
  return `Курса ${currency} на ${day} нет. Задайте курс или впишите сумму в ${baseCurrency} вручную.`;
}

/**
 * The rate an edit keeps: the one the operation was written at, while the edit leaves its account
 * and its day as they were — correcting a note must not revalue a purchase at a later rate. `null`
 * for a new operation, or when the account or the day changed (then the rate of the day applies).
 */
function keptRate(current: Transaction | undefined, accountId: string, occurredOn: string, baseCurrency: string): ExchangeRateValue | null {
  if (
    current !== undefined
    && (current.kind === "income" || current.kind === "expense" || current.kind === "refund")
    && current.accountId === accountId
    && current.occurredOn === occurredOn
    && current.rate !== undefined
    && current.baseCurrency === baseCurrency
  ) return current.rate;
  return null;
}

/**
 * What a write of `amountMinor` on a foreign account will store, said before the write — the
 * entry sheet's estimate (review of 2b, MEDIUM-2). The same choice as {@link snapshotFor}: the
 * operation's own rate while the edit keeps its account and day, otherwise the rate of the day,
 * otherwise nothing to value it with. `changed` — an edit of a valued operation whose account or
 * day moved, so the sheet can say why the figure is a new one. Zero or an unvalued sum estimates
 * to zero rather than to a refusal: the sum is still being typed.
 */
export type SnapshotPreview =
  | { readonly kind: "kept"; readonly baseMinor: number; readonly rate: ExchangeRateValue }
  | { readonly kind: "day"; readonly baseMinor: number; readonly rate: ExchangeRate; readonly changed: boolean }
  | { readonly kind: "missing" };

export function snapshotPreview(
  state: BudgetState,
  account: Pick<BudgetState["accounts"][number], "id" | "currency">,
  amountMinor: number,
  occurredOn: string,
  current: Transaction | undefined,
): SnapshotPreview {
  const baseCurrency = baseCurrencyOf(state);
  const kept = keptRate(current, account.id, occurredOn, baseCurrency);
  if (kept !== null) {
    const snapshot = amountMinor > 0 ? snapshotAt(amountMinor, baseCurrency, kept) : null;
    // A sum the kept rate cannot value falls through to the rate of the day — as the write does.
    if (snapshot !== null || amountMinor <= 0) return { kind: "kept", baseMinor: snapshot?.baseAmountMinor ?? 0, rate: kept };
  }
  const rates = indexRates(state.exchangeRates ?? []);
  const rate = rates.find(account.currency, baseCurrency, occurredOn);
  if (rate === undefined) return { kind: "missing" };
  const snapshot = amountMinor > 0 ? baseSnapshot(amountMinor, account.currency, baseCurrency, rates, occurredOn) : null;
  const changed = current !== undefined
    && (current.kind === "income" || current.kind === "expense" || current.kind === "refund")
    && current.rate !== undefined
    && (current.accountId !== account.id || current.occurredOn !== occurredOn);
  return { kind: "day", baseMinor: snapshot?.baseAmountMinor ?? 0, rate, changed };
}

/**
 * The base-currency snapshot of an income, an expense or a refund, or nothing on an account in the
 * base currency.
 *
 * A typed base sum is the exact rate «sum for sum» (D-031). Otherwise an edit that keeps the
 * account and the day keeps the rate the operation was written at (`keptRate`), and everything
 * else takes the rate of its day. Without one the operation is refused in words that say what to
 * do, not written without its figure.
 */
function snapshotFor(
  state: BudgetState,
  account: BudgetState["accounts"][number],
  amountMinor: number,
  occurredOn: string,
  draft: ForeignValueDraft,
  current: Transaction | undefined,
): BaseSnapshot | Record<string, never> {
  const baseCurrency = baseCurrencyOf(state);
  if (account.currency === baseCurrency) return {};
  const typed = draft.baseAmount?.trim() ?? "";
  if (typed !== "") {
    const baseMinor = parsePositiveMoney(typed, exponentOf(baseCurrency), "baseAmount");
    const manual = manualSnapshot(amountMinor, baseMinor, baseCurrency);
    if (manual === null) return fail("baseAmount", "Такую пару сумм записать нельзя: проверьте обе.");
    return manual;
  }
  const keptAt = keptRate(current, account.id, occurredOn, baseCurrency);
  if (keptAt !== null) {
    const kept = snapshotAt(amountMinor, baseCurrency, keptAt);
    if (kept !== null) return kept;
  }
  const snapshot = baseSnapshot(amountMinor, account.currency, baseCurrency, indexRates(state.exchangeRates ?? []), occurredOn);
  if (snapshot === null) return fail("baseAmount", missingRateMessage(account.currency, baseCurrency, occurredOn));
  return snapshot;
}

/** The note as it is stored, or nothing; refusals in the words of the field. */
function noteFor(value: string | undefined): { readonly note?: string } {
  let note: string | undefined;
  try {
    note = normalizeNote(value ?? "");
  } catch (error) {
    if (!(error instanceof TextValidationError)) throw error;
    return fail("note", error.code === "too_long"
      ? `Комментарий — не больше ${NOTE_MAX_LENGTH} символов.`
      : "Уберите из комментария скрытые или служебные символы.");
  }
  return note === undefined ? {} : { note };
}

/**
 * The tags as an operation stores them: no repeats, one order, no empty list. Each names a tag of the
 * state; an archived one only if the edited operation already carries it — archive means «not offered
 * for new operations», not «taken off the old ones».
 */
function tagsFor(state: BudgetState, ids: readonly string[] | undefined, current: Transaction | undefined): { readonly tagIds?: readonly string[] } {
  const tagIds = normalizeTagIds(ids ?? []);
  if (tagIds === undefined) return {};
  if (tagIds.length > MAX_TAGS_PER_TRANSACTION) fail("tagIds", `Не больше ${MAX_TAGS_PER_TRANSACTION} меток на одной операции.`);
  const known = new Map((state.tags ?? []).map((tag) => [tag.id, tag]));
  for (const id of tagIds) {
    const tag = known.get(id);
    if (tag === undefined) fail("tagIds", "Метка не найдена: возможно, её удалили на другом устройстве.");
    if (!tag.active && current?.tagIds?.includes(id) !== true) fail("tagIds", `Метка «${tag.name}» в архиве.`);
  }
  return { tagIds };
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

/**
 * Категория дохода, если она названа, — или ничего.
 *
 * Пустая строка не ошибка и не «не выбрано ещё»: у дохода категории может не быть вовсе, и такой
 * доход проходит здесь без единой проверки. Всё остальное сверяется строже, чем на расходной
 * стороне не бывает: категория обязана существовать, быть доходной и быть активной — кроме той,
 * что уже стоит в редактируемой операции и с тех пор ушла в архив.
 */
function incomeCategoryFor(
  state: BudgetState,
  value: string,
  allowedArchivedId?: string,
): string | undefined {
  if (value === "") return undefined;
  assertIdentifier(value, "categoryId");
  const category = state.categories.find((item) => item.id === value);
  if (!category || category.type !== "income" || (!category.active && value !== allowedArchivedId)) {
    fail("categoryId", "Выберите активную категорию доходов.");
  }
  return value;
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
  switch (transaction.kind) {
    case "income":
    case "expense":
    case "refund":
    case "debt_out":
    case "debt_in":
      return [transaction.accountId];
    case "transfer":
    case "goal_contribution":
      return [transaction.fromAccountId, transaction.toAccountId];
  }
}

type CarriedLabels = Pick<Transaction, "memberId" | "recurringRuleId">;

/**
 * What an edit keeps from the operation it edits because the sheet never shows it.
 *
 * The sheet rebuilds an operation from its own fields, and a field it does not have would simply be
 * lost: an edit would take off the participant the operation was credited to — the split by
 * participant would then count it as unattributed, against D-021 and against the journal, whose codec
 * carries the participant on the operation for exactly this reason — and the recurring rule it is an
 * occurrence of. The note and the tags are the sheet's own fields now (wave 2b) and come from the
 * draft; these two are labels no figure reads, so carrying them over cannot move a kopeck. Absent
 * stays absent.
 */
function carriedLabels(current: Transaction | undefined): CarriedLabels {
  if (current === undefined) return {};
  return {
    ...(current.memberId === undefined ? {} : { memberId: current.memberId }),
    ...(current.recurringRuleId === undefined ? {} : { recurringRuleId: current.recurringRuleId }),
  };
}

function makeTransaction(
  state: BudgetState,
  id: string,
  draft: TransactionDraft,
  current?: Transaction,
): Transaction {
  const occurredOn = assertLocalDate(draft.occurredOn);
  const status = assertStatus(draft.status);
  const oldAccounts = current?.kind === draft.kind ? accountIds(current) : [];
  const labels = { ...carriedLabels(current), ...noteFor(draft.note), ...tagsFor(state, draft.tagIds, current) };

  switch (draft.kind) {
    case "income": {
      const account = accountFor(state, draft.accountId, "accountId", oldAccounts[0]);
      const amountMinor = parsePositiveMoney(draft.amount, exponentOf(account.currency));
      const oldCategoryId = current?.kind === "income" ? current.categoryId : undefined;
      const categoryId = incomeCategoryFor(state, draft.categoryId, oldCategoryId);
      // Отсутствующая категория остаётся отсутствующей: `categoryId: undefined` — это не то же
      // самое, что не иметь поля, ни для домена, ни для журнала синхронизации.
      return {
        id,
        kind: "income",
        occurredOn,
        status,
        amountMinor,
        accountId: draft.accountId,
        ...(categoryId === undefined ? {} : { categoryId }),
        ...snapshotFor(state, account, amountMinor, occurredOn, draft, current),
        ...labels,
      };
    }
    case "expense": {
      const account = accountFor(state, draft.accountId, "accountId", oldAccounts[0]);
      const amountMinor = parsePositiveMoney(draft.amount, exponentOf(account.currency));
      const oldCategoryId = current?.kind === "expense" ? current.categoryId : undefined;
      expenseCategoryFor(state, draft.categoryId, oldCategoryId);
      return {
        id, kind: "expense", occurredOn, status, amountMinor, accountId: draft.accountId, categoryId: draft.categoryId,
        ...snapshotFor(state, account, amountMinor, occurredOn, draft, current),
        ...labels,
      };
    }
    case "refund": {
      const account = accountFor(state, draft.accountId, "accountId", oldAccounts[0]);
      const amountMinor = parsePositiveMoney(draft.amount, exponentOf(account.currency));
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
        ...snapshotFor(state, account, amountMinor, occurredOn, draft, current),
        ...labels,
      };
    }
    case "transfer": {
      const from = accountFor(state, draft.fromAccountId, "fromAccountId", oldAccounts[0]);
      const to = accountFor(state, draft.toAccountId, "toAccountId", oldAccounts[1]);
      if (draft.fromAccountId === draft.toAccountId) fail("toAccountId", "Выберите другой счёт назначения.");
      const amountMinor = parsePositiveMoney(draft.amount, exponentOf(from.currency));
      // Между двумя валютами сумма зачисления — своя, в валюте счёта назначения, и обязательна:
      // курс перевода назначает банк, а не таблица курсов.
      let arrived = {};
      if (from.currency !== to.currency) {
        const typed = draft.toAmount?.trim() ?? "";
        if (typed === "") fail("toAmount", `Впишите, сколько пришло на счёт «${to.name}», в ${to.currency}.`);
        arrived = { toAmountMinor: parsePositiveMoney(typed, exponentOf(to.currency), "toAmount") };
      }
      return { id, kind: "transfer", occurredOn, status, amountMinor, fromAccountId: draft.fromAccountId, toAccountId: draft.toAccountId, ...arrived, ...labels };
    }
    case "goal_contribution": {
      const from = accountFor(state, draft.fromAccountId, "fromAccountId", oldAccounts[0]);
      const to = accountFor(state, draft.toAccountId, "toAccountId", oldAccounts[1]);
      if (draft.fromAccountId === draft.toAccountId) fail("toAccountId", "Выберите другой счёт назначения.");
      if (from.currency !== to.currency) fail("toAccountId", "Взнос в цель идёт со счёта в той же валюте, что и счёт цели.");
      const amountMinor = parsePositiveMoney(draft.amount, exponentOf(from.currency));
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
        ...labels,
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

export interface TransactionBatchCreation {
  readonly state: BudgetState;
  /** Идентификаторы созданных операций, в порядке черновиков: по ним пачку можно отменить. */
  readonly ids: readonly string[];
}

/**
 * Записывает несколько операций одним изменением состояния.
 *
 * Тот же путь, что у одиночной записи: те же проверки счёта, категории, даты и суммы для каждой
 * операции, та же проверка целого документа — только один раз на пачку, а не на каждую строку.
 * Нужно импорту выписки: сотни операций через `createTransaction` по одной пересчитывали бы весь
 * бюджет сотни раз, а координатор записи всё равно сохраняет состояние целиком.
 */
export function createTransactions(
  state: BudgetState,
  drafts: readonly TransactionDraft[],
  makeId: OperationsIdFactory = () => crypto.randomUUID(),
): TransactionBatchCreation {
  validateState(state);
  if (state.transactions.length + drafts.length > OPERATIONS_LIMITS.transactions) {
    fail("transactions", "Достигнут лимит операций.");
  }
  const ids = allDocumentIds(state);
  const created = drafts.map((draft) => {
    const id = nextId(ids, makeId);
    return makeTransaction(state, id, draft);
  });
  return {
    state: validateResult({ ...state, transactions: [...state.transactions, ...created] }),
    ids: created.map((transaction) => transaction.id),
  };
}

/**
 * Удаляет несколько операций одним изменением: отмена импорта. Отказывает, если хоть одной нет
 * или если с одной из них связан возврат, который не удаляется вместе с ней.
 */
export function deleteTransactions(state: BudgetState, ids: readonly string[]): BudgetState {
  validateState(state);
  const removing = new Set(ids.map((id) => assertIdentifier(id)));
  for (const id of removing) {
    if (!state.transactions.some((item) => item.id === id)) fail("id", "Операция не найдена.");
  }
  const blocked = state.transactions.some(
    (item) => item.kind === "refund" && removing.has(item.originalTransactionId) && !removing.has(item.id),
  );
  if (blocked) fail("id", "Сначала удалите связанные возвраты.");
  return validateResult({ ...state, transactions: state.transactions.filter((item) => !removing.has(item.id)) });
}

/** Words for an operation the sheet cannot show whole yet: a debt movement (its sheet is wave 2e). */
export const DEBT_EDIT_REFUSAL = "Операцию по долгу этот лист пока не изменяет.";

/**
 * An operation the sheet cannot show whole is not edited by it: the sheet would rebuild it from its
 * own fields and lose what it does not have. Since wave 2b that is only a debt movement — the sheet
 * has no debt and no sum in the debt's currency; the base-currency value and the amount that
 * arrived are its own fields now.
 */
function assertEditableByForm(current: Transaction): void {
  if (current.kind === "debt_out" || current.kind === "debt_in") fail("kind", DEBT_EDIT_REFUSAL);
}

export function editTransaction(state: BudgetState, id: string, draft: TransactionDraft): BudgetState {
  validateState(state);
  assertIdentifier(id);
  const current = state.transactions.find((item) => item.id === id);
  if (!current) fail("id", "Операция не найдена.");
  assertEditableByForm(current);
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

/**
 * Puts an operation back exactly as it was before an edit: «Отменить» in the toast that announced
 * the edit. The stored operation is the one the domain accepted then; the whole document is checked
 * again now, so a change that came from another device in between still cannot leave a broken state.
 */
export function restoreTransaction(state: BudgetState, previous: Transaction): BudgetState {
  validateState(state);
  assertIdentifier(previous.id);
  if (!state.transactions.some((item) => item.id === previous.id)) fail("id", "Операция не найдена.");
  return validateResult({ ...state, transactions: state.transactions.map((item) => item.id === previous.id ? previous : item) });
}

/**
 * Writes a deleted operation again — «Отменить» in the toast that announced the delete — under a
 * new identifier: in the family journal a delete is final, and the same identifier written again
 * would come back on this device alone. Everything else is the operation as it was.
 */
export function recreateTransaction(
  state: BudgetState,
  deleted: Transaction,
  makeId: OperationsIdFactory = () => crypto.randomUUID(),
): TransactionBatchCreation {
  validateState(state);
  if (state.transactions.length >= OPERATIONS_LIMITS.transactions) fail("transactions", "Достигнут лимит операций.");
  const id = nextId(allDocumentIds(state), makeId);
  const recreated = { ...deleted, id } as Transaction;
  return { state: validateResult({ ...state, transactions: [...state.transactions, recreated] }), ids: [id] };
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

function parseLimitMoney(value: string): number {
  try {
    return parseMoney(value);
  } catch {
    return fail("limit", "Введите положительную сумму в рублях, не более двух знаков после запятой.");
  }
}

export interface OperationCategoryDraft {
  readonly name: string;
  readonly type: CategoryType;
  readonly group: CategoryGroup;
  /** Пусто — категория без месячного лимита. Лимит не часть категории, а строка бюджета. */
  readonly limit: string;
}

export interface OperationCategoryCreation {
  readonly state: BudgetState;
  readonly categoryId: string;
}

/**
 * Заводит категорию прямо из формы операции и, если сумма названа, сразу даёт ей месячный лимит.
 *
 * Категория создаётся доменом — здесь не повторяется ни одна его проверка имени, группы и вида,
 * только переводятся его отказы в те же поля, которыми говорит остальная форма. Лимит
 * необязателен и добавляется отдельной строкой активного бюджета: заводить категорию ради
 * покупки, лимит на которую никто не планировал, — обычное дело, и требовать сумму значило бы
 * вернуть тот самый окольный путь через «Добавить лимит», ради ухода от которого всё и делается.
 */
export function createOperationCategory(
  state: BudgetState,
  draft: OperationCategoryDraft,
  makeId: OperationsIdFactory = () => crypto.randomUUID(),
): OperationCategoryCreation {
  validateState(state);
  if (state.categories.length >= OPERATIONS_LIMITS.categories) {
    fail("name", "Достигнут лимит категорий.");
  }
  const ids = allDocumentIds(state);
  let created;
  try {
    created = createCategory(
      state,
      { name: draft.name, type: draft.type, group: draft.group },
      () => nextId(ids, makeId),
    );
  } catch (error) {
    if (error instanceof CategoryValidationError) fail(error.field, error.message);
    throw error;
  }

  const limit = draft.limit.trim();
  if (limit.length === 0) {
    return { state: validateResult(created.state), categoryId: created.category.id };
  }
  if (draft.type !== "expense") fail("limit", "Месячный лимит бывает только у расходной категории.");
  const budget = created.state.budgets.find((item) => item.id === created.state.activeBudgetId);
  if (!budget) fail("limit", "Активный бюджетный период не найден.");
  if (budget.lines.length >= OPERATIONS_LIMITS.linesPerBudget) {
    fail("limit", "Достигнут лимит бюджетных лимитов в периоде.");
  }
  if (totalBudgetLines(created.state) >= OPERATIONS_LIMITS.totalBudgetLines) {
    fail("limit", "Достигнут лимит бюджетных лимитов.");
  }
  const line: BudgetLine = {
    id: nextId(ids, makeId),
    categoryId: created.category.id,
    plannedMinor: parseLimitMoney(limit),
    active: true,
  };
  return {
    state: validateResult({
      ...created.state,
      budgets: created.state.budgets.map((item) =>
        item.id === budget.id ? { ...item, lines: [...item.lines, line] } : item,
      ),
    }),
    categoryId: created.category.id,
  };
}

/**
 * Возвращает категорию из архива вместо того, чтобы заводить её тёзку.
 *
 * Отказывает единственным способом, каким возврат может быть неправ: активная категория того же
 * вида уже носит это имя, и после возврата их стало бы две. Уже активная категория — не ошибка,
 * а гонка двух устройств, и состояние просто остаётся прежним.
 */
export function restoreCategory(state: BudgetState, id: string): BudgetState {
  validateState(state);
  assertIdentifier(id, "categoryId");
  const category = state.categories.find((item) => item.id === id);
  if (!category) fail("categoryId", "Категория не найдена.");
  if (category.active) return state;
  const key = categoryNameKey(category.name);
  const clash = state.categories.some(
    (item) => item.active && item.type === category.type && categoryNameKey(item.name) === key,
  );
  if (clash) fail("categoryId", "Активная категория с таким названием уже существует.");
  return validateResult({
    ...state,
    categories: state.categories.map((item) => item.id === id ? { ...item, active: true } : item),
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
  // Записи недоступны, пока документ семьи задержан или не пришёл: это не сбой, и человек должен
  // знать, почему и когда записи откроются.
  if (error instanceof BudgetWriteRefusal) return { field: "form", message: error.userMessage };
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
