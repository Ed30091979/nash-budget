/// <reference types="node" />
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { calculateAnnualPlan, type BudgetState } from "@family-budget/domain";
import { afterEach, describe, expect, it } from "vitest";
import { editFlexibleLine } from "./features/planning";
import { makeCanonicalPlanningState, makePlanningTestState, TEST_IDS } from "./features/planning/test-fixture";
import { createBudgetRepository } from "./storage-repository";
import { BUDGET_WRITE_CONFLICT_MESSAGE, createAppBudgetSaveCoordinator } from "./App";

const databaseNames = new Set<string>();

function databaseName(label: string): string {
  const name = `family-budget-app-planning-${label}-${crypto.randomUUID()}`;
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForLength(values: readonly unknown[], length: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (values.length >= length) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected ${length} queued saves, received ${values.length}.`);
}

function operationChange(id: string) {
  return (state: BudgetState): BudgetState => ({
    ...state,
    transactions: [...state.transactions, {
      id,
      occurredOn: "2026-07-18",
      status: "posted",
      kind: "expense",
      amountMinor: 123_400,
      accountId: TEST_IDS.account,
      categoryId: TEST_IDS.categories.children,
    }],
  });
}

function harness(
  repository: Pick<ReturnType<typeof createBudgetRepository>, "loadVersioned" | "saveIfRevision">,
  initial: BudgetState,
  initialRevision: string | null,
) {
  const view = {
    current: initial,
    revision: initialRevision as string | null,
    published: [] as Array<{ readonly state: BudgetState; readonly revision: string }>,
  };
  const coordinator = createAppBudgetSaveCoordinator({
    repository,
    getCurrent: () => view.current,
    getRevision: () => view.revision,
    setRevision: (revision) => { view.revision = revision; },
    publish: (state, revision) => {
      view.current = state;
      view.revision = revision;
      view.published.push({ state: structuredClone(state), revision });
    },
  });
  return { coordinator, view };
}

afterEach(async () => {
  await Promise.all([...databaseNames].map(deleteDatabase));
  databaseNames.clear();
});

describe("planning app integration", () => {
  it("wires active views, one CAS coordinator, strict CSP and no hidden persistence path", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

    expect(source).toContain('type Screen = "today" | "year" | "planning"');
    expect(source).toContain("Настроить план");
    expect(source).toContain("← К горизонту");
    expect(source).toContain('<PlanningScreen budget={budget} onChange={(change) => budgetSave.apply(change)} />');
    expect(source).toContain('active={screen === "year" || screen === "planning"}');
    expect(source).toContain("activeBudget.lines.filter((line) => line.active !== false)");
    expect(source).toContain("category.active && flexibleIds.has(category.id)");
    expect(source).toContain("annualCommitments.filter((item) => item.active)");
    expect(source).toContain("scheduledExpenses.filter((item) => item.active)");
    expect(source).toContain('budget.categories.filter((category) => category.active && category.type === "expense")');
    expect(source).toContain("repository.loadVersioned()");
    expect(source).toContain("repository.saveIfRevision(expectedRevision, candidate)");
    expect(source).not.toMatch(/commitBudget|repository\.save\(/);
    expect(source).toContain("(restored) => budgetSave.apply(() => restored).then(() => undefined)");
    expect(source).toContain("() => undefined,");
    expect(source).not.toMatch(/location\.|URLSearchParams|localStorage|sessionStorage/);
    expect(source.match(/makePlanningSeed\(\)/g)).toHaveLength(1);
    expect(styles).toMatch(/\.planning-entry \{[^}]*white-space: nowrap/s);
    expect(styles).toMatch(/\.month-checkboxes label \{[^}]*min-height: 44px/s);
    expect(styles).not.toMatch(/\sstyle\s*=/);
    expect(html).toContain("connect-src 'self'");
    expect(html).not.toMatch(/connect-src[^;]*(?:https?:|wss?:|\*)/u);
  });

  it("lazily acquires the onboarding revision, then CAS-saves and reloads the stored snapshot", async () => {
    const repository = createBudgetRepository({ databaseName: databaseName("lazy-revision") });
    const initial = makePlanningTestState();
    await repository.save(initial);
    const { coordinator, view } = harness(repository, initial, null);

    const saved = await coordinator.apply((state) => editFlexibleLine(
      state,
      TEST_IDS.lines[0],
      { name: "Детские покупки", amount: "12500" },
    ));
    const reloaded = await repository.loadVersioned();

    expect(view.published).toHaveLength(1);
    expect(view.revision).toBe(reloaded?.revision);
    expect(JSON.stringify(view.current)).toBe(JSON.stringify(saved));
    expect(JSON.stringify(reloaded?.value)).toBe(JSON.stringify(saved));
    expect(await repository.documentCount()).toBe(1);
  });

  it("publishes a different stored winner instead of applying a draft with no local revision", async () => {
    const repository = createBudgetRepository({ databaseName: databaseName("lazy-stale") });
    const winner = makePlanningTestState();
    await repository.save(winner);
    const stale = {
      ...winner,
      budgets: winner.budgets.map((item) => ({ ...item, plannedIncomeMinor: 19_000_000 })),
    };
    const { coordinator, view } = harness(repository, stale, null);

    await expect(coordinator.apply(operationChange("70000000-0000-4000-8000-000000000009")))
      .rejects.toThrow(BUDGET_WRITE_CONFLICT_MESSAGE);
    const reloaded = await repository.loadVersioned();

    expect(view.published).toHaveLength(1);
    expect(JSON.stringify(view.current)).toBe(JSON.stringify(winner));
    expect(JSON.stringify(reloaded?.value)).toBe(JSON.stringify(winner));
    expect(view.revision).toBe(reloaded?.revision);
    expect(view.current.transactions).toHaveLength(0);
  });

  it("serializes simultaneous planning and operation changes without losing either", async () => {
    const actualRepository = createBudgetRepository({ databaseName: databaseName("same-app") });
    const initial = makePlanningTestState();
    await actualRepository.save(initial);
    const snapshot = (await actualRepository.loadVersioned())!;
    const candidates: BudgetState[] = [];
    const gates = [deferred(), deferred()];
    const repository = {
      loadVersioned: () => actualRepository.loadVersioned(),
      async saveIfRevision(expectedRevision: string | null, state: BudgetState) {
        const index = candidates.length;
        candidates.push(structuredClone(state));
        await gates[index]!.promise;
        return actualRepository.saveIfRevision(expectedRevision, state);
      },
    };
    const { coordinator, view } = harness(repository, snapshot.value, snapshot.revision);

    const planning = coordinator.apply((state) => editFlexibleLine(state, TEST_IDS.lines[0], { name: "Детские покупки", amount: "12500" }));
    await waitForLength(candidates, 1);
    const operation = coordinator.apply(operationChange("70000000-0000-4000-8000-000000000001"));
    expect(view.published).toHaveLength(0);
    gates[0]!.resolve();
    await waitForLength(candidates, 2);
    expect(candidates[1]?.categories.find((item) => item.id === TEST_IDS.categories.children)?.name).toBe("Детские покупки");
    expect(candidates[1]?.transactions).toHaveLength(1);
    gates[1]!.resolve();
    await Promise.all([planning, operation]);

    const reloaded = await actualRepository.loadVersioned();
    expect(view.published).toHaveLength(2);
    expect(view.current.transactions).toHaveLength(1);
    expect(view.current.categories.find((item) => item.id === TEST_IDS.categories.children)?.name).toBe("Детские покупки");
    expect(JSON.stringify(reloaded?.value)).toBe(JSON.stringify(view.current));
    expect(reloaded?.revision).toBe(view.revision);
  });

  it("allows one of two tabs to save and makes the CAS loser publish the winner", async () => {
    const name = databaseName("two-tabs");
    const firstRepository = createBudgetRepository({ databaseName: name });
    const secondRepository = createBudgetRepository({ databaseName: name });
    await firstRepository.save(makePlanningTestState());
    const firstSnapshot = (await firstRepository.loadVersioned())!;
    const secondSnapshot = (await secondRepository.loadVersioned())!;
    const first = harness(firstRepository, firstSnapshot.value, firstSnapshot.revision);
    const second = harness(secondRepository, secondSnapshot.value, secondSnapshot.revision);

    const results = await Promise.allSettled([
      first.coordinator.apply((state) => editFlexibleLine(state, TEST_IDS.lines[0], { name: "Детские покупки", amount: "12500" })),
      second.coordinator.apply(operationChange("70000000-0000-4000-8000-000000000002")),
    ]);
    const rejected = results.find((result) => result.status === "rejected");
    const finalSnapshot = (await firstRepository.loadVersioned())!;

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({ message: BUDGET_WRITE_CONFLICT_MESSAGE });
    expect(JSON.stringify(first.view.current)).toBe(JSON.stringify(finalSnapshot.value));
    expect(JSON.stringify(second.view.current)).toBe(JSON.stringify(finalSnapshot.value));
    expect(first.view.revision).toBe(finalSnapshot.revision);
    expect(second.view.revision).toBe(finalSnapshot.revision);
    expect(await firstRepository.documentCount()).toBe(1);
  });

  it("orders planning before a restore replacement and stores the replacement byte-identically", async () => {
    const repository = createBudgetRepository({ databaseName: databaseName("restore") });
    await repository.save(makePlanningTestState());
    const snapshot = (await repository.loadVersioned())!;
    const { coordinator, view } = harness(repository, snapshot.value, snapshot.revision);
    const imported = {
      ...makePlanningTestState(),
      budgets: makePlanningTestState().budgets.map((item) => ({ ...item, plannedIncomeMinor: 20_000_000 })),
    };

    const planning = coordinator.apply((state) => editFlexibleLine(state, TEST_IDS.lines[0], { name: "Детские покупки", amount: "12500" }));
    const restore = coordinator.apply(() => imported);
    await Promise.all([planning, restore]);
    const reloaded = await repository.loadVersioned();

    expect(view.published).toHaveLength(2);
    expect(view.published[0]?.state.categories.find((item) => item.id === TEST_IDS.categories.children)?.name).toBe("Детские покупки");
    expect(JSON.stringify(view.current)).toBe(JSON.stringify(imported));
    expect(JSON.stringify(reloaded?.value)).toBe(JSON.stringify(imported));
    expect(reloaded?.revision).toBe(view.revision);
  });

  it("does not publish failed operation or restore saves", async () => {
    const initial = makePlanningTestState();
    const repository = {
      async loadVersioned() { return { value: initial, revision: "10000000-0000-4000-8000-000000000099" }; },
      async saveIfRevision(): Promise<never> { throw new Error("private storage detail"); },
    };
    const operation = harness(repository, initial, "10000000-0000-4000-8000-000000000099");
    const restore = harness(repository, initial, "10000000-0000-4000-8000-000000000099");
    const imported = { ...initial, budgets: initial.budgets.map((item) => ({ ...item, plannedIncomeMinor: 21_000_000 })) };

    await expect(operation.coordinator.apply(operationChange("70000000-0000-4000-8000-000000000003"))).rejects.toThrow("private storage detail");
    await expect(restore.coordinator.apply(() => imported)).rejects.toThrow("private storage detail");
    expect(operation.view.published).toHaveLength(0);
    expect(restore.view.published).toHaveLength(0);
    expect(operation.view.current).toBe(initial);
    expect(restore.view.current).toBe(initial);
  });

  it("round-trips the exact canonical 24-month plan through the CAS path", async () => {
    const repository = createBudgetRepository({ databaseName: databaseName("canonical") });
    const canonical = makeCanonicalPlanningState();
    await repository.save(canonical);
    const snapshot = (await repository.loadVersioned())!;
    const { coordinator, view } = harness(repository, snapshot.value, snapshot.revision);
    await coordinator.apply((state) => state);
    const reloaded = (await repository.loadVersioned())!;
    const plan = calculateAnnualPlan(reloaded.value, "2026-07", 24);

    expect(JSON.stringify(reloaded.value)).toBe(JSON.stringify(view.current));
    expect({ accounts: reloaded.value.accounts.length, categories: reloaded.value.categories.length, budgets: reloaded.value.budgets.length, lines: reloaded.value.budgets[0]?.lines.length, goals: reloaded.value.goals.length, commitments: reloaded.value.annualCommitments.length, schedules: reloaded.value.scheduledExpenses.length, transactions: reloaded.value.transactions.length }).toEqual({ accounts: 1, categories: 4, budgets: 1, lines: 3, goals: 0, commitments: 3, schedules: 3, transactions: 0 });
    expect(plan.months[0]).toMatchObject({ month: "2026-07", annualReserveMinor: 1_980_900, spendableAfterPlanMinor: 5_419_100 });
    expect(plan.months[2]).toMatchObject({ month: "2026-09", seasonalExpenseMinor: 3_100_000, spendableAfterPlanMinor: 2_319_100 });
    expect(plan.months.find((item) => item.month === "2027-01")?.annualDueMinor).toBe(7_200_000);
    expect(plan.months.find((item) => item.month === "2028-01")?.annualDueMinor).toBe(7_200_000);
    expect(plan.months.find((item) => item.month === "2027-06")?.annualDueMinor).toBe(9_000_000);
    expect(plan.months.find((item) => item.month === "2028-06")?.annualDueMinor).toBe(0);
  });
});
