import type { BudgetState } from "./types.js";

export const SEED_IDS = {
  budget: "44444444-4444-4444-8444-444444444441",
  accounts: {
    main: "22222222-2222-4222-8222-222222222221",
    savings: "22222222-2222-4222-8222-222222222222",
  },
  categories: {
    housing: "33333333-3333-4333-8333-333333333331",
    food: "33333333-3333-4333-8333-333333333332",
    transport: "33333333-3333-4333-8333-333333333333",
  },
  goal: "66666666-6666-4666-8666-666666666661",
  transactions: {
    income: "55555555-5555-4555-8555-555555555551",
    housing: "55555555-5555-4555-8555-555555555552",
    food: "55555555-5555-4555-8555-555555555553",
    transport: "55555555-5555-4555-8555-555555555554",
    goal: "55555555-5555-4555-8555-555555555555",
  },
} as const;

export function makeSeedBudget(): BudgetState {
  return {
    activeBudgetId: SEED_IDS.budget,
    accounts: [
      {
        id: SEED_IDS.accounts.main,
        name: "Основной",
        type: "current",
        currency: "RUB",
        openingBalanceMinor: 0,
        active: true,
      },
      {
        id: SEED_IDS.accounts.savings,
        name: "Накопительный",
        type: "savings",
        currency: "RUB",
        openingBalanceMinor: 0,
        active: true,
      },
    ],
    categories: [
      {
        id: SEED_IDS.categories.housing,
        name: "Жильё",
        type: "expense",
        group: "Обязательные расходы",
        active: true,
        sortOrder: 10,
      },
      {
        id: SEED_IDS.categories.food,
        name: "Продукты",
        type: "expense",
        group: "Повседневные расходы",
        active: true,
        sortOrder: 20,
      },
      {
        id: SEED_IDS.categories.transport,
        name: "Транспорт",
        type: "expense",
        group: "Повседневные расходы",
        active: true,
        sortOrder: 30,
      },
    ],
    budgets: [
      {
        id: SEED_IDS.budget,
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        status: "open",
        plannedIncomeMinor: 10_000_000,
        warningThreshold: 0.8,
        lines: [
          {
            id: "44444444-4444-4444-8444-444444444451",
            categoryId: SEED_IDS.categories.housing,
            plannedMinor: 4_000_000,
          },
          {
            id: "44444444-4444-4444-8444-444444444452",
            categoryId: SEED_IDS.categories.food,
            plannedMinor: 3_000_000,
          },
          {
            id: "44444444-4444-4444-8444-444444444453",
            categoryId: SEED_IDS.categories.transport,
            plannedMinor: 1_000_000,
          },
        ],
      },
    ],
    goals: [
      {
        id: SEED_IDS.goal,
        name: "Резерв",
        linkedAccountId: SEED_IDS.accounts.savings,
        targetMinor: 10_000_000,
        openingContributedMinor: 0,
        plannedContributionMinor: 1_000_000,
        status: "active",
      },
    ],
    annualCommitments: [],
    scheduledExpenses: [],
    transactions: [
      {
        id: SEED_IDS.transactions.income,
        occurredOn: "2026-07-01",
        status: "posted",
        kind: "income",
        amountMinor: 10_000_000,
        accountId: SEED_IDS.accounts.main,
      },
      {
        id: SEED_IDS.transactions.housing,
        occurredOn: "2026-07-02",
        status: "posted",
        kind: "expense",
        amountMinor: 4_000_000,
        accountId: SEED_IDS.accounts.main,
        categoryId: SEED_IDS.categories.housing,
      },
      {
        id: SEED_IDS.transactions.food,
        occurredOn: "2026-07-05",
        status: "posted",
        kind: "expense",
        amountMinor: 3_150_000,
        accountId: SEED_IDS.accounts.main,
        categoryId: SEED_IDS.categories.food,
      },
      {
        id: SEED_IDS.transactions.transport,
        occurredOn: "2026-07-06",
        status: "posted",
        kind: "expense",
        amountMinor: 500_000,
        accountId: SEED_IDS.accounts.main,
        categoryId: SEED_IDS.categories.transport,
      },
      {
        id: SEED_IDS.transactions.goal,
        occurredOn: "2026-07-10",
        status: "posted",
        kind: "goal_contribution",
        amountMinor: 1_000_000,
        fromAccountId: SEED_IDS.accounts.main,
        toAccountId: SEED_IDS.accounts.savings,
        goalId: SEED_IDS.goal,
      },
    ],
  };
}

export const PLANNING_IDS = {
  budget: "74444444-4444-4444-8444-444444444441",
  categories: {
    housing: "73333333-3333-4333-8333-333333333331",
    utilities: "73333333-3333-4333-8333-333333333332",
    children: "73333333-3333-4333-8333-333333333333",
    transport: "73333333-3333-4333-8333-333333333334",
    food: "73333333-3333-4333-8333-333333333335",
    leisure: "73333333-3333-4333-8333-333333333336",
    household: "73333333-3333-4333-8333-333333333337",
  },
  commitments: {
    carInsurance: "78888888-8888-4888-8888-888888888881",
    countryHouse: "78888888-8888-4888-8888-888888888882",
    summerCamp: "78888888-8888-4888-8888-888888888883",
  },
} as const;

