import {
  addDays,
  baseCurrencyOf,
  baseSnapshot,
  calculateBudget,
  calculateHoldings,
  createTag,
  currencyExponent,
  findBudgetForMonth,
  findRate,
  findTagByName,
  indexRates,
  isSupportedCurrency,
  MAX_TAGS_PER_TRANSACTION,
  monthOfDate,
  normalizeTagName,
  TagValidationError,
  type BudgetState,
  type CurrencyCode,
  type ExchangeRate,
  type Transaction,
} from "@family-budget/domain";
import { formatDay } from "../../date-words";
import { formatMoney } from "../../money";
import { amountText, evaluateAmount, settleAmount } from "../operations/amount-expression";
import {
  createTransaction,
  DEBT_EDIT_REFUSAL,
  editTransaction,
  OperationsValidationError,
  type TransactionDraft,
} from "../operations/model";
import { kindLabels } from "../operations/transaction-words";
import { defaultAccountOf } from "../overview/overview-model";
import type { SheetRequest } from "../overview/pick-model";

/**
 * Лист ввода суммы — данные и решения без разметки (план волны 2, §1.2).
 *
 * Черновик плоский: вид, «откуда» и «куда», сумма выражением, дата, комментарий, метки. Вид меняется
 * на месте, и сумма, дата, комментарий и метки при этом остаются. Отсюда — запись одним изменением
 * состояния (новые метки создаются в той же транзакции), слова «откуда → куда», строка «останется» и
 * оценка операции в другой валюте.
 */

/** Что записывает лист в 2b. Взнос в цель и долги — 2e: их лист отвергает словами. */
export const ENTRY_MODES = ["expense", "income", "transfer", "refund"] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];

export interface EntryDraft {
  readonly mode: EntryMode;
  /** Операция, которую правят; `null` — новая. */
  readonly editId: string | null;
  /** Счёт, с которого уходят деньги (расход, перевод) или на который приходят (доход, возврат). */
  readonly accountId: string;
  /** Категория расхода. */
  readonly categoryId: string;
  /** Категория дохода; пустая строка — «Без категории» (D-026). */
  readonly incomeCategoryId: string;
  /** Счёт назначения перевода. */
  readonly toAccountId: string;
  /** Расход, который возвращают. */
  readonly originalTransactionId: string;
  /** Сумма — выражение клавиатуры, в валюте счёта операции. */
  readonly amount: string;
  /** Сумма в базовой валюте вручную; пусто — по курсу дня (D-031). */
  readonly baseAmount: string;
  /** Сколько пришло — перевод между валютами. */
  readonly toAmount: string;
  readonly occurredOn: string;
  readonly note: string;
  readonly tagIds: readonly string[];
  /** Названия меток, набранные «+ метка»: создаются той же записью. */
  readonly newTags: readonly string[];
}

const EMPTY: Omit<EntryDraft, "mode" | "occurredOn"> = {
  editId: null,
  accountId: "",
  categoryId: "",
  incomeCategoryId: "",
  toAccountId: "",
  originalTransactionId: "",
  amount: "",
  baseAmount: "",
  toAmount: "",
  note: "",
  tagIds: [],
  newTags: [],
};

function activeAccount(state: BudgetState, id: string | null | undefined): string {
  return state.accounts.find((account) => account.id === id && account.active)?.id ?? "";
}

/** Первый активный счёт, кроме `except`: второй конец перевода по умолчанию. */
function otherAccount(state: BudgetState, except: string): string {
  return state.accounts.find((account) => account.active && account.id !== except)?.id ?? "";
}

/** Черновик по касанию плиток «Обзора»: вид и обе плитки уже названы. */
export function newEntryDraft(state: BudgetState, request: SheetRequest, today: string): EntryDraft {
  const main = defaultAccountOf(state)?.id ?? "";
  const common = { ...EMPTY, occurredOn: today };
  switch (request.kind) {
    case "expense": return { ...common, mode: "expense", accountId: activeAccount(state, request.accountId) || main, categoryId: request.categoryId };
    case "income": return { ...common, mode: "income", accountId: activeAccount(state, request.accountId) || main, incomeCategoryId: request.categoryId ?? "" };
    case "transfer": return { ...common, mode: "transfer", accountId: request.fromAccountId, toAccountId: request.toAccountId };
  }
}

