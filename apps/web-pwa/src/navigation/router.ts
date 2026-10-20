import { createContext, useContext, useSyncExternalStore } from "react";
import {
  forReload,
  isRoot,
  isRouteKey,
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
 * никогда, кроме той, что только что появилась (адрес, набранный руками), той, что чужой код
 * поставил на место нашей, и первой при запуске: замена оставила бы впереди записи, чьи цепочки
 * описывают уже не то, что под ними (ревью 2a, п. 5). Каждый переход по истории, начатый роутером,
 * ждёт свой `popstate` не дольше `TRAVERSAL_TIMEOUT_MS`.
 * Несохранённый черновик спрашивается синхронно в момент нажатия (`NavigationGuard`); системное
 * «Назад» с черновиком возвращает адрес на место и задаёт тот же вопрос.
 */

const STATE_MARK = "nash-budget/route";
const ROOT_KEY = routeKey(ROOT_ROUTE);
/** Сколько раз подряд роутер вернётся по истории, пока цепочка не сойдётся. Больше — не ходить вслепую. */
const MAX_TRAVERSALS = 8;
/**
 * How long a traversal the router started may go without its `popstate`. None comes when the
 * entry is not there — no entries below in a standalone window or the Android WebView, a count
 * thrown off by an entry someone replaced — and the router must not wait for it forever with every
 * later tap queued behind it (review of 2a, round 2, LOW 3).
 */
const TRAVERSAL_TIMEOUT_MS = 500;

interface EntryState {
  readonly mark: typeof STATE_MARK;
  /** Ключи записей приложения от корня до этой; последний — её собственный. */
  readonly stack: readonly string[];
}

function entryState(value: unknown): EntryState | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly mark?: unknown; readonly stack?: unknown };
  // Ровно два поля: запись, где есть что-то ещё, писал не роутер, и её не продолжают.
  if (Object.keys(candidate).length !== 2) return null;
  if (candidate.mark !== STATE_MARK || !Array.isArray(candidate.stack) || candidate.stack.length === 0) return null;
  // Каждый ключ — канонический адрес маршрута: ключи цепочки снова уходят в адрес, и то, что
  // записала другая сборка или чужой код, туда не попадёт.
  if (!candidate.stack.every((key): key is string => typeof key === "string" && isRouteKey(key))) return null;
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
  /** Entries in this tab's history: tells a typed address that pushed an entry from one that replaced it. */
  readonly length: number;
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

/**
 * Защита черновика: спрашивается в момент нажатия и в момент системного «Назад» — с тем, откуда
 * и куда переход: лист поверх экрана экран не покидает (ревью 2b, MEDIUM-4).
 */
export interface NavigationGuard {
  /** Есть ли несохранённое, что переход с `from` на `to` потеряет. Синхронно — без эффектов и ожиданий. */
  blocks(from: Route, to: Route): boolean;
  /** Спросить человека; `proceed` вызывается, только если он решил уйти. */
  confirm(proceed: () => void, from: Route, to: Route): void;
}

