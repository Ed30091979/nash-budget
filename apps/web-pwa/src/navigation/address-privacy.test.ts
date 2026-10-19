/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MonthSwitch } from "../features/overview/MonthSwitch";
import { createRouter } from "./router";
import { formatRoute, parseRoute, QUERY_GRAMMAR, type Route, type RouteName } from "./routes";
import {
  ALL_ROUTE_FIXTURES,
  draftGuard,
  expectHonestHistory,
  CATEGORY,
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
 *    package. The model is a mistake, not an attacker: the names (`location`, `pushState`, the
 *    Navigation API, `open`, `document.title`) are refused wherever they appear, globals may not be
 *    destructured or aliased, and only an allow-list of files writes an `href`. Deliberate
 *    obfuscation — a name assembled from strings at run time — is out of the model (docs/SECURITY.md
 *    §7.3) and left to review;
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
        // Test files and their fixtures never ship (the first test keeps it so). Every script
        // extension counts: a `.js` or `.mjs` module ships as surely as a `.tsx` one.
        else if (/\.[cm]?[jt]sx?$/u.test(name) && !/\.test\.[cm]?[jt]sx?$/u.test(name) && name !== "test-fixture.ts") {
          files.push({ path: `${label}/${relative(rootDir, path).split(sep).join("/")}`, text: readFileSync(path, "utf8") });
        }
      }
    };
    walk(rootDir);
  }
  return files;
}

const ROUTER = "web/navigation/router.ts";

/**
 * Every way a mistake in shipped code could reach history or the address. The names themselves are
 * refused wherever they appear — bracket access, `.call`, an alias and a string all carry them —
 * and the router is the one module allowed them.
 */
