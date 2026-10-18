import type {
  Account,
  AccountId,
  AnnualCommitment,
  AnnualCommitmentId,
  AnnualCommitmentMetrics,
  AnnualPlanMetrics,
  Budget,
  BudgetMetrics,
  BudgetState,
  Category,
  CategoryBudgetStatus,
  CategoryId,
  CategoryMetrics,
  CurrencyCode,
  Debt,
  ExchangeRate,
  ExpenseShareMetrics,
  FormatMinorOptions,
  Goal,
  GoalId,
  Household,
  Member,
  MemberExpenseBreakdown,
  MemberExpenseMetrics,
  MemberId,
  MinorUnits,
  PlanningMonthMetrics,
  RecurringRule,
  ScheduledExpense,
  StableId,
  Tag,
  TagId,
  Transaction,
} from "./types.js";
import {
  daysInMonth,
  isWithinDateWindow,
  MAX_LOCAL_DATE,
  MAX_LOCAL_MONTH_INDEX,
  MIN_LOCAL_DATE,
  monthFromIndex,
  monthIndex,
} from "./calendar.js";
import {
  baseAmountOf,
  baseCurrencyOf,
  isExchangeRateValue,
  isSupportedCurrency,
  RATE_PART_MAX,
  RATE_PART_MIN,
} from "./currency.js";
import { HOUSEHOLD_ID } from "./identity.js";
import { MAX_MONEY_MINOR, MAX_RECURRENCE_INTERVAL, MAX_SORT_ORDER } from "./limits.js";
import { isStorableLabel, isStorableNote } from "./stored-text.js";
import {
  COUNTERPARTY_MAX_LENGTH,
  isDisplayKey,
  MAX_TAGS_PER_TRANSACTION,
  NOTE_MAX_LENGTH,
  RULE_NAME_MAX_LENGTH,
  TAG_NAME_MAX_LENGTH,
} from "./text.js";

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertEnum(value: unknown, allowed: readonly string[], label: string): asserts value is string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} has unknown value ${String(value)}`);
  }
}

function assertStableId(id: StableId, label: string): void {
  if (id.trim().length === 0) {
    throw new Error(`${label} must have a non-empty stable id`);
  }
}

function assertMinor(value: MinorUnits, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer minor-unit amount`);
  }
}

function assertNonNegativeMinor(value: MinorUnits, label: string): void {
  assertMinor(value, label);
  if (value < 0) {
    throw new Error(`${label} must not be negative`);
  }
}

function assertPositiveMinor(value: MinorUnits, label: string): void {
  assertMinor(value, label);
  if (value <= 0) {
    throw new Error(`${label} must be greater than zero`);
  }
}

function addMinor(left: MinorUnits, right: MinorUnits, label: string): MinorUnits {
  const value = left + right;
  assertMinor(value, label);
  return value;
}

function reservePerMonth(amountMinor: MinorUnits, months: number): MinorUnits {
  const value = Math.ceil(amountMinor / (months * 100)) * 100;
  assertMinor(value, "monthly reserve");
  return value;
}

