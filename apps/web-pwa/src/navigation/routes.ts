import { isUuid } from "@family-budget/domain";

/**
 * Маршруты приложения и их адреса (план волны 2, §2.1).
 *
 * Адрес — решётка (`#/operations`): статический хостинг, Capacitor и сервис-воркер отдают одну и ту
 * же страницу, и переписывать пути не нужно никому. Адрес видят история браузера, снимки экрана и
 * системный переключатель приложений, поэтому в него попадает только то, что разрешает грамматика
 * ниже (`QUERY_GRAMMAR`): у каждого маршрута — свой закрытый список ключей, у каждого ключа —
 * значение закрытого типа (UUID, значение из перечня, дата, месяц, небольшое число). Свободного
 * текста — сумм, заметок, имён, строки поиска — в адресе нет и не может быть: `formatRoute`
 * бросает на всём, что вне грамматики, а `parseRoute` читает по той же грамматике
 * (docs/SECURITY.md, «Адрес приложения»).
 *
 * У каждого маршрута есть родитель — туда ведут «назад» и всякий мусор в адресе.
 */

/** Лист поверх маршрута. Черновик листа в адрес не попадает никогда, и при перезагрузке лист закрыт. */
export const SHEET_NAMES = ["entry"] as const;
export type SheetName = (typeof SHEET_NAMES)[number];

export type Route =
  | { readonly name: "overview"; readonly sheet?: SheetName }
  | { readonly name: "operations"; readonly sheet?: SheetName }
  | { readonly name: "reports"; readonly sheet?: SheetName }
  | { readonly name: "more"; readonly sheet?: SheetName }
  /** «+»: запись операции; `edit` — операция, открытая из «Операций». */
  | { readonly name: "entry"; readonly edit?: string; readonly sheet?: SheetName }
  | { readonly name: "plan-month"; readonly sheet?: SheetName }
  | { readonly name: "plan-year"; readonly sheet?: SheetName }
  | { readonly name: "family"; readonly sheet?: SheetName }
  | { readonly name: "import"; readonly sheet?: SheetName };

export type RouteName = Route["name"];

/** Пять мест нижней навигации; «+» — не вкладка, а запись поверх той, на которой стоишь. */
export const TAB_NAMES = ["overview", "operations", "reports", "more"] as const satisfies readonly RouteName[];
export type TabName = (typeof TAB_NAMES)[number];

export const ROOT_ROUTE: Route = { name: "overview" };

/** Подэкраны «Ещё»: путь `#/more/<name>`. */
const MORE_CHILDREN = ["plan-month", "plan-year", "family", "import"] as const satisfies readonly RouteName[];
type MoreChild = (typeof MORE_CHILDREN)[number];

/** Адрес длиннее этого — не наш: настоящие адреса приложения короче сотни знаков. */
const MAX_HASH_LENGTH = 512;

export function isTab(route: Route): boolean {
  return (TAB_NAMES as readonly string[]).includes(route.name) && route.sheet === undefined;
}

export function isRoot(route: Route): boolean {
  return route.name === "overview" && route.sheet === undefined;
}

/**
 * Родитель маршрута: «назад» внутри приложения и место, куда ведёт мусор в адресе. У «Обзора»
 * родителя нет — это корень. Лист закрывается на экран под ним.
 */
export function parentRoute(route: Route): Route | null {
  if (route.sheet !== undefined) return withoutSheet(route);
  switch (route.name) {
    case "overview":
      return null;
    case "operations":
    case "reports":
    case "more":
      return ROOT_ROUTE;
    case "entry":
      return route.edit === undefined ? ROOT_ROUTE : { name: "operations" };
    case "plan-month":
    case "plan-year":
    case "family":
    case "import":
      return { name: "more" };
  }
}

export function withoutSheet(route: Route): Route {
  if (route.sheet === undefined) return route;
  const { sheet: _sheet, ...rest } = route;
  return rest;
}

/** То, что видно после перезагрузки: лист закрыт, черновика в адресе нет и не было. */
export function forReload(route: Route): Route {
  return withoutSheet(route);
}

function pathOf(route: Route): string {
  switch (route.name) {
    case "overview":
      return "#/";
    case "operations":
      return "#/operations";
    case "reports":
      return "#/reports";
    case "more":
      return "#/more";
    case "entry":
      return "#/new";
    case "plan-month":
    case "plan-year":
    case "family":
    case "import":
      return `#/more/${route.name}`;
    default:
      // A route object built around the type system (a cast, a stale build) has no address.
      throw new Error("Unknown route.");
  }
}

/**
 * The closed types a query value may have. There is deliberately no free-text kind: a value either
 * names something opaque (a UUID), picks from a fixed list, or is a date, a month or a small count.
 */
export type QueryValue =
  | { readonly kind: "uuid" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "day" }
  | { readonly kind: "month" }
  | { readonly kind: "count"; readonly max: number };

