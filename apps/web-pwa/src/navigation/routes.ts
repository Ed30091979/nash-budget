import { isUuid, isWithinDateWindow, MAX_LOCAL_DATE, MIN_LOCAL_DATE } from "@family-budget/domain";

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

/** Что лист ввода открыт записать — с плиток «Обзора»; «+» открывает его без вида. */
export const ENTRY_SHEET_OPS = ["expense", "income", "transfer"] as const;
export type EntrySheetOp = (typeof ENTRY_SHEET_OPS)[number];

/**
 * Лист поверх экрана и то, с чем его открыли, — только закрытые типы: вид из перечня и непрозрачные
 * идентификаторы плиток. Сумма, дата, комментарий и метки — черновик (`app/entry-draft-store.ts`),
 * и в адрес он не попадает. Ключи названы не `from`/`to`/`kind`: у «Операций» эти имена займут
 * фильтры подволны 2d — даты и вид операции, другие типы под теми же именами.
 */
export interface SheetFields {
  readonly sheet?: SheetName;
  /** Вид записи: расход, доход, перевод. */
  readonly op?: EntrySheetOp;
  /** «Откуда»: счёт расхода и перевода, источник дохода. */
  readonly src?: string;
  /** «Куда»: категория расхода, счёт дохода и перевода. */
  readonly dst?: string;
  /** Операция, открытая в листе для правки. */
  readonly edit?: string;
}

/** Ключи, которые бывают только у открытого листа. */
const SHEET_ONLY_KEYS = ["op", "src", "dst", "edit"] as const satisfies readonly (keyof SheetFields)[];

export type Route =
  /** «Обзор»; `month` — месяц плиток, `ГГГГ-ММ`, без него — текущий. */
  | ({ readonly name: "overview"; readonly month?: string } & SheetFields)
  | ({ readonly name: "operations" } & SheetFields)
  | ({ readonly name: "reports" } & SheetFields)
  | ({ readonly name: "more" } & SheetFields)
  | ({ readonly name: "plan-month" } & SheetFields)
  | ({ readonly name: "plan-year" } & SheetFields)
  | ({ readonly name: "family" } & SheetFields)
  | ({ readonly name: "import" } & SheetFields);

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
  return route.name === "overview" && route.sheet === undefined && route.month === undefined;
}

/**
 * Родитель маршрута: «назад» внутри приложения и место, куда ведёт мусор в адресе. У «Обзора»
 * родителя нет — это корень. Лист закрывается на экран под ним.
 */
export function parentRoute(route: Route): Route | null {
  if (route.sheet !== undefined) return withoutSheet(route);
  switch (route.name) {
    case "overview":
      // Другой месяц «Обзора» — шаг от текущего: «Назад» возвращает к сегодняшнему месяцу.
      return route.month === undefined ? null : ROOT_ROUTE;
    case "operations":
    case "reports":
    case "more":
      return ROOT_ROUTE;
    case "plan-month":
    case "plan-year":
    case "family":
    case "import":
      return { name: "more" };
  }
}

/** Экран под листом: без листа и без того, с чем лист открыли. */
export function withoutSheet(route: Route): Route {
  if (route.sheet === undefined && !SHEET_ONLY_KEYS.some((key) => key in route)) return route;
  const { sheet: _sheet, op: _op, src: _src, dst: _dst, edit: _edit, ...rest } = route;
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
   * Where an invalid value leads. Without it the key is dropped and the route stays; with
   * `"close-sheet"` — an identifier naming a record that cannot exist — the sheet does not open and
   * the route stays on the screen under it.
   */
  readonly invalid?: "close-sheet";
};

type QueryKeysOf<N extends RouteName> = Exclude<keyof Extract<Route, { readonly name: N }>, "name">;

/** Every optional field of every route has exactly one spec: a new field without one does not compile. */
type QueryGrammar = { readonly [N in RouteName]: { readonly [K in QueryKeysOf<N>]-?: QuerySpec } };

/**
 * The sheet's keys, the same on every screen, in their canonical order. `edit` names an operation:
 * one that cannot exist means there is no sheet to open, so the sheet closes — see `parseRoute`.
 */
const SHEET_GRAMMAR = {
  sheet: { kind: "enum", values: SHEET_NAMES },
  op: { kind: "enum", values: ENTRY_SHEET_OPS },
  src: { kind: "uuid" },
  dst: { kind: "uuid" },
  edit: { kind: "uuid", invalid: "close-sheet" },
} as const satisfies { readonly [K in keyof SheetFields]-?: QuerySpec };

/**
 * The address grammar: per route, the query keys it may carry, in their canonical order. Adding a
 * key is adding a line here — and in the fragment pattern of `address-privacy.test.ts`, on purpose.
 */
export const QUERY_GRAMMAR = {
  overview: { month: { kind: "month" }, ...SHEET_GRAMMAR },
  operations: SHEET_GRAMMAR,
  reports: SHEET_GRAMMAR,
  more: SHEET_GRAMMAR,
  "plan-month": SHEET_GRAMMAR,
  "plan-year": SHEET_GRAMMAR,
  family: SHEET_GRAMMAR,
  import: SHEET_GRAMMAR,
} as const satisfies QueryGrammar;

