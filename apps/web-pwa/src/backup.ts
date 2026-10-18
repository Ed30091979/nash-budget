import {
  baseCurrencyOf,
  calculateAnnualPlan,
  calculateBudget,
  calculateDebts,
  calculateHoldings,
  calculateMemberExpenses,
  calculateTagExpenses,
  COLLECTION_LIMITS,
  convertMinor,
  COUNTERPARTY_MAX_LENGTH,
  DEFAULT_BASE_CURRENCY,
  HOUSEHOLD_ID,
  isExchangeRateValue,
  isSupportedCurrency,
  isBlankStoredText,
  isDisplayKey,
  isStorableLabel,
  isStorableNote,
  isUuid,
  isWithinDateWindow,
  MAX_LOCAL_DATE,
  MAX_MONEY_MINOR,
  MAX_RECURRENCE_INTERVAL,
  MAX_SORT_ORDER,
  MAX_TAGS_PER_TRANSACTION,
  MIN_LOCAL_DATE,
  NOTE_MAX_LENGTH,
  RULE_NAME_MAX_LENGTH,
  TAG_NAME_MAX_LENGTH,
  type BudgetState,
  type RecurringTemplate,
  type Transaction,
} from "@family-budget/domain";
import {
  ValidatedBackupCodec,
  type SerializeBackupOptions,
} from "@family-budget/storage";

export const MAX_BACKUP_FILE_BYTES = 5 * 1024 * 1024;
export const BACKUP_LIMITS = {
  accounts: COLLECTION_LIMITS.accounts,
  members: COLLECTION_LIMITS.members,
  categories: COLLECTION_LIMITS.categories,
  budgets: COLLECTION_LIMITS.budgets,
  goals: COLLECTION_LIMITS.goals,
  annualCommitments: COLLECTION_LIMITS.annualCommitments,
  scheduledExpenses: COLLECTION_LIMITS.scheduledExpenses,
  transactions: COLLECTION_LIMITS.transactions,
  linesPerBudget: COLLECTION_LIMITS.linesPerBudget,
  totalBudgetLines: COLLECTION_LIMITS.budgetLines,
  selectedMonths: 12,
  idLength: 128,
  nameLength: 200,
  textLength: 500,
  tags: COLLECTION_LIMITS.tags,
  exchangeRates: COLLECTION_LIMITS.exchangeRates,
  debts: COLLECTION_LIMITS.debts,
  recurringRules: COLLECTION_LIMITS.recurringRules,
  counterpartyLength: COUNTERPARTY_MAX_LENGTH,
  ruleNameLength: RULE_NAME_MAX_LENGTH,
  tagsPerTransaction: MAX_TAGS_PER_TRANSACTION,
  tagNameLength: TAG_NAME_MAX_LENGTH,
} as const;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type LegacyBudgetState = Omit<BudgetState, "annualCommitments" | "scheduledExpenses"> &
  Partial<Pick<BudgetState, "annualCommitments" | "scheduledExpenses">>;

interface BackupFile {
  readonly size: number;
  text(): Promise<string>;
}

export interface PreparedBudgetBackup {
  readonly text: string;
  readonly createdAt: string;
  /**
   * Что сказать человеку, когда записанную копию эта сборка восстановить не сможет — в бюджете
   * записей больше, чем принимает восстановление, — или `null`, когда копия восстанавливается.
   */
  readonly restoreWarning: string | null;
}

/**
 * A repair the gate applied to the restored state, so that nothing changes silently.
 *
 * Every repair takes a label off an operation and nothing else: the participant credited with it,
 * a tag, or the recurring rule it came from. The operation and its money always stay.
 */
export type BackupRepair =
  | {
    readonly kind: "unknown_member_attribution";
    readonly transactionId: string;
    readonly memberId: string;
  }
  | {
    readonly kind: "unknown_tag";
    readonly transactionId: string;
    readonly tagId: string;
  }
  | {
    readonly kind: "unknown_recurring_rule";
    readonly transactionId: string;
    readonly recurringRuleId: string;
  };

export type BackupRepairReporter = (repair: BackupRepair) => void;

/** Что сказать человеку о ремонтах одного вида: сколько снято и чего в копии нет. */
const REPAIR_NOTICES = {
  unknown_member_attribution: (count: number) => `Снято меток участника: ${count} — такого участника в копии нет.`,
  unknown_tag: (count: number) => `Снято меток: ${count} — таких меток в копии нет.`,
  unknown_recurring_rule: (count: number) => `Снята привязка к регулярной операции: ${count} — такого правила в копии нет.`,
} as const satisfies Readonly<Record<BackupRepair["kind"], (count: number) => string>>;

/**
 * Сообщение о ремонтах восстановленной копии, по строке на вид ремонта, или `null`, если ремонтов
 * не было.
 *
 * Раньше любой ремонт назывался снятой меткой участника: пока участник был единственной меткой, это
 * было правдой. С метками и правилами регулярных операций это стало бы ложью на экране, поэтому
 * каждый вид считается отдельно и называется своими словами. Последняя фраза общая: ремонт снимает
 * метку и ничего больше — операции и суммы восстановлены как есть.
 */
export function describeBackupRepairs(repairs: readonly BackupRepair[]): string | null {
  const counts = new Map<BackupRepair["kind"], number>();
  for (const repair of repairs) counts.set(repair.kind, (counts.get(repair.kind) ?? 0) + 1);
  const lines: string[] = [];
  for (const kind of Object.keys(REPAIR_NOTICES) as BackupRepair["kind"][]) {
    const count = counts.get(kind);
    if (count !== undefined) lines.push(REPAIR_NOTICES[kind](count));
  }
  if (lines.length === 0) return null;
  return [...lines, "Сами операции и все суммы восстановлены без изменений."].join(" ");
}

/**
 * Where a state comes from, which decides one thing: whether the count of a collection is a
 * refusal. Every collection grows through the family's journal, so this is every count the gate
 * keeps — the lines of a budget and of all budgets included.
 *
 * - `file` — a backup being restored. A file is untrusted input, and the counts bound the work its
 *   restore does, so a file beyond {@link COLLECTION_LIMITS} is refused.
 * - `export` — a backup being written from the state the app holds. Not refused for a count either:
 *   the family's data is the family's, and a copy of a document past a limit is still a copy of
 *   everything it holds. That this build would refuse to restore it is checked and said at the
 *   moment of writing ({@link PreparedBudgetBackup.restoreWarning}), not discovered on restore.
 * - `document` — a state the app already holds: written by this device, read from storage or
 *   materialised from the journal. Several devices adding accounts, operations or tags offline can
 *   pass a limit together — two devices merging sixty accounts each is honest work — and a refusal
 *   here would refuse the merged state on every write of every device, leaving the whole family on
 *   its last snapshot with nothing on the screen to say so. Creation keeps each device under the
 *   limit where a form creates the kind, and the journal reports the overflow (`collection_limit`).
 *
 * Every other check is the same for both: a malformed field is malformed wherever it comes from.
 */
