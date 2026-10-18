/// <reference types="node" />
/**
 * То, что записал выпуск 1.0.0, обязано открываться без единой правки — всегда.
 *
 * Файлы лежат в `packages/test-fixtures/frozen/1.0.0/` и записаны один раз кодом 1.0.0; их байты
 * закреплены SHA-256 (`FROZEN_1_0_0`), так что «пересобрать фикстуру под новый формат» нельзя
 * незаметно. Здесь проверяется обещание целиком: копия восстанавливается в то же состояние байт в
 * байт и без единого ремонта, запись IndexedDB открывается через `prepareBudgetState` без
 * изменений, а посев журнала G-002 даёт те же наброски и те же байты на проводе.
 */
import "fake-indexeddb/auto";
import {
  calculateAnnualPlan,
  calculateBudget,
  makePlanningSeed,
  type BudgetState,
} from "@family-budget/domain";
import { createClock, createLocalOperation, encodeOperation } from "@family-budget/sync-protocol";
import { G002, toDomainBudgetState } from "@family-budget/test-fixtures";
import { readFrozenArtifact, type FrozenArtifact } from "@family-budget/test-fixtures/frozen";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBudgetBackup,
  parseAndValidateBudgetBackup,
  prepareBudgetState,
  restoreBudgetBackup,
  type BackupRepair,
} from "./backup";
import { budgetJournalDrafts } from "./features/family/journal";
import { createBudgetRepository } from "./storage-repository";

/** Контрольные суммы payload, записанные 1.0.0 в поле `integrity.checksum` копии. */
const G002_PAYLOAD_CHECKSUM = "e20b5952f9ae07c268447f4d1d94da5656eed0601f74b569f22bef7f879e746e";
const PLANNING_SEED_PAYLOAD_CHECKSUM = "9fc4f3834aedfbe9562f97993f93a3e97e313fca55cb668716112e523011bc9f";

const JULY_RESERVE_MINOR = 1_980_900;
const JULY_SPENDABLE_MINOR = 4_419_100;

interface FrozenBackup {
  readonly schemaVersion: number;
  readonly integrity: { readonly algorithm: string; readonly checksum: string };
  readonly payload: unknown;
}

interface FrozenRecord {
  readonly key: string;
  readonly schemaVersion: number;
  readonly updatedAt: string;
  readonly revision: string;
  readonly value: unknown;
}

const CASES = [
  {
    label: "G-002",
    backup: "g002Backup",
    record: "g002IndexedDb",
    checksum: G002_PAYLOAD_CHECKSUM,
    source: (): BudgetState => toDomainBudgetState(G002) as BudgetState,
  },
  {
    label: "makePlanningSeed",
    backup: "planningSeedBackup",
    record: "planningSeedIndexedDb",
    checksum: PLANNING_SEED_PAYLOAD_CHECKSUM,
    source: makePlanningSeed,
  },
] as const satisfies readonly {
  readonly label: string;
  readonly backup: FrozenArtifact;
  readonly record: FrozenArtifact;
  readonly checksum: string;
  readonly source: () => BudgetState;
}[];

const databaseNames = new Set<string>();

function databaseName(label: string): string {
  const value = `family-budget-frozen-${label}-${crypto.randomUUID()}`;
  databaseNames.add(value);
  return value;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Кладёт запись так, как её оставил 1.0.0: база версии 2, одно хранилище `documents`. */
async function writeAsReleased(name: string, record: FrozenRecord): Promise<void> {
  const request = indexedDB.open(name, 2);
  request.onupgradeneeded = () => request.result.createObjectStore("documents", { keyPath: "key" });
  const database = await requestResult(request);
  const transaction = database.transaction("documents", "readwrite");
  transaction.objectStore("documents").put(record);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function readRecords(name: string): Promise<unknown[]> {
  const database = await requestResult(indexedDB.open(name));
  const records = await requestResult(
    database.transaction("documents", "readonly").objectStore("documents").getAll(),
  );
  database.close();
  return records;
}

afterEach(async () => {
  await Promise.all(
    [...databaseNames].map(
      (name) =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        }),
    ),
  );
  databaseNames.clear();
});