/**
 * The rules between keys, which a per-key grammar cannot say: the sheet's keys exist only with an
 * open sheet, tiles only with the kind they were tapped for, and a sheet edits an operation or
 * writes a new one between two tiles — never both.
 */
function sheetFieldsCoherent(fields: Readonly<Record<string, unknown>>): boolean {
  const open = fields.sheet !== undefined;
  if (!open && SHEET_ONLY_KEYS.some((key) => fields[key] !== undefined)) return false;
  if (fields.op === undefined && (fields.src !== undefined || fields.dst !== undefined)) return false;
  return !(fields.edit !== undefined && fields.op !== undefined);
}

const DAY_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const COUNT_PATTERN = /^(?:0|[1-9]\d{0,5})$/u;

/**
 * The months the domain's calendar knows, 1900-01 … 2199-12. A month outside it passed the pattern
 * and took the app down: the month arrows step from it with `shiftMonth`, which throws past the
 * window, and a reload kept the address (review of 2b, MEDIUM-7). Outside is «Запись не найдена».
 */
export const FIRST_ROUTE_MONTH = MIN_LOCAL_DATE.slice(0, 7);
export const LAST_ROUTE_MONTH = MAX_LOCAL_DATE.slice(0, 7);

function isCalendarDay(text: string): boolean {
  const match = DAY_PATTERN.exec(text);
  if (match === null) return false;
  const [, year, month, day] = match.map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && isWithinDateWindow(text);
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
      return typeof value === "string" && MONTH_PATTERN.test(value) && value >= FIRST_ROUTE_MONTH && value <= LAST_ROUTE_MONTH ? value : null;
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
  if (!sheetFieldsCoherent(fields)) throw new Error("A sheet key is outside an open sheet, or an edit names tiles too.");
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
    // Адрес «+» подволны 2a: записи теперь — лист поверх экрана, и по ссылке он не открывается.
    case "new":
      return tail ? notFound(ROOT_ROUTE) : found(ROOT_ROUTE);
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
  let closeSheet = false;
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
      if (spec.invalid === "close-sheet") closeSheet = true;
      delete fields[key];
      continue;
    }
    fields[key] = fieldValue(spec, text);
  }
  if (closeSheet) return notFound(withoutSheet(fields as unknown as Route));
  // Ключи листа без листа — отбросить молча, как чужие; плитки без вида и плитки рядом с правкой —
  // тоже лишние: такой лист не открывают, и в адрес они больше не вернутся.
  if (fields.sheet === undefined) for (const key of SHEET_ONLY_KEYS) delete fields[key];
  if (fields.edit !== undefined) delete fields.op;
  if (fields.op === undefined) for (const key of ["src", "dst"] as const) delete fields[key];
  const route = fields as unknown as Route;
  try {
    formatRoute(route);
  } catch {
    return notFound(base.route);
  }
  return rejected ? notFound(route) : found(route);
}

/**
 * Тот ли это идентификатор. Адрес пишет UUID строчными, а бюджет хранит его так, как он пришёл
 * (копия и журнал принимают любой регистр), поэтому сравнение — без учёта регистра, а хранимое
 * не переписывается (ревью 2a, п. 4).
 */
export function sameRecordId(stored: string, routed: string): boolean {
  return stored.toLowerCase() === routed.toLowerCase();
}

/**
 * Проверка идентификаторов маршрута по бюджету: операция, которой нет (удалена здесь или на другом
 * устройстве), — тоже «Запись не найдена», и маршрут уходит к родителю.
 */
export function resolveRoute(route: Route, exists: { readonly transaction: (id: string) => boolean }): ParsedRoute {
  if (route.sheet !== undefined && route.edit !== undefined && !exists.transaction(route.edit)) {
    return notFound(withoutSheet(route));
  }
  return found(route);
}

/**
 * Экран маршрута: без листа и без месяца «Обзора». По нему помнится прокрутка и ставится фокус на
 * заголовок: открытый лист и смена месяца — тот же экран, и фокус там ведут лист и стрелки.
 */
export function screenKey(route: Route): string {
  const screen = withoutSheet(route);
  if (screen.name === "overview" && screen.month !== undefined) return routeKey(ROOT_ROUTE);
  return routeKey(screen);
}

/**
 * Что переход с `from` на `to` оставляет позади (ревью 2b, MEDIUM-4): другой экран — `"screen"`
 * (и лист над ним); лист, закрытый на свой экран или сменённый другим листом над ним, —
 * `"sheet"`; лист, открытый поверх экрана, и другой месяц «Обзора» — ничего: экран на месте, его
 * черновик не спрашивается и не забывается.
 */
export function leftBehind(from: Route, to: Route): "screen" | "sheet" | null {
  if (screenKey(from) !== screenKey(to)) return "screen";
  if (from.sheet !== undefined && routeKey(from) !== routeKey(to)) return "sheet";
  return null;
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
