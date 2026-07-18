export type StableId = string;
export type AccountId = StableId;
export type CategoryId = StableId;
export type BudgetId = StableId;
export type BudgetLineId = StableId;
export type GoalId = StableId;
export type TransactionId = StableId;
export type AnnualCommitmentId = StableId;
export type ScheduledExpenseId = StableId;

/** Money stored as an integer count of the currency's minor unit. */
export type MinorUnits = number;

/** Calendar date encoded as YYYY-MM-DD. */
export type LocalDate = string;

export type AccountType = "current" | "cash" | "savings" | "reserve";
export type CategoryType = "income" | "expense";
export type BudgetStatus = "draft" | "open" | "closed";
export type GoalStatus = "active" | "completed" | "cancelled";
export type ScheduleMode = "monthly" | "selected_months";
export type CommitmentRecurrence = "annual" | "one_time";
export type TransactionStatus = "posted" | "pending" | "draft";
export type TransactionKind =
  | "income"
  | "expense"
  | "refund"
  | "transfer"
  | "goal_contribution";

export interface Account {
  readonly id: AccountId;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly openingBalanceMinor: MinorUnits;
  readonly active: boolean;
}

export interface Category {
  readonly id: CategoryId;
  readonly name: string;
  readonly type: CategoryType;
  readonly group: string;
  readonly active: boolean;
  readonly sortOrder: number;
}

export interface BudgetLine {
  readonly id: BudgetLineId;
  readonly categoryId: CategoryId;
  readonly plannedMinor: MinorUnits;
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
}

export interface IncomeTransaction extends BaseTransaction {
  readonly kind: "income";
  readonly accountId: AccountId;
}

export interface ExpenseTransaction extends BaseTransaction {
  readonly kind: "expense";
  readonly accountId: AccountId;
  readonly categoryId: CategoryId;
}

export interface RefundTransaction extends BaseTransaction {
  readonly kind: "refund";
  readonly accountId: AccountId;
  readonly categoryId: CategoryId;
  readonly originalTransactionId?: TransactionId;
}

export interface TransferTransaction extends BaseTransaction {
  readonly kind: "transfer";
  readonly fromAccountId: AccountId;
  readonly toAccountId: AccountId;
}

export interface GoalContributionTransaction extends BaseTransaction {
  readonly kind: "goal_contribution";
  readonly fromAccountId: AccountId;
  readonly toAccountId: AccountId;
  readonly goalId: GoalId;
}

export type Transaction =
  | IncomeTransaction
  | ExpenseTransaction
  | RefundTransaction
  | TransferTransaction
  | GoalContributionTransaction;

export interface BudgetState {
  readonly activeBudgetId: BudgetId;
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
