import { calculateBudget, type BudgetState, type Category } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import {
  createOperationCategory,
  createTransaction,
  editTransaction,
  OperationsValidationError,
  restoreCategory,
} from "./model";
import { makeG000State, OPERATIONS_TEST_IDS as ids } from "./test-fixture";

const salaryId = "88000000-0000-4000-8000-000000000001";
const bonusId = "88000000-0000-4000-8000-000000000002";
const createdCategoryId = "99000000-0000-4000-8000-000000000001";
const createdLineId = "99000000-0000-4000-8000-000000000002";
const createdTransactionId = "99000000-0000-4000-8000-000000000003";

function withIncomeCategories(active = true): BudgetState {
  const base = makeG000State();
  const extra: readonly Category[] = [
    { id: salaryId, name: "Зарплата", type: "income", group: "income", active, sortOrder: 30 },
    { id: bonusId, name: "Премия и бонусы", type: "income", group: "income", active: true, sortOrder: 40 },
  ];
  return { ...base, categories: [...base.categories, ...extra] };
}

function ids2(...values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `unexpected-${index}`;
}

function refusal(run: () => unknown): OperationsValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof OperationsValidationError) return error;
    throw error;
  }
  throw new Error("ожидался отказ");
}

const incomeDraft = {
  kind: "income" as const,
  status: "posted" as const,
  occurredOn: "2026-07-15",
  amount: "1000",
  accountId: ids.accounts.main,
};

describe("категория у дохода", () => {
  it("доход без категории сохраняется ровно как раньше — поля нет вовсе", () => {
    const state = createTransaction(
      withIncomeCategories(),
      { ...incomeDraft, categoryId: "" },
      () => createdTransactionId,
    );
    const saved = state.transactions.find((item) => item.id === createdTransactionId);

    expect(saved).toEqual({
      id: createdTransactionId,
      kind: "income",
      status: "posted",
      occurredOn: "2026-07-15",
      amountMinor: 100_000,
      accountId: ids.accounts.main,
    });
    expect(Object.hasOwn(saved ?? {}, "categoryId")).toBe(false);
  });

  it("доход с доходной категорией сохраняет её и не двигает ни одной суммы", () => {
    const before = calculateBudget(withIncomeCategories());
    const state = createTransaction(
      withIncomeCategories(),
      { ...incomeDraft, categoryId: salaryId },
      () => createdTransactionId,
    );
    const saved = state.transactions.find((item) => item.id === createdTransactionId);

    expect(saved).toMatchObject({ kind: "income", categoryId: salaryId });
    // Метка есть, а расчёт от неё не зависит: доход прибавился, категорийные метрики прежние.
    const after = calculateBudget(state);
    expect(after.incomeMinor - before.incomeMinor).toBe(100_000);
    expect(after.categoryMetrics).toEqual(before.categoryMetrics);
  });

  it("отвергает расходную, несуществующую и архивную категорию дохода", () => {
    const state = withIncomeCategories();
    for (const categoryId of [ids.categories.products, "88000000-0000-4000-8000-000000000009"]) {
      expect(refusal(() => createTransaction(state, { ...incomeDraft, categoryId })).field).toBe("categoryId");
    }
    expect(refusal(() => createTransaction(state, { ...incomeDraft, categoryId: "не-uuid" })).field).toBe("categoryId");

    const archived = withIncomeCategories(false);
    expect(refusal(() => createTransaction(archived, { ...incomeDraft, categoryId: salaryId })).message)
      .toBe("Выберите активную категорию доходов.");
  });

  it("оставляет ушедшую в архив категорию на операции, которая её уже носит", () => {
    const state = createTransaction(
      withIncomeCategories(),
      { ...incomeDraft, categoryId: salaryId },
      () => createdTransactionId,
    );
    const archived: BudgetState = {
      ...state,
      categories: state.categories.map((item) => item.id === salaryId ? { ...item, active: false } : item),
    };

    const edited = editTransaction(archived, createdTransactionId, {
      ...incomeDraft, amount: "1200", categoryId: salaryId,
    });
    expect(edited.transactions.find((item) => item.id === createdTransactionId))
      .toMatchObject({ amountMinor: 120_000, categoryId: salaryId });

    // Убрать её при этом можно всегда: категория у дохода необязательна.
    const cleared = editTransaction(archived, createdTransactionId, { ...incomeDraft, categoryId: "" });
    expect(Object.hasOwn(cleared.transactions.find((item) => item.id === createdTransactionId) ?? {}, "categoryId"))
      .toBe(false);
  });
});