/** Friendly demo for the planning UI; G-001 remains unchanged for contract tests. */
export function makePlanningSeed(): BudgetState {
  const mainAccountId = SEED_IDS.accounts.main;
  const savingsAccountId = SEED_IDS.accounts.savings;
  return {
    activeBudgetId: PLANNING_IDS.budget,
    accounts: [
      { id: mainAccountId, name: "Основной", type: "current", currency: "RUB", openingBalanceMinor: 0, active: true },
      { id: savingsAccountId, name: "Резерв платежей", type: "reserve", currency: "RUB", openingBalanceMinor: 1_500_000, active: true },
    ],
    categories: [
      { id: PLANNING_IDS.categories.housing, name: "Жильё", type: "expense", group: "Обязательные", active: true, sortOrder: 10 },
      { id: PLANNING_IDS.categories.utilities, name: "ЖКХ и связь", type: "expense", group: "Обязательные", active: true, sortOrder: 20 },
      { id: PLANNING_IDS.categories.children, name: "Дети", type: "expense", group: "Семья", active: true, sortOrder: 30 },
      { id: PLANNING_IDS.categories.food, name: "Продукты", type: "expense", group: "Повседневные", active: true, sortOrder: 40 },
      { id: PLANNING_IDS.categories.transport, name: "Транспорт", type: "expense", group: "Повседневные", active: true, sortOrder: 50 },
      { id: PLANNING_IDS.categories.leisure, name: "Досуг", type: "expense", group: "Повседневные", active: true, sortOrder: 60 },
      { id: PLANNING_IDS.categories.household, name: "Дом и мелкие покупки", type: "expense", group: "Повседневные", active: true, sortOrder: 70 },
    ],
    budgets: [{
      id: PLANNING_IDS.budget,
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      status: "open",
      plannedIncomeMinor: 18_000_000,
      warningThreshold: 0.8,
      lines: [
        { id: "74444444-4444-4444-8444-444444444451", categoryId: PLANNING_IDS.categories.food, plannedMinor: 3_000_000 },
        { id: "74444444-4444-4444-8444-444444444452", categoryId: PLANNING_IDS.categories.transport, plannedMinor: 1_000_000 },
        { id: "74444444-4444-4444-8444-444444444453", categoryId: PLANNING_IDS.categories.leisure, plannedMinor: 800_000 },
        { id: "74444444-4444-4444-8444-444444444454", categoryId: PLANNING_IDS.categories.household, plannedMinor: 500_000 },
      ],
    }],
    goals: [{
      id: SEED_IDS.goal,
      name: "Финансовая подушка",
      linkedAccountId: savingsAccountId,
      targetMinor: 60_000_000,
      openingContributedMinor: 1_500_000,
      plannedContributionMinor: 1_000_000,
      status: "active",
    }],
    annualCommitments: [
      { id: PLANNING_IDS.commitments.carInsurance, name: "Страхование автомобиля", categoryId: PLANNING_IDS.categories.transport, accountId: mainAccountId, dueDate: "2027-01-15", amountMinor: 7_200_000, reservedMinor: 0, recurrence: "annual", active: true },
      { id: PLANNING_IDS.commitments.countryHouse, name: "Платёж за загородный дом", categoryId: PLANNING_IDS.categories.housing, accountId: mainAccountId, dueDate: "2027-05-01", amountMinor: 3_600_000, reservedMinor: 0, recurrence: "annual", active: true },
      { id: PLANNING_IDS.commitments.summerCamp, name: "Летний лагерь", categoryId: PLANNING_IDS.categories.children, accountId: mainAccountId, dueDate: "2027-06-15", amountMinor: 9_000_000, reservedMinor: 1_500_000, recurrence: "one_time", active: true },
    ],
    scheduledExpenses: [
      { id: "79999999-9999-4999-8999-999999999991", name: "Аренда / ипотека", categoryId: PLANNING_IDS.categories.housing, accountId: mainAccountId, amountMinor: 4_500_000, dueDay: 5, mode: "monthly", active: true },
      { id: "79999999-9999-4999-8999-999999999992", name: "ЖКХ, интернет и связь", categoryId: PLANNING_IDS.categories.utilities, accountId: mainAccountId, amountMinor: 800_000, dueDay: 15, mode: "monthly", active: true },
      { id: "79999999-9999-4999-8999-999999999993", name: "Обучение детей", categoryId: PLANNING_IDS.categories.children, accountId: mainAccountId, amountMinor: 2_500_000, dueDay: 10, mode: "selected_months", months: [1, 2, 3, 4, 5, 9, 10, 11, 12], active: true },
      { id: "79999999-9999-4999-8999-999999999994", name: "Секции", categoryId: PLANNING_IDS.categories.children, accountId: mainAccountId, amountMinor: 600_000, dueDay: 12, mode: "selected_months", months: [1, 2, 3, 4, 5, 9, 10, 11, 12], active: true },
    ],
    transactions: [
      { id: "75555555-5555-4555-8555-555555555551", occurredOn: "2026-07-01", status: "posted", kind: "income", amountMinor: 18_000_000, accountId: mainAccountId },
      { id: "75555555-5555-4555-8555-555555555552", occurredOn: "2026-07-05", status: "posted", kind: "expense", amountMinor: 4_500_000, accountId: mainAccountId, categoryId: PLANNING_IDS.categories.housing },
      { id: "75555555-5555-4555-8555-555555555553", occurredOn: "2026-07-08", status: "posted", kind: "expense", amountMinor: 2_200_000, accountId: mainAccountId, categoryId: PLANNING_IDS.categories.food },
      { id: "75555555-5555-4555-8555-555555555554", occurredOn: "2026-07-09", status: "posted", kind: "expense", amountMinor: 400_000, accountId: mainAccountId, categoryId: PLANNING_IDS.categories.transport },
    ],
  };
}
