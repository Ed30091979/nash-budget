import "fake-indexeddb/auto";
import { calculateAnnualPlan } from "@family-budget/domain";
import { afterEach, describe, expect, it } from "vitest";
import { prepareBudgetState } from "../backup";
import { createBudgetRepository } from "../storage-repository";
import {
  buildOnboardingBudgetState,
  persistCompletedOnboarding,
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

/** Набор первого запуска 9 июля 2026: тот же месяц, что у канонического набора. */
function acceptancePreset(currency: "RUB" | "EUR" = "RUB") {
  return buildOnboardingBudgetState({ today: "2026-07-09", currency });
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

  it("записывает набор первого запуска один раз и после reload возвращает те же суммы и счётчики", async () => {
    const repository = createBudgetRepository({ databaseName: databaseName("complete") });
    const built = prepareBudgetState(acceptancePreset());
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
      incomeMinor: 0,
      scheduledMinor: 0,
      flexibleMinor: 0,
      spendableMinor: 0,
      transactions: 0,
      goals: 0,
      annualCommitments: 0,
      scheduledExpenses: 0,
    });
    expect(reloaded?.accounts.map((account) => account.name)).toEqual(["Карта", "Наличные"]);
  });

  it("не публикует completed state, если атомарное сохранение завершилось ошибкой", async () => {
    const state = acceptancePreset();
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
    // Две вкладки создают каждая свой набор: разные идентификаторы и разная валюта.
    const firstCandidate = prepareBudgetState(acceptancePreset("RUB"));
    const secondCandidate = prepareBudgetState(acceptancePreset("EUR"));
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
    const candidate = prepareBudgetState(acceptancePreset());
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
