import { describe, expect, it } from "vitest";
import {
  canonicalValue,
  forReload,
  formatRoute,
  isRoot,
  isTab,
  leftBehind,
  parentRoute,
  parseRoute,
  resolveRoute,
  ROOT_ROUTE,
  routeChain,
  routeKey,
  ROUTE_NOT_FOUND_MESSAGE,
  sameRecordId,
  screenKey,
  withoutSheet,
  type Route,
} from "./routes";

const OPERATION = "7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const ACCOUNT = "22222222-2222-4222-8222-222222222221";
const RESERVE = "22222222-2222-4222-8222-222222222222";
const CATEGORY = "73333333-3333-4333-8333-333333333335";

/** Все маршруты 2b — по одному на каждую форму адреса. */
const ROUTES: readonly Route[] = [
  { name: "overview" },
  { name: "overview", month: "2026-08" },
  { name: "operations" },
  { name: "reports" },
  { name: "more" },
  { name: "plan-month" },
  { name: "plan-year" },
  { name: "family" },
  { name: "import" },
  { name: "overview", sheet: "entry" },
  { name: "overview", sheet: "entry", op: "expense", dst: CATEGORY },
  { name: "overview", month: "2026-08", sheet: "entry", op: "expense", src: ACCOUNT, dst: CATEGORY },
  { name: "overview", sheet: "entry", op: "income", dst: ACCOUNT },
  { name: "overview", sheet: "entry", op: "income", src: CATEGORY, dst: ACCOUNT },
  { name: "overview", sheet: "entry", op: "transfer", src: ACCOUNT, dst: RESERVE },
  { name: "operations", sheet: "entry" },
  { name: "operations", sheet: "entry", edit: OPERATION },
  { name: "more", sheet: "entry" },
];