function assertLocalDate(value: string, label: string): void {
  if (!LOCAL_DATE_PATTERN.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a valid calendar date`);
  }
}

/**
 * A date of a field added to the model since the journal existed: a calendar date, and inside the
 * window the codec carries. Older fields are checked by {@link assertLocalDate} alone, because a
 * document written by 1.0.0 may hold a date outside the window and must keep opening.
 */
function assertWindowDate(value: string, label: string): void {
  assertLocalDate(value, label);
  if (!isWithinDateWindow(value)) throw new Error(`${label} must be from ${MIN_LOCAL_DATE} to ${MAX_LOCAL_DATE}`);
}

/** An amount of a field added since the journal existed: positive, and at most a field's ceiling. */
function assertFieldMinor(value: MinorUnits, label: string): void {
  assertPositiveMinor(value, label);
  if (value > MAX_MONEY_MINOR) throw new Error(`${label} must be at most ${MAX_MONEY_MINOR}`);
}

function indexById<T extends { readonly id: StableId }>(
  entities: readonly T[],
  label: string,
): Map<StableId, T> {
  const result = new Map<StableId, T>();

  for (const entity of entities) {
    assertStableId(entity.id, label);
    if (result.has(entity.id)) {
      throw new Error(`${label} contains duplicate id ${entity.id}`);
    }
    result.set(entity.id, entity);
  }

  return result;
}

/**
 * The collections of a state indexed by identifier, each checked for a repeated id on the way.
 *
 * Every calculation used to build these maps itself, three times over, and three copies of one
 * index are three places a new collection can be forgotten in. Indexing happens here, in the order
 * the copies indexed: what each calculation then validates is its own business, so that the set of
 * errors each one raises stays exactly what it was — participants are still checked only by the
 * split by participant, and large payments and schedules only by the annual plan.
 *
 * Tags are the one collection validated here as well. Every calculation resolves the tags of every
 * transaction it reads, so every calculation needs them whole, and no state written before tags
 * existed carries one: checking them in all three adds no refusal to any state that was valid. The
 * household and the exchange rates are validated here for the same reason — every calculation
 * reads the base currency, to know which operations must carry a snapshot — and no older state
 * carries either.
 */
export interface StateIndex {
  readonly accounts: ReadonlyMap<StableId, Account>;
  readonly categories: ReadonlyMap<StableId, Category>;
  readonly budgets: ReadonlyMap<StableId, Budget>;
  readonly goals: ReadonlyMap<StableId, Goal>;
  readonly transactions: ReadonlyMap<StableId, Transaction>;
  readonly tags: ReadonlyMap<TagId, Tag>;
  readonly exchangeRates: ReadonlyMap<StableId, ExchangeRate>;
  readonly debts: ReadonlyMap<StableId, Debt>;
  readonly recurringRules: ReadonlyMap<StableId, RecurringRule>;
  /** The currency every budget figure is counted in: the household's, or roubles. */
  readonly baseCurrency: CurrencyCode;
}

export function indexState(state: BudgetState): StateIndex {
  // Object literals evaluate in source order, so a duplicate is reported for the same collection
  // the inlined copies reported it for; the collections no older state has come last.
  const index: StateIndex = {
    accounts: indexById(state.accounts, "accounts"),
    categories: indexById(state.categories, "categories"),
    budgets: indexById(state.budgets, "budgets"),
    goals: indexById(state.goals, "goals"),
    transactions: indexById(state.transactions, "transactions"),
    tags: indexById(state.tags ?? [], "tags"),
    exchangeRates: indexById(state.exchangeRates ?? [], "exchangeRates"),
    debts: indexById(state.debts ?? [], "debts"),
    recurringRules: indexById(state.recurringRules ?? [], "recurringRules"),
    baseCurrency: baseCurrencyOf(state),
  };
  for (const tag of index.tags.values()) validateTag(tag);
  if (state.household !== undefined) validateHousehold(state.household);
  for (const rate of index.exchangeRates.values()) validateExchangeRate(rate);
  for (const debt of index.debts.values()) validateDebt(debt);
  // Last: a rule's template names accounts, categories and tags, so it is checked against them all.
  for (const rule of index.recurringRules.values()) validateRecurringRule(rule, index);
  return index;
}

/**
 * A recurring rule: its schedule by the bounds every new field is held to, and its template by the
 * rules of the operation it writes — the same references, category types, labels and currencies —
 * so that every occurrence it writes is one the domain accepts.
 */
function validateRecurringRule(rule: RecurringRule, index: StateIndex): void {
  const label = `recurring rule ${rule.id}`;
  if (rule.name !== undefined && !isStorableLabel(rule.name, RULE_NAME_MAX_LENGTH)) {
    throw new Error(`${label} name must be stored text of at most ${RULE_NAME_MAX_LENGTH} characters`);
  }
  assertEnum(rule.frequency, ["daily", "weekly", "monthly", "yearly"], `${label} frequency`);
  if (!Number.isSafeInteger(rule.interval) || rule.interval < 1 || rule.interval > MAX_RECURRENCE_INTERVAL) {
    throw new Error(`${label} interval must be an integer from 1 to ${MAX_RECURRENCE_INTERVAL}`);
  }
  assertWindowDate(rule.startDate, `${label} startDate`);
  if (rule.endDate !== undefined) {
    assertWindowDate(rule.endDate, `${label} endDate`);
    if (rule.endDate < rule.startDate) throw new Error(`${label} endDate must not be before startDate`);
  }
  if (rule.materializedThrough !== undefined) assertWindowDate(rule.materializedThrough, `${label} materializedThrough`);
  if (typeof rule.active !== "boolean") throw new Error(`${label} active must be a boolean`);
  validateRecurringTemplate(rule, index);
}

function validateRecurringTemplate(rule: RecurringRule, index: StateIndex): void {
  const label = `recurring rule ${rule.id} template`;
  const template: unknown = rule.template;
  if (typeof template !== "object" || template === null || Array.isArray(template)) {
    throw new Error(`${label} must be an operation template`);
  }
  const value = rule.template;
  assertEnum(value.kind, ["expense", "income", "transfer"], `${label} kind`);
  assertFieldMinor(value.amountMinor, `${label} amountMinor`);
  if (value.note !== undefined && !isStorableNote(value.note)) {
    throw new Error(`${label} note must be one trimmed line of stored text of at most ${NOTE_MAX_LENGTH} characters`);
  }
  validateTagIds(value.tagIds, index, label);
  switch (value.kind) {
    case "expense": {
      requireEntity(index.accounts, value.accountId, label);
      const category = requireEntity(index.categories, value.categoryId, label);
      if (category.type !== "expense") throw new Error(`${label} must reference an expense category`);
      return;
    }
    case "income": {
      requireEntity(index.accounts, value.accountId, label);
      if (value.categoryId !== undefined) {
        const category = requireEntity(index.categories, value.categoryId, label);
        if (category.type !== "income") throw new Error(`${label} must reference an income category`);
      }
      return;
    }
    case "transfer": {
      const from = requireEntity(index.accounts, value.fromAccountId, label);
      const to = requireEntity(index.accounts, value.toAccountId, label);
      if (value.fromAccountId === value.toAccountId) throw new Error(`${label} must use two different accounts`);
      if (from.currency === to.currency) {
        if (value.toAmountMinor !== undefined) throw new Error(`${label} moves within one currency and must not carry toAmountMinor`);
        return;
      }
      if (value.toAmountMinor === undefined) {
        throw new Error(`${label} moves from ${from.currency} to ${to.currency} and must carry toAmountMinor`);
      }
      assertFieldMinor(value.toAmountMinor, `${label} toAmountMinor`);
      return;
    }
  }
}

/**
 * A debt, by the rules of every field added since the journal existed: a stored label for the
 * counterparty, a direction of the two, a supported currency, an opening amount from zero to the
 * field ceiling and a due date inside the window.
 */
function validateDebt(debt: Debt): void {
  if (!isStorableLabel(debt.counterparty, COUNTERPARTY_MAX_LENGTH)) {
    throw new Error(`debt ${debt.id} counterparty must be stored text of at most ${COUNTERPARTY_MAX_LENGTH} characters`);
  }
  assertEnum(debt.direction, ["i_owe", "owed_to_me"], `debt ${debt.id} direction`);
  if (!isSupportedCurrency(debt.currency)) {
    throw new Error(`debt ${debt.id} currency has unknown value ${String(debt.currency)}`);
  }
  assertNonNegativeMinor(debt.openingMinor, `debt ${debt.id} openingMinor`);
  if (debt.openingMinor > MAX_MONEY_MINOR) throw new Error(`debt ${debt.id} openingMinor must be at most ${MAX_MONEY_MINOR}`);
  if (debt.dueDate !== undefined) assertWindowDate(debt.dueDate, `debt ${debt.id} dueDate`);
  if (typeof debt.active !== "boolean") throw new Error(`debt ${debt.id} active must be a boolean`);
}

function validateHousehold(household: Household): void {
  if (household.id !== HOUSEHOLD_ID) {
    throw new Error(`household id must be ${HOUSEHOLD_ID}, the identifier every device derives`);
  }
  if (!isSupportedCurrency(household.baseCurrency)) {
    throw new Error(`household baseCurrency has unknown value ${String(household.baseCurrency)}`);
  }
}

function assertRateValue(value: unknown, label: string): void {
  if (!isExchangeRateValue(value)) {
    throw new Error(`${label} parts must be integers from ${RATE_PART_MIN} to ${RATE_PART_MAX}`);
  }
}

function validateExchangeRate(rate: ExchangeRate): void {
  if (!isSupportedCurrency(rate.currency)) {
    throw new Error(`exchange rate ${rate.id} currency has unknown value ${String(rate.currency)}`);
  }
  if (!isSupportedCurrency(rate.baseCurrency)) {
    throw new Error(`exchange rate ${rate.id} baseCurrency has unknown value ${String(rate.baseCurrency)}`);
  }
  if (rate.currency === rate.baseCurrency) {
    throw new Error(`exchange rate ${rate.id} must value one currency in another`);
  }
  assertWindowDate(rate.date, `exchange rate ${rate.id} date`);
  assertRateValue(rate.rate, `exchange rate ${rate.id} rate`);
}

/**
 * Stored text is held to the stored-text rule, which asks the engine nothing (stored-text.ts): a
 * label the input rule accepted on one engine must not become a state this engine refuses.
 */
function validateTag(tag: Tag): void {
  if (!isStorableLabel(tag.name, TAG_NAME_MAX_LENGTH)) {
    throw new Error(`tag ${tag.id} name must be stored text of at most ${TAG_NAME_MAX_LENGTH} characters`);
  }
  if (typeof tag.active !== "boolean") {
    throw new Error(`tag ${tag.id} active must be a boolean`);
  }
}

/** A display field is optional; when present it names a design token. */
function assertOptionalDisplayKey(value: unknown, label: string): void {
  if (value !== undefined && !isDisplayKey(value)) {
    throw new Error(`${label} must be a display key`);
  }
}

function createIdRecord<Key extends StableId, Value>(): Record<Key, Value> {
  return Object.create(null) as Record<Key, Value>;
}

function recordFromMap<Key extends StableId, Value>(
  source: ReadonlyMap<Key, Value>,
): Record<Key, Value> {
  const result = createIdRecord<Key, Value>();
  for (const [key, value] of source) {
    result[key] = value;
  }
  return result;
}

function requireEntity<T>(
  entities: ReadonlyMap<StableId, T>,
  id: StableId,
  label: string,
): T {
  const entity = entities.get(id);
  if (entity === undefined) {
    throw new Error(`${label} references unknown id ${id}`);
  }
  return entity;
}

function isWithinBudget(transaction: Transaction, budget: Budget): boolean {
  return transaction.occurredOn >= budget.startDate && transaction.occurredOn <= budget.endDate;
}

function categoryStatus(
  actualMinor: MinorUnits,
  availableMinor: MinorUnits,
  warningThreshold: number,
): CategoryBudgetStatus {
  if (availableMinor === 0) {
    return actualMinor > 0 ? "over_limit" : "no_plan";
  }
  if (actualMinor > availableMinor) {
    return "over_limit";
  }
  if (actualMinor === availableMinor) {
    return "exhausted";
  }
  if (actualMinor / availableMinor >= warningThreshold) {
    return "near_limit";
  }
  return "normal";
}

function validateAccount(account: Account): void {
  assertEnum(account.type, ["current", "cash", "savings", "reserve"], `account ${account.id} type`);
  if (!isSupportedCurrency(account.currency)) {
    throw new Error(`account ${account.id} currency has unknown value ${String(account.currency)}`);
  }
  assertMinor(account.openingBalanceMinor, `account ${account.id} openingBalanceMinor`);
  // Display fields: optional, read by no figure, and never allowed to be something else.
  if (account.sortOrder !== undefined && !Number.isSafeInteger(account.sortOrder)) {
    throw new Error(`account ${account.id} sortOrder must be an integer`);
  }
  if (account.sortOrder !== undefined && Math.abs(account.sortOrder) > MAX_SORT_ORDER) {
    throw new Error(`account ${account.id} sortOrder must be from -${MAX_SORT_ORDER} to ${MAX_SORT_ORDER}`);
  }
  assertOptionalDisplayKey(account.icon, `account ${account.id} icon`);
  assertOptionalDisplayKey(account.color, `account ${account.id} color`);
  if (account.includeInTotal !== undefined && typeof account.includeInTotal !== "boolean") {
    throw new Error(`account ${account.id} includeInTotal must be a boolean when provided`);
  }
}

function validateCategory(category: Category): void {
  assertEnum(category.type, ["income", "expense"], `category ${category.id} type`);
  if (!Number.isSafeInteger(category.sortOrder)) {
    throw new Error(`category ${category.id} sortOrder must be an integer`);
  }
  assertOptionalDisplayKey(category.icon, `category ${category.id} icon`);
  assertOptionalDisplayKey(category.color, `category ${category.id} color`);
}

/**
 * A plan — a goal, a large payment, a schedule — lives on an account kept in the base currency.
 *
 * The annual plan adds their amounts up as they stand, without a rate, so a plan that mixed dollars
 * into roubles would be a plausible figure and a wrong one (D-032).
 */
function assertBaseCurrencyAccount(account: Account, baseCurrency: CurrencyCode, label: string): void {
  if (account.currency !== baseCurrency) {
    throw new Error(`${label} must use an account in the base currency ${baseCurrency}`);
  }
}

function validateGoal(goal: Goal, accounts: ReadonlyMap<StableId, Account>, baseCurrency: CurrencyCode): void {
  assertEnum(goal.status, ["active", "completed", "cancelled"], `goal ${goal.id} status`);
  assertNonNegativeMinor(goal.targetMinor, `goal ${goal.id} targetMinor`);
  assertNonNegativeMinor(
    goal.openingContributedMinor,
    `goal ${goal.id} openingContributedMinor`,
  );
  assertNonNegativeMinor(
    goal.plannedContributionMinor,
    `goal ${goal.id} plannedContributionMinor`,
  );
  const account = requireEntity(accounts, goal.linkedAccountId, `goal ${goal.id}`);
  assertBaseCurrencyAccount(account, baseCurrency, `goal ${goal.id}`);
  if (goal.deadline !== undefined) assertWindowDate(goal.deadline, `goal ${goal.id} deadline`);
  assertOptionalDisplayKey(goal.icon, `goal ${goal.id} icon`);
}

function validateBudget(
  budget: Budget,
  categories: ReadonlyMap<StableId, Category>,
): Map<CategoryId, MinorUnits> {
  assertEnum(budget.status, ["draft", "open", "closed"], `budget ${budget.id} status`);
  assertLocalDate(budget.startDate, `budget ${budget.id} startDate`);
  assertLocalDate(budget.endDate, `budget ${budget.id} endDate`);
  if (budget.startDate > budget.endDate) {
    throw new Error(`budget ${budget.id} startDate must not be after endDate`);
  }
  assertNonNegativeMinor(
    budget.plannedIncomeMinor,
    `budget ${budget.id} plannedIncomeMinor`,
  );
  if (
    !Number.isFinite(budget.warningThreshold) ||
    budget.warningThreshold < 0 ||
    budget.warningThreshold >= 1
  ) {
    throw new Error(`budget ${budget.id} warningThreshold must be in [0, 1)`);
  }

  indexById(budget.lines, `budget ${budget.id} lines`);
  const availableByCategory = new Map<CategoryId, MinorUnits>();

  for (const line of budget.lines) {
    const category = requireEntity(categories, line.categoryId, `budget line ${line.id}`);
    if (category.type !== "expense") {
      throw new Error(`budget line ${line.id} must reference an expense category`);
    }
    if (availableByCategory.has(line.categoryId)) {
      throw new Error(`budget ${budget.id} has multiple lines for category ${line.categoryId}`);
    }
    if (line.active !== undefined && typeof line.active !== "boolean") {
      throw new Error(`budget line ${line.id} active must be a boolean when provided`);
    }

    const rolloverMinor = line.rolloverMinor ?? 0;
    const adjustmentMinor = line.adjustmentMinor ?? 0;
    assertNonNegativeMinor(line.plannedMinor, `budget line ${line.id} plannedMinor`);
    assertNonNegativeMinor(rolloverMinor, `budget line ${line.id} rolloverMinor`);
    assertMinor(adjustmentMinor, `budget line ${line.id} adjustmentMinor`);

    const availableMinor = addMinor(
      addMinor(line.plannedMinor, rolloverMinor, `budget line ${line.id} availableMinor`),
      adjustmentMinor,
      `budget line ${line.id} availableMinor`,
    );
    if (availableMinor < 0) {
      throw new Error(`budget line ${line.id} availableMinor must not be negative`);
    }
    availableByCategory.set(
      line.categoryId,
      category.active && line.active !== false ? availableMinor : 0,
    );
  }

  return availableByCategory;
}

/**
 * The labels every operation may carry — a note, tags and the recurring rule it came from — checked
 * on every transaction, whatever its status and whichever side of the budget window it falls on,
 * for the reason `calculateMemberExpenses` gives for the participant: a label checked only where it
 * is counted can sit dangling in a draft until the day the draft is posted.
 *
 * No figure reads any of them. They are strict all the same, because a stored label that names
 * nothing is a broken reference whoever reads it next; the backup gate and the journal clear a
 * dangling one and say so, and the domain never sees it.
 */
function validateTransactionLabels(transaction: Transaction, index: StateIndex): void {
  const id = transaction.id;
  if (transaction.note !== undefined && !isStorableNote(transaction.note)) {
    throw new Error(`transaction ${id} note must be one trimmed line of stored text of at most ${NOTE_MAX_LENGTH} characters`);
  }
  validateTagIds(transaction.tagIds, index, `transaction ${id}`);
  if (transaction.recurringRuleId !== undefined) {
    // A label, and strict all the same: it names a rule the state holds.
    assertStableId(transaction.recurringRuleId, `transaction ${id} recurringRuleId`);
    requireEntity(index.recurringRules, transaction.recurringRuleId, `transaction ${id} recurringRuleId`);
  }
}

/** Tags on an operation or a template: from one to ten, no repeats, each a tag the state holds. */
function validateTagIds(value: unknown, index: StateIndex, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TAGS_PER_TRANSACTION) {
    throw new Error(`${label} tagIds must list from 1 to ${MAX_TAGS_PER_TRANSACTION} tags`);
  }
  const seen = new Set<TagId>();
  for (const tagId of value as readonly unknown[]) {
    if (typeof tagId !== "string") throw new Error(`${label} tagIds must list tag ids`);
    assertStableId(tagId, `${label} tagIds`);
    if (seen.has(tagId)) throw new Error(`${label} tagIds repeats tag ${tagId}`);
    seen.add(tagId);
    requireEntity(index.tags, tagId, `${label} tagIds`);
  }
}

/**
 * The base-currency snapshot of an income, an expense or a refund, against the account it moves.
 *
 * On an account in the base currency there is none — the amount already is the figure, and a second
 * copy of it could only disagree. On any other account all three fields are there, the snapshot is
 * in this household's base currency, and the value is a positive amount: the budget adds it up as it
 * stands and never looks at a rate table, which is what keeps a new rate from revaluing the past.
 */
function validateBaseSnapshot(
  transaction: Extract<Transaction, { readonly kind: "income" | "expense" | "refund" }>,
  account: Account,
  baseCurrency: CurrencyCode,
): void {
  const id = transaction.id;
  const parts = [transaction.baseAmountMinor, transaction.baseCurrency, transaction.rate];
  const present = parts.filter((part) => part !== undefined).length;
  if (account.currency === baseCurrency) {
    if (present > 0) throw new Error(`transaction ${id} is in the base currency and must not carry a base-currency snapshot`);
    return;
  }
  if (present < parts.length) {
    throw new Error(`transaction ${id} on an account in ${account.currency} must carry baseAmountMinor, baseCurrency and rate together`);
  }
  if (transaction.baseCurrency !== baseCurrency) {
    throw new Error(`transaction ${id} snapshot must be in the base currency ${baseCurrency}`);
  }
  assertFieldMinor(transaction.baseAmountMinor!, `transaction ${id} baseAmountMinor`);
  assertRateValue(transaction.rate, `transaction ${id} rate`);
}

/**
 * The amount that arrives on the other account of a transfer: in its own currency, and named only
 * when that currency is not the one the money left in.
 */
function validateTransferAmounts(
  transaction: Extract<Transaction, { readonly kind: "transfer" }>,
  from: Account,
  to: Account,
): void {
  const id = transaction.id;
  if (from.currency === to.currency) {
    if (transaction.toAmountMinor !== undefined) {
      throw new Error(`transaction ${id} moves within one currency and must not carry toAmountMinor`);
    }
    return;
  }
  if (transaction.toAmountMinor === undefined) {
    throw new Error(`transaction ${id} moves from ${from.currency} to ${to.currency} and must carry toAmountMinor`);
  }
  assertFieldMinor(transaction.toAmountMinor, `transaction ${id} toAmountMinor`);
}

/**
 * The two amounts of a debt movement: the account's, and the debt's when its currency is another.
 * A debt movement is neither income nor expense, so it carries no base-currency snapshot either —
 * nothing in the budget counts it.
 */
function validateDebtAmounts(
  transaction: Extract<Transaction, { readonly kind: "debt_out" | "debt_in" }>,
  account: Account,
  debt: Debt,
): void {
  const id = transaction.id;
  for (const field of ["baseAmountMinor", "baseCurrency", "rate", "toAmountMinor"]) {
    if (field in transaction) throw new Error(`transaction ${id} moves a debt and must not carry ${field}`);
  }
  if (account.currency === debt.currency) {
    if (transaction.debtAmountMinor !== undefined) {
      throw new Error(`transaction ${id} is in the debt's currency and must not carry debtAmountMinor`);
    }
    return;
  }
  if (transaction.debtAmountMinor === undefined) {
    throw new Error(`transaction ${id} moves ${account.currency} against a debt in ${debt.currency} and must carry debtAmountMinor`);
  }
  assertFieldMinor(transaction.debtAmountMinor, `transaction ${id} debtAmountMinor`);
}

