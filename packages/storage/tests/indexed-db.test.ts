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

async function createV2(
  databaseName: string,
  documents: readonly Record<string, unknown>[],
): Promise<void> {
  const request = indexedDB.open(databaseName, 2);
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

async function readV2Document(
  databaseName: string,
  key: string,
): Promise<{ schemaVersion: number; revision?: string; value: unknown } | undefined> {
  const database = await requestResult(indexedDB.open(databaseName, 2));
  const document = await requestResult(
    database.transaction("documents", "readonly").objectStore("documents").get(key),
  );
  database.close();
  return document as { schemaVersion: number; revision?: string; value: unknown } | undefined;
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

  it("миграция allowlist отбрасывает подставленный revision и неизвестные wrapper-поля", async () => {
    const databaseName = name("migration-wrapper-allowlist");
    const injectedRevision = "11111111-1111-4111-8111-111111111111";
    const originalValue = { owner: "legacy", amountMinor: 12345 };
    await createV1(databaseName, [{
      key: "active-budget",
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
      revision: injectedRevision,
      unknownWrapperField: "must-be-dropped",
      value: originalValue,
    }]);
    const repository = new IndexedDbBudgetRepository<typeof originalValue>({ databaseName });

    const migrated = await repository.loadVersioned();
    expect(migrated?.value).toEqual(originalValue);
    expect(migrated?.revision).toMatch(/^[0-9a-f-]{36}$/i);
    expect(migrated?.revision).not.toBe(injectedRevision);
    const stored = await readV2Document(databaseName, "active-budget");
    expect(stored).toMatchObject({ schemaVersion: 2, revision: migrated?.revision, value: originalValue });
    expect(stored).not.toHaveProperty("unknownWrapperField");

    const staleWrite = await repository.saveIfRevision(injectedRevision, { owner: "attacker", amountMinor: 99999 });
    expect(staleWrite).toEqual({ status: "conflict", current: migrated });
    expect(await repository.loadVersioned()).toEqual(migrated);
    expect(await repository.documentCount()).toBe(1);
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

  it("атомарно создаёт активный бюджет только в одной из двух вкладок", async () => {
    const databaseName = name("create-if-absent-race");
    const firstValue = { owner: "first", amountMinor: 18000000 };
    const secondValue = { owner: "second", amountMinor: 5300000 };
    const firstRepository = new IndexedDbBudgetRepository<typeof firstValue>({ databaseName });
    const secondRepository = new IndexedDbBudgetRepository<typeof firstValue>({ databaseName });

    const results = await Promise.all([
      firstRepository.createIfAbsent(firstValue),
      secondRepository.createIfAbsent(secondValue),
    ]);
    const created = results.find((result) => result.status === "created");
    const existing = results.find((result) => result.status === "existing");

    expect(results.map((result) => result.status).sort()).toEqual(["created", "existing"]);
    expect(created).toBeDefined();
    expect(existing).toBeDefined();
    expect(existing?.value).toEqual(created?.value);
    expect(await firstRepository.load()).toEqual(created?.value);
    expect(await secondRepository.load()).toEqual(created?.value);
    expect(await firstRepository.documentCount()).toBe(1);
  });

  it("возвращает точный сохранённый snapshot, даже если вызывающий код меняет исходный объект", async () => {
    const repository = new IndexedDbBudgetRepository<{ owner: string; details: { amountMinor: number } }>({
      databaseName: name("create-if-absent-snapshot"),
    });
    const value = { owner: "before", details: { amountMinor: 12345 } };

    const pendingCreate = repository.createIfAbsent(value);
    value.owner = "mutated";
    value.details.amountMinor = 99999;
    const result = await pendingCreate;

    expect(result).toEqual({ status: "created", value: { owner: "before", details: { amountMinor: 12345 } } });
    expect(result.value).not.toBe(value);
    expect(result.value.details).not.toBe(value.details);
    expect(await repository.load()).toEqual(result.value);

    result.value.details.amountMinor = 77777;
    expect(await repository.load()).toEqual({ owner: "before", details: { amountMinor: 12345 } });
  });

  it("изолирует существующий документ от мутации значения, возвращённого проигравшей вкладке", async () => {
    const repository = new IndexedDbBudgetRepository<{ owner: string; details: { amountMinor: number } }>({
      databaseName: name("create-if-absent-existing-snapshot"),
    });
    const persisted = { owner: "winner", details: { amountMinor: 12345 } };
    await repository.createIfAbsent(persisted);

    const result = await repository.createIfAbsent({ owner: "loser", details: { amountMinor: 99999 } });
    expect(result).toEqual({ status: "existing", value: persisted });
    result.value.details.amountMinor = 77777;

    expect(await repository.load()).toEqual({ owner: "winner", details: { amountMinor: 12345 } });
  });

  it("возвращает versioned snapshot и изолирует его от исходного и хранимого значений", async () => {
    const databaseName = name("versioned-snapshot");
    const repository = new IndexedDbBudgetRepository<{ owner: string; details: { amountMinor: number } }>({ databaseName });
    const first = { owner: "before", details: { amountMinor: 12345 } };
    await repository.save(first);

    const loaded = await repository.loadVersioned();
    expect(loaded).not.toBeNull();
    expect(loaded?.revision).toMatch(/^[0-9a-f-]{36}$/i);
    expect(loaded?.value).toEqual(first);
    first.details.amountMinor = 99999;
    loaded!.value.details.amountMinor = 77777;

    expect(await repository.load()).toEqual({ owner: "before", details: { amountMinor: 12345 } });
    expect((await repository.loadVersioned())?.revision).toBe(loaded?.revision);
    expect((await readV2Document(databaseName, "active-budget"))?.revision).toBe(loaded?.revision);

    await repository.save({ owner: "second", details: { amountMinor: 54321 } });
    expect((await repository.loadVersioned())?.revision).not.toBe(loaded?.revision);
  });

  it("атомарно создаёт отсутствующий документ только по null revision", async () => {
    const databaseName = name("cas-missing");
    const repository = new IndexedDbBudgetRepository<{ owner: string; amountMinor: number }>({ databaseName });

    expect(await repository.loadVersioned()).toBeNull();
    await expect(repository.saveIfRevision("stale-revision", { owner: "stale", amountMinor: 1 })).resolves.toEqual({
      status: "conflict",
      current: null,
    });
    expect(await repository.documentCount()).toBe(0);

    const input = { owner: "winner", amountMinor: 18000000 };
    const pending = repository.saveIfRevision(null, input);
    input.owner = "mutated";
    const saved = await pending;
    expect(saved).toMatchObject({ status: "saved", value: { owner: "winner", amountMinor: 18000000 } });
    expect(saved.status === "saved" && saved.revision).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await repository.load()).toEqual({ owner: "winner", amountMinor: 18000000 });
  });

  it("разрешает ровно одну из двух CAS-записей и возвращает проигравшей точный snapshot победителя", async () => {
    const databaseName = name("cas-race");
    const firstRepository = new IndexedDbBudgetRepository<{ owner: string; amountMinor: number }>({ databaseName });
    const secondRepository = new IndexedDbBudgetRepository<{ owner: string; amountMinor: number }>({ databaseName });
    await firstRepository.save({ owner: "base", amountMinor: 0 });
    const initial = await firstRepository.loadVersioned();
    if (!initial) throw new Error("missing initial snapshot");

    const results = await Promise.all([
      firstRepository.saveIfRevision(initial.revision, { owner: "first", amountMinor: 18000000 }),
      secondRepository.saveIfRevision(initial.revision, { owner: "second", amountMinor: 5300000 }),
    ]);
    const saved = results.find((result) => result.status === "saved");
    const conflict = results.find((result) => result.status === "conflict");

    expect(results.map((result) => result.status).sort()).toEqual(["conflict", "saved"]);
    expect(saved?.status).toBe("saved");
    expect(conflict?.status).toBe("conflict");
    if (saved?.status !== "saved" || conflict?.status !== "conflict") throw new Error("unexpected CAS result");
    expect(conflict.current).toEqual({ value: saved.value, revision: saved.revision });
    expect(await firstRepository.loadVersioned()).toEqual({ value: saved.value, revision: saved.revision });

    conflict.current!.value.amountMinor = 77777;
    saved.value.amountMinor = 99999;
    expect(await secondRepository.loadVersioned()).toEqual({
      value: { owner: conflict.current!.value.owner, amountMinor: conflict.current!.value.owner === "first" ? 18000000 : 5300000 },
      revision: saved.revision,
    });
  });

  it("атомарно выдаёт revisionless-документам разные UUID, а stale token не может перезаписать данные", async () => {
    const firstDatabaseName = name("cas-revisionless-first");
    const secondDatabaseName = name("cas-revisionless-second");
    const updatedAt = "2026-07-16T00:00:00.000Z";
    await createV1(firstDatabaseName, [{
      key: "active-budget",
      schemaVersion: 1,
      updatedAt,
      value: { owner: "first legacy", amountMinor: 12345 },
    }]);
    await createV1(secondDatabaseName, [{
      key: "active-budget",
      schemaVersion: 1,
      updatedAt,
      value: { owner: "second legacy", amountMinor: 12345 },
    }]);
    const firstRepository = new IndexedDbBudgetRepository<{ owner: string; amountMinor: number }>({
      databaseName: firstDatabaseName,
    });
    const secondRepository = new IndexedDbBudgetRepository<{ owner: string; amountMinor: number }>({
      databaseName: secondDatabaseName,
    });

    const conflict = await firstRepository.saveIfRevision("stale-token", { owner: "attacker", amountMinor: 99999 });
    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict" || !conflict.current) throw new Error("missing upgraded conflict snapshot");
    expect(conflict.current.value).toEqual({ owner: "first legacy", amountMinor: 12345 });
    expect(conflict.current.revision).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await firstRepository.loadVersioned()).toEqual(conflict.current);
    expect((await readV2Document(firstDatabaseName, "active-budget"))?.revision).toBe(conflict.current.revision);

    const second = await secondRepository.loadVersioned();
    expect(second?.value).toEqual({ owner: "second legacy", amountMinor: 12345 });
    expect(second?.revision).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second?.revision).not.toBe(conflict.current.revision);
    expect(await secondRepository.loadVersioned()).toEqual(second);
    expect((await readV2Document(secondDatabaseName, "active-budget"))?.revision).toBe(second?.revision);

    const saved = await firstRepository.saveIfRevision(conflict.current.revision, { owner: "updated", amountMinor: 54321 });
    expect(saved).toMatchObject({ status: "saved", value: { owner: "updated", amountMinor: 54321 } });
  });

  it("считает присутствующий malformed revision повреждением без утечки данных", async () => {
    const databaseName = name("cas-malformed-revision");
    const malformedRevision = "malformed-secret-revision";
    const originalValue = { owner: "private-budget-label", amountMinor: 12345 };
    await createV2(databaseName, [{
      key: "active-budget",
      schemaVersion: 1,
      updatedAt: "2026-07-16T00:00:00.000Z",
      revision: malformedRevision,
      value: originalValue,
    }]);
    const repository = new IndexedDbBudgetRepository<typeof originalValue>({ databaseName });

    let loadError: unknown;
    try {
      await repository.loadVersioned();
    } catch (error) {
      loadError = error;
    }
    expect(loadError).toBeInstanceOf(Error);
    expect((loadError as Error).message).toMatch(/повреждён/);
    expect((loadError as Error).message).not.toMatch(/malformed-secret|private-budget|12345/);

    let saveError: unknown;
    try {
      await repository.saveIfRevision("stale-token", { owner: "attacker", amountMinor: 99999 });
    } catch (error) {
      saveError = error;
    }
    expect(saveError).toBeInstanceOf(Error);
    expect((saveError as Error).message).toMatch(/повреждён/);
    expect((saveError as Error).message).not.toMatch(/malformed-secret|private-budget|12345/);
    expect(await readV2Document(databaseName, "active-budget")).toMatchObject({
      revision: malformedRevision,
      value: originalValue,
    });
  });

  it("добавляет UUID revision в каждую новую запись, не ломая backup metadata", async () => {
    const databaseName = name("all-writes-revisioned");
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({ databaseName });
    await repository.createIfAbsent({ amountMinor: 12345 });
    await repository.setLastSuccessfulBackup("2026-07-17T12:00:00.000Z");

    expect((await readV2Document(databaseName, "active-budget"))?.revision).toMatch(/^[0-9a-f-]{36}$/i);
    expect((await readV2Document(databaseName, "metadata:last-successful-backup"))?.revision).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await repository.getLastSuccessfulBackup()).toBe("2026-07-17T12:00:00.000Z");
    expect(await repository.documentCount()).toBe(2);
  });

  it("CAS возвращает generic ошибку при синхронном сбое создания транзакции", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("cas-transaction-throw"),
    });
    expect(await repository.loadVersioned()).toBeNull();
    const originalTransaction = IDBDatabase.prototype.transaction;
    let caught: unknown;

    try {
      IDBDatabase.prototype.transaction = function injectedCasTransactionThrow(): IDBTransaction {
        throw new Error("injected-secret-cas-transaction");
      };
      try {
        await repository.saveIfRevision(null, { amountMinor: 12345 });
      } catch (error) {
        caught = error;
      }
    } finally {
      IDBDatabase.prototype.transaction = originalTransaction;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/транзакцию локального хранилища/);
    expect((caught as Error).message).not.toContain("injected-secret");
    expect(await repository.loadVersioned()).toBeNull();
  });

  it("loadVersioned ждёт terminal abort и скрывает detail синхронного read сбоя", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("versioned-get-throw"),
    });
    expect(await repository.load()).toBeNull();
    const originalGet = IDBObjectStore.prototype.get;
    let abortTerminal = false;
    let caught: unknown;

    try {
      IDBObjectStore.prototype.get = function injectedVersionedGetThrow(this: IDBObjectStore): IDBRequest<unknown> {
        this.transaction.addEventListener("abort", () => {
          abortTerminal = true;
        }, { once: true });
        throw new Error("injected-secret-versioned-get");
      } as typeof IDBObjectStore.prototype.get;
      try {
        await repository.loadVersioned();
      } catch (error) {
        caught = error;
      }
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }

    expect(abortTerminal).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Транзакция хранилища/);
    expect((caught as Error).message).not.toContain("injected-secret");
    expect(await repository.loadVersioned()).toBeNull();
  });

  it("loadVersioned терминально откатывается при асинхронной get request ошибке", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("versioned-get-error"),
    });
    const originalGet = IDBObjectStore.prototype.get;
    const originalAdd = IDBObjectStore.prototype.add;
    let abortTerminal = false;

    try {
      IDBObjectStore.prototype.get = function injectedVersionedGetError(this: IDBObjectStore): IDBRequest<unknown> {
        this.transaction.addEventListener("abort", () => {
          abortTerminal = true;
        }, { once: true });
        const document = {
          key: "active-budget",
          schemaVersion: 2,
          updatedAt: "2026-07-18T00:00:00.000Z",
          value: { amountMinor: 0 },
        };
        originalAdd.call(this, document);
        return originalAdd.call(this, document) as IDBRequest<unknown>;
      } as typeof IDBObjectStore.prototype.get;

      await expect(repository.loadVersioned()).rejects.toThrow(/Транзакция хранилища/);
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }

    expect(abortTerminal).toBe(true);
    expect(await repository.documentCount()).toBe(0);
    expect(await repository.loadVersioned()).toBeNull();
  });

  it("CAS ждёт terminal abort при синхронном initial get сбое и не раскрывает detail", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("cas-get-throw"),
    });
    expect(await repository.loadVersioned()).toBeNull();
    const originalGet = IDBObjectStore.prototype.get;
    let abortTerminal = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let caught: unknown;

    try {
      IDBObjectStore.prototype.get = function injectedCasGetThrow(this: IDBObjectStore): IDBRequest<unknown> {
        this.transaction.addEventListener("abort", () => {
          abortTerminal = true;
        }, { once: true });
        throw new Error("injected-secret-cas-get");
      } as typeof IDBObjectStore.prototype.get;
      const livenessTimeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("CAS did not settle")), 500);
      });
      try {
        await Promise.race([repository.saveIfRevision(null, { amountMinor: 12345 }), livenessTimeout]);
      } catch (error) {
        caught = error;
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      IDBObjectStore.prototype.get = originalGet;
    }

    expect(abortTerminal).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Транзакция хранилища/);
    expect((caught as Error).message).not.toMatch(/injected-secret|did not settle/);
    expect(await repository.loadVersioned()).toBeNull();
  });

  it("CAS терминально откатывается при асинхронной initial get request ошибке", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("cas-get-error"),
    });
    const originalGet = IDBObjectStore.prototype.get;
    const originalAdd = IDBObjectStore.prototype.add;
    let abortTerminal = false;

    try {
      IDBObjectStore.prototype.get = function injectedCasGetError(this: IDBObjectStore): IDBRequest<unknown> {
        this.transaction.addEventListener("abort", () => {
          abortTerminal = true;
        }, { once: true });
        const document = {
          key: "active-budget",
          schemaVersion: 2,
          updatedAt: "2026-07-18T00:00:00.000Z",
          value: { amountMinor: 0 },
        };
        originalAdd.call(this, document);
        return originalAdd.call(this, document) as IDBRequest<unknown>;
      } as typeof IDBObjectStore.prototype.get;

      await expect(repository.saveIfRevision(null, { amountMinor: 12345 })).rejects.toThrow(/Транзакция хранилища/);
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }

    expect(abortTerminal).toBe(true);
    expect(await repository.documentCount()).toBe(0);
    expect(await repository.loadVersioned()).toBeNull();
  });

  it("CAS откатывает синхронный put сбой, ждёт abort и сохраняет прежнюю версию", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("cas-put-throw"),
    });
    await repository.save({ amountMinor: 12345 });
    const before = await repository.loadVersioned();
    const originalPut = IDBObjectStore.prototype.put;
    let abortTerminal = false;
    let caught: unknown;

    try {
      IDBObjectStore.prototype.put = function injectedCasPutThrow(this: IDBObjectStore): IDBRequest<IDBValidKey> {
        this.transaction.addEventListener("abort", () => {
          abortTerminal = true;
        }, { once: true });
        throw new Error("injected-secret-cas-put");
      } as typeof IDBObjectStore.prototype.put;
      try {
        await repository.saveIfRevision(before!.revision, { amountMinor: 54321 });
      } catch (error) {
        caught = error;
      }
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }

    expect(abortTerminal).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Транзакция хранилища/);
    expect((caught as Error).message).not.toContain("injected-secret");
    expect(await repository.loadVersioned()).toEqual(before);
  });

  it("CAS откатывает асинхронную put request ошибку и остаётся доступным", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("cas-put-error"),
    });
    await repository.save({ amountMinor: 12345 });
    const before = await repository.loadVersioned();
    const originalPut = IDBObjectStore.prototype.put;
    const originalAdd = IDBObjectStore.prototype.add;
    let abortTerminal = false;

    try {
      IDBObjectStore.prototype.put = function injectedCasPutError(
        this: IDBObjectStore,
        value: unknown,
      ): IDBRequest<IDBValidKey> {
        this.transaction.addEventListener("abort", () => {
          abortTerminal = true;
        }, { once: true });
        return originalAdd.call(this, value);
      } as typeof IDBObjectStore.prototype.put;

      await expect(repository.saveIfRevision(before!.revision, { amountMinor: 54321 })).rejects.toThrow(
        /Транзакция хранилища/,
      );
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }

    expect(abortTerminal).toBe(true);
    expect(await repository.loadVersioned()).toEqual(before);
    await expect(repository.saveIfRevision(before!.revision, { amountMinor: 54321 })).resolves.toMatchObject({
      status: "saved",
      value: { amountMinor: 54321 },
    });
  });

  it("CAS откатывает запись при синхронном read-back get сбое без зависания и утечки detail", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("cas-readback-get-throw"),
    });
    await repository.save({ amountMinor: 12345 });
    const before = await repository.loadVersioned();
    const originalGet = IDBObjectStore.prototype.get;
    let getCalls = 0;
    let abortTerminal = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let caught: unknown;

    try {
      IDBObjectStore.prototype.get = function injectedCasReadbackGetThrow(
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ): IDBRequest<unknown> {
        getCalls += 1;
        if (getCalls === 2) {
          this.transaction.addEventListener("abort", () => {
            abortTerminal = true;
          }, { once: true });
          throw new Error("injected-secret-cas-readback-get");
        }
        return originalGet.call(this, query);
      } as typeof IDBObjectStore.prototype.get;
      const livenessTimeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("CAS read-back did not settle")), 500);
      });
      try {
        await Promise.race([
          repository.saveIfRevision(before!.revision, { amountMinor: 54321 }),
          livenessTimeout,
        ]);
      } catch (error) {
        caught = error;
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      IDBObjectStore.prototype.get = originalGet;
    }

    expect(getCalls).toBe(2);
    expect(abortTerminal).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Транзакция хранилища/);
    expect((caught as Error).message).not.toMatch(/injected-secret|did not settle/);
    expect(await repository.loadVersioned()).toEqual(before);
  });

  it("CAS откатывает запись при асинхронной read-back get request ошибке", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("cas-readback-get-error"),
    });
    await repository.save({ amountMinor: 12345 });
    const before = await repository.loadVersioned();
    const originalGet = IDBObjectStore.prototype.get;
    const originalAdd = IDBObjectStore.prototype.add;
    let getCalls = 0;
    let abortTerminal = false;

    try {
      IDBObjectStore.prototype.get = function injectedCasReadbackGetError(
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ): IDBRequest<unknown> {
        getCalls += 1;
        if (getCalls === 2) {
          this.transaction.addEventListener("abort", () => {
            abortTerminal = true;
          }, { once: true });
          return originalAdd.call(this, {
            key: "active-budget",
            schemaVersion: 2,
            updatedAt: "2026-07-18T00:00:00.000Z",
            revision: crypto.randomUUID(),
            value: { amountMinor: 0 },
          }) as IDBRequest<unknown>;
        }
        return originalGet.call(this, query);
      } as typeof IDBObjectStore.prototype.get;

      await expect(repository.saveIfRevision(before!.revision, { amountMinor: 54321 })).rejects.toThrow(
        /Транзакция хранилища/,
      );
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }

    expect(getCalls).toBe(2);
    expect(abortTerminal).toBe(true);
    expect(await repository.loadVersioned()).toEqual(before);
  });

  it("CAS откатывается при сбое getter read-back result и не раскрывает detail", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("cas-readback-result-throw"),
    });
    await repository.save({ amountMinor: 12345 });
    const before = await repository.loadVersioned();
    const originalGet = IDBObjectStore.prototype.get;
    const originalResultDescriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result");
    if (!originalResultDescriptor?.get) throw new Error("IDBRequest.result getter is unavailable");
    const markedRequests = new WeakSet<IDBRequest>();
    let getCalls = 0;
    let abortTerminal = false;
    let caught: unknown;

    try {
      IDBObjectStore.prototype.get = function markCasReadbackResult(
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ): IDBRequest<unknown> {
        const request = originalGet.call(this, query);
        getCalls += 1;
        if (getCalls === 2) {
          markedRequests.add(request);
          this.transaction.addEventListener("abort", () => {
            abortTerminal = true;
          }, { once: true });
        }
        return request;
      } as typeof IDBObjectStore.prototype.get;
      Object.defineProperty(IDBRequest.prototype, "result", {
        ...originalResultDescriptor,
        get(this: IDBRequest) {
          if (markedRequests.delete(this)) throw new Error("injected-secret-cas-readback-result");
          return originalResultDescriptor.get!.call(this);
        },
      });
      try {
        await repository.saveIfRevision(before!.revision, { amountMinor: 54321 });
      } catch (error) {
        caught = error;
      }
    } finally {
      IDBObjectStore.prototype.get = originalGet;
      Object.defineProperty(IDBRequest.prototype, "result", originalResultDescriptor);
    }

    expect(getCalls).toBe(2);
    expect(abortTerminal).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Транзакция хранилища/);
    expect((caught as Error).message).not.toContain("injected-secret");
    expect(await repository.loadVersioned()).toEqual(before);
  });

  it("CAS откатывает put при revision mismatch в read-back и не меняет active и metadata", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("cas-readback-revision-mismatch"),
    });
    await repository.save({ amountMinor: 12345 });
    await repository.setLastSuccessfulBackup("2026-07-17T12:00:00.000Z");
    const before = await repository.loadVersioned();
    const originalGet = IDBObjectStore.prototype.get;
    let getCalls = 0;
    let abortTerminal = false;

    try {
      IDBObjectStore.prototype.get = function injectCasRevisionMismatch(
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ): IDBRequest<unknown> {
        getCalls += 1;
        if (getCalls === 2) {
          this.transaction.addEventListener("abort", () => {
            abortTerminal = true;
          }, { once: true });
          return originalGet.call(this, "metadata:last-successful-backup");
        }
        return originalGet.call(this, query);
      } as typeof IDBObjectStore.prototype.get;

      await expect(repository.saveIfRevision(before!.revision, { amountMinor: 54321 })).rejects.toThrow(
        /Транзакция хранилища/,
      );
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }

    expect(getCalls).toBe(2);
    expect(abortTerminal).toBe(true);
    expect(await repository.loadVersioned()).toEqual(before);
    expect(await repository.getLastSuccessfulBackup()).toBe("2026-07-17T12:00:00.000Z");
    expect(await repository.documentCount()).toBe(2);
  });

  it("отклоняет неклонируемое значение до записи и остаётся доступным", async () => {
    const repository = new IndexedDbBudgetRepository<unknown>({ databaseName: name("create-if-absent-abort") });
    const uncloneableValue = { amountMinor: 12345, callback: () => undefined };

    await expect(repository.createIfAbsent(uncloneableValue)).rejects.toThrow(/безопасно скопирован/);
    expect(await repository.documentCount()).toBe(0);
    expect(await repository.load()).toBeNull();

    const validValue = { amountMinor: 12345 };
    await expect(repository.createIfAbsent(validValue)).resolves.toEqual({ status: "created", value: validValue });
    expect(await repository.load()).toEqual(validValue);
    expect(await repository.documentCount()).toBe(1);
  });

  it("возвращает только generic ошибку при синхронном сбое создания транзакции", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("create-if-absent-transaction-throw"),
    });
    expect(await repository.load()).toBeNull();
    const originalTransaction = IDBDatabase.prototype.transaction;
    let caught: unknown;

    try {
      IDBDatabase.prototype.transaction = function injectedTransactionThrow(): IDBTransaction {
        throw new Error("injected-secret-transaction");
      };
      try {
        await repository.createIfAbsent({ amountMinor: 12345 });
      } catch (error) {
        caught = error;
      }
    } finally {
      IDBDatabase.prototype.transaction = originalTransaction;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/транзакцию локального хранилища/);
    expect((caught as Error).message).not.toContain("injected-secret");
    expect(await repository.load()).toBeNull();
  });

  it("терминально откатывает синхронный сбой objectStore и не раскрывает injected detail", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("create-if-absent-object-store-throw"),
    });
    expect(await repository.load()).toBeNull();
    const originalObjectStore = IDBTransaction.prototype.objectStore;
    let abortTerminal = false;
    let caught: unknown;

    try {
      IDBTransaction.prototype.objectStore = function injectedObjectStoreThrow(): IDBObjectStore {
        this.addEventListener("abort", () => {
          abortTerminal = true;
        }, { once: true });
        throw new Error("injected-secret-object-store");
      };
      try {
        await repository.createIfAbsent({ amountMinor: 12345 });
      } catch (error) {
        caught = error;
      }
    } finally {
      IDBTransaction.prototype.objectStore = originalObjectStore;
    }

    expect(abortTerminal).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Транзакция хранилища/);
    expect((caught as Error).message).not.toContain("injected-secret");
    expect(await repository.load()).toBeNull();
    await expect(repository.createIfAbsent({ amountMinor: 12345 })).resolves.toMatchObject({ status: "created" });
  });

  it("терминально откатывает синхронный initial get throw без утечки detail и зависания", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("create-if-absent-initial-get-throw"),
    });
    const originalGet = IDBObjectStore.prototype.get;
    let abortTerminal = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let caught: unknown;

    try {
      IDBObjectStore.prototype.get = function injectedInitialGetThrow(this: IDBObjectStore): IDBRequest<unknown> {
        this.transaction.addEventListener("abort", () => {
          abortTerminal = true;
        }, { once: true });
        throw new Error("injected-secret-initial-get");
      } as typeof IDBObjectStore.prototype.get;
      const livenessTimeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("createIfAbsent did not settle")), 500);
      });
      try {
        await Promise.race([repository.createIfAbsent({ amountMinor: 12345 }), livenessTimeout]);
      } catch (error) {
        caught = error;
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      IDBObjectStore.prototype.get = originalGet;
    }

    expect(abortTerminal).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Транзакция хранилища/);
    expect((caught as Error).message).not.toMatch(/injected-secret|did not settle/);
    expect(await repository.documentCount()).toBe(0);
    expect(await repository.load()).toBeNull();
    await expect(repository.createIfAbsent({ amountMinor: 12345 })).resolves.toMatchObject({ status: "created" });
  });

  it("терминально откатывает асинхронную initial get request ошибку", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("create-if-absent-initial-get-error"),
    });
    const originalGet = IDBObjectStore.prototype.get;
    const originalAdd = IDBObjectStore.prototype.add;
    let abortTerminal = false;
    let caught: unknown;

    try {
      IDBObjectStore.prototype.get = function injectedInitialGetError(this: IDBObjectStore): IDBRequest<unknown> {
        this.transaction.addEventListener("abort", () => {
          abortTerminal = true;
        }, { once: true });
        const document = {
          key: "active-budget",
          schemaVersion: 2,
          updatedAt: "2026-07-18T00:00:00.000Z",
          value: { amountMinor: 0 },
        };
        originalAdd.call(this, document);
        return originalAdd.call(this, document) as IDBRequest<unknown>;
      } as typeof IDBObjectStore.prototype.get;
      try {
        await repository.createIfAbsent({ amountMinor: 12345 });
      } catch (error) {
        caught = error;
      }
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }

    expect(abortTerminal).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Транзакция хранилища/);
    expect(await repository.documentCount()).toBe(0);
    expect(await repository.load()).toBeNull();
  });

  it("терминально откатывает синхронный add throw без утечки detail", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("create-if-absent-add-throw"),
    });
    const originalAdd = IDBObjectStore.prototype.add;
    let abortTerminal = false;
    let caught: unknown;

    try {
      IDBObjectStore.prototype.add = function injectedAddThrow(this: IDBObjectStore): IDBRequest<IDBValidKey> {
        this.transaction.addEventListener("abort", () => {
          abortTerminal = true;
        }, { once: true });
        throw new Error("injected-secret-add");
      } as typeof IDBObjectStore.prototype.add;
      try {
        await repository.createIfAbsent({ amountMinor: 12345 });
      } catch (error) {
        caught = error;
      }
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
    }

    expect(abortTerminal).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Транзакция хранилища/);
    expect((caught as Error).message).not.toContain("injected-secret");
    expect(await repository.documentCount()).toBe(0);
    await expect(repository.createIfAbsent({ amountMinor: 12345 })).resolves.toMatchObject({ status: "created" });
  });

  it("откатывает createIfAbsent при асинхронной ошибке add request и не зависает", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("create-if-absent-add-error"),
    });
    const originalAdd = IDBObjectStore.prototype.add;
    let abortTerminal = false;

    try {
      IDBObjectStore.prototype.add = function injectedDuplicateAdd(
        this: IDBObjectStore,
        value: unknown,
      ): IDBRequest<IDBValidKey> {
        this.transaction.addEventListener("abort", () => {
          abortTerminal = true;
        }, { once: true });
        originalAdd.call(this, value);
        return originalAdd.call(this, value);
      } as typeof IDBObjectStore.prototype.add;

      await expect(repository.createIfAbsent({ amountMinor: 12345 })).rejects.toThrow(/Транзакция хранилища/);
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
    }

    expect(abortTerminal).toBe(true);
    expect(await repository.documentCount()).toBe(0);
    expect(await repository.load()).toBeNull();
    await expect(repository.createIfAbsent({ amountMinor: 12345 })).resolves.toEqual({
      status: "created",
      value: { amountMinor: 12345 },
    });
  });

  it("откатывает созданный документ при асинхронной ошибке контрольного read-back", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("create-if-absent-readback-error"),
    });
    const originalGet = IDBObjectStore.prototype.get;
    const originalAdd = IDBObjectStore.prototype.add;
    let getCalls = 0;

    try {
      IDBObjectStore.prototype.get = function injectedReadBackError(
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ): IDBRequest<unknown> {
        getCalls += 1;
        if (getCalls === 2) {
          return originalAdd.call(this, {
            key: "active-budget",
            schemaVersion: 2,
            updatedAt: "2026-07-18T00:00:00.000Z",
            value: { amountMinor: 0 },
          }) as IDBRequest<unknown>;
        }
        return originalGet.call(this, query);
      } as typeof IDBObjectStore.prototype.get;

      await expect(repository.createIfAbsent({ amountMinor: 12345 })).rejects.toThrow(/Транзакция хранилища/);
    } finally {
      IDBObjectStore.prototype.get = originalGet;
    }

    expect(getCalls).toBe(2);
    expect(await repository.documentCount()).toBe(0);
    expect(await repository.load()).toBeNull();
  });

  it("откатывает add при синхронной ошибке создания read-back request и не зависает", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("create-if-absent-readback-throw"),
    });
    const originalGet = IDBObjectStore.prototype.get;
    let getCalls = 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      IDBObjectStore.prototype.get = function injectedReadBackThrow(
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ): IDBRequest<unknown> {
        getCalls += 1;
        if (getCalls === 2) throw new Error("injected synchronous read-back failure");
        return originalGet.call(this, query);
      } as typeof IDBObjectStore.prototype.get;

      const livenessTimeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("createIfAbsent did not settle")), 500);
      });
      await expect(Promise.race([
        repository.createIfAbsent({ amountMinor: 12345 }),
        livenessTimeout,
      ])).rejects.toThrow(/Транзакция хранилища/);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      IDBObjectStore.prototype.get = originalGet;
    }

    expect(getCalls).toBe(2);
    expect(await repository.documentCount()).toBe(0);
    expect(await repository.load()).toBeNull();
    await expect(repository.createIfAbsent({ amountMinor: 12345 })).resolves.toEqual({
      status: "created",
      value: { amountMinor: 12345 },
    });
  });

  it("откатывает транзакцию при синхронной ошибке чтения initial result и остаётся доступным", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("create-if-absent-initial-result-throw"),
    });
    const originalGet = IDBObjectStore.prototype.get;
    const originalResultDescriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result");
    if (!originalResultDescriptor?.get) throw new Error("IDBRequest.result getter is unavailable");
    const markedRequests = new WeakSet<IDBRequest>();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      IDBObjectStore.prototype.get = function markInitialGet(
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ): IDBRequest<unknown> {
        const request = originalGet.call(this, query);
        markedRequests.add(request);
        return request;
      } as typeof IDBObjectStore.prototype.get;
      Object.defineProperty(IDBRequest.prototype, "result", {
        ...originalResultDescriptor,
        get(this: IDBRequest) {
          if (markedRequests.delete(this)) throw new Error("injected initial result getter failure");
          return originalResultDescriptor.get!.call(this);
        },
      });

      const livenessTimeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("createIfAbsent did not settle")), 500);
      });
      await expect(Promise.race([
        repository.createIfAbsent({ amountMinor: 12345 }),
        livenessTimeout,
      ])).rejects.toThrow(/Транзакция хранилища/);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      IDBObjectStore.prototype.get = originalGet;
      Object.defineProperty(IDBRequest.prototype, "result", originalResultDescriptor);
    }

    expect(await repository.documentCount()).toBe(0);
    expect(await repository.load()).toBeNull();
    await expect(repository.createIfAbsent({ amountMinor: 12345 })).resolves.toEqual({
      status: "created",
      value: { amountMinor: 12345 },
    });
  });

  it("откатывает транзакцию при синхронной ошибке чтения read-back result", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("create-if-absent-readback-result-throw"),
    });
    const originalGet = IDBObjectStore.prototype.get;
    const originalResultDescriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result");
    if (!originalResultDescriptor?.get) throw new Error("IDBRequest.result getter is unavailable");
    const markedRequests = new WeakSet<IDBRequest>();
    let getCalls = 0;
    let abortTerminal = false;
    let caught: unknown;

    try {
      IDBObjectStore.prototype.get = function markReadBackGet(
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ): IDBRequest<unknown> {
        const request = originalGet.call(this, query);
        getCalls += 1;
        if (getCalls === 2) {
          markedRequests.add(request);
          this.transaction.addEventListener("abort", () => {
            abortTerminal = true;
          }, { once: true });
        }
        return request;
      } as typeof IDBObjectStore.prototype.get;
      Object.defineProperty(IDBRequest.prototype, "result", {
        ...originalResultDescriptor,
        get(this: IDBRequest) {
          if (markedRequests.delete(this)) throw new Error("injected-secret-readback-result");
          return originalResultDescriptor.get!.call(this);
        },
      });

      try {
        await repository.createIfAbsent({ amountMinor: 12345 });
      } catch (error) {
        caught = error;
      }
    } finally {
      IDBObjectStore.prototype.get = originalGet;
      Object.defineProperty(IDBRequest.prototype, "result", originalResultDescriptor);
    }

    expect(getCalls).toBe(2);
    expect(abortTerminal).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Транзакция хранилища/);
    expect((caught as Error).message).not.toContain("injected-secret");
    expect(await repository.documentCount()).toBe(0);
    expect(await repository.load()).toBeNull();
  });

  it("ждёт terminal abort, даже если abort wrapper сам бросает исключение", async () => {
    const repository = new IndexedDbBudgetRepository<{ amountMinor: number }>({
      databaseName: name("create-if-absent-abort-throw"),
    });
    const originalAdd = IDBObjectStore.prototype.add;
    const originalAbort = IDBTransaction.prototype.abort;
    let abortTerminal = false;
    let caught: unknown;

    try {
      IDBObjectStore.prototype.add = function injectedAddThrow(this: IDBObjectStore): IDBRequest<IDBValidKey> {
        this.transaction.addEventListener("abort", () => {
          abortTerminal = true;
        }, { once: true });
        throw new Error("injected-secret-trigger-abort");
      } as typeof IDBObjectStore.prototype.add;
      IDBTransaction.prototype.abort = function injectedAbortThrow(): void {
        originalAbort.call(this);
        throw new Error("injected-secret-abort");
      };
      try {
        await repository.createIfAbsent({ amountMinor: 12345 });
      } catch (error) {
        caught = error;
      }
    } finally {
      IDBObjectStore.prototype.add = originalAdd;
      IDBTransaction.prototype.abort = originalAbort;
    }

    expect(abortTerminal).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Транзакция хранилища/);
    expect((caught as Error).message).not.toContain("injected-secret");
    expect(await repository.documentCount()).toBe(0);
    await expect(repository.createIfAbsent({ amountMinor: 12345 })).resolves.toMatchObject({ status: "created" });
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

  it("не воскрешает metadata, если другая вкладка завершила clear до поздней post-download записи", async () => {
    const databaseName = name("metadata-after-two-tab-clear");
    const clearingTab = new IndexedDbBudgetRepository<{ amountMinor: number }>({ databaseName });
    const backupTab = new IndexedDbBudgetRepository<{ amountMinor: number }>({ databaseName });
    await clearingTab.save({ amountMinor: 12345 });
    expect(await backupTab.loadVersioned()).not.toBeNull();

    await clearingTab.clear();
    await expect(
      backupTab.setLastSuccessfulBackup("2026-07-24T09:10:11.000Z"),
    ).rejects.toThrow(/бюджет уже удалён/);

    expect(await clearingTab.documentCount()).toBe(0);
    expect(await clearingTab.loadVersioned()).toBeNull();
    expect(await clearingTab.getLastSuccessfulBackup()).toBeNull();
  });

  it("не меняет metadata, если последующий export завершился ошибкой", async () => {
    const repository = new IndexedDbBudgetRepository({ databaseName: name("failed-export") });
    await repository.save({ amountMinor: 12345 });
    await repository.setLastSuccessfulBackup("2026-07-17T12:00:00.000Z");
    const codec = new ValidatedBackupCodec((value) => value);

    expect(() => codec.serialize({ left: { id: "same" }, right: { id: "same" } })).toThrow(/повторяющийся/);
    expect(await repository.getLastSuccessfulBackup()).toBe("2026-07-17T12:00:00.000Z");
  });
});
