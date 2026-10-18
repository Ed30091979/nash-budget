export type StableId = string;
export type AccountId = StableId;
export type CategoryId = StableId;
export type BudgetId = StableId;
export type BudgetLineId = StableId;
export type GoalId = StableId;
export type TransactionId = StableId;
export type AnnualCommitmentId = StableId;
export type ScheduledExpenseId = StableId;
export type MemberId = StableId;
export type TagId = StableId;
export type RecurringRuleId = StableId;
export type ExchangeRateId = StableId;
export type DebtId = StableId;
export type HouseholdId = StableId;
/** An ISO 4217 code, and only one of `SUPPORTED_CURRENCIES` in `currency.ts`. */
export type CurrencyCode = string;

/**
 * Key of a design token the interface draws an entity with: kebab-case, at most 40 characters,
 * such as `shopping-basket` or `sage`. Never a hex colour and never a file name, so the journal
 * carries a choice from the design system and not an arbitrary style or picture.
 */
export type DisplayKey = string;

/** Money stored as an integer count of the currency's minor unit. */
export type MinorUnits = number;

/** Calendar date encoded as YYYY-MM-DD. */
export type LocalDate = string;

export type AccountType = "current" | "cash" | "savings" | "reserve";
export type CategoryType = "income" | "expense";

/**
 * Closed set of category groups. Four groups hold expenses and one holds income; the display
 * order is fixed by {@link CATEGORY_GROUPS} rather than by the order of this union.
 */
export type ExpenseCategoryGroup = "mandatory" | "everyday" | "personal" | "other";
export type IncomeCategoryGroup = "income";
export type CategoryGroup = ExpenseCategoryGroup | IncomeCategoryGroup;

/**
 * What a stored category actually carries in its `group`. Every category written from now on
 * holds one of the {@link CategoryGroup} keys, but a document written before the closed set
 * existed carries a free-form label such as "Повседневные" and must keep opening without a
 * single edit. Read it through `resolveCategoryGroup`, never by comparing raw strings.
 */
export type StoredCategoryGroup = CategoryGroup | (string & {});
export type BudgetStatus = "draft" | "open" | "closed";
export type GoalStatus = "active" | "completed" | "cancelled";
export type ScheduleMode = "monthly" | "selected_months";
export type CommitmentRecurrence = "annual" | "one_time";
export type TransactionStatus = "posted" | "pending" | "draft";
/**
 * Advisory label, never a permission. The domain runs offline and grants nothing on the
 * strength of a role; the sync server is the only place where access is decided.
 */
export type MemberRole = "owner" | "member";

export type TransactionKind =
  | "income"
  | "expense"
  | "refund"
  | "transfer"
  | "goal_contribution"
  | "debt_out"
  | "debt_in";

/**
 * A family participant. Attribution only: nothing in the money calculations reads a member,
 * so adding, renaming or archiving one never moves a single kopeck.
 */
export interface Member {
  readonly id: MemberId;
  readonly name: string;
  readonly role: MemberRole;
  readonly active: boolean;
}

export interface Account {
  readonly id: AccountId;
  readonly name: string;
  readonly type: AccountType;
  /** Every amount on the account is a count of this currency's minor unit. */
  readonly currency: CurrencyCode;
  readonly openingBalanceMinor: MinorUnits;
  readonly active: boolean;
  // Display fields. Each is optional on purpose, exactly like `BaseTransaction.memberId`: every
  // account written before they existed omits them and stays valid without a single edit. No
  // figure in BudgetMetrics or AnnualPlanMetrics reads any of them.
  /** Position in the list of accounts; a safe integer. */
  readonly sortOrder?: number;
  readonly icon?: DisplayKey;
  readonly color?: DisplayKey;
  /**
   * Whether the account counts towards the total of everything the household holds. Absent
   * means it does. Only that total reads it: `capitalMinor` never does.
   */
  readonly includeInTotal?: boolean;
}

export interface Category {
  readonly id: CategoryId;
  readonly name: string;
  readonly type: CategoryType;
  /** One of the {@link CategoryGroup} keys; legacy documents carry a free-form label. */
  readonly group: StoredCategoryGroup;
  readonly active: boolean;
  readonly sortOrder: number;
  /** Display fields, optional for the same reason as on {@link Account}. Read by no figure. */
  readonly icon?: DisplayKey;
  readonly color?: DisplayKey;
}

