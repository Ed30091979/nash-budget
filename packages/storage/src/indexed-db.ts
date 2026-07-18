const DEFAULT_DATABASE_NAME = "family-budget";
const DATABASE_VERSION = 2;
const STORE_NAME = "documents";
const ACTIVE_BUDGET_KEY = "active-budget";
const LAST_BACKUP_KEY = "metadata:last-successful-backup";

interface StoredDocument<T> {
  readonly key: string;
  readonly schemaVersion: number;
  readonly updatedAt: string;
  readonly revision?: string;
  readonly value: T;
}

export interface StorageHealth {
  readonly persisted: boolean;
  readonly usage: number | null;
  readonly quota: number | null;
}

export interface RepositoryOptions<T = unknown> {
  readonly databaseName?: string;
  /** Synchronous v1 payload validator/transform; throwing aborts the whole versionchange transaction. */
  readonly migrateV1Value?: (value: unknown, key: string) => T;
}

export type CreateIfAbsentResult<T> =
  | { readonly status: "created"; readonly value: T }
  | { readonly status: "existing"; readonly value: T };

export interface VersionedSnapshot<T> {
  readonly value: T;
  readonly revision: string;
}

export type SaveIfRevisionResult<T> =
  | { readonly status: "saved"; readonly value: T; readonly revision: string }
  | { readonly status: "conflict"; readonly current: VersionedSnapshot<T> | null };

function databaseError(message: string): Error {
  return new Error(message);
}

function guardGenericV1Value(value: unknown): unknown {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  const ids = new Set<string>();
  let nodes = 0;
  let characterUnits = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 100_000) throw databaseError("Документ v1 содержит слишком много данных.");
    if (current.depth > 64) throw databaseError("Документ v1 имеет слишком глубокую структуру.");
    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "string") {
      characterUnits += current.value.length;
      if (characterUnits > 5 * 1024 * 1024) throw databaseError("Документ v1 содержит слишком много текста.");
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value) || Math.abs(current.value) > Number.MAX_SAFE_INTEGER) {
        throw databaseError("Документ v1 содержит небезопасное число.");
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > 50_000) throw databaseError("Документ v1 содержит слишком большую коллекцию.");
      if (seen.has(current.value)) throw databaseError("Документ v1 содержит циклическую ссылку.");
      seen.add(current.value);
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (typeof current.value !== "object" || current.value === undefined) {
      throw databaseError("Документ v1 содержит неподдерживаемый тип данных.");
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw databaseError("Документ v1 содержит неподдерживаемый тип данных.");
    }
    if (seen.has(current.value)) throw databaseError("Документ v1 содержит циклическую ссылку.");
    seen.add(current.value);
    const entries = Object.entries(current.value);
    if (entries.length > 50_000) throw databaseError("Документ v1 содержит слишком большую коллекцию.");
    for (const [key, child] of entries) {
      characterUnits += key.length;
      if (characterUnits > 5 * 1024 * 1024) throw databaseError("Документ v1 содержит слишком много текста.");
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw databaseError("Документ v1 содержит запрещённое имя поля.");
      }
      if (key === "id" && typeof child === "string") {
        if (ids.has(child)) throw databaseError("Документ v1 содержит повторяющийся идентификатор.");
        ids.add(child);
      }
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return value;
}

function migrateV1ToV2<T>(store: IDBObjectStore, options: RepositoryOptions<T>, transaction: IDBTransaction): void {
  const cursorRequest = store.openCursor();
  cursorRequest.onerror = () => transaction.abort();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    try {
      const document = cursor.value as Partial<StoredDocument<unknown>> | null;
      if (
        !document ||
        typeof document !== "object" ||
        typeof document.key !== "string" ||
        document.schemaVersion !== 1 ||
        typeof document.updatedAt !== "string" ||
        !("value" in document)
      ) {
        throw databaseError("Документ v1 не может быть безопасно мигрирован.");
      }
      guardGenericV1Value(document.value);
      const migratedValue = options.migrateV1Value
        ? options.migrateV1Value(document.value, document.key)
        : document.value;
      if (migratedValue && typeof (migratedValue as { then?: unknown }).then === "function") {
        throw databaseError("Миграция v1 должна быть синхронной.");
      }
      guardGenericV1Value(migratedValue);
      cursor.update({
        key: document.key,
        schemaVersion: 2,
        updatedAt: document.updatedAt,
        value: migratedValue,
      } satisfies StoredDocument<unknown>);
      cursor.continue();
    } catch {
      transaction.abort();
    }
  };
}