const ADDRESS_ACCESS: readonly (readonly [string, RegExp])[] = [
  // `location` by name, read or written, aliased, passed to a helper, assigned into: the router
  // reads `frame.location.hash`, and nothing else in the app has any business with it.
  ["the location object, by name", /\blocation\b/u],
  ["pushState/replaceState/scrollRestoration", /\b(?:pushState|replaceState|scrollRestoration)\b/u],
  ["history via a global", /\b(?:window|globalThis|self|top|parent|frames)\s*(?:\?\.|\.)\s*history\b|\[\s*["'`]history["'`]\s*\]/u],
  ["history traversal or state", /\bhistory\s*(?:\?\.|\.)\s*(?:go|back|forward|state)\b|\bhistory\s*\[\s*["'`]/u],
  // `const { history: past } = window` hides the name the rule above looks for.
  ["a global destructured or aliased", /\{[^{}]*\}\s*=\s*(?:window|globalThis|self|document|top|parent)\b|=\s*(?:window|globalThis|self|top|parent|history)\s*[;,)]/u],
  ["the Navigation API", /\bnavigation(?:\?\.|\.)[A-Za-z_$]|\bnavigation\s*\[|\b(?:window|globalThis|self|top|parent)\s*(?:\?\.|\.)\s*navigation\b/u],
  // `window.open(url, "_self")` navigates this window; a bare `open(` is the same global. A
  // method of something else (`indexedDB.open(`) is not.
  ["open() of a window", /\b(?:window|globalThis|self|top|parent)\s*(?:\?\.|\.)\s*open\b|(?<![.\w$])open\(/u],
  // The title is in the history list and the app switcher just as the address is.
  ["the document title", /\bdocument\s*(?:\?\.|\.)\s*title\b/u],
  ["the document address", /\bdocument\s*(?:\?\.|\.)\s*(?:URL|documentURI|baseURI)\b/u],
  // A form without a handler submits by GET into the query string — `?q=кофе` in the address.
  ["a form that submits into the address", /<form\b(?![^>]*\bonSubmit=)/u],
];

/**
 * The files allowed to write an `href`, with how many writers each has: the sprite reference of
 * `Icon`, the skip link, the download link (an object URL, not the page's address) and the iOS
 * launch-image markup the build writes into `index.html`. Anywhere else — a link built in a
 * variable above, a `.href =` before `.click()` — an `href` is a way into the address. Changing
 * this list is a deliberate edit.
 */
const HREF_WRITERS: Readonly<Record<string, number>> = {
  "web/components/Icon.tsx": 1,
  "web/app/AppShell.tsx": 1,
  "web/features/data-management/download.ts": 1,
  "web/splash.ts": 1,
};
const HREF_WRITE = /\bhref\s*=(?!=)|\bhref\s*:|setAttribute\(\s*["'`]href|\[\s*["'`]href["'`]\s*\]/gu;

/** What the tripwire says about one shipped file. */
function violations(path: string, text: string): string[] {
  const found = path === ROUTER ? [] : ADDRESS_ACCESS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  const writers = [...text.matchAll(HREF_WRITE)].length;
  if (writers !== (HREF_WRITERS[path] ?? 0)) found.push(`${writers} href writers, allowed ${HREF_WRITERS[path] ?? 0}`);
  return found;
}

/**
 * The bypasses of the re-review of 2a (round 2), as the source they were written in, put into a
 * screen that has no business with the address. Each is refused here; the built bundle refuses
 * them again (`release-scan.test.ts`). A10 — a name assembled from strings at run time — is the
 * kind of deliberate obfuscation the model leaves to review, and is not listed.
 */
const REVIEW_BYPASSES: readonly (readonly [string, string])[] = [
  ["A01 the amount in the document title", 'document.title = `${draft.amount} ₽ — Наш бюджет`;'],
  ["A02 a link built in a variable, then clicked", '{ const target = `#/operations?q=${encodeURIComponent(draft.amount)}`; const link = document.createElement("a"); link.href = target; link.click(); }'],
  ["A03 window.open into this window", 'window.open(`#/operations?q=${encodeURIComponent(draft.amount)}`, "_self");'],
  ["A04 the Navigation API", 'void navigation.navigate(`#/operations?q=${encodeURIComponent(draft.amount)}`, { history: "replace", state: { amount: draft.amount } });'],
  ["A05 location under another name", '{ const here = location; here.hash = `#/operations?q=${draft.amount}`; }'],
  ["A06 Object.assign over location", 'Object.assign(location, { hash: `#/operations?q=${draft.amount}` });'],
  ["A07 history destructured under another name", '{ const { history: past } = window; past.go(-1); }'],
  ["A08 Reflect.apply of pushState", 'Reflect.apply(History.prototype.pushState, history, [null, "", `#/operations?q=${draft.amount}`]);'],
  ["A09 history through a globalThis alias", '{ const h = globalThis.history; h.replaceState(history.state, "", `#/operations?q=${draft.amount}`); }'],
  ["A11 history destructured, method name joined", '{ const { history: h } = window; const m = ["push", "State"].join("") as "pushState"; h[m](null, "", `#/operations?q=${draft.amount}`); }'],
  ["A12 a URL object and location.replace", '{ const url = new URL(document.baseURI); url.hash = `/operations?q=${draft.amount}`; window.location.replace(url); }'],
  ["A13 optional chaining", 'globalThis?.history?.pushState?.(null, "", `#/operations?q=${draft.amount}`);'],
  ["A14 document.location", 'document.location.hash = `#/operations?q=${draft.amount}`;'],
  ["A15 location passed to a helper", '{ const setHash = (target: { hash: string }, value: string) => { target.hash = value; }; setHash(location, `#/operations?q=${draft.amount}`); }'],
  ["A16 a JSX link whose href is built above", 'const searchHref = `#/operations?q=${encodeURIComponent(draft.amount)}`;\n<a hidden href={searchHref}>Поиск</a>'],
  ["A17 a form that submits by GET", '<form role="search"><label htmlFor="report-search">Поиск</label><input id="report-search" name="q" type="search" /></form>'],
];

describe("адрес — только маршрут: исходники", () => {
  it("приложение не тянет к себе опоры проверок: поддельная история не попадает в сборку", () => {
    const importing = sources().filter(({ text }) => /from\s+["'][^"']*test-fixture["']/u.test(text)).map(({ path }) => path);
    expect(importing).toEqual([]);
  });

  it("историю, адрес и заголовок трогает один модуль — роутер; `href` пишут только файлы из списка", () => {
    const all = sources();
    expect(all.some(({ path }) => path.startsWith("packages/domain/"))).toBe(true);
    expect(all.some(({ path }) => path === ROUTER)).toBe(true);
    for (const path of Object.keys(HREF_WRITERS)) expect(all.some((file) => file.path === path), path).toBe(true);
    const touching = all.flatMap(({ path, text }) => violations(path, text).map((label) => `${path}: ${label}`));
    expect(touching).toEqual([]);
  });

  it("каждый обход повторного ревью 2a отвергается, вставленный в лист ввода операции", () => {
    // С 2b операцию записывает лист ввода: сумма, комментарий и метки черновика — у него в руках.
    const sheet = "web/features/entry/EntrySheet.tsx";
    const screen = sources().find(({ path }) => path === sheet);
    expect(screen).toBeDefined();
    const at = screen?.text.indexOf("    if (busy) return;") ?? -1;
    expect(at).toBeGreaterThan(0);
    for (const [label, snippet] of REVIEW_BYPASSES) {
      const patched = `${screen?.text.slice(0, at) ?? ""}    ${snippet}\n${screen?.text.slice(at) ?? ""}`;
      expect(violations(sheet, patched), label).not.toEqual([]);
    }
  });

  it("правило ловит и прежние формы обхода, и не трогает то, что не адрес", () => {
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
      'const w = window;',
      'const past = history;',
      'globalThis.navigation.navigate("#/x");',
      'open("#/spent", "_self");',
      'self.open(url);',
      'document.title = note;',
    ];
    for (const evasion of evasions) {
      expect(ADDRESS_ACCESS.some(([, pattern]) => pattern.test(evasion)), evasion).toBe(true);
    }
    for (const writer of ['<a href="#/new?note=кофе">', "<a href={formatRoute(route)}>", "link.href = target;", "{ href: target }", 'link.setAttribute("href", target);', 'link["href"] = target;']) {
      expect(violations("web/features/entry/EntrySheet.tsx", writer), writer).not.toEqual([]);
    }
    // And it leaves alone what is not the address: a local list called `history`, a database
    // opened by name, a word in a comment, a draft scope.
    for (const innocent of [
      "if (history.length < CONFIDENT_REPEATS) return [];",
      "const opening = indexedDB.open(name, VERSION);",
      "// The guard asks during navigation. Then the screen changes.",
      'drafts.hasUnsavedDrafts("navigation")',
      "<form onSubmit={submit} noValidate>",
      "const isOpen = sheet !== null;",
    ]) {
      expect(violations("web/features/entry/EntrySheet.tsx", innocent), innocent).toEqual([]);
    }
  });

  it("роутер пишет в адрес только ключи цепочки, и только двумя вызовами", () => {
    const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");
    const writes = [...router.matchAll(/\.(pushState|replaceState)\(([^;]*)\);/gu)].map((match) => `${match[1]}(${match[2]})`);
    expect(writes).toEqual([
      'pushState(stateOf(chain.slice(0, index + 1)), "", chain[index] ?? ROOT_KEY)',
      'replaceState(stateOf(chain), "", chain[chain.length - 1] ?? ROOT_KEY)',
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
    "entry", "ENTRY", "entry&amount=1200", "expense", "income&note=кофе", "2026-10-19", "2026-10", "12", 1200, -1, 0.5, Number.NaN, null, true, {}, [], ["entry"],
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
    expect(formatRoute({ name: "operations", sheet: "entry", edit: OPERATION.toUpperCase() })).toBe(`#/operations?sheet=entry&edit=${OPERATION}`);
    expect(parseRoute(`#/operations?sheet=entry&edit=${OPERATION.toUpperCase()}`).route).toEqual({ name: "operations", sheet: "entry", edit: OPERATION });
    expect(formatRoute({ name: "overview", sheet: "entry", op: "expense", dst: CATEGORY.toUpperCase() })).toBe(`#/?sheet=entry&op=expense&dst=${CATEGORY}`);
  });

  it("всё вне грамматики — ошибка программы, и в адрес оно не попадёт", () => {
    const outside = [
      { name: "operations", sheet: "entry", edit: "Продукты 1 250 ₽" },
      { name: "operations", sheet: "entry", edit: "1250" },
      { name: "operations", q: "кофе" },
      { name: "operations", note: "кофе" },
      { name: "operations", sheet: "entry", edit: OPERATION, amount: 1200 },
      { name: "overview", sheet: "кофе" },
      { name: "overview", sheet: "entry", op: "expense", dst: "Продукты" },
      { name: "overview", sheet: "entry", op: "кофе" },
      { name: "overview", sheet: "entry", op: "expense", note: "кофе" },
      { name: "overview", month: "июль" },
      { name: "reports", edit: OPERATION },
      { name: "reports", month: "2026-08" },
      { name: "entry" },
      { name: "spent" },
      { name: "more", sheet: "entry", from: "2026-10-01" },
      // Справочники: имя счёта или категории — не идентификатор, а вид списка — только из перечня.
      { name: "account", id: "Карта Сбера" },
      { name: "account", id: "1250" },
      { name: "account" },
      { name: "accounts", id: OPERATION },
      { name: "account-new", id: OPERATION },
      { name: "category", id: "Продукты" },
      { name: "category", id: OPERATION, type: "Зарплата" },
      { name: "category", id: OPERATION, type: "income", month: "2026-08" },
      { name: "categories", type: "Продукты" },
      { name: "categories", id: CATEGORY },
      { name: "tags", note: "отпуск" },
      { name: "tags", id: OPERATION },
      { name: "rates", amount: 9250 },
    ];
    for (const route of outside) expect(() => formatRoute(route as unknown as Route), JSON.stringify(route)).toThrow();
  });

  it("перебор каждого поля каждого маршрута: `formatRoute` либо бросает, либо пишет язык адреса без свободного текста", () => {
    let written = 0;
    let refused = 0;
    for (const seed of [3, 11, 2026]) {
      const random = generator(seed);
      for (const route of ALL_ROUTE_FIXTURES) {
        // `id` — идентификатор записи в пути (`#/more/accounts/<id>`): у счёта и категории свой,
        // у всех прочих маршрутов его нет вовсе. Враждебное имя вместо UUID адреса не получает.
        const fields = ["name", "id", ...Object.keys(QUERY_GRAMMAR[route.name]), "q", "note", "amount", "from"];
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
    const heads = [
      "#/", "#/new", "#/operations", "#/more/plan-month", "#/reports", "#/spent", "#/more",
      "#/more/accounts", "#/more/accounts/new", `#/more/accounts/${OPERATION}`, `#/more/accounts/${OPERATION.toUpperCase()}`,
      "#/more/accounts/Карта", "#/more/rates", "#/more/categories", `#/more/categories/${CATEGORY}`, "#/more/categories/Продукты",
      "#/more/tags", "#/more/tags/отпуск",
    ];
    const keys = ["edit", "sheet", "op", "src", "dst", "month", "type", "id", "q", "note", "amount", "EDIT", "edit[]", ""];
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const values = hostileValues(random).map((value) => (typeof value === "string" ? value : JSON.stringify(value) ?? ""));
      const query = Array.from({ length: random.next(4) }, () => `${random.pick(keys)}=${random.pick(values)}`).join("&");
      const hash = query === "" ? random.pick(heads) : `${random.pick(heads)}?${query}`;
      const parsed = parseRoute(hash);
      expect(formatRoute(parsed.route), hash).toMatch(ROUTE_FRAGMENT);
    }
  });
});

describe("адрес — только маршрут: месяц на краю календаря", () => {
  it("месяц любого года 0000–9999 читается, только если он в окне домена, — и «Обзор» с ним рисуется", () => {
    // Ревью 2b, MEDIUM-7: `#/?month=0000-01` проходил грамматику, стрелка месяца бросала исключение,
    // и приложение вставало пустой страницей — и после перезагрузки тоже.
    const random = generator(23);
    let accepted = 0;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const year = String(attempt < 4 ? [0, 1899, 2200, 9999][attempt] : random.next(10_000)).padStart(4, "0");
      const month = `${year}-${String(1 + random.next(12)).padStart(2, "0")}`;
      const parsed = parseRoute(`#/?month=${month}`);
      const inWindow = month >= "1900-01" && month <= "2199-12";
      expect(parsed, month).toEqual(inWindow ? { route: { name: "overview", month }, notFound: false } : { route: { name: "overview" }, notFound: true });
      if (!inWindow) continue;
      accepted += 1;
      expect(() => renderToStaticMarkup(createElement(MonthSwitch, { month, onMonth: () => undefined })), month).not.toThrow();
    }
    expect(accepted).toBeGreaterThan(10);
    for (const edge of ["1900-01", "2199-12"]) {
      expect(() => renderToStaticMarkup(createElement(MonthSwitch, { month: edge, onMonth: () => undefined })), edge).not.toThrow();
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
    // Время — ожидание событий истории (по 5 мс на переход), а не счёт: маршрутов с 2c больше, и
    // переходов между ними — квадрат их числа.
  }, 120_000);

  it("после каждого пути — возврат с черновиком, набранный адрес, лист при перезагрузке, уход без вопроса, «Назад» и «Вперёд»", async () => {
    // Системное «Назад» с черновиком: запись возвращается поверх той, куда пришли.
    const drafts = draftGuard();
    const { frame, router } = started("", null, { guard: drafts.guard });
    await go(router, { name: "operations" });
    await go(router, { name: "operations", sheet: "entry" });
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
    await go(router, { name: "operations", sheet: "entry", edit: OPERATION });
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
      `#/operations?sheet=entry&edit=${OPERATION.toUpperCase()}`,
      "#/operations?sheet=entry&edit=1200",
      "#/?sheet=entry&op=expense&dst=Продукты&amount=1200",
      "#/?month=2026-08&note=кофе",
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
      [`#/more/categories/${CATEGORY}`, null],
      ["#/more/accounts/Карта%20Сбера", null],
      ["#/more/categories?type=income&note=кофе", null],
      ["#/?amount=1200", null],
      ["#/new?edit=not-a-uuid", { mark: "nash-budget/route", stack: ["#/new?edit=not-a-uuid"] }],
      ["#/operations?sheet=entry&edit=not-a-uuid", { mark: "nash-budget/route", stack: ["#/", "#/operations?sheet=entry&edit=not-a-uuid"] }],
      ["#/reports", { mark: "nash-budget/route", stack: ["#/", "#/reports"], note: "кофе" }],
      ["#/operations", { mark: "nash-budget/route", stack: ["#/", "#/operations?q=кофе"] }],
    ] as const) {
      const link = new FakeBrowser(hash, state);
      createRouter({ window: link }).start();
      expectHonestHistory(link);
    }
  });
});
