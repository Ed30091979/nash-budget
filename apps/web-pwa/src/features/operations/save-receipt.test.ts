import { calculateBudget, makeSeedBudget, SEED_IDS, type BudgetState } from "@family-budget/domain";
import { describe, expect, it } from "vitest";

import { createTransaction, type TransactionDraft } from "./model";
import { effectLabel, effectTarget, effectValueMinor } from "./save-receipt";

const common = { status: "posted" as const, occurredOn: "2026-07-09" };

function expenseDraft(categoryId: string, amount = "1200"): TransactionDraft {
  return { ...common, kind: "expense", amount, accountId: SEED_IDS.accounts.main, categoryId };
}

function withoutPlan(state: BudgetState, categoryId: string): BudgetState {
  return {
    ...state,
    budgets: state.budgets.map((budget) => ({
      ...budget,
      lines: budget.lines.filter((line) => line.categoryId !== categoryId),
    })),
  };
}

describe("число, которое человек узнаёт после записи", () => {
  it("у расхода по категории с лимитом называет остаток этой категории", () => {
    const budget = makeSeedBudget();
    const metrics = calculateBudget(budget);
    const draft = expenseDraft(SEED_IDS.categories.food);

    const target = effectTarget(budget, metrics, draft);

    expect(target).toEqual({ kind: "category", id: SEED_IDS.categories.food, name: "Продукты" });
    expect(effectLabel(target!)).toBe("Осталось в категории «Продукты»");
    expect(effectValueMinor(metrics, target!))
      .toBe(metrics.categoryMetrics[SEED_IDS.categories.food]!.remainingMinor);
  });

  it("после записи это число уменьшается ровно на сумму траты", () => {
    const before = makeSeedBudget();
    const beforeMetrics = calculateBudget(before);
    const draft = expenseDraft(SEED_IDS.categories.food, "1200");
    const target = effectTarget(before, beforeMetrics, draft)!;

    const after = createTransaction(before, draft, () => "55555555-5555-4555-8555-555555555561");

    expect(effectValueMinor(calculateBudget(after), target))
      .toBe(effectValueMinor(beforeMetrics, target) - 120_000);
  });

  it("у категории без плана называет не «остаток лимита», а остаток счёта", () => {
    // Без строки плана `availableMinor` равен нулю, и «осталось» было бы суммой трат со знаком
    // минус — числом, которого человек нигде больше не видит и которое ничего не значит.
    const budget = withoutPlan(makeSeedBudget(), SEED_IDS.categories.food);
    const metrics = calculateBudget(budget);

    const target = effectTarget(budget, metrics, expenseDraft(SEED_IDS.categories.food))!;

    expect(target).toEqual({ kind: "account", id: SEED_IDS.accounts.main, name: "Основной" });
    expect(effectLabel(target)).toBe("Остаток на счёте «Основной»");
    expect(effectValueMinor(metrics, target))
      .toBe(metrics.accountBalancesMinor[SEED_IDS.accounts.main]);
  });

  it("у перевода называет счёт, с которого ушли деньги, — тот, что и подвинулся вниз", () => {
    const budget = makeSeedBudget();
    const metrics = calculateBudget(budget);
    const draft: TransactionDraft = {
      ...common,
      kind: "transfer",
      amount: "5000",
      fromAccountId: SEED_IDS.accounts.main,
      toAccountId: SEED_IDS.accounts.savings,
    };

    expect(effectTarget(budget, metrics, draft))
      .toEqual({ kind: "account", id: SEED_IDS.accounts.main, name: "Основной" });
  });

  it("молчит, когда называть нечего: выдуманное число хуже отсутствующего", () => {
    const budget = makeSeedBudget();
    const metrics = calculateBudget(budget);
    const draft: TransactionDraft = {
      ...common,
      kind: "expense",
      amount: "1200",
      accountId: "00000000-0000-4000-8000-000000000000",
      categoryId: "",
    };

    expect(effectTarget(budget, metrics, draft)).toBeNull();
  });
});