/** Черновик «+»: вид, основной счёт и ничего больше — «куда» выбирают в листе. */
export function blankEntryDraft(state: BudgetState, mode: Exclude<EntryMode, "refund">, today: string): EntryDraft {
  const main = defaultAccountOf(state)?.id ?? "";
  return { ...EMPTY, occurredOn: today, mode, accountId: main, toAccountId: mode === "transfer" ? otherAccount(state, main) : "" };
}

/** Сумма в поле: «1250» или «40,50» — как её набирают, без отбивки разрядов. */
function amountOf(minor: number, currency: CurrencyCode): string {
  return amountText(minor, exponentOf(currency));
}

/** Почему лист не правит операцию: долг и взнос в цель — подволна 2e. */
export const GOAL_EDIT_REFUSAL = "Взнос в цель этот лист пока не изменяет.";

export type EditOpening =
  | { readonly kind: "draft"; readonly draft: EntryDraft }
  | { readonly kind: "refused"; readonly message: string; readonly transaction: Transaction };

/** Черновик правки по операции — или отказ словами, если лист её целиком не покажет. */
export function draftFromTransaction(state: BudgetState, transaction: Transaction): EditOpening {
  const currencyOf = (id: string) => state.accounts.find((account) => account.id === id)?.currency ?? baseCurrencyOf(state);
  const common = {
    ...EMPTY,
    editId: transaction.id,
    occurredOn: transaction.occurredOn,
    note: transaction.note ?? "",
    tagIds: [...(transaction.tagIds ?? [])],
  };
  // Сумму в базовой валюте, набранную вручную, лист показывает как набранную: курс «сумма за сумму».
  const manualBase = (value: { readonly amountMinor: number; readonly baseAmountMinor?: number; readonly rate?: { readonly baseMinor: number; readonly quoteMinor: number } }) =>
    value.rate !== undefined && value.baseAmountMinor !== undefined && value.rate.quoteMinor === value.amountMinor && value.rate.baseMinor === value.baseAmountMinor
      ? amountOf(value.baseAmountMinor, baseCurrencyOf(state))
      : "";
  switch (transaction.kind) {
    case "expense":
      return { kind: "draft", draft: { ...common, mode: "expense", accountId: transaction.accountId, categoryId: transaction.categoryId, amount: amountOf(transaction.amountMinor, currencyOf(transaction.accountId)), baseAmount: manualBase(transaction) } };
    case "income":
      return { kind: "draft", draft: { ...common, mode: "income", accountId: transaction.accountId, incomeCategoryId: transaction.categoryId ?? "", amount: amountOf(transaction.amountMinor, currencyOf(transaction.accountId)), baseAmount: manualBase(transaction) } };
    case "refund":
      return { kind: "draft", draft: { ...common, mode: "refund", accountId: transaction.accountId, originalTransactionId: transaction.originalTransactionId, amount: amountOf(transaction.amountMinor, currencyOf(transaction.accountId)), baseAmount: manualBase(transaction) } };
    case "transfer":
      return {
        kind: "draft",
        draft: {
          ...common,
          mode: "transfer",
          accountId: transaction.fromAccountId,
          toAccountId: transaction.toAccountId,
          amount: amountOf(transaction.amountMinor, currencyOf(transaction.fromAccountId)),
          toAmount: transaction.toAmountMinor === undefined ? "" : amountOf(transaction.toAmountMinor, currencyOf(transaction.toAccountId)),
        },
      };
    case "goal_contribution":
      return { kind: "refused", message: GOAL_EDIT_REFUSAL, transaction };
    case "debt_out":
    case "debt_in":
      return { kind: "refused", message: DEBT_EDIT_REFUSAL, transaction };
  }
}

