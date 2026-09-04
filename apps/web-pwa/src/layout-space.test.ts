/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADER_SPACE_PROPERTY, NAV_SPACE_PROPERTY, observeLayoutSpace } from "./layout-space";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const withoutComments = styles.replace(/\/\*[\s\S]*?\*\//gu, "");

interface CssRule {
  readonly selectors: readonly string[];
  readonly declarations: readonly string[];
}

/** Плоский разбор правил: вложенные в `@media` правила видны наравне с верхнеуровневыми. */
function cssRules(source: string): CssRule[] {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((rule) => ({
    selectors: (rule[1] ?? "").split(",").map((selector) => selector.trim()).filter(Boolean),
    declarations: (rule[2] ?? "").split(";").map((declaration) => declaration.trim()).filter(Boolean),
  }));
}

function rulesFor(selector: string): CssRule[] {
  return cssRules(withoutComments).filter((rule) => rule.selectors.includes(selector));
}

function token(name: string): string {
  const value = withoutComments.match(new RegExp(`\\n\\s*${name}:\\s*([^;]+);`, "u"))?.[1];
  expect(value, `токен ${name} не объявлен`).toBeDefined();
  return (value ?? "").trim();
}

/** Подделка наблюдателя: запоминает, за чем следит, и срабатывает по команде. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element) { this.observed.push(element); }
  unobserve() { /* не используется */ }
  disconnect() { this.disconnected = true; }
  fire() { this.callback([], this as unknown as ResizeObserver); }
}

/** Блок с известной высотой рамки — единственное, что модуль у него спрашивает. */
function block(height: number): Element & { height: number } {
  const element = { height, getBoundingClientRect: () => ({ height: element.height }) };
  return element as unknown as Element & { height: number };
}

/** Корень с инлайн-стилем — единственное, что модуль у него трогает. */
function root(): HTMLElement & { properties: Map<string, string> } {
  const properties = new Map<string, string>();
  const element = {
    properties,
    style: {
      setProperty: (name: string, value: string) => { properties.set(name, value); },
      removeProperty: (name: string) => { properties.delete(name); },
    },
  };
  return element as unknown as HTMLElement & { properties: Map<string, string> };
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
});

describe("место под навигацию и шапку снимается с разметки", () => {
  it("пишет настоящие высоты сразу и переписывает их, когда панель меняет размер", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const shell = root();
    const header = block(79);
    const nav = block(150);

    const release = observeLayoutSpace(shell, header, nav);

    // Первый кадр — до того, как наблюдатель успеет сообщить о размере.
    expect(shell.properties.get(NAV_SPACE_PROPERTY)).toBe("150px");
    expect(shell.properties.get(HEADER_SPACE_PROPERTY)).toBe("79px");
    const [observer] = FakeResizeObserver.instances;
    expect(observer?.observed).toEqual([header, nav]);

    // Подписи перенеслись на четвёртую строку — панель выросла, токен обязан вырасти с ней.
    nav.height = 188;
    header.height = 56;
    observer?.fire();
    expect(shell.properties.get(NAV_SPACE_PROPERTY)).toBe("188px");
    expect(shell.properties.get(HEADER_SPACE_PROPERTY)).toBe("56px");

    release();
    expect(observer?.disconnected).toBe(true);
    expect(shell.properties.size).toBe(0);
  });

  it("без наблюдателя всё равно ставит первый кадр и снимает токены при отписке", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const shell = root();

    const release = observeLayoutSpace(shell, block(56), block(56));
    expect(shell.properties.get(NAV_SPACE_PROPERTY)).toBe("56px");
    expect(shell.properties.get(HEADER_SPACE_PROPERTY)).toBe("56px");

    release();
    expect(shell.properties.size).toBe(0);
  });

  it("подключено к оболочке: шапка и навигация измеряются, пока оболочка на экране", () => {
    expect(appSource).toContain("observeLayoutSpace(document.documentElement, header, nav)");
    expect(appSource).toMatch(/<header ref=\{headerRef\} className="app-header"/u);
    expect(appSource).toMatch(/<nav ref=\{navRef\} className="bottom-nav"/u);
    // Первый кадр обязан стоять на настоящей панели, поэтому эффект — до отрисовки.
    expect(appSource).toMatch(/useLayoutEffect\(\(\) => \{\s*const header = headerRef\.current;/u);
  });
});

describe("таблица стилей считает от измеренного места, а не от числа", () => {
  it("объявляет токены места с проектными значениями на первый кадр", () => {
    expect(token("--nav-height")).toBe("56px");
    expect(token("--nav-space")).toBe("calc(var(--nav-height) + env(safe-area-inset-bottom))");
    expect(token("--header-space")).toBe("calc(56px + env(safe-area-inset-top))");
  });

  it("ставит оболочку, полосу записи и тост на измеренную навигацию", () => {
    // Дефект: полоса стояла на `--nav-height`, панель при ×2.7 занимала 150–188 pt вместо 56,
    // и кнопка «Записать покупку» оказывалась под навигацией — в режиме для плохо видящих.
    const shell = rulesFor(".app-shell").flatMap((rule) => rule.declarations);
    expect(shell).toContain("padding-bottom: calc(var(--nav-space) + 24px)");

    const bar = rulesFor(".record-action").flatMap((rule) => rule.declarations);
    expect(bar).toContain("bottom: var(--nav-space)");

    const toast = rulesFor(".update-toast").flatMap((rule) => rule.declarations);
    expect(toast).toContain("bottom: calc(var(--nav-space) + 28px)");
  });

  it("на широком экране ставит навигацию под измеренную шапку", () => {
    // При ×2.7 шапка — 79 pt, а навигация липла на 56: верх вкладок был под шапкой.
    const nav = rulesFor(".bottom-nav").flatMap((rule) => rule.declarations);
    expect(nav).toContain("top: var(--header-space)");
    expect(nav.some((declaration) => /^top: calc\(56px/u.test(declaration))).toBe(false);
  });

  it("не даёт измерению кормить само себя: панель и шапка токены места не читают", () => {
    for (const rule of rulesFor(".bottom-nav")) {
      for (const declaration of rule.declarations) {
        expect(declaration, `.bottom-nav читает --nav-space: ${declaration}`).not.toContain("--nav-space");
      }
    }
    for (const rule of rulesFor(".app-header")) {
      for (const declaration of rule.declarations) {
        expect(declaration, `.app-header читает --header-space: ${declaration}`).not.toContain("--header-space");
      }
    }
  });

  it("от проектной высоты считает только сама панель — и токен места на первый кадр", () => {
    // Всякий другой потребитель `--nav-height` — это возврат дефекта: он снова стоял бы на числе.
    const consumers = cssRules(withoutComments)
      .filter((rule) => rule.declarations.some((declaration) => declaration.includes("var(--nav-height)")))
      .map((rule) => rule.selectors.join(", "));
    // Множество, а не список: порядок правил в таблице смысла не несёт.
    expect(new Set(consumers)).toEqual(new Set([":root", ".bottom-nav"]));
  });

  it("на коротком экране при крупном шрифте полоса записи встаёт в поток", () => {
    // 320×568 при ×2.7: шапка 79 + полоса 178 + навигация 188 = 445 из 568 — под прилипшей
    // полосой не поместился бы ни один конверт. Высота экрана считается в кеглях, как ширина в §5.
    const short = styles.match(/@media \(max-width: 18em\) and \(max-height: 16em\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
    expect(short).toContain(".record-action { position: static; }");
  });
});
