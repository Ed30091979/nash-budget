import { createContext, useContext, useSyncExternalStore } from "react";
import {
  forReload,
  isRoot,
  isTab,
  parentRoute,
  parseRoute,
  ROOT_ROUTE,
  routeChain,
  routeKey,
  sameRoute,
  type Route,
} from "./routes";

/**
 * Свой роутер на решётке адреса (план волны 2, §2.1), без зависимостей.
 *
 * История браузера ведётся по правилам приложения, а не по нажатиям:
 *
 * - «Обзор» — корень; с «Обзора» «Назад» выводит из приложения;
 * - «Обзор» → вкладка кладёт запись, вкладка → вкладка её заменяет, поэтому «Назад» с любой
 *   вкладки ведёт на «Обзор»;
 * - подэкран и запись («+», лист) кладут запись поверх; маршрут, который уже лежит ниже в истории,
 *   не кладётся второй раз — приложение возвращается к нему;
 * - кнопка «назад» внутри экрана ведёт к родителю маршрута, а не слепым `history.back()`:
 *   приложение возвращается по истории к записи родителя, и дубля в истории не остаётся;
 * - маршрут, открытый ссылкой или перезагрузкой, получает в истории цепочку родителей, и «Назад»
 *   ведёт по ней, а не прочь из приложения; лист при перезагрузке закрыт.
 *
 * Каждая запись истории несёт в `state` ключи своей цепочки от корня — так роутер знает, что под
 * ней, не заглядывая в чужие записи. Цепочки обязаны оставаться правдой и для записей «вперёд»,
 * поэтому история меняется только наращиванием: вернуться по истории к последней общей записи и
 * положить остальное (`pushState` отрезает всё, что было впереди). Запись на месте не заменяется
 * никогда, кроме той, что только что появилась (адрес, набранный руками), и первой при запуске:
 * замена оставила бы впереди записи, чьи цепочки описывают уже не то, что под ними (ревью 2a, п. 5).
 * Несохранённый черновик спрашивается синхронно в момент нажатия (`NavigationGuard`); системное
 * «Назад» с черновиком возвращает адрес на место и задаёт тот же вопрос.
 */

const STATE_MARK = "nash-budget/route";
const ROOT_KEY = routeKey(ROOT_ROUTE);
/** Сколько раз подряд роутер вернётся по истории, пока цепочка не сойдётся. Больше — не ходить вслепую. */
const MAX_TRAVERSALS = 8;

interface EntryState {
  readonly mark: typeof STATE_MARK;
  /** Ключи записей приложения от корня до этой; последний — её собственный. */
  readonly stack: readonly string[];
}

function entryState(value: unknown): EntryState | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly mark?: unknown; readonly stack?: unknown };
  if (candidate.mark !== STATE_MARK || !Array.isArray(candidate.stack) || candidate.stack.length === 0) return null;
  if (!candidate.stack.every((key): key is string => typeof key === "string")) return null;
  // Цепочка начинается с корня — иначе это не наша запись, а подделка под неё.
  if (candidate.stack[0] !== ROOT_KEY) return null;
  return { mark: STATE_MARK, stack: candidate.stack };
}

function stateOf(stack: readonly string[]): EntryState {
  return { mark: STATE_MARK, stack: [...stack] };
}

/** То, что роутеру нужно от `window.history`; в проверках — поддельная история. */
export interface HistoryLike {
  readonly state: unknown;
  scrollRestoration?: ScrollRestoration;
  pushState(data: unknown, unused: string, url?: string | null): void;
  replaceState(data: unknown, unused: string, url?: string | null): void;
  go(delta: number): void;
}

export interface RouterWindow {
  readonly location: { readonly hash: string };
  readonly history: HistoryLike;
  addEventListener(type: "popstate" | "hashchange", listener: () => void): void;
  removeEventListener(type: "popstate" | "hashchange", listener: () => void): void;
}

/** Защита черновика: спрашивается в момент нажатия и в момент системного «Назад». */
export interface NavigationGuard {
  /** Есть ли несохранённое, что переход потеряет. Синхронно — без эффектов и ожиданий. */
  blocks(): boolean;
  /** Спросить человека; `proceed` вызывается, только если он решил уйти. */
  confirm(proceed: () => void): void;
}

export interface RouterOptions {
  readonly window: RouterWindow;
  readonly guard?: NavigationGuard;
  /** Перед сменой маршрута — с ключом того, с которого уходят: оболочка запоминает прокрутку. */
  readonly onLeave?: (key: string) => void;
  /** Адрес назвал то, чего нет: маршрут уже ушёл к родителю, человеку надо сказать «Запись не найдена». */
  readonly onNotFound?: () => void;
}

export interface NavigateOptions {
  /** Заменить текущую запись истории, а не положить новую. */
  readonly replace?: boolean;
}

export interface Router {
  current(): Route;
  subscribe(listener: () => void): () => void;
  navigate(route: Route, options?: NavigateOptions): void;
  /** Кнопка «назад» внутри экрана: к родителю маршрута. */
  back(): void;
  /**
   * Переход без вопроса о черновике: маршрут, которого больше нет (операция удалена), уходит к
   * родителю, а адрес правки, которая кончилась, сменяется адресом записи, — спрашивать там нечего.
   */
  redirect(route: Route, options?: NavigateOptions): void;
  /** Читает адрес, достраивает историю и слушает `popstate`. Возвращает отписку. */
  start(): () => void;
}