/**
 * «Оформить возврат» из правки расхода: новый возврат на тот же счёт и с той же суммой — полную
 * сумму меняют, частичную набирают. Дата — сегодня, но не раньше самого расхода.
 */
export function refundDraftFor(expense: Extract<Transaction, { readonly kind: "expense" }>, state: BudgetState, today: string): EntryDraft {
  const currency = state.accounts.find((account) => account.id === expense.accountId)?.currency ?? baseCurrencyOf(state);
  return {
    ...EMPTY,
    mode: "refund",
    accountId: activeAccount(state, expense.accountId) || (defaultAccountOf(state)?.id ?? ""),
    originalTransactionId: expense.id,
    amount: amountOf(expense.amountMinor, currency),
    occurredOn: today < expense.occurredOn ? expense.occurredOn : today,
  };
}

/** Смена вида на месте: сумма, дата, комментарий и метки остаются, «откуда» и «куда» — по смыслу вида. */
export function switchMode(state: BudgetState, draft: EntryDraft, mode: Exclude<EntryMode, "refund">): EntryDraft {
  if (draft.mode === mode) return draft;
  const account = draft.accountId || (defaultAccountOf(state)?.id ?? "");
  return {
    ...draft,
    mode,
    accountId: account,
    toAccountId: mode === "transfer" ? (draft.toAccountId && draft.toAccountId !== account ? draft.toAccountId : otherAccount(state, account)) : "",
    baseAmount: "",
    toAmount: "",
  };
}

function exponentOf(currency: CurrencyCode): number {
  return isSupportedCurrency(currency) ? currencyExponent(currency) : 2;
}

/** Валюта суммы черновика: счёта, с которого уходят деньги, или на который приходят. */
export function draftCurrency(state: BudgetState, draft: EntryDraft): CurrencyCode {
  return state.accounts.find((account) => account.id === draft.accountId)?.currency ?? baseCurrencyOf(state);
}

export function draftExponent(state: BudgetState, draft: EntryDraft): number {
  return exponentOf(draftCurrency(state, draft));
}

/** Валюта счёта назначения перевода — для поля «Зачислено». */
export function toAccountCurrency(state: BudgetState, draft: EntryDraft): CurrencyCode | null {
  return state.accounts.find((account) => account.id === draft.toAccountId)?.currency ?? null;
}

/** Нужна ли сумма зачисления: перевод между счетами в разных валютах. */
export function needsArrivedAmount(state: BudgetState, draft: EntryDraft): boolean {
  if (draft.mode !== "transfer") return false;
  const to = toAccountCurrency(state, draft);
  return to !== null && to !== draftCurrency(state, draft);
}

/** Итог суммы черновика в минимальных единицах, или `null`, пока набранное не число. */
export function draftAmountMinor(state: BudgetState, draft: EntryDraft): number | null {
  const value = evaluateAmount(draft.amount, draftExponent(state, draft));
  return value.kind === "value" ? value.minor : null;
}

/** Черновик модели операций — то, что запишет домен. Выражение свёрнуто в число. */
export function toTransactionDraft(state: BudgetState, draft: EntryDraft, newTagIds: readonly string[] = []): TransactionDraft {
  const common = {
    status: "posted" as const,
    occurredOn: draft.occurredOn,
    amount: settleAmount(draft.amount, draftExponent(state, draft)),
    note: draft.note,
    tagIds: [...draft.tagIds, ...newTagIds],
  };
  switch (draft.mode) {
    case "expense": return { ...common, kind: "expense", accountId: draft.accountId, categoryId: draft.categoryId, baseAmount: draft.baseAmount };
    case "income": return { ...common, kind: "income", accountId: draft.accountId, categoryId: draft.incomeCategoryId, baseAmount: draft.baseAmount };
    case "refund": return { ...common, kind: "refund", accountId: draft.accountId, originalTransactionId: draft.originalTransactionId, baseAmount: draft.baseAmount };
    case "transfer": return { ...common, kind: "transfer", fromAccountId: draft.accountId, toAccountId: draft.toAccountId, toAmount: draft.toAmount };
  }
}

