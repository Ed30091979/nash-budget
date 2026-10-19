/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRouter } from "./router";
import { formatRoute, parseRoute, QUERY_GRAMMAR, type Route, type RouteName } from "./routes";
import {
  ALL_ROUTE_FIXTURES,
  draftGuard,
  expectHonestHistory,
  FakeBrowser,
  go,
  OPERATION,
  ROUTE_FIXTURES,
  ROUTE_FRAGMENT,
  settle,
  started,
} from "./test-fixture";

/**
 * The address is a channel that browser history, screenshots and the app switcher all see
 * (docs/SECURITY.md, "The app's address"). Only the route goes there, and only in the closed
 * grammar of `routes.ts`. Four layers keep it so, and this file holds three of them:
 *
 * 1. the grammar itself — every route, every key, and a fuzz over every field: `formatRoute`
 *    either throws or writes something in the hand-written address language;
 * 2. the sources — one module, the router, touches history and the address, in every shipped
 *    package, whatever the syntax (bracket access, `.call`, destructuring);
 * 3. the history the router builds — after every path, entries hold `{ mark, stack }` and nothing
 *    else, and every address in them is in the address language.
 *
 * The fourth, `scripts/release-scan.mjs`, pins the call sites in the built bundle.
 */
const webSource = fileURLToPath(new URL("..", import.meta.url));
const repository = fileURLToPath(new URL("../../../../", import.meta.url));

/** The source directories that ship: the app's own and every workspace package it depends on. */
function shippedSourceRoots(): readonly { readonly label: string; readonly dir: string }[] {
  const manifest = JSON.parse(readFileSync(join(webSource, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
  const workspace = Object.keys(manifest.dependencies).filter((name) => manifest.dependencies[name]?.startsWith("workspace:"));
  const packagesDir = join(repository, "packages");
  const packages = readdirSync(packagesDir)
    .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8")) as { name: string } }))
    .filter(({ manifest: pkg }) => workspace.includes(pkg.name));
  expect(packages.map(({ manifest: pkg }) => pkg.name).sort()).toEqual([...workspace].sort());
  return [
    { label: "web", dir: webSource },
    ...packages.map(({ dir }) => ({ label: `packages/${dir}`, dir: join(packagesDir, dir, "src") })),
  ];
}

function sources(): { readonly path: string; readonly text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const { label, dir: rootDir } of shippedSourceRoots()) {
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        // Test files and their fixtures never ship (the first test keeps it so).
        else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name) && name !== "test-fixture.ts") {
          files.push({ path: `${label}/${relative(rootDir, path).split(sep).join("/")}`, text: readFileSync(path, "utf8") });
        }
      }
    };
    walk(rootDir);
  }
  return files;
}

const ROUTER = "web/navigation/router.ts";