function commonPrefix(left: readonly string[], right: readonly string[]): number {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return length;
}

/** Маршрут, который кладётся поверх того, на котором стоишь: запись «+» и всякий лист. */
function stacksOnTop(route: Route): boolean {
  return route.sheet !== undefined || (route.name === "entry" && route.edit === undefined);
}

/**
 * История в памяти — для отрисовки без браузера (статическая разметка, проверки): записи, позиция
 * и `popstate`, который приходит сразу, а не следующей задачей.
 */
export function memoryRouterWindow(hash = ""): RouterWindow {
  const entries: { state: unknown; hash: string }[] = [{ state: null, hash }];
  const listeners = new Set<() => void>();
  let index = 0;
  return {
    location: { get hash() { return entries[index]?.hash ?? ""; } },
    history: {
      get state() { return entries[index]?.state ?? null; },
      pushState(state, _unused, url) {
        entries.splice(index + 1, entries.length, { state, hash: url ?? entries[index]?.hash ?? "" });
        index += 1;
      },
      replaceState(state, _unused, url) {
        entries[index] = { state, hash: url ?? entries[index]?.hash ?? "" };
      },
      go(delta) {
        const target = index + delta;
        if (target < 0 || target >= entries.length || target === index) return;
        index = target;
        for (const listener of [...listeners]) listener();
      },
    },
    addEventListener(type, listener) { if (type === "popstate") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "popstate") listeners.delete(listener); },
  };
}