/**
 * Every reference and label of one transaction, against the whole index. Exported for the metrics
 * that live in modules of their own (`debts.ts`, `holdings.ts`), so they refuse exactly what the
 * budget refuses; not part of the package's public surface.
 */
export function validateTransactionReferences(transaction: Transaction, index: StateIndex): void {
  const { accounts, categories, goals, transactions, baseCurrency } = index;
  assertEnum(transaction.status, ["posted", "pending", "draft"], `transaction ${transaction.id} status`);
  assertEnum(
    transaction.kind,
    ["income", "expense", "refund", "transfer", "goal_contribution", "debt_out", "debt_in"],
    `transaction ${transaction.id} kind`,
  );
  assertLocalDate(transaction.occurredOn, `transaction ${transaction.id} occurredOn`);
  assertPositiveMinor(transaction.amountMinor, `transaction ${transaction.id} amountMinor`);
  validateTransactionLabels(transaction, index);

  switch (transaction.kind) {
    case "income": {
      const account = requireEntity(accounts, transaction.accountId, `transaction ${transaction.id}`);
      validateBaseSnapshot(transaction, account, baseCurrency);
      const categoryId = transaction.categoryId;
      // Optional, like memberId: absent in every income written before income had categories.
      if (categoryId !== undefined) {
        assertStableId(categoryId, `transaction ${transaction.id} categoryId`);
        const category = requireEntity(categories, categoryId, `transaction ${transaction.id}`);
        if (category.type !== "income") {
          throw new Error(`transaction ${transaction.id} must reference an income category`);
        }
      }
      return;
    }
    case "expense": {
      const account = requireEntity(accounts, transaction.accountId, `transaction ${transaction.id}`);
      validateBaseSnapshot(transaction, account, baseCurrency);
      const category = requireEntity(
        categories,
        transaction.categoryId,
        `transaction ${transaction.id}`,
      );
      if (category.type !== "expense") {
        throw new Error(`transaction ${transaction.id} must reference an expense category`);
      }
      return;
    }
    case "refund": {
      const account = requireEntity(accounts, transaction.accountId, `transaction ${transaction.id}`);
      validateBaseSnapshot(transaction, account, baseCurrency);
      const category = requireEntity(categories, transaction.categoryId, `transaction ${transaction.id}`);
      if (category.type !== "expense") throw new Error(`transaction ${transaction.id} must reference an expense category`);
      const original = requireEntity(transactions, transaction.originalTransactionId, `refund ${transaction.id} originalTransactionId`);
      if (original.status !== "posted" || original.kind !== "expense") {
        throw new Error(`refund ${transaction.id} must reference a posted expense transaction`);
      }
      if (original.categoryId !== transaction.categoryId) {
        throw new Error(`refund ${transaction.id} must use the original expense category`);
      }
      if (transaction.occurredOn < original.occurredOn) {
        throw new Error(`refund ${transaction.id} must not occur before the original expense`);
      }
      return;
    }
    case "transfer": {
      const from = requireEntity(accounts, transaction.fromAccountId, `transaction ${transaction.id}`);
      const to = requireEntity(accounts, transaction.toAccountId, `transaction ${transaction.id}`);
      if (transaction.fromAccountId === transaction.toAccountId) {
        throw new Error(`transaction ${transaction.id} must use two different accounts`);
      }
      validateTransferAmounts(transaction, from, to);
      return;
    }
    case "goal_contribution": {
      const from = requireEntity(accounts, transaction.fromAccountId, `transaction ${transaction.id}`);
      const to = requireEntity(accounts, transaction.toAccountId, `transaction ${transaction.id}`);
      if (transaction.fromAccountId === transaction.toAccountId) {
        throw new Error(`transaction ${transaction.id} must use two different accounts`);
      }
      // A contribution carries one amount, so both accounts count it in one currency.
      if (from.currency !== to.currency) {
        throw new Error(`transaction ${transaction.id} must move between two accounts in one currency`);
      }
      const goal = requireEntity(goals, transaction.goalId, `transaction ${transaction.id}`);
      if (goal.linkedAccountId !== transaction.toAccountId) {
        throw new Error(
          `transaction ${transaction.id} destination must match goal ${goal.id} linked account`,
        );
      }
      return;
    }
    case "debt_out":
    case "debt_in": {
      const account = requireEntity(accounts, transaction.accountId, `transaction ${transaction.id}`);
      const debt = requireEntity(index.debts, transaction.debtId, `transaction ${transaction.id} debtId`);
      validateDebtAmounts(transaction, account, debt);
      return;
    }
    default: {
      const unknown = transaction as unknown as { readonly id?: unknown; readonly kind?: unknown };
      throw new Error(`transaction ${String(unknown.id)} kind has unknown value ${String(unknown.kind)}`);
    }
  }
}