describe("адреса маршрутов", () => {
  it("каждый маршрут пишется адресом и читается из него тем же маршрутом", () => {
    for (const route of ROUTES) {
      const parsed = parseRoute(formatRoute(route));
      expect(parsed, formatRoute(route)).toEqual({ route, notFound: false });
    }
    expect(formatRoute({ name: "overview" })).toBe("#/");
    expect(formatRoute({ name: "operations" })).toBe("#/operations");
    expect(formatRoute({ name: "overview", month: "2026-08" })).toBe("#/?month=2026-08");
    expect(formatRoute({ name: "plan-month" })).toBe("#/more/plan-month");
    expect(formatRoute({ name: "plan-year" })).toBe("#/more/plan-year");
    expect(formatRoute({ name: "overview", sheet: "entry" })).toBe("#/?sheet=entry");
    // Ключи — в каноническом порядке грамматики, как бы их ни перечислили.
    expect(formatRoute({ dst: CATEGORY, src: ACCOUNT, op: "expense", sheet: "entry", month: "2026-08", name: "overview" }))
      .toBe(`#/?month=2026-08&sheet=entry&op=expense&src=${ACCOUNT}&dst=${CATEGORY}`);
    expect(formatRoute({ name: "operations", sheet: "entry", edit: OPERATION })).toBe(`#/operations?sheet=entry&edit=${OPERATION}`);
  });

  it("адрес «+» подволны 2a — «Обзор»: запись теперь лист, и по старой ссылке он не открывается", () => {
    expect(parseRoute("#/new")).toEqual({ route: ROOT_ROUTE, notFound: false });
    expect(parseRoute(`#/new?edit=${OPERATION}`)).toEqual({ route: ROOT_ROUTE, notFound: false });
    expect(parseRoute("#/new?sheet=entry")).toEqual({ route: { name: "overview", sheet: "entry" }, notFound: false });
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
      // Операция, которой не может быть, — листа нет: экран под ним и «Запись не найдена».
      ["#/operations?sheet=entry&edit=not-a-uuid", { name: "operations" }],
      ["#/operations?sheet=entry&edit=1250", { name: "operations" }],
      [`#/operations?sheet=entry&edit=${OPERATION}&edit=${OPERATION}`, { name: "operations" }],
      ["#/?month=2026-08&sheet=entry&edit=Продукты", { name: "overview", month: "2026-08" }],
      ["#/?sheet=unknown", { name: "overview" }],
      ["#/?month=2026-13", { name: "overview" }],
      // Месяц вне окна календаря домена (1900–2199) — тоже «не найдена» (ревью 2b, MEDIUM-7).
      ["#/?month=0000-01", { name: "overview" }],
      ["#/?month=9999-12", { name: "overview" }],
      ["#/?month=1899-12", { name: "overview" }],
      ["#/?month=2200-01", { name: "overview" }],
      ["#/?month=август", { name: "overview" }],
      ["#/operations?sheet=entry&sheet=entry", { name: "operations" }],
      // Вид не из перечня и плитка не UUID — ключ отброшен, лист без него, и это тоже «не найдена».
      ["#/?sheet=entry&op=coffee", { name: "overview", sheet: "entry" }],
      ["#/?sheet=entry&op=expense&dst=1250", { name: "overview", sheet: "entry", op: "expense" }],
      [`#/?sheet=entry&op=expense&src=${ACCOUNT}&src=${ACCOUNT}`, { name: "overview", sheet: "entry", op: "expense" }],
      [`#/${"x".repeat(600)}`, { name: "overview" }],
      // Значения читаются как есть: каноническое значение не кодируется, и `%…` — не наше.
      ["#/?sheet=%65ntry", { name: "overview" }],
      [`#/operations?sheet=entry&edit=${OPERATION.replace("-", "%2D")}`, { name: "operations" }],
      ["#/operations?sheet=entry&edit", { name: "operations" }],
      ["#/operations?sheet=entry&edit=", { name: "operations" }],
      ["#/more/family?sheet=entry+", { name: "family" }],
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
    expect(parseRoute(`#/operations?sheet=entry&edit=${OPERATION.toUpperCase()}`).route).toEqual({ name: "operations", sheet: "entry", edit: OPERATION });
    // Ключи листа без листа — лишние, как чужие: экран открывается без них.
    expect(parseRoute(`#/operations?edit=${OPERATION}`)).toEqual({ route: { name: "operations" }, notFound: false });
    expect(parseRoute(`#/?op=expense&dst=${CATEGORY}`)).toEqual({ route: ROOT_ROUTE, notFound: false });
    // Плитки без вида и вид рядом с правкой — тоже лишние: такой лист не открывают.
    expect(parseRoute(`#/?sheet=entry&src=${ACCOUNT}`)).toEqual({ route: { name: "overview", sheet: "entry" }, notFound: false });
    expect(parseRoute(`#/operations?sheet=entry&edit=${OPERATION}&op=expense&dst=${CATEGORY}`))
      .toEqual({ route: { name: "operations", sheet: "entry", edit: OPERATION }, notFound: false });
    // Порядок ключей в набранном адресе — любой; ключ записи истории — канонический.
    expect(routeKey(parseRoute(`#/?dst=${CATEGORY.toUpperCase()}&op=expense&sheet=entry`).route)).toBe(`#/?sheet=entry&op=expense&dst=${CATEGORY}`);
    // `month` — только у «Обзора».
    expect(parseRoute("#/operations?month=2026-08")).toEqual({ route: { name: "operations" }, notFound: false });
  });

  it("в адресе только непрозрачные идентификаторы и ключи — ни сумм, ни заметок, ни имён", () => {
    expect(() => formatRoute({ name: "operations", sheet: "entry", edit: "Продукты 1 250 ₽" })).toThrow();
    expect(() => formatRoute({ name: "operations", sheet: "entry", edit: "1250" })).toThrow();
    expect(() => formatRoute({ name: "overview", sheet: "entry", op: "expense", dst: "Продукты" })).toThrow();
    expect(() => formatRoute({ name: "overview", month: "август" })).toThrow();
    // Ключи между собой: листа нет — нет и его ключей; плитки — только с видом; правка — без вида.
    expect(() => formatRoute({ name: "operations", edit: OPERATION })).toThrow();
    expect(() => formatRoute({ name: "overview", op: "expense" })).toThrow();
    expect(() => formatRoute({ name: "overview", sheet: "entry", src: ACCOUNT })).toThrow();
    expect(() => formatRoute({ name: "operations", sheet: "entry", edit: OPERATION, op: "expense" })).toThrow();
    for (const route of ROUTES) {
      expect(formatRoute(route)).toMatch(/^#\/[a-z/-]*(?:\?[a-z]+=[0-9a-z-]+(?:&[a-z]+=[0-9a-z-]+)*)?$/u);
    }
  });
});

describe("значения закрытых типов", () => {
  it("UUID — в любом регистре на входе, строчными на выходе; не UUID — нет", () => {
    expect(canonicalValue({ kind: "uuid" }, OPERATION.toUpperCase())).toBe(OPERATION);
    for (const value of ["1200", `${OPERATION} `, OPERATION.replace(/-/gu, ""), "00000000-0000-0000-0000-000000000000", 1200, null]) {
      expect(canonicalValue({ kind: "uuid" }, value), String(value)).toBeNull();
    }
  });

  it("перечень — только свои значения, с точностью до регистра", () => {
    const spec = { kind: "enum", values: ["expense", "income"] } as const;
    expect(canonicalValue(spec, "income")).toBe("income");
    for (const value of ["Income", "кофе", "", "income ", 1]) expect(canonicalValue(spec, value), String(value)).toBeNull();
  });

  it("дата — настоящий день календаря, месяц — настоящий месяц", () => {
    for (const day of ["2026-10-19", "2024-02-29", "2026-12-31"]) expect(canonicalValue({ kind: "day" }, day)).toBe(day);
    for (const day of ["2026-02-29", "2026-13-01", "2026-10-32", "2026-1-19", "19.10.2026", "2026-10-19T00:00", 20261019]) {
      expect(canonicalValue({ kind: "day" }, day), String(day)).toBeNull();
    }
    for (const month of ["2026-10", "2026-01", "1900-01", "2199-12"]) expect(canonicalValue({ kind: "month" }, month)).toBe(month);
    for (const month of ["2026-13", "2026-1", "2026-10-01", "октябрь", "0000-01", "9999-12", "1899-12", "2200-01"]) expect(canonicalValue({ kind: "month" }, month), month).toBeNull();
    // День и месяц — в окне календаря домена: за его краем приложению с ними делать нечего.
    for (const day of ["1900-01-01", "2199-12-31"]) expect(canonicalValue({ kind: "day" }, day)).toBe(day);
    for (const day of ["1899-12-31", "2200-01-01", "0000-01-01"]) expect(canonicalValue({ kind: "day" }, day), day).toBeNull();
  });

  it("число — небольшое целое без знака и лишних нулей, не больше предела", () => {
    const spec = { kind: "count", max: 50 } as const;
    expect(canonicalValue(spec, 0)).toBe("0");
    expect(canonicalValue(spec, "50")).toBe("50");
    for (const value of [51, -1, 1.5, "07", "1e1", " 5", "1200", Number.NaN, "5 ₽"]) expect(canonicalValue(spec, value), String(value)).toBeNull();
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

  it("вкладки и другой месяц — дети «Обзора», подэкраны «Ещё» — дети «Ещё», лист — дитя экрана под ним", () => {
    for (const name of ["operations", "reports", "more"] as const) {
      expect(isTab({ name })).toBe(true);
      expect(parentRoute({ name })).toEqual(ROOT_ROUTE);
    }
    expect(isRoot({ name: "overview", month: "2026-08" })).toBe(false);
    // Другой месяц — та же вкладка: шаг между месяцами не копит записи истории, «Назад» — к текущему.
    expect(isTab({ name: "overview", month: "2026-08" })).toBe(true);
    expect(parentRoute({ name: "overview", month: "2026-08" })).toEqual(ROOT_ROUTE);
    expect(parentRoute({ name: "operations", sheet: "entry", edit: OPERATION })).toEqual({ name: "operations" });
    expect(parentRoute({ name: "overview", month: "2026-08", sheet: "entry", op: "expense", dst: CATEGORY })).toEqual({ name: "overview", month: "2026-08" });
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
    // Вместе с листом уходит всё, с чем его открыли: плитки и правка по ссылке не оживают.
    expect(forReload({ name: "overview", month: "2026-08", sheet: "entry", op: "transfer", src: ACCOUNT, dst: RESERVE })).toEqual({ name: "overview", month: "2026-08" });
    expect(withoutSheet({ name: "operations", sheet: "entry", edit: OPERATION })).toEqual({ name: "operations" });
  });

  it("экран маршрута — без листа и без месяца «Обзора»: по нему помнится прокрутка и ставится фокус", () => {
    expect(screenKey({ name: "overview" })).toBe("#/");
    expect(screenKey({ name: "overview", month: "2026-08", sheet: "entry", op: "expense", dst: CATEGORY })).toBe("#/");
    expect(screenKey({ name: "operations", sheet: "entry", edit: OPERATION })).toBe("#/operations");
    expect(screenKey({ name: "plan-year", sheet: "entry" })).toBe("#/more/plan-year");
  });

  it("что переход оставляет позади: экран — с листом над ним, только лист — или ничего (ревью 2b, MEDIUM-4)", () => {
    // Лист открылся поверх экрана — экран не покинут: его черновик не спрашивается и не стирается.
    expect(leftBehind({ name: "plan-month" }, { name: "plan-month", sheet: "entry" })).toBeNull();
    expect(leftBehind({ name: "import" }, { name: "import", sheet: "entry", op: "expense", dst: CATEGORY })).toBeNull();
    // Лист закрылся на свой экран или сменился другим листом над ним — покинут только лист.
    expect(leftBehind({ name: "plan-month", sheet: "entry" }, { name: "plan-month" })).toBe("sheet");
    expect(leftBehind({ name: "overview", sheet: "entry", op: "expense", dst: CATEGORY }, { name: "overview", sheet: "entry" })).toBe("sheet");
    // Другой экран — покинуто всё; другой месяц «Обзора» — тот же экран.
    expect(leftBehind({ name: "plan-month", sheet: "entry" }, { name: "overview" })).toBe("screen");
    expect(leftBehind({ name: "plan-month" }, { name: "overview", sheet: "entry" })).toBe("screen");
    expect(leftBehind({ name: "overview" }, { name: "overview", month: "2026-08" })).toBeNull();
    expect(leftBehind({ name: "operations" }, { name: "operations" })).toBeNull();
  });

  it("идентификатор из адреса находит операцию, записанную в любом регистре (ревью 2a, п. 4)", () => {
    expect(sameRecordId(OPERATION.toUpperCase(), OPERATION)).toBe(true);
    expect(sameRecordId(OPERATION, OPERATION.toUpperCase())).toBe(true);
    expect(sameRecordId(OPERATION, OPERATION.replace("7f1d", "7f1e"))).toBe(false);
    // Адрес — всегда строчными; хранимое — как пришло, и `resolveRoute` с этим сравнением его находит.
    const stored = [{ id: OPERATION.toUpperCase() }];
    const route = parseRoute(`#/operations?sheet=entry&edit=${OPERATION.toUpperCase()}`).route;
    expect(route).toEqual({ name: "operations", sheet: "entry", edit: OPERATION });
    expect(resolveRoute(route, { transaction: (id) => stored.some((item) => sameRecordId(item.id, id)) })).toEqual({ route, notFound: false });
  });

  it("операция, которой в бюджете нет, — «Запись не найдена», и лист не открывается над «Операциями»", () => {
    const route: Route = { name: "operations", sheet: "entry", edit: OPERATION };
    expect(resolveRoute(route, { transaction: () => true })).toEqual({ route, notFound: false });
    expect(resolveRoute(route, { transaction: () => false })).toEqual({ route: { name: "operations" }, notFound: true });
    const blank: Route = { name: "overview", sheet: "entry" };
    expect(resolveRoute(blank, { transaction: () => false })).toEqual({ route: blank, notFound: false });
  });
});

describe("справочники «Учёта» (подволна 2c)", () => {
  /** Каждая форма адреса справочника — список, запись по UUID в пути, новая запись, вид списка. */
  const DIRECTORY: readonly (readonly [Route, string])[] = [
    [{ name: "accounts" }, "#/more/accounts"],
    [{ name: "account", id: ACCOUNT }, `#/more/accounts/${ACCOUNT}`],
    [{ name: "account-new" }, "#/more/accounts/new"],
    [{ name: "rates" }, "#/more/rates"],
    [{ name: "categories" }, "#/more/categories"],
    [{ name: "categories", type: "expense" }, "#/more/categories?type=expense"],
    [{ name: "categories", type: "income" }, "#/more/categories?type=income"],
    [{ name: "category", id: CATEGORY }, `#/more/categories/${CATEGORY}`],
    [{ name: "category", id: CATEGORY, type: "income" }, `#/more/categories/${CATEGORY}?type=income`],
    [{ name: "category", id: CATEGORY, type: "expense", sheet: "entry", edit: OPERATION }, `#/more/categories/${CATEGORY}?type=expense&sheet=entry&edit=${OPERATION}`],
    [{ name: "tags" }, "#/more/tags"],
    [{ name: "account-new", type: "savings" }, "#/more/accounts/new?type=savings"],
    [{ name: "debts" }, "#/more/debts"],
    [{ name: "goals" }, "#/more/goals"],
    [{ name: "recurring" }, "#/more/recurring"],
    [{ name: "account", id: ACCOUNT, sheet: "entry", op: "transfer", src: ACCOUNT, dst: RESERVE }, `#/more/accounts/${ACCOUNT}?sheet=entry&op=transfer&src=${ACCOUNT}&dst=${RESERVE}`],
    [{ name: "categories", type: "income", sheet: "entry", edit: OPERATION }, `#/more/categories?type=income&sheet=entry&edit=${OPERATION}`],
  ];

  it("каждый адрес справочника пишется и читается обратно тем же маршрутом", () => {
    for (const [route, address] of DIRECTORY) {
      expect(formatRoute(route)).toBe(address);
      expect(parseRoute(address), address).toEqual({ route, notFound: false });
    }
    // UUID в пути — в любом регистре на входе, строчными в адресе.
    expect(formatRoute({ name: "account", id: ACCOUNT.toUpperCase() })).toBe(`#/more/accounts/${ACCOUNT}`);
    expect(parseRoute(`#/more/categories/${CATEGORY.toUpperCase()}`)).toEqual({ route: { name: "category", id: CATEGORY }, notFound: false });
    expect(parseRoute("#/more/accounts/")).toEqual({ route: { name: "accounts" }, notFound: false });
  });

  it("имя, сумма и лишний сегмент вместо UUID — к списку и «Запись не найдена»", () => {
    const cases: readonly (readonly [string, Route])[] = [
      ["#/more/accounts/Карта", { name: "accounts" }],
      ["#/more/accounts/1250", { name: "accounts" }],
      [`#/more/accounts/${ACCOUNT}/edit`, { name: "accounts" }],
      ["#/more/accounts/new/x", { name: "accounts" }],
      ["#/more/accounts/NEW", { name: "accounts" }],
      ["#/more/categories/Продукты", { name: "categories" }],
      [`#/more/categories/${CATEGORY}/x`, { name: "categories" }],
      ["#/more/categories/new", { name: "categories" }],
      ["#/more/rates/USD", { name: "rates" }],
      ["#/more/tags/отпуск", { name: "tags" }],
      ["#/more/categories?type=Продукты", { name: "categories" }],
      ["#/more/categories?type=expense&type=income", { name: "categories" }],
      [`#/more/categories/${CATEGORY}?type=Зарплата`, { name: "category", id: CATEGORY }],
      ["#/more/accounts%2Fnew", { name: "more" }],
      // Вид нового счёта — только из перечня домена: имя или слово вне перечня — форма без вида.
      ["#/more/accounts/new?type=Вклад", { name: "account-new" }],
      ["#/more/accounts/new?type=savings&type=cash", { name: "account-new" }],
      ["#/more/goals/Отпуск", { name: "goals" }],
      ["#/more/debts/Саша", { name: "debts" }],
    ];
    for (const [hash, route] of cases) expect(parseRoute(hash), hash).toEqual({ route, notFound: true });
    // Ключ чужого маршрута отбрасывается молча: `type` бывает только у категорий и их списка.
    expect(parseRoute("#/more/tags?type=income")).toEqual({ route: { name: "tags" }, notFound: false });
    expect(parseRoute(`#/more/accounts/${ACCOUNT}?id=${RESERVE}`)).toEqual({ route: { name: "account", id: ACCOUNT }, notFound: false });
  });

  it("имя записи в адрес не попадает: `formatRoute` бросает на всём, что не UUID и не перечень", () => {
    for (const route of [
      { name: "account", id: "Карта Сбера" },
      { name: "account", id: `${ACCOUNT}/edit` },
      { name: "account" },
      { name: "category", id: "Продукты" },
      { name: "categories", type: "Продукты" },
      { name: "category", id: CATEGORY, type: "Зарплата" },
      { name: "accounts", id: ACCOUNT },
      { name: "tags", id: OPERATION },
      { name: "rates", currency: "USD" },
      { name: "account-new", name2: "Карта" },
      { name: "account-new", type: "Вклад" },
      { name: "goals", id: OPERATION },
      { name: "debts", counterparty: "Саша" },
    ]) {
      expect(() => formatRoute(route as unknown as Route), JSON.stringify(route)).toThrow();
    }
  });

  it("родители: списки — дети «Ещё», запись — дитя своего списка; вкладка подсвечена «Ещё»", () => {
    for (const name of ["accounts", "rates", "categories", "tags", "debts", "goals", "recurring"] as const) expect(parentRoute({ name })).toEqual({ name: "more" });
    expect(parentRoute({ name: "account-new", type: "savings" })).toEqual({ name: "accounts" });
    expect(parentRoute({ name: "account", id: ACCOUNT })).toEqual({ name: "accounts" });
    expect(parentRoute({ name: "account-new" })).toEqual({ name: "accounts" });
    expect(parentRoute({ name: "category", id: CATEGORY })).toEqual({ name: "categories", type: "expense" });
    // Источник дохода — дитя списка доходов: «Назад» и история ведут к нему (ревью 2c, MEDIUM-1).
    expect(parentRoute({ name: "category", id: CATEGORY, type: "income" })).toEqual({ name: "categories", type: "income" });
    expect(routeChain({ name: "category", id: CATEGORY, type: "income" }).map(formatRoute))
      .toEqual(["#/", "#/more", "#/more/categories?type=income", `#/more/categories/${CATEGORY}?type=income`]);
    expect(routeChain({ name: "account", id: ACCOUNT }).map(formatRoute)).toEqual(["#/", "#/more", "#/more/accounts", `#/more/accounts/${ACCOUNT}`]);
    expect(screenKey({ name: "account", id: ACCOUNT, sheet: "entry" })).toBe(`#/more/accounts/${ACCOUNT}`);
    // Лист поверх формы счёта экран не покидает: черновик формы не спрашивается.
    expect(leftBehind({ name: "account", id: ACCOUNT }, { name: "account", id: ACCOUNT, sheet: "entry" })).toBeNull();
    expect(leftBehind({ name: "account", id: ACCOUNT }, { name: "accounts" })).toBe("screen");
    expect(leftBehind({ name: "categories", type: "expense" }, { name: "categories", type: "income" })).toBe("screen");
  });

  it("счёт или категория, которых в бюджете нет, — «Запись не найдена» и список", () => {
    const records = { transaction: () => true, account: (id: string) => sameRecordId(ACCOUNT, id), category: () => null };
    expect(resolveRoute({ name: "account", id: ACCOUNT }, records)).toEqual({ route: { name: "account", id: ACCOUNT }, notFound: false });
    expect(resolveRoute({ name: "account", id: RESERVE }, records)).toEqual({ route: { name: "accounts" }, notFound: true });
    expect(resolveRoute({ name: "account", id: RESERVE, sheet: "entry" }, records)).toEqual({ route: { name: "accounts" }, notFound: true });
    expect(resolveRoute({ name: "category", id: CATEGORY }, records)).toEqual({ route: { name: "categories", type: "expense" }, notFound: true });
    // Вид списка в адресе — по записи: ссылка без него на источник дохода становится точной.
    const income = { transaction: () => true, category: () => "income" as const };
    expect(resolveRoute({ name: "category", id: CATEGORY }, income)).toEqual({ route: { name: "category", id: CATEGORY, type: "income" }, notFound: false });
    expect(resolveRoute({ name: "category", id: CATEGORY, type: "expense", sheet: "entry" }, income))
      .toEqual({ route: { name: "category", id: CATEGORY, type: "income", sheet: "entry" }, notFound: false });
    expect(resolveRoute({ name: "category", id: CATEGORY, type: "income" }, income)).toEqual({ route: { name: "category", id: CATEGORY, type: "income" }, notFound: false });
    expect(resolveRoute({ name: "category", id: CATEGORY }, { transaction: () => true, category: () => "expense" as const })).toEqual({ route: { name: "category", id: CATEGORY }, notFound: false });
    // Без проверки записей (старый вызов) — маршрут как есть.
    expect(resolveRoute({ name: "account", id: RESERVE }, { transaction: () => true })).toEqual({ route: { name: "account", id: RESERVE }, notFound: false });
  });
});