export function createRouter(options: RouterOptions): Router {
  const { window: frame } = options;
  const listeners = new Set<() => void>();
  // Маршрут известен с первой отрисовки: адрес читается без побочных действий, историю достраивает `start`.
  let route: Route = forReload(parseRoute(frame.location.hash).route);
  let stack: readonly string[] = [ROOT_KEY];
  /** Переход по истории, начатый самим роутером: его `popstate` вопроса о черновике не задаёт. */
  let pending: { readonly expected: readonly string[]; readonly arrive: () => void } | null = null;
  let queued: (() => void) | null = null;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  /** Показать запись `chain`: сменить маршрут и сообщить подписчикам. */
  const commit = (chain: readonly string[]) => {
    const key = chain[chain.length - 1] ?? ROOT_KEY;
    const next = parseRoute(key).route;
    stack = chain;
    if (sameRoute(next, route)) return;
    options.onLeave?.(routeKey(route));
    route = next;
    notify();
  };

  const pushFrom = (chain: readonly string[], from: number) => {
    for (let index = from; index < chain.length; index += 1) {
      frame.history.pushState(stateOf(chain.slice(0, index + 1)), "", chain[index] ?? ROOT_KEY);
    }
  };
  /** Заменить текущую запись — только ту, над которой ничего нет: новую или первую при запуске. */
  const replaceCurrent = (chain: readonly string[]) => {
    frame.history.replaceState(stateOf(chain), "", chain[chain.length - 1] ?? ROOT_KEY);
  };

  /** Цепочка записей, которой история должна стать, чтобы показать `target`. */
  const chainFor = (target: Route, replace: boolean): readonly string[] => {
    const key = routeKey(target);
    if (replace) {
      const replaced = [...stack.slice(0, -1), key];
      return replaced[0] === ROOT_KEY ? replaced : routeChain(target).map(routeKey);
    }
    if (isRoot(target)) return [ROOT_KEY];
    if (isTab(target)) return [ROOT_KEY, key];
    // Маршрут уже лежит ниже — вернуться к нему, а не класть второй раз.
    const already = stack.indexOf(key);
    if (already !== -1) return stack.slice(0, already + 1);
    const parent = parentRoute(target);
    if (stacksOnTop(target) || (parent !== null && stack.includes(routeKey(parent)))) return [...stack, key];
    return routeChain(target).map(routeKey);
  };

  /**
   * Привести историю к цепочке. Если текущая цепочка — её начало, недостающее кладётся сверху.
   * Иначе — возврат по истории к последней общей записи (асинхронно), и по приходу то же самое
   * считается заново от цепочки, которую несёт запись, куда пришли, а не от ожидаемой: так
   * расхождение, если оно есть, не накапливается.
   */
  const apply = (chain: readonly string[], traversals = 0) => {
    const shared = commonPrefix(stack, chain);
    if (shared === stack.length) {
      pushFrom(chain, shared);
      commit(chain);
      return;
    }
    if (shared === 0 || traversals >= MAX_TRAVERSALS) {
      // История не сходится с цепочкой: вслепую по ней не ходить — нужный маршрут встаёт сверху.
      const onTop = [...stack, chain[chain.length - 1] ?? ROOT_KEY];
      pushFrom(onTop, stack.length);
      commit(onTop);
      return;
    }
    const landing = shared - 1;
    const expected = stack.slice(0, landing + 1);
    pending = {
      expected,
      arrive: () => apply(chain, traversals + 1),
    };
    frame.history.go(landing - (stack.length - 1));
  };

  /** Выполнить сейчас или, если история ещё едет, — сразу после неё. */
  const whenSettled = (action: () => void) => {
    if (pending !== null) {
      queued = action;
      return;
    }
    action();
  };

  const perform = (target: Route, replace: boolean) => {
    whenSettled(() => {
      if (sameRoute(target, route) && !replace) return;
      apply(chainFor(target, replace));
    });
  };

  const navigate = (target: Route, navigateOptions: NavigateOptions = {}) => {
    if (sameRoute(target, route) && navigateOptions.replace !== true) return;
    const replace = navigateOptions.replace === true;
    if (options.guard?.blocks()) {
      options.guard.confirm(() => perform(target, replace));
      return;
    }
    perform(target, replace);
  };

  const onPopState = () => {
    const state = entryState(frame.history.state);
    if (pending !== null) {
      const arrival = pending;
      pending = null;
      // Цепочка — та, что несёт запись, куда пришли; без неё — та, что ожидалась.
      stack = state?.stack ?? arrival.expected;
      arrival.arrive();
      const next = queued;
      queued = null;
      next?.();
      return;
    }
    const parsed = parseRoute(frame.location.hash);
    const landed = state?.stack ?? null;
    const leaving = routeKey(route);
    if (landed === null) {
      // Запись не приложения: адрес набран руками или пришёл по старой ссылке. Она только что
      // появилась над той, на которой стояли, — её заменить можно, и адрес набран как переход.
      const typed = forReload(parsed.route);
      const above = [...stack, options.guard?.blocks() ? leaving : routeKey(typed)];
      replaceCurrent(above);
      stack = above;
      if (options.guard?.blocks()) {
        // С черновиком набранный адрес — та же просьба уйти: адрес возвращается, вопрос задаётся.
        options.guard.confirm(() => {
          perform(typed, false);
          if (parsed.notFound) options.onNotFound?.();
        });
        return;
      }
      if (parsed.notFound) options.onNotFound?.();
      apply(chainFor(typed, false));
      return;
    }
    if (options.guard?.blocks()) {
      // Системное «Назад» или «Вперёд» с несохранённым черновиком: адрес возвращается в историю
      // поверх записи, куда пришли, и человек отвечает на тот же вопрос, что и при нажатии на вкладку.
      const restored = [...landed, leaving];
      frame.history.pushState(stateOf(restored), "", leaving);
      stack = restored;
      options.guard.confirm(() => whenSettled(() => apply(landed)));
      return;
    }
    commit(landed);
  };

  // Переход по якорю (`#…` набран руками, старая ссылка) браузер объявляет `popstate`, а затем
  // `hashchange`. Если `popstate` уже разобрал адрес, решётка совпадает с маршрутом, и здесь
  // делать нечего; если браузер его не прислал — адрес разбирается здесь, тем же путём.
  const onHashChange = () => {
    if (pending !== null || frame.location.hash === routeKey(route)) return;
    onPopState();
  };

  const start = () => {
    if (frame.history.scrollRestoration !== undefined) frame.history.scrollRestoration = "manual";
    const parsed = parseRoute(frame.location.hash);
    const target = forReload(parsed.route);
    const key = routeKey(target);
    const state = entryState(frame.history.state);
    if (state !== null && !parsed.notFound && state.stack[state.stack.length - 1] === key) {
      // Перезагрузка: запись своя, и всё под ней — тоже.
      stack = state.stack;
    } else if (state !== null && !parsed.notFound && state.stack[state.stack.length - 1] === routeKey(parsed.route)) {
      // Перезагрузка с открытым листом: лист закрыт, запись остаётся на месте под адресом экрана.
      stack = [...state.stack.slice(0, -1), key];
      replaceCurrent(stack);
    } else {
      // Первое открытие, ссылка или мусор в адресе: история получает цепочку родителей.
      const chain = routeChain(target).map(routeKey);
      replaceCurrent(chain.slice(0, 1));
      pushFrom(chain, 1);
      stack = chain;
    }
    route = target;
    frame.addEventListener("popstate", onPopState);
    frame.addEventListener("hashchange", onHashChange);
    if (parsed.notFound) options.onNotFound?.();
    return () => {
      frame.removeEventListener("popstate", onPopState);
      frame.removeEventListener("hashchange", onHashChange);
    };
  };

  return {
    current: () => route,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    navigate,
    back: () => {
      const parent = parentRoute(route);
      if (parent !== null) navigate(parent);
    },
    redirect: (target, redirectOptions = {}) => perform(target, redirectOptions.replace === true),
    start,
  };
}

export const RouterContext = createContext<Router | null>(null);

export function useRouter(): Router {
  const router = useContext(RouterContext);
  if (router === null) throw new Error("useRouter needs a RouterContext provider.");
  return router;
}

/** Текущий маршрут; перерисовка — на каждом его изменении, и только на нём. */
export function useRoute(): Route {
  const router = useRouter();
  return useSyncExternalStore(router.subscribe, router.current, router.current);
}
