import { type BudgetState } from "@family-budget/domain";
import { createCommitment, createSchedule } from "./model";

export const TEST_IDS = {
  account: "10000000-0000-4000-8000-000000000001",
  budget: "20000000-0000-4000-8000-000000000001",
  categories: {
    housing: "30000000-0000-4000-8000-000000000001",
    children: "30000000-0000-4000-8000-000000000002",
    transport: "30000000-0000-4000-8000-000000000003",
    food: "30000000-0000-4000-8000-000000000004",
  },
  lines: [
    "40000000-0000-4000-8000-000000000001",
    "40000000-0000-4000-8000-000000000002",
    "40000000-0000-4000-8000-000000000003",
  ],
  monthly: "50000000-0000-4000-8000-000000000001",
} as const;

export function makePlanningTestState(): BudgetState {
  return {
    activeBudgetId: TEST_IDS.budget,
    accounts: [{ id: TEST_IDS.account, name: "Основной", type: "current", currency: "RUB", openingBalanceMinor: 0, active: true }],
    categories: [
      { id: TEST_IDS.categories.housing, name: "Жильё", type: "expense", group: "Обязательные", active: true, sortOrder: 10 },
      { id: TEST_IDS.categories.children, name: "Дети", type: "expense", group: "Семья", active: true, sortOrder: 20 },
      { id: TEST_IDS.categories.transport, name: "Транспорт", type: "expense", group: "Повседневные", active: true, sortOrder: 30 },
      { id: TEST_IDS.categories.food, name: "Продукты", type: "expense", group: "Повседневные", active: true, sortOrder: 40 },
    ],
    budgets: [{
      id: TEST_IDS.budget,
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      status: "open",
      plannedIncomeMinor: 18_000_000,
      warningThreshold: 0.8,
      lines: [
        { id: TEST_IDS.lines[0], categoryId: TEST_IDS.categories.children, plannedMinor: 1_000_000 },
        { id: TEST_IDS.lines[1], categoryId: TEST_IDS.categories.transport, plannedMinor: 1_000_000 },
        { id: TEST_IDS.lines[2], categoryId: TEST_IDS.categories.food, plannedMinor: 3_300_000 },
      ],
    }],
    goals: [],
    annualCommitments: [],
    scheduledExpenses: [{ id: TEST_IDS.monthly, name: "Ежемесячные обязательные", categoryId: TEST_IDS.categories.housing, accountId: TEST_IDS.account, amountMinor: 5_300_000, dueDay: 1, mode: "monthly", active: true }],
    transactions: [],
  };
}

export function deterministicIds(): () => string {
  let value = 1;
  return () => `90000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

export function makeCanonicalPlanningState(): BudgetState {
  const makeId = deterministicIds();
  let state = makePlanningTestState();
  for (const draft of [
    { name: "Страхование автомобиля", categoryId: TEST_IDS.categories.transport, accountId: TEST_IDS.account, dueDate: "2027-01-15", amount: "72000", reserved: "0", recurrence: "annual" as const },
    { name: "Плата за загородный дом", categoryId: TEST_IDS.categories.housing, accountId: TEST_IDS.account, dueDate: "2027-05-01", amount: "36000", reserved: "0", recurrence: "annual" as const },
    { name: "Летний лагерь", categoryId: TEST_IDS.categories.children, accountId: TEST_IDS.account, dueDate: "2027-06-15", amount: "90000", reserved: "15000", recurrence: "one_time" as const },
  ]) state = createCommitment(state, draft, makeId);
  for (const draft of [
    { name: "Обучение детей", amount: "25000", dueDay: "10" },
    { name: "Секции", amount: "6000", dueDay: "12" },
  ]) state = createSchedule(state, { ...draft, categoryId: TEST_IDS.categories.children, accountId: TEST_IDS.account, mode: "selected_months", months: [1, 2, 3, 4, 5, 9, 10, 11, 12] }, makeId);
  return state;
}
