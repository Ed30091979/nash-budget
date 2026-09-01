const DEFAULT_DATABASE_NAME = "family-budget";
/**
 * The version every installation reaches, with or without an account.
 *
 * A local-only device stops here and stays here for ever. Section 9 of `SYNC_ARCHITECTURE.md`
 * does not say "synchronisation switched off", it says the queue **is not created** — so a device
 * that never signs in does not get the stores, does not get a version bump, and does not migrate.
 */
const DATABASE_BASE_VERSION = 2;

/**
 * The version that carries the two stores family synchronisation needs.
 *
 * Reached the first time something is actually written to them, which is the first local change
 * made by a device that has joined a family. Nothing about the documents changes with it, and
 * that is why {@link DOCUMENT_SCHEMA_VERSION} is a separate number and stays at `2`: bumping the
 * field on every stored document because the *database* gained an empty store would have made an
 * existing user's budget differ from a migrated one on a field neither of them uses.
 */
const DATABASE_SYNC_VERSION = 3;

/** Shape of one stored document. Unchanged since database version `2`. */
const DOCUMENT_SCHEMA_VERSION = 2;
const STORE_NAME = "documents";
const ACTIVE_BUDGET_KEY = "active-budget";
const LAST_BACKUP_KEY = "metadata:last-successful-backup";

/**
 * The outgoing queue of `SYNC_ARCHITECTURE.md` 3.1 step 7 and 3.3.
 *
 * `autoIncrement` on `sequence` is the FIFO the protocol asks for and the one thing that has to
 * survive a restart: 3.3 sends envelopes in the order their stamps were taken, and a queue whose
 * order came from a `Date.now()` written by the client would reorder itself on a clock change.
 * The unique index on `opId` is the local half of the server's `(familyId, keyEpoch, opId)`
 * index — the same envelope is never queued twice, however many times a save is retried.
 */
export const SYNC_OUTBOX_STORE = "sync-outbox";
/** Cursor, folded journal, Lamport clock and the alarm state of 3.4. Keyed by name. */
export const SYNC_STATE_STORE = "sync-state";
const OUTBOX_OP_ID_INDEX = "opId";

/** One envelope waiting for a `seq`. The payload is opaque here: storage never opens it. */
export interface OutboxAppend {
  readonly opId: string;
  /** Structured-cloneable sealed envelope. `@family-budget/sync-client` owns its shape. */
  readonly envelope: unknown;
}

export interface OutboxRecord extends OutboxAppend {
  /** Assigned by the store, monotone, and the order the queue is drained in. */
  readonly sequence: number;
}

export interface SyncStateEntry {
  readonly key: string;
  readonly value: unknown;
}

/**
 * One local change: the new document, the envelopes it produced and the sync bookkeeping that
 * goes with it, written in a single IndexedDB transaction.
 *
 * 3.1 step 7 is the requirement, in its own words: the envelope goes into the queue *in the same
 * transaction* as the changed state and the new clock. A state changed locally cannot exist
 * without its queue entry, and a queue entry cannot exist without the state it came from.
 */
export interface LocalCommit<T> {
  /** CAS expectation, exactly as {@link IndexedDbBudgetRepository.saveIfRevision} uses it. */
  readonly expectedRevision: string | null;
  readonly value: T;
  readonly outbox?: readonly OutboxAppend[];
  readonly syncState?: readonly SyncStateEntry[];
}

export interface SyncRecordCounts {
  readonly outbox: number;
  readonly state: number;
}

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
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
        updatedAt: document.updatedAt,
        value: migratedValue,
      } satisfies StoredDocument<unknown>);
      cursor.continue();
    } catch {
      transaction.abort();
    }
  };
}

/**
 * Marks the one failure that is not a failure: the database on disk is *newer* than the version
 * this call asked for, because another part of the application has joined a family and created
 * the sync stores. The caller reopens at whatever version is there.
 */
