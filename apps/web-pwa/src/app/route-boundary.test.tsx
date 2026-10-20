import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RouteErrorBoundary, ROUTE_FAILURE_TITLE } from "./RouteErrorBoundary";

/**
 * Экран маршрута, который упал при отрисовке, — спокойный экран с дорогой на «Обзор», а не белая
 * страница (ревью 2d, HIGH-1). Отрисовку без браузера `react-dom/server` не ловит границей ошибок,
 * поэтому проверка зовёт методы границы прямо: так React зовёт их сам, когда потомок бросает.
 */

const plain = (markup: string) => markup.replace(/<[^>]*>/gu, " ").replace(/&nbsp;/gu, " ").replace(/[\u00a0\u202f]/gu, " ").replace(/&quot;/gu, "\"").replace(/\s+/gu, " ").trim();

describe("граница ошибок экрана маршрута", () => {
  it("пока экран рисуется, граница его не трогает", () => {
    const markup = renderToStaticMarkup(
      <RouteErrorBoundary routeKey="#/reports" onHome={vi.fn()}><p>экран</p></RouteErrorBoundary>,
    );
    expect(markup).toBe("<p>экран</p>");
  });

  it("упавший экран — заголовок, слова о том, что данные целы, и «На «Обзор»»", () => {
    const onHome = vi.fn();
    const boundary = new RouteErrorBoundary({ routeKey: "#/reports", onHome, children: <p>экран</p> });
    boundary.state = { ...boundary.state, ...RouteErrorBoundary.getDerivedStateFromError(new Error("calendar")) };
    const markup = renderToStaticMarkup(<>{boundary.render()}</>);
    // Заголовок — `h1`: оболочка ставит на него фокус, и читающий с экрана слышит, где он.
    expect(markup).toContain(`<h1 tabindex="-1">${ROUTE_FAILURE_TITLE}</h1>`);
    expect(plain(markup)).toContain("Записи целы");
    expect(markup).toMatch(/<button class="primary-button wide empty-action" type="button">На «Обзор»<\/button>/u);
    // Текст ошибки на экран не выводится: в нём бывают суммы, имена и заметки.
    expect(markup).not.toContain("calendar");
    expect(markup).not.toContain("экран</p>");
  });

  it("другой маршрут — граница сбрасывается, и новый экран рисуется заново", () => {
    const failed = { failed: true, routeKey: "#/reports?period=month&from=1900-01-01" };
    expect(RouteErrorBoundary.getDerivedStateFromProps({ routeKey: "#/reports?period=month&from=1900-01-01", onHome: vi.fn(), children: null }, failed)).toBeNull();
    expect(RouteErrorBoundary.getDerivedStateFromProps({ routeKey: "#/", onHome: vi.fn(), children: null }, failed)).toEqual({ failed: false, routeKey: "#/" });
  });

  it("оболочка рисует экран маршрута внутри границы и ведёт её «На «Обзор»» на корень", () => {
    const shell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
    expect(shell).toMatch(/<RouteErrorBoundary routeKey=\{routeKey\(route\)\} onHome=\{\(\) => navigate\(\{ name: "overview" \}\)\}>\s*<RouteView route=\{route\} app=\{routeContext\} \/>\s*<\/RouteErrorBoundary>/u);
  });
});
