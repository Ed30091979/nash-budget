/**
 * Память первого запуска — что из §e уже было на этом устройстве: какие вопросы спрошены, отвечены
 * или отложены, закрыта ли подсказка на первую трату и какие карточки-подсказки закрыты навсегда.
 *
 * Локальная запись, и только она, — так же, как память назначений импорта (`features/import/memory.ts`).
 * В бюджет, копию и журнал семьи она не попадает: это не данные семьи, а то, что этому телефону уже
 * показали. Хранится в IndexedDB под своим именем базы, а не в `localStorage`: политика безопасности
 * запрещает браузерное хранилище ключ-значение для данных приложения, и скан релиза это проверяет.
 * Стирается вместе с остальными данными устройства («Удалить данные»).
 */

/** Вопросы первого запуска — в том порядке, в каком их задают. */
export const QUESTION_IDS = ["categories", "accounts", "payday"] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

/**
 * `pending` — ещё не показан; `asked` — показан, но ни ответа, ни «позже» (лист закрыли
 * перезагрузкой): покажется снова; `answered` — отвечен, больше не спрашивается; `later` —
 * крестик «Спросить позже» (правило повтора — `questions-model.ts`).
 */
export type QuestionStatus = "pending" | "asked" | "answered" | "later";

export interface QuestionRecord {
  readonly status: QuestionStatus;
  /** День последней смены статуса, `ГГГГ-ММ-ДД` по календарю семьи. */
  readonly on: string;
  /** Сколько раз вопрос отложили крестиком. */
  readonly postponed: number;
}

/** Карточки-подсказки в конце «Обзора» (§e, п. 7), в порядке важности. */
export const HINT_IDS = ["opening-balance", "backup", "import", "goal", "family"] as const;
export type HintId = (typeof HINT_IDS)[number];

export interface FirstRunState {
  /** День, когда на этом устройстве создан набор первого запуска; `null` — набора здесь не было. */
  readonly startedOn: string | null;
  readonly questions: Readonly<Partial<Record<QuestionId, QuestionRecord>>>;
  /** Подсказка на первую трату: ждёт, показана и закрыта — или её здесь не было (`null`). */
  readonly coach: "pending" | "done" | null;
  /** Карточки, закрытые крестиком: навсегда, на этом устройстве. */
  readonly closedHints: readonly HintId[];
}

export const EMPTY_FIRST_RUN: FirstRunState = { startedOn: null, questions: {}, coach: null, closedHints: [] };

export interface FirstRunMemory {
  load(): Promise<FirstRunState>;
  save(state: FirstRunState): Promise<void>;
  clear(): Promise<void>;
}

export const FIRST_RUN_DATABASE = "family-budget-first-run";
const STORE = "first-run";
const KEY = "state";
const VERSION = 1;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const STATUSES: readonly QuestionStatus[] = ["pending", "asked", "answered", "later"];

function isDay(value: unknown): value is string {
  return typeof value === "string" && DAY_PATTERN.test(value);
}

function readRecord(value: unknown): QuestionRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!STATUSES.includes(record.status as QuestionStatus) || !isDay(record.on)) return undefined;
  const postponed = typeof record.postponed === "number" && Number.isSafeInteger(record.postponed) && record.postponed >= 0 ? record.postponed : 0;
  return { status: record.status as QuestionStatus, on: record.on, postponed };
}

/**
 * Запись, прочитанная с диска, — только то, что эта сборка понимает. Чужое или испорченное
 * забывается, а не роняет «Обзор»: в худшем случае подсказка покажется ещё раз.
 */
