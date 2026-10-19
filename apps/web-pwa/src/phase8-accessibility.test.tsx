/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  focusRouteHeading,
  MAIN_CONTENT_ID,
} from "./app/AppShell";
import { addressesTouchTarget, designTouchTargetMinimum } from "./design-contract";
import { readAppSource } from "./app/shell-source";

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
    const source = readAppSource();

    expect(MAIN_CONTENT_ID).toBe("main-content");
    expect(source).toContain('href={`#${MAIN_CONTENT_ID}`}');
    expect(source).toContain("id={MAIN_CONTENT_ID}");
    expect(source).toMatch(/id=\{MAIN_CONTENT_ID\} tabIndex=\{-1\}/);
    expect(source).toContain('data-layout-contract="no-action-overflow"');
    expect(source).toContain('data-screen={route.name}');
    // Фокус и прокрутка — по экрану: лист поверх экрана и другой месяц «Обзора» экран не меняют,
    // и фокус там ведут лист (возвращает на плитку) и стрелки месяца.
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*if \(previousScreenKeyRef\.current === currentScreenKey\) return;[\s\S]*focusRouteHeading\(document\.getElementById\(MAIN_CONTENT_ID\)\);[\s\S]*\}, \[currentScreenKey\]\);/,
    );
    expect(source).toContain("const currentScreenKey = screenKey(route);");
    // Прокрутка возвращается по ключу экрана, а ссылка обхода не трогает адрес: решётка — роутера.
    expect(source).toContain("window.scrollTo(0, scrollPositions.current.get(currentScreenKey) ?? 0);");
    expect(source).toMatch(/const skip = \(event: MouseEvent<HTMLAnchorElement>\) => \{\s*event\.preventDefault\(\);\s*document\.getElementById\(MAIN_CONTENT_ID\)\?\.focus\(\);/u);
    expect(source).not.toMatch(/focusRouteHeading[\s\S]{0,100}\[(?:budget|message|loadState)\]/);
  });

  it("не объявляет ни одной цели нажатия ниже норматива §9 и оставляет всем видимый фокус", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const minimum = designTouchTargetMinimum();

    // Проверяется не конкретное число в конкретной строке, а само правило: ни одно правило,
    // адресующее нажимаемый элемент, не смеет объявить цель мельче норматива. Раньше здесь
    // стояло «44px» тремя точными строками — и документ говорил 48, пока код говорил 44.
    const declaredTargets = cssRules(styles)
      .flatMap((rule) => rule.selectors.map((selector) => ({ selector, declarations: rule.declarations })))
      .filter(({ selector }) => addressesTouchTarget(selector))
      .flatMap(({ selector, declarations }) => declarations
        .map((declaration) => /^min-height:\s*([\d.]+)px$/u.exec(declaration))
        .filter((declared): declared is RegExpExecArray => declared !== null)
        .map((declared) => ({ selector, px: Number(declared[1]) })));

    expect(declaredTargets.length).toBeGreaterThan(10);
    expect(declaredTargets.filter(({ px }) => px < minimum)).toEqual([]);

    expect(styles).toContain(".segmented label:has(input:focus-visible)");
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
    // Здесь стояли три имени класса, и любое переименование внутреннего прокрутчика делало
    // проверку зелёной и бессмысленной. Проверяется само правило: то, что прокручивается вбок
    // внутри себя, обязано и уметь сжиматься — иначе прокрутку получит страница целиком.
    const scrollers = cssRules(styles)
      .filter((rule) => rule.declarations.includes("overflow-x: auto"))
      .flatMap((rule) => rule.selectors);
    const shrinkable = new Set(
      cssRules(styles)
        .filter((rule) => rule.declarations.some((declaration) => /^(?:min-width: 0|max-width: 100%)$/u.test(declaration)))
        .flatMap((rule) => rule.selectors),
    );

    expect(scrollers.length).toBeGreaterThan(0);
    expect(scrollers.filter((selector) => !shrinkable.has(selector))).toEqual([]);
    // И широкая разметка живёт только внутри прокрутчика: правило, требующее себе больше
    // самого узкого поддерживаемого экрана, обязано лежать в чём-то, что прокручивается вбок.
    const narrowest = 320;
    const widened = cssRules(styles)
      .filter((rule) => rule.declarations.some((declaration) => {
        const declared = /^min-width: (\d+)px$/u.exec(declaration);
        return declared !== null && Number(declared[1]) >= narrowest;
      }))
      .flatMap((rule) => rule.selectors)
      .filter((selector) => !selector.startsWith("@") && selector !== "html" && selector !== "body");
    expect(widened.filter((selector) => !scrollers.some((scroller) => selector.startsWith(scroller)))).toEqual([]);
  });

  it("не называет состояние сети: без синхронизации приложение к сети не обращается", () => {
    const source = readAppSource();
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    // Пилюля «в сети» была сведением ни о чём: она называла состояние, которым продукт не занят.
    // Единственное слово шапки о сети — индикатор синхронизации, и только после входа в семью.
    // Он остаётся живой областью с доступным именем: состояние системы называется словом, а не
    // цветной точкой.
    expect(source).not.toMatch(/Состояние сети|network-badge|navigator\.onLine/u);
    expect(styles).not.toContain(".network-badge");
    expect(source).toMatch(/syncIndicator\.state === "local" \? null : <div className="header-badges"><span className=\{syncIndicator\.className\} role="status" aria-label=\{syncIndicator\.ariaLabel\}>\{syncIndicator\.text\}<\/span>/u);
    // Состояние лимита по-прежнему словом, а не только цветом.
    expect(source).toContain('over_limit: "Перелимит"');
    expect(source).toContain('near_limit: "Почти лимит"');
  });

  it("не рисует рамку вокруг программно сфокусированного заголовка, но рисует её на кнопке", () => {
    const rules = cssRules(readFileSync(new URL("./styles.css", import.meta.url), "utf8"));

    // Заголовок маршрута: фокус ставится кодом ради объявления смены экрана — кольца там нет.
    expect(outlineOf(rules, 'h1[tabindex="-1"]:focus')).toEqual(["outline: none"]);
    expect(outlineOf(rules, 'h1[tabindex="-1"]:focus-visible')).toEqual(["outline: none"]);
    // Ни одно правило во всей таблице не возвращает заголовку слайдов первого запуска рамку.
    expect(
      rules.filter(
        (rule) =>
          rule.selectors.some((selector) => /intro.*h1|#intro-title/u.test(selector)) &&
          rule.declarations.some((declaration) => declaration.startsWith("outline:")),
      ),
    ).toEqual([]);

    // Настоящий фокус — на том, что нажимают и заполняют, — остаётся видимым.
    for (const selector of [
      "button:focus-visible",
      "input:focus-visible",
      "select:focus-visible",
      "a:focus-visible",
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

  it("держит цели слайдов первого запуска нажимаемыми кнопками с клавиатурным фокусом", () => {
    const rules = cssRules(readFileSync(new URL("./styles.css", import.meta.url), "utf8"));
    const skip = rules.find((rule) => rule.selectors.includes(".intro-skip"));

    // «Пропустить» — кнопка, а не ссылка-подпись: цель 48 и кольцо общим правилом button:focus-visible.
    expect(skip?.declarations).toContain("min-height: 48px");
    expect(outlineOf(rules, ".intro-skip")).toEqual([]);
    expect(rules.find((rule) => rule.selectors.includes(".intro-actions"))?.declarations).toContain("gap: 8px");
  });
});