describe.each(CASES)("копия 1.0.0: $label", ({ backup, checksum, source }) => {
  it("восстанавливается в то же состояние байт в байт и без единого ремонта", async () => {
    const text = readFrozenArtifact(backup);
    const envelope = JSON.parse(text) as FrozenBackup;
    const repairs: BackupRepair[] = [];

    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.integrity).toEqual({ algorithm: "sha256", checksum });

    const restored = parseAndValidateBudgetBackup(text, (repair) => repairs.push(repair));

    expect(repairs).toEqual([]);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(envelope.payload));
    expect(restored).toEqual(source());
  });

  it("проходит восстановление целиком: сохраняется и публикуется ровно то, что в файле", async () => {
    const text = readFrozenArtifact(backup);
    const payload = (JSON.parse(text) as FrozenBackup).payload;
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();

    const restored = await restoreBudgetBackup({ size: text.length, text: async () => text }, save, publish);

    expect(JSON.stringify(restored)).toBe(JSON.stringify(payload));
    expect(save).toHaveBeenCalledExactlyOnceWith(restored);
    expect(publish).toHaveBeenCalledExactlyOnceWith(restored);
  });

  it("выгружается обратно с той же контрольной суммой payload", async () => {
    const restored = parseAndValidateBudgetBackup(readFrozenArtifact(backup));

    const exported = await createBudgetBackup(restored, async () => undefined, {
      createdAt: "2026-10-18T09:00:00.000Z",
    });
    const envelope = JSON.parse(exported.text) as FrozenBackup;

    // Версия схемы копии может расти; сами данные и их контрольная сумма — нет.
    expect(envelope.integrity).toEqual({ algorithm: "sha256", checksum });
    expect(JSON.stringify(envelope.payload)).toBe(JSON.stringify(restored));
  });
});

describe.each(CASES)("документ IndexedDB 1.0.0: $label", ({ record: artifact, source }) => {
  it("открывается через prepareBudgetState без единой правки и с прежней ревизией", async () => {
    const record = JSON.parse(readFrozenArtifact(artifact)) as FrozenRecord;
    const name = databaseName(artifact);
    await writeAsReleased(name, record);

    const repository = createBudgetRepository({ databaseName: name });
    const snapshot = await repository.loadVersioned();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.revision).toBe(record.revision);
    const prepared = prepareBudgetState(snapshot!.value);
    expect(JSON.stringify(prepared)).toBe(JSON.stringify(record.value));
    expect(prepared).toEqual(source());

    // Открытие ничего не переписывает: запись на диске осталась той, что оставил 1.0.0.
    expect(await readRecords(name)).toEqual([record]);
  });
});

describe("расчёты по документу 1.0.0", () => {
  it("G-002 даёт те же июльские резерв и свободный остаток", () => {
    const record = JSON.parse(readFrozenArtifact("g002IndexedDb")) as FrozenRecord;
    const state = prepareBudgetState(record.value);
    const july = calculateAnnualPlan(state, G002.startMonth, 12).currentMonth;

    expect(july.annualReserveMinor).toBe(JULY_RESERVE_MINOR);
    expect(july.spendableAfterPlanMinor).toBe(JULY_SPENDABLE_MINOR);
    expect(calculateBudget(state)).toEqual(calculateBudget(toDomainBudgetState(G002) as BudgetState));
  });
});

describe("журнал G-002, засеянный 1.0.0", () => {
  it("даёт те же наброски операций", () => {
    const frozen = readFrozenArtifact("g002JournalDrafts");
    const drafts = budgetJournalDrafts(null, toDomainBudgetState(G002) as BudgetState);

    expect(JSON.stringify(drafts, null, 2)).toBe(frozen);
  });

  it("даёт те же байты на проводе", () => {
    const frozen = readFrozenArtifact("g002Journal");
    let clock = createClock("0000000a-0000-4000-8000-000000000001", 0);
    const lines = budgetJournalDrafts(null, toDomainBudgetState(G002) as BudgetState).map((draft, index) => {
      const local = createLocalOperation(clock, {
        ...draft,
        opId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      });
      clock = local.clock;
      return encodeOperation(local.operation);
    });

    expect(lines.join("\n")).toBe(frozen);
  });
});
