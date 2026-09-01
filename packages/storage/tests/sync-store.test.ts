import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";

import { IndexedDbBudgetRepository, SYNC_OUTBOX_STORE, SYNC_STATE_STORE } from "../src";

const databaseNames = new Set<string>();

function name(label: string): string {
  const value = `family-budget-sync-${label}-${crypto.randomUUID()}`;
  databaseNames.add(value);
  return value;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function createLegacy(
  databaseName: string,
  version: 1 | 2,
  documents: readonly Record<string, unknown>[],
): Promise<void> {
  const request = indexedDB.open(databaseName, version);
  request.onupgradeneeded = () => request.result.createObjectStore("documents", { keyPath: "key" });
  const database = await requestResult(request);
  const transaction = database.transaction("documents", "readwrite");
  for (const document of documents) transaction.objectStore("documents").put(document);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function storeNames(databaseName: string): Promise<string[]> {
  const database = await requestResult(indexedDB.open(databaseName));
  const names = [...database.objectStoreNames];
  database.close();
  return names;
}

async function databaseVersion(databaseName: string): Promise<number> {
  const database = await requestResult(indexedDB.open(databaseName));
  const version = database.version;
  database.close();
  return version;
}

afterEach(async () => {
  for (const databaseName of databaseNames) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  }
  databaseNames.clear();
});

interface Doc {
  readonly amountMinor: number;
  readonly note?: string;
}

describe("хранилище синхронизации (схема 3)", () => {
  it("открывает схему 2 без изменений и без создания sync-хранилищ", async () => {
    const databaseName = name("upgrade-v2");
    await createLegacy(databaseName, 2, [
      {
        key: "active-budget",
        schemaVersion: 2,
        updatedAt: "2026-07-16T00:00:00.000Z",
        revision: "11111111-1111-4111-8111-111111111111",
        value: { amountMinor: 1_980_900, note: "июльский резерв" },
      },
      {
        key: "metadata:last-successful-backup",
        schemaVersion: 2,
        updatedAt: "2026-07-16T00:00:00.000Z",
        revision: "22222222-2222-4222-8222-222222222222",
        value: "2026-07-16T00:00:00.000Z",
      },
    ]);

    const repository = new IndexedDbBudgetRepository<Doc>({ databaseName });
    const snapshot = await repository.loadVersioned();

    expect(snapshot?.value).toEqual({ amountMinor: 1_980_900, note: "июльский резерв" });
    expect(snapshot?.revision).toBe("11111111-1111-4111-8111-111111111111");
    expect(await repository.getLastSuccessfulBackup()).toBe("2026-07-16T00:00:00.000Z");
    expect(await repository.documentCount()).toBe(2);
    // Section 9 in its strongest reading: with no account the queue is not created at all, and
    // an existing user who never signs in is not migrated to a schema they have no use for.
    expect(await repository.syncRecordCount()).toEqual({ outbox: 0, state: 0 });
    expect(await databaseVersion(databaseName)).toBe(2);
    expect(await storeNames(databaseName)).toEqual(["documents"]);
  });

  it("первая запись синхронизации поднимает схему до 3 и создаёт оба хранилища", async () => {
    const databaseName = name("enable-sync");
    await createLegacy(databaseName, 2, [
      {
        key: "active-budget",
        schemaVersion: 2,
        updatedAt: "2026-07-16T00:00:00.000Z",
        revision: "55555555-5555-4555-8555-555555555555",
        value: { amountMinor: 1_980_900 },
      },
    ]);

    const repository = new IndexedDbBudgetRepository<Doc>({ databaseName });
    expect(await databaseVersion(databaseName)).toBe(2);

    const commit = await repository.commitWithSync({
      expectedRevision: "55555555-5555-4555-8555-555555555555",
      value: { amountMinor: 1_980_901 },
      outbox: [{ opId: "op-1", envelope: { ciphertext: "AAAA" } }],
      syncState: [{ key: "cursor", value: { keyEpoch: 1, seq: 0 } }],
    });

    expect(commit.status).toBe("saved");
    expect(await databaseVersion(databaseName)).toBe(3);
    expect(await storeNames(databaseName)).toContain(SYNC_OUTBOX_STORE);
    expect(await storeNames(databaseName)).toContain(SYNC_STATE_STORE);
    expect(await repository.load()).toEqual({ amountMinor: 1_980_901 });
    expect(await repository.countOutbox()).toBe(1);
  });

  it("другой обработчик того же хранилища подхватывает поднятую схему", async () => {
    const databaseName = name("second-handle");
    const writer = new IndexedDbBudgetRepository<Doc>({ databaseName });
    const reader = new IndexedDbBudgetRepository<Doc>({ databaseName });
    // The reader opens first and settles on the base version.
    expect(await reader.load()).toBeNull();

    await writer.createIfAbsent({ amountMinor: 0 });
    const revision = (await writer.loadVersioned())!.revision;
    await writer.commitWithSync({
      expectedRevision: revision,
      value: { amountMinor: 7 },
      outbox: [{ opId: "op-1", envelope: {} }],
    });

    // The reader must not fail with a VersionError now that the database is newer than it thinks.
    expect(await reader.load()).toEqual({ amountMinor: 7 });
    expect(await reader.countOutbox()).toBe(1);
  });

  it("мигрирует схему 1 до 2 и не заводит очередь без входа", async () => {
    const databaseName = name("upgrade-v1");
    await createLegacy(databaseName, 1, [
      {
        key: "active-budget",
        schemaVersion: 1,
        updatedAt: "2026-07-16T00:00:00.000Z",
        value: { amountMinor: 4_419_100 },
      },
    ]);

    const repository = new IndexedDbBudgetRepository<Doc>({ databaseName });
    expect(await repository.load()).toEqual({ amountMinor: 4_419_100 });
    expect(await repository.syncRecordCount()).toEqual({ outbox: 0, state: 0 });
    expect(await databaseVersion(databaseName)).toBe(2);
  });

  it("записывает документ, очередь и курсор одной транзакцией", async () => {
    const repository = new IndexedDbBudgetRepository<Doc>({ databaseName: name("atomic") });
    const created = await repository.createIfAbsent({ amountMinor: 0 });
    expect(created.status).toBe("created");
    const before = await repository.loadVersioned();

    const commit = await repository.commitWithSync({
      expectedRevision: before!.revision,
      value: { amountMinor: 1_980_900 },
      outbox: [
        { opId: "op-1", envelope: { ciphertext: "AAAA" } },
        { opId: "op-2", envelope: { ciphertext: "BBBB" } },
      ],
      syncState: [{ key: "cursor", value: { keyEpoch: 1, seq: 0 } }],
    });

    expect(commit.status).toBe("saved");
    expect(await repository.load()).toEqual({ amountMinor: 1_980_900 });
    expect((await repository.listOutbox()).map((record) => record.opId)).toEqual(["op-1", "op-2"]);
    expect(await repository.readSyncState("cursor")).toEqual({ keyEpoch: 1, seq: 0 });
  });

  it("на конфликте ревизии не пишет ни документ, ни очередь, ни курсор", async () => {
    const repository = new IndexedDbBudgetRepository<Doc>({ databaseName: name("conflict") });
    await repository.createIfAbsent({ amountMinor: 1 });
    const stale = await repository.loadVersioned();
    await repository.saveIfRevision(stale!.revision, { amountMinor: 2 });

    const commit = await repository.commitWithSync({
      expectedRevision: stale!.revision,
      value: { amountMinor: 3 },
      outbox: [{ opId: "op-lost", envelope: { ciphertext: "CCCC" } }],
      syncState: [{ key: "cursor", value: { keyEpoch: 1, seq: 7 } }],
    });

    expect(commit.status).toBe("conflict");
    expect(await repository.load()).toEqual({ amountMinor: 2 });
    expect(await repository.listOutbox()).toEqual([]);
    expect(await repository.readSyncState("cursor")).toBeUndefined();
  });

  it("держит очередь в порядке записи и переживает переоткрытие хранилища", async () => {
    const databaseName = name("restart");
    const first = new IndexedDbBudgetRepository<Doc>({ databaseName });
    await first.createIfAbsent({ amountMinor: 0 });
    let revision = (await first.loadVersioned())!.revision;
    for (let index = 1; index <= 20; index += 1) {
      const commit = await first.commitWithSync({
        expectedRevision: revision,
        value: { amountMinor: index },
        outbox: [{ opId: `op-${index}`, envelope: { index } }],
      });
      expect(commit.status).toBe("saved");
      revision = (commit as { revision: string }).revision;
    }

    const restarted = new IndexedDbBudgetRepository<Doc>({ databaseName });
    const queued = await restarted.listOutbox();
    expect(queued).toHaveLength(20);
    expect(queued.map((record) => record.opId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `op-${index + 1}`),
    );
    expect(queued.map((record) => record.sequence)).toEqual(
      [...queued].map((record) => record.sequence).sort((left, right) => left - right),
    );
  });

  it("удаляет из очереди только подтверждённые идентификаторы", async () => {
    const repository = new IndexedDbBudgetRepository<Doc>({ databaseName: name("confirm") });
    await repository.createIfAbsent({ amountMinor: 0 });
    const revision = (await repository.loadVersioned())!.revision;
    await repository.commitWithSync({
      expectedRevision: revision,
      value: { amountMinor: 1 },
      outbox: [
        { opId: "op-1", envelope: {} },
        { opId: "op-2", envelope: {} },
        { opId: "op-3", envelope: {} },
      ],
    });

    expect(await repository.confirmOutbox(["op-2", "op-unknown"])).toBe(1);
    expect((await repository.listOutbox()).map((record) => record.opId)).toEqual(["op-1", "op-3"]);
    expect(await repository.countOutbox()).toBe(2);
  });

  it("не ставит второй записи на тот же opId", async () => {
    const repository = new IndexedDbBudgetRepository<Doc>({ databaseName: name("dedupe") });
    await repository.createIfAbsent({ amountMinor: 0 });
    let revision = (await repository.loadVersioned())!.revision;
    const first = await repository.commitWithSync({
      expectedRevision: revision,
      value: { amountMinor: 1 },
      outbox: [{ opId: "op-1", envelope: { take: 1 } }],
    });
    revision = (first as { revision: string }).revision;
    const second = await repository.commitWithSync({
      expectedRevision: revision,
      value: { amountMinor: 2 },
      outbox: [{ opId: "op-1", envelope: { take: 2 } }],
    });

    expect(second.status).toBe("saved");
    const queued = await repository.listOutbox();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.envelope).toEqual({ take: 1 });
  });

  it("полностью локальная работа не создаёт ни одной записи синхронизации", async () => {
    const repository = new IndexedDbBudgetRepository<Doc>({ databaseName: name("local-only") });
    await repository.createIfAbsent({ amountMinor: 0 });
    const revision = (await repository.loadVersioned())!.revision;
    await repository.saveIfRevision(revision, { amountMinor: 1_980_900 });
    await repository.save({ amountMinor: 4_419_100 });
    await repository.setLastSuccessfulBackup("2026-07-16T00:00:00.000Z");
    await repository.restore('{"amountMinor":123}', (text) => JSON.parse(text) as Doc);

    expect(await repository.syncRecordCount()).toEqual({ outbox: 0, state: 0 });
    expect(await repository.listOutbox()).toEqual([]);
    expect(await repository.readSyncState("cursor")).toBeUndefined();
  });

  it("clear убирает и документы, и очередь, и состояние синхронизации", async () => {
    const repository = new IndexedDbBudgetRepository<Doc>({ databaseName: name("clear") });
    await repository.createIfAbsent({ amountMinor: 0 });
    const revision = (await repository.loadVersioned())!.revision;
    await repository.commitWithSync({
      expectedRevision: revision,
      value: { amountMinor: 1 },
      outbox: [{ opId: "op-1", envelope: {} }],
      syncState: [{ key: "cursor", value: { keyEpoch: 1, seq: 3 } }],
    });

    await repository.clear();
    expect(await repository.documentCount()).toBe(0);
    expect(await repository.syncRecordCount()).toEqual({ outbox: 0, state: 0 });
  });

  it("clearSyncData возвращает устройство в локальный режим, не трогая бюджет", async () => {
    const repository = new IndexedDbBudgetRepository<Doc>({ databaseName: name("leave-family") });
    await repository.createIfAbsent({ amountMinor: 0 });
    const revision = (await repository.loadVersioned())!.revision;
    await repository.commitWithSync({
      expectedRevision: revision,
      value: { amountMinor: 1_980_900 },
      outbox: [{ opId: "op-1", envelope: {} }],
      syncState: [{ key: "cursor", value: { keyEpoch: 1, seq: 3 } }],
    });

    await repository.clearSyncData();
    expect(await repository.load()).toEqual({ amountMinor: 1_980_900 });
    expect(await repository.syncRecordCount()).toEqual({ outbox: 0, state: 0 });
  });
});
