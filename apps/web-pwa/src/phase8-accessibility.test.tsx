/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { focusRouteHeading, MAIN_CONTENT_ID } from "./App";

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
    expect(styles).toContain("outline: 3px solid #075fd8");
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

    expect(source).toContain('aria-label={`Состояние сети: ${online ? "в сети" : "офлайн"}`}');
    expect(source).toContain('{online ? "в сети" : "офлайн"}');
    expect(source).toContain('over_limit: "Перелимит"');
    expect(source).toContain('near_limit: "Почти лимит"');
  });
});
