import { type BudgetState } from "@family-budget/domain";

export const OPERATIONS_TEST_IDS = {
  accounts: {
    main: "11000000-0000-4000-8000-000000000001",
    savings: "11000000-0000-4000-8000-000000000002",
  },
  categories: {
    products: "22000000-0000-4000-8000-000000000001",
    housing: "22000000-0000-4000-8000-000000000002",
  },
  budget: "33000000-0000-4000-8000-000000000001",
  lines: {
    products: "44000000-0000-4000-8000-000000000001",
    housing: "44000000-0000-4000-8000-000000000002",
  },
  goal: "55000000-0000-4000-8000-000000000001",
  transactions: {
    income: "66000000-0000-4000-8000-000000000001",
    housing1: "66000000-0000-4000-8000-000000000002",
    housing2: "66000000-0000-4000-8000-000000000003",
    products: "66000000-0000-4000-8000-000000000004",
    created: "77000000-0000-4000-8000-000000000001",
  },
} as const;

export function makeG000State(): BudgetState {
  const ids = OPERATIONS_TEST_IDS;
  return {
    activeBudgetId: ids.budget,
    accounts: [
      { id: ids.accounts.main, name: "Основной", type: "current", currency: "RUB", openingBalanceMinor: 0, active: true },
      { id: ids.accounts.savings, name: "Накопительный", type: "savings", currency: "RUB", openingBalanceMinor: 0, active: true },
    ],
    categories: [
      { id: ids.categories.products, name: "Продукты", type: "expense", group: "Повседневные", active: true, sortOrder: 10 },
      { id: ids.categories.housing, name: "Жильё", type: "expense", group: "Обязательные", active: true, sortOrder: 20 },
    ],
    budgets: [{
      id: ids.budget,
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      status: "open",
      plannedIncomeMinor: 10_000_000,
      warningThreshold: 0.8,
      lines: [
        { id: ids.lines.products, categoryId: ids.categories.products, plannedMinor: 3_000_000 },
        { id: ids.lines.housing, categoryId: ids.categories.housing, plannedMinor: 4_500_000 },
      ],
    }],
    goals: [{
      id: ids.goal,
      name: "Подушка",
      linkedAccountId: ids.accounts.savings,
      targetMinor: 50_000_000,
      openingContributedMinor: 0,
      plannedContributionMinor: 1_000_000,
      status: "active",
    }],
    annualCommitments: [],
    scheduledExpenses: [],
    transactions: [
      { id: ids.transactions.income, kind: "income", status: "posted", occurredOn: "2026-07-01", amountMinor: 10_000_000, accountId: ids.accounts.main },
      { id: ids.transactions.housing1, kind: "expense", status: "posted", occurredOn: "2026-07-02", amountMinor: 4_000_000, accountId: ids.accounts.main, categoryId: ids.categories.housing },
      { id: ids.transactions.housing2, kind: "expense", status: "posted", occurredOn: "2026-07-03", amountMinor: 500_000, accountId: ids.accounts.main, categoryId: ids.categories.housing },
      { id: ids.transactions.products, kind: "expense", status: "posted", occurredOn: "2026-07-06", amountMinor: 3_150_000, accountId: ids.accounts.main, categoryId: ids.categories.products },
    ],
  };
}

export function fixedOperationId(): string {
  return OPERATIONS_TEST_IDS.transactions.created;
}