export function calculateBudget(
  state: BudgetState,
  budgetId: string = state.activeBudgetId,
): BudgetMetrics {
  const index = indexState(state);

  for (const account of state.accounts) validateAccount(account);
  for (const category of state.categories) validateCategory(category);
  for (const goal of state.goals) validateGoal(goal, index.accounts, index.baseCurrency);

  const budget = requireEntity(index.budgets, budgetId, "calculateBudget");
  const availableByCategory = validateBudget(budget, index.categories);

  const accountBalances = new Map<AccountId, MinorUnits>();
  for (const account of state.accounts) {
    accountBalances.set(account.id, account.openingBalanceMinor);
  }

  const expenseByCategory = new Map<CategoryId, MinorUnits>();
  const refundByCategory = new Map<CategoryId, MinorUnits>();
  for (const category of state.categories) {
    if (category.type === "expense") {
      expenseByCategory.set(category.id, 0);
      refundByCategory.set(category.id, 0);
    }
  }

  const goalContributions = new Map<GoalId, MinorUnits>();
  for (const goal of state.goals) {
    goalContributions.set(goal.id, goal.openingContributedMinor);
  }

  let incomeMinor = 0;
  let grossExpensesMinor = 0;
  let refundsMinor = 0;
  let goalContributionMinor = 0;

  const changeAccount = (accountId: AccountId, delta: MinorUnits): void => {
    const current = accountBalances.get(accountId);
    if (current === undefined) {
      throw new Error(`cannot change unknown account ${accountId}`);
    }
    accountBalances.set(accountId, addMinor(current, delta, `account ${accountId} balance`));
  };

  for (const transaction of state.transactions) {
    validateTransactionReferences(transaction, index);
    if (transaction.status !== "posted" || !isWithinBudget(transaction, budget)) continue;

    // The budget's figures are counted in the base currency, the balances in each account's own:
    // an operation on an account in another currency moves that account by its amount and the
    // budget by the snapshot it carries, and no rate table is read on the way.
    switch (transaction.kind) {
      case "income":
        incomeMinor = addMinor(incomeMinor, baseAmountOf(transaction), "incomeMinor");
        changeAccount(transaction.accountId, transaction.amountMinor);
        break;
      case "expense": {
        const baseMinor = baseAmountOf(transaction);
        grossExpensesMinor = addMinor(grossExpensesMinor, baseMinor, "grossExpensesMinor");
        const categoryAmount = expenseByCategory.get(transaction.categoryId) ?? 0;
        expenseByCategory.set(
          transaction.categoryId,
          addMinor(categoryAmount, baseMinor, "category expenseMinor"),
        );
        changeAccount(transaction.accountId, -transaction.amountMinor);
        break;
      }
      case "refund": {
        const baseMinor = baseAmountOf(transaction);
        refundsMinor = addMinor(refundsMinor, baseMinor, "refundsMinor");
        const categoryAmount = refundByCategory.get(transaction.categoryId) ?? 0;
        refundByCategory.set(
          transaction.categoryId,
          addMinor(categoryAmount, baseMinor, "category refundMinor"),
        );
        changeAccount(transaction.accountId, transaction.amountMinor);
        break;
      }
      case "transfer":
        changeAccount(transaction.fromAccountId, -transaction.amountMinor);
        changeAccount(transaction.toAccountId, transaction.toAmountMinor ?? transaction.amountMinor);
        break;
      case "goal_contribution": {
        changeAccount(transaction.fromAccountId, -transaction.amountMinor);
        changeAccount(transaction.toAccountId, transaction.amountMinor);
        goalContributionMinor = addMinor(
          goalContributionMinor,
          transaction.amountMinor,
          "goalContributionMinor",
        );
        const current = goalContributions.get(transaction.goalId) ?? 0;
        goalContributions.set(
          transaction.goalId,
          addMinor(current, transaction.amountMinor, "goal contributedMinor"),
        );
        break;
      }
      // A debt movement is neither income nor expense (rule 4 of the contracts): it moves the
      // account it touches and no figure of the budget. Its other side is the debt's balance,
      // which `calculateDebts` keeps.
      case "debt_out":
        changeAccount(transaction.accountId, -transaction.amountMinor);
        break;
      case "debt_in":
        changeAccount(transaction.accountId, transaction.amountMinor);
        break;
    }
  }

  const categoryMetrics = createIdRecord<CategoryId, CategoryMetrics>();
  let plannedExpenseMinor = 0;

  for (const category of state.categories) {
    if (category.type !== "expense") continue;

    const availableMinor = availableByCategory.get(category.id) ?? 0;
    const expenseMinor = expenseByCategory.get(category.id) ?? 0;
    const refundMinor = refundByCategory.get(category.id) ?? 0;
    // Excess refunds remain a negative net actual in their original category.
    const actualMinor = addMinor(expenseMinor, -refundMinor, "category actualMinor");
    const remainingMinor = addMinor(availableMinor, -actualMinor, "category remainingMinor");
    const overMinor = Math.max(0, actualMinor - availableMinor);
    plannedExpenseMinor = addMinor(
      plannedExpenseMinor,
      availableMinor,
      "plannedExpenseMinor",
    );

    categoryMetrics[category.id] = {
      categoryId: category.id,
      availableMinor,
      expenseMinor,
      refundMinor,
      actualMinor,
      remainingMinor,
      overMinor,
      execution: availableMinor === 0 ? null : actualMinor / availableMinor,
      status: categoryStatus(actualMinor, availableMinor, budget.warningThreshold),
    };
  }

  const expensesMinor = addMinor(grossExpensesMinor, -refundsMinor, "expensesMinor");
  // Capital adds up the accounts kept in the base currency and no other: a dollar balance added to
  // a rouble one is a sum of cents and kopecks, which is no amount of anything. Every state written
  // before currencies were more than a label keeps its accounts in roubles, so its capital is what
  // it always was. The valuation of everything held, at a rate, is a metric of its own (holdings).
  let capitalMinor = 0;
  for (const account of state.accounts) {
    if (account.currency !== index.baseCurrency) continue;
    capitalMinor = addMinor(capitalMinor, accountBalances.get(account.id) ?? 0, "capitalMinor");
  }

  return {
    budgetId: budget.id,
    incomeMinor,
    grossExpensesMinor,
    refundsMinor,
    expensesMinor,
    plannedExpenseMinor,
    goalContributionMinor,
    capitalMinor,
    aggregateExecution:
      plannedExpenseMinor === 0 ? null : expensesMinor / plannedExpenseMinor,
    accountBalancesMinor: recordFromMap(accountBalances),
    goalContributionsMinor: recordFromMap(goalContributions),
    categoryMetrics,
  };
}

