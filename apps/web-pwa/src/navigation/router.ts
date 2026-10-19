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
 * - подэкран и запись («+», лист) кладут запись поверх;
 * - кнопка «назад» внутри экрана ведёт к родителю маршрута, а не слепым `history.back()`: если
 *   родитель — запись под текущей, приложение возвращается на неё (дубля в истории не остаётся);
 *   если нет (адрес открыт ссылкой), текущая запись заменяется родителем;
 * - маршрут, открытый ссылкой или перезагрузкой, получает в истории цепочку родителей, и «Назад»
 *   ведёт по ней, а не прочь из приложения; лист при перезагрузке закрыт.
 *
 * Каждая запись истории несёт в `state` ключи своей цепочки от корня — так роутер знает, что под
 * ней, не заглядывая в чужие записи. Несохранённый черновик спрашивается синхронно в момент
 * нажатия (`NavigationGuard`); системное «Назад» с черновиком возвращает адрес на место и задаёт
 * тот же вопрос.
 */

const STATE_MARK = "nash-budget/route";

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
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
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
   * родителю, и спрашивать человеку там нечего.
   */
  redirect(route: Route): void;
  /** Читает адрес, достраивает историю и слушает `popstate`. Возвращает отписку. */
  start(): () => void;
}

const ROOT_KEY = routeKey(ROOT_ROUTE);

function commonPrefix(left: readonly string[], right: readonly string[]): number {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return length;
}

/** Маршрут, который кладётся поверх того, на котором стоишь: запись «+» и всякий лист. */
function stacksOnTop(route: Route): boolean {
  return route.sheet !== undefined || (route.name === "entry" && route.edit === undefined);
}

export function createRouter(options: RouterOptions): Router {
  const { window: frame } = options;
  const listeners = new Set<() => void>();
  let route: Route = ROOT_ROUTE;
  let stack: readonly string[] = [ROOT_KEY];
  /** Переход по истории, начатый самим роутером: его `popstate` вопроса о черновике не задаёт. */
  let pending: { readonly arrive: () => void } | null = null;
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
  const replaceAt = (chain: readonly string[], index: number) => {
    frame.history.replaceState(stateOf(chain.slice(0, index + 1)), "", chain[index] ?? ROOT_KEY);
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
    if (stacksOnTop(target)) return [...stack, key];
    const parent = parentRoute(target);
    const parentAt = parent === null ? -1 : stack.lastIndexOf(routeKey(parent));
    if (parentAt !== -1) return [...stack.slice(0, parentAt + 1), key];
    return routeChain(target).map(routeKey);
  };

  /** Привести историю к цепочке: положить, заменить или вернуться по истории — что короче. */
  const apply = (chain: readonly string[]) => {
    const shared = commonPrefix(stack, chain);
    if (shared === stack.length) {
      pushFrom(chain, shared);
      commit(chain);
      return;
    }
    if (shared === stack.length - 1 && chain.length > shared) {
      replaceAt(chain, shared);
      pushFrom(chain, shared + 1);
      commit(chain);
      return;
    }
    // Нужная запись лежит ниже: вернуться к ней по истории (асинхронно) и достроить остальное.
    const landing = chain.length > shared ? shared : shared - 1;
    pending = {
      arrive: () => {
        if (chain.length > shared) {
          replaceAt(chain, shared);
          pushFrom(chain, shared + 1);
        }
        commit(chain);
      },
    };
    frame.history.go(landing - (stack.length - 1));
  };

  const perform = (target: Route, replace: boolean) => {
    if (pending !== null) {
      queued = () => perform(target, replace);
      return;
    }
    if (sameRoute(target, route) && !replace) return;
    apply(chainFor(target, replace));
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
      stack = state?.stack ?? stack;
      arrival.arrive();
      const next = queued;
      queued = null;
      next?.();
      return;
    }
    const parsed = parseRoute(frame.location.hash);
    const landed = state?.stack ?? null;
    if (options.guard?.blocks()) {
      // Системное «Назад» с несохранённым черновиком: адрес возвращается в историю, и человек
      // отвечает на тот же вопрос, что и при нажатии на вкладку.
      const leaving = routeKey(route);
      const below = landed ?? stack;
      frame.history.pushState(stateOf([...below, leaving]), "", leaving);
      stack = [...below, leaving];
      options.guard.confirm(() => {
        pending = { arrive: () => commit(landed ?? below) };
        frame.history.go(-1);
      });
      return;
    }
    if (landed !== null && !parsed.notFound) {
      commit(landed);
      return;
    }
    // Запись не приложения: адрес набран руками или пришёл по старой ссылке. Она встаёт поверх
    // той, на которой стояли, — уже под правильным адресом.
    const target = forReload(parsed.route);
    const chain = isRoot(target) ? [ROOT_KEY] : [...stack, routeKey(target)];
    frame.history.replaceState(stateOf(chain), "", chain[chain.length - 1] ?? ROOT_KEY);
    commit(chain);
    if (parsed.notFound) options.onNotFound?.();
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
      replaceAt(stack, stack.length - 1);
    } else {
      // Первое открытие, ссылка или мусор в адресе: история получает цепочку родителей.
      const chain = routeChain(target).map(routeKey);
      frame.history.replaceState(stateOf(chain.slice(0, 1)), "", chain[0] ?? ROOT_KEY);
      pushFrom(chain, 1);
      stack = chain;
    }
    route = target;
    frame.addEventListener("popstate", onPopState);
    if (parsed.notFound) options.onNotFound?.();
    return () => frame.removeEventListener("popstate", onPopState);
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
    redirect: (target) => perform(target, false),
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