/** One entry of a category catalogue: everything a category needs except its identity. */
export interface CategoryTemplate {
  readonly name: string;
  readonly type: CategoryType;
  readonly group: CategoryGroup;
}

/** Display metadata for one group of the closed set. */
export interface CategoryGroupDefinition {
  readonly key: CategoryGroup;
  readonly title: string;
  readonly type: CategoryType;
  /** Ascending display order across the whole set, expenses first. */
  readonly order: number;
}

export interface BudgetLine {
  readonly id: BudgetLineId;
  readonly categoryId: CategoryId;
  readonly plannedMinor: MinorUnits;
  /** Soft-archive flag. Omitted by legacy data and treated as active. */
  readonly active?: boolean;
  readonly rolloverMinor?: MinorUnits;
  readonly adjustmentMinor?: MinorUnits;
}

export interface Budget {
  readonly id: BudgetId;
  readonly startDate: LocalDate;
  readonly endDate: LocalDate;
  readonly status: BudgetStatus;
  readonly plannedIncomeMinor: MinorUnits;
  /** Ratio from 0 (inclusive) to 1 (exclusive); 0.8 means 80%. */
  readonly warningThreshold: number;
  readonly lines: readonly BudgetLine[];
}

export interface Goal {
  readonly id: GoalId;
  readonly name: string;
  readonly linkedAccountId: AccountId;
  readonly targetMinor: MinorUnits;
  readonly openingContributedMinor: MinorUnits;
  readonly plannedContributionMinor: MinorUnits;
  readonly status: GoalStatus;
  /** The date the family means to reach the goal by. Optional, and read by no figure. */
  readonly deadline?: LocalDate;
  readonly icon?: DisplayKey;
}

/**
 * A label a family puts on operations: «Отпуск», «Дача», «Ремонт». Attribution only, like a
 * {@link Member}: nothing in the money calculations reads a tag, so creating, renaming,
 * archiving or deleting one never moves a single kopeck. An archived tag stays on the
 * operations that carry it and is merely no longer offered for new ones.
 */
export interface Tag {
  readonly id: TagId;
  readonly name: string;
  readonly active: boolean;
}

/** Who owes whom: the family owes the counterparty, or the counterparty owes the family. */
export type DebtDirection = "i_owe" | "owed_to_me";

/**
 * Money lent or borrowed: «Петя должен мне», «я должен Сергею».
 *
 * A debt is a balance of its own, outside the budget: lending is not an expense and borrowing is not
 * an income (rule 4 of `contracts/README.md`), so no figure of `BudgetMetrics` reads a debt. What a
 * debt is worth is a metric of its own, `calculateDebts`. The direction gives the operations on the
 * debt their meaning, so it does not change once operations are written against it.
 */
export interface Debt {
  readonly id: DebtId;
  /** Who the debt is with, as the family calls them: a label, at most 80 characters. */
  readonly counterparty: string;
  readonly direction: DebtDirection;
  /** The debt is counted in this currency; any supported one, the base or not. */
  readonly currency: CurrencyCode;
  /** What was owed when the debt was entered, before any operation, in the debt's currency; ≥ 0. */
  readonly openingMinor: MinorUnits;
  /** When it is due. Optional; a debt past it with something still owed is overdue. */
  readonly dueDate?: LocalDate;
  /** An archived debt is no longer offered for new operations and still counts in every total. */
  readonly active: boolean;
}

/**
 * The household itself: for now, the one currency every budget, category and plan is counted in.
 *
 * An entity rather than a setting, because the journal replicates entities and only entities, and
 * its identifier is derived — always `HOUSEHOLD_ID` — so two devices that name the base currency
 * independently write one and the same record. A state without one is counted in roubles, which is
 * what every state written before it existed is.
 */
export interface Household {
  readonly id: HouseholdId;
  readonly baseCurrency: CurrencyCode;
}

/**
 * A rate as two integers: `quoteMinor` minor units of the quoted currency are worth `baseMinor`
 * minor units of the base one. Integers on both sides, so a conversion is exact arithmetic followed
 * by one rounding, and never a binary fraction.
 */
export interface ExchangeRateValue {
  readonly baseMinor: MinorUnits;
  readonly quoteMinor: MinorUnits;
}

/**
 * What one unit of `currency` was worth in `baseCurrency` on `date`.
 *
 * Read only by valuations that are meant to move with the rate — the holdings of a later step —
 * and by whoever writes a snapshot. No budget figure reads it: an operation carries its own value in
 * the base currency, so a new rate never revalues the past.
 */