function validateMember(member: Member): void {
  assertEnum(member.role, ["owner", "member"], `member ${member.id} role`);
  if (typeof member.name !== "string") {
    throw new Error(`member ${member.id} name must be a string`);
  }
  if (typeof member.active !== "boolean") {
    throw new Error(`member ${member.id} active must be a boolean`);
  }
}

function expenseShare(
  expenseMinor: MinorUnits,
  refundMinor: MinorUnits,
  transactionCount: number,
  expensesMinor: MinorUnits,
): ExpenseShareMetrics {
  const actualMinor = addMinor(expenseMinor, -refundMinor, "member actualMinor");
  return {
    expenseMinor,
    refundMinor,
    actualMinor,
    transactionCount,
    share: expensesMinor > 0 ? actualMinor / expensesMinor : null,
  };
}

/**
 * Expenses of one budget split by participant.
 *
 * Deliberately a second pass rather than a field of {@link calculateBudget}: attribution is
 * a label on an operation, and no headline figure may move because a label was added, changed
 * or dropped. A state without members, or with operations that carry no `memberId`, is normal
 * and lands whole in `unattributed` — that is what every backup written before members looks
 * like. Counts the same operations as `calculateBudget`: posted expenses and refunds inside
 * the budget window, so `attributedMinor` plus `unattributed.actualMinor` is exactly
 * `BudgetMetrics.expensesMinor`.
 *
 * Validates every transaction the way `calculateBudget` validates it — the same references,
 * plus the label — and validates all of them, whatever their status and whichever side of the
 * budget window they fall on. Two reasons, and neither is tidiness. A metric built on a state
 * the main calculation rejects is a metric compared against a figure that does not exist, so
 * the invariant `attributedMinor + unattributed.actualMinor === expensesMinor` would be
 * checked against nothing. And a label checked only on the operations that happen to be
 * counted lets a dangling one sit in a draft, in a transfer or in last month's expense until
 * the day it is posted or the window moves — a state that is valid for months and then is not,
 * without anybody having touched the label. The sync journal already sweeps every transaction
 * it holds, with no regard for status or window (`clearUnknownAttribution`); this makes the
 * domain say the same thing from its own side, and strictly: the journal repairs a dangling
 * label and reports it, the domain never sees one and never silently drops one.
 */
