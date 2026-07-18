import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import budgetFixtureSchema from "../../../contracts/schemas/budget-fixture.schema.json";
import planningFixtureSchema from "../../../contracts/schemas/planning-fixture.schema.json";
import g000Json from "../../../contracts/fixtures/g-000.json";
import g001Json from "../../../contracts/fixtures/g-001.json";
import g002Json from "../../../contracts/fixtures/g-002.json";

type StableId = string;
type MinorUnits = number;
type TransactionStatus = "posted" | "pending" | "draft";

export type DomainTransaction =
  | { readonly id: StableId; readonly occurredOn: string; readonly status: TransactionStatus; readonly kind: "income"; readonly amountMinor: MinorUnits; readonly accountId: StableId }
  | { readonly id: StableId; readonly occurredOn: string; readonly status: TransactionStatus; readonly kind: "expense"; readonly amountMinor: MinorUnits; readonly accountId: StableId; readonly categoryId: StableId }
  | { readonly id: StableId; readonly occurredOn: string; readonly status: TransactionStatus; readonly kind: "refund"; readonly amountMinor: MinorUnits; readonly accountId: StableId; readonly categoryId: StableId; readonly originalTransactionId: StableId }
  | { readonly id: StableId; readonly occurredOn: string; readonly status: TransactionStatus; readonly kind: "transfer"; readonly amountMinor: MinorUnits; readonly fromAccountId: StableId; readonly toAccountId: StableId }
  | { readonly id: StableId; readonly occurredOn: string; readonly status: TransactionStatus; readonly kind: "goal_contribution"; readonly amountMinor: MinorUnits; readonly fromAccountId: StableId; readonly toAccountId: StableId; readonly goalId: StableId };

export interface DomainBudgetState {
  readonly activeBudgetId: StableId;
  readonly accounts: readonly { readonly id: StableId; readonly name: string; readonly type: "current" | "cash" | "savings" | "reserve"; readonly currency: string; readonly openingBalanceMinor: MinorUnits; readonly active: boolean }[];
  readonly categories: readonly { readonly id: StableId; readonly name: string; readonly type: "income" | "expense"; readonly group: string; readonly active: boolean; readonly sortOrder: number }[];
  readonly budgets: readonly { readonly id: StableId; readonly startDate: string; readonly endDate: string; readonly status: "draft" | "open" | "closed"; readonly plannedIncomeMinor: MinorUnits; readonly warningThreshold: number; readonly lines: readonly { readonly id: StableId; readonly categoryId: StableId; readonly plannedMinor: MinorUnits; readonly rolloverMinor?: MinorUnits; readonly adjustmentMinor?: MinorUnits }[] }[];
  readonly goals: readonly { readonly id: StableId; readonly name: string; readonly linkedAccountId: StableId; readonly targetMinor: MinorUnits; readonly openingContributedMinor: MinorUnits; readonly plannedContributionMinor: MinorUnits; readonly status: "active" | "completed" | "cancelled" }[];
  readonly annualCommitments: readonly { readonly id: StableId; readonly name: string; readonly categoryId: StableId; readonly accountId: StableId; readonly dueDate: string; readonly amountMinor: MinorUnits; readonly reservedMinor: MinorUnits; readonly recurrence: "annual" | "one_time"; readonly active: boolean }[];
  readonly scheduledExpenses: readonly { readonly id: StableId; readonly name: string; readonly categoryId: StableId; readonly accountId: StableId; readonly amountMinor: MinorUnits; readonly dueDay: number; readonly mode: "monthly" | "selected_months"; readonly months?: readonly number[]; readonly active: boolean }[];
  readonly transactions: readonly DomainTransaction[];
}

