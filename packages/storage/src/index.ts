const DATABASE_NAME = "family-budget";
const DATABASE_VERSION = 1;
const STORE_NAME = "documents";
const ACTIVE_BUDGET_KEY = "active-budget";

interface StoredDocument<T> {
  key: string;
  schemaVersion: number;
  updatedAt: string;
  value: T;
}

export interface FamilyBudgetBackup<T> {
  backupVersion: 1;
  createdAt: string;
  app: "family-budget";
  payload: T;
}

export interface StorageHealth {
  persisted: boolean;
  usage: number | null;
  quota: number | null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Не удалось открыть локальное хранилище."));
    request.onblocked = () => reject(new Error("Обновление локального хранилища заблокировано другой вкладкой."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Ошибка локального хранилища."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Транзакция хранилища завершилась ошибкой."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Транзакция хранилища отменена."));
  });
}

export class IndexedDbBudgetRepository<T> {
  async load(): Promise<T | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const result = await requestResult(
        transaction.objectStore(STORE_NAME).get(ACTIVE_BUDGET_KEY) as IDBRequest<StoredDocument<T> | undefined>,
      );
      return result?.value ?? null;
    } finally {
      database.close();
    }
  }

  async save(value: T): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const document: StoredDocument<T> = {
        key: ACTIVE_BUDGET_KEY,
        schemaVersion: DATABASE_VERSION,
        updatedAt: new Date().toISOString(),
        value,
      };
      transaction.objectStore(STORE_NAME).put(document);
      await transactionComplete(transaction);
    } finally {
      database.close();
    }
  }

  async clear(): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(ACTIVE_BUDGET_KEY);
      await transactionComplete(transaction);
    } finally {
      database.close();
    }
  }
}

export function serializeBackup<T>(payload: T): string {
  const backup: FamilyBudgetBackup<T> = {
    backupVersion: 1,
    createdAt: new Date().toISOString(),
    app: "family-budget",
    payload,
  };
  return JSON.stringify(backup, null, 2);
}

export function parseBackup<T>(text: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Файл резервной копии не является корректным JSON.");
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("backupVersion" in value) ||
    value.backupVersion !== 1 ||
    !("app" in value) ||
    value.app !== "family-budget" ||
    !("payload" in value)
  ) {
    throw new Error("Это не поддерживаемая резервная копия семейного бюджета.");
  }

  return value.payload as T;
}

export async function requestStorageHealth(): Promise<StorageHealth> {
  const storage = navigator.storage;
  if (!storage) {
    return { persisted: false, usage: null, quota: null };
  }

  let persisted = false;
  if (storage.persisted) {
    persisted = await storage.persisted();
  }
  if (!persisted && storage.persist) {
    persisted = await storage.persist();
  }

  const estimate = storage.estimate ? await storage.estimate() : {};
  return {
    persisted,
    usage: estimate.usage ?? null,
    quota: estimate.quota ?? null,
  };
}
