import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

/**
 * Реестр несохранённых черновиков (план волны 2, §2.4).
 *
 * Прежде экран сообщал о черновике пассивным эффектом (`onDirtyChange`), и флаг приложения
 * отставал от экрана на отрисовку: касание вкладки сразу после «Записать» спрашивало про
 * черновик, который уже уходил в запись (третье ревью, e2e b1). Теперь экран не сообщает, а
 * отвечает: регистрирует `isDirty`, и навигация читает её синхронно в момент нажатия — того же
 * касания, того же кадра. Тот же реестр читают `beforeunload` и плашка обновления.
 *
 * Черновик, отправленный в запись, перестаёт быть грязным до первого `await`
 * (`createDraftSaving`): запись доводит координатор, итог — квитанция или ошибка, и при ошибке
 * черновик снова грязный, с тем же содержимым; при удаче — чистый, как только сброшенная форма
 * нарисована.
 */
export interface DraftEntry {
  /** Есть ли несохранённое, что уход с экрана потеряет. Вызывается синхронно, без эффектов. */
  readonly isDirty: () => boolean;
  /** Забыть черновик: человек выбрал «Не сохранять». */
  readonly discard?: () => void;
  /** Что именно потеряется — словами, для вопроса: «сумма и категория операции». */
  readonly label: string;
  /**
   * `false` — черновик переживает переход внутри приложения (он живёт не в экране), но не
   * перезагрузку: такой держит только `beforeunload` и обновление версии. Так устроен начатый вход
   * в «Семью»: код запрошен, и форма кода вернётся, а перезагрузка её потеряет.
   */
  readonly guardsNavigation?: boolean;
  /**
   * Где черновик живёт: на экране (по умолчанию) или в листе поверх экрана. Лист, открытый или
   * закрытый над экраном, экран не покидает: о черновике экрана тогда не спрашивают и его не
   * забывают (ревью 2b, MEDIUM-4).
   */
  readonly layer?: DraftLayer;
}

export type DraftScope = "navigation" | "unload";

/** Что переход оставляет позади: экран вместе с листом над ним — или только лист (`leftBehind`). */
export type DraftLayer = "screen" | "sheet";

export interface DraftRegistry {
  register(entry: { readonly current: DraftEntry }): () => void;
  /**
   * Синхронно: есть ли грязный черновик для перехода (`navigation`) или для ухода со страницы.
   * `leaving` — что переход оставляет: экран (всё) или только лист над ним.
   */
  hasUnsavedDrafts(scope?: DraftScope, leaving?: DraftLayer): boolean;
  /** Подписи грязных черновиков — для текста вопроса. */
  dirtyLabels(scope?: DraftScope, leaving?: DraftLayer): string[];
  discardAll(scope?: DraftScope, leaving?: DraftLayer): void;
  /** Пересчитать после отрисовки зарегистрированного экрана и сообщить подписчикам, если ответ изменился. */
  refresh(): void;
  subscribe(listener: () => void): () => void;
  /** Последний сообщённый ответ для ухода со страницы — снимок для `useSyncExternalStore`. */
  snapshot(): boolean;
}

export function createDraftRegistry(): DraftRegistry {
  const entries = new Set<{ readonly current: DraftEntry }>();
  const listeners = new Set<() => void>();
  let last = false;

  const inScope = (entry: DraftEntry, scope: DraftScope, leaving: DraftLayer) =>
    scope === "unload" || (entry.guardsNavigation !== false && (leaving === "screen" || entry.layer === "sheet"));
  const dirty = (scope: DraftScope, leaving: DraftLayer = "screen") =>
    [...entries].filter((entry) => inScope(entry.current, scope, leaving) && entry.current.isDirty());

  const refresh = () => {
    const now = dirty("unload").length > 0;
    if (now === last) return;
    last = now;
    for (const listener of [...listeners]) listener();
  };

  return {
    register(entry) {
      entries.add(entry);
      refresh();
      return () => {
        entries.delete(entry);
        refresh();
      };
    },
    hasUnsavedDrafts: (scope = "unload", leaving = "screen") => dirty(scope, leaving).length > 0,
    dirtyLabels: (scope = "unload", leaving = "screen") => dirty(scope, leaving).map((entry) => entry.current.label),
    discardAll(scope = "navigation", leaving = "screen") {
      for (const entry of dirty(scope, leaving)) entry.current.discard?.();
    },
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => last,
  };
}