interface CanonicalBudgetFixture {
  readonly schemaVersion: "1.0.0";
  readonly fixtureId: "G-000" | "G-001";
  readonly title: string;
  readonly household: { readonly id: string; readonly baseCurrency: string };
  readonly members: readonly { readonly id: string; readonly householdId: string }[];
  readonly accounts: readonly { readonly id: string; readonly householdId: string; readonly name: string; readonly type: string; readonly currency: string; readonly openingBalanceMinor: number; readonly active: boolean; readonly isPrimary: boolean }[];
  readonly categories: readonly { readonly id: string; readonly householdId: string; readonly parentId: string | null; readonly name: string; readonly type: "income" | "expense"; readonly group: string; readonly active: boolean; readonly sortOrder: number }[];
  readonly budgetPeriod: { readonly id: string; readonly householdId: string; readonly startDate: string; readonly endDate: string; readonly status: "draft" | "open" | "closed" };
  readonly budgetPlan: { readonly plannedIncomeMinor: number; readonly lines: readonly { readonly id: string; readonly periodId: string; readonly categoryId: string; readonly plannedMinor: number; readonly rolloverMinor: number; readonly adjustmentMinor: number; readonly warnPercent: number }[] };
  readonly goals: readonly { readonly id: string; readonly householdId: string; readonly name: string; readonly linkedAccountId: string; readonly targetMinor: number; readonly plannedContributionMinor: number; readonly status: "active" | "completed" | "cancelled" }[];
  readonly transactions: readonly CanonicalTransaction[];
  readonly expected: {
    readonly incomeMinor: number;
    readonly expenseMinor: number;
    readonly netWorthMinor: number;
    readonly accountBalances: readonly { readonly accountId: string; readonly balanceMinor: number }[];
    readonly categoryMetrics: readonly { readonly categoryId: string; readonly actualExpenseMinor: number; readonly usageBasisPoints: number | null; readonly remainingMinor: number; readonly overLimitMinor: number; readonly status: string }[];
  };
}

interface CanonicalTransaction {
  readonly id: string;
  readonly householdId: string;
  readonly memberId: string;
  readonly kind: "income" | "expense" | "transfer" | "refund" | "goal_contribution";
  readonly amountMinor: number;
  readonly occurredOn: string;
  readonly status: "draft" | "pending" | "posted" | "voided";
  readonly optionalGoalId: string | null;
  readonly originalTransactionId: string | null;
  readonly movements: readonly { readonly id: string; readonly accountId: string; readonly signedAmountMinor: number; readonly role: "source" | "destination" }[];
  readonly splits: readonly { readonly id: string; readonly categoryId: string; readonly amountMinor: number }[];
}

export interface PlanningFixture {
  readonly schemaVersion: "1.0.0";
  readonly fixtureId: "G-002";
  readonly title: string;
  readonly startMonth: string;
  readonly horizonMonths: 24;
  readonly minorUnit: { readonly currency: "RUB"; readonly exponent: 2 };
  readonly state: DomainBudgetState;
  readonly expected: {
    readonly firstTwelveMonthsEqual: true;
    readonly months: readonly { readonly month: string; readonly plannedIncomeMinor: number; readonly scheduledExpenseMinor: number; readonly seasonalExpenseMinor: number; readonly flexiblePlanMinor: number; readonly annualReserveMinor: number; readonly annualDueMinor: number; readonly goalPlanMinor: number; readonly spendableAfterPlanMinor: number }[];
    readonly commitments: readonly { readonly commitmentId: string; readonly monthsUntilDue: number; readonly remainingToReserveMinor: number; readonly monthlyReserveMinor: number; readonly status: "funded" | "on_track" | "due_soon" | "overdue" }[];
  };
}

export type CanonicalFixture = CanonicalBudgetFixture | PlanningFixture;

const ajv = new Ajv2020({
  allErrors: false,
  allowUnionTypes: true,
  strict: true,
  strictRequired: false,
  strictTypes: false,
});
addFormats(ajv);
const validateBudget = ajv.compile(budgetFixtureSchema) as ValidateFunction<CanonicalBudgetFixture>;
const validatePlanning = ajv.compile(planningFixtureSchema) as ValidateFunction<PlanningFixture>;

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  const message = errors?.slice(0, 8).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ?? "unknown schema error";
  return message.slice(0, 2000);
}

