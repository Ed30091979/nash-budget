import "fake-indexeddb/auto";
import { calculateAnnualPlan } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import { createPlanningSaveCoordinator, editFlexibleLine } from "./model";
import { createBudgetRepository } from "../../storage-repository";
import { makeCanonicalPlanningState, makePlanningTestState, TEST_IDS } from "./test-fixture";

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe("planning persistence", () => {
  it("saves before publish and reloads byte-identical entity counts and values", async () => {
    let current = makePlanningTestState();
    let stored = current;
    const order: string[] = [];
    const coordinator = createPlanningSaveCoordinator({
      repository: { async save(state) { order.push("save"); stored = structuredClone(state); } },
      getCurrent: () => current,
      prepare: (state) => structuredClone(state),
      publish: (state) => { order.push("publish"); current = state; },
    });
    await coordinator.apply((state) => editFlexibleLine(state, TEST_IDS.lines[0], { name: "Детские покупки", amount: "12500" }));
    expect(order).toEqual(["save", "publish"]);
    expect(JSON.stringify(stored)).toBe(JSON.stringify(current));
    expect({ accounts: stored.accounts.length, categories: stored.categories.length, lines: stored.budgets[0]?.lines.length, transactions: stored.transactions.length }).toEqual({ accounts: 1, categories: 4, lines: 3, transactions: 0 });
  });

  it("does not publish a failed save and serializes rapid edits without lost updates", async () => {
    let current = makePlanningTestState();
    let saveCount = 0;
    const coordinator = createPlanningSaveCoordinator({
      repository: { async save() { saveCount += 1; if (saveCount === 1) throw new Error("disk"); } },
      getCurrent: () => current,
      prepare: (state) => state,
      publish: (state) => { current = state; },
    });
    await expect(coordinator.apply((state) => editFlexibleLine(state, TEST_IDS.lines[0], { name: "Не сохранено", amount: "12000" }))).rejects.toThrow("disk");
    expect(current.categories.find((item) => item.id === TEST_IDS.categories.children)?.name).toBe("Дети");
    const first = coordinator.apply((state) => editFlexibleLine(state, TEST_IDS.lines[0], { name: "Детские покупки", amount: "12000" }));
    const second = coordinator.apply((state) => editFlexibleLine(state, TEST_IDS.lines[1], { name: "Проезд", amount: "9000" }));
    await Promise.all([first, second]);
    expect(current.categories.find((item) => item.id === TEST_IDS.categories.children)?.name).toBe("Детские покупки");
    expect(current.categories.find((item) => item.id === TEST_IDS.categories.transport)?.name).toBe("Проезд");
    expect(coordinator.locked).toBe(false);
  });

  it("round-trips the complete canonical plan through production IndexedDB byte-identically", async () => {
    const databaseName = `family-budget-planning-${crypto.randomUUID()}`;
    try {
      const before = makeCanonicalPlanningState();
      const beforeText = JSON.stringify(before);
      const repository = createBudgetRepository({ databaseName });
      await repository.save(before);
      const loaded = await repository.load();
      expect(JSON.stringify(loaded)).toBe(beforeText);
      expect({
        accounts: loaded?.accounts.length,
        categories: loaded?.categories.length,
        budgets: loaded?.budgets.length,
        lines: loaded?.budgets[0]?.lines.length,
        goals: loaded?.goals.length,
        commitments: loaded?.annualCommitments.length,
        schedules: loaded?.scheduledExpenses.length,
        transactions: loaded?.transactions.length,
      }).toEqual({ accounts: 1, categories: 4, budgets: 1, lines: 3, goals: 0, commitments: 3, schedules: 3, transactions: 0 });

      const plan = calculateAnnualPlan(loaded!, "2026-07", 24);
      expect(plan.months[0]).toMatchObject({ annualReserveMinor: 1_980_900, spendableAfterPlanMinor: 5_419_100 });
      expect(plan.months[2]).toMatchObject({ seasonalExpenseMinor: 3_100_000, spendableAfterPlanMinor: 2_319_100 });
      expect(plan.months.find((item) => item.month === "2027-01")?.annualDueMinor).toBe(7_200_000);
      expect(plan.months.find((item) => item.month === "2028-01")?.annualDueMinor).toBe(7_200_000);
      expect(plan.months.find((item) => item.month === "2027-06")?.annualDueMinor).toBe(9_000_000);
      expect(plan.months.find((item) => item.month === "2028-06")?.annualDueMinor).toBe(0);
      expect(await repository.documentCount()).toBe(1);
    } finally {
      await deleteDatabase(databaseName);
    }
  });
});
