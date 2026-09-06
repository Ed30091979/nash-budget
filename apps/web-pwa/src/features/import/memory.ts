import type { MerchantMemoryEntry } from "./classify";

/**
 * Память назначений: «этого продавца семья положила в эту категорию».
 *
 * Локальная запись, и только она. Новой операции журнала под неё нет и не будет — это была бы
 * смена протокола ради удобства; второе устройство спросит про незнакомого продавца само, один
 * раз. Хранится в IndexedDB, а не в `localStorage`: политика безопасности запрещает
 * `localStorage` для данных приложения, и скан релиза это проверяет. Ключ продавца — это
 * название магазина из выписки, то есть след покупок семьи, поэтому память стирается вместе с
 * остальными данными устройства.
 *
 * Хранятся названия категорий, а не идентификаторы: память переживает восстановление из копии и
 * смену бюджета, а «Продукты» — те же «Продукты» в любом из них.
 */
export interface ImportMemory {
  load(): Promise<readonly MerchantMemoryEntry[]>;
  remember(entries: readonly MerchantMemoryEntry[]): Promise<void>;
  clear(): Promise<void>;
}

export interface ImportMemoryOptions {
  readonly databaseName?: string;
  /** Сколько продавцов помнить; сверх того забываются самые давние. */
  readonly capacity?: number;
}

export const IMPORT_MEMORY_DATABASE = "family-budget-import-memory";
export const IMPORT_MEMORY_CAPACITY = 2000;
const STORE = "merchants";
const VERSION = 1;

function request<T>(target: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    target.onsuccess = () => resolve(target.result);
    target.onerror = () => reject(target.error ?? new Error("IndexedDB request failed."));
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

function isEntry(value: unknown): value is MerchantMemoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.key === "string"
    && entry.key.length > 0
    && (entry.categoryName === null || typeof entry.categoryName === "string")
    && (entry.type === "expense" || entry.type === "income")
    && typeof entry.updatedAt === "string";
}

function openDatabase(name: string): Promise<IDBDatabase> {
  const opening = indexedDB.open(name, VERSION);
  opening.onupgradeneeded = () => {
    const database = opening.result;
    if (!database.objectStoreNames.contains(STORE)) {
      database.createObjectStore(STORE, { keyPath: "key" });
    }
  };
  return request(opening);
}

/** Без IndexedDB память пуста и ничего не помнит: импорт работает, только спрашивает каждый раз. */
const SILENT_MEMORY: ImportMemory = {
  async load() { return []; },
  async remember() { return undefined; },
  async clear() { return undefined; },
};

export function createImportMemory(options: ImportMemoryOptions = {}): ImportMemory {
  if (typeof indexedDB === "undefined") return SILENT_MEMORY;
  const name = options.databaseName ?? IMPORT_MEMORY_DATABASE;
  const capacity = options.capacity ?? IMPORT_MEMORY_CAPACITY;

  const withStore = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T> => {
    const database = await openDatabase(name);
    try {
      const transaction = database.transaction(STORE, mode);
      const done = complete(transaction);
      const result = await work(transaction.objectStore(STORE));
      await done;
      return result;
    } finally {
      database.close();
    }
  };

  return {
    async load() {
      const records = await withStore("readonly", (store) => request(store.getAll()));
      return (records as unknown[]).filter(isEntry);
    },
    async remember(entries) {
      if (entries.length === 0) return;
      await withStore("readwrite", async (store) => {
        for (const entry of entries) {
          if (!isEntry(entry)) continue;
          await request(store.put(entry));
        }
        const all = ((await request(store.getAll())) as unknown[]).filter(isEntry);
        if (all.length > capacity) {
          const stale = [...all].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).slice(0, all.length - capacity);
          for (const entry of stale) await request(store.delete(entry.key));
        }
      });
    },
    async clear() {
      await withStore("readwrite", (store) => request(store.clear()));
    },
  };
}