export interface ExchangeRate {
  readonly id: ExchangeRateId;
  /** The quoted currency; never the base one. */
  readonly currency: CurrencyCode;
  readonly baseCurrency: CurrencyCode;
  readonly date: LocalDate;
  readonly rate: ExchangeRateValue;
}

/** A large predictable payment with one next due date and a reserve built in advance. */
export interface AnnualCommitment {
  readonly id: AnnualCommitmentId;
  readonly name: string;
  readonly categoryId: CategoryId;
  readonly accountId: AccountId;
  readonly dueDate: LocalDate;
  readonly amountMinor: MinorUnits;
  readonly reservedMinor: MinorUnits;
  readonly recurrence: CommitmentRecurrence;
  readonly active: boolean;
}

/** A fixed payment that repeats every month or only in selected calendar months. */
export interface ScheduledExpense {
  readonly id: ScheduledExpenseId;
  readonly name: string;
  readonly categoryId: CategoryId;
  readonly accountId: AccountId;
  readonly amountMinor: MinorUnits;
  readonly dueDay: number;
  readonly mode: ScheduleMode;
  /** Calendar month numbers from 1 through 12. Required for selected_months. */
  readonly months?: readonly number[];
  readonly active: boolean;
}

interface BaseTransaction {
  readonly id: TransactionId;
  readonly occurredOn: LocalDate;
  readonly status: TransactionStatus;
  readonly amountMinor: MinorUnits;
  /**
   * Family participant credited with the operation. Optional on purpose: every backup and
   * every budget written before members existed omits it, and such data stays valid. Read
   * only by {@link MemberExpenseBreakdown}; the budget and planning figures ignore it.
   */
  readonly memberId?: MemberId;
  /**
   * A one-line note, at most 500 characters, normalised by `normalizeNote`. There is no empty
   * note: an operation without one omits the field.
   */
  readonly note?: string;
  /**
   * Tags on the operation: from one to ten, no repeats, each naming a tag of
   * {@link BudgetState.tags}, archived ones included. There is no empty list: an operation
   * without tags omits the field. Labels, read by no figure in {@link BudgetMetrics}.
   */
  readonly tagIds?: readonly TagId[];
  /**
   * The recurring rule this operation is an occurrence of. A label read by no figure. No rule can
   * exist in this version of the model yet, so every value names nothing and is refused.
   */
  readonly recurringRuleId?: RecurringRuleId;
}

/**
 * The value of an operation in the base currency, fixed when it was written.
 *
 * Carried only by an operation on an account in another currency, and then all three fields
 * together: the budget, the categories and the plan add up `baseAmountMinor` and never read a rate
 * table, so the rouble figure of a dollar purchase is the one the family saw that day. An operation
 * in the base currency carries none of them — its amount already is the figure.
 */
interface BaseAmountSnapshot {
  readonly baseAmountMinor?: MinorUnits;
  readonly baseCurrency?: CurrencyCode;
  readonly rate?: ExchangeRateValue;
}

export interface IncomeTransaction extends BaseTransaction, BaseAmountSnapshot {
  readonly kind: "income";
  readonly accountId: AccountId;
  /**
   * Income category. Optional on purpose, exactly like {@link BaseTransaction.memberId}: every
   * backup written before income had categories omits it and stays valid without a single edit.
   * When present it must name an active-or-archived category of type `income`. No figure in
   * {@link BudgetMetrics} or {@link AnnualPlanMetrics} reads it: it labels income, it does not
   * move it.
   */
  readonly categoryId?: CategoryId;
}

export interface ExpenseTransaction extends BaseTransaction, BaseAmountSnapshot {
  readonly kind: "expense";
  readonly accountId: AccountId;
  readonly categoryId: CategoryId;
}

export interface RefundTransaction extends BaseTransaction, BaseAmountSnapshot {
  readonly kind: "refund";
  readonly accountId: AccountId;
  readonly categoryId: CategoryId;
  readonly originalTransactionId: TransactionId;
}

export interface TransferTransaction extends BaseTransaction {
  readonly kind: "transfer";
  readonly fromAccountId: AccountId;
  readonly toAccountId: AccountId;
  /**
   * What arrived, in the currency of `toAccountId`; `amountMinor` is what left, in the currency of
   * `fromAccountId`. Present exactly when the two accounts are in different currencies: within one
   * currency the two amounts are one amount, and two fields for it could disagree.
   */
  readonly toAmountMinor?: MinorUnits;
}

