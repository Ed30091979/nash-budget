import { baseCurrencyOf, isSupportedCurrency } from "./currency.js";
import { documentIds, isUuid } from "./identity.js";
import { COLLECTION_LIMITS, MAX_MONEY_MINOR, MAX_SORT_ORDER } from "./limits.js";
import {
  isDisplayKey,
  isReadableName,
  labelKey,
  normalizeLabel,
  TextValidationError,
  type TextErrorCode,
} from "./text.js";
import type { Account, AccountId, AccountType, BudgetState, CurrencyCode, DisplayKey, MinorUnits, Transaction } from "./types.js";

/**
 * Accounts: the places money is kept, and the transitions a family makes to them by hand.
 *
 * Two invariants are this module's to keep, and it keeps both by refusal.
 *
 * - **A currency does not change under the money counted in it.** Every amount of an operation, of
 *   a debt movement, of a goal and of a plan on the account is a count of the account's minor unit;
 *   the moment the currency changed, «1 250,00 ₽» would read as «1 250,00 $». So the currency of an
 *   account anything refers to is fixed, and only an account nothing names yet can change it.
 * - **Plans live in the base currency (D-032).** A goal, a large payment, a schedule and a recurring
 *   template name an account, and the annual plan adds their amounts up without a rate. An account
 *   linked to one of them never leaves the base currency — it is refused with words of its own
 *   rather than the general «in use», because the reason is a different one.
 *
 * Nothing here deletes an account: an account with history is archived, and an archived account stays
 * in every balance and every total it was part of. No figure of the budget moves when an account is
 * renamed, recoloured, reordered or archived; the opening balance moves the account's balances in the
 * past, which is why the interface warns before it is changed.
 */

export const ACCOUNT_NAME_MAX_LENGTH = 80;

/** The closed set of account kinds, in the order the interface offers them. */
export const ACCOUNT_TYPES: readonly AccountType[] = ["current", "cash", "savings", "reserve"] as const;

export type AccountErrorCode =
  | "name_required"
  | "name_too_long"
  | "name_forbidden_characters"
  | "name_mixed_scripts"
  | "name_unreadable"
  | "duplicate_name"
  | "unknown_type"
  | "unknown_currency"
  | "invalid_opening_balance"
  | "invalid_icon"
  | "invalid_color"
  | "invalid_include_in_total"
  | "limit_reached"
  | "id_required"
  | "duplicate_id"
  | "unknown_account"
  | "currency_in_use"
  | "base_currency_required"
  | "sort_order_overflow";

export type AccountField = "name" | "type" | "currency" | "openingBalanceMinor" | "icon" | "color" | "includeInTotal" | "sortOrder" | "id";

/** Refusal a person is meant to read: `code` for the caller, `message` for the screen. */
export class AccountValidationError extends Error {
  readonly code: AccountErrorCode;
  readonly field: AccountField;

  constructor(code: AccountErrorCode, field: AccountField, message: string) {
    super(message);
    this.name = "AccountValidationError";
    this.code = code;
    this.field = field;
  }
}

function fail(code: AccountErrorCode, field: AccountField, message: string): never {
  throw new AccountValidationError(code, field, message);
}

const NAME_REFUSALS: Readonly<Record<TextErrorCode, readonly [AccountErrorCode, string]>> = {
  required: ["name_required", "Укажите название счёта."],
  too_long: ["name_too_long", `Не более ${ACCOUNT_NAME_MAX_LENGTH} символов.`],
  forbidden_characters: ["name_forbidden_characters", "Уберите скрытые или служебные символы."],
  mixed_scripts: ["name_mixed_scripts", "Не смешивайте похожие символы разных алфавитов."],
};

/** Trims and normalises an account name the way it will be stored, or refuses it — the rule of a name. */
export function normalizeAccountName(value: string): string {
  let normalized: string;
  try {
    normalized = normalizeLabel(value, ACCOUNT_NAME_MAX_LENGTH);
  } catch (error) {
    if (!(error instanceof TextValidationError)) throw error;
    const [code, message] = NAME_REFUSALS[error.code];
    return fail(code, "name", message);
  }
  if (!isReadableName(normalized)) fail("name_unreadable", "name", "В названии счёта нужны буквы или цифры.");
  return normalized;
}

/** What names an account, and so fixes its currency. */
export type AccountReference = "operations" | "debts" | "goals" | "plans" | "recurring";

function transactionAccountIds(transaction: Transaction): readonly AccountId[] {
  switch (transaction.kind) {
    case "transfer":
    case "goal_contribution":
      return [transaction.fromAccountId, transaction.toAccountId];
    default:
      return [transaction.accountId];
  }
}

