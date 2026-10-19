import { isUuid } from "@family-budget/domain";

/**
 * Маршруты приложения и их адреса (план волны 2, §2.1).
 *
 * Адрес — решётка (`#/operations`): статический хостинг, Capacitor и сервис-воркер отдают одну и ту
 * же страницу, и переписывать пути не нужно никому. В адрес попадают только непрозрачные
 * идентификаторы (UUID) и ключи фильтров — ни сумм, ни заметок, ни имён: адрес видят история
 * браузера, снимки экрана и системный переключатель приложений.
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
  }
}

/**
 * Адрес маршрута. Идентификатор, который не UUID, — ошибка программы, а не данных: в адрес он не
 * попадёт ни при каких условиях.
 */
export function formatRoute(route: Route): string {
  const query = new URLSearchParams();
  if (route.name === "entry" && route.edit !== undefined) {
    if (!isUuid(route.edit)) throw new Error("A route identifier must be a UUID.");
    query.set("edit", route.edit.toLowerCase());
  }
  if (route.sheet !== undefined) query.set("sheet", route.sheet);
  const search = query.toString();
  return search === "" ? pathOf(route) : `${pathOf(route)}?${search}`;
}

/** Ключ маршрута — его адрес: по нему помнится прокрутка и сравниваются записи истории. */
export function routeKey(route: Route): string {
  return formatRoute(route);
}

export function sameRoute(left: Route, right: Route): boolean {
  return routeKey(left) === routeKey(right);
}

export interface ParsedRoute {
  readonly route: Route;
  /**
   * В адресе было то, чего в приложении нет: неизвестный путь, мусор вместо идентификатора,
   * неизвестный лист. Маршрут тогда — ближайший родитель, а человеку говорят «Запись не найдена».
   * Лишние ключи запроса сюда не относятся: они просто отбрасываются.
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
 * Маршрут по решётке адреса. Пустая решётка и `#/` — «Обзор». Всё, что не разобралось, ведёт к
 * родителю с `notFound`; ничто из адреса не попадает в маршрут без проверки.
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

  let query: URLSearchParams;
  try {
    query = new URLSearchParams(search);
  } catch {
    return notFound(parentRoute(base.route) ?? ROOT_ROUTE);
  }
  let route = base.route;
  const edits = query.getAll("edit");
  if (route.name === "entry" && edits.length > 0) {
    const edit = edits[0] ?? "";
    // Два `edit` или не UUID — это не операция, которую можно открыть.
    if (edits.length > 1 || !isUuid(edit)) return notFound({ name: "operations" });
    route = { name: "entry", edit: edit.toLowerCase() };
  }
  const sheets = query.getAll("sheet");
  if (sheets.length > 0) {
    const sheet = sheets[0] ?? "";
    if (sheets.length > 1 || !(SHEET_NAMES as readonly string[]).includes(sheet)) return notFound(route);
    route = { ...route, sheet: sheet as SheetName };
  }
  return found(route);
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