export interface GoalContributionTransaction extends BaseTransaction {
  readonly kind: "goal_contribution";
  readonly fromAccountId: AccountId;
  readonly toAccountId: AccountId;
  readonly goalId: GoalId;
}

/**
 * Money that moved between an account and a debt: not an income and not an expense (rule 4 of
 * `contracts/README.md`). Two kinds and not four: which way the money went is the kind, and what it
 * means — lent or repaid, borrowed or paid back — is the debt's direction, so a debt whose direction
 * changed in flight cannot leave an operation that says the opposite.
 */
interface DebtMovement extends BaseTransaction {
  readonly accountId: AccountId;
  readonly debtId: DebtId;
  /**
   * The amount in the debt's currency; `amountMinor` is the account's. Present exactly when the two
   * currencies differ — within one currency the two amounts are one amount.
   */
  readonly debtAmountMinor?: MinorUnits;
}

/** Money left the account: «дал в долг» on a debt owed to the family, «вернул долг» on one it owes. */
export interface DebtOutTransaction extends DebtMovement {
  readonly kind: "debt_out";
}

/** Money came to the account: «взял в долг» on a debt the family owes, «мне вернули» on one owed to it. */
export interface DebtInTransaction extends DebtMovement {
  readonly kind: "debt_in";
}

export type Transaction =
  | IncomeTransaction
  | ExpenseTransaction
  | RefundTransaction
  | TransferTransaction
  | GoalContributionTransaction
  | DebtOutTransaction
  | DebtInTransaction;

export interface BudgetState {
  readonly activeBudgetId: BudgetId;
  /** Absent in every budget written before members existed; such a state stays valid. */
  readonly members?: readonly Member[];
  /** Absent in every budget written before tags existed, exactly like `members`. */
  readonly tags?: readonly Tag[];
  /** Absent in every budget written before it existed; such a state is counted in roubles. */
  readonly household?: Household;
  /** Absent in every budget written before rates existed, exactly like `members`. */
  readonly exchangeRates?: readonly ExchangeRate[];
  /** Absent in every budget written before debts existed, exactly like `members`. */
  readonly debts?: readonly Debt[];
  readonly accounts: readonly Account[];
  readonly categories: readonly Category[];
  readonly budgets: readonly Budget[];
  readonly goals: readonly Goal[];
  readonly annualCommitments: readonly AnnualCommitment[];
  readonly scheduledExpenses: readonly ScheduledExpense[];
  readonly transactions: readonly Transaction[];
}

export type CategoryBudgetStatus =
  | "no_plan"
  | "normal"
  | "near_limit"
  | "exhausted"
  | "over_limit";

export interface CategoryMetrics {
  readonly categoryId: CategoryId;
  readonly availableMinor: MinorUnits;
  readonly expenseMinor: MinorUnits;
  readonly refundMinor: MinorUnits;
  readonly actualMinor: MinorUnits;
  readonly remainingMinor: MinorUnits;
  readonly overMinor: MinorUnits;
  readonly execution: number | null;
  readonly status: CategoryBudgetStatus;
}

export interface BudgetMetrics {
  readonly budgetId: BudgetId;
  readonly incomeMinor: MinorUnits;
  readonly grossExpensesMinor: MinorUnits;
  readonly refundsMinor: MinorUnits;
  readonly expensesMinor: MinorUnits;
  readonly plannedExpenseMinor: MinorUnits;
  readonly goalContributionMinor: MinorUnits;
  readonly capitalMinor: MinorUnits;
  readonly aggregateExecution: number | null;
  readonly accountBalancesMinor: Readonly<Record<AccountId, MinorUnits>>;
  readonly goalContributionsMinor: Readonly<Record<GoalId, MinorUnits>>;
  readonly categoryMetrics: Readonly<Record<CategoryId, CategoryMetrics>>;
}

/** Net expense figures for one slice of a budget: a member, or everything left unattributed. */
export interface ExpenseShareMetrics {
  readonly expenseMinor: MinorUnits;
  readonly refundMinor: MinorUnits;
  /** expenseMinor minus refundMinor; an excess refund keeps it negative, as elsewhere. */
  readonly actualMinor: MinorUnits;
  /** Posted expenses and refunds counted in this slice. */
  readonly transactionCount: number;
  /** actualMinor over the budget's net expenses; null when those are zero or negative. */
  readonly share: number | null;
}

