import { ACCOUNT_TYPES, isUuid, isWithinDateWindow, MAX_LOCAL_DATE, MIN_LOCAL_DATE, type AccountType, type TransactionKind } from "@family-budget/domain";

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

/** Какой список «Категорий и доходов» открыт: расходы или источники дохода. */
export const CATEGORY_LIST_TYPES = ["expense", "income"] as const;
export type CategoryListType = (typeof CATEGORY_LIST_TYPES)[number];

/**
 * Вид нового счёта, с которым открывается форма: вопрос первого запуска «Есть ещё места, где лежат
 * деньги?» открывает её с видом «Накопления». Ключ — из перечня домена, имени счёта в адресе нет.
 */
export const NEW_ACCOUNT_TYPES: readonly AccountType[] = ACCOUNT_TYPES;

/** Вид операции в фильтре «Операций» — значения домена, и только они. */
export const FEED_KINDS = ["income", "expense", "refund", "transfer", "goal_contribution", "debt_out", "debt_in"] as const satisfies readonly TransactionKind[];
export type FeedKind = (typeof FEED_KINDS)[number];
/** Новый вид операции в домене без строки здесь не компилируется: фильтр знает каждый. */
const FEED_KINDS_COMPLETE: Exclude<TransactionKind, FeedKind> extends never ? true : never = true;
void FEED_KINDS_COMPLETE;

/** Период «Операций» словом: `all` — вся история. Без него и без дней — текущий месяц. */
export const FEED_PERIODS = ["all"] as const;
export type FeedPeriod = (typeof FEED_PERIODS)[number];

/**
 * Фильтры «Операций» (подволна 2d, план волны 2, §1.3) — только закрытые типы: период из перечня,
 * дни `ГГГГ-ММ-ДД`, UUID счёта, категории, метки и участника и вид операции из перечня. Строки поиска
 * среди них нет и быть не может: это свободный текст — сумма, заметка, имя, — и он живёт в памяти
 * экрана (`features/feed/FeedScreen.tsx`), а не в адресе и не в состоянии записи истории (SECURITY §7.3).
 *
 * Период: без ключей — текущий месяц (лента по умолчанию — месяц с итогами дней и строкой итогов,
 * ревью 2d, LOW-11), `period=all` — вся история, `from`/`to` — свои дни. Слово и дни вместе не бывают.
 */
export interface OperationsFilterFields {
  /** `all` — вся история; не вместе с днями. */
  readonly period?: FeedPeriod;
  /** Первый день периода, включительно. */
  readonly from?: string;
  /** Последний день периода, включительно; не раньше `from`. */
  readonly to?: string;
  readonly acc?: string;
  readonly cat?: string;
  readonly tag?: string;
  readonly member?: string;
  readonly kind?: FeedKind;
}

/** Ключи фильтров «Операций» в каноническом порядке. */
export const FEED_FILTER_KEYS = ["period", "from", "to", "acc", "cat", "tag", "member", "kind"] as const satisfies readonly (keyof OperationsFilterFields)[];