export interface EntryWrite {
  readonly state: BudgetState;
  /** Идентификатор записанной или исправленной операции. */
  readonly transactionId: string;
}

/**
 * Запись черновика одним изменением состояния: сначала метки, набранные «+ метка» (или уже
 * существующие с тем же именем — тогда берётся она, а не тёзка), потом операция. Отказ домена —
 * исключение с полем и словами (`OperationsValidationError`), и состояние тогда не меняется вовсе.
 */
export function writeEntry(state: BudgetState, draft: EntryDraft, makeId: () => string = () => crypto.randomUUID()): EntryWrite {
  let next = state;
  const added: string[] = [];
  for (const name of draft.newTags) {
    let normalized: string;
    try {
      normalized = normalizeTagName(name);
    } catch (error) {
      if (error instanceof TagValidationError) throw new OperationsValidationError("tagIds", error.message);
      throw error;
    }
    const existing = findTagByName(next, normalized);
    if (existing !== undefined && existing.active) {
      if (!draft.tagIds.includes(existing.id) && !added.includes(existing.id)) added.push(existing.id);
      continue;
    }
    try {
      const created = createTag(next, normalized, makeId);
      next = created.state;
      added.push(created.tag.id);
    } catch (error) {
      if (error instanceof TagValidationError) throw new OperationsValidationError("tagIds", error.message);
      throw error;
    }
  }
  const operation = toTransactionDraft(next, draft, added);
  if (draft.editId !== null) {
    return { state: editTransaction(next, draft.editId, operation), transactionId: draft.editId };
  }
  let createdId = "";
  const written = createTransaction(next, operation, () => {
    createdId = makeId();
    return createdId;
  });
  return { state: written, transactionId: createdId };
}

/** Можно ли нажать «Записать»: сумма — число, и выбраны «откуда» и «куда». */
export function draftReady(state: BudgetState, draft: EntryDraft): boolean {
  if (draftAmountMinor(state, draft) === null || draft.accountId === "") return false;
  switch (draft.mode) {
    case "expense": return draft.categoryId !== "";
    case "income": return true;
    case "refund": return draft.originalTransactionId !== "";
    case "transfer": return draft.toAccountId !== "" && draft.toAccountId !== draft.accountId;
  }
}

/** «Сегодня», «Вчера» или другой день — по местному календарю семьи. */
export type DateChoice = "today" | "yesterday" | "other";

export function yesterdayOf(today: string): string {
  return addDays(today, -1);
}

export function dateChoice(occurredOn: string, today: string): DateChoice {
  if (occurredOn === today) return "today";
  if (occurredOn === yesterdayOf(today)) return "yesterday";
  return "other";
}

