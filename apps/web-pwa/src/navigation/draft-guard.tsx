import { createContext, useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

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
 * черновик снова грязный, с тем же содержимым.
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
}

export type DraftScope = "navigation" | "unload";

export interface DraftRegistry {
  register(entry: { readonly current: DraftEntry }): () => void;
  /** Синхронно: есть ли грязный черновик для перехода (`navigation`) или для ухода со страницы. */
  hasUnsavedDrafts(scope?: DraftScope): boolean;
  /** Подписи грязных черновиков — для текста вопроса. */
  dirtyLabels(scope?: DraftScope): string[];
  discardAll(scope?: DraftScope): void;
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

  const inScope = (entry: DraftEntry, scope: DraftScope) => scope === "unload" || entry.guardsNavigation !== false;
  const dirty = (scope: DraftScope) => [...entries].filter((entry) => inScope(entry.current, scope) && entry.current.isDirty());

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
    hasUnsavedDrafts: (scope = "unload") => dirty(scope).length > 0,
    dirtyLabels: (scope = "unload") => dirty(scope).map((entry) => entry.current.label),
    discardAll(scope = "navigation") {
      for (const entry of dirty(scope)) entry.current.discard?.();
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
 * `begin` — синхронно, до первого `await`; `end(failed)` — когда запись кончилась; при неудаче
 * черновик снова грязный, потому что его содержимое никуда не делось.
 */
export interface DraftSaving {
  readonly saving: boolean;
  begin(): void;
  end(): void;
}

export function createDraftSaving(): DraftSaving {
  let saving = false;
  return {
    get saving() { return saving; },
    begin() { saving = true; },
    end() { saving = false; },
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

/** Есть ли несохранённое для ухода со страницы — с перерисовкой, когда ответ меняется. */
export function useUnsavedDrafts(registry: DraftRegistry): boolean {
  return useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot);
}
