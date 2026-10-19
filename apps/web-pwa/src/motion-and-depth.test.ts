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
    // Прежде у героя «Сегодня» был свой тон тени под зелёный градиент. С 2b герой «Обзора» —
    // строка «Можно на повседневные»: плоскость белая, и вторая тень означала бы вторую ступень
    // возвышения там, где ступеней всего две.
    expect(withoutComments).not.toContain("--shadow-hero");
    const hero = withoutComments.match(/\n\.reach-line \{([^}]*)\}/u)?.[1] ?? "";
    expect(hero).toContain("background: var(--surface)");
    expect(hero).toContain("box-shadow: var(--shadow-card)");
  });
});

/**
 * §5 DESIGN.md 4.0: скругление по ролям. Радиус — токен роли, и роль видна по нему: кнопка и поле —
 * 14, пилюля — круг, плитка — 16, карточка — 20, лист — 24, подложка глифа — 10, «+» — 18. Прямой
 * угол — тоже роль. Каждый токен роли достаётся только своим элементам: скруглённая карточка,
 * которую не нажимают, или «+» с радиусом кнопки — это уже не та роль.
 *
 * Девять радиусов по месту системой не были: раз скруглено всё, скругление не различает ничего.
 */
describe("форма", () => {
  /** Метка-пилюля: её форма — часть роли «короткое слово о состоянии», а не приглашение нажать. */
  const pillLabels = new Set([".status-chip", ".network-badge", ".sync-badge", ".save-receipt-change"]);
  /** Оправа группы переключателей: сама не нажимается, но обнимает то, что нажимается. */
  const controlHousings = new Set([".segmented", '.dashboard-screen > header [role="group"]']);
  /** Токен роли → его значение по §5 и то, кому он достаётся. */
  const roles: Record<string, { readonly px: string; readonly owns: (selector: string) => boolean }> = {
    // Пилюля и оправа при системном шрифте ниже 18em выпрямляются в прямоугольник кнопки (§5).
    "--radius-control": {
      px: "14px",
      owns: (selector) => addressesTouchTarget(selector) || pillLabels.has(selector) || controlHousings.has(selector),
    },
    "--radius-input": { px: "14px", owns: (selector) => addressesTouchTarget(selector) },
    "--radius-pill": {
      px: "999px",
      owns: (selector) => addressesTouchTarget(selector) || pillLabels.has(selector) || controlHousings.has(selector),
    },
    "--radius-tile": { px: "16px", owns: (selector) => /\.(?:tile|add-tile)(?![\w-])/u.test(selector) },
    "--radius-card": { px: "20px", owns: (selector) => /\.(?:card|tile-card)(?![\w-])/u.test(selector) },
    "--radius-sheet": { px: "24px", owns: (selector) => /\.(?:sheet|sheet-frame)(?![\w-])/u.test(selector) },
    "--radius-plate": { px: "10px", owns: (selector) => /\.(?:icon-plate|tile-glyph)(?![\w-])/u.test(selector) },
    "--radius-fab": { px: "18px", owns: (selector) => /\.nav-fab(?![\w-])/u.test(selector) },
  };
  /** Поверхности 3.0, которые остаются прямыми, пока их экран не переписан (§5: роли — с компонентами). */
  const surfaces = [
    ".section-card, .entry-card", ".quick-card",
    ".save-receipt", ".sheet-card", ".confirmation-dialog", ".horizon-card",
    ".list-card", ".explain-card", ".invite-code",
    ".limit-bar", ".dialog-aside", ".month-shape, .ladder-block",
    ".pay-row", ".import-action", ".family-news",
  ];

  function radiusRules(): { selector: string; value: string }[] {
    return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].flatMap((rule) => {
      const value = (rule[2] ?? "").split(";").map((declaration) => declaration.trim())
        .find((declaration) => declaration.startsWith("border-radius:"))?.slice("border-radius:".length).trim();
      if (value === undefined) return [];
      return (rule[1] ?? "").split(",").map((selector) => ({ selector: selector.trim().replace(/\s+/gu, " "), value }));
    });
  }

  it("объявляет токены ролей с числами §5 — и документ называет те же числа", () => {
    const section = design.slice(design.indexOf("## 5. Сетка"), design.indexOf("## 6. Компоненты"));
    for (const [name, role] of Object.entries(roles)) {
      expect(token(name), `${name} в :root`).toBe(role.px);
      expect(section, `§5 не называет ${name}`).toMatch(new RegExp(`\\| \`${name}\` \\| ${Number.parseInt(role.px, 10)} \\|`, "u"));
    }
  });

  it("не знает ни одного радиуса мимо токенов ролей, прямого угла и точки", () => {
    const rules = radiusRules();
    const approved = new Set(["0", "50%", ...Object.keys(roles).map((name) => `var(${name})`)]);
    expect(rules.length).toBeGreaterThan(10);
    for (const { selector, value } of rules) {
      expect(approved, `${selector} набирает радиус по месту: ${value}`).toContain(value);
    }
  });

  it("даёт каждый токен роли только его элементам, а круг — только точке-индикатору", () => {
    for (const { selector, value } of radiusRules()) {
      if (value === "0") continue;
      if (value === "50%") {
        expect(/::(?:before|after)$/u.test(selector), `${selector}: круг 50 % — только у точки-индикатора`).toBe(true);
        continue;
      }
      const name = /^var\((--radius-[a-z]+)\)$/u.exec(value)?.[1] ?? "";
      const role = roles[name];
      expect(role, `${selector}: ${value} — не токен роли`).toBeDefined();
      const allowed = (role?.owns(selector) ?? false) || /::(?:before|after)$/u.test(selector);
      expect(allowed, `${selector} скруглён ролью ${name}, которая ему не принадлежит`).toBe(true);
    }
  });

  it("оставляет поверхности 3.0 прямыми, пока их экран не переписан", () => {
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