export type QuerySpec = QueryValue & {
  /**
   * Where an invalid value leads. Without it the key is dropped and the route stays; with it —
   * an identifier naming a record that cannot exist — the route goes to the record's list.
   */
  readonly invalid?: Route;
};

type QueryKeysOf<N extends RouteName> = Exclude<keyof Extract<Route, { readonly name: N }>, "name">;

/** Every optional field of every route has exactly one spec: a new field without one does not compile. */
type QueryGrammar = { readonly [N in RouteName]: { readonly [K in QueryKeysOf<N>]-?: QuerySpec } };

const SHEET_SPEC: QuerySpec = { kind: "enum", values: SHEET_NAMES };

/**
 * The address grammar: per route, the query keys it may carry, in their canonical order. Adding a
 * key is adding a line here — and in the fragment pattern of `address-privacy.test.ts`, on purpose.
 */
export const QUERY_GRAMMAR = {
  overview: { sheet: SHEET_SPEC },
  operations: { sheet: SHEET_SPEC },
  reports: { sheet: SHEET_SPEC },
  more: { sheet: SHEET_SPEC },
  entry: { edit: { kind: "uuid", invalid: { name: "operations" } }, sheet: SHEET_SPEC },
  "plan-month": { sheet: SHEET_SPEC },
  "plan-year": { sheet: SHEET_SPEC },
  family: { sheet: SHEET_SPEC },
  import: { sheet: SHEET_SPEC },
} as const satisfies QueryGrammar;

const DAY_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const COUNT_PATTERN = /^(?:0|[1-9]\d{0,5})$/u;

function isCalendarDay(text: string): boolean {
  const match = DAY_PATTERN.exec(text);
  if (match === null) return false;
  const [, year, month, day] = match.map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The canonical text of a valid value, or `null`. One check for writing and for reading. */
export function canonicalValue(spec: QueryValue, value: unknown): string | null {
  switch (spec.kind) {
    case "uuid":
      return isUuid(value) ? value.toLowerCase() : null;
    case "enum":
      return typeof value === "string" && spec.values.includes(value) ? value : null;
    case "day":
      return typeof value === "string" && isCalendarDay(value) ? value : null;
    case "month":
      return typeof value === "string" && MONTH_PATTERN.test(value) ? value : null;
    case "count": {
      const text = typeof value === "number" ? String(value) : value;
      return typeof text === "string" && COUNT_PATTERN.test(text) && Number(text) <= spec.max ? text : null;
    }
  }
}

/** The value a route field holds for a canonical text (a count is a number, the rest are text). */
function fieldValue(spec: QueryValue, text: string): string | number {
  return spec.kind === "count" ? Number(text) : text;
}

function grammarOf(name: unknown): Readonly<Record<string, QuerySpec>> | null {
  if (typeof name !== "string" || !Object.hasOwn(QUERY_GRAMMAR, name)) return null;
  return QUERY_GRAMMAR[name as RouteName];
}

/**
 * Адрес маршрута — единственное место, где он строится. Ключ вне грамматики маршрута, значение
 * не своего типа, неизвестный маршрут — ошибка программы, а не данных: в адрес такое не попадёт ни
 * при каких условиях. Порядок ключей и вид значений канонические: UUID пишется строчными.
 */
export function formatRoute(route: Route): string {
  const grammar = grammarOf(route.name);
  if (grammar === null) throw new Error("Unknown route.");
  const fields = route as unknown as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(fields)) {
    if (key !== "name" && !Object.hasOwn(grammar, key)) throw new Error("A route field is outside the address grammar.");
  }
  const pairs: string[] = [];
  for (const [key, spec] of Object.entries(grammar)) {
    const value = fields[key];
    if (value === undefined) continue;
    const text = canonicalValue(spec, value);
    if (text === null) throw new Error("A route value is outside the address grammar.");
    pairs.push(`${key}=${text}`);
  }
  const path = pathOf(route);
  return pairs.length === 0 ? path : `${path}?${pairs.join("&")}`;
}

/** Ключ маршрута — его адрес: по нему помнится прокрутка и сравниваются записи истории. */
export function routeKey(route: Route): string {
  return formatRoute(route);
}

/**
 * Is `key` exactly what `formatRoute` writes for some route? Keys the router reads back from a
 * history entry pass this before it writes them into the address again.
 */
export function isRouteKey(key: string): boolean {
  const parsed = parseRoute(key);
  return !parsed.notFound && formatRoute(parsed.route) === key;
}

export function sameRoute(left: Route, right: Route): boolean {
  return routeKey(left) === routeKey(right);
}

export interface ParsedRoute {
  readonly route: Route;
  /**
   * В адресе было то, чего в приложении нет: неизвестный путь, значение не своего типа, повтор
   * ключа. Маршрут тогда — ближайший родитель (или экран без этого ключа), а человеку говорят
   * «Запись не найдена». Ключ, которого в грамматике маршрута нет, сюда не относится: он просто
   * отбрасывается и в адрес больше не вернётся.
   */
  readonly notFound: boolean;
}

