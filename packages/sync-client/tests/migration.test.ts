/**
 * The acceptance of phase S4, in the numbers the plan names.
 *
 * A budget written by the shipped version — database schema `2`, one document, no sync records —
 * is opened by the schema this phase introduces. Nothing about it may change: four operations,
 * the July reserve of `1 980 900` kopecks and `4 419 100` free after the plan.
 */
import { calculateAnnualPlan } from "@family-budget/domain";
import { IndexedDbBudgetRepository } from "@family-budget/storage";
import type { SyncedBudgetState } from "@family-budget/sync-protocol";
import { G002, toDomainBudgetState } from "@family-budget/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";

import { SyncEngine } from "../src/engine.js";
import {
  createFamilyKey,
  databaseName,
  deleteDatabases,
  DEVICE_A,
  FAMILY_ID,
  FakeSyncServer,
  FIRST_EPOCH,
  g002Drafts,
} from "./support.js";

afterEach(deleteDatabases);

const JULY_RESERVE_MINOR = 1_980_900;
const JULY_SPENDABLE_MINOR = 4_419_100;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeLegacy(name: string, version: 1 | 2, document: Record<string, unknown>): Promise<void> {
  const request = indexedDB.open(name, version);
  request.onupgradeneeded = () => request.result.createObjectStore("documents", { keyPath: "key" });
  const database = await requestResult(request);
  const transaction = database.transaction("documents", "readwrite");
  transaction.objectStore("documents").put(document);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

function july(state: SyncedBudgetState) {
  return calculateAnnualPlan(state, G002.startMonth, 12).currentMonth;
}

describe("миграция схемы хранилища на версию 3", () => {
  it("переносит бюджет G-002 из схемы 2, сохраняя 4 операции и все суммы", async () => {
    const name = databaseName("g002-v2");
    await writeLegacy(name, 2, {
      key: "active-budget",
      schemaVersion: 2,
      updatedAt: "2026-07-16T00:00:00.000Z",
      revision: "33333333-3333-4333-8333-333333333333",
      value: toDomainBudgetState(G002),
    });

    const repository = new IndexedDbBudgetRepository<SyncedBudgetState>({ databaseName: name });
    const restored = await repository.load();

    expect(restored).not.toBeNull();
    expect(restored!.transactions).toHaveLength(4);
    expect(july(restored!).annualReserveMinor).toBe(JULY_RESERVE_MINOR);
    expect(july(restored!).spendableAfterPlanMinor).toBe(JULY_SPENDABLE_MINOR);
    expect(restored).toEqual(toDomainBudgetState(G002));
    // The device has not signed in, so nothing of synchronisation exists yet (§9).
    expect(await repository.syncRecordCount()).toEqual({ outbox: 0, state: 0 });
  });

  it("переносит тот же бюджет из схемы 1 через обе ступени миграции", async () => {
    const name = databaseName("g002-v1");
    await writeLegacy(name, 1, {
      key: "active-budget",
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
      value: toDomainBudgetState(G002),
    });

    const repository = new IndexedDbBudgetRepository<SyncedBudgetState>({ databaseName: name });
    const restored = await repository.load();

    expect(restored!.transactions).toHaveLength(4);
    expect(july(restored!).annualReserveMinor).toBe(JULY_RESERVE_MINOR);
    expect(july(restored!).spendableAfterPlanMinor).toBe(JULY_SPENDABLE_MINOR);
    expect(await repository.syncRecordCount()).toEqual({ outbox: 0, state: 0 });
  });

  it("после миграции устройство может войти в семью, не потеряв ни одной суммы", async () => {
    const name = databaseName("g002-join");
    await writeLegacy(name, 2, {
      key: "active-budget",
      schemaVersion: 2,
      updatedAt: "2026-07-16T00:00:00.000Z",
      revision: "44444444-4444-4444-8444-444444444444",
      value: toDomainBudgetState(G002),
    });

    const repository = new IndexedDbBudgetRepository<SyncedBudgetState>({ databaseName: name });
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const engine = new SyncEngine({
      repository,
      transport: server,
      familyId: FAMILY_ID,
      deviceId: DEVICE_A,
      familyKey: family.key,
      keyEpoch: FIRST_EPOCH,
      keyDigest: family.digest,
    });

    const drafts = g002Drafts();
    const enqueued = await engine.enqueue(drafts);
    expect(enqueued.queued).toBe(drafts.length);
    const pushed = await engine.push();
    expect(pushed.confirmed).toBe(drafts.length);
    expect(pushed.pending).toBe(0);

    const state = (await repository.load())!;
    expect(state.transactions).toHaveLength(4);
    expect(july(state).annualReserveMinor).toBe(JULY_RESERVE_MINOR);
    expect(july(state).spendableAfterPlanMinor).toBe(JULY_SPENDABLE_MINOR);
  });
});