export function readFirstRunState(value: unknown): FirstRunState {
  if (typeof value !== "object" || value === null) return EMPTY_FIRST_RUN;
  const raw = value as Record<string, unknown>;
  const questions: Partial<Record<QuestionId, QuestionRecord>> = {};
  const rawQuestions = typeof raw.questions === "object" && raw.questions !== null ? raw.questions as Record<string, unknown> : {};
  for (const id of QUESTION_IDS) {
    const record = Object.hasOwn(rawQuestions, id) ? readRecord(rawQuestions[id]) : undefined;
    if (record !== undefined) questions[id] = record;
  }
  const closedHints = Array.isArray(raw.closedHints)
    ? HINT_IDS.filter((id) => (raw.closedHints as unknown[]).includes(id))
    : [];
  return {
    startedOn: isDay(raw.startedOn) ? raw.startedOn : null,
    questions,
    coach: raw.coach === "pending" || raw.coach === "done" ? raw.coach : null,
    closedHints,
  };
}

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

function openDatabase(name: string): Promise<IDBDatabase> {
  const opening = indexedDB.open(name, VERSION);
  opening.onupgradeneeded = () => {
    const database = opening.result;
    if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
  };
  return request(opening);
}

/** Без IndexedDB память пуста: вопросы и подсказки просто не показываются — набор работает и так. */
const SILENT_MEMORY: FirstRunMemory = {
  async load() { return EMPTY_FIRST_RUN; },
  async save() { return undefined; },
  async clear() { return undefined; },
};

export function createFirstRunMemory(options: { readonly databaseName?: string } = {}): FirstRunMemory {
  if (typeof indexedDB === "undefined") return SILENT_MEMORY;
  const name = options.databaseName ?? FIRST_RUN_DATABASE;
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
      return readFirstRunState(await withStore("readonly", (store) => request(store.get(KEY))));
    },
    async save(state) {
      // Пишется ровно то, что прочитает `readFirstRunState`: копия без лишних ключей и ссылок.
      const value = readFirstRunState(JSON.parse(JSON.stringify(state)));
      await withStore("readwrite", (store) => request(store.put(value, KEY)).then(() => undefined));
    },
    async clear() {
      await withStore("readwrite", (store) => request(store.clear()).then(() => undefined));
    },
  };
}

/**
 * Состояние первого запуска на время сессии: одно на приложение — набор создаёт его на слайдах, а
 * «Обзор» читает в ту же секунду, не дожидаясь диска. Запись на диск — по очереди, в фоне.
 */
export interface FirstRunStore {
  subscribe(listener: () => void): () => void;
  /** `null` — ещё не прочитано с диска: ничего не показываем, чтобы не мигать. */
  snapshot(): FirstRunState | null;
  /** Прочитать с диска один раз; повторный вызов ничего не делает. */
  load(): void;
  /** Правка сразу видна всем и уходит на диск следом. */
  update(change: (state: FirstRunState) => FirstRunState): Promise<void>;
  /** Заменить целиком (начало набора, демо, «Удалить данные») и дождаться диска. */
  replace(next: FirstRunState): Promise<void>;
  /** Стереть с диска и из памяти — вместе с данными устройства. */
  clear(): Promise<void>;
}

export function createFirstRunStore(memory: FirstRunMemory): FirstRunStore {
  let state: FirstRunState | null = null;
  let loading: Promise<void> | null = null;
  let queue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (next: FirstRunState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const persist = (next: FirstRunState): Promise<void> => {
    queue = queue.then(() => memory.save(next)).catch(() => undefined);
    return queue;
  };
  const store: FirstRunStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => state,
    load() {
      if (loading !== null || state !== null) return;
      loading = memory.load().then(
        (loaded) => { if (state === null) publish(loaded); },
        () => { if (state === null) publish(EMPTY_FIRST_RUN); },
      );
    },
    async update(change) {
      const base = state ?? EMPTY_FIRST_RUN;
      const next = change(base);
      if (next === base) return;
      publish(next);
      await persist(next);
    },
    async replace(next) {
      publish(next);
      await persist(next);
    },
    async clear() {
      publish(EMPTY_FIRST_RUN);
      queue = queue.then(() => memory.clear()).catch(() => undefined);
      await queue;
    },
  };
  return store;
}

let defaultStore: FirstRunStore | null = null;

/** Хранилище первого запуска приложения — одно на вкладку. */
export function firstRunStore(): FirstRunStore {
  defaultStore ??= createFirstRunStore(createFirstRunMemory());
  return defaultStore;
}