/** Частые активные метки: по числу операций с ними, затем по порядку списка. */
export function frequentTags(state: BudgetState, limit = 6): readonly { readonly id: string; readonly name: string }[] {
  const uses = new Map<string, number>();
  for (const transaction of state.transactions) {
    for (const id of transaction.tagIds ?? []) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  return (state.tags ?? [])
    .map((tag, index) => ({ tag, index }))
    .filter(({ tag }) => tag.active)
    .sort((left, right) => (uses.get(right.tag.id) ?? 0) - (uses.get(left.tag.id) ?? 0) || left.index - right.index)
    .slice(0, limit)
    .map(({ tag }) => ({ id: tag.id, name: tag.name }));
}

/** Сколько меток ещё можно добавить к черновику. */
export function tagRoom(draft: EntryDraft): number {
  return MAX_TAGS_PER_TRANSACTION - draft.tagIds.length - draft.newTags.length;
}

/** Слова вида листа — эйбрау и доступное имя. */
export const MODE_LABELS: Readonly<Record<EntryMode, string>> = {
  expense: kindLabels.expense,
  income: kindLabels.income,
  transfer: kindLabels.transfer,
  refund: kindLabels.refund,
};

/** Имена «откуда» и «куда» — для плиток листа и доступного имени. */
export function endpoints(state: BudgetState, draft: EntryDraft): { readonly from: string; readonly to: string } {
  const account = (id: string) => state.accounts.find((item) => item.id === id)?.name ?? "счёт не выбран";
  const category = (id: string) => state.categories.find((item) => item.id === id)?.name ?? "категория не выбрана";
  switch (draft.mode) {
    case "expense": return { from: account(draft.accountId), to: category(draft.categoryId) };
    case "income": return { from: draft.incomeCategoryId === "" ? "Без категории" : category(draft.incomeCategoryId), to: account(draft.accountId) };
    case "transfer": return { from: account(draft.accountId), to: account(draft.toAccountId) };
    case "refund": {
      const original = state.transactions.find((item) => item.id === draft.originalTransactionId);
      return { from: original?.kind === "expense" ? category(original.categoryId) : "расход не найден", to: account(draft.accountId) };
    }
  }
}

/** Доступное имя листа: «Расход: Карта → Продукты». */
export function sheetTitle(state: BudgetState, draft: EntryDraft): string {
  const { from, to } = endpoints(state, draft);
  const verb = draft.editId === null ? MODE_LABELS[draft.mode] : `Изменить: ${MODE_LABELS[draft.mode].toLowerCase()}`;
  return `${verb}: ${from} → ${to}`;
}

/** Кнопка записи называет действие и сумму: «Записать 1 250 ₽», при правке — «Сохранить». */
export function submitLabel(state: BudgetState, draft: EntryDraft): string {
  if (draft.editId !== null) return "Сохранить";
  const minor = draftAmountMinor(state, draft);
  return minor === null ? "Записать" : `Записать ${formatMoney(minor, draftCurrency(state, draft))}`;
}

/**
 * Что станет от этой записи — одной строкой под суммой. Расход в категорию с лимитом месяца —
 * «В категории «Продукты» останется 13 250 ₽ из 30 000 ₽» (имя не склоняется, рамочное слово рядом);
 * без лимита и у остальных видов — остаток счёта в его валюте. Правка уже учтена в остатках, и
 * строка тогда не вычитает сумму второй раз. `null` — сказать нечего.
 */
export function effectLine(state: BudgetState, draft: EntryDraft, today: string): string | null {
  if (draft.editId !== null) return null;
  try {
    return effectWords(state, draft, today);
  } catch {
    // Дата, которую ещё набирают, или счёт, которого уже нет: строке сказать нечего, но лист стоит.
    return null;
  }
}

function effectWords(state: BudgetState, draft: EntryDraft, today: string): string | null {
  const minor = draftAmountMinor(state, draft) ?? 0;
  const account = state.accounts.find((item) => item.id === draft.accountId);
  if (draft.mode === "expense" && draft.categoryId !== "") {
    const category = state.categories.find((item) => item.id === draft.categoryId);
    const budget = findBudgetForMonth(state, monthOfDate(draft.occurredOn));
    const line = budget?.lines.find((item) => item.categoryId === draft.categoryId && item.active !== false);
    const value = valueInBase(state, draft, minor);
    if (category !== undefined && budget !== undefined && line !== undefined && value !== null) {
      const metric = calculateBudget(state, budget.id).categoryMetrics[category.id];
      if (metric !== undefined) {
        const left = metric.remainingMinor - value;
        const base = baseCurrencyOf(state);
        return left >= 0
          ? `В категории «${category.name}» останется ${formatMoney(left, base)} из ${formatMoney(metric.availableMinor, base)}`
          : `В категории «${category.name}» будет перелимит ${formatMoney(-left, base)} при лимите ${formatMoney(metric.availableMinor, base)}`;
      }
    }
  }
  if (account === undefined) return null;
  // Остаток — накопленный с открытия счёта, в его валюте, на сегодня (или на день операции позже).
  const balance = calculateHoldings(state, draft.occurredOn > today ? draft.occurredOn : today).accountBalancesMinor[account.id];
  if (balance === undefined || balance === null) return null;
  const incoming = draft.mode === "income" || draft.mode === "refund";
  const after = incoming ? balance + minor : balance - minor;
  return incoming
    ? `На счёте «${account.name}» станет ${formatMoney(after, account.currency)}`
    : `На счёте «${account.name}» останется ${formatMoney(after, account.currency)}`;
}

/** Оценка операции в другой валюте: по курсу дня, вручную или «курса нет». */
export type ForeignValue =
  | { readonly kind: "base" }
  | { readonly kind: "rate"; readonly baseMinor: number; readonly rate: ExchangeRate; readonly baseCurrency: CurrencyCode; readonly currency: CurrencyCode }
  | { readonly kind: "manual"; readonly baseMinor: number; readonly baseCurrency: CurrencyCode }
  | { readonly kind: "missing"; readonly currency: CurrencyCode; readonly baseCurrency: CurrencyCode; readonly date: string };

/** Перевод валюту не оценивает: его сумма в базу не идёт. Доход, расход и возврат — оценивают. */
export function foreignValue(state: BudgetState, draft: EntryDraft): ForeignValue {
  const currency = draftCurrency(state, draft);
  const baseCurrency = baseCurrencyOf(state);
  if (draft.mode === "transfer" || currency === baseCurrency) return { kind: "base" };
  const typed = evaluateAmount(draft.baseAmount, exponentOf(baseCurrency));
  if (typed.kind === "value") return { kind: "manual", baseMinor: typed.minor, baseCurrency };
  const rates = state.exchangeRates ?? [];
  const rate = findRate(rates, currency, baseCurrency, draft.occurredOn);
  const minor = draftAmountMinor(state, draft) ?? 0;
  if (rate === undefined) return { kind: "missing", currency, baseCurrency, date: draft.occurredOn };
  const snapshot = minor > 0 ? baseSnapshot(minor, currency, baseCurrency, indexRates(rates), draft.occurredOn) : null;
  return { kind: "rate", baseMinor: snapshot?.baseAmountMinor ?? 0, rate, baseCurrency, currency };
}

/** Сумма черновика в базовой валюте — для строки «останется»; `null`, пока оценить нечем. */
function valueInBase(state: BudgetState, draft: EntryDraft, minor: number): number | null {
  const value = foreignValue(state, draft);
  switch (value.kind) {
    case "base": return minor;
    case "manual":
    case "rate": return value.baseMinor;
    case "missing": return null;
  }
}

/** Курс словами: «92,50» за единицу валюты; для слабых — за сотню. */
export function rateWords(rate: ExchangeRate): string {
  const quoteExponent = exponentOf(rate.currency);
  const baseExponent = exponentOf(rate.baseCurrency);
  // Сколько базовых единиц за одну единицу валюты: baseMinor / 10^baseExp за quoteMinor / 10^quoteExp.
  const perUnit = (rate.rate.baseMinor / 10 ** baseExponent) / (rate.rate.quoteMinor / 10 ** quoteExponent);
  const per = perUnit < 1 ? 100 : 1;
  const value = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(perUnit * per);
  return per === 1 ? value : `${value} за ${per}`;
}

/** «≈ 1 157 ₽ по курсу 92,50 от 15 октября». */
export function foreignValueLine(value: ForeignValue): string | null {
  switch (value.kind) {
    case "base": return null;
    case "manual": return `В ${value.baseCurrency}: ${formatMoney(value.baseMinor, value.baseCurrency)} — сумма вписана вручную`;
    case "rate": return `≈ ${formatMoney(value.baseMinor, value.baseCurrency)} по курсу ${rateWords(value.rate)} от ${formatDay(value.rate.date)}`;
    case "missing": return null;
  }
}

/** Черновик, отличный от снимка при открытии, — несохранённый (§2.4): сравнение по содержимому. */
export function draftDiffers(draft: EntryDraft, pristine: EntryDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(pristine);
}
