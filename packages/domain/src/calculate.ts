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
  FormatMinorOptions,
  Goal,
  GoalId,
  MinorUnits,
  PlanningMonthMetrics,
  ScheduledExpense,
  StableId,
  Transaction,
} from "./types.js";

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_MONTH_PATTERN = /^\d{4}-\d{2}$/;

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
  assertMinor(account.openingBalanceMinor, `account ${account.id} openingBalanceMinor`);
}

function validateCategory(category: Category): void {
  assertEnum(category.type, ["income", "expense"], `category ${category.id} type`);
  if (!Number.isSafeInteger(category.sortOrder)) {
    throw new Error(`category ${category.id} sortOrder must be an integer`);
  }
}

function validateGoal(goal: Goal, accounts: ReadonlyMap<StableId, Account>): void {
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
  requireEntity(accounts, goal.linkedAccountId, `goal ${goal.id}`);
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
    availableByCategory.set(line.categoryId, availableMinor);
  }

  return availableByCategory;
}

function validateTransactionReferences(
  transaction: Transaction,
  accounts: ReadonlyMap<StableId, Account>,
  categories: ReadonlyMap<StableId, Category>,
  goals: ReadonlyMap<StableId, Goal>,
  transactions: ReadonlyMap<StableId, Transaction>,
): void {
  assertEnum(transaction.status, ["posted", "pending", "draft"], `transaction ${transaction.id} status`);
  assertEnum(transaction.kind, ["income", "expense", "refund", "transfer", "goal_contribution"], `transaction ${transaction.id} kind`);
  assertLocalDate(transaction.occurredOn, `transaction ${transaction.id} occurredOn`);
  assertPositiveMinor(transaction.amountMinor, `transaction ${transaction.id} amountMinor`);

  switch (transaction.kind) {
    case "income":
      requireEntity(accounts, transaction.accountId, `transaction ${transaction.id}`);
      return;
    case "expense": {
      requireEntity(accounts, transaction.accountId, `transaction ${transaction.id}`);
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
      requireEntity(accounts, transaction.accountId, `transaction ${transaction.id}`);
      const category = requireEntity(categories, transaction.categoryId, `transaction ${transaction.id}`);
      if (category.type !== "expense") throw new Error(`transaction ${transaction.id} must reference an expense category`);
      const original = requireEntity(transactions, transaction.originalTransactionId, `refund ${transaction.id} originalTransactionId`);
      if (original.status !== "posted" || original.kind !== "expense") {
        throw new Error(`refund ${transaction.id} must reference a posted expense transaction`);
      }
      if (original.categoryId !== transaction.categoryId) {
        throw new Error(`refund ${transaction.id} must use the original expense category`);
      }
      return;
    }
    case "transfer":
      requireEntity(accounts, transaction.fromAccountId, `transaction ${transaction.id}`);
      requireEntity(accounts, transaction.toAccountId, `transaction ${transaction.id}`);
      if (transaction.fromAccountId === transaction.toAccountId) {
        throw new Error(`transaction ${transaction.id} must use two different accounts`);
      }
      return;
    case "goal_contribution": {
      requireEntity(accounts, transaction.fromAccountId, `transaction ${transaction.id}`);
      requireEntity(accounts, transaction.toAccountId, `transaction ${transaction.id}`);
      if (transaction.fromAccountId === transaction.toAccountId) {
        throw new Error(`transaction ${transaction.id} must use two different accounts`);
      }
      const goal = requireEntity(goals, transaction.goalId, `transaction ${transaction.id}`);
      if (goal.linkedAccountId !== transaction.toAccountId) {
        throw new Error(
          `transaction ${transaction.id} destination must match goal ${goal.id} linked account`,
        );
      }
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
  const accounts = indexById(state.accounts, "accounts");
  const categories = indexById(state.categories, "categories");
  const budgets = indexById(state.budgets, "budgets");
  const goals = indexById(state.goals, "goals");
  const transactions = indexById(state.transactions, "transactions");

  for (const account of state.accounts) validateAccount(account);
  for (const category of state.categories) validateCategory(category);
  for (const goal of state.goals) validateGoal(goal, accounts);

  const budget = requireEntity(budgets, budgetId, "calculateBudget");
  const availableByCategory = validateBudget(budget, categories);

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
    validateTransactionReferences(transaction, accounts, categories, goals, transactions);
    if (transaction.status !== "posted" || !isWithinBudget(transaction, budget)) continue;

    switch (transaction.kind) {
      case "income":
        incomeMinor = addMinor(incomeMinor, transaction.amountMinor, "incomeMinor");
        changeAccount(transaction.accountId, transaction.amountMinor);
        break;
      case "expense": {
        grossExpensesMinor = addMinor(
          grossExpensesMinor,
          transaction.amountMinor,
          "grossExpensesMinor",
        );
        const categoryAmount = expenseByCategory.get(transaction.categoryId) ?? 0;
        expenseByCategory.set(
          transaction.categoryId,
          addMinor(categoryAmount, transaction.amountMinor, "category expenseMinor"),
        );
        changeAccount(transaction.accountId, -transaction.amountMinor);
        break;
      }
      case "refund": {
        refundsMinor = addMinor(refundsMinor, transaction.amountMinor, "refundsMinor");
        const categoryAmount = refundByCategory.get(transaction.categoryId) ?? 0;
        refundByCategory.set(
          transaction.categoryId,
          addMinor(categoryAmount, transaction.amountMinor, "category refundMinor"),
        );
        changeAccount(transaction.accountId, transaction.amountMinor);
        break;
      }
      case "transfer":
        changeAccount(transaction.fromAccountId, -transaction.amountMinor);
        changeAccount(transaction.toAccountId, transaction.amountMinor);
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
  const capitalMinor = [...accountBalances.values()].reduce(
    (total, balance) => addMinor(total, balance, "capitalMinor"),
    0,
  );

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

function monthIndex(value: string, label: string): number {
  if (!LOCAL_MONTH_PATTERN.test(value)) {
    throw new Error(`${label} must use YYYY-MM`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  if (!Number.isSafeInteger(year) || month < 1 || month > 12) {
    throw new Error(`${label} must be a valid calendar month`);
  }
  return year * 12 + month - 1;
}

function monthFromIndex(value: number): string {
  const year = Math.floor(value / 12);
  const month = value - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** A due day beyond the month end is charged on that month's final calendar day. */
export function normalizeScheduledDueDate(month: string, dueDay: number): string {
  monthIndex(month, "month");
  if (!Number.isSafeInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    throw new Error("dueDay must be from 1 to 31");
  }
  const year = Number(month.slice(0, 4));
  const calendarMonth = Number(month.slice(5, 7));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return `${month}-${String(Math.min(dueDay, days[calendarMonth - 1]!)).padStart(2, "0")}`;
}

function validateAnnualCommitment(
  item: AnnualCommitment,
  accounts: ReadonlyMap<StableId, Account>,
  categories: ReadonlyMap<StableId, Category>,
): void {
  assertEnum(item.recurrence, ["annual", "one_time"], `annual commitment ${item.id} recurrence`);
  assertLocalDate(item.dueDate, `annual commitment ${item.id} dueDate`);
  assertPositiveMinor(item.amountMinor, `annual commitment ${item.id} amountMinor`);
  assertNonNegativeMinor(item.reservedMinor, `annual commitment ${item.id} reservedMinor`);
  requireEntity(accounts, item.accountId, `annual commitment ${item.id}`);
  const category = requireEntity(categories, item.categoryId, `annual commitment ${item.id}`);
  if (category.type !== "expense") {
    throw new Error(`annual commitment ${item.id} must reference an expense category`);
  }
}

function validateScheduledExpense(
  item: ScheduledExpense,
  accounts: ReadonlyMap<StableId, Account>,
  categories: ReadonlyMap<StableId, Category>,
): void {
  assertEnum(item.mode, ["monthly", "selected_months"], `scheduled expense ${item.id} mode`);
  assertPositiveMinor(item.amountMinor, `scheduled expense ${item.id} amountMinor`);
  if (!Number.isSafeInteger(item.dueDay) || item.dueDay < 1 || item.dueDay > 31) {
    throw new Error(`scheduled expense ${item.id} dueDay must be from 1 to 31`);
  }
  requireEntity(accounts, item.accountId, `scheduled expense ${item.id}`);
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

  const accounts = indexById(state.accounts, "accounts");
  const categories = indexById(state.categories, "categories");
  const budgets = indexById(state.budgets, "budgets");
  const goals = indexById(state.goals, "goals");
  const transactions = indexById(state.transactions, "transactions");
  const annualCommitments = indexById(state.annualCommitments ?? [], "annualCommitments");
  const scheduledExpenses = indexById(state.scheduledExpenses ?? [], "scheduledExpenses");
  const budget = requireEntity(budgets, state.activeBudgetId, "calculateAnnualPlan");
  for (const account of accounts.values()) validateAccount(account);
  for (const category of categories.values()) validateCategory(category);
  const flexibleByCategory = validateBudget(budget, categories);

  for (const goal of goals.values()) validateGoal(goal, accounts);
  for (const transaction of transactions.values()) validateTransactionReferences(transaction, accounts, categories, goals, transactions);

  for (const item of annualCommitments.values()) {
    validateAnnualCommitment(item, accounts, categories);
  }
  for (const item of scheduledExpenses.values()) {
    validateScheduledExpense(item, accounts, categories);
  }

  const flexiblePlanMinor = [...flexibleByCategory.values()].reduce(
    (total, value) => addMinor(total, value, "flexiblePlanMinor"),
    0,
  );
  const goalPlanMinor = [...goals.values()]
    .filter((goal) => goal.status === "active")
    .reduce((total, goal) => addMinor(total, goal.plannedContributionMinor, "goalPlanMinor"), 0);

  const commitmentMetrics = createIdRecord<AnnualCommitmentId, AnnualCommitmentMetrics>();
  for (const item of annualCommitments.values()) {
    const dueIndex = monthIndex(item.dueDate.slice(0, 7), `annual commitment ${item.id} due month`);
    const monthsUntilDue = dueIndex - startIndex + 1;
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
        const dueIndex = monthIndex(item.dueDate.slice(0, 7), `annual commitment ${item.id} due month`);
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
    .filter((item) => item.active && monthIndex(item.dueDate.slice(0, 7), `annual commitment ${item.id} due month`) >= startIndex)
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate))
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
