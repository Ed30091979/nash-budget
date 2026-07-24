/// <reference types="node" />
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import {
  calculateBudget,
  makePlanningSeed,
  type BudgetState,
} from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBudgetBackup, restoreBudgetBackup } from "./backup";
import {
  createOperationsCsv,
  prepareOperationsCsvDownload,
} from "./features/data-management";
import {
  createRecoveryActionGate,
  downloadThenRecordSuccessfulBackup,
  persistThenPublishEmpty,
} from "./features/data-management/recovery";
import {
  createDashboardModel,
  DashboardScreen,
  OperationsSearch,
  searchOperations,
} from "./features/dashboard";
import {
  makeG000State,
  OPERATIONS_TEST_IDS,
} from "./features/operations/test-fixture";
import { createBudgetRepository } from "./storage-repository";
import { createAppBudgetSaveCoordinator } from "./App";

const databaseNames = new Set<string>();

function databaseName(label: string): string {
  const name = `family-budget-phase7-${label}-${crypto.randomUUID()}`;
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

function sixOperationState(): BudgetState {
  const source = makeG000State();
  return {
    ...source,
    transactions: [
      ...source.transactions,
      {
        id: "97555555-5555-4555-8555-555555555551",
        occurredOn: "2026-07-07",
        status: "posted",
        kind: "refund",
        amountMinor: 150_000,
        accountId: OPERATIONS_TEST_IDS.accounts.main,
        categoryId: OPERATIONS_TEST_IDS.categories.products,
        originalTransactionId: OPERATIONS_TEST_IDS.transactions.products,
      },
      {
        id: "97555555-5555-4555-8555-555555555552",
        occurredOn: "2026-07-08",
        status: "posted",
        kind: "transfer",
        amountMinor: 500_000,
        fromAccountId: OPERATIONS_TEST_IDS.accounts.main,
        toAccountId: OPERATIONS_TEST_IDS.accounts.savings,
      },
    ],
  };
}

function coordinatorHarness(
  repository: Pick<ReturnType<typeof createBudgetRepository>, "loadVersioned" | "saveIfRevision">,
  initial: BudgetState,
  initialRevision: string,
) {
  const view = {
    current: initial,
    revision: initialRevision,
    published: [] as BudgetState[],
  };
  const coordinator = createAppBudgetSaveCoordinator({
    repository,
    getCurrent: () => view.current,
    getRevision: () => view.revision,
    setRevision: (revision) => { view.revision = revision; },
    publish: (state, revision) => {
      view.current = state;
      view.revision = revision;
      view.published.push(structuredClone(state));
    },
  });
  return { coordinator, view };
}

afterEach(async () => {
  await Promise.all([...databaseNames].map(deleteDatabase));
  databaseNames.clear();
});

describe("phase 7 App composition", () => {
  it("renders G-002 dashboard on Year and keeps planning and search in their intended routes", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const dashboard = renderToStaticMarkup(
      <DashboardScreen budget={makePlanningSeed()} startMonth="2026-07" />,
    ).replaceAll("\u00a0", " ");
    const operations = renderToStaticMarkup(<OperationsSearch budget={sixOperationState()} />);
    const twelve = createDashboardModel(makePlanningSeed(), "2026-07", 12);
    const twentyFour = createDashboardModel(makePlanningSeed(), "2026-07", 24);

    expect(source).toContain('import { DashboardScreen, OperationsSearch } from "./features/dashboard"');
    expect(source).toContain("<DashboardScreen budget={budget} />");
    expect(source).toContain("Настроить план");
    expect(source).toMatch(/screen === "operations"[\s\S]*<OperationsScreen[\s\S]*<OperationsSearch budget=\{budget\}/);
    expect(source).not.toMatch(/screen === "year"[\s\S]{0,300}<OperationsSearch/);
    expect(source.match(/const budgetSave = useMemo\(\(\) => createAppBudgetSaveCoordinator/g)).toHaveLength(1);
    expect(source).not.toMatch(/repository\.save\(/);

    expect(twelve.months).toHaveLength(12);
    expect(twentyFour.months).toHaveLength(24);
    expect(twentyFour.months.slice(0, 12)).toEqual(twelve.months);
    expect(twentyFour.months.find((item) => item.month === "2027-01")?.annualDueMinor).toBe(7_200_000);
    expect(twentyFour.months.find((item) => item.month === "2027-06")?.annualDueMinor).toBe(9_000_000);
    expect(twentyFour.months.find((item) => item.month === "2028-01")?.annualDueMinor).toBe(7_200_000);
    expect(twentyFour.months.find((item) => item.month === "2028-06")?.annualDueMinor).toBe(0);
    expect(dashboard.match(/class="dashboard-month-card"/g)).toHaveLength(12);
    expect(dashboard).toContain("Доход, факт</span><strong>180 000");
    expect(dashboard).toContain("Расходы, факт</span><strong>71 000");
    expect(dashboard).toContain("Капитал</span><strong>124 000");
    expect(dashboard).toContain("Повседневные, факт</span><strong>26 000");
    expect(dashboard).toContain("Остаток повседневного лимита</span><strong>27 000");
    expect(operations).toContain("Найдено операций: <strong>6</strong> из 6");
  });

  it("round-trips the canonical six-operation backup through the shared CAS path exactly", async () => {
    const source = sixOperationState();
    const sourceRepository = createBudgetRepository({ databaseName: databaseName("backup-source") });
    await sourceRepository.save(source);
    const createdAt = "2026-07-24T09:10:11.000Z";
    const backup = await createBudgetBackup(
      source,
      async () => undefined,
      { createdAt },
    );
    expect(await sourceRepository.getLastSuccessfulBackup()).toBeNull();
    const backupOrder: string[] = [];
    await downloadThenRecordSuccessfulBackup(
      backup,
      () => { backupOrder.push("download"); },
      async (value) => {
        backupOrder.push("persist");
        await sourceRepository.setLastSuccessfulBackup(value);
      },
    );

    const targetRepository = createBudgetRepository({ databaseName: databaseName("backup-target") });
    await targetRepository.save(makeG000State());
    const target = (await targetRepository.loadVersioned())!;
    const { coordinator, view } = coordinatorHarness(targetRepository, target.value, target.revision);
    const restored = await restoreBudgetBackup(
      {
        size: new Blob([backup.text]).size,
        text: async () => backup.text,
      },
      (state) => coordinator.apply(() => state).then(() => undefined),
      () => undefined,
    );
    const reloaded = (await targetRepository.loadVersioned())!;
    const metrics = calculateBudget(reloaded.value);

    expect(backup.createdAt).toBe(createdAt);
    expect(backupOrder).toEqual(["download", "persist"]);
    expect(await sourceRepository.getLastSuccessfulBackup()).toBe(createdAt);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(source));
    expect(JSON.stringify(reloaded.value)).toBe(JSON.stringify(source));
    expect(JSON.stringify(view.current)).toBe(JSON.stringify(source));
    expect(view.published).toHaveLength(1);
    expect(reloaded.value.transactions.map((item) => [item.id, item.occurredOn, item.amountMinor]))
      .toEqual(source.transactions.map((item) => [item.id, item.occurredOn, item.amountMinor]));
    expect(reloaded.value.transactions.slice(-2)).toEqual([
      expect.objectContaining({
        id: "97555555-5555-4555-8555-555555555551",
        occurredOn: "2026-07-07",
        amountMinor: 150_000,
        originalTransactionId: OPERATIONS_TEST_IDS.transactions.products,
      }),
      expect.objectContaining({
        id: "97555555-5555-4555-8555-555555555552",
        occurredOn: "2026-07-08",
        amountMinor: 500_000,
        fromAccountId: OPERATIONS_TEST_IDS.accounts.main,
        toAccountId: OPERATIONS_TEST_IDS.accounts.savings,
      }),
    ]);
    expect({
      accounts: reloaded.value.accounts.length,
      categories: reloaded.value.categories.length,
      budgets: reloaded.value.budgets.length,
      lines: reloaded.value.budgets[0]!.lines.length,
      goals: reloaded.value.goals.length,
      commitments: reloaded.value.annualCommitments.length,
      schedules: reloaded.value.scheduledExpenses.length,
      transactions: reloaded.value.transactions.length,
    }).toEqual({
      accounts: 2,
      categories: 2,
      budgets: 1,
      lines: 2,
      goals: 1,
      commitments: 0,
      schedules: 0,
      transactions: 6,
    });
    expect(metrics).toMatchObject({
      incomeMinor: 10_000_000,
      expensesMinor: 7_500_000,
      capitalMinor: 2_500_000,
      accountBalancesMinor: {
        [OPERATIONS_TEST_IDS.accounts.main]: 2_000_000,
        [OPERATIONS_TEST_IDS.accounts.savings]: 500_000,
      },
    });
    expect(await targetRepository.documentCount()).toBe(1);
  });

  it("does not persist backup metadata when download startup fails", async () => {
    const repository = createBudgetRepository({ databaseName: databaseName("backup-download-failure") });
    const createdAt = "2026-07-24T09:10:11.000Z";
    await repository.save(sixOperationState());
    await repository.setLastSuccessfulBackup("2026-07-17T09:30:00.000Z");
    const backup = await createBudgetBackup(
      sixOperationState(),
      async () => undefined,
      { createdAt },
    );
    const record = vi.fn((value: string) => repository.setLastSuccessfulBackup(value));

    await expect(downloadThenRecordSuccessfulBackup(
      backup,
      () => { throw new Error("anchor click failed"); },
      record,
    )).rejects.toThrow();

    expect(record).not.toHaveBeenCalled();
    expect(await repository.getLastSuccessfulBackup()).toBe("2026-07-17T09:30:00.000Z");
  });

  it("keeps the previous backup date when metadata persistence fails", async () => {
    const repository = createBudgetRepository({ databaseName: databaseName("backup-metadata-failure") });
    const previous = "2026-07-17T09:30:00.000Z";
    await repository.save(sixOperationState());
    await repository.setLastSuccessfulBackup(previous);
    const backup = await createBudgetBackup(
      sixOperationState(),
      async () => undefined,
      { createdAt: "2026-07-24T09:10:11.000Z" },
    );
    const download = vi.fn();

    await expect(downloadThenRecordSuccessfulBackup(
      backup,
      download,
      async () => { throw new Error("metadata persistence failed"); },
    )).rejects.toThrow();

    expect(download).toHaveBeenCalledTimes(1);
    expect(await repository.getLastSuccessfulBackup()).toBe(previous);
  });

  it("App has one post-download metadata callback and no eager legacy writer", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(source.match(/onRecordSuccessfulBackup=/g)).toHaveLength(2);
    expect(source).toContain("await repository.setLastSuccessfulBackup(createdAt);");
    expect(source).toMatch(
      /onCreateBackup=\{async \(\) => createBudgetBackup\([\s\S]*async \(\) => undefined,[\s\S]*\)\}[\s\S]*onRecordSuccessfulBackup=/,
    );
    expect(source.match(/repository\.setLastSuccessfulBackup/g)).toHaveLength(1);
  });

  it("rejects a damaged restore before save, publication, or revision changes", async () => {
    const initial = sixOperationState();
    const revision = "10000000-0000-4000-8000-000000000077";
    const save = vi.fn(async () => undefined);
    const publish = vi.fn();

    await expect(restoreBudgetBackup(
      {
        size: 18,
        text: async () => '{"schemaVersion":1',
      },
      save,
      publish,
    )).rejects.toThrow();

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(revision).toBe("10000000-0000-4000-8000-000000000077");
    expect(initial.transactions).toHaveLength(6);
  });

  it("clears persisted state before publishing empty and blocks a rapid second action", async () => {
    const repository = createBudgetRepository({ databaseName: databaseName("clear") });
    await repository.save(sixOperationState());
    await repository.setLastSuccessfulBackup("2026-07-24T09:10:11.000Z");
    const order: string[] = [];

    await persistThenPublishEmpty(
      async () => {
        await repository.clear();
        order.push("persist");
      },
      () => order.push("publish"),
    );
    expect(order).toEqual(["persist", "publish"]);
    expect(await repository.loadVersioned()).toBeNull();
    expect(await repository.getLastSuccessfulBackup()).toBeNull();

    const publish = vi.fn();
    await expect(persistThenPublishEmpty(
      async () => { throw new Error("private database detail"); },
      publish,
    )).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();

    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const gate = createRecoveryActionGate();
    const first = vi.fn(async () => pending);
    const second = vi.fn(async () => undefined);
    const firstResult = gate.run(first);
    const secondResult = gate.run(second);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    await expect(secondResult).resolves.toBeUndefined();
    release();
    await firstResult;
  });

  it("exports seven semantic CSV rows and search 2/reset 6 without changing totals", () => {
    const state = sixOperationState();
    const before = calculateBudget(state);
    const snapshot = structuredClone(state);
    const csv = createOperationsCsv(state);
    const rows = csv.slice(1).trimEnd().split("\r\n");
    const prepared = prepareOperationsCsvDownload(state, new Date(2026, 6, 24, 23, 55));

    expect(rows).toHaveLength(7);
    expect(rows[0]).toBe("Дата,Тип,Статус,\"Сумма, ₽\",Счёт,Категория или цель,Связь с исходной операцией");
    expect(rows.filter((row) => row.includes("Продукты"))).toHaveLength(2);
    expect(prepared).toMatchObject({
      filename: "family-budget-operations-2026-07-24.csv",
      mediaType: "text/csv;charset=utf-8",
    });
    expect(searchOperations(state, { query: "продукты" })).toHaveLength(2);
    expect(searchOperations(state, { query: "", kind: "all" })).toHaveLength(6);
    expect(calculateBudget(state)).toEqual(before);
    expect(state).toEqual(snapshot);
  });
});
