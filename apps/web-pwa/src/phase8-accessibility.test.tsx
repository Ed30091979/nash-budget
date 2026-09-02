/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  focusRouteHeading,
  isCapacitorNativeRuntime,
  MAIN_CONTENT_ID,
  networkStatusPresentation,
} from "./App";

interface CssRule {
  readonly selectors: readonly string[];
  readonly declarations: readonly string[];
}

/**
 * Плоский разбор правил таблицы стилей.
 *
 * Внутренние фигурные скобки `@media` не дают прелюдии сойтись за селектор, поэтому вложенные
 * правила попадают сюда наравне с верхнеуровневыми — и это то, что нужно: утверждение «кольца нет
 * нигде» обязано видеть и правило, спрятанное под медиазапросом.
 */
function cssRules(styles: string): CssRule[] {
  return [...styles.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(
    (rule) => ({
      selectors: (rule[1] ?? "").split(",").map((selector) => selector.trim()).filter(Boolean),
      declarations: (rule[2] ?? "").split(";").map((declaration) => declaration.trim()).filter(Boolean),
    }),
  );
}

function outlineOf(rules: readonly CssRule[], selector: string): string[] {
  return rules
    .filter((rule) => rule.selectors.includes(selector))
    .flatMap((rule) => rule.declarations)
    .filter((declaration) => declaration.startsWith("outline:"));
}

describe("phase 8 accessibility and responsive contract", () => {
  it("focuses the route heading without requiring a pre-existing tab stop", () => {
    const focus = vi.fn();
    const setAttribute = vi.fn();
    const heading = {
      focus,
      hasAttribute: vi.fn(() => false),
      setAttribute,
    } as unknown as HTMLElement;
    const root = {
      querySelector: vi.fn(() => heading),
    } as unknown as ParentNode;

    expect(focusRouteHeading(root)).toBe(true);
    expect(root.querySelector).toHaveBeenCalledWith("h1");
    expect(setAttribute).toHaveBeenCalledWith("tabindex", "-1");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focusRouteHeading(null)).toBe(false);
  });

  it("offers a stable skip target and moves focus only after route navigation", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(MAIN_CONTENT_ID).toBe("main-content");
    expect(source).toContain('href={`#${MAIN_CONTENT_ID}`}');
    expect(source).toContain("id={MAIN_CONTENT_ID}");
    expect(source).toMatch(/id=\{MAIN_CONTENT_ID\} tabIndex=\{-1\}/);
    expect(source).toContain('data-layout-contract="no-action-overflow"');
    expect(source).toContain('data-screen={screen}');
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*if \(previousScreenRef\.current === screen\) return;[\s\S]*focusRouteHeading\(document\.getElementById\(MAIN_CONTENT_ID\)\);[\s\S]*\}, \[screen\]\);/,
    );
    expect(source).not.toMatch(/focusRouteHeading[\s\S]{0,100}\[(?:budget|message|loadState)\]/);
  });

  it("keeps every visible control at least 44px with keyboard-visible focus", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(styles).toMatch(
      /button, select, input:not\(\[type="radio"\]\):not\(\[type="checkbox"\]\):not\(\[type="file"\]\), \.file-button \{ min-height: 44px; \}/,
    );
    expect(styles).toMatch(/\.horizon-toggle button \{ min-height: 44px;/);
    expect(styles).toMatch(/\.segmented label \{[^}]*min-height: 44px;/);
    expect(styles).toContain(".segmented label:has(input:focus-visible)");
    expect(styles).toContain(".composition-options label:has(input:focus-visible)");
    expect(styles).toContain(".month-checkboxes label:has(input:focus-visible)");
    expect(styles).toContain(".file-button:focus-within");
    expect(styles).toContain("outline: 3px solid var(--focus)");
  });

  it("defines narrow, zoomed-tablet and landscape containment without hiding inner data scrollers", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    expect(styles).toContain('body { max-width: 100%;');
    expect(styles).toContain("overflow-x: clip;");
    expect(styles).toContain('[data-layout-contract="no-action-overflow"] { min-width: 0; max-width: 100%; }');
    expect(styles).toContain("@media (max-width: 520px)");
    expect(styles).toContain("@media (max-width: 360px)");
    expect(styles).toContain("@media (orientation: landscape) and (max-height: 520px)");
    expect(styles).toMatch(/\.dashboard-chart \{[^}]*overflow-x: auto;/);
    expect(styles).toMatch(/\.dashboard-table-scroll \{[^}]*overflow-x: auto;/);
    expect(styles).toMatch(/\.dashboard-month-cards \{[^}]*overflow-x: auto;/);
  });

  it("retains text labels for network and budget states instead of color-only status", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(source).toContain('ariaLabel: "Состояние сети: локально на устройстве"');
    expect(source).toContain('text: "локально на устройстве"');
    expect(source).toContain('ariaLabel: `Состояние сети: ${text}`');
    expect(source).toContain("<span className={networkStatus.className} role=\"status\" aria-label={networkStatus.ariaLabel}>{networkStatus.text}</span>");
    expect(source).toContain('over_limit: "Перелимит"');
    expect(source).toContain('near_limit: "Почти лимит"');
  });

  it.each([true, false])("shows a neutral local-device status in native runtime when navigator online is %s", (online) => {
    expect(networkStatusPresentation(true, online)).toEqual({
      text: "локально на устройстве",
      ariaLabel: "Состояние сети: локально на устройстве",
      className: "network-badge",
    });
  });

  it("preserves online and offline status in the web runtime", () => {
    expect(networkStatusPresentation(false, true)).toEqual({
      text: "в сети",
      ariaLabel: "Состояние сети: в сети",
      className: "network-badge",
    });
    expect(networkStatusPresentation(false, false)).toEqual({
      text: "офлайн",
      ariaLabel: "Состояние сети: офлайн",
      className: "network-badge offline",
    });
  });

  it("accepts only an explicit, successful Capacitor native-platform contract", () => {
    const nativeCheck = vi.fn(() => true);
    const runtime = { isNativePlatform: nativeCheck };

    expect(isCapacitorNativeRuntime({ Capacitor: runtime })).toBe(true);
    expect(nativeCheck).toHaveBeenCalledOnce();
    expect(nativeCheck.mock.contexts[0]).toBe(runtime);
    expect(isCapacitorNativeRuntime({ Capacitor: { isNativePlatform: () => false } })).toBe(false);
    expect(isCapacitorNativeRuntime({ Capacitor: { isNativePlatform: "true" } })).toBe(false);
    expect(isCapacitorNativeRuntime({ Capacitor: { isNativePlatform: () => { throw new Error("untrusted bridge"); } } })).toBe(false);
    expect(isCapacitorNativeRuntime({})).toBe(false);
  });

  it("не рисует рамку вокруг программно сфокусированного заголовка, но рисует её на кнопке", () => {
    const rules = cssRules(readFileSync(new URL("./styles.css", import.meta.url), "utf8"));

    // Заголовок маршрута: фокус ставится кодом ради объявления смены экрана — кольца там нет.
    expect(outlineOf(rules, 'h1[tabindex="-1"]:focus')).toEqual(["outline: none"]);
    expect(outlineOf(rules, 'h1[tabindex="-1"]:focus-visible')).toEqual(["outline: none"]);
    // Ни одно правило во всей таблице не возвращает заголовку онбординга рамку.
    expect(
      rules.filter(
        (rule) =>
          rule.selectors.some((selector) => selector.includes("#onboarding-title")) &&
          rule.declarations.some((declaration) => declaration.startsWith("outline:")),
      ),
    ).toEqual([]);

    // Настоящий фокус — на том, что нажимают и заполняют, — остаётся видимым.
    for (const selector of [
      "button:focus-visible",
      "input:focus-visible",
      "select:focus-visible",
      "a:focus-visible",
      "#categories:focus-visible",
      "#composition:focus-visible",
      ".composition-options label:has(input:focus-visible)",
    ]) {
      expect(outlineOf(rules, selector)).toContain("outline: 3px solid var(--focus)");
    }

    // Выключено кольцо ровно у заголовка и больше ни у чего: список — часть контракта.
    expect(
      rules
        .filter((rule) => rule.declarations.includes("outline: none"))
        .flatMap((rule) => rule.selectors),
    ).toEqual(['h1[tabindex="-1"]:focus', 'h1[tabindex="-1"]:focus-visible']);
  });

  it("держит шаги онбординга нажимаемыми целями с клавиатурным фокусом", () => {
    const rules = cssRules(readFileSync(new URL("./styles.css", import.meta.url), "utf8"));
    const step = rules.find((rule) => rule.selectors.includes(".step-progress-step"));

    // Кнопка, а не span: кольцо ей достаётся общим правилом button:focus-visible.
    expect(step?.declarations).toContain("min-height: 48px");
    expect(outlineOf(rules, ".step-progress-step")).toEqual([]);
    expect(rules.find((rule) => rule.selectors.includes(".step-progress ol"))?.declarations)
      .toContain("gap: 8px");
  });
});