function openDatabase<T>(options: RepositoryOptions<T>): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(options.databaseName ?? DEFAULT_DATABASE_NAME, DATABASE_VERSION);
    let settled = false;

    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      if (!transaction) {
        request.result.close();
        return;
      }
      try {
        const oldVersion = event.oldVersion;
        if (oldVersion === 0) database.createObjectStore(STORE_NAME, { keyPath: "key" });
        if (oldVersion >= 1 && oldVersion < 2) {
          migrateV1ToV2(transaction.objectStore(STORE_NAME), options, transaction);
        }
      } catch {
        transaction.abort();
      }
    };

    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(databaseError("Не удалось открыть или обновить локальное хранилище."));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(databaseError("Обновление локального хранилища заблокировано другой вкладкой."));
    };
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(databaseError("Ошибка локального хранилища."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(databaseError("Транзакция хранилища завершилась ошибкой."));
    transaction.onabort = () => reject(databaseError("Транзакция хранилища отменена."));
  });
}

function createRevision(): string {
  try {
    return crypto.randomUUID();
  } catch {
    throw databaseError("Не удалось подготовить версию для локального хранилища.");
  }
}

function makeDocument<T>(key: string, value: T, now: Date, revision = createRevision()): StoredDocument<T> {
  return { key, schemaVersion: DATABASE_VERSION, updatedAt: now.toISOString(), revision, value };
}

function isCurrentRevision(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function corruptRevisionError(): Error {
  return databaseError("Документ локального хранилища повреждён.");
}

function cloneForStorage<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw databaseError("Документ не может быть безопасно скопирован в локальное хранилище.");
  }
}

export class IndexedDbBudgetRepository<T> {
  private readonly options: RepositoryOptions<T>;

  constructor(options: RepositoryOptions<T> = {}) {
    this.options = options;
  }

  private async withDatabase<R>(operation: (database: IDBDatabase) => Promise<R>): Promise<R> {
    const database = await openDatabase(this.options);
    try {
      return await operation(database);
    } finally {
      database.close();
    }
  }