const notFound = (route: Route): ParsedRoute => ({ route, notFound: true });
const found = (route: Route): ParsedRoute => ({ route, notFound: false });

/** Маршрут по пути без запроса; неизвестный хвост — к ближайшему известному предку. */
function routeOfPath(segments: readonly string[]): ParsedRoute {
  const [first, second, ...rest] = segments;
  if (first === undefined) return found(ROOT_ROUTE);
  const tail = second !== undefined;
  switch (first) {
    case "operations":
      return tail ? notFound({ name: "operations" }) : found({ name: "operations" });
    case "reports":
      return tail ? notFound({ name: "reports" }) : found({ name: "reports" });
    case "new":
      return tail ? notFound(ROOT_ROUTE) : found({ name: "entry" });
    case "more": {
      if (!tail) return found({ name: "more" });
      const child = (MORE_CHILDREN as readonly string[]).includes(second) ? second as MoreChild : null;
      if (child === null) return notFound({ name: "more" });
      return rest.length > 0 ? notFound({ name: child }) : found({ name: child });
    }
    default:
      return notFound(ROOT_ROUTE);
  }
}

/**
 * Маршрут по решётке адреса — по той же грамматике, что пишет `formatRoute`. Пустая решётка и
 * `#/` — «Обзор». Значения читаются как есть, без раскодирования: каноническое значение в
 * кодировании не нуждается, поэтому `%…` и `+` — не наше. Всё, что не разобралось, ведёт к
 * родителю с `notFound`; ничто из адреса не попадает в маршрут без проверки, и всякий
 * прочитанный маршрут снова пишется `formatRoute` без ошибки.
 */
export function parseRoute(hash: string): ParsedRoute {
  if (hash === "" || hash === "#" || hash === "#/") return found(ROOT_ROUTE);
  if (hash.length > MAX_HASH_LENGTH || !hash.startsWith("#/")) return notFound(ROOT_ROUTE);
  const body = hash.slice(2);
  const queryAt = body.indexOf("?");
  const path = queryAt === -1 ? body : body.slice(0, queryAt);
  const search = queryAt === -1 ? "" : body.slice(queryAt + 1);
  const segments = path.split("/").filter((segment, index, all) => segment !== "" || index < all.length - 1);
  if (segments.some((segment) => segment === "")) return notFound(ROOT_ROUTE);
  const base = routeOfPath(segments);
  if (base.notFound) return base;

  const grammar = grammarOf(base.route.name) ?? {};
  const fields: Record<string, unknown> = { ...base.route };
  const seen = new Set<string>();
  let rejected = false;
  let fallback: Route | null = null;
  for (const part of search === "" ? [] : search.split("&")) {
    const at = part.indexOf("=");
    const key = at === -1 ? part : part.slice(0, at);
    const spec = Object.hasOwn(grammar, key) ? grammar[key] : undefined;
    // Ключа нет в грамматике маршрута — отбросить молча (`utm`, `edit` у «Операций»).
    if (spec === undefined) continue;
    const text = at === -1 || seen.has(key) ? null : canonicalValue(spec, part.slice(at + 1));
    seen.add(key);
    if (text === null) {
      // Повтор ключа или значение не своего типа: такой записи нет.
      rejected = true;
      fallback ??= spec.invalid ?? null;
      delete fields[key];
      continue;
    }
    fields[key] = fieldValue(spec, text);
  }
  if (fallback !== null) return notFound(fallback);
  const route = fields as unknown as Route;
  try {
    formatRoute(route);
  } catch {
    return notFound(base.route);
  }
  return rejected ? notFound(route) : found(route);
}

/**
 * Проверка идентификаторов маршрута по бюджету: операция, которой нет (удалена здесь или на другом
 * устройстве), — тоже «Запись не найдена», и маршрут уходит к родителю.
 */
export function resolveRoute(route: Route, exists: { readonly transaction: (id: string) => boolean }): ParsedRoute {
  if (route.name === "entry" && route.edit !== undefined && !exists.transaction(route.edit)) {
    return notFound(parentRoute(route) ?? ROOT_ROUTE);
  }
  return found(route);
}

/**
 * Цепочка от корня до маршрута по родителям: так выглядит история, когда маршрут открыт по
 * ссылке или перезагрузкой, — «назад» ведёт к родителю, а не прочь из приложения.
 */
export function routeChain(route: Route): readonly Route[] {
  const chain: Route[] = [route];
  for (let parent = parentRoute(route); parent !== null; parent = parentRoute(parent)) chain.unshift(parent);
  return chain;
}

/** Текст тоста, когда адрес ведёт к тому, чего нет. */
export const ROUTE_NOT_FOUND_MESSAGE = "Запись не найдена";
