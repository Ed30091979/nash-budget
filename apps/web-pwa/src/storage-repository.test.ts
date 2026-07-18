import "fake-indexeddb/auto";
import { calculateBudget, makePlanningSeed, type BudgetState } from "@family-budget/domain";
import { G001, toDomainBudgetState } from "@family-budget/test-fixtures";
import { serializeBackup } from "@family-budget/storage";
import { afterEach, describe, expect, it } from "vitest";
import { parseAndValidateBudgetBackup } from "./backup";
import { createBudgetRepository } from "./storage-repository";

const databaseNames = new Set<string>();

interface V1Document {
  readonly key: string;
  readonly schemaVersion: 1;
  readonly updatedAt: string;
  readonly value: unknown;
}

type LegacyBudgetState = Omit<BudgetState, "annualCommitments" | "scheduledExpenses">;

function databaseName(label: string): string {
  const value = `family-budget-web-${label}-${crypto.randomUUID()}`;
  databaseNames.add(value);
  return value;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function createV1(name: string, documents: readonly V1Document[]): Promise<void> {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore("documents", { keyPath: "key" });
  const database = await requestResult(request);
  const transaction = database.transaction("documents", "readwrite");
  for (const document of documents) transaction.objectStore("documents").put(document);
  await transactionComplete(transaction);
  database.close();
}

async function readDocuments(name: string, version: number): Promise<unknown[]> {
  const database = await requestResult(indexedDB.open(name, version));
  const values = await requestResult(
    database.transaction("documents", "readonly").objectStore("documents").getAll(),
  );
  database.close();
  return values;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function makeLegacyState(): LegacyBudgetState {
  const { annualCommitments: _annualCommitments, scheduledExpenses: _scheduledExpenses, ...legacy } = makePlanningSeed();
  return legacy;
}

function v1Document(key: string, value: unknown): V1Document {
  return {
    key,
    schemaVersion: 1,
    updatedAt: "2026-07-17T12:00:00.000Z",
    value,
  };
}

afterEach(async () => {
  await Promise.all([...databaseNames].map(deleteDatabase));
  databaseNames.clear();
});

describe("production budget repository migration", () => {
  it("нормализует v1 в production path и сохраняет сумму 12 345 minor units", async () => {
    const name = databaseName("valid-v1");
    const legacy = makeLegacyState();
    const value = {
      ...legacy,
      transactions: legacy.transactions.map((transaction, index) => (
        index === 0 ? { ...transaction, amountMinor: 12_345 } : transaction
      )),
    };
    await createV1(name, [v1Document("active-budget", value)]);

    const repository = createBudgetRepository({ databaseName: name });
    const migrated = await repository.load();

    expect(migrated?.transactions[0]?.amountMinor).toBe(12_345);
    expect(migrated?.annualCommitments).toEqual([]);
    expect(migrated?.scheduledExpenses).toEqual([]);
    expect(await repository.documentCount()).toBe(1);
    expect(await readDocuments(name, 2)).toEqual([
      expect.objectContaining({
        key: "active-budget",
        schemaVersion: 2,
        value: expect.objectContaining({ annualCommitments: [], scheduledExpenses: [] }),
      }),
    ]);
  });

  it.each([
    {
      label: "fractional-money",
      corrupt: (state: LegacyBudgetState) => ({
        ...state,
        budgets: state.budgets.map((budget, index) => (
          index === 0 ? { ...budget, plannedIncomeMinor: 12.5 } : budget
        )),
      }),
    },
    {
      label: "bad-uuid",
      corrupt: (state: LegacyBudgetState) => ({
        ...state,
        transactions: state.transactions.map((transaction, index) => (
          index === 0 ? { ...transaction, id: "broken-uuid" } : transaction
        )),
      }),
    },
  ])("полностью откатывает два v1 документа при $label", async ({ label, corrupt }) => {
    const name = databaseName(label);
    const originals = [
      v1Document("active-budget", makeLegacyState()),
      v1Document("second", corrupt(makeLegacyState())),
    ];
    const before = JSON.stringify(originals);
    await createV1(name, originals);

    const repository = createBudgetRepository({ databaseName: name });
    await expect(repository.load()).rejects.toThrow(/открыть или обновить/);

    expect(JSON.stringify(await readDocuments(name, 1))).toBe(before);
  });
});

describe("canonical projected BudgetState recovery", () => {
  it("round-trip сохраняет проекцию G-001 и её расчёт без подмены raw canonical model", async () => {
    const name = databaseName("g001-projected-round-trip");
    // Adapter projection is the production BudgetState. Raw household/member/movement/split fields remain canonical-only.
    const projected: BudgetState = toDomainBudgetState(G001);
    const before = JSON.stringify(projected);
    const text = serializeBackup(projected, { createdAt: "2026-07-17T12:00:00.000Z" });

    const parsed = parseAndValidateBudgetBackup(text);
    expect(JSON.stringify(parsed)).toBe(before);

    const repository = createBudgetRepository({ databaseName: name });
    const restored = await repository.restore(text, parseAndValidateBudgetBackup);
    const loaded = await repository.load();

    expect(JSON.stringify(restored)).toBe(before);
    expect(JSON.stringify(loaded)).toBe(before);
    expect({
      accounts: loaded?.accounts.length,
      categories: loaded?.categories.length,
      budgets: loaded?.budgets.length,
      budgetLines: loaded?.budgets.reduce((total, budget) => total + budget.lines.length, 0),
      goals: loaded?.goals.length,
      annualCommitments: loaded?.annualCommitments.length,
      scheduledExpenses: loaded?.scheduledExpenses.length,
      transactions: loaded?.transactions.length,
    }).toEqual({
      accounts: 2,
      categories: 3,
      budgets: 1,
      budgetLines: 3,
      goals: 1,
      annualCommitments: 0,
      scheduledExpenses: 0,
      transactions: 5,
    });
    expect(loaded?.accounts.map(({ id }) => id)).toEqual(projected.accounts.map(({ id }) => id));
    expect(loaded?.budgets.map(({ id, startDate, endDate, plannedIncomeMinor }) => ({ id, startDate, endDate, plannedIncomeMinor }))).toEqual(
      projected.budgets.map(({ id, startDate, endDate, plannedIncomeMinor }) => ({ id, startDate, endDate, plannedIncomeMinor })),
    );
    expect(loaded?.transactions.map(({ id, occurredOn, amountMinor }) => ({ id, occurredOn, amountMinor }))).toEqual(
      projected.transactions.map(({ id, occurredOn, amountMinor }) => ({ id, occurredOn, amountMinor })),
    );

    const metrics = calculateBudget(loaded!);
    expect({
      incomeMinor: metrics.incomeMinor,
      expensesMinor: metrics.expensesMinor,
      capitalMinor: metrics.capitalMinor,
    }).toEqual({
      incomeMinor: 10_000_000,
      expensesMinor: 7_650_000,
      capitalMinor: 2_350_000,
    });
    expect(await repository.documentCount()).toBe(1);
  });
});
