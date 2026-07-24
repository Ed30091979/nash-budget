/// <reference types="node" />
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { calculateBudget, type BudgetState } from "@family-budget/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTransaction,
  deleteTransaction,
  editTransaction,
} from "./features/operations";
import {
  makeG000State,
  OPERATIONS_TEST_IDS as ids,
} from "./features/operations/test-fixture";
import { editFlexibleLine } from "./features/planning";
import { createBudgetRepository } from "./storage-repository";
import {
  BUDGET_WRITE_CONFLICT_MESSAGE,
  createAppBudgetSaveCoordinator,
} from "./App";

const databaseNames = new Set<string>();

function databaseName(label: string): string {
  const name = `family-budget-app-operations-${label}-${crypto.randomUUID()}`;
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

const refundDraft = {
  kind: "refund",
  status: "posted",
  occurredOn: "2026-07-07",
  amount: "1500",
  accountId: ids.accounts.main,
  originalTransactionId: ids.transactions.products,
} as const;

const transferDraft = (amount: string) => ({
  kind: "transfer" as const,
  status: "posted" as const,
  occurredOn: "2026-07-08",
  amount,
  fromAccountId: ids.accounts.main,
  toAccountId: ids.accounts.savings,
});

afterEach(async () => {
  await Promise.all([...databaseNames].map(deleteDatabase));
  databaseNames.clear();
});

describe("operations app integration", () => {
  it("uses the full operations screen and the shared durable CAS coordinator", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(source).toContain('import { OperationsScreen } from "./features/operations"');
    expect(source).toContain('<OperationsScreen budget={budget} onChange={(change) => budgetSave.apply(change)} onDirtyChange={setOperationDraftDirty} />');
    expect(source).toContain("<UpdatePrompt hasUnsavedChanges={operationDraftDirty || planningDraftDirty} />");
    expect(source).toContain('<PlanningScreen budget={budget} onChange={(change) => budgetSave.apply(change)} onDirtyChange={setPlanningDraftDirty} />');
    expect(source).toContain("(restored) => budgetSave.apply(() => restored).then(() => undefined)");
    expect(source).toContain(".slice(0, 5)");
    expect(source).not.toMatch(/entryKind|entryAmount|entryCategoryId|addTransaction/);
    expect(source).not.toMatch(/commitBudget|repository\.save\(/);
    expect(styles).toMatch(/\.operations-screen/);
    expect(styles).not.toMatch(/\sstyle\s*=/);
  });

  it("persists every exact G-000 step with one document and a new revision", async () => {
    const repository = createBudgetRepository({ databaseName: databaseName("canonical-flow") });
    const initial = makeG000State();
    await repository.save(initial);
    const first = (await repository.loadVersioned())!;
    const { coordinator, view } = harness(repository, first.value, first.revision);
    const observedRevisions = [first.revision];
    const refundId = "77000000-0000-4000-8000-000000000001";
    const transferId = "77000000-0000-4000-8000-000000000002";

    let metrics = calculateBudget(first.value);
    expect(first.value.transactions).toHaveLength(4);
    expect(metrics).toMatchObject({
      incomeMinor: 10_000_000,
      expensesMinor: 7_650_000,
      capitalMinor: 2_350_000,
    });

    const verifyStored = async () => {
      const reloaded = (await repository.loadVersioned())!;
      expect(JSON.stringify(reloaded.value)).toBe(JSON.stringify(view.current));
      expect(reloaded.revision).toBe(view.revision);
      expect(await repository.documentCount()).toBe(1);
      expect(observedRevisions).not.toContain(reloaded.revision);
      observedRevisions.push(reloaded.revision);
      return reloaded.value;
    };

    await coordinator.apply((state) => createTransaction(state, refundDraft, () => refundId));
    let stored = await verifyStored();
    metrics = calculateBudget(stored);
    expect(stored.transactions).toHaveLength(5);
    expect(metrics).toMatchObject({
      expensesMinor: 7_500_000,
      capitalMinor: 2_500_000,
    });
    expect(metrics.categoryMetrics[ids.categories.products]).toMatchObject({
      actualMinor: 3_000_000,
      status: "exhausted",
    });

    await coordinator.apply((state) => createTransaction(state, transferDraft("5000"), () => transferId));
    stored = await verifyStored();
    metrics = calculateBudget(stored);
    expect(stored.transactions).toHaveLength(6);
    expect(metrics.accountBalancesMinor).toMatchObject({
      [ids.accounts.main]: 2_000_000,
      [ids.accounts.savings]: 500_000,
    });

    await coordinator.apply((state) => editTransaction(state, transferId, transferDraft("7000")));
    stored = await verifyStored();
    metrics = calculateBudget(stored);
    expect(stored.transactions).toHaveLength(6);
    expect(metrics.accountBalancesMinor).toMatchObject({
      [ids.accounts.main]: 1_800_000,
      [ids.accounts.savings]: 700_000,
    });

    await coordinator.apply((state) => deleteTransaction(state, transferId));
    stored = await verifyStored();
    metrics = calculateBudget(stored);
    expect(stored.transactions).toHaveLength(5);
    expect(metrics).toMatchObject({
      expensesMinor: 7_500_000,
      capitalMinor: 2_500_000,
    });
    expect(metrics.accountBalancesMinor).toMatchObject({
      [ids.accounts.main]: 2_500_000,
      [ids.accounts.savings]: 0,
    });
    expect(new Set(observedRevisions).size).toBe(5);
  });

  it("serializes a planning edit before an operation without optimistic publication", async () => {
    const actualRepository = createBudgetRepository({ databaseName: databaseName("same-app") });
    await actualRepository.save(makeG000State());
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

    const planning = coordinator.apply((state) => editFlexibleLine(
      state,
      ids.lines.products,
      { name: "Продукты и быт", amount: "32000" },
    ));
    await waitForLength(candidates, 1);
    const operation = coordinator.apply((state) => createTransaction(
      state,
      refundDraft,
      () => "77000000-0000-4000-8000-000000000003",
    ));
    expect(view.published).toHaveLength(0);
    gates[0]!.resolve();
    await waitForLength(candidates, 2);
    expect(candidates[1]?.categories.find((item) => item.id === ids.categories.products)?.name).toBe("Продукты и быт");
    expect(candidates[1]?.transactions).toHaveLength(5);
    gates[1]!.resolve();
    await Promise.all([planning, operation]);

    const reloaded = (await actualRepository.loadVersioned())!;
    expect(view.published).toHaveLength(2);
    expect(view.current.categories.find((item) => item.id === ids.categories.products)?.name).toBe("Продукты и быт");
    expect(view.current.transactions).toHaveLength(5);
    expect(JSON.stringify(reloaded.value)).toBe(JSON.stringify(view.current));
    expect(reloaded.revision).toBe(view.revision);
  });

  it("makes one of two tabs the winner and publishes it in the CAS loser", async () => {
    const name = databaseName("two-tabs");
    const firstRepository = createBudgetRepository({ databaseName: name });
    const secondRepository = createBudgetRepository({ databaseName: name });
    await firstRepository.save(makeG000State());
    const firstSnapshot = (await firstRepository.loadVersioned())!;
    const secondSnapshot = (await secondRepository.loadVersioned())!;
    const first = harness(firstRepository, firstSnapshot.value, firstSnapshot.revision);
    const second = harness(secondRepository, secondSnapshot.value, secondSnapshot.revision);

    const results = await Promise.allSettled([
      first.coordinator.apply((state) => editFlexibleLine(
        state,
        ids.lines.products,
        { name: "Продукты и быт", amount: "32000" },
      )),
      second.coordinator.apply((state) => createTransaction(
        state,
        refundDraft,
        () => "77000000-0000-4000-8000-000000000004",
      )),
    ]);
    const finalSnapshot = (await firstRepository.loadVersioned())!;

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null)
      .toMatchObject({ message: BUDGET_WRITE_CONFLICT_MESSAGE });
    expect(JSON.stringify(first.view.current)).toBe(JSON.stringify(finalSnapshot.value));
    expect(JSON.stringify(second.view.current)).toBe(JSON.stringify(finalSnapshot.value));
    expect(first.view.revision).toBe(finalSnapshot.revision);
    expect(second.view.revision).toBe(finalSnapshot.revision);
    expect(await firstRepository.documentCount()).toBe(1);
  });

  it("does not publish a failed operation and leaves its input state untouched", async () => {
    const initial = makeG000State();
    const repository = {
      async loadVersioned() {
        return { value: initial, revision: "10000000-0000-4000-8000-000000000099" };
      },
      async saveIfRevision(): Promise<never> {
        throw new Error("private storage detail");
      },
    };
    const { coordinator, view } = harness(
      repository,
      initial,
      "10000000-0000-4000-8000-000000000099",
    );

    await expect(coordinator.apply((state) => createTransaction(
      state,
      refundDraft,
      () => "77000000-0000-4000-8000-000000000005",
    ))).rejects.toThrow("private storage detail");
    expect(view.published).toHaveLength(0);
    expect(view.current).toBe(initial);
    expect(view.current.transactions).toHaveLength(4);
  });
});