function assertUniqueIds(items: readonly { readonly id: string }[], label: string): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`${label} contains duplicate id ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function requireReference(ids: ReadonlySet<string>, id: string, label: string): void {
  if (!ids.has(id)) throw new Error(`${label} references unknown id ${id}`);
}

function safeSum(values: readonly number[], label: string): number {
  return values.reduce((total, value) => {
    const next = total + value;
    if (!Number.isSafeInteger(next)) throw new Error(`${label} exceeds safe integer range`);
    return next;
  }, 0);
}

function assertMovementSemantics(
  transaction: CanonicalTransaction,
  goals: ReadonlyMap<string, CanonicalBudgetFixture["goals"][number]>,
  transactions: ReadonlyMap<string, CanonicalTransaction>,
): void {
  const sources = transaction.movements.filter((item) => item.role === "source");
  const destinations = transaction.movements.filter((item) => item.role === "destination");
  const splitTotal = safeSum(transaction.splits.map((item) => item.amountMinor), `transaction ${transaction.id} split total`);
  const requireMovement = (items: typeof sources, role: string, signedAmountMinor: number) => {
    if (items.length !== 1 || items[0]!.signedAmountMinor !== signedAmountMinor) {
      throw new Error(`Transaction ${transaction.id} must have exactly one ${role} movement with amount ${signedAmountMinor}`);
    }
    return items[0]!;
  };

  switch (transaction.kind) {
    case "income":
      requireMovement(destinations, "destination", transaction.amountMinor);
      if (sources.length || transaction.splits.length) throw new Error(`Transaction ${transaction.id} has invalid income movements or splits`);
      return;
    case "expense":
      requireMovement(sources, "source", -transaction.amountMinor);
      if (destinations.length || splitTotal !== transaction.amountMinor) throw new Error(`Transaction ${transaction.id} expense splits must equal amountMinor`);
      return;
    case "refund":
      requireMovement(destinations, "destination", transaction.amountMinor);
      if (sources.length || splitTotal !== transaction.amountMinor) throw new Error(`Transaction ${transaction.id} refund splits must equal amountMinor`);
      {
        const original = transaction.originalTransactionId ? transactions.get(transaction.originalTransactionId) : undefined;
        if (!original || original.status !== "posted" || original.kind !== "expense") {
          throw new Error(`Transaction ${transaction.id} refund must reference a posted expense`);
        }
        const originalCategories = new Set(original.splits.map((item) => item.categoryId));
        if (transaction.splits.some((item) => !originalCategories.has(item.categoryId))) {
          throw new Error(`Transaction ${transaction.id} refund must use the original expense category`);
        }
      }
      return;
    case "transfer":
    case "goal_contribution": {
      const source = requireMovement(sources, "source", -transaction.amountMinor);
      const destination = requireMovement(destinations, "destination", transaction.amountMinor);
      if (source.accountId === destination.accountId) throw new Error(`Transaction ${transaction.id} must use two different accounts`);
      if (transaction.splits.length || safeSum(transaction.movements.map((item) => item.signedAmountMinor), `transaction ${transaction.id} movement total`) !== 0) {
        throw new Error(`Transaction ${transaction.id} movements must net to zero`);
      }
      if (transaction.kind === "goal_contribution") {
        const goal = transaction.optionalGoalId ? goals.get(transaction.optionalGoalId) : undefined;
        if (!goal || goal.linkedAccountId !== destination.accountId) throw new Error(`Transaction ${transaction.id} destination must match its goal account`);
      }
      return;
    }
  }
}

function assertBudgetReferences(fixture: CanonicalBudgetFixture): void {
  const householdId = fixture.household.id;
  const members = assertUniqueIds(fixture.members, `${fixture.fixtureId} members`);
  const accounts = assertUniqueIds(fixture.accounts, `${fixture.fixtureId} accounts`);
  const categories = assertUniqueIds(fixture.categories, `${fixture.fixtureId} categories`);
  const goalIds = assertUniqueIds(fixture.goals, `${fixture.fixtureId} goals`);
  const goals = new Map(fixture.goals.map((goal) => [goal.id, goal]));
  const transactionIds = assertUniqueIds(fixture.transactions, `${fixture.fixtureId} transactions`);
  const transactions = new Map(fixture.transactions.map((transaction) => [transaction.id, transaction]));
  assertUniqueIds(fixture.budgetPlan.lines, `${fixture.fixtureId} budget lines`);
  if (fixture.budgetPeriod.householdId !== householdId) throw new Error("budget period references unknown household");
  for (const member of fixture.members) if (member.householdId !== householdId) throw new Error(`member ${member.id} references unknown household`);
  for (const account of fixture.accounts) {
    if (account.householdId !== householdId) throw new Error(`account ${account.id} references unknown household`);
    if (account.currency !== fixture.household.baseCurrency) throw new Error(`account ${account.id} currency differs from household`);
  }
  for (const category of fixture.categories) {
    if (category.householdId !== householdId) throw new Error(`category ${category.id} references unknown household`);
    if (category.parentId) requireReference(categories, category.parentId, `category ${category.id}`);
  }
  for (const line of fixture.budgetPlan.lines) {
    if (line.periodId !== fixture.budgetPeriod.id) throw new Error(`budget line ${line.id} references unknown period`);
    requireReference(categories, line.categoryId, `budget line ${line.id}`);
  }
  for (const goal of fixture.goals) {
    if (goal.householdId !== householdId) throw new Error(`goal ${goal.id} references unknown household`);
    requireReference(accounts, goal.linkedAccountId, `goal ${goal.id}`);
  }
  for (const transaction of fixture.transactions) {
    if (transaction.householdId !== householdId) throw new Error(`transaction ${transaction.id} references unknown household`);
    requireReference(members, transaction.memberId, `transaction ${transaction.id}`);
    assertUniqueIds(transaction.movements, `transaction ${transaction.id} movements`);
    assertUniqueIds(transaction.splits, `transaction ${transaction.id} splits`);
    for (const movement of transaction.movements) requireReference(accounts, movement.accountId, `movement ${movement.id}`);
    for (const split of transaction.splits) requireReference(categories, split.categoryId, `split ${split.id}`);
    if (transaction.optionalGoalId) requireReference(goalIds, transaction.optionalGoalId, `transaction ${transaction.id}`);
    if (transaction.originalTransactionId) requireReference(transactionIds, transaction.originalTransactionId, `transaction ${transaction.id}`);
    assertMovementSemantics(transaction, goals, transactions);
  }
}

function assertPlanningReferences(fixture: PlanningFixture): void {
  const state = fixture.state;
  const accounts = assertUniqueIds(state.accounts, "G-002 accounts");
  const categories = assertUniqueIds(state.categories, "G-002 categories");
  const budgets = assertUniqueIds(state.budgets, "G-002 budgets");
  const goalIds = assertUniqueIds(state.goals, "G-002 goals");
  const goals = new Map(state.goals.map((goal) => [goal.id, goal]));
  const transactionIds = assertUniqueIds(state.transactions, "G-002 transactions");
  const transactions = new Map(state.transactions.map((transaction) => [transaction.id, transaction]));
  assertUniqueIds(state.annualCommitments, "G-002 annual commitments");
  assertUniqueIds(state.scheduledExpenses, "G-002 scheduled expenses");
  requireReference(budgets, state.activeBudgetId, "G-002 activeBudgetId");
  for (const budget of state.budgets) {
    assertUniqueIds(budget.lines, `budget ${budget.id} lines`);
    for (const line of budget.lines) requireReference(categories, line.categoryId, `budget line ${line.id}`);
  }
  for (const goal of goals.values()) requireReference(accounts, goal.linkedAccountId, `goal ${goal.id}`);
  for (const item of [...state.annualCommitments, ...state.scheduledExpenses]) {
    requireReference(accounts, item.accountId, `${item.id}`);
    requireReference(categories, item.categoryId, `${item.id}`);
  }
  for (const transaction of state.transactions) {
    if (transaction.kind === "income" || transaction.kind === "expense" || transaction.kind === "refund") requireReference(accounts, transaction.accountId, `transaction ${transaction.id}`);
    if (transaction.kind === "expense" || transaction.kind === "refund") requireReference(categories, transaction.categoryId, `transaction ${transaction.id}`);
    if (transaction.kind === "refund") {
      requireReference(transactionIds, transaction.originalTransactionId, `refund ${transaction.id}`);
      const original = transactions.get(transaction.originalTransactionId)!;
      if (original.status !== "posted" || original.kind !== "expense") throw new Error(`refund ${transaction.id} must reference a posted expense`);
      if (original.categoryId !== transaction.categoryId) throw new Error(`refund ${transaction.id} must use the original expense category`);
    }
    if (transaction.kind === "transfer" || transaction.kind === "goal_contribution") {
      requireReference(accounts, transaction.fromAccountId, `transaction ${transaction.id}`);
      requireReference(accounts, transaction.toAccountId, `transaction ${transaction.id}`);
      if (transaction.fromAccountId === transaction.toAccountId) throw new Error(`transaction ${transaction.id} must use two different accounts`);
    }
    if (transaction.kind === "goal_contribution") {
      requireReference(goalIds, transaction.goalId, `transaction ${transaction.id}`);
      const goal = goals.get(transaction.goalId)!;
      if (goal.linkedAccountId !== transaction.toAccountId) throw new Error(`transaction ${transaction.id} destination must match its goal account`);
    }
  }
}

export function parseCanonicalFixture(value: unknown): CanonicalFixture {
  const fixtureId = typeof value === "object" && value !== null && "fixtureId" in value ? value.fixtureId : null;
  const validate = fixtureId === "G-002" ? validatePlanning : validateBudget;
  if (!validate(value)) throw new Error(`Fixture schema validation failed: ${validationMessage(validate.errors)}`);
  if (fixtureId === "G-002") {
    const fixture = value as PlanningFixture;
    assertPlanningReferences(fixture);
    return fixture;
  }
  const fixture = value as CanonicalBudgetFixture;
  assertBudgetReferences(fixture);
  return fixture;
}

function movement(transaction: CanonicalTransaction, role: "source" | "destination") {
  const matches = transaction.movements.filter((item) => item.role === role);
  if (matches.length !== 1) throw new Error(`Transaction ${transaction.id} must have exactly one ${role} movement`);
  return matches[0]!;
}

function split(transaction: CanonicalTransaction) {
  if (transaction.splits.length !== 1) throw new Error(`Transaction ${transaction.id} must have exactly one split for the domain adapter`);
  return transaction.splits[0]!;
}

function adaptTransaction(transaction: CanonicalTransaction): DomainTransaction {
  if (transaction.status === "voided") throw new Error(`Transaction ${transaction.id} uses unsupported voided status`);
  const base = { id: transaction.id, occurredOn: transaction.occurredOn, status: transaction.status, amountMinor: transaction.amountMinor };
  switch (transaction.kind) {
    case "income":
      return { ...base, kind: "income", accountId: movement(transaction, "destination").accountId };
    case "expense":
      return { ...base, kind: "expense", accountId: movement(transaction, "source").accountId, categoryId: split(transaction).categoryId };
    case "refund":
      if (!transaction.originalTransactionId) throw new Error(`Transaction ${transaction.id} is missing originalTransactionId`);
      return { ...base, kind: "refund", accountId: movement(transaction, "destination").accountId, categoryId: split(transaction).categoryId, originalTransactionId: transaction.originalTransactionId };
    case "transfer":
      return { ...base, kind: "transfer", fromAccountId: movement(transaction, "source").accountId, toAccountId: movement(transaction, "destination").accountId };
    case "goal_contribution":
      if (!transaction.optionalGoalId) throw new Error(`Transaction ${transaction.id} is missing optionalGoalId`);
      return { ...base, kind: "goal_contribution", fromAccountId: movement(transaction, "source").accountId, toAccountId: movement(transaction, "destination").accountId, goalId: transaction.optionalGoalId };
  }
}

export function toDomainBudgetState(fixture: CanonicalFixture): DomainBudgetState {
  if (fixture.fixtureId === "G-002") return structuredClone(fixture.state);
  return {
    activeBudgetId: fixture.budgetPeriod.id,
    accounts: fixture.accounts.map((account) => {
      if (account.type !== "current" && account.type !== "cash" && account.type !== "savings" && account.type !== "reserve") throw new Error(`Unsupported account type ${account.type}`);
      return { id: account.id, name: account.name, type: account.type, currency: account.currency, openingBalanceMinor: account.openingBalanceMinor, active: account.active };
    }),
    categories: fixture.categories.map(({ id, name, type, group, active, sortOrder }) => ({ id, name, type, group, active, sortOrder })),
    budgets: [{
      id: fixture.budgetPeriod.id,
      startDate: fixture.budgetPeriod.startDate,
      endDate: fixture.budgetPeriod.endDate,
      status: fixture.budgetPeriod.status,
      plannedIncomeMinor: fixture.budgetPlan.plannedIncomeMinor,
      warningThreshold: Math.min(...fixture.budgetPlan.lines.map((line) => line.warnPercent)) / 100,
      lines: fixture.budgetPlan.lines.map(({ id, categoryId, plannedMinor, rolloverMinor, adjustmentMinor }) => ({ id, categoryId, plannedMinor, rolloverMinor, adjustmentMinor })),
    }],
    goals: fixture.goals.map(({ id, name, linkedAccountId, targetMinor, plannedContributionMinor, status }) => ({ id, name, linkedAccountId, targetMinor, openingContributedMinor: 0, plannedContributionMinor, status })),
    annualCommitments: [],
    scheduledExpenses: [],
    transactions: fixture.transactions.map(adaptTransaction),
  };
}

export const G000 = parseCanonicalFixture(g000Json) as CanonicalBudgetFixture;
export const G001 = parseCanonicalFixture(g001Json) as CanonicalBudgetFixture;
export const G002 = parseCanonicalFixture(g002Json) as PlanningFixture;