export function calculateMemberExpenses(
  state: BudgetState,
  budgetId: string = state.activeBudgetId,
): MemberExpenseBreakdown {
  const index = indexState(state);
  const budget = requireEntity(index.budgets, budgetId, "calculateMemberExpenses");
  assertLocalDate(budget.startDate, `budget ${budget.id} startDate`);
  assertLocalDate(budget.endDate, `budget ${budget.id} endDate`);

  const declared = state.members ?? [];
  const members = indexById(declared, "members");
  for (const member of declared) validateMember(member);

  const expenseByMember = new Map<MemberId, MinorUnits>();
  const refundByMember = new Map<MemberId, MinorUnits>();
  const countByMember = new Map<MemberId, number>();
  for (const member of declared) {
    expenseByMember.set(member.id, 0);
    refundByMember.set(member.id, 0);
    countByMember.set(member.id, 0);
  }

  let unattributedExpenseMinor = 0;
  let unattributedRefundMinor = 0;
  let unattributedCount = 0;
  let grossExpensesMinor = 0;
  let refundsMinor = 0;

  for (const transaction of state.transactions) {
    validateTransactionReferences(transaction, index);
    // The label is a reference like any other and is checked here, before the status and
    // window filter, so no dangling one can hide in an operation this budget does not count.
    const memberId = transaction.memberId;
    if (memberId !== undefined) {
      assertStableId(memberId, `transaction ${transaction.id} memberId`);
      requireEntity(members, memberId, `transaction ${transaction.id} memberId`);
    }
    if (transaction.status !== "posted" || !isWithinBudget(transaction, budget)) continue;
    if (transaction.kind !== "expense" && transaction.kind !== "refund") continue;

    const isRefund = transaction.kind === "refund";
    // In the base currency, exactly as calculateBudget counts it, so the split adds up to its total.
    const baseMinor = baseAmountOf(transaction);
    if (isRefund) {
      refundsMinor = addMinor(refundsMinor, baseMinor, "refundsMinor");
    } else {
      grossExpensesMinor = addMinor(grossExpensesMinor, baseMinor, "grossExpensesMinor");
    }

    if (memberId === undefined) {
      if (isRefund) {
        unattributedRefundMinor = addMinor(unattributedRefundMinor, baseMinor, "unattributed refundMinor");
      } else {
        unattributedExpenseMinor = addMinor(unattributedExpenseMinor, baseMinor, "unattributed expenseMinor");
      }
      unattributedCount += 1;
      continue;
    }

    const bucket = isRefund ? refundByMember : expenseByMember;
    const label = isRefund ? "member refundMinor" : "member expenseMinor";
    bucket.set(memberId, addMinor(bucket.get(memberId) ?? 0, baseMinor, label));
    countByMember.set(memberId, (countByMember.get(memberId) ?? 0) + 1);
  }

  const expensesMinor = addMinor(grossExpensesMinor, -refundsMinor, "expensesMinor");
  const byMember = createIdRecord<MemberId, MemberExpenseMetrics>();
  const memberMetrics: MemberExpenseMetrics[] = [];
  let attributedMinor = 0;

  for (const member of declared) {
    const metrics: MemberExpenseMetrics = {
      memberId: member.id,
      ...expenseShare(
        expenseByMember.get(member.id) ?? 0,
        refundByMember.get(member.id) ?? 0,
        countByMember.get(member.id) ?? 0,
        expensesMinor,
      ),
    };
    attributedMinor = addMinor(attributedMinor, metrics.actualMinor, "attributedMinor");
    memberMetrics.push(metrics);
    byMember[member.id] = metrics;
  }

  return {
    budgetId: budget.id,
    expensesMinor,
    attributedMinor,
    members: memberMetrics,
    byMember,
    unattributed: expenseShare(
      unattributedExpenseMinor,
      unattributedRefundMinor,
      unattributedCount,
      expensesMinor,
    ),
  };
}