/**
 * Everything that names the account, by kind, in a fixed order. An account with no reference may
 * change its currency; any reference fixes it. Archived plans and stopped rules count: their amounts
 * are still counts of the account's minor unit, and restoring one must not find them reinterpreted.
 */
export function accountReferences(state: BudgetState, id: AccountId): readonly AccountReference[] {
  const found = new Set<AccountReference>();
  for (const transaction of state.transactions) {
    if (!transactionAccountIds(transaction).includes(id)) continue;
    found.add(transaction.kind === "debt_in" || transaction.kind === "debt_out" ? "debts" : "operations");
  }
  if (state.goals.some((goal) => goal.linkedAccountId === id)) found.add("goals");
  if (state.annualCommitments.some((item) => item.accountId === id) || state.scheduledExpenses.some((item) => item.accountId === id)) {
    found.add("plans");
  }
  for (const rule of state.recurringRules ?? []) {
    const template = rule.template;
    const ids = template.kind === "transfer" ? [template.fromAccountId, template.toAccountId] : [template.accountId];
    if (ids.includes(id)) found.add("recurring");
  }
  const order: readonly AccountReference[] = ["operations", "debts", "goals", "plans", "recurring"];
  return order.filter((kind) => found.has(kind));
}

/**
 * Whether the account may carry a goal or a plan: it is kept in the base currency (D-032). The
 * planning screens offer only such accounts, and the domain refuses the others.
 */
export function holdsPlans(state: Pick<BudgetState, "household">, account: Pick<Account, "currency">): boolean {
  return account.currency === baseCurrencyOf(state);
}

const REFERENCE_WORDS: Readonly<Record<AccountReference, string>> = {
  operations: "операции",
  debts: "движения по долгам",
  goals: "цель",
  plans: "плановые платежи",
  recurring: "регулярные операции",
};