/** Every way shipped code could reach history or the address, whatever the syntax. */
const ADDRESS_ACCESS: readonly (readonly [string, RegExp])[] = [
  // The names themselves: bracket access, `.call`, destructuring and strings all carry them.
  ["pushState/replaceState/scrollRestoration", /\b(?:pushState|replaceState|scrollRestoration)\b/u],
  ["history via a global", /\b(?:window|globalThis|self|top|parent|frames)\s*(?:\?\.|\.)\s*history\b|\[\s*["'`]history["'`]\s*\]/u],
  ["history traversal or state", /\bhistory\s*(?:\?\.|\.)\s*(?:go|back|forward|state)\b|\bhistory\s*\[\s*["'`]/u],
  ["location, read or written", /\blocation\s*(?:\?\.|\.|\[)|\b(?:window|globalThis|self|document|top|parent)\s*(?:\?\.|\.)\s*location\b|\[\s*["'`]location["'`]\s*\]/u],
  ["location destructured", /\{[^{}]*\blocation\b[^{}]*\}\s*=/u],
  ["document address", /\bdocument\s*(?:\?\.|\.)\s*(?:URL|documentURI|baseURI)\b/u],
  ["link into the route fragment", /\bhref\s*=\s*\{?\s*["'`]#\/|\bhref\s*=\s*\{\s*(?:formatRoute|routeKey)\b/u],
];

describe("адрес — только маршрут: исходники", () => {
  it("приложение не тянет к себе опоры проверок: поддельная история не попадает в сборку", () => {
    const importing = sources().filter(({ text }) => /from\s+["'][^"']*test-fixture["']/u.test(text)).map(({ path }) => path);
    expect(importing).toEqual([]);
  });

  it("историю и адрес трогает один модуль — роутер, во всех пакетах, что едут в сборку, и любым синтаксисом", () => {
    const all = sources();
    expect(all.some(({ path }) => path.startsWith("packages/domain/"))).toBe(true);
    expect(all.some(({ path }) => path === ROUTER)).toBe(true);
    const touching = all
      .filter(({ path }) => path !== ROUTER)
      .flatMap(({ path, text }) => ADDRESS_ACCESS.filter(([, pattern]) => pattern.test(text)).map(([label]) => `${path}: ${label}`));
    expect(touching).toEqual([]);
  });

  it("правило ловит каждую форму обхода, а не одну", () => {
    const evasions = [
      'history.pushState({ amount: 1200, note }, "", "#/");',
      'history["pushState"](null, "", "#/spent?amount=" + amount);',
      'history.pushState.call(history, null, "", `#/spent?amount=${amount}`);',
      'const { replaceState } = window.history;',
      'window.history.go(-1);',
      'history.back();',
      'location.hash += "/1200";',
      'location.assign("#/spent");',
      'location.replace("/budget/" + month);',
      'location.href = "/spent?amount=1200";',
      'window.location = "/spent";',
      'const filter = location.search;',
      'const route = window.location.hash;',
      'const where = globalThis["location"].hash;',
      'const { location } = window;',
      'const url = document.URL;',
      '<a href="#/new?note=кофе">',
      '<a href={formatRoute(route)}>',
    ];
    for (const evasion of evasions) {
      expect(ADDRESS_ACCESS.some(([, pattern]) => pattern.test(evasion)), evasion).toBe(true);
    }
    // And it leaves alone what is not the address: a local list called `history`, a download link.
    for (const innocent of ["if (history.length < CONFIDENT_REPEATS) return [];", "anchor.href = objectUrl;", '<use href={`#${ICON_ID_PREFIX}${name}`} />']) {
      expect(ADDRESS_ACCESS.some(([, pattern]) => pattern.test(innocent)), innocent).toBe(false);
    }
  });

  it("роутер пишет в адрес только ключи цепочки, и только тремя вызовами", () => {
    const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");
    const writes = [...router.matchAll(/\.(pushState|replaceState)\(([^;]*)\);/gu)].map((match) => `${match[1]}(${match[2]})`);
    expect(writes).toEqual([
      'pushState(stateOf(chain.slice(0, index + 1)), "", chain[index] ?? ROOT_KEY)',
      'replaceState(stateOf(chain), "", chain[chain.length - 1] ?? ROOT_KEY)',
      'pushState(stateOf(restored), "", leaving)',
    ]);
    // No other form of the calls, and the address is only ever read, as `frame.location.hash`.
    expect(router).not.toMatch(/\[\s*["'`](?:pushState|replaceState|location|history)["'`]\s*\]|\.(?:pushState|replaceState)\s*\.\s*(?:call|apply|bind)\b/u);
    expect([...router.matchAll(/\bhistory\.go\(/gu)]).toHaveLength(1);
    expect([...router.matchAll(/\blocation\s*\.\s*(\w+)/gu)].map((match) => match[1])).toEqual(["hash", "hash", "hash", "hash"]);
    expect([...router.matchAll(/location\.hash/gu)].map((match) => router.slice(match.index, match.index + 24))).not.toContainEqual(expect.stringMatching(/location\.hash\s*\+?=(?!=)/u));
    // The state of an entry is the chain of keys and nothing from the budget; keys come from
    // `formatRoute`, and keys read back from history pass `isRouteKey` first.
    expect(router).toContain("return { mark: STATE_MARK, stack: [...stack] };");
    expect(router).toContain("const leaving = routeKey(route);");
    expect(router).toContain('typeof key === "string" && isRouteKey(key)');
    const routes = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
    expect(routes).toMatch(/export function routeKey\(route: Route\): string \{\s*return formatRoute\(route\);\s*\}/u);
  });
});

/** A seeded generator: the fuzz is the same on every run, and a failure names its seed. */
function generator(seed: number) {
  let value = seed;
  const next = (limit: number) => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value % limit;
  };
  const pick = <T,>(items: readonly T[]): T => items[next(items.length)] as T;
  return { next, pick };
}

/** Values a careless or hostile caller might put in a route field. */
function hostileValues(random: ReturnType<typeof generator>): unknown[] {
  const control = [0, 9, 10, 13, 27, 127, 0x200b, 0x202e, 0xfeff].map((code) => String.fromCharCode(code));
  const pieces = ["кофе", "1200", "1 250,50 ₽", "Маша", "#", "?", "&", "=", "%20", "+", "/", " ", "..", "<b>", OPERATION.toUpperCase(), ...control];
  const random_text = () => Array.from({ length: 1 + random.next(6) }, () => random.pick(pieces)).join("");
  return [
    "", "кофе", "1200", "Продукты 1 250 ₽", OPERATION.toUpperCase(), `${OPERATION} `, ` ${OPERATION}`,
    `${OPERATION}&note=кофе`, `${OPERATION}#/spent`, OPERATION.replace(/-/gu, ""), "00000000-0000-0000-0000-000000000000",
    "entry", "ENTRY", "entry&amount=1200", "2026-10-19", "2026-10", "12", 1200, -1, 0.5, Number.NaN, null, true, {}, [], ["entry"],
    random_text(), random_text(), random_text(),
  ];
}

describe("адрес — только маршрут: грамматика", () => {
  it("у каждого ключа грамматики есть пример у его маршрута", () => {
    for (const [name, grammar] of Object.entries(QUERY_GRAMMAR) as [RouteName, Record<string, unknown>][]) {
      for (const key of Object.keys(grammar)) {
        const examples = ROUTE_FIXTURES[name] as readonly Route[];
        expect(examples.some((route) => key in route), `${name}.${key}`).toBe(true);
      }
    }
  });

  it("каждый маршрут пишется языком адреса и читается обратно тем же маршрутом", () => {
    for (const route of ALL_ROUTE_FIXTURES) {
      const address = formatRoute(route);
      expect(address).toMatch(ROUTE_FRAGMENT);
      expect(parseRoute(address), address).toEqual({ route, notFound: false });
    }
    // UUID принимается в любом регистре и пишется строчными.
    expect(formatRoute({ name: "entry", edit: OPERATION.toUpperCase() })).toBe(`#/new?edit=${OPERATION}`);
    expect(parseRoute(`#/new?edit=${OPERATION.toUpperCase()}`).route).toEqual({ name: "entry", edit: OPERATION });
  });

  it("всё вне грамматики — ошибка программы, и в адрес оно не попадёт", () => {
    const outside = [
      { name: "entry", edit: "Продукты 1 250 ₽" },
      { name: "entry", edit: "1250" },
      { name: "operations", q: "кофе" },
      { name: "operations", note: "кофе" },
      { name: "entry", edit: OPERATION, amount: 1200 },
      { name: "overview", sheet: "кофе" },
      { name: "reports", edit: OPERATION },
      { name: "spent" },
      { name: "more", sheet: "entry", from: "2026-10-01" },
    ];
    for (const route of outside) expect(() => formatRoute(route as unknown as Route), JSON.stringify(route)).toThrow();
  });

  it("перебор каждого поля каждого маршрута: `formatRoute` либо бросает, либо пишет язык адреса без свободного текста", () => {
    let written = 0;
    let refused = 0;
    for (const seed of [3, 11, 2026]) {
      const random = generator(seed);
      for (const route of ALL_ROUTE_FIXTURES) {
        const fields = ["name", ...Object.keys(QUERY_GRAMMAR[route.name]), "q", "note", "amount", "from"];
        for (const field of fields) {
          for (const value of hostileValues(random)) {
            const candidate = { ...route, [field]: value } as unknown as Route;
            let address: string;
            try {
              address = formatRoute(candidate);
            } catch {
              refused += 1;
              continue;
            }
            written += 1;
            expect(address, `seed ${seed}: ${JSON.stringify(candidate)}`).toMatch(ROUTE_FRAGMENT);
            expect(formatRoute(parseRoute(address).route)).toBe(address);
          }
        }
      }
    }
    expect(written).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(written);
  });

  it("перебор адресов: что бы ни пришло в решётке, прочитанный маршрут пишется языком адреса", () => {
    const random = generator(19);
    const heads = ["#/", "#/new", "#/operations", "#/more/plan-month", "#/reports", "#/spent", "#/more"];
    const keys = ["edit", "sheet", "q", "note", "amount", "EDIT", "edit[]", ""];
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const values = hostileValues(random).map((value) => (typeof value === "string" ? value : JSON.stringify(value) ?? ""));
      const query = Array.from({ length: random.next(4) }, () => `${random.pick(keys)}=${random.pick(values)}`).join("&");
      const hash = query === "" ? random.pick(heads) : `${random.pick(heads)}?${query}`;
      const parsed = parseRoute(hash);
      expect(formatRoute(parsed.route), hash).toMatch(ROUTE_FRAGMENT);
    }
  });
});

describe("адрес — только маршрут: история, которую строит роутер", () => {
  it("переход к каждому маршруту с каждого — в истории только `{ mark, stack }` и адреса языка", async () => {
    for (const from of ALL_ROUTE_FIXTURES) {
      const { frame, router } = started(formatRoute(from));
      expectHonestHistory(frame);
      for (const to of ALL_ROUTE_FIXTURES) {
        await go(router, to);
        expectHonestHistory(frame);
      }
    }
  }, 30_000);

  it("после каждого пути — возврат с черновиком, набранный адрес, лист при перезагрузке, уход без вопроса, «Назад» и «Вперёд»", async () => {
    // Системное «Назад» с черновиком: запись возвращается поверх той, куда пришли.
    const drafts = draftGuard();
    const { frame, router } = started("", null, { guard: drafts.guard });
    await go(router, { name: "operations" });
    await go(router, { name: "entry" });
    drafts.setDirty(true);
    await frame.press(-1);
    expect(drafts.asked).toHaveLength(1);
    expectHonestHistory(frame);
    // «Не сохранять» на этом вопросе.
    drafts.setDirty(false);
    drafts.asked[0]?.();
    await settle();
    expectHonestHistory(frame);
    // Уход без вопроса: операции больше нет.
    await go(router, { name: "entry", edit: OPERATION });
    drafts.setDirty(true);
    router.redirect({ name: "operations" });
    await settle();
    expectHonestHistory(frame);
    // Адрес, набранный руками, — свой, со свободным текстом, мусорный; и с черновиком.
    drafts.setDirty(false);
    for (const typed of [
      "#/more/plan-month",
      "#/operations?q=%D0%BA%D0%BE%D1%84%D0%B5&amount=1200",
      "#/spent?amount=1200&note=кофе",
      "#/new?edit=1200",
      `#/new?edit=${OPERATION.toUpperCase()}`,
    ]) {
      await frame.type(typed);
      await settle();
      expectHonestHistory(frame);
    }
    drafts.setDirty(true);
    await frame.type("#/reports?note=кофе");
    expectHonestHistory(frame);
    drafts.setDirty(false);
    // «Назад» и «Вперёд».
    await frame.press(-1);
    await frame.press(-1);
    await frame.press(1);
    expectHonestHistory(frame);
    // Запись с чужим `state` под видом своей: со свободным текстом в цепочке.
    frame.entries = frame.entries.slice(0, frame.index + 1);
    frame.entries.push({ state: { mark: "nash-budget/route", stack: ["#/", "#/operations?q=кофе"] }, hash: "#/operations?q=кофе" });
    frame.index += 1;
    frame.fire();
    await settle();
    await settle();
    expectHonestHistory(frame);

    // Перезагрузка с открытым листом.
    const sheet = started();
    await go(sheet.router, { name: "operations" });
    await go(sheet.router, { name: "operations", sheet: "entry" });
    sheet.stop();
    createRouter({ window: sheet.frame }).start();
    expectHonestHistory(sheet.frame);

    // Запуск со ссылкой, мусором и чужим `state`.
    for (const [hash, state] of [
      ["#/more/import", null],
      ["#/?amount=1200", null],
      ["#/new?edit=not-a-uuid", { mark: "nash-budget/route", stack: ["#/new?edit=not-a-uuid"] }],
      ["#/reports", { mark: "nash-budget/route", stack: ["#/", "#/reports"], note: "кофе" }],
      ["#/operations", { mark: "nash-budget/route", stack: ["#/", "#/operations?q=кофе"] }],
    ] as const) {
      const link = new FakeBrowser(hash, state);
      createRouter({ window: link }).start();
      expectHonestHistory(link);
    }
  });
});
