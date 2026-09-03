/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const design = readFileSync(new URL("../../../DESIGN.md", import.meta.url), "utf8");
const withoutComments = styles.replace(/\/\*[\s\S]*?\*\//gu, "");

/** Значение токена из `:root`. */
function token(name: string): string {
  const value = withoutComments.match(new RegExp(`\\n\\s*${name}:\\s*([^;]+);`, "u"))?.[1];
  expect(value, `токен ${name} не объявлен`).toBeDefined();
  return (value ?? "").trim();
}

describe("токены движения", () => {
  it("берёт длительности и кривые Material 3 как есть (§5 исследования)", () => {
    expect(token("--motion-press")).toBe("100ms");
    expect(token("--motion-screen")).toBe("200ms");
    expect(token("--motion-number")).toBe("250ms");
    expect(token("--motion-surface")).toBe("300ms");
    expect(token("--ease-enter")).toBe("cubic-bezier(0.05, 0.7, 0.1, 1)");
    expect(token("--ease-exit")).toBe("cubic-bezier(0.3, 0, 0.8, 0.15)");
    expect(token("--ease-standard")).toBe("cubic-bezier(0.2, 0, 0, 1)");
  });

  it("не оставляет ни одной длительности, набранной по месту", () => {
    // Числа живут в токенах и в `DESIGN.md`; переписанное по месту число рано или поздно
    // разойдётся с документом — ровно так же, как это уже случилось с целями нажатия.
    const declarations = [...withoutComments.matchAll(/(?:transition|animation)(?:-duration)?:\s*([^;]+);/gu)]
      .map((match) => (match[1] ?? "").trim())
      .filter((value) => value !== "none !important");

    expect(declarations.length).toBeGreaterThan(0);
    for (const value of declarations) {
      expect(value, `длительность набрана по месту: ${value}`).not.toMatch(/\d+m?s/u);
    }
  });

  it("выключает движение полностью, а не ослабляет его до сотых миллисекунды", () => {
    const reduced = styles.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";

    expect(reduced).toContain("transition: none !important");
    expect(reduced).toContain("animation: none !important");
    expect(reduced).not.toMatch(/\.01ms/u);
  });

  it("не пружинит цветом и прозрачностью: у слоя эффектов демпфирование 1.0", () => {
    // Пружины expressive не наш тон, а цвет и прозрачность не пружинят ни в какой схеме.
    // Переход шапки — единственное место, где меняется цвет, и он идёт общей кривой.
    const header = withoutComments.match(/\.app-header \{([^}]*)\}/u)?.[1] ?? "";

    expect(header).toContain("background: transparent");
    expect(header).toContain("border-bottom: 1px solid transparent");
    // Уход — accelerate, появление — decelerate и быстрее: пока фон полупрозрачен, под шапкой
    // просвечивает содержимое, и читаться она в это время не может.
    expect(header).toMatch(/transition: background-color var\(--motion-screen\) var\(--ease-exit\)/u);
    const scrolled = withoutComments.match(/\.app-header\[data-scrolled\] \{([^}]*)\}/u)?.[1] ?? "";
    expect(scrolled).toContain("background: var(--surface)");
    expect(scrolled).toContain("border-bottom-color: var(--border)");
    expect(scrolled).toContain("transition-duration: var(--motion-press)");
    expect(scrolled).toContain("transition-timing-function: var(--ease-enter)");
  });
});

describe("глубина", () => {
  it("строит тень накопительным стеком слоёв: ступень добавляет слой, а не заменяет его", () => {
    const near = token("--shadow-layer-near");
    const hairline = token("--shadow-layer-hairline");
    const far = token("--shadow-layer-far");

    expect(token("--elevation-1")).toBe("var(--shadow-layer-near), var(--shadow-layer-hairline)");
    expect(token("--elevation-3"))
      .toBe("var(--shadow-layer-far), var(--shadow-layer-near), var(--shadow-layer-hairline)");
    // Слои полупрозрачные и мягкие: непрозрачная тень грязнит светлый мятный фон.
    for (const layer of [near, hairline, far]) expect(layer).toMatch(/rgb\(16 40 30 \/ \d+%\)/u);
  });

  it("держит ровно две ступени возвышения: карточка — 1, всплывающий слой — 3", () => {
    expect(token("--shadow-card")).toBe("var(--elevation-1)");
    expect(token("--shadow-sheet")).toBe("var(--elevation-3)");
    expect(withoutComments).not.toMatch(/--elevation-(?:0|2|[4-9]|1\d)/u);

    for (const selector of [".sheet-card", ".confirmation-dialog"]) {
      const rule = withoutComments.match(new RegExp(`\\${selector} \\{([^}]*)\\}`, "u"))?.[1] ?? "";
      expect(rule, `${selector} обязан стоять на возвышении листа`).toContain("box-shadow: var(--shadow-sheet)");
    }
  });

  it("даёт герою ту же геометрию тени, что и карточке, — своё у него только тон", () => {
    const hero = token("--shadow-hero");
    const card = token("--shadow-layer-near");

    expect(hero).toContain(card.replace(/rgb\([^)]*\)/u, "").trim().split(" ").slice(0, 3).join(" "));
    expect(hero).toMatch(/rgb\(46 125 91 \/ \d+%\)/u);
    expect(hero.split(",")).toHaveLength(2);
  });
});

describe("концентричные углы", () => {
  it("считает вложенный радиус как внешний минус отступ, а не назначает его на глаз", () => {
    const outer = token("--radius-section");
    const card = withoutComments.match(/\.section-card, \.entry-card \{([^}]*)\}/u)?.[1] ?? "";
    const padding = card.match(/padding:\s*(\d+)px/u)?.[1];

    expect(padding, "карточка секции обязана называть свой отступ одним числом").toBeDefined();
    expect(token("--radius-nested"))
      .toBe(`${Number.parseInt(outer, 10) - Number.parseInt(padding ?? "0", 10)}px`);
  });

  it("применяет вложенный радиус к поверхностям внутри карточки, а не к элементам управления", () => {
    expect(withoutComments)
      .toMatch(/\.section-card \.limit-alert[^{]*\{[^}]*border-radius: var\(--radius-nested\)/u);
    expect(withoutComments)
      .toMatch(/\.save-receipt \{[^}]*border-radius: var\(--radius-nested\)/u);
    // У кнопок и полей свой радиус: правило про поверхности, а не про всё подряд.
    expect(withoutComments)
      .toMatch(/\.primary-button, \.secondary-button \{[^}]*border-radius: var\(--radius-control\)/u);
  });
});

describe("документ дизайна", () => {
  it("называет те же числа движения, что и таблица стилей", () => {
    // §11: норматив живёт в документе. Если он разойдётся с токенами, разойдётся и продукт.
    for (const value of ["100", "200", "250", "300"]) {
      expect(design, `§10 не называет длительность ${value} мс`).toMatch(new RegExp(`${value} мс`, "u"));
    }
    for (const curve of ["cubic-bezier(0.05, 0.7, 0.1, 1)", "cubic-bezier(0.3, 0, 0.8, 0.15)", "cubic-bezier(0.2, 0, 0, 1)"]) {
      expect(design, `§10 не называет кривую ${curve}`).toContain(curve);
    }
  });
});