export type BudgetStateSource = "document" | "file" | "export";

const RENDERABLE_PLANNING_HORIZON_MONTHS = 24;

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
  // Blank by the domain's stored-text whitespace, not by `trim`, whose answer moves with the engine.
  if (typeof value !== "string" || (nonEmpty && isBlankStoredText(value))) {
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

function requireOptionalBoolean(value: unknown, label: string): void {
  if (value !== undefined) requireBoolean(value, label);
}

/**
 * A display field: absent, or the key of a design token. A copy carries a choice from the design
 * system, never a colour or a file name of its own.
 */
function requireOptionalDisplayKey(value: unknown, label: string): void {
  if (value === undefined) return;
  requireString(value, label, true, BACKUP_LIMITS.idLength);
  if (!isDisplayKey(value)) throw new Error(`${label}: недопустимый ключ оформления.`);
}

function requireOptionalSafeInteger(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label}: ожидалось целое число.`);
}

function requireLocalDate(value: string, label: string): void {
  if (!LOCAL_DATE_PATTERN.test(value)) throw new Error(`${label}: дата должна иметь формат YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label}: невозможная календарная дата.`);
  }
}

/**
 * The date of a field added to the model since the journal existed: inside the window the journal
 * carries, the same window the domain and the codec hold it to (`MIN_LOCAL_DATE`…`MAX_LOCAL_DATE`).
 * Older dates are checked by {@link requireLocalDate} alone, because a copy written by 1.0.0 may
 * carry one outside it and must keep restoring.
 */
function requireWindowDate(value: unknown, label: string): void {
  const date = requireString(value, label, false, 10);
  requireLocalDate(date, label);
  if (!isWithinDateWindow(date)) throw new Error(`${label}: дата вне диапазона ${MIN_LOCAL_DATE}…${MAX_LOCAL_DATE}.`);
}

/** A sort order of a field added since the journal existed: an integer within ±{@link MAX_SORT_ORDER}. */
function requireOptionalSortOrder(value: unknown, label: string): void {
  if (value === undefined) return;
  requireOptionalSafeInteger(value, label);
  if (Math.abs(value as number) > MAX_SORT_ORDER) {
    throw new Error(`${label}: порядок вне диапазона ±${MAX_SORT_ORDER}.`);
  }
}

/** The shape of every identifier, by the domain's one rule — the same `isUuid` the journal codec reads. */
function requireUuid(value: string, label: string): void {
  if (!isUuid(value)) throw new Error(`${label}: некорректный UUID.`);
}

function validateBudgetStateUuids(state: BudgetState): void {
  requireUuid(state.activeBudgetId, "activeBudgetId");
  if (state.household !== undefined) requireUuid(state.household.id, "household.id");
  state.exchangeRates?.forEach((item, index) => requireUuid(item.id, `exchangeRates[${index}].id`));
  state.debts?.forEach((item, index) => requireUuid(item.id, `debts[${index}].id`));
  state.recurringRules?.forEach((rule, index) => {
    requireUuid(rule.id, `recurringRules[${index}].id`);
    // The references of a template are identifiers like any other, judged here like any other.
    for (const [field, id] of templateReferences(rule.template)) requireUuid(id, `recurringRules[${index}].template.${field}`);
    rule.template.tagIds?.forEach((tagId, tagIndex) => requireUuid(tagId, `recurringRules[${index}].template.tagIds[${tagIndex}]`));
  });
  state.members?.forEach((item, index) => requireUuid(item.id, `members[${index}].id`));
  state.tags?.forEach((item, index) => requireUuid(item.id, `tags[${index}].id`));
  state.accounts.forEach((item, index) => requireUuid(item.id, `accounts[${index}].id`));
  state.categories.forEach((item, index) => requireUuid(item.id, `categories[${index}].id`));
  state.budgets.forEach((budget, budgetIndex) => {
    requireUuid(budget.id, `budgets[${budgetIndex}].id`);
    budget.lines.forEach((line, lineIndex) => requireUuid(line.id, `budgets[${budgetIndex}].lines[${lineIndex}].id`));
  });
  state.goals.forEach((item, index) => requireUuid(item.id, `goals[${index}].id`));
  state.annualCommitments.forEach((item, index) => requireUuid(item.id, `annualCommitments[${index}].id`));
  state.scheduledExpenses.forEach((item, index) => requireUuid(item.id, `scheduledExpenses[${index}].id`));
  state.transactions.forEach((item, index) => {
    requireUuid(item.id, `transactions[${index}].id`);
    if (item.kind === "debt_out" || item.kind === "debt_in") requireUuid(item.debtId, `transactions[${index}].debtId`);
    // A malformed label is malformed data, judged like every other identifier here; an
    // identifier that is merely unknown is a different case, repaired by
    // clearUnknownMemberAttribution.
    if (item.memberId !== undefined) requireUuid(item.memberId, `transactions[${index}].memberId`);
    // The same for the other two labels: malformed is refused, merely unknown is repaired — by
    // clearUnresolvedLabels.
    item.tagIds?.forEach((tagId, tagIndex) => requireUuid(tagId, `transactions[${index}].tagIds[${tagIndex}]`));
    if (item.recurringRuleId !== undefined) {
      requireUuid(item.recurringRuleId, `transactions[${index}].recurringRuleId`);
    }
  });
}

function requireSafeMinor(value: number, label: string, allowNegative = false): void {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new Error(`${label}: некорректная сумма в minor units.`);
  }
}

function requireBaseShape(value: unknown, source: BudgetStateSource): asserts value is LegacyBudgetState {
  const state = requireRecord(value, "Бюджет");
  // A count is a refusal for a file only, for every collection; see BudgetStateSource.
  const grown = (limit: number): number => (source === "file" ? limit : Number.MAX_SAFE_INTEGER);
  requireString(state.activeBudgetId, "activeBudgetId", true, BACKUP_LIMITS.idLength);

  // Absent in every copy written before members existed, and such a copy stays valid.
  if (state.members !== undefined) {
    requireArray(state.members, "members", grown(BACKUP_LIMITS.members)).forEach((item, index) => {
      const member = requireRecord(item, `members[${index}]`);
      requireString(member.id, `members[${index}].id`, true, BACKUP_LIMITS.idLength);
      requireString(member.name, `members[${index}].name`, false, BACKUP_LIMITS.nameLength);
      requireEnum(member.role, ["owner", "member"], `members[${index}].role`);
      requireBoolean(member.active, `members[${index}].active`);
    });
  }

  // Absent in every copy written before tags existed, exactly like the participants above.
  if (state.tags !== undefined) {
    requireArray(state.tags, "tags", grown(BACKUP_LIMITS.tags)).forEach((item, index) => {
      const tag = requireRecord(item, `tags[${index}]`);
      requireString(tag.id, `tags[${index}].id`, true, BACKUP_LIMITS.idLength);
      const name = requireString(tag.name, `tags[${index}].name`, true, BACKUP_LIMITS.tagNameLength);
      // The stored-text rule, which asks the engine nothing: a name the input rule accepted on one
      // engine must keep restoring after a browser update (stored-text.ts in the domain).
      if (!isStorableLabel(name, TAG_NAME_MAX_LENGTH)) {
        throw new Error(`tags[${index}].name: название метки с лишними пробелами или служебными символами.`);
      }
      requireBoolean(tag.active, `tags[${index}].active`);
    });
  }

  // Absent in every copy written before it existed: such a copy is counted in roubles.
  if (state.household !== undefined) {
    const household = requireRecord(state.household, "household");
    requireString(household.id, "household.id", true, BACKUP_LIMITS.idLength);
    if (household.id !== HOUSEHOLD_ID) throw new Error("household.id: хозяйство записывается под выведенным идентификатором.");
    requireCurrency(household.baseCurrency, "household.baseCurrency");
  }

  // Absent in every copy written before rates existed, exactly like the participants above.
  if (state.exchangeRates !== undefined) {
    requireArray(state.exchangeRates, "exchangeRates", grown(BACKUP_LIMITS.exchangeRates)).forEach((item, index) => {
      const rate = requireRecord(item, `exchangeRates[${index}]`);
      requireString(rate.id, `exchangeRates[${index}].id`, true, BACKUP_LIMITS.idLength);
      const currency = requireCurrency(rate.currency, `exchangeRates[${index}].currency`);
      const base = requireCurrency(rate.baseCurrency, `exchangeRates[${index}].baseCurrency`);
      if (currency === base) throw new Error(`exchangeRates[${index}]: курс валюты к ней самой.`);
      requireWindowDate(rate.date, `exchangeRates[${index}].date`);
      requireRate(rate.rate, `exchangeRates[${index}].rate`);
    });
  }

  // Absent in every copy written before debts existed, exactly like the participants above.
  if (state.debts !== undefined) {
    requireArray(state.debts, "debts", grown(BACKUP_LIMITS.debts)).forEach((item, index) => {
      const debt = requireRecord(item, `debts[${index}]`);
      requireString(debt.id, `debts[${index}].id`, true, BACKUP_LIMITS.idLength);
      const counterparty = requireString(debt.counterparty, `debts[${index}].counterparty`, true, BACKUP_LIMITS.counterpartyLength);
      if (!isStorableLabel(counterparty, COUNTERPARTY_MAX_LENGTH)) {
        throw new Error(`debts[${index}].counterparty: имя с лишними пробелами или служебными символами.`);
      }
      requireEnum(debt.direction, ["i_owe", "owed_to_me"], `debts[${index}].direction`);
      requireCurrency(debt.currency, `debts[${index}].currency`);
      if (typeof debt.openingMinor !== "number" || !Number.isSafeInteger(debt.openingMinor) || debt.openingMinor < 0 || debt.openingMinor > MAX_MONEY_MINOR) {
        throw new Error(`debts[${index}].openingMinor: сумма от 0 до ${MAX_MONEY_MINOR} minor units.`);
      }
      if (debt.dueDate !== undefined) requireWindowDate(debt.dueDate, `debts[${index}].dueDate`);
      requireBoolean(debt.active, `debts[${index}].active`);
    });
  }

  // Absent in every copy written before recurring rules existed, exactly like the participants above.
  if (state.recurringRules !== undefined) {
    requireArray(state.recurringRules, "recurringRules", grown(BACKUP_LIMITS.recurringRules)).forEach((item, index) => {
      const label = `recurringRules[${index}]`;
      const rule = requireRecord(item, label);
      requireString(rule.id, `${label}.id`, true, BACKUP_LIMITS.idLength);
      if (rule.name !== undefined) {
        const name = requireString(rule.name, `${label}.name`, true, BACKUP_LIMITS.ruleNameLength);
        if (!isStorableLabel(name, RULE_NAME_MAX_LENGTH)) {
          throw new Error(`${label}.name: название с лишними пробелами или служебными символами.`);
        }
      }
      requireEnum(rule.frequency, ["daily", "weekly", "monthly", "yearly"], `${label}.frequency`);
      if (typeof rule.interval !== "number" || !Number.isSafeInteger(rule.interval) || rule.interval < 1 || rule.interval > MAX_RECURRENCE_INTERVAL) {
        throw new Error(`${label}.interval: целое число от 1 до ${MAX_RECURRENCE_INTERVAL}.`);
      }
      requireWindowDate(rule.startDate, `${label}.startDate`);
      if (rule.endDate !== undefined) {
        requireWindowDate(rule.endDate, `${label}.endDate`);
        if ((rule.endDate as string) < (rule.startDate as string)) throw new Error(`${label}.endDate: последняя дата раньше первой.`);
      }
      if (rule.materializedThrough !== undefined) requireWindowDate(rule.materializedThrough, `${label}.materializedThrough`);
      requireBoolean(rule.active, `${label}.active`);
      requireRecurringTemplate(rule.template, `${label}.template`);
    });
  }

  requireArray(state.accounts, "accounts", grown(BACKUP_LIMITS.accounts)).forEach((item, index) => {
    const account = requireRecord(item, `accounts[${index}]`);
    requireString(account.id, `accounts[${index}].id`, true, BACKUP_LIMITS.idLength);
    requireString(account.name, `accounts[${index}].name`, false, BACKUP_LIMITS.nameLength);
    requireEnum(account.type, ["current", "cash", "savings", "reserve"], `accounts[${index}].type`);
    requireCurrency(account.currency, `accounts[${index}].currency`);
    requireNumber(account.openingBalanceMinor, `accounts[${index}].openingBalanceMinor`);
    requireBoolean(account.active, `accounts[${index}].active`);
    // Display fields: absent in every copy written before them, read by no figure.
    requireOptionalSortOrder(account.sortOrder, `accounts[${index}].sortOrder`);
    requireOptionalDisplayKey(account.icon, `accounts[${index}].icon`);
    requireOptionalDisplayKey(account.color, `accounts[${index}].color`);
    requireOptionalBoolean(account.includeInTotal, `accounts[${index}].includeInTotal`);
  });

  requireArray(state.categories, "categories", grown(BACKUP_LIMITS.categories)).forEach((item, index) => {
    const category = requireRecord(item, `categories[${index}]`);
    requireString(category.id, `categories[${index}].id`, true, BACKUP_LIMITS.idLength);
    requireString(category.name, `categories[${index}].name`, false, BACKUP_LIMITS.nameLength);
    requireEnum(category.type, ["income", "expense"], `categories[${index}].type`);
    requireString(category.group, `categories[${index}].group`);
    requireBoolean(category.active, `categories[${index}].active`);
    requireNumber(category.sortOrder, `categories[${index}].sortOrder`);
    requireOptionalDisplayKey(category.icon, `categories[${index}].icon`);
    requireOptionalDisplayKey(category.color, `categories[${index}].color`);
  });

  let totalBudgetLines = 0;
  requireArray(state.budgets, "budgets", grown(BACKUP_LIMITS.budgets)).forEach((item, index) => {
    const budget = requireRecord(item, `budgets[${index}]`);
    requireString(budget.id, `budgets[${index}].id`, true, BACKUP_LIMITS.idLength);
    requireString(budget.startDate, `budgets[${index}].startDate`, false, 10);
    requireString(budget.endDate, `budgets[${index}].endDate`, false, 10);
    requireEnum(budget.status, ["draft", "open", "closed"], `budgets[${index}].status`);
    requireNumber(budget.plannedIncomeMinor, `budgets[${index}].plannedIncomeMinor`);
    requireNumber(budget.warningThreshold, `budgets[${index}].warningThreshold`);
    const lines = requireArray(budget.lines, `budgets[${index}].lines`, grown(BACKUP_LIMITS.linesPerBudget));
    totalBudgetLines += lines.length;
    if (totalBudgetLines > grown(BACKUP_LIMITS.totalBudgetLines)) {
      throw new Error(`budget lines: допускается не более ${BACKUP_LIMITS.totalBudgetLines} элементов суммарно.`);
    }
    lines.forEach((lineValue, lineIndex) => {
      const line = requireRecord(lineValue, `budgets[${index}].lines[${lineIndex}]`);
      requireString(line.id, `budgets[${index}].lines[${lineIndex}].id`, true, BACKUP_LIMITS.idLength);
      requireString(line.categoryId, `budgets[${index}].lines[${lineIndex}].categoryId`, true, BACKUP_LIMITS.idLength);
      requireNumber(line.plannedMinor, `budgets[${index}].lines[${lineIndex}].plannedMinor`);
      requireOptionalNumber(line.rolloverMinor, `budgets[${index}].lines[${lineIndex}].rolloverMinor`);
      requireOptionalNumber(line.adjustmentMinor, `budgets[${index}].lines[${lineIndex}].adjustmentMinor`);
      requireOptionalBoolean(line.active, `budgets[${index}].lines[${lineIndex}].active`);
    });
  });

  requireArray(state.goals, "goals", grown(BACKUP_LIMITS.goals)).forEach((item, index) => {
    const goal = requireRecord(item, `goals[${index}]`);
    requireString(goal.id, `goals[${index}].id`, true, BACKUP_LIMITS.idLength);
    requireString(goal.name, `goals[${index}].name`, false, BACKUP_LIMITS.nameLength);
    requireString(goal.linkedAccountId, `goals[${index}].linkedAccountId`, true, BACKUP_LIMITS.idLength);
    requireNumber(goal.targetMinor, `goals[${index}].targetMinor`);
    requireNumber(goal.openingContributedMinor, `goals[${index}].openingContributedMinor`);
    requireNumber(goal.plannedContributionMinor, `goals[${index}].plannedContributionMinor`);
    requireEnum(goal.status, ["active", "completed", "cancelled"], `goals[${index}].status`);
    if (goal.deadline !== undefined) requireWindowDate(goal.deadline, `goals[${index}].deadline`);
    requireOptionalDisplayKey(goal.icon, `goals[${index}].icon`);
  });

  requireArray(state.transactions, "transactions", grown(BACKUP_LIMITS.transactions)).forEach((item, index) => {
    const transaction = requireRecord(item, `transactions[${index}]`);
    requireString(transaction.id, `transactions[${index}].id`, true, BACKUP_LIMITS.idLength);
    requireString(transaction.occurredOn, `transactions[${index}].occurredOn`, false, 10);
    requireEnum(transaction.status, ["posted", "pending", "draft"], `transactions[${index}].status`);
    const kind = requireEnum(
      transaction.kind,
      ["income", "expense", "refund", "transfer", "goal_contribution", "debt_out", "debt_in"],
      `transactions[${index}].kind`,
    );
    requireNumber(transaction.amountMinor, `transactions[${index}].amountMinor`);
    if (transaction.memberId !== undefined) {
      requireString(transaction.memberId, `transactions[${index}].memberId`, true, BACKUP_LIMITS.idLength);
    }
    requireTransactionLabels(transaction, index);
    requireTransactionAmounts(transaction, kind, index);
    if (kind === "income" || kind === "expense" || kind === "refund" || kind === "debt_out" || kind === "debt_in") {
      requireString(transaction.accountId, `transactions[${index}].accountId`, true, BACKUP_LIMITS.idLength);
    }
    if (kind === "debt_out" || kind === "debt_in") {
      requireString(transaction.debtId, `transactions[${index}].debtId`, true, BACKUP_LIMITS.idLength);
    }
    if (kind === "expense" || kind === "refund") {
      requireString(transaction.categoryId, `transactions[${index}].categoryId`, true, BACKUP_LIMITS.idLength);
    }
    // Категория дохода необязательна, как и memberId: копия, написанная до того, как она у дохода
    // появилась, поля не несёт и остаётся годной навсегда. Если поле есть — оно строка-идентификатор.
    if (kind === "income" && transaction.categoryId !== undefined) {
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

  if (state.annualCommitments !== undefined) requireArray(state.annualCommitments, "annualCommitments", grown(BACKUP_LIMITS.annualCommitments));
  if (state.scheduledExpenses !== undefined) requireArray(state.scheduledExpenses, "scheduledExpenses", grown(BACKUP_LIMITS.scheduledExpenses));
}

/**
 * The note, the tags and the recurring rule of one operation, in the shape the domain stores them.
 *
 * A note the domain would refuse is refused here, naming the field: there is no repair for text,
 * because the gate cannot know which of two spellings the family meant. A list of tags is refused
 * when it is empty, too long or repeats a tag — malformed data, judged as such — while a tag that
 * is merely unknown is repaired later, by clearUnresolvedLabels.
 */
function requireTransactionLabels(transaction: Record<string, unknown>, index: number): void {
  if (transaction.note !== undefined) {
    const note = requireString(transaction.note, `transactions[${index}].note`, true, BACKUP_LIMITS.textLength);
    if (!isStorableNote(note)) {
      throw new Error(`transactions[${index}].note: заметка в несколько строк, с лишними пробелами или служебными символами.`);
    }
  }
  if (transaction.tagIds !== undefined) {
    const tagIds = requireArray(transaction.tagIds, `transactions[${index}].tagIds`, BACKUP_LIMITS.tagsPerTransaction);
    if (tagIds.length === 0) throw new Error(`transactions[${index}].tagIds: ожидался непустой список.`);
    const seen = new Set<string>();
    tagIds.forEach((tagId, tagIndex) => {
      const value = requireString(tagId, `transactions[${index}].tagIds[${tagIndex}]`, true, BACKUP_LIMITS.idLength);
      if (seen.has(value)) throw new Error(`transactions[${index}].tagIds: метка повторяется.`);
      seen.add(value);
    });
  }
  if (transaction.recurringRuleId !== undefined) {
    requireString(transaction.recurringRuleId, `transactions[${index}].recurringRuleId`, true, BACKUP_LIMITS.idLength);
  }
}

/** The fields a template of each kind carries: those of the operation it writes, without id and date. */
const TEMPLATE_FIELDS = {
  expense: ["kind", "amountMinor", "accountId", "categoryId", "note", "tagIds"],
  income: ["kind", "amountMinor", "accountId", "categoryId", "note", "tagIds"],
  transfer: ["kind", "amountMinor", "fromAccountId", "toAccountId", "toAmountMinor", "note", "tagIds"],
} as const;

/**
 * The template of a recurring rule, in the shape the domain stores it and the journal carries it:
 * one of three kinds and the fields of that kind, nothing else. Strict, as a rate is: a template is
 * nested data the journal reads by a closed list, and a field this build does not know would be
 * kept here and dropped on the way to every other device.
 */
function requireRecurringTemplate(value: unknown, label: string): void {
  const template = requireRecord(value, label);
  const kind = requireEnum(template.kind, ["expense", "income", "transfer"], `${label}.kind`);
  const allowed: readonly string[] = TEMPLATE_FIELDS[kind];
  for (const key of Object.keys(template)) {
    if (!allowed.includes(key)) throw new Error(`${label}: лишнее поле ${key.slice(0, 32)}.`);
  }
  requireFieldAmount(template.amountMinor, `${label}.amountMinor`);
  if (kind === "transfer") {
    const from = requireString(template.fromAccountId, `${label}.fromAccountId`, true, BACKUP_LIMITS.idLength);
    const to = requireString(template.toAccountId, `${label}.toAccountId`, true, BACKUP_LIMITS.idLength);
    if (from === to) throw new Error(`${label}: перевод со счёта на него же.`);
    if (template.toAmountMinor !== undefined) requireFieldAmount(template.toAmountMinor, `${label}.toAmountMinor`);
  } else {
    requireString(template.accountId, `${label}.accountId`, true, BACKUP_LIMITS.idLength);
    if (kind === "expense" || template.categoryId !== undefined) {
      requireString(template.categoryId, `${label}.categoryId`, true, BACKUP_LIMITS.idLength);
    }
  }
  if (template.note !== undefined) {
    const note = requireString(template.note, `${label}.note`, true, BACKUP_LIMITS.textLength);
    if (!isStorableNote(note)) throw new Error(`${label}.note: заметка в несколько строк, с лишними пробелами или служебными символами.`);
  }
  if (template.tagIds !== undefined) {
    const tagIds = requireArray(template.tagIds, `${label}.tagIds`, BACKUP_LIMITS.tagsPerTransaction);
    if (tagIds.length === 0) throw new Error(`${label}.tagIds: ожидался непустой список.`);
    const seen = new Set<string>();
    tagIds.forEach((tagId, tagIndex) => {
      const id = requireString(tagId, `${label}.tagIds[${tagIndex}]`, true, BACKUP_LIMITS.idLength);
      if (seen.has(id)) throw new Error(`${label}.tagIds: метка повторяется.`);
      seen.add(id);
    });
  }
}

/** The accounts and the category a template names, with the field that names each. */
function templateReferences(template: RecurringTemplate): readonly (readonly [string, string])[] {
  if (template.kind === "transfer") return [["fromAccountId", template.fromAccountId], ["toAccountId", template.toAccountId]];
  return [["accountId", template.accountId], ...(template.categoryId === undefined ? [] : [["categoryId", template.categoryId] as const])];
}

/**
 * Шаблоны регулярных операций: всё, что они называют, есть в копии и подходит по виду, а перевод
 * между валютами называет сумму зачисления — по тем же правилам, что и операция, которую правило
 * пишет.
 *
 * Метка шаблона, которой в копии нет, не ремонтируется, а отвергается: приложение такой копии не
 * пишет — домен не принимает правило с неизвестной меткой, — значит, файл собран не им, и угадывать,
 * чего хотел его автор, шлюз не берётся. Проверка стоит здесь, а не оставлена расчёту, чтобы отказ
 * называл правило файла.
 */
function validateRecurringRules(state: BudgetState): void {
  const accounts = new Map(state.accounts.map((account) => [account.id, account]));
  const categories = new Map(state.categories.map((category) => [category.id, category]));
  const tags = new Set((state.tags ?? []).map((tag) => tag.id));
  (state.recurringRules ?? []).forEach((rule, index) => {
    const label = `recurringRules[${index}].template`;
    const template = rule.template;
    for (const [field, id] of templateReferences(template)) {
      if (field === "categoryId") {
        const category = categories.get(id);
        if (!category) throw new Error(`${label}.categoryId: неизвестная категория ${id}.`);
        if (category.type !== template.kind) {
          throw new Error(`${label}.categoryId: категория должна быть ${template.kind === "income" ? "доходной" : "расходной"}.`);
        }
      } else if (!accounts.has(id)) {
        throw new Error(`${label}.${field}: неизвестный счёт ${id}.`);
      }
    }
    for (const tagId of template.tagIds ?? []) {
      if (!tags.has(tagId)) throw new Error(`${label}.tagIds: неизвестная метка ${tagId}.`);
    }
    if (template.kind === "transfer") {
      const from = accounts.get(template.fromAccountId)!.currency;
      const to = accounts.get(template.toAccountId)!.currency;
      if (from !== to && template.toAmountMinor === undefined) throw new Error(`${label}: перевод из ${from} в ${to} без суммы зачисления.`);
      if (from === to && template.toAmountMinor !== undefined) throw new Error(`${label}.toAmountMinor: перевод в одной валюте без отдельной суммы зачисления.`);
    }
  });
}

/** A currency of the domain's table; anything else is a currency this build cannot count. */
function requireCurrency(value: unknown, label: string): string {
  if (!isSupportedCurrency(value)) throw new Error(`${label}: недопустимое значение.`);
  return value;
}

/** A rate as the domain stores one: two integers from one minor unit to a trillion. */
function requireRate(value: unknown, label: string): void {
  const rate = requireRecord(value, label);
  for (const key of Object.keys(rate)) {
    if (key !== "baseMinor" && key !== "quoteMinor") throw new Error(`${label}: лишнее поле ${key.slice(0, 32)}.`);
  }
  if (!isExchangeRateValue(rate)) throw new Error(`${label}: части курса — целые числа от 1 до 10¹².`);
}

/** An amount of a field added since the journal existed: positive and at most a field's ceiling. */
function requireFieldAmount(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_MONEY_MINOR) {
    throw new Error(`${label}: сумма от 1 до ${MAX_MONEY_MINOR} minor units.`);
  }
}

/**
 * The amounts of an operation in another currency, in the shape the domain stores them: the
 * snapshot of an income, an expense or a refund — the three fields together or none of them — and
 * what arrived on the other side of a transfer. Whether the account needs them is decided with the
 * whole state in hand, by {@link validateCurrencies}.
 */
function requireTransactionAmounts(transaction: Record<string, unknown>, kind: string, index: number): void {
  const label = `transactions[${index}]`;
  const snapshot = ["baseAmountMinor", "baseCurrency", "rate"].filter((key) => transaction[key] !== undefined);
  if (snapshot.length > 0 && kind !== "income" && kind !== "expense" && kind !== "refund") {
    throw new Error(`${label}.${snapshot[0]}: у такой операции нет суммы в базовой валюте.`);
  }
  if (snapshot.length > 0 && snapshot.length < 3) {
    throw new Error(`${label}: сумма в базовой валюте записывается тремя полями — baseAmountMinor, baseCurrency и rate.`);
  }
  if (snapshot.length === 3) {
    requireFieldAmount(transaction.baseAmountMinor, `${label}.baseAmountMinor`);
    requireCurrency(transaction.baseCurrency, `${label}.baseCurrency`);
    requireRate(transaction.rate, `${label}.rate`);
  }
  if (transaction.toAmountMinor !== undefined) {
    if (kind !== "transfer") throw new Error(`${label}.toAmountMinor: сумма зачисления бывает только у перевода.`);
    requireFieldAmount(transaction.toAmountMinor, `${label}.toAmountMinor`);
  }
  if (transaction.debtAmountMinor !== undefined) {
    if (kind !== "debt_out" && kind !== "debt_in") throw new Error(`${label}.debtAmountMinor: сумма в валюте долга бывает только у операции по долгу.`);
    requireFieldAmount(transaction.debtAmountMinor, `${label}.debtAmountMinor`);
  }
}

/**
 * Операция модели, какой она стала вместе с журналом: движение по долгу, операция со снимком в
 * базовой валюте или с суммой зачисления, операция по счёту не в рублях — копия 1.0.0 таких не
 * несёт, потому что 1.0.0 знала только рубли. То же правило, что в домене.
 */
function isWaveOneOperation(transaction: Transaction, currencies: ReadonlyMap<string, string>): boolean {
  const foreign = (accountId: string): boolean => {
    const currency = currencies.get(accountId);
    return currency !== undefined && currency !== DEFAULT_BASE_CURRENCY;
  };
  switch (transaction.kind) {
    case "debt_out":
    case "debt_in":
      return true;
    case "income":
    case "expense":
    case "refund":
      return transaction.baseAmountMinor !== undefined || foreign(transaction.accountId);
    case "transfer":
      return transaction.toAmountMinor !== undefined || foreign(transaction.fromAccountId) || foreign(transaction.toAccountId);
    case "goal_contribution":
      return foreign(transaction.fromAccountId) || foreign(transaction.toAccountId);
  }
}

/**
 * Валюты операций: сумма в базовой валюте есть ровно у дохода, расхода и возврата по счёту в другой
 * валюте и равна сумме операции по её курсу, а сумма зачисления — ровно у перевода между счетами
 * разных валют. Операция модели волны 1 держит сумму и дату в пределах, которые несёт журнал.
 *
 * Проверка стоит здесь, а не оставлена расчёту, по той же причине, что и проверка категории дохода:
 * отказ восстановления обязан называть операцию файла, а не всплывать изнутри `calculateBudget`.
 * Пределы стоят здесь, а не только в кодеке журнала, потому что значение, которое приняла копия, а
 * отверг кодек, застревало на устройстве: первая же синхронизация бросала на каждой записи.
 */
function validateCurrencies(state: BudgetState): void {
  const base = baseCurrencyOf(state);
  const currencies = new Map(state.accounts.map((account) => [account.id, account.currency]));
  const debts = new Map((state.debts ?? []).map((debt) => [debt.id, debt]));
  state.transactions.forEach((transaction, index) => {
    if (isWaveOneOperation(transaction, currencies)) {
      requireFieldAmount(transaction.amountMinor, `transactions[${index}].amountMinor`);
      requireWindowDate(transaction.occurredOn, `transactions[${index}].occurredOn`);
    }
    // Долг — не метка: операция по долгу, которого в копии нет, не ремонтируется снятием, а
    // отвергается, потому что её деньгам не к чему относиться (D-033).
    if (transaction.kind === "debt_out" || transaction.kind === "debt_in") {
      const debt = debts.get(transaction.debtId);
      if (debt === undefined) throw new Error(`transactions[${index}].debtId: неизвестный долг ${transaction.debtId}.`);
      const currency = currencies.get(transaction.accountId);
      if (currency === undefined) return;
      if (currency !== debt.currency && transaction.debtAmountMinor === undefined) {
        throw new Error(`transactions[${index}]: операция по счёту в ${currency} и долгу в ${debt.currency} без суммы в валюте долга.`);
      }
      if (currency === debt.currency && transaction.debtAmountMinor !== undefined) {
        throw new Error(`transactions[${index}].debtAmountMinor: счёт и долг в одной валюте.`);
      }
      return;
    }
    if (transaction.kind === "income" || transaction.kind === "expense" || transaction.kind === "refund") {
      const currency = currencies.get(transaction.accountId);
      if (currency === undefined) return;
      if (currency === base && transaction.baseAmountMinor !== undefined) {
        throw new Error(`transactions[${index}]: операция в базовой валюте ${base} не несёт второй суммы в ней же.`);
      }
      if (currency !== base && transaction.baseAmountMinor === undefined) {
        throw new Error(`transactions[${index}]: операция по счёту в ${currency} без суммы в базовой валюте ${base}.`);
      }
      if (currency !== base && transaction.baseCurrency !== base) {
        throw new Error(`transactions[${index}].baseCurrency: сумма записана не в базовой валюте ${base}.`);
      }
      if (currency !== base && transaction.rate !== undefined) {
        let expected: number | null;
        try {
          expected = convertMinor(transaction.amountMinor, transaction.rate);
        } catch {
          expected = null;
        }
        if (expected !== transaction.baseAmountMinor) {
          throw new Error(`transactions[${index}].baseAmountMinor: сумма в базовой валюте не равна сумме операции по её курсу${expected === null ? "" : ` — ${expected}`}.`);
        }
      }
    }
    if (transaction.kind === "transfer") {
      const from = currencies.get(transaction.fromAccountId);
      const to = currencies.get(transaction.toAccountId);
      if (from === undefined || to === undefined) return;
      if (from !== to && transaction.toAmountMinor === undefined) {
        throw new Error(`transactions[${index}]: перевод из ${from} в ${to} без суммы зачисления.`);
      }
      if (from === to && transaction.toAmountMinor !== undefined) {
        throw new Error(`transactions[${index}].toAmountMinor: перевод в одной валюте без отдельной суммы зачисления.`);
      }
    }
  });
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

/**
 * Категория дохода: необязательная, но не произвольная.
 *
 * Домен принимает доход без категории и доход, отнесённый к категории доходного вида, и отвергает
 * всё, что между. Проверка стоит здесь, а не оставлена расчёту, по той же причине, по какой рядом
 * проверяются строки бюджета: отказ восстановления обязан называть поле файла, а не всплывать
 * изнутри `calculateBudget` строкой, которую человеку не с чем сопоставить.
 */
function validateIncomeCategories(state: BudgetState): void {
  const categories = new Map(state.categories.map((category) => [category.id, category]));
  state.transactions.forEach((transaction, index) => {
    if (transaction.kind !== "income" || transaction.categoryId === undefined) return;
    const category = categories.get(transaction.categoryId);
    if (!category) {
      throw new Error(`transactions[${index}].categoryId: неизвестная категория ${transaction.categoryId}.`);
    }
    if (category.type !== "income") {
      throw new Error(`transactions[${index}].categoryId: категория должна быть доходной.`);
    }
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
      if (line.active !== undefined && typeof line.active !== "boolean") {
        throw new Error(`budget line ${line.id}: active должен быть логическим значением.`);
      }
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

/**
 * Clears an attribution whose participant the copy does not carry, and says so out loud.
 *
 * The restored state has to be one the domain accepts, and `calculateMemberExpenses` refuses a
 * transaction whose `memberId` names nobody. The answer is the one the sync journal already
 * gives: rejecting the operation would quietly take every purchase attributed to a deleted
 * person out of the family's budget, so the operation stays to the kopeck and only the label
 * goes. Nothing else in the state is touched — no calculation reads a `memberId`, so no figure
 * moves because a label was dropped — and every clearing is reported, because nothing may
 * disappear from a restored copy in silence.
 */
function clearUnknownMemberAttribution(state: BudgetState, report?: BackupRepairReporter): BudgetState {
  const known = new Set((state.members ?? []).map((member) => member.id));
  let cleared = false;
  // Read first, copied only where there is something to clear: almost no transaction needs it.
  const transactions = state.transactions.map((transaction): Transaction => {
    const memberId = transaction.memberId;
    if (memberId === undefined || known.has(memberId)) return transaction;
    const { memberId: _unknown, ...unlabelled } = transaction;
    cleared = true;
    report?.({ kind: "unknown_member_attribution", transactionId: transaction.id, memberId });
    return unlabelled;
  });
  return cleared ? { ...state, transactions } : state;
}

/**
 * Takes off every tag the copy does not carry, and the recurring rule an operation names when the
 * copy has no such rule, and says so out loud — the same answer as for a participant, for the same
 * reason: the domain refuses a label that names nothing, and the operation it is on is the
 * family's money, which no label may cost.
 *
 * An operation left without tags loses the field rather than keeping an empty list, because there
 * is no empty list of tags. A rule label stays when the copy carries the rule: the occurrence is
 * still the occurrence of that rule.
 */
function clearUnresolvedLabels(state: BudgetState, report?: BackupRepairReporter): BudgetState {
  const known = new Set((state.tags ?? []).map((tag) => tag.id));
  const rules = new Set((state.recurringRules ?? []).map((rule) => rule.id));
  let cleared = false;
  // Read first, copied only where there is something to clear: almost no transaction needs it.
  const transactions = state.transactions.map((transaction): Transaction => {
    const unknownTags = (transaction.tagIds ?? []).filter((tagId) => !known.has(tagId));
    const ruleId = transaction.recurringRuleId !== undefined && !rules.has(transaction.recurringRuleId)
      ? transaction.recurringRuleId
      : undefined;
    if (unknownTags.length === 0 && ruleId === undefined) return transaction;
    cleared = true;
    let repaired: Transaction = transaction;
    if (unknownTags.length > 0) {
      const { tagIds, ...untagged } = repaired;
      const remaining = (tagIds ?? []).filter((tagId) => known.has(tagId));
      repaired = remaining.length === 0 ? untagged : { ...untagged, tagIds: remaining };
      for (const tagId of unknownTags) report?.({ kind: "unknown_tag", transactionId: transaction.id, tagId });
    }
    if (ruleId !== undefined) {
      const { recurringRuleId: _unknown, ...unlinked } = repaired;
      repaired = unlinked;
      report?.({ kind: "unknown_recurring_rule", transactionId: transaction.id, recurringRuleId: ruleId });
    }
    return repaired;
  });
  return cleared ? { ...state, transactions } : state;
}

/**
 * Structural validation followed by all domain calculations that enforce model invariants.
 *
 * Returns the state to store: identical to the input except for the labels cleared by
 * {@link clearUnknownMemberAttribution} and {@link clearUnresolvedLabels}, each of them passed
 * to `report`.
 */
export function prepareBudgetState(
  value: unknown,
  report?: BackupRepairReporter,
  source: BudgetStateSource = "document",
): BudgetState {
  requireBaseShape(value, source);
  const normalized = normalizeBudgetState(value);
  requirePlanningShape(normalized);
  validateBudgetStateUuids(normalized);
  const state = clearUnresolvedLabels(clearUnknownMemberAttribution(normalized, report), report);

  const activeBudget = state.budgets.find((budget) => budget.id === state.activeBudgetId);
  if (!activeBudget) throw new Error("activeBudgetId ссылается на неизвестный бюджет.");
  validateAllBudgets(state);
  validateIncomeCategories(state);
  validateCurrencies(state);
  validateRecurringRules(state);
  calculateBudget(state);
  calculateAnnualPlan(
    state,
    activeBudget.startDate.slice(0, 7),
    RENDERABLE_PLANNING_HORIZON_MONTHS,
  );
  // The split by participant is a calculation of its own, so it is the only place where a
  // member's own fields are enforced by the domain; a copy that would crash it never lands.
  calculateMemberExpenses(state);
  // The metrics of wave 1, each a calculation of its own, run on the last day of the active
  // budget: a copy that would crash the debts, the holdings or the split by tag never lands either.
  // None of them throws on a magnitude — a figure it cannot represent is null — so what refuses a
  // state here is a malformed state, never an amount that grows into the window next month. The
  // holdings reuse the debts rather than valuing every debt twice.
  const debts = calculateDebts(state, activeBudget.endDate);
  calculateHoldings(state, activeBudget.endDate, { debts });
  calculateTagExpenses(state);
  return state;
}

export function parseAndValidateBudgetBackup(text: string, report?: BackupRepairReporter): BudgetState {
  return new ValidatedBackupCodec((value: unknown) => prepareBudgetState(value, report, "file")).parse(text);
}

/** Сколько записей какого вида больше, чем принимает восстановление копии, — словами. */
export function restoreLimitExcess(state: BudgetState): readonly string[] {
  const lines = state.budgets.map((budget) => budget.lines.length);
  const counts: readonly (readonly [string, number, number])[] = [
    ["счетов", state.accounts.length, BACKUP_LIMITS.accounts],
    ["категорий", state.categories.length, BACKUP_LIMITS.categories],
    ["бюджетных периодов", state.budgets.length, BACKUP_LIMITS.budgets],
    ["строк в одном бюджете", Math.max(0, ...lines), BACKUP_LIMITS.linesPerBudget],
    ["строк во всех бюджетах", lines.reduce((total, count) => total + count, 0), BACKUP_LIMITS.totalBudgetLines],
    ["целей", state.goals.length, BACKUP_LIMITS.goals],
    ["крупных платежей", state.annualCommitments.length, BACKUP_LIMITS.annualCommitments],
    ["регулярных расходов", state.scheduledExpenses.length, BACKUP_LIMITS.scheduledExpenses],
    ["операций", state.transactions.length, BACKUP_LIMITS.transactions],
    ["участников", (state.members ?? []).length, BACKUP_LIMITS.members],
    ["меток", (state.tags ?? []).length, BACKUP_LIMITS.tags],
    ["курсов валют", (state.exchangeRates ?? []).length, BACKUP_LIMITS.exchangeRates],
    ["долгов", (state.debts ?? []).length, BACKUP_LIMITS.debts],
    ["регулярных операций", (state.recurringRules ?? []).length, BACKUP_LIMITS.recurringRules],
  ];
  return counts.filter(([, count, limit]) => count > limit).map(([label, count, limit]) => `${label} ${count} при пределе ${limit}`);
}

/**
 * Serializes first and records metadata only when the complete backup is valid.
 *
 * The file carries the state as {@link prepareBudgetState} returns it, so an attribution that
 * names nobody is written out cleared rather than baked into the copy.
 *
 * A state past a count limit is written all the same (`export`): refusing it would leave a family
 * whose devices merged past a limit without any copy of its data. The file is then read back by the
 * very path a restore takes, and when this build would refuse it — a file past a limit is refused,
 * because the limits bound the work an untrusted file makes the app do — the copy says so in
 * {@link PreparedBudgetBackup.restoreWarning}, naming every count over its limit.
 */
export async function createBudgetBackup(
  state: BudgetState,
  persistLastSuccessfulBackup: (createdAt: string) => Promise<void>,
  options: SerializeBackupOptions = {},
): Promise<PreparedBudgetBackup> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const text = new ValidatedBackupCodec((value: unknown) => prepareBudgetState(value, undefined, "export")).serialize(state, {
    ...options,
    createdAt,
  });
  let restoreWarning: string | null = null;
  try {
    parseAndValidateBudgetBackup(text);
  } catch {
    const excess = restoreLimitExcess(state);
    restoreWarning = `Восстановить эту копию эта версия приложения не сможет${excess.length > 0 ? `: ${excess.join(", ")}` : ""}. Пределы восстановления защищают приложение от чужого файла; эта копия восстановится, когда записей в бюджете станет не больше предела.`;
  }
  await persistLastSuccessfulBackup(createdAt);
  return { text, createdAt, restoreWarning };
}

export async function restoreBudgetBackup(
  file: BackupFile,
  save: (state: BudgetState) => Promise<void>,
  publish: (state: BudgetState) => void,
  report?: BackupRepairReporter,
): Promise<BudgetState> {
  if (file.size > MAX_BACKUP_FILE_BYTES) {
    throw new Error("Резервная копия больше допустимых 5 МБ.");
  }
  const next = parseAndValidateBudgetBackup(await file.text(), report);
  await save(next);
  publish(next);
  return next;
}