/**
 * Черновик, отправленный в запись: с этого касания он не «несохранённый», а «записывается».
 *
 * Each submit takes a ticket (`begin`, synchronously, before the first `await`), and only the
 * newest ticket moves the latch: a write that fails (`fail`) makes the draft unsaved again — its
 * contents never went anywhere; a write that succeeds (`succeed`) holds the latch until the form
 * it reset is drawn and reads clean (`settle`, after every commit). The latch never waits on
 * anything but the form it was taken for: other drafts on the screen (a limit typed for restoring
 * an archived line) are guarded on their own and cannot keep it shut (review of 2a, finding 2).
 */
export interface DraftSaving {
  readonly saving: boolean;
  begin(): number;
  fail(ticket: number): void;
  succeed(ticket: number): void;
  settle(formDirty: boolean): void;
}

export function createDraftSaving(): DraftSaving {
  let latest = 0;
  let saving = false;
  let succeeded = false;
  return {
    get saving() { return saving; },
    begin() {
      latest += 1;
      saving = true;
      succeeded = false;
      return latest;
    },
    fail(ticket) {
      if (ticket !== latest) return;
      saving = false;
      succeeded = false;
    },
    succeed(ticket) {
      if (ticket === latest && saving) succeeded = true;
    },
    settle(formDirty) {
      if (!saving || !succeeded || formDirty) return;
      saving = false;
      succeeded = false;
    },
  };
}

const DraftRegistryContext = createContext<DraftRegistry | null>(null);

export function DraftRegistryProvider({ registry, children }: { readonly registry: DraftRegistry; readonly children: ReactNode }) {
  return <DraftRegistryContext.Provider value={registry}>{children}</DraftRegistryContext.Provider>;
}

/**
 * Регистрирует черновик экрана. Запись держит последнюю `entry` через ссылку, поэтому `isDirty`
 * видит состояние последней отрисовки, а не первой. Вне провайдера — ничего: экран, нарисованный
 * проверкой без оболочки, черновиков не охраняет.
 */
export function useDraftGuard(entry: DraftEntry): void {
  const registry = useContext(DraftRegistryContext);
  const latest = useRef(entry);
  useLayoutEffect(() => {
    latest.current = entry;
  });
  useEffect(() => registry?.register(latest), [registry]);
  useEffect(() => {
    registry?.refresh();
  });
}

/**
 * Черновик формы целиком: регистрация в реестре и защёлка «записывается» (`createDraftSaving`).
 * `dirty` — отличие от снимка при открытии формы, а не от бюджета, который может прийти с другого
 * устройства посреди набора. Отправленная форма перестаёт быть грязной до первого `await`; неудача
 * возвращает её грязной с тем же содержимым; удача держит защёлку, пока сброшенная или закрытая
 * форма не нарисована. Так устроены формы справочников (подволна 2c).
 */
export function useFormDraft(entry: { readonly label: string; readonly dirty: boolean; readonly discard: () => void; readonly layer?: DraftLayer }): DraftSaving {
  const [saving] = useState(createDraftSaving);
  useLayoutEffect(() => {
    saving.settle(entry.dirty);
  });
  useDraftGuard({
    label: entry.label,
    isDirty: () => entry.dirty && !saving.saving,
    discard: entry.discard,
    ...(entry.layer === undefined ? {} : { layer: entry.layer }),
  });
  return saving;
}

/** Есть ли несохранённое для ухода со страницы — с перерисовкой, когда ответ меняется. */
export function useUnsavedDrafts(registry: DraftRegistry): boolean {
  return useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot);
}