function effectiveCommitmentDueIndex(
  item: AnnualCommitment,
  startIndex: number,
): number {
  const originalDueIndex = monthIndex(
    item.dueDate.slice(0, 7),
    `annual commitment ${item.id} due month`,
  );
  if (item.recurrence === "one_time" || originalDueIndex >= startIndex) {
    return originalDueIndex;
  }
  const nextDueIndex = originalDueIndex + Math.ceil((startIndex - originalDueIndex) / 12) * 12;
  if (nextDueIndex > MAX_LOCAL_MONTH_INDEX) {
    throw new Error("annual recurrence exceeds supported calendar range");
  }
  return nextDueIndex;
}

/** A due day beyond the month end is charged on that month's final calendar day. */
export function normalizeScheduledDueDate(month: string, dueDay: number): string {
  monthIndex(month, "month");
  if (!Number.isSafeInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    throw new Error("dueDay must be from 1 to 31");
  }
  return `${month}-${String(Math.min(dueDay, daysInMonth(month))).padStart(2, "0")}`;
}

function validateAnnualCommitment(
  item: AnnualCommitment,
  accounts: ReadonlyMap<StableId, Account>,
  categories: ReadonlyMap<StableId, Category>,
  baseCurrency: CurrencyCode,
): void {
  assertEnum(item.recurrence, ["annual", "one_time"], `annual commitment ${item.id} recurrence`);
  assertLocalDate(item.dueDate, `annual commitment ${item.id} dueDate`);
  assertPositiveMinor(item.amountMinor, `annual commitment ${item.id} amountMinor`);
  assertNonNegativeMinor(item.reservedMinor, `annual commitment ${item.id} reservedMinor`);
  const account = requireEntity(accounts, item.accountId, `annual commitment ${item.id}`);
  assertBaseCurrencyAccount(account, baseCurrency, `annual commitment ${item.id}`);
  const category = requireEntity(categories, item.categoryId, `annual commitment ${item.id}`);
  if (category.type !== "expense") {
    throw new Error(`annual commitment ${item.id} must reference an expense category`);
  }
}

function validateScheduledExpense(
  item: ScheduledExpense,
  accounts: ReadonlyMap<StableId, Account>,
  categories: ReadonlyMap<StableId, Category>,
  baseCurrency: CurrencyCode,
): void {
  assertEnum(item.mode, ["monthly", "selected_months"], `scheduled expense ${item.id} mode`);
  assertPositiveMinor(item.amountMinor, `scheduled expense ${item.id} amountMinor`);
  if (!Number.isSafeInteger(item.dueDay) || item.dueDay < 1 || item.dueDay > 31) {
    throw new Error(`scheduled expense ${item.id} dueDay must be from 1 to 31`);
  }
  const account = requireEntity(accounts, item.accountId, `scheduled expense ${item.id}`);
  assertBaseCurrencyAccount(account, baseCurrency, `scheduled expense ${item.id}`);
  const category = requireEntity(categories, item.categoryId, `scheduled expense ${item.id}`);
  if (category.type !== "expense") {
    throw new Error(`scheduled expense ${item.id} must reference an expense category`);
  }
  if (item.mode === "selected_months") {
    if (!item.months?.length) {
      throw new Error(`scheduled expense ${item.id} must select at least one month`);
    }
    const unique = new Set(item.months);
    if (unique.size !== item.months.length || item.months.some((month) => !Number.isSafeInteger(month) || month < 1 || month > 12)) {
      throw new Error(`scheduled expense ${item.id} months must be unique values from 1 to 12`);
    }
  }
}

/**
 * Builds a rolling monthly plan. Annual payments are shown in their due month,
 * while their reserve is subtracted monthly so the same payment is not counted twice.
 */