describe("создание категории из формы операции", () => {
  it("заводит категорию без лимита и не трогает ни одной строки бюджета", () => {
    const before = makeG000State();
    const result = createOperationCategory(
      before,
      { name: "  Каршеринг  ", type: "expense", group: "everyday", limit: "" },
      ids2(createdCategoryId),
    );

    expect(result.categoryId).toBe(createdCategoryId);
    expect(result.state.categories).toHaveLength(before.categories.length + 1);
    expect(result.state.categories.at(-1)).toMatchObject({
      id: createdCategoryId, name: "Каршеринг", type: "expense", group: "everyday", active: true,
    });
    expect(result.state.budgets[0]?.lines).toEqual(before.budgets[0]?.lines);
    expect(calculateBudget(result.state).expensesMinor).toBe(calculateBudget(before).expensesMinor);
  });

  it("названная сумма становится строкой активного бюджета", () => {
    const result = createOperationCategory(
      makeG000State(),
      { name: "Каршеринг", type: "expense", group: "everyday", limit: "4 500" },
      ids2(createdCategoryId, createdLineId),
    );

    expect(result.state.budgets[0]?.lines.at(-1)).toEqual({
      id: createdLineId, categoryId: createdCategoryId, plannedMinor: 450_000, active: true,
    });
    expect(calculateBudget(result.state).categoryMetrics[createdCategoryId])
      .toMatchObject({ availableMinor: 450_000, actualMinor: 0, status: "normal" });
  });

  it("заводит доходную категорию и отказывает ей в месячном лимите", () => {
    const created = createOperationCategory(
      withIncomeCategories(),
      { name: "Подработка", type: "income", group: "income", limit: "" },
      ids2(createdCategoryId),
    );
    expect(created.state.categories.at(-1)).toMatchObject({ type: "income", group: "income" });

    const refused = refusal(() => createOperationCategory(
      withIncomeCategories(),
      { name: "Подработка", type: "income", group: "income", limit: "1000" },
      ids2(createdCategoryId, createdLineId),
    ));
    expect(refused.field).toBe("limit");
  });

  it("переводит отказы домена в поля формы, а не в необъяснимую ошибку", () => {
    const state = withIncomeCategories();
    expect(refusal(() => createOperationCategory(state, { name: "  ", type: "expense", group: "everyday", limit: "" })))
      .toMatchObject({ field: "name", message: "Укажите название." });
    expect(refusal(() => createOperationCategory(state, { name: "Продукты", type: "expense", group: "everyday", limit: "" })))
      .toMatchObject({ field: "name", message: "Активная категория с таким названием уже существует." });
    expect(refusal(() => createOperationCategory(state, { name: "Каршеринг", type: "expense", group: "income", limit: "" })))
      .toMatchObject({ field: "group" });
    expect(refusal(() => createOperationCategory(state, { name: "Каршеринг", type: "expense", group: "everyday", limit: "-5" })))
      .toMatchObject({ field: "limit" });
  });
});

describe("возврат категории из архива", () => {
  function archived(): BudgetState {
    const base = makeG000State();
    return {
      ...base,
      categories: base.categories.map((item) =>
        item.id === ids.categories.products ? { ...item, active: false } : item),
    };
  }

  it("возвращает и оставляет всё остальное на месте", () => {
    const restored = restoreCategory(archived(), ids.categories.products);

    expect(restored.categories.find((item) => item.id === ids.categories.products)?.active).toBe(true);
    expect(restored.transactions).toEqual(archived().transactions);
    expect(restored.budgets).toEqual(archived().budgets);
  });

  it("отказывает, если имя тем временем занято активной категорией", () => {
    const state = archived();
    const clashing: BudgetState = {
      ...state,
      categories: [
        ...state.categories,
        { id: createdCategoryId, name: "продукты", type: "expense", group: "everyday", active: true, sortOrder: 90 },
      ],
    };

    expect(refusal(() => restoreCategory(clashing, ids.categories.products)))
      .toMatchObject({ field: "categoryId", message: "Активная категория с таким названием уже существует." });
  });

  it("на уже активной категории ничего не меняет и не спорит", () => {
    const state = makeG000State();
    expect(restoreCategory(state, ids.categories.products)).toBe(state);
    expect(refusal(() => restoreCategory(state, createdCategoryId)).field).toBe("categoryId");
  });
});
