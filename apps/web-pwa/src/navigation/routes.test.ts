import { describe, expect, it } from "vitest";
import {
  forReload,
  formatRoute,
  isRoot,
  isTab,
  parentRoute,
  parseRoute,
  resolveRoute,
  ROOT_ROUTE,
  routeChain,
  routeKey,
  ROUTE_NOT_FOUND_MESSAGE,
  type Route,
} from "./routes";

const OPERATION = "7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

/** Все маршруты 2a — по одному на каждую форму адреса. */
const ROUTES: readonly Route[] = [
  { name: "overview" },
  { name: "operations" },
  { name: "reports" },
  { name: "more" },
  { name: "entry" },
  { name: "entry", edit: OPERATION },
  { name: "plan-month" },
  { name: "plan-year" },
  { name: "family" },
  { name: "import" },
  { name: "overview", sheet: "entry" },
  { name: "operations", sheet: "entry" },
];

describe("адреса маршрутов", () => {
  it("каждый маршрут пишется адресом и читается из него тем же маршрутом", () => {
    for (const route of ROUTES) {
      const parsed = parseRoute(formatRoute(route));
      expect(parsed, formatRoute(route)).toEqual({ route, notFound: false });
    }
    expect(formatRoute({ name: "overview" })).toBe("#/");
    expect(formatRoute({ name: "operations" })).toBe("#/operations");
    expect(formatRoute({ name: "entry" })).toBe("#/new");
    expect(formatRoute({ name: "entry", edit: OPERATION })).toBe(`#/new?edit=${OPERATION}`);
    expect(formatRoute({ name: "plan-month" })).toBe("#/more/plan-month");
    expect(formatRoute({ name: "plan-year" })).toBe("#/more/plan-year");
    expect(formatRoute({ name: "overview", sheet: "entry" })).toBe("#/?sheet=entry");
  });

  it("пустой адрес, «#» и «#/» — «Обзор», и это не ошибка", () => {
    for (const hash of ["", "#", "#/"]) expect(parseRoute(hash)).toEqual({ route: ROOT_ROUTE, notFound: false });
  });

  it("мусор ведёт к ближайшему родителю и называется «Запись не найдена»", () => {
    const cases: readonly (readonly [string, Route])[] = [
      ["#/bogus", { name: "overview" }],
      ["#main-content", { name: "overview" }],
      ["#/more/bogus", { name: "more" }],
      ["#/more/plan-month/extra", { name: "plan-month" }],
      ["#/operations/123", { name: "operations" }],
      ["#/reports/x/y", { name: "reports" }],
      ["#/new/x", { name: "overview" }],
      ["#//more", { name: "overview" }],
      ["#/new?edit=not-a-uuid", { name: "operations" }],
      ["#/new?edit=1250", { name: "operations" }],
      [`#/new?edit=${OPERATION}&edit=${OPERATION}`, { name: "operations" }],
      ["#/?sheet=unknown", { name: "overview" }],
      ["#/operations?sheet=entry&sheet=entry", { name: "operations" }],
      [`#/${"x".repeat(600)}`, { name: "overview" }],
    ];
    for (const [hash, route] of cases) {
      expect(parseRoute(hash), hash).toEqual({ route, notFound: true });
    }
    expect(ROUTE_NOT_FOUND_MESSAGE).toBe("Запись не найдена");
  });

  it("лишние ключи запроса отбрасывает молча, а косую черту на конце — прощает", () => {
    expect(parseRoute("#/operations?utm=1")).toEqual({ route: { name: "operations" }, notFound: false });
    expect(parseRoute("#/more/")).toEqual({ route: { name: "more" }, notFound: false });
    // Ключ записи истории — только канонический адрес: лишнее не переживает ни одного перехода.
    expect(routeKey(parseRoute("#/operations?utm=1").route)).toBe("#/operations");
    expect(parseRoute(`#/new?edit=${OPERATION.toUpperCase()}`).route).toEqual({ name: "entry", edit: OPERATION });
    // `edit` принадлежит только записи; у других маршрутов он — лишний ключ.
    expect(parseRoute(`#/operations?edit=${OPERATION}`)).toEqual({ route: { name: "operations" }, notFound: false });
  });

  it("в адресе только непрозрачные идентификаторы и ключи — ни сумм, ни заметок, ни имён", () => {
    expect(() => formatRoute({ name: "entry", edit: "Продукты 1 250 ₽" })).toThrow();
    expect(() => formatRoute({ name: "entry", edit: "1250" })).toThrow();
    for (const route of ROUTES) {
      expect(formatRoute(route)).toMatch(/^#\/[a-z/-]*(?:\?[a-z]+=[0-9a-z-]+(?:&[a-z]+=[0-9a-z-]+)*)?$/u);
    }
  });
});

describe("родители маршрутов", () => {
  it("у каждого маршрута есть родитель, и цепочка родителей кончается «Обзором»", () => {
    expect(parentRoute(ROOT_ROUTE)).toBeNull();
    for (const route of ROUTES.filter((item) => !isRoot(item))) {
      const chain = routeChain(route);
      expect(chain[0], formatRoute(route)).toEqual(ROOT_ROUTE);
      expect(chain[chain.length - 1]).toEqual(route);
      expect(chain.length).toBeLessThanOrEqual(3);
    }
  });

  it("вкладки и «+» — дети «Обзора», подэкраны «Ещё» — дети «Ещё», правка — дитя «Операций»", () => {
    for (const name of ["operations", "reports", "more"] as const) {
      expect(isTab({ name })).toBe(true);
      expect(parentRoute({ name })).toEqual(ROOT_ROUTE);
    }
    expect(isTab({ name: "entry" })).toBe(false);
    expect(parentRoute({ name: "entry" })).toEqual(ROOT_ROUTE);
    expect(parentRoute({ name: "entry", edit: OPERATION })).toEqual({ name: "operations" });
    for (const name of ["plan-month", "plan-year", "family", "import"] as const) {
      expect(parentRoute({ name })).toEqual({ name: "more" });
    }
    expect(routeChain({ name: "plan-year" }).map(formatRoute)).toEqual(["#/", "#/more", "#/more/plan-year"]);
  });

  it("лист закрывается на экран под ним, а при перезагрузке закрыт", () => {
    const sheet: Route = { name: "operations", sheet: "entry" };
    expect(isTab(sheet)).toBe(false);
    expect(parentRoute(sheet)).toEqual({ name: "operations" });
    expect(forReload(sheet)).toEqual({ name: "operations" });
    expect(forReload({ name: "plan-month" })).toEqual({ name: "plan-month" });
  });

  it("операция, которой в бюджете нет, — «Запись не найдена» и возврат к «Операциям»", () => {
    const route: Route = { name: "entry", edit: OPERATION };
    expect(resolveRoute(route, { transaction: () => true })).toEqual({ route, notFound: false });
    expect(resolveRoute(route, { transaction: () => false })).toEqual({ route: { name: "operations" }, notFound: true });
    expect(resolveRoute({ name: "entry" }, { transaction: () => false })).toEqual({ route: { name: "entry" }, notFound: false });
  });
});
