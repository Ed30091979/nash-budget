import "fake-indexeddb/auto";
import { calculateAnnualPlan } from "@family-budget/domain";
import { afterEach, describe, expect, it } from "vitest";
import { prepareBudgetState } from "../backup";
import { createBudgetRepository } from "../storage-repository";
import {
  buildOnboardingBudgetState,
  createInitialOnboardingDraft,
  persistCompletedOnboarding,
  type OnboardingDraft,
} from "./model";

const databaseNames = new Set<string>();

function databaseName(label: string): string {
  const name = `family-budget-onboarding-${label}-${crypto.randomUUID()}`;
  databaseNames.add(name);
  return name;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function acceptanceDraft(): OnboardingDraft {
  return {
    ...createInitialOnboardingDraft("2026-07-01"),
    monthlyIncome: "180000",
    mandatoryAmount: "53000",
    categories: [
      { key: "1", name: "Продукты", limit: "30000" },
      { key: "2", name: "Транспорт", limit: "15000" },
      { key: "3", name: "Дом", limit: "8000" },
    ],
  };
}

afterEach(async () => {
  await Promise.all([...databaseNames].map(deleteDatabase));
  databaseNames.clear();
});

describe("onboarding IndexedDB lifecycle", () => {
  it("первое load возвращает null и оставляет в репозитории 0 документов", async () => {
    const repository = createBudgetRepository({ databaseName: databaseName("empty") });
    expect(await repository.load()).toBeNull();
    expect(await repository.documentCount()).toBe(0);
  });

  it("записывает готовый план один раз и после reload возвращает те же суммы и счётчики", async () => {
    const repository = createBudgetRepository({ databaseName: databaseName("complete") });
    const built = prepareBudgetState(buildOnboardingBudgetState(acceptanceDraft()));
    let published = null as typeof built | null;
    let createCount = 0;

    const result = await persistCompletedOnboarding({
      createIfAbsent: async (state) => {
        createCount += 1;
        return repository.createIfAbsent(state);
      },
    }, built, prepareBudgetState, (state) => { published = state; });
    const reloaded = await repository.load();
    const plan = calculateAnnualPlan(reloaded!, "2026-07", 12);

    expect(JSON.stringify(published)).toBe(JSON.stringify(built));
    expect(JSON.stringify(reloaded)).toBe(JSON.stringify(built));
    expect(result.status).toBe("created");
    expect(createCount).toBe(1);
    expect(await repository.documentCount()).toBe(1);
    expect({
      startDate: reloaded?.budgets[0]?.startDate,
      incomeMinor: reloaded?.budgets[0]?.plannedIncomeMinor,
      scheduledMinor: plan.currentMonth.scheduledExpenseMinor,
      flexibleMinor: plan.currentMonth.flexiblePlanMinor,
      spendableMinor: plan.currentMonth.spendableAfterPlanMinor,
      transactions: reloaded?.transactions.length,
      goals: reloaded?.goals.length,
      annualCommitments: reloaded?.annualCommitments.length,
      scheduledExpenses: reloaded?.scheduledExpenses.length,
    }).toEqual({
      startDate: "2026-07-01",
      incomeMinor: 18_000_000,
      scheduledMinor: 5_300_000,
      flexibleMinor: 5_300_000,
      spendableMinor: 7_400_000,
      transactions: 0,
      goals: 0,
      annualCommitments: 0,
      scheduledExpenses: 1,
    });
  });

  it("не публикует completed state, если атомарное сохранение завершилось ошибкой", async () => {
    const state = buildOnboardingBudgetState(acceptanceDraft());
    let published = false;
    const failedRepository = { createIfAbsent: async () => { throw new Error("Диск недоступен"); } };

    await expect(persistCompletedOnboarding(failedRepository, state, prepareBudgetState, () => { published = true; }))
      .rejects.toThrow("Диск недоступен");
    expect(published).toBe(false);
  });

  it("атомарно выбирает одного победителя для двух вкладок и не даёт проигравшей перезаписать бюджет", async () => {
    const name = databaseName("race");
    const firstRepository = createBudgetRepository({ databaseName: name });
    const secondRepository = createBudgetRepository({ databaseName: name });
    const firstCandidate = prepareBudgetState(buildOnboardingBudgetState({
      ...acceptanceDraft(),
      householdLabel: "Первая вкладка",
    }));
    const secondCandidate = prepareBudgetState(buildOnboardingBudgetState({
      ...acceptanceDraft(),
      householdLabel: "Вторая вкладка",
    }));
    let firstPublished = null as typeof firstCandidate | null;
    let secondPublished = null as typeof secondCandidate | null;

    const [firstResult, secondResult] = await Promise.all([
      persistCompletedOnboarding(firstRepository, firstCandidate, prepareBudgetState, (state) => { firstPublished = state; }),
      persistCompletedOnboarding(secondRepository, secondCandidate, prepareBudgetState, (state) => { secondPublished = state; }),
    ]);
    const results = [firstResult, secondResult];
    const created = results.find(({ status }) => status === "created")!;
    const losingCandidate = firstResult.status === "existing" ? firstCandidate : secondCandidate;
    const finalState = await firstRepository.load();

    expect(results.map(({ status }) => status).sort()).toEqual(["created", "existing"]);
    expect(JSON.stringify(finalState)).toBe(JSON.stringify(created.value));
    expect(JSON.stringify(firstPublished)).toBe(JSON.stringify(created.value));
    expect(JSON.stringify(secondPublished)).toBe(JSON.stringify(created.value));
    expect(JSON.stringify(finalState)).not.toBe(JSON.stringify(losingCandidate));
    expect(await firstRepository.documentCount()).toBe(1);
  });

  it("не публикует повреждённого победителя из другой вкладки", async () => {
    const repository = createBudgetRepository({ databaseName: databaseName("corrupt-existing") });
    const candidate = prepareBudgetState(buildOnboardingBudgetState(acceptanceDraft()));
    const corrupt = { ...candidate, activeBudgetId: crypto.randomUUID() };
    await repository.save(corrupt);
    let publishCount = 0;

    await expect(persistCompletedOnboarding(
      repository,
      candidate,
      prepareBudgetState,
      () => { publishCount += 1; },
    )).rejects.toThrow();

    expect(publishCount).toBe(0);
    expect(JSON.stringify(await repository.load())).toBe(JSON.stringify(corrupt));
    expect(await repository.documentCount()).toBe(1);
  });
});