/** «по счёту есть операции и цель» — what keeps the currency, in words. */
export function accountReferenceWords(references: readonly AccountReference[]): string {
  const words = references.map((reference) => REFERENCE_WORDS[reference]);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} и ${words[words.length - 1]}`;
}

function assertType(type: unknown): AccountType {
  if (typeof type !== "string" || !(ACCOUNT_TYPES as readonly string[]).includes(type)) {
    fail("unknown_type", "type", "Выберите вид счёта из списка.");
  }
  return type as AccountType;
}

function assertCurrency(currency: unknown): CurrencyCode {
  if (!isSupportedCurrency(currency)) fail("unknown_currency", "currency", "Выберите валюту из списка.");
  return currency;
}

function assertOpeningBalance(value: unknown): MinorUnits {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > MAX_MONEY_MINOR) {
    fail("invalid_opening_balance", "openingBalanceMinor", "Начальный остаток — сумма не больше ста миллионов по модулю.");
  }
  return value;
}

function assertDisplayKey(value: unknown, field: "icon" | "color"): DisplayKey {
  if (!isDisplayKey(value)) {
    fail(field === "icon" ? "invalid_icon" : "invalid_color", field, field === "icon" ? "Выберите иконку из списка." : "Выберите цвет из списка.");
  }
  return value;
}

function requireAccount(state: BudgetState, id: AccountId): Account {
  const account = state.accounts.find((item) => item.id === id);
  if (account === undefined) fail("unknown_account", "id", "Счёт не найден.");
  return account;
}

function assertUniqueActiveName(state: BudgetState, name: string, exceptId?: AccountId): void {
  const key = labelKey(name);
  if (state.accounts.some((item) => item.id !== exceptId && item.active && labelKey(item.name) === key)) {
    fail("duplicate_name", "name", "Активный счёт с таким названием уже есть.");
  }
}

/** The accounts in the order the interface lists them: by `sortOrder`, absent as 0, ties by position. */
export function accountsInOrder(accounts: readonly Account[]): readonly Account[] {
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((left, right) => (left.account.sortOrder ?? 0) - (right.account.sortOrder ?? 0) || left.index - right.index)
    .map(({ account }) => account);
}

/** Display fields as an entity stores them: a cleared key and «counts in the total» are absent fields. */
function withDisplay(account: Account, icon: DisplayKey | null | undefined, color: DisplayKey | null | undefined, includeInTotal: boolean | undefined): Account {
  const { icon: _icon, color: _color, includeInTotal: _include, ...rest } = account;
  const nextIcon = icon === undefined ? account.icon : icon ?? undefined;
  const nextColor = color === undefined ? account.color : color ?? undefined;
  const nextInclude = includeInTotal === undefined ? account.includeInTotal : includeInTotal ? undefined : false;
  return {
    ...rest,
    ...(nextIcon === undefined ? {} : { icon: nextIcon }),
    ...(nextColor === undefined ? {} : { color: nextColor }),
    ...(nextInclude === undefined ? {} : { includeInTotal: nextInclude }),
  };
}

export interface AccountDraft {
  readonly name: string;
  readonly type: AccountType;
  readonly currency: CurrencyCode;
  /** In the account's own currency; below zero is a card in debt. */
  readonly openingBalanceMinor: MinorUnits;
  readonly icon?: DisplayKey;
  readonly color?: DisplayKey;
  /** Absent or true — the account counts towards the total of everything the household holds. */
  readonly includeInTotal?: boolean;
}

export interface AccountCreation {
  readonly state: BudgetState;
  readonly account: Account;
}

/**
 * Creates an active account at the end of the list. Refuses a malformed or unreadable name, a name
 * an active account already carries (an archived namesake is not a duplicate — the interface offers
 * it back), an unknown kind or currency, an opening balance past the field ceiling, a display key
 * that is not one, and the account past `COLLECTION_LIMITS.accounts`, archived ones counted.
 *
 * The position is the last one plus ten. When that would leave the bound every gate shares
 * (`MAX_SORT_ORDER`), the list is numbered afresh, in its order, from ten — so a document someone
 * filled with huge positions still takes a new account, and no position leaves the bound.
 */
export function createAccount(
  state: BudgetState,
  draft: AccountDraft,
  makeId: () => AccountId = () => crypto.randomUUID(),
): AccountCreation {
  const name = normalizeAccountName(draft.name);
  assertUniqueActiveName(state, name);
  const type = assertType(draft.type);
  const currency = assertCurrency(draft.currency);
  const openingBalanceMinor = assertOpeningBalance(draft.openingBalanceMinor);
  const icon = draft.icon === undefined ? undefined : assertDisplayKey(draft.icon, "icon");
  const color = draft.color === undefined ? undefined : assertDisplayKey(draft.color, "color");
  if (draft.includeInTotal !== undefined && typeof draft.includeInTotal !== "boolean") {
    fail("invalid_include_in_total", "includeInTotal", "Отметьте, учитывать ли счёт в итоге.");
  }
  if (state.accounts.length >= COLLECTION_LIMITS.accounts) {
    fail("limit_reached", "name", `Счетов уже ${COLLECTION_LIMITS.accounts} — это предел. Уберите в архив те, что не нужны.`);
  }
  const id = makeId();
  if (!isUuid(id)) fail("id_required", "id", "Не удалось создать идентификатор счёта.");
  // Identifiers are unique across the whole document, not only among accounts.
  if (documentIds(state).includes(id)) fail("duplicate_id", "id", "Не удалось создать уникальный идентификатор счёта.");

  let accounts = state.accounts;
  const highest = accounts.reduce((max, item) => Math.max(max, item.sortOrder ?? 0), 0);
  let sortOrder = highest + 10;
  if (sortOrder > MAX_SORT_ORDER) {
    const renumbered = new Map(accountsInOrder(accounts).map((item, index) => [item.id, (index + 1) * 10]));
    accounts = accounts.map((item) => ({ ...item, sortOrder: renumbered.get(item.id) ?? 0 }));
    sortOrder = (accounts.length + 1) * 10;
  }
  const account: Account = withDisplay(
    { id, name, type, currency, openingBalanceMinor, active: true, sortOrder },
    icon ?? null,
    color ?? null,
    draft.includeInTotal,
  );
  return { state: { ...state, accounts: [...accounts, account] }, account };
}

/** A change to an account; a field left out stays as it is. `null` clears a display key. */
export interface AccountPatch {
  readonly name?: string;
  readonly type?: AccountType;
  readonly currency?: CurrencyCode;
  readonly openingBalanceMinor?: MinorUnits;
  readonly icon?: DisplayKey | null;
  readonly color?: DisplayKey | null;
  readonly includeInTotal?: boolean;
}

function replaceAccount(state: BudgetState, next: Account): BudgetState {
  return { ...state, accounts: state.accounts.map((item) => (item.id === next.id ? next : item)) };
}

function sameAccount(left: Account, right: Account): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof Account>;
  return [...keys].every((key) => left[key] === right[key]);
}

/**
 * Changes an account. The name follows the rule of {@link createAccount} — a duplicate counts only
 * while the account is active, because an archived account is out of every list it would be confused
 * in. The currency changes only while nothing names the account ({@link accountReferences}); an
 * account a goal or a plan is linked to is refused with D-032's own words. An opening balance moves
 * every balance of the account in the past: the interface says so before it is saved.
 *
 * A patch that changes nothing returns the very same state, so the journal sees no update.
 */
export function updateAccount(state: BudgetState, id: AccountId, patch: AccountPatch): BudgetState {
  const current = requireAccount(state, id);
  const name = patch.name === undefined ? current.name : normalizeAccountName(patch.name);
  if (current.active && name !== current.name) assertUniqueActiveName(state, name, id);
  const type = patch.type === undefined ? current.type : assertType(patch.type);
  const currency = patch.currency === undefined ? current.currency : assertCurrency(patch.currency);
  if (currency !== current.currency) {
    const references = accountReferences(state, id);
    if (references.includes("goals") || references.includes("plans")) {
      fail(
        "base_currency_required",
        "currency",
        `Счёт привязан к плану: по нему есть ${accountReferenceWords(references)}. Цели и планы ведутся только в базовой валюте ${baseCurrencyOf(state)}.`,
      );
    }
    if (references.length > 0) {
      fail("currency_in_use", "currency", `Валюту не сменить: по счёту есть ${accountReferenceWords(references)}. Суммы записаны в ${current.currency}.`);
    }
  }
  const openingBalanceMinor = patch.openingBalanceMinor === undefined ? current.openingBalanceMinor : assertOpeningBalance(patch.openingBalanceMinor);
  const icon = patch.icon === undefined || patch.icon === null ? patch.icon : assertDisplayKey(patch.icon, "icon");
  const color = patch.color === undefined || patch.color === null ? patch.color : assertDisplayKey(patch.color, "color");
  if (patch.includeInTotal !== undefined && typeof patch.includeInTotal !== "boolean") {
    fail("invalid_include_in_total", "includeInTotal", "Отметьте, учитывать ли счёт в итоге.");
  }
  const next = withDisplay({ ...current, name, type, currency, openingBalanceMinor }, icon, color, patch.includeInTotal);
  return sameAccount(current, next) ? state : replaceAccount(state, next);
}

/**
 * Archives an account: it leaves the lists new operations are written from and stays in every
 * balance and total, with all its history. Archiving an archived account changes nothing.
 */
export function archiveAccount(state: BudgetState, id: AccountId): BudgetState {
  const account = requireAccount(state, id);
  if (!account.active) return state;
  return replaceAccount(state, { ...account, active: false });
}

/**
 * Brings an account back from the archive. Refuses the one way it can be wrong — an active account
 * already carries its name, and the two would be confused in every list. An active account is not an
 * error but a race of two devices: the state stays as it was.
 */
export function restoreAccount(state: BudgetState, id: AccountId): BudgetState {
  const account = requireAccount(state, id);
  if (account.active) return state;
  assertUniqueActiveName(state, account.name, id);
  return replaceAccount(state, { ...account, active: true });
}

export type MoveDirection = "up" | "down";

/**
 * Moves an active account one place up or down among the active ones. Two positions swap, and only
 * the two accounts change: every update is a whole entity in the journal, and renumbering the whole
 * list on every move would overwrite a concurrent edit of any account on another device. Positions
 * that tie — accounts written before positions existed all sit at nought — are first spread apart in
 * their current order, once. At either end the state stays as it is.
 */
export function moveAccount(state: BudgetState, id: AccountId, direction: MoveDirection): BudgetState {
  const account = requireAccount(state, id);
  if (!account.active) return state;
  const active = accountsInOrder(state.accounts.filter((item) => item.active));
  const at = active.findIndex((item) => item.id === id);
  const neighbour = active[direction === "up" ? at - 1 : at + 1];
  if (neighbour === undefined) return state;

  const positions = new Map(active.map((item) => [item.id, item.sortOrder ?? 0]));
  if (new Set(positions.values()).size !== positions.size) {
    let previous = Number.NEGATIVE_INFINITY;
    for (const item of active) {
      const next = Math.max(item.sortOrder ?? 0, previous + 1);
      if (next > MAX_SORT_ORDER) fail("sort_order_overflow", "sortOrder", "Порядок счетов слишком велик.");
      positions.set(item.id, next);
      previous = next;
    }
  }
  const mine = positions.get(account.id) ?? 0;
  positions.set(account.id, positions.get(neighbour.id) ?? 0);
  positions.set(neighbour.id, mine);
  return {
    ...state,
    accounts: state.accounts.map((item) => {
      const sortOrder = positions.get(item.id);
      return sortOrder === undefined || sortOrder === item.sortOrder ? item : { ...item, sortOrder };
    }),
  };
}