export interface RouterOptions {
  readonly window: RouterWindow;
  readonly guard?: NavigationGuard;
  /**
   * Перед сменой маршрута — с ключом того, с которого уходят, и того, куда приходят: оболочка
   * запоминает прокрутку и отличает уход с экрана от листа, открытого поверх него.
   */
  readonly onLeave?: (key: string, next: string) => void;
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
   * Маршрут записи истории под текущей, если она наша: «‹ Отчёты» у ленты, открытой строкой легенды,
   * ведёт к ней, а не к родителю (ревью 2d, LOW-6). `null` — под текущей ничего нет (корень).
   */
  beneath(): Route | null;
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

/** Маршрут, который кладётся поверх того, на котором стоишь: всякий лист, и лист ввода тоже. */
function stacksOnTop(route: Route): boolean {
  return route.sheet !== undefined;
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
      get length() { return entries.length; },
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
  let pending: {
    readonly delta: number;
    readonly expected: readonly string[];
    readonly arrive: () => void;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let queued: (() => void) | null = null;
  /** `history.length`, каким роутер его оставил, и сколько записей впереди текущей. */
  let knownLength = 0;
  let ahead = 0;
  const observe = () => { knownLength = frame.history.length; };

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  /** Показать запись `chain`: сменить маршрут и сообщить подписчикам. */
  const commit = (chain: readonly string[]) => {
    const key = chain[chain.length - 1] ?? ROOT_KEY;
    const next = parseRoute(key).route;
    stack = chain;
    if (sameRoute(next, route)) return;
    options.onLeave?.(routeKey(route), routeKey(next));
    route = next;
    notify();
  };

  const pushFrom = (chain: readonly string[], from: number) => {
    for (let index = from; index < chain.length; index += 1) {
      frame.history.pushState(stateOf(chain.slice(0, index + 1)), "", chain[index] ?? ROOT_KEY);
      ahead = 0;
    }
    observe();
  };
  /**
   * Заменить текущую запись — только ту, чья цепочка от этого не станет неправдой для записей
   * впереди: новую, первую при запуске, или ту, что кто-то заменил чужой.
   */
  const replaceCurrent = (chain: readonly string[]) => {
    frame.history.replaceState(stateOf(chain), "", chain[chain.length - 1] ?? ROOT_KEY);
    observe();
  };

  const runQueued = () => {
    const next = queued;
    queued = null;
    next?.();
  };

  /**
   * Пройти по истории на `delta` и по приходу выполнить `arrive`. Если `popstate` так и не пришёл —
   * записи там нет, — `stalled`: роутер перестаёт ждать, и очередь переходов не застревает.
   */
  const traverse = (delta: number, expected: readonly string[], arrive: () => void, stalled: () => void) => {
    const timer = setTimeout(() => {
      if (pending === null || pending.timer !== timer) return;
      pending = null;
      stalled();
      runQueued();
    }, TRAVERSAL_TIMEOUT_MS);
    pending = { delta, expected, arrive, timer };
    frame.history.go(delta);
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
    // История не сходится с цепочкой: вслепую по ней не ходить — нужный маршрут встаёт сверху.
    const onTop = () => {
      const top = [...stack, chain[chain.length - 1] ?? ROOT_KEY];
      pushFrom(top, stack.length);
      commit(top);
    };
    if (shared === 0 || traversals >= MAX_TRAVERSALS) {
      onTop();
      return;
    }
    const landing = shared - 1;
    traverse(landing - (stack.length - 1), stack.slice(0, landing + 1), () => apply(chain, traversals + 1), onTop);
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
    const from = route;
    if (options.guard?.blocks(from, target)) {
      options.guard.confirm(() => perform(target, replace), from, target);
      return;
    }
    perform(target, replace);
  };

  /**
   * Запись без нашего `state` — адрес набран руками, пришёл по старой ссылке или его заменил чужой
   * код. Новая запись над текущей меняет `history.length` (кроме случая, когда она отрезала ровно
   * одну запись впереди — тогда она всё равно скорее новая: так набирают адрес); замена — никогда.
   */
  const typedEntryWasPushed = () => frame.history.length !== knownLength || ahead === 1;

  const onTypedEntry = (parsed: ReturnType<typeof parseRoute>) => {
    const typed = forReload(parsed.route);
    const from = route;
    const leaving = routeKey(route);
    const pushed = typedEntryWasPushed();
    const asked = () => options.guard?.confirm(() => {
      perform(typed, false);
      if (parsed.notFound) options.onNotFound?.();
    }, from, typed);
    if (!pushed) {
      // Чужая запись встала на место нашей: наша возвращается на место, и адрес — та же просьба
      // перейти. Записи впереди и цепочки под ней остаются правдой (ревью 2a, круг 2, LOW 3).
      replaceCurrent(stack);
      if (options.guard?.blocks(from, typed)) {
        asked();
        return;
      }
      if (parsed.notFound) options.onNotFound?.();
      apply(chainFor(typed, false));
      return;
    }
    ahead = 0;
    if (options.guard?.blocks(from, typed)) {
      // С черновиком набранный адрес — та же просьба уйти. Новая запись становится правдивой копией
      // той, с которой уходят, и роутер возвращается на шаг назад, на саму эту запись: копия
      // остаётся впереди, а «Назад» с экрана ведёт к его родителю, а не на копию (ревью 2a, круг 2, LOW 2).
      const below = stack;
      const copy = [...below, leaving];
      replaceCurrent(copy);
      stack = copy;
      traverse(-1, below, () => undefined, () => undefined);
      asked();
      return;
    }
    const above = [...stack, routeKey(typed)];
    replaceCurrent(above);
    stack = above;
    if (parsed.notFound) options.onNotFound?.();
    apply(chainFor(typed, false));
  };

  const onPopState = () => {
    const state = entryState(frame.history.state);
    if (pending !== null) {
      const arrival = pending;
      pending = null;
      clearTimeout(arrival.timer);
      ahead = Math.max(0, ahead - arrival.delta);
      // Цепочка — та, что несёт запись, куда пришли; без неё — та, что ожидалась.
      stack = state?.stack ?? arrival.expected;
      arrival.arrive();
      runQueued();
      return;
    }
    const parsed = parseRoute(frame.location.hash);
    const landed = state?.stack ?? null;
    if (landed === null) {
      onTypedEntry(parsed);
      return;
    }
    ahead = Math.max(0, ahead - (landed.length - stack.length));
    const from = route;
    const to = parseRoute(landed[landed.length - 1] ?? ROOT_KEY).route;
    if (options.guard?.blocks(from, to)) {
      // Системное «Назад» или «Вперёд» с несохранённым черновиком: адрес возвращается в историю
      // поверх записи, куда пришли, и человек отвечает на тот же вопрос, что и при нажатии на вкладку.
      const restored = [...landed, routeKey(route)];
      pushFrom(restored, landed.length);
      stack = restored;
      options.guard.confirm(() => whenSettled(() => apply(landed)), from, to);
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
    // Что впереди после перезагрузки, роутер не знает; длину истории — знает.
    ahead = 0;
    observe();
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
    beneath: () => {
      const key = stack.length < 2 ? undefined : stack[stack.length - 2];
      return key === undefined ? null : parseRoute(key).route;
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
