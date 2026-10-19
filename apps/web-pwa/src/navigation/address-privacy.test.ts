/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRouter, memoryRouterWindow } from "./router";
import { formatRoute, type Route } from "./routes";

/**
 * Адрес — канал, который видят история браузера, снимки экрана и переключатель приложений
 * (`scripts/release-scan.mjs`). План волны 2 (§2.1) пускает в него маршрут и только его: решётку
 * пишет один модуль — роутер, ключами `formatRoute`, где идентификатор обязан быть UUID. Скан сборки
 * видит только минифицированный код; кто и чем пишет адрес — проверяется здесь, по исходникам.
 */
const root = fileURLToPath(new URL("..", import.meta.url));

function sources(): { readonly path: string; readonly text: string }[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      // Test files and their fixtures never ship (the next check keeps it so).
      else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name) && name !== "test-fixture.ts") files.push(path);
    }
  };
  walk(root);
  return files.map((path) => ({ path: relative(root, path).split(sep).join("/"), text: readFileSync(path, "utf8") }));
}

describe("адрес — только маршрут", () => {
  it("приложение не тянет к себе опоры проверок: поддельная история не попадает в сборку", () => {
    const importing = sources().filter(({ text }) => /from\s+["'][^"']*test-fixture["']/u.test(text)).map(({ path }) => path);
    expect(importing).toEqual([]);
  });

  it("историю и решётку адреса трогает один модуль — роутер", () => {
    const touching = sources()
      .filter(({ text }) => /\.(?:pushState|replaceState)\(|history\.go\(|location\.(?:hash|search|href)\b/u.test(text))
      .map(({ path }) => path);
    expect(touching).toEqual(["navigation/router.ts"]);
  });

  it("роутер пишет в адрес только ключи цепочки, а ключи делает `formatRoute`", () => {
    const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");
    const writes = [...router.matchAll(/frame\.history\.(pushState|replaceState)\(([^;]*)\);/gu)].map((match) => match[2]);
    expect(writes).toEqual([
      'stateOf(chain.slice(0, index + 1)), "", chain[index] ?? ROOT_KEY',
      'stateOf(chain), "", chain[chain.length - 1] ?? ROOT_KEY',
      'stateOf(restored), "", leaving',
    ]);
    // Состояние записи истории — только ключи цепочки, ничего из бюджета.
    expect(router).toContain("return { mark: STATE_MARK, stack: [...stack] };");
    expect(router).toContain("const leaving = routeKey(route);");
    const routes = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
    expect(routes).toMatch(/export function routeKey\(route: Route\): string \{\s*return formatRoute\(route\);\s*\}/u);
  });

  it("всё, что роутер положил в историю, — канонические адреса маршрутов", () => {
    const frame = memoryRouterWindow("#/more/plan-month");
    const states: unknown[] = [];
    const pushes: string[] = [];
    const { pushState, replaceState } = frame.history;
    frame.history.pushState = (state, unused, url) => { states.push(state); pushes.push(url ?? ""); pushState.call(frame.history, state, unused, url); };
    frame.history.replaceState = (state, unused, url) => { states.push(state); pushes.push(url ?? ""); replaceState.call(frame.history, state, unused, url); };
    const router = createRouter({ window: frame });
    router.start();
    const visits: Route[] = [
      { name: "more" }, { name: "family" }, { name: "operations" },
      { name: "entry", edit: "7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b" }, { name: "reports" },
    ];
    for (const route of visits) router.navigate(route);
    const canonical = new Set(["#/", "#/more", "#/more/plan-month", "#/more/family", "#/operations", "#/reports", formatRoute(visits[3]!)]);
    expect(pushes.length).toBeGreaterThan(4);
    for (const url of pushes) expect(canonical, url).toContain(url);
    for (const state of states) {
      expect(Object.keys(state as object).sort()).toEqual(["mark", "stack"]);
      for (const key of (state as { stack: string[] }).stack) expect(canonical).toContain(key);
    }
  });
});
