import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { IndexedDbBudgetRepository, ValidatedBackupCodec, serializeBackup } from "../src";

const databaseNames = new Set<string>();

function name(label: string): string {
  const value = `family-budget-test-${label}-${crypto.randomUUID()}`;
  databaseNames.add(value);
  return value;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function createV1(
  databaseName: string,
  documents: readonly Record<string, unknown>[],
): Promise<void> {
  const request = indexedDB.open(databaseName, 1);
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

async function readV1Documents(databaseName: string): Promise<unknown[]> {
  const database = await requestResult(indexedDB.open(databaseName, 1));
  const documents = await requestResult(database.transaction("documents", "readonly").objectStore("documents").getAll());
  database.close();
  return documents;
}

async function readV2Document(databaseName: string, key: string): Promise<{ schemaVersion: number; value: unknown } | undefined> {
  const database = await requestResult(indexedDB.open(databaseName, 2));
  const document = await requestResult(
    database.transaction("documents", "readonly").objectStore("documents").get(key),
  );
  database.close();
  return document as { schemaVersion: number; value: unknown } | undefined;
}

function nestedValue(depth: number): unknown {
  let value: unknown = { amountMinor: 1 };
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

afterEach(async () => {
  await Promise.all([...databaseNames].map(deleteDatabase));
  databaseNames.clear();
});

describe("IndexedDB storage v2", () => {
  it("мигрирует реальный v1 документ и сохраняет 12 345 minor units без изменения", async () => {
    const databaseName = name("migration");
    await createV1(databaseName, [
      {
        key: "active-budget",
        schemaVersion: 1,
        updatedAt: "2026-07-16T00:00:00.000Z",
        value: { amountMinor: 12345 },
      },
    ]);

    const repository = new IndexedDbBudgetRepository<{ amountMinor: number; migrated: boolean }>({
      databaseName,
      migrateV1Value: (value) => {
        const candidate = value as { amountMinor?: unknown };
        if (!Number.isSafeInteger(candidate.amountMinor)) throw new Error("invalid v1 amount");
        return { amountMinor: candidate.amountMinor as number, migrated: true };
      },
    });
    expect(await repository.load()).toEqual({ amountMinor: 12345, migrated: true });
    expect(await repository.documentCount()).toBe(1);
    expect(await readV2Document(databaseName, "active-budget")).toMatchObject({
      schemaVersion: 2,
      value: { amountMinor: 12345, migrated: true },
    });
  });

  it("откатывает versionchange целиком при ошибке миграции", async () => {
    const databaseName = name("rollback");
    const originals = [
      { key: "active-budget", schemaVersion: 1, updatedAt: "2026-07-16T00:00:00.000Z", value: { amountMinor: 12345 } },
      { key: "second", schemaVersion: 1, updatedAt: "2026-07-16T00:00:00.000Z", value: { amountMinor: 12.5 } },
    ];
    await createV1(databaseName, originals);
    const repository = new IndexedDbBudgetRepository({
      databaseName,
      migrateV1Value: (value) => {
        const candidate = value as { amountMinor?: unknown };
        if (!Number.isSafeInteger(candidate.amountMinor)) throw new Error("invalid v1 amount");
        return { amountMinor: candidate.amountMinor as number, migrated: true };
      },
    });

    await expect(repository.load()).rejects.toThrow(/открыть или обновить/);
    expect(JSON.stringify(await readV1Documents(databaseName))).toBe(JSON.stringify(originals));
  });

  it.each([
    ["dangerous key", () => JSON.parse('{"__proto__":{"polluted":true}}')],
    ["depth 65", () => nestedValue(65)],
    ["excessive nodes", () => ({ items: Array.from({ length: 50_000 }, () => ({ value: null })) })],
    ["oversized collection", () => Array.from({ length: 50_001 }, () => 0)],
  ])("generic guard отклоняет %s до custom callback и полностью откатывает два документа", async (label, makeInvalidValue) => {
    const databaseName = name(`generic-${label}`);
    const originals = [
      { key: "active-budget", schemaVersion: 1, updatedAt: "2026-07-16T00:00:00.000Z", value: { amountMinor: 12345 } },
      { key: "second", schemaVersion: 1, updatedAt: "2026-07-16T00:00:00.000Z", value: makeInvalidValue() },
    ];
    const before = JSON.stringify(originals);
    await createV1(databaseName, originals);
    const callbackKeys: string[] = [];
    const repository = new IndexedDbBudgetRepository<unknown>({
      databaseName,
      migrateV1Value: (value, key) => {
        callbackKeys.push(key);
        return value;
      },
    });

    await expect(repository.load()).rejects.toThrow(/открыть или обновить/);
    expect(callbackKeys).toEqual(["active-budget"]);
    expect(JSON.stringify(await readV1Documents(databaseName))).toBe(before);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("валидирует restore до единственной записи и не меняет прежний документ при отказе", async () => {
    const databaseName = name("restore");
    const repository = new IndexedDbBudgetRepository<{ id: string; amountMinor: number }>({ databaseName });
    const oldValue = { id: "018f4b42-7c2e-7b85-a471-7d8c87b3e5c1", amountMinor: 12345 };
    await repository.save(oldValue);
    const before = JSON.stringify(await repository.load());
    const codec = new ValidatedBackupCodec<{ id: string; amountMinor: number }>((value) => {
      const candidate = value as { id?: unknown; amountMinor?: unknown };
      if (typeof candidate.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(candidate.id)) {
        throw new Error("invalid uuid");
      }
      if (!Number.isSafeInteger(candidate.amountMinor)) throw new Error("invalid amount");
      return candidate as { id: string; amountMinor: number };
    });

    await expect(repository.restore(serializeBackup({ ...oldValue, id: "corrupt" }), (text) => codec.parse(text))).rejects.toThrow("invalid uuid");
    await expect(repository.restore(serializeBackup({ ...oldValue, amountMinor: 12.5 }), (text) => codec.parse(text))).rejects.toThrow("invalid amount");
    expect(JSON.stringify(await repository.load())).toBe(before);
    expect(await repository.documentCount()).toBe(1);
  });

  it("возвращает понятную blocked ошибку, если вкладка v1 удерживает соединение", async () => {
    const databaseName = name("blocked");
    await createV1(databaseName, []);
    const blocker = await requestResult(indexedDB.open(databaseName, 1));
    const repository = new IndexedDbBudgetRepository({ databaseName });

    await expect(repository.load()).rejects.toThrow(/заблокировано другой вкладкой/);
    blocker.close();
    expect(await repository.load()).toBeNull();
  });

  it("хранит дату успешного backup и clear оставляет 0 документов", async () => {
    const repository = new IndexedDbBudgetRepository({ databaseName: name("metadata") });
    await repository.save({ amountMinor: 12345 });
    await repository.setLastSuccessfulBackup("2026-07-17T12:00:00.000Z");
    expect(await repository.getLastSuccessfulBackup()).toBe("2026-07-17T12:00:00.000Z");
    expect(await repository.documentCount()).toBe(2);

    await repository.clear();
    expect(await repository.documentCount()).toBe(0);
    expect(await repository.load()).toBeNull();
    expect(await repository.getLastSuccessfulBackup()).toBeNull();
  });

  it("не меняет metadata, если последующий export завершился ошибкой", async () => {
    const repository = new IndexedDbBudgetRepository({ databaseName: name("failed-export") });
    await repository.setLastSuccessfulBackup("2026-07-17T12:00:00.000Z");
    const codec = new ValidatedBackupCodec((value) => value);

    expect(() => codec.serialize({ left: { id: "same" }, right: { id: "same" } })).toThrow(/повторяющийся/);
    expect(await repository.getLastSuccessfulBackup()).toBe("2026-07-17T12:00:00.000Z");
  });
});