/** Вкладки «Отчётов»: расходы, доходы, метки. */
export const REPORT_VIEWS = ["expense", "income", "tags"] as const;
export type ReportView = (typeof REPORT_VIEWS)[number];
/** Период «Отчётов»: календарный месяц, квартал, год или свои дни. */
export const REPORT_PERIODS = ["month", "quarter", "year", "custom"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/**
 * Что показывают «Отчёты» (план волны 2, §1.4): вкладка, период и счёт. У месяца, квартала и года
 * `from` — день внутри периода (без него — сегодняшний), у своего периода — его первый день, а `to` —
 * последний. Периоды — календарные: окно плана в отчёт не входит (`packages/domain/src/reports.ts`).
 */
export interface ReportsFields {
  readonly view?: ReportView;
  readonly period?: ReportPeriod;
  readonly from?: string;
  readonly to?: string;
  readonly acc?: string;
}

export type Route =
  /** «Обзор»; `month` — месяц плиток, `ГГГГ-ММ`, без него — текущий. */
  | ({ readonly name: "overview"; readonly month?: string } & SheetFields)
  /** «Операции»; фильтры — в адресе, строка поиска — в памяти экрана. */
  | ({ readonly name: "operations" } & OperationsFilterFields & SheetFields)
  /** «Отчёты»: вкладка, период и счёт. */
  | ({ readonly name: "reports" } & ReportsFields & SheetFields)
  | ({ readonly name: "more" } & SheetFields)
  | ({ readonly name: "plan-month" } & SheetFields)
  | ({ readonly name: "plan-year" } & SheetFields)
  | ({ readonly name: "family" } & SheetFields)
  | ({ readonly name: "import" } & SheetFields)
  /** Справочники «Учёта» (подволна 2c): счета, курсы, категории и доходы, метки. */
  | ({ readonly name: "accounts" } & SheetFields)
  /** Счёт, открытый для правки; `id` — его UUID, в пути: `#/more/accounts/<id>`. */
  | ({ readonly name: "account"; readonly id: string } & SheetFields)
  /** «Новый счёт»; `type` — вид, отмеченный в форме при открытии, без него — «Карта или счёт». */
  | ({ readonly name: "account-new"; readonly type?: AccountType } & SheetFields)
  | ({ readonly name: "rates" } & SheetFields)
  /** Список категорий; `type` — расходы или доходы, без него — расходы. */
  | ({ readonly name: "categories"; readonly type?: CategoryListType } & SheetFields)
  /**
   * Категория или источник дохода, открытые для правки: `#/more/categories/<id>?type=income`. Вид
   * списка — ключ из закрытого набора, как у списка: по нему родитель в истории — свой список, а не
   * всегда расходы (ревью 2c, MEDIUM-1). Без него — расходы.
   */
  | ({ readonly name: "category"; readonly id: string; readonly type?: CategoryListType } & SheetFields)
  | ({ readonly name: "tags" } & SheetFields)
  /** Заглушки до подволны 2e: «Долги», «Цели», «Регулярные» — пустые состояния в «Ещё» → «Учёт». */
  | ({ readonly name: "debts" } & SheetFields)
  | ({ readonly name: "goals" } & SheetFields)
  | ({ readonly name: "recurring" } & SheetFields);

export type RouteName = Route["name"];

/** Пять мест нижней навигации; «+» — не вкладка, а запись поверх той, на которой стоишь. */
export const TAB_NAMES = ["overview", "operations", "reports", "more"] as const satisfies readonly RouteName[];
export type TabName = (typeof TAB_NAMES)[number];

export const ROOT_ROUTE: Route = { name: "overview" };

/** Подэкраны «Ещё»: путь `#/more/<name>`. */
const MORE_CHILDREN = ["plan-month", "plan-year", "family", "import", "accounts", "rates", "categories", "tags", "debts", "goals", "recurring"] as const satisfies readonly RouteName[];
type MoreChild = (typeof MORE_CHILDREN)[number];

/**
 * Маршруты, у которых в пути стоит идентификатор записи: `#/more/accounts/<id>`,
 * `#/more/categories/<id>`. Идентификатор — UUID и ничего больше: имя счёта или категории в адрес
 * не попадает никогда, как и всякий свободный текст (SECURITY §7.3).
 */
const PATH_ID_ROUTES = ["account", "category"] as const satisfies readonly RouteName[];
type PathIdRoute = (typeof PATH_ID_ROUTES)[number];

function hasPathId(name: unknown): name is PathIdRoute {
  return typeof name === "string" && (PATH_ID_ROUTES as readonly string[]).includes(name);
}

/** UUID в пути — по тому же правилу, что и в запросе: в любом регистре на входе, строчными в адресе. */
const PATH_ID: QueryValue = { kind: "uuid" };

/** Адрес длиннее этого — не наш: настоящие адреса приложения короче сотни знаков. */
const MAX_HASH_LENGTH = 512;

/** Стоит ли в адресе «Операций» хоть один фильтр. */
export function hasFeedFilters(route: Route): boolean {
  return route.name === "operations" && FEED_FILTER_KEYS.some((key) => route[key] !== undefined);
}

/**
 * Вкладка — экран нижней навигации без листа. «Операции» с фильтром — не вкладка, а взгляд на них
 * откуда-то (строка легенды «Отчётов»): такой маршрут кладётся поверх того, где стоишь, и «Назад»
 * возвращает туда — к «Отчётам» с их периодом. Смена фильтра на самом экране заменяет запись
 * истории, а не копит их (`features/feed/FeedScreen.tsx`).
 */
export function isTab(route: Route): boolean {
  if (route.sheet !== undefined || !(TAB_NAMES as readonly string[]).includes(route.name)) return false;
  return !hasFeedFilters(route);
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
    case "accounts":
    case "rates":
    case "categories":
    case "tags":
    case "debts":
    case "goals":
    case "recurring":
      return { name: "more" };
    case "account":
    case "account-new":
      return { name: "accounts" };
    case "category":
      // Родитель чистый и бюджета не читает: вид списка записан в адресе. Ссылку без него, ведущую
      // к источнику дохода, `resolveRoute` по бюджету переписывает на вид записи.
      return { name: "categories", type: route.type ?? "expense" };
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
    case "accounts":
    case "rates":
    case "categories":
    case "tags":
    case "debts":
    case "goals":
    case "recurring":
      return `#/more/${route.name}`;
    case "account-new":
      return "#/more/accounts/new";
    case "account":
    case "category": {
      const id = canonicalValue(PATH_ID, route.id);
      if (id === null) throw new Error("A route value is outside the address grammar.");
      return `#/more/${route.name === "account" ? "accounts" : "categories"}/${id}`;
    }
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

/** Ключи запроса маршрута: всё, кроме имени и идентификатора в пути. */
type QueryKeysOf<N extends RouteName> = Exclude<keyof Extract<Route, { readonly name: N }>, "name" | "id">;

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

/** Фильтры «Операций» (2d): период и вид из перечней, дни, идентификаторы записей — ничего свободного. */
const OPERATIONS_GRAMMAR = {
  period: { kind: "enum", values: FEED_PERIODS },
  from: { kind: "day" },
  to: { kind: "day" },
  acc: { kind: "uuid" },
  cat: { kind: "uuid" },
  tag: { kind: "uuid" },
  member: { kind: "uuid" },
  kind: { kind: "enum", values: FEED_KINDS },
} as const satisfies { readonly [K in keyof OperationsFilterFields]-?: QuerySpec };

/** «Отчёты» (2d): вкладка и период из перечней, дни и счёт. */
const REPORTS_GRAMMAR = {
  view: { kind: "enum", values: REPORT_VIEWS },
  period: { kind: "enum", values: REPORT_PERIODS },
  from: { kind: "day" },
  to: { kind: "day" },
  acc: { kind: "uuid" },
} as const satisfies { readonly [K in keyof ReportsFields]-?: QuerySpec };

/**
 * The address grammar: per route, the query keys it may carry, in their canonical order. Adding a
 * key is adding a line here — and in the fragment pattern of `address-privacy.test.ts`, on purpose.
 */
export const QUERY_GRAMMAR = {
  overview: { month: { kind: "month" }, ...SHEET_GRAMMAR },
  operations: { ...OPERATIONS_GRAMMAR, ...SHEET_GRAMMAR },
  reports: { ...REPORTS_GRAMMAR, ...SHEET_GRAMMAR },
  more: SHEET_GRAMMAR,
  "plan-month": SHEET_GRAMMAR,
  "plan-year": SHEET_GRAMMAR,
  family: SHEET_GRAMMAR,
  import: SHEET_GRAMMAR,
  accounts: SHEET_GRAMMAR,
  account: SHEET_GRAMMAR,
  "account-new": { type: { kind: "enum", values: NEW_ACCOUNT_TYPES }, ...SHEET_GRAMMAR },
  rates: SHEET_GRAMMAR,
  categories: { type: { kind: "enum", values: CATEGORY_LIST_TYPES }, ...SHEET_GRAMMAR },
  category: { type: { kind: "enum", values: CATEGORY_LIST_TYPES }, ...SHEET_GRAMMAR },
  tags: SHEET_GRAMMAR,
  debts: SHEET_GRAMMAR,
  goals: SHEET_GRAMMAR,
  recurring: SHEET_GRAMMAR,
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

/**
 * Период — от `from` до `to` включительно: последний день не раньше первого. У «Операций» период —
 * либо словом («вся история»), либо днями, но не тем и другим сразу.
 */
function periodCoherent(fields: Readonly<Record<string, unknown>>): boolean {
  if (fields.name === "operations" && fields.period !== undefined && (fields.from !== undefined || fields.to !== undefined)) return false;
  return typeof fields.from !== "string" || typeof fields.to !== "string" || fields.from <= fields.to;
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
    if (key === "name" || (key === "id" && hasPathId(route.name))) continue;
    if (!Object.hasOwn(grammar, key)) throw new Error("A route field is outside the address grammar.");
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
  if (!periodCoherent(fields)) throw new Error("A period ends before it starts, or names the whole history and days at once.");
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
      if (rest.length === 0) return found({ name: child });
      // Запись справочника — один сегмент после списка: UUID (или «new» у счетов). Всё прочее —
      // имя, сумма, лишний сегмент — к списку и «Запись не найдена».
      const [record, ...beyond] = rest;
      const id = canonicalValue(PATH_ID, record);
      if (beyond.length > 0) return notFound({ name: child });
      if (child === "accounts" && record === "new") return found({ name: "account-new" });
      if (child === "accounts" && id !== null) return found({ name: "account", id });
      if (child === "categories" && id !== null) return found({ name: "category", id });
      return notFound({ name: child });
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
  // Период, который кончается раньше, чем начался, — не период: оба дня уходят, и это «Запись не найдена».
  // «Вся история» вместе с днями — тоже: дни уходят, остаётся слово.
  if (!periodCoherent(fields)) {
    delete fields.from;
    delete fields.to;
    rejected = true;
  }
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

/** Что есть в бюджете: по этому маршрут проверяет идентификаторы, которые несёт. */
export interface RouteRecords {
  readonly transaction: (id: string) => boolean;
  readonly account?: (id: string) => boolean;
  /** Вид категории — расходы или доходы; `null` — такой категории нет. */
  readonly category?: (id: string) => CategoryListType | null;
  /** Метка фильтра «Операций». */
  readonly tag?: (id: string) => boolean;
  /** Участник фильтра «Операций». */
  readonly member?: (id: string) => boolean;
}

/**
 * Фильтры «Операций» и счёт «Отчётов», чьих записей в бюджете нет (удалены здесь или на другом
 * устройстве, ссылка из чужого бюджета): такие ключи уходят из маршрута, экран остаётся.
 */
function missingRecordKeys(route: Route, exists: RouteRecords): readonly ("acc" | "cat" | "tag" | "member")[] {
  if (route.name !== "operations" && route.name !== "reports") return [];
  const missing: ("acc" | "cat" | "tag" | "member")[] = [];
  if (route.acc !== undefined && exists.account !== undefined && !exists.account(route.acc)) missing.push("acc");
  if (route.name === "operations") {
    if (route.cat !== undefined && exists.category !== undefined && exists.category(route.cat) === null) missing.push("cat");
    if (route.tag !== undefined && exists.tag !== undefined && !exists.tag(route.tag)) missing.push("tag");
    if (route.member !== undefined && exists.member !== undefined && !exists.member(route.member)) missing.push("member");
  }
  return missing;
}

/**
 * Проверка идентификаторов маршрута по бюджету: операция, счёт или категория, которых нет (удалены
 * здесь или на другом устройстве, ссылка из чужого бюджета), — тоже «Запись не найдена», и маршрут
 * уходит к родителю. Категория, чей вид списка в адресе не тот, что у записи (старая ссылка на
 * источник дохода без `type`), — найдена, но маршрут её — с видом записи: по нему и «назад».
 */
export function resolveRoute(route: Route, exists: RouteRecords): ParsedRoute {
  const missingKeys = missingRecordKeys(route, exists);
  if (missingKeys.length > 0) {
    const fields: Record<string, unknown> = { ...route };
    for (const key of missingKeys) delete fields[key];
    const rest = resolveRoute(fields as unknown as Route, exists);
    return notFound(rest.route);
  }
  const screen = withoutSheet(route);
  const kind = screen.name === "category" && exists.category !== undefined ? exists.category(screen.id) : undefined;
  const missing = (screen.name === "account" && exists.account !== undefined && !exists.account(screen.id)) || kind === null;
  if (missing) return notFound(parentRoute(screen) ?? ROOT_ROUTE);
  if (route.name === "category" && kind !== undefined && kind !== null && (route.type ?? "expense") !== kind) {
    return found({ ...route, type: kind });
  }
  if (route.sheet !== undefined && route.edit !== undefined && !exists.transaction(route.edit)) {
    return notFound(withoutSheet(route));
  }
  return found(route);
}

/**
 * Экран маршрута: без листа, без месяца «Обзора», без фильтров «Операций» и без вкладки и периода
 * «Отчётов». По нему помнится прокрутка и ставится фокус на заголовок: открытый лист, смена месяца,
 * фильтра или периода — тот же экран, и фокус там ведут лист, стрелки и чипы. Строка поиска
 * «Операций» живёт ровно столько, сколько этот экран (`features/feed/FeedScreen.tsx`).
 */
export function screenKey(route: Route): string {
  const screen = withoutSheet(route);
  if (screen.name === "overview" && screen.month !== undefined) return routeKey(ROOT_ROUTE);
  if (screen.name === "operations" || screen.name === "reports") return routeKey({ name: screen.name });
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