  async load(): Promise<T | null> {
    return this.withDatabase(async (database) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const result = await requestResult(
        transaction.objectStore(STORE_NAME).get(ACTIVE_BUDGET_KEY) as IDBRequest<StoredDocument<T> | undefined>,
      );
      return result?.value ?? null;
    });
  }

  async loadVersioned(): Promise<VersionedSnapshot<T> | null> {
    const upgradeRevision = createRevision();
    return this.withDatabase(
      (database) =>
        new Promise<VersionedSnapshot<T> | null>((resolve, reject) => {
          let transaction: IDBTransaction;
          try {
            transaction = database.transaction(STORE_NAME, "readwrite");
          } catch {
            reject(databaseError("Не удалось начать транзакцию локального хранилища."));
            return;
          }
          let result: VersionedSnapshot<T> | null | undefined;
          let settled = false;
          let transactionFailed = false;
          let terminalError: Error | undefined;
          const rejectOnce = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
          };
          const abort = (error?: Error) => {
            transactionFailed = true;
            terminalError ??= error;
            try {
              transaction.abort();
            } catch {
              // Settle through the terminal transaction event.
            }
          };

          transaction.oncomplete = () => {
            if (transactionFailed) {
              rejectOnce(terminalError ?? databaseError("Транзакция хранилища завершилась ошибкой."));
              return;
            }
            if (result === undefined) {
              rejectOnce(databaseError("Транзакция хранилища завершилась без результата."));
              return;
            }
            if (settled) return;
            settled = true;
            resolve(result);
          };
          transaction.onerror = () => {
            transactionFailed = true;
          };
          transaction.onabort = () => rejectOnce(terminalError ?? databaseError("Транзакция хранилища отменена."));

          let store: IDBObjectStore;
          try {
            store = transaction.objectStore(STORE_NAME);
          } catch {
            abort();
            return;
          }

          let request: IDBRequest<StoredDocument<T> | undefined>;
          try {
            request = store.get(ACTIVE_BUDGET_KEY) as IDBRequest<StoredDocument<T> | undefined>;
          } catch {
            abort();
            return;
          }
          request.onerror = () => abort();
          request.onsuccess = () => {
            let document: StoredDocument<T> | undefined;
            try {
              document = request.result;
            } catch {
              abort();
              return;
            }
            if (!document) {
              result = null;
              return;
            }
            if (isCurrentRevision(document.revision)) {
              result = { value: document.value, revision: document.revision };
              return;
            }
            if (document.revision !== undefined) {
              abort(corruptRevisionError());
              return;
            }

            try {
              const writeRequest = store.put({ ...document, revision: upgradeRevision });
              writeRequest.onerror = () => abort();
              writeRequest.onsuccess = () => {
                let readBackRequest: IDBRequest<StoredDocument<T> | undefined>;
                try {
                  readBackRequest = store.get(ACTIVE_BUDGET_KEY) as IDBRequest<StoredDocument<T> | undefined>;
                } catch {
                  abort();
                  return;
                }
                readBackRequest.onerror = () => abort();
                readBackRequest.onsuccess = () => {
                  try {
                    const stored = readBackRequest.result;
                    if (!stored || stored.revision !== upgradeRevision) {
                      abort();
                      return;
                    }
                    result = { value: stored.value, revision: upgradeRevision };
                  } catch {
                    abort();
                  }
                };
              };
            } catch {
              abort();
            }
          };
        }),
    );
  }

  async save(value: T): Promise<void> {
    await this.withDatabase(async (database) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(makeDocument(ACTIVE_BUDGET_KEY, value, new Date()));
      await transactionComplete(transaction);
    });
  }

  /**
   * Atomically writes only if the active document still has expectedRevision.
   * A null expectation matches an absent document. Both success and conflict
   * values are snapshots produced by IndexedDB, never the caller-owned object.
   */
  async saveIfRevision(expectedRevision: string | null, value: T): Promise<SaveIfRevisionResult<T>> {
    const valueSnapshot = cloneForStorage(value);
    const nextRevision = createRevision();
    const upgradeRevision = createRevision();

    return this.withDatabase(
      (database) =>
        new Promise<SaveIfRevisionResult<T>>((resolve, reject) => {
          let transaction: IDBTransaction;
          try {
            transaction = database.transaction(STORE_NAME, "readwrite");
          } catch {
            reject(databaseError("Не удалось начать транзакцию локального хранилища."));
            return;
          }

          let result: SaveIfRevisionResult<T> | undefined;
          let settled = false;
          let transactionFailed = false;
          let terminalError: Error | undefined;

          const rejectOnce = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
          };
          const abort = (error?: Error) => {
            transactionFailed = true;
            terminalError ??= error;
            try {
              transaction.abort();
            } catch {
              // The terminal transaction event owns settlement even if a wrapper throws.
            }
          };

          transaction.oncomplete = () => {
            if (transactionFailed) {
              rejectOnce(terminalError ?? databaseError("Транзакция хранилища завершилась ошибкой."));
              return;
            }
            if (!result) {
              rejectOnce(databaseError("Транзакция хранилища завершилась без результата."));
              return;
            }
            if (settled) return;
            settled = true;
            resolve(result);
          };
          transaction.onerror = () => {
            transactionFailed = true;
          };
          transaction.onabort = () => rejectOnce(terminalError ?? databaseError("Транзакция хранилища отменена."));

          let store: IDBObjectStore;
          try {
            store = transaction.objectStore(STORE_NAME);
          } catch {
            abort();
            return;
          }

          let readRequest: IDBRequest<StoredDocument<T> | undefined>;
          try {
            readRequest = store.get(ACTIVE_BUDGET_KEY) as IDBRequest<StoredDocument<T> | undefined>;
          } catch {
            abort();
            return;
          }
          readRequest.onerror = () => abort();
          readRequest.onsuccess = () => {
            let currentDocument: StoredDocument<T> | undefined;
            try {
              currentDocument = readRequest.result;
            } catch {
              abort();
              return;
            }

            if (currentDocument && !isCurrentRevision(currentDocument.revision)) {
              if (currentDocument.revision !== undefined) {
                abort(corruptRevisionError());
                return;
              }
              try {
                const upgradeRequest = store.put({ ...currentDocument, revision: upgradeRevision });
                upgradeRequest.onerror = () => abort();
                upgradeRequest.onsuccess = () => {
                  let readBackRequest: IDBRequest<StoredDocument<T> | undefined>;
                  try {
                    readBackRequest = store.get(ACTIVE_BUDGET_KEY) as IDBRequest<StoredDocument<T> | undefined>;
                  } catch {
                    abort();
                    return;
                  }
                  readBackRequest.onerror = () => abort();
                  readBackRequest.onsuccess = () => {
                    try {
                      const upgraded = readBackRequest.result;
                      if (!upgraded || upgraded.revision !== upgradeRevision) {
                        abort();
                        return;
                      }
                      result = {
                        status: "conflict",
                        current: { value: upgraded.value, revision: upgradeRevision },
                      };
                    } catch {
                      abort();
                    }
                  };
                };
              } catch {
                abort();
              }
              return;
            }

            const current = currentDocument
              ? { value: currentDocument.value, revision: currentDocument.revision! }
              : null;
            const matches = current ? current.revision === expectedRevision : expectedRevision === null;
            if (!matches) {
              result = { status: "conflict", current };
              return;
            }

            try {
              const writeRequest = store.put(
                makeDocument(ACTIVE_BUDGET_KEY, valueSnapshot, new Date(), nextRevision),
              );
              writeRequest.onerror = () => abort();
              writeRequest.onsuccess = () => {
                let readBackRequest: IDBRequest<StoredDocument<T> | undefined>;
                try {
                  readBackRequest = store.get(ACTIVE_BUDGET_KEY) as IDBRequest<StoredDocument<T> | undefined>;
                } catch {
                  abort();
                  return;
                }
                readBackRequest.onerror = () => abort();
                readBackRequest.onsuccess = () => {
                  try {
                    const stored = readBackRequest.result;
                    if (!stored || stored.revision !== nextRevision) {
                      abort();
                      return;
                    }
                    result = { status: "saved", value: stored.value, revision: nextRevision };
                  } catch {
                    abort();
                  }
                };
              };
            } catch {
              abort();
            }
          };
        }),
    );
  }

  /** Creates the active document only when it is still absent in the same read/write transaction. */
  async createIfAbsent(value: T): Promise<CreateIfAbsentResult<T>> {
    const valueSnapshot = cloneForStorage(value);

    return this.withDatabase(
      (database) =>
        new Promise<CreateIfAbsentResult<T>>((resolve, reject) => {
          let transaction: IDBTransaction;
          try {
            transaction = database.transaction(STORE_NAME, "readwrite");
          } catch {
            reject(databaseError("Не удалось начать транзакцию локального хранилища."));
            return;
          }
          let result: CreateIfAbsentResult<T> | undefined;
          let settled = false;
          let transactionFailed = false;

          const rejectOnce = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
          };
          const abort = () => {
            transactionFailed = true;
            try {
              transaction.abort();
            } catch {
              // An inactive transaction will still finish through onabort/oncomplete; settle only there.
            }
          };

          transaction.oncomplete = () => {
            if (transactionFailed) {
              rejectOnce(databaseError("Транзакция хранилища завершилась ошибкой."));
              return;
            }
            if (!result) {
              rejectOnce(databaseError("Транзакция хранилища завершилась без результата."));
              return;
            }
            if (settled) return;
            settled = true;
            resolve(result);
          };
          transaction.onerror = () => {
            transactionFailed = true;
          };
          transaction.onabort = () => rejectOnce(databaseError("Транзакция хранилища отменена."));

          let store: IDBObjectStore;
          try {
            store = transaction.objectStore(STORE_NAME);
          } catch {
            abort();
            return;
          }

          let readRequest: IDBRequest<StoredDocument<T> | undefined>;
          try {
            readRequest = store.get(ACTIVE_BUDGET_KEY) as IDBRequest<StoredDocument<T> | undefined>;
          } catch {
            abort();
            return;
          }
          readRequest.onerror = abort;
          readRequest.onsuccess = () => {
            let existing: StoredDocument<T> | undefined;
            try {
              existing = readRequest.result;
            } catch {
              abort();
              return;
            }
            if (existing) {
              result = { status: "existing", value: existing.value };
              return;
            }

            try {
              const addRequest = store.add(makeDocument(ACTIVE_BUDGET_KEY, valueSnapshot, new Date()));
              addRequest.onerror = abort;
              addRequest.onsuccess = () => {
                try {
                  const readBackRequest = store.get(ACTIVE_BUDGET_KEY) as IDBRequest<StoredDocument<T> | undefined>;
                  readBackRequest.onerror = abort;
                  readBackRequest.onsuccess = () => {
                    try {
                      const created = readBackRequest.result;
                      if (!created) {
                        abort();
                        return;
                      }
                      result = { status: "created", value: created.value };
                    } catch {
                      abort();
                    }
                  };
                } catch {
                  abort();
                }
              };
            } catch {
              abort();
            }
          };
        }),
    );
  }

  /** Parses and validates completely before opening the single write transaction. */
  async restore(text: string, parseAndValidate: (text: string) => T): Promise<T> {
    const value = parseAndValidate(text);
    await this.save(value);
    return value;
  }

  async setLastSuccessfulBackup(createdAt: string): Promise<void> {
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime()) || date.toISOString() !== createdAt) {
      throw new Error("Некорректная дата резервной копии.");
    }
    await this.withDatabase(async (database) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(makeDocument(LAST_BACKUP_KEY, createdAt, date));
      await transactionComplete(transaction);
    });
  }

  async getLastSuccessfulBackup(): Promise<string | null> {
    return this.withDatabase(async (database) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const result = await requestResult(
        transaction.objectStore(STORE_NAME).get(LAST_BACKUP_KEY) as IDBRequest<StoredDocument<string> | undefined>,
      );
      return result?.value ?? null;
    });
  }

  /** Removes the whole repository, including metadata, in one transaction. */
  async clear(): Promise<void> {
    await this.withDatabase(async (database) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).clear();
      await transactionComplete(transaction);
    });
  }

  async documentCount(): Promise<number> {
    return this.withDatabase(async (database) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      return requestResult(transaction.objectStore(STORE_NAME).count());
    });
  }
}

export async function requestStorageHealth(): Promise<StorageHealth> {
  const storage = navigator.storage;
  if (!storage) return { persisted: false, usage: null, quota: null };
  let persisted = storage.persisted ? await storage.persisted() : false;
  if (!persisted && storage.persist) persisted = await storage.persist();
  const estimate = storage.estimate ? await storage.estimate() : {};
  return { persisted, usage: estimate.usage ?? null, quota: estimate.quota ?? null };
}