export function calculateAnnualPlan(
  state: BudgetState,
  startMonth: string = state.budgets.find((budget) => budget.id === state.activeBudgetId)?.startDate.slice(0, 7) ?? "",
  monthCount = 12,
): AnnualPlanMetrics {
  const startIndex = monthIndex(startMonth, "startMonth");
  if (!Number.isSafeInteger(monthCount) || monthCount < 1 || monthCount > 24) {
    throw new Error("monthCount must be an integer from 1 to 24");
  }
  if (startIndex > MAX_LOCAL_MONTH_INDEX - (monthCount - 1)) {
    throw new Error("planning horizon exceeds supported calendar range");
  }

  const index = indexState(state);
  const { accounts, categories, goals } = index;
  const annualCommitments = indexById(state.annualCommitments ?? [], "annualCommitments");
  const scheduledExpenses = indexById(state.scheduledExpenses ?? [], "scheduledExpenses");
  const budget = requireEntity(index.budgets, state.activeBudgetId, "calculateAnnualPlan");
  for (const account of accounts.values()) validateAccount(account);
  for (const category of categories.values()) validateCategory(category);
  const flexibleByCategory = validateBudget(budget, categories);

  for (const goal of goals.values()) validateGoal(goal, accounts, index.baseCurrency);
  for (const transaction of index.transactions.values()) validateTransactionReferences(transaction, index);

  for (const item of annualCommitments.values()) {
    validateAnnualCommitment(item, accounts, categories, index.baseCurrency);
  }
  for (const item of scheduledExpenses.values()) {
    validateScheduledExpense(item, accounts, categories, index.baseCurrency);
  }

  const flexiblePlanMinor = [...flexibleByCategory.values()].reduce(
    (total, value) => addMinor(total, value, "flexiblePlanMinor"),
    0,
  );
  const goalPlanMinor = [...goals.values()]
    .filter((goal) => goal.status === "active")
    .reduce((total, goal) => addMinor(total, goal.plannedContributionMinor, "goalPlanMinor"), 0);

  const commitmentMetrics = createIdRecord<AnnualCommitmentId, AnnualCommitmentMetrics>();
  const effectiveDueByCommitment = new Map<AnnualCommitmentId, number>();
  for (const item of annualCommitments.values()) {
    const dueIndex = effectiveCommitmentDueIndex(item, startIndex);
    effectiveDueByCommitment.set(item.id, dueIndex);
    const monthsUntilDue = dueIndex - startIndex + 1;
    // reservedMinor is the current unspent reserve balance. It intentionally carries
    // across annual anniversaries: the calendar cannot infer payment or consumption,
    // so a user edit or transaction flow must update the balance explicitly.
    const remainingToReserveMinor = Math.max(0, item.amountMinor - item.reservedMinor);
    const monthlyReserveMinor = item.active && monthsUntilDue > 0 && remainingToReserveMinor > 0
      ? reservePerMonth(remainingToReserveMinor, monthsUntilDue)
      : 0;
    const status = remainingToReserveMinor === 0
      ? "funded"
      : monthsUntilDue <= 0
        ? "overdue"
        : monthsUntilDue <= 2
          ? "due_soon"
          : "on_track";
    commitmentMetrics[item.id] = {
      commitmentId: item.id,
      monthsUntilDue,
      remainingToReserveMinor,
      monthlyReserveMinor,
      status,
    };
  }

  const monthlyPlan: PlanningMonthMetrics[] = [];
  for (let offset = 0; offset < monthCount; offset += 1) {
    const currentIndex = startIndex + offset;
    const month = monthFromIndex(currentIndex);
    const calendarMonth = Number(month.slice(5, 7));
    const scheduledExpenseMinor = [...scheduledExpenses.values()]
      .filter((item) => item.active && (item.mode === "monthly" || item.months?.includes(calendarMonth)))
      .reduce((total, item) => addMinor(total, item.amountMinor, "scheduledExpenseMinor"), 0);
    const seasonalExpenseMinor = [...scheduledExpenses.values()]
      .filter((item) => item.active && item.mode === "selected_months" && item.months?.includes(calendarMonth))
      .reduce((total, item) => addMinor(total, item.amountMinor, "seasonalExpenseMinor"), 0);
    const annualReserveMinor = [...annualCommitments.values()]
      .filter((item) => item.active)
      .reduce((total, item) => {
        const dueIndex = effectiveDueByCommitment.get(item.id)!;
        const reserve = currentIndex <= dueIndex
          ? commitmentMetrics[item.id]?.monthlyReserveMinor ?? 0
          : item.recurrence === "annual"
            ? reservePerMonth(item.amountMinor, 12)
            : 0;
        return addMinor(total, reserve, "annualReserveMinor");
      }, 0);
    const annualDueMinor = [...annualCommitments.values()]
      .filter((item) => {
        if (!item.active) return false;
        const dueIndex = monthIndex(item.dueDate.slice(0, 7), `annual commitment ${item.id} due month`);
        return currentIndex === dueIndex || (item.recurrence === "annual" && currentIndex > dueIndex && (currentIndex - dueIndex) % 12 === 0);
      })
      .reduce((total, item) => addMinor(total, item.amountMinor, "annualDueMinor"), 0);
    const committedMinor = [scheduledExpenseMinor, flexiblePlanMinor, annualReserveMinor, goalPlanMinor]
      .reduce((total, value) => addMinor(total, value, "committedMinor"), 0);
    monthlyPlan.push({
      month,
      plannedIncomeMinor: budget.plannedIncomeMinor,
      scheduledExpenseMinor,
      seasonalExpenseMinor,
      flexiblePlanMinor,
      annualReserveMinor,
      annualDueMinor,
      goalPlanMinor,
      spendableAfterPlanMinor: addMinor(budget.plannedIncomeMinor, -committedMinor, "spendableAfterPlanMinor"),
    });
  }

  const upcomingCommitmentIds = [...annualCommitments.values()]
    .filter((item) => item.active && effectiveDueByCommitment.get(item.id)! >= startIndex)
    .sort((left, right) => {
      const monthDifference = effectiveDueByCommitment.get(left.id)! - effectiveDueByCommitment.get(right.id)!;
      if (monthDifference !== 0) return monthDifference;
      const dayDifference = Number(left.dueDate.slice(8, 10)) - Number(right.dueDate.slice(8, 10));
      if (dayDifference !== 0) return dayDifference;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    })
    .map((item) => item.id);

  return {
    startMonth,
    months: monthlyPlan,
    commitments: commitmentMetrics,
    currentMonth: monthlyPlan[0]!,
    upcomingCommitmentIds,
  };
}

export function formatMinor(
  amountMinor: MinorUnits,
  options: FormatMinorOptions = {},
): string {
  assertMinor(amountMinor, "amountMinor");
  const exponent = options.exponent ?? 2;
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new Error("exponent must be an integer from 0 to 6");
  }

  return new Intl.NumberFormat(options.locale ?? "ru-RU", {
    style: "currency",
    currency: options.currency ?? "RUB",
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(amountMinor / 10 ** exponent);
}
