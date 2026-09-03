/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addressesTouchTarget } from "./design-contract";

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
    // Слои полупрозрачные и мягкие: непрозрачная тень грязнит светлый фон. И тон у всех трёх
    // один — тень под белой карточкой на тёплом холсте обязана быть того же тепла, иначе она
    // читается грязью, а не глубиной. Проверяется правило, а не переписанный сюда цвет.
    const hues = new Set<string>();
    for (const layer of [near, hairline, far]) {
      const rgb = /rgb\((\d+ \d+ \d+) \/ (\d+)%\)/u.exec(layer);
      expect(rgb, `слой набран непрозрачным цветом: ${layer}`).not.toBeNull();
      expect(Number(rgb?.[2]), `слой непрозрачен: ${layer}`).toBeLessThan(20);
      hues.add(rgb?.[1] ?? "");
    }
    expect(hues.size, "слои тени набраны разными тонами").toBe(1);
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

  it("не заводит герою собственной тени: герой — карточка, и стоит он на возвышении карточки", () => {
    // Прежде у героя был свой тон тени под зелёный градиент. Градиента нет, плоскость белая,
    // и вторая тень означала бы вторую ступень возвышения там, где ступеней всего две.
    expect(withoutComments).not.toContain("--shadow-hero");
    const hero = withoutComments.match(/\.hero-card \{([^}]*)\}/u)?.[1] ?? "";
    expect(hero).toContain("background: var(--surface)");
    expect(hero).toContain("box-shadow: var(--shadow-card)");
  });
});

/**
 * §5: форма кодирует смысл. Радиус достаётся тому, что трогают пальцем, и пилюле-метке;
 * поверхности прямые. Тогда правило читается само: скруглённое нажимается, прямое читается.
 *
 * Девять радиусов системой не были: раз скруглено всё, скругление не различает ничего.
 */
describe("форма", () => {
  const approvedRadii = new Set(["0", "50%", "var(--radius-control)", "var(--radius-input)", "var(--radius-pill)"]);
  /** Метка-пилюля: её форма — часть роли «короткое слово о состоянии», а не приглашение нажать. */
  const pillLabels = new Set([".status-chip", ".network-badge", ".sync-badge", ".save-receipt-change"]);
  /** Оправа группы переключателей: сама не нажимается, но обнимает то, что нажимается. */
  const controlHousings = new Set([".segmented", '.dashboard-screen > header [role="group"]']);
  /** Поверхности, которые до этой версии были скруглены, а теперь обязаны быть прямыми. */
  const surfaces = [
    ".hero-card", ".section-card, .entry-card", ".quick-card", ".month-split", ".next-card",
    ".save-receipt", ".sheet-card", ".confirmation-dialog", ".onboarding-card", ".horizon-chart",
    ".data-management-card", ".limit-alert", ".explain-card", ".install-note", ".invite-code",
    ".limit-bar", ".dialog-aside", ".step-progress-bar",
  ];

  function radiusRules(): { selector: string; value: string }[] {
    return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].flatMap((rule) => {
      const value = (rule[2] ?? "").split(";").map((declaration) => declaration.trim())
        .find((declaration) => declaration.startsWith("border-radius:"))?.slice("border-radius:".length).trim();
      if (value === undefined) return [];
      return (rule[1] ?? "").split(",").map((selector) => ({ selector: selector.trim().replace(/\s+/gu, " "), value }));
    });
  }

  it("не знает ни одного радиуса мимо трёх утверждённых ролей", () => {
    const rules = radiusRules();
    expect(rules.length).toBeGreaterThan(10);
    for (const { selector, value } of rules) {
      expect(approvedRadii, `${selector} набирает радиус по месту: ${value}`).toContain(value);
    }
  });

  it("даёт радиус только тому, что трогают пальцем, метке-пилюле и точке-индикатору", () => {
    for (const { selector, value } of radiusRules()) {
      if (value === "0") continue;
      const allowed = addressesTouchTarget(selector)
        || pillLabels.has(selector)
        || controlHousings.has(selector)
        || /::(?:before|after)$/u.test(selector);
      expect(allowed, `${selector} скруглён, хотя его не нажимают`).toBe(true);
    }
  });

  it("оставляет поверхности прямыми: скруглённое нажимается, прямое читается", () => {
    const withRadius = new Set(radiusRules().filter(({ value }) => value !== "0").map(({ selector }) => selector));
    for (const surface of surfaces) {
      expect(withoutComments.includes(`\n${surface} {`), `правило ${surface} исчезло — контракт формы проверять не на чем`).toBe(true);
      for (const one of surface.split(",").map((part) => part.trim())) {
        expect(withRadius.has(one), `поверхность ${one} скруглена`).toBe(false);
      }
    }
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