export interface MemberExpenseMetrics extends ExpenseShareMetrics {
  readonly memberId: MemberId;
}

/**
 * Expenses split by participant. A standalone metric: {@link BudgetMetrics} is computed
 * without it and does not change by a kopeck when members appear, disappear or are renamed.
 */
export interface MemberExpenseBreakdown {
  readonly budgetId: BudgetId;
  /** Identical to BudgetMetrics.expensesMinor for the same budget. */
  readonly expensesMinor: MinorUnits;
  /** Sum of the members' actualMinor; the remainder is unattributed. */
  readonly attributedMinor: MinorUnits;
  /** Declaration order of state.members, so the caller decides how to sort. */
  readonly members: readonly MemberExpenseMetrics[];
  readonly byMember: Readonly<Record<MemberId, MemberExpenseMetrics>>;
  /** Everything posted without a memberId, including every pre-member operation. */
  readonly unattributed: ExpenseShareMetrics;
}

/** One debt as it stands on a day. */
export interface DebtBalanceMetrics {
  readonly debtId: DebtId;
  readonly direction: DebtDirection;
  readonly currency: CurrencyCode;
  /** Posted money that left an account for this debt up to the day, in the debt's currency. */
  readonly outMinor: MinorUnits;
  /** Posted money that came to an account from this debt up to the day, in the debt's currency. */
  readonly inMinor: MinorUnits;
  /** owed_to_me: opening + out − in; i_owe: opening + in − out. Below zero is an overpayment. */
  readonly balanceMinor: MinorUnits;
  /** The balance in the base currency at the latest rate on or before the day; null without one. */
  readonly balanceInBaseMinor: MinorUnits | null;
  /** Past its due date with something still owed. */
  readonly overdue: boolean;
}

/**
 * Every debt of the household on a day, archived ones included. A standalone metric, like the split
 * by participant: no figure of {@link BudgetMetrics} reads a debt.
 */
export interface DebtMetrics {
  readonly asOf: LocalDate;
  readonly baseCurrency: CurrencyCode;
  /** Declaration order of state.debts. */
  readonly debts: readonly DebtBalanceMetrics[];
  readonly byDebt: Readonly<Record<DebtId, DebtBalanceMetrics>>;
  /** What others owe the family, in the base currency: the valued owed_to_me balances, summed. */
  readonly receivableInBaseMinor: MinorUnits;
  /** What the family owes others, in the base currency: the valued i_owe balances, summed. */
  readonly payableInBaseMinor: MinorUnits;
  /** receivable − payable. */
  readonly netInBaseMinor: MinorUnits;
  /** Debts whose balance could not be valued in the base currency: no rate, or too large a sum. */
  readonly unvaluedDebtIds: readonly DebtId[];
}

export type AnnualCommitmentStatus = "funded" | "on_track" | "due_soon" | "overdue";

export interface AnnualCommitmentMetrics {
  readonly commitmentId: AnnualCommitmentId;
  readonly monthsUntilDue: number;
  readonly remainingToReserveMinor: MinorUnits;
  readonly monthlyReserveMinor: MinorUnits;
  readonly status: AnnualCommitmentStatus;
}

export interface PlanningMonthMetrics {
  /** Calendar month encoded as YYYY-MM. */
  readonly month: string;
  readonly plannedIncomeMinor: MinorUnits;
  readonly scheduledExpenseMinor: MinorUnits;
  /** Portion of scheduledExpenseMinor enabled only in selected calendar months. */
  readonly seasonalExpenseMinor: MinorUnits;
  readonly flexiblePlanMinor: MinorUnits;
  readonly annualReserveMinor: MinorUnits;
  readonly annualDueMinor: MinorUnits;
  readonly goalPlanMinor: MinorUnits;
  readonly spendableAfterPlanMinor: MinorUnits;
}

export interface AnnualPlanMetrics {
  readonly startMonth: string;
  readonly months: readonly PlanningMonthMetrics[];
  readonly commitments: Readonly<Record<AnnualCommitmentId, AnnualCommitmentMetrics>>;
  readonly currentMonth: PlanningMonthMetrics;
  readonly upcomingCommitmentIds: readonly AnnualCommitmentId[];
}

export interface FormatMinorOptions {
  readonly currency?: string;
  readonly locale?: string;
  readonly exponent?: number;
}
