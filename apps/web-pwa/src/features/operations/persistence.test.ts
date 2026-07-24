import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createBudgetRepository } from "../../storage-repository";
import {
  archiveCategory,
  calculateOperationsMetrics,
  createOperationsSaveCoordinator,
  createTransaction,
} from "./model";
import { makeG000State, OPERATIONS_TEST_IDS as ids } from "./test-fixture";

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe("operations persistence", () => {
  it("round-trips an atomic transfer and contribution through production IndexedDB", async () => {
    const databaseName = `family-budget-operations-${crypto.randomUUID()}`;
    try {
      const repository = createBudgetRepository({ databaseName });
      let state = makeG000State();
      state = createTransaction(state, {
        kind: "transfer", status: "posted", occurredOn: "2026-07-07", amount: "5000",
        fromAccountId: ids.accounts.main, toAccountId: ids.accounts.savings,
      }, () => "77000000-0000-4000-8000-000000000001");
      state = createTransaction(state, {
        kind: "goal_contribution", status: "posted", occurredOn: "2026-07-08", amount: "1000",
        fromAccountId: ids.accounts.main, toAccountId: ids.accounts.savings, goalId: ids.goal,
      }, () => "77000000-0000-4000-8000-000000000002");
      expect(state.transactions).toHaveLength(6);
      await repository.save(state);
      const loaded = await repository.load();
      expect(JSON.stringify(loaded)).toBe(JSON.stringify(state));
      expect(await repository.documentCount()).toBe(1);
      const metrics = calculateOperationsMetrics(loaded!);
      expect(metrics).toMatchObject({ expensesMinor: 7_650_000, capitalMinor: 2_350_000, goalContributionMinor: 100_000 });
      expect(metrics.accountBalancesMinor).toMatchObject({ [ids.accounts.main]: 1_750_000, [ids.accounts.savings]: 600_000 });
      expect(metrics.goalContributionsMinor[ids.goal]).toBe(100_000);
    } finally {
      await deleteDatabase(databaseName);
    }
  });

  it("saves before publish, validates queued changes against fresh state, and does not publish failures", async () => {
    let current = makeG000State();
    let durable = current;
    const order: string[] = [];
    let failNext = false;
    const coordinator = createOperationsSaveCoordinator({
      repository: {
        async save(state) {
          order.push("save");
          if (failNext) { failNext = false; throw new Error("disk"); }
          durable = structuredClone(state);
        },
      },
      getCurrent: () => current,
      prepare: (state) => structuredClone(state),
      publish: (state) => { order.push("publish"); current = state; },
    });

    const beforeBlockedArchive = JSON.stringify(current);
    await expect(
      coordinator.apply((state) => archiveCategory(state, ids.categories.products)),
    ).rejects.toThrow("Сначала отключите активные лимиты");
    expect(order).toEqual([]);
    expect(JSON.stringify(current)).toBe(beforeBlockedArchive);
    expect(JSON.stringify(durable)).toBe(beforeBlockedArchive);
    expect(current.categories.find((item) => item.id === ids.categories.products)?.active).toBe(true);
    expect(coordinator.locked).toBe(false);

    await coordinator.apply((state) => ({
      ...state,
      budgets: state.budgets.map((budget) => ({
        ...budget,
        lines: budget.lines.map((line) => line.categoryId === ids.categories.products
          ? { ...line, active: false }
          : line),
      })),
    }));
    const archive = coordinator.apply((state) => archiveCategory(state, ids.categories.products));
    const staleCreate = coordinator.apply((state) => createTransaction(state, {
      kind: "expense", status: "posted", occurredOn: "2026-07-09", amount: "1",
      accountId: ids.accounts.main, categoryId: ids.categories.products,
    }, () => "77000000-0000-4000-8000-000000000001"));
    await archive;
    await expect(staleCreate).rejects.toThrow("активную категорию");
    expect(order).toEqual(["save", "publish", "save", "publish"]);
    expect(JSON.stringify(durable)).toBe(JSON.stringify(current));
    expect(current.transactions).toHaveLength(4);

    const beforeFailure = JSON.stringify(current);
    failNext = true;
    await expect(coordinator.apply((state) => createTransaction(state, {
      kind: "income", status: "posted", occurredOn: "2026-07-10", amount: "100",
      accountId: ids.accounts.main,
    }, () => "77000000-0000-4000-8000-000000000002"))).rejects.toThrow("disk");
    expect(JSON.stringify(current)).toBe(beforeFailure);
    expect(coordinator.locked).toBe(false);
  });

  it("serializes rapid independent mutations without losing the first result", async () => {
    let current = makeG000State();
    const coordinator = createOperationsSaveCoordinator({
      repository: { async save() {} },
      getCurrent: () => current,
      prepare: (state) => state,
      publish: (state) => { current = state; },
    });
    const income = coordinator.apply((state) => createTransaction(state, {
      kind: "income", status: "posted", occurredOn: "2026-07-09", amount: "100",
      accountId: ids.accounts.main,
    }, () => "77000000-0000-4000-8000-000000000001"));
    const transfer = coordinator.apply((state) => createTransaction(state, {
      kind: "transfer", status: "posted", occurredOn: "2026-07-10", amount: "50",
      fromAccountId: ids.accounts.main, toAccountId: ids.accounts.savings,
    }, () => "77000000-0000-4000-8000-000000000002"));
    await Promise.all([income, transfer]);
    expect(current.transactions).toHaveLength(6);
    expect(calculateOperationsMetrics(current).accountBalancesMinor).toMatchObject({
      [ids.accounts.main]: 2_355_000,
      [ids.accounts.savings]: 5_000,
    });
  });
});