class DatabaseTooNewError extends Error {}

/**
 * Opens the database at `version`, or at whatever version it already has when `version` is
 * `undefined`.
 *
 * `undefined` is only ever used after a {@link DatabaseTooNewError}, so the database is known to
 * exist and no upgrade can be triggered by it.
 */
function openDatabase<T>(options: RepositoryOptions<T>, version: number | undefined): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
    const request =
      version === undefined ? indexedDB.open(databaseName) : indexedDB.open(databaseName, version);
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
        // Membership rather than `oldVersion === 0`: a database opened without a version is
        // created empty at version 1, and the documents store has to appear on the next open
        // whatever number that open carries.
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
        if (oldVersion >= 1 && oldVersion < 2 && database.objectStoreNames.contains(STORE_NAME)) {
          migrateV1ToV2(transaction.objectStore(STORE_NAME), options, transaction);
        }
        // The sync stores are added and nothing else is touched: every document written by
        // version 1 or 2 is carried over exactly as it was — see DOCUMENT_SCHEMA_VERSION. This
        // branch is only reached by a device that is about to write to them.
        if ((version ?? 0) >= DATABASE_SYNC_VERSION) {
          if (!database.objectStoreNames.contains(SYNC_OUTBOX_STORE)) {
            const outbox = database.createObjectStore(SYNC_OUTBOX_STORE, {
              keyPath: "sequence",
              autoIncrement: true,
            });
            outbox.createIndex(OUTBOX_OP_ID_INDEX, "opId", { unique: true });
          }
          if (!database.objectStoreNames.contains(SYNC_STATE_STORE)) {
            database.createObjectStore(SYNC_STATE_STORE, { keyPath: "key" });
          }
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
      if (request.error?.name === "VersionError") {
        reject(new DatabaseTooNewError("local storage is newer than this call asked for"));
        return;
      }
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
  return { key, schemaVersion: DOCUMENT_SCHEMA_VERSION, updatedAt: now.toISOString(), revision, value };
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

  /**
   * The version this instance opens at.
   *
   * Starts at the base version and is raised once — either because a sync write asked for the
   * sync stores, or because an open discovered that some other part of the application had
   * already created them. Raising it is what keeps a signed-in device from paying for the
   * discovery on every single call.
   */
  private targetVersion = DATABASE_BASE_VERSION;

  private async withDatabase<R>(
    operation: (database: IDBDatabase) => Promise<R>,
    minimumVersion = DATABASE_BASE_VERSION,
  ): Promise<R> {
    if (minimumVersion > this.targetVersion) this.targetVersion = minimumVersion;
    let database: IDBDatabase;
    try {
      database = await openDatabase(this.options, this.targetVersion);
    } catch (error) {
      if (!(error instanceof DatabaseTooNewError)) throw error;
      // Another tab, or another repository handle, has joined a family since this instance was
      // constructed. Take the version that is there and remember it.
      database = await openDatabase(this.options, undefined);
      if (database.version > this.targetVersion) this.targetVersion = database.version;
    }
    try {
      return await operation(database);
    } finally {
      database.close();
    }
  }

  /** True when the database in front of us carries the two sync stores. */
  private static hasSyncStores(database: IDBDatabase): boolean {
    return (
      database.objectStoreNames.contains(SYNC_OUTBOX_STORE) &&
      database.objectStoreNames.contains(SYNC_STATE_STORE)
    );
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

  /**
   * Writes the document, the outgoing envelopes and the sync bookkeeping in **one** transaction.
   *
   * This is 3.1 step 7 made executable, and it is also the answer to the compatibility question
   * of phase S4: the compare-and-set is the same one `saveIfRevision` performs, so a delivery of
   * somebody else's operations that lands between this device's read and its write loses the
   * race and is told so, instead of overwriting a local change. Nothing here is written when the
   * revision does not match — not the document, not the queue, not the cursor.
   *
   * Every value is cloned and every envelope serialised **before** the transaction opens. An
   * `await` on anything other than an IndexedDB request would let the transaction commit
   * underneath us, and then "the same transaction" would be a comment rather than a fact.
   */
  async commitWithSync(commit: LocalCommit<T>): Promise<SaveIfRevisionResult<T>> {
    const valueSnapshot = cloneForStorage(commit.value);
    const appends = (commit.outbox ?? []).map((entry) => {
      if (typeof entry.opId !== "string" || entry.opId.length === 0 || entry.opId.length > 128) {
        throw databaseError("Идентификатор операции в очереди некорректен.");
      }
      return { opId: entry.opId, envelope: cloneForStorage(entry.envelope) };
    });
    const stateEntries = (commit.syncState ?? []).map((entry) => {
      if (typeof entry.key !== "string" || entry.key.length === 0 || entry.key.length > 128) {
        throw databaseError("Ключ состояния синхронизации некорректен.");
      }
      return { key: entry.key, value: cloneForStorage(entry.value) };
    });
    const nextRevision = createRevision();
    const upgradeRevision = createRevision();

    return this.withDatabase(async (database) => {
      const transaction = database.transaction(
        [STORE_NAME, SYNC_OUTBOX_STORE, SYNC_STATE_STORE],
        "readwrite",
      );
      const settled = transactionComplete(transaction);
      let result: SaveIfRevisionResult<T>;
      try {
        const documents = transaction.objectStore(STORE_NAME);
        const current = await requestResult(
          documents.get(ACTIVE_BUDGET_KEY) as IDBRequest<StoredDocument<T> | undefined>,
        );

        if (current && !isCurrentRevision(current.revision)) {
          if (current.revision !== undefined) throw corruptRevisionError();
          // A document written before revisions existed. Same treatment as `saveIfRevision`:
          // give it one, hand it back as a conflict, and let the caller retry against it.
          await requestResult(documents.put({ ...current, revision: upgradeRevision }));
          result = {
            status: "conflict",
            current: { value: current.value, revision: upgradeRevision },
          };
        } else {
          const snapshot = current
            ? { value: current.value, revision: current.revision! }
            : null;
          const matches = snapshot
            ? snapshot.revision === commit.expectedRevision
            : commit.expectedRevision === null;
          if (!matches) {
            result = { status: "conflict", current: snapshot };
          } else {
            await requestResult(
              documents.put(makeDocument(ACTIVE_BUDGET_KEY, valueSnapshot, new Date(), nextRevision)),
            );
            const outbox = transaction.objectStore(SYNC_OUTBOX_STORE);
            const index = outbox.index(OUTBOX_OP_ID_INDEX);
            for (const entry of appends) {
              // 3.5: a repeat of the same identifier must not become a second envelope. The
              // unique index would refuse it by aborting the whole transaction, which would take
              // the document write down with it; asking first turns a retry into a no-op.
              const existing = await requestResult(index.getKey(entry.opId));
              if (existing !== undefined) continue;
              await requestResult(outbox.add(entry));
            }
            const state = transaction.objectStore(SYNC_STATE_STORE);
            for (const entry of stateEntries) await requestResult(state.put(entry));
            // Read back inside the same transaction, exactly as `saveIfRevision` does: the value
            // handed to the caller is the one IndexedDB actually holds, never the object that was
            // passed in, and a `put` that stored something else is caught here rather than on the
            // next load.
            const stored = await requestResult(
              documents.get(ACTIVE_BUDGET_KEY) as IDBRequest<StoredDocument<T> | undefined>,
            );
            if (!stored || stored.revision !== nextRevision) {
              throw databaseError("Транзакция хранилища завершилась ошибкой.");
            }
            result = { status: "saved", value: stored.value, revision: nextRevision };
          }
        }
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The terminal transaction event owns settlement.
        }
        await settled.catch(() => undefined);
        throw error instanceof Error ? error : databaseError("Ошибка локального хранилища.");
      }
      await settled;
      return result;
    }, DATABASE_SYNC_VERSION);
  }

  /** The queue in the order it was written. `limit` caps one batch; 3.2 puts the wire cap at 200. */
  async listOutbox(limit?: number): Promise<readonly OutboxRecord[]> {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw databaseError("Размер выборки очереди должен быть положительным целым.");
    }
    return this.withDatabase(async (database) => {
      // A device that never signed in has no such store, and that is the answer rather than an
      // error: section 9 says the queue is not created, so "what is in the queue" is "nothing".
      if (!IndexedDbBudgetRepository.hasSyncStores(database)) return [];
      const transaction = database.transaction(SYNC_OUTBOX_STORE, "readonly");
      const records = await requestResult(
        transaction.objectStore(SYNC_OUTBOX_STORE).getAll(null, limit) as IDBRequest<OutboxRecord[]>,
      );
      await transactionComplete(transaction);
      return records;
    });
  }

  /**
   * Removes exactly the envelopes the server numbered, and nothing else.
   *
   * 3.3, last paragraph: the record leaves the queue only against a confirmed `seq`. Anything
   * else — a dropped connection, a `409` of any kind, a batch the server never answered — leaves
   * the queue as it was, which is what makes twenty operations survive a network cut without a
   * duplicate and without a loss.
   */
  async confirmOutbox(opIds: readonly string[]): Promise<number> {
    if (opIds.length === 0) return 0;
    return this.withDatabase(async (database) => {
      if (!IndexedDbBudgetRepository.hasSyncStores(database)) return 0;
      const transaction = database.transaction(SYNC_OUTBOX_STORE, "readwrite");
      const store = transaction.objectStore(SYNC_OUTBOX_STORE);
      const index = store.index(OUTBOX_OP_ID_INDEX);
      let removed = 0;
      for (const opId of opIds) {
        const key = await requestResult(index.getKey(opId));
        if (key === undefined) continue;
        await requestResult(store.delete(key));
        removed += 1;
      }
      await transactionComplete(transaction);
      return removed;
    });
  }

  /** How many envelopes are still waiting for a `seq`. */
  async countOutbox(): Promise<number> {
    return this.withDatabase(async (database) => {
      if (!IndexedDbBudgetRepository.hasSyncStores(database)) return 0;
      const transaction = database.transaction(SYNC_OUTBOX_STORE, "readonly");
      const total = await requestResult(transaction.objectStore(SYNC_OUTBOX_STORE).count());
      await transactionComplete(transaction);
      return total;
    });
  }

  async readSyncState<V = unknown>(key: string): Promise<V | undefined> {
    return this.withDatabase(async (database) => {
      if (!IndexedDbBudgetRepository.hasSyncStores(database)) return undefined;
      const transaction = database.transaction(SYNC_STATE_STORE, "readonly");
      const record = await requestResult(
        transaction.objectStore(SYNC_STATE_STORE).get(key) as IDBRequest<SyncStateEntry | undefined>,
      );
      await transactionComplete(transaction);
      return record?.value as V | undefined;
    });
  }

  /** Bookkeeping that is not tied to a document write: the cursor after a pull, the alarm state. */
  async writeSyncState(entries: readonly SyncStateEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const cloned = entries.map((entry) => ({ key: entry.key, value: cloneForStorage(entry.value) }));
    await this.withDatabase(async (database) => {
      const transaction = database.transaction(SYNC_STATE_STORE, "readwrite");
      const store = transaction.objectStore(SYNC_STATE_STORE);
      for (const entry of cloned) await requestResult(store.put(entry));
      await transactionComplete(transaction);
    }, DATABASE_SYNC_VERSION);
  }

  /**
   * How many sync records exist at all.
   *
   * Written for the property section 9 states and phase S4 has to prove rather than assert: with
   * no account, the queue is not created and no cursor exists. Both numbers are zero for the
   * whole life of a local-only installation, and a test can say so.
   */
  async syncRecordCount(): Promise<SyncRecordCounts> {
    return this.withDatabase(async (database) => {
      if (!IndexedDbBudgetRepository.hasSyncStores(database)) return { outbox: 0, state: 0 };
      const transaction = database.transaction([SYNC_OUTBOX_STORE, SYNC_STATE_STORE], "readonly");
      const outbox = await requestResult(transaction.objectStore(SYNC_OUTBOX_STORE).count());
      const state = await requestResult(transaction.objectStore(SYNC_STATE_STORE).count());
      await transactionComplete(transaction);
      return { outbox, state };
    });
  }

  /** Leaving a family (6.6): the sync records go, the budget stays and the app is local again. */
  async clearSyncData(): Promise<void> {
    await this.withDatabase(async (database) => {
      if (!IndexedDbBudgetRepository.hasSyncStores(database)) return;
      const transaction = database.transaction(
        [SYNC_OUTBOX_STORE, SYNC_STATE_STORE],
        "readwrite",
      );
      transaction.objectStore(SYNC_OUTBOX_STORE).clear();
      transaction.objectStore(SYNC_STATE_STORE).clear();
      await transactionComplete(transaction);
    });
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
    await this.withDatabase(
      (database) =>
        new Promise<void>((resolve, reject) => {
          let transaction: IDBTransaction;
          try {
            transaction = database.transaction(STORE_NAME, "readwrite");
          } catch {
            reject(databaseError("Не удалось начать транзакцию локального хранилища."));
            return;
          }

          let recorded = false;
          let activeBudgetMissing = false;
          let transactionFailed = false;
          let settled = false;

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
              // The terminal transaction event owns settlement.
            }
          };

          transaction.oncomplete = () => {
            if (transactionFailed) {
              rejectOnce(databaseError("Транзакция хранилища завершилась ошибкой."));
              return;
            }
            if (activeBudgetMissing) {
              rejectOnce(databaseError("Активный бюджет уже удалён. Дата резервной копии не сохранена."));
              return;
            }
            if (!recorded) {
              rejectOnce(databaseError("Транзакция хранилища завершилась без результата."));
              return;
            }
            if (settled) return;
            settled = true;
            resolve();
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

          let activeBudgetRequest: IDBRequest<StoredDocument<T> | undefined>;
          try {
            activeBudgetRequest = store.get(ACTIVE_BUDGET_KEY) as IDBRequest<StoredDocument<T> | undefined>;
          } catch {
            abort();
            return;
          }
          activeBudgetRequest.onerror = abort;
          activeBudgetRequest.onsuccess = () => {
            try {
              if (!activeBudgetRequest.result) {
                activeBudgetMissing = true;
                return;
              }
              const writeRequest = store.put(makeDocument(LAST_BACKUP_KEY, createdAt, date));
              writeRequest.onerror = abort;
              writeRequest.onsuccess = () => {
                recorded = true;
              };
            } catch {
              abort();
            }
          };
        }),
    );
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

  /**
   * Removes the whole repository, including metadata and every sync record, in one transaction.
   *
   * The sync stores belong in the same sweep: "удалить все данные" that left a queue of sealed
   * envelopes and a folded journal behind would have deleted the budget from the screen and kept
   * it in the database, and the next pull would have rebuilt it from a cursor the user believed
   * was gone.
   */
  async clear(): Promise<void> {
    await this.withDatabase(async (database) => {
      const stores = IndexedDbBudgetRepository.hasSyncStores(database)
        ? [STORE_NAME, SYNC_OUTBOX_STORE, SYNC_STATE_STORE]
        : [STORE_NAME];
      const transaction = database.transaction(stores, "readwrite");
      for (const store of stores) transaction.objectStore(store).clear();
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
