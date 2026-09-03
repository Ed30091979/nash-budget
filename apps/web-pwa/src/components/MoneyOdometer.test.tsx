/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { MoneyOdometer } from "./MoneyOdometer";
import { MINUS_SIGN } from "../money";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function withReducedMotion(reduce: boolean, body: () => string): string {
  const previous = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", {
    matchMedia: (query: string) => ({ matches: reduce && query.includes("prefers-reduced-motion") }),
  });
  try {
    return body();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "window");
    else Reflect.set(globalThis, "window", previous);
  }
}

function digitsOf(markup: string): string {
  return [...markup.matchAll(/data-digit="(\d)"/gu)].map((match) => match[1]).join("");
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("одометр на денежной величине", () => {
  it("набирает каждую цифру катушкой из десяти, а не текстом", () => {
    const markup = renderToStaticMarkup(<MoneyOdometer from={1_280_000} to={1_160_000} />);

    // Пять цифр «12 800» — пять слотов, и в каждом полная катушка: иначе ехать нечему.
    expect(digitsOf(markup)).toBe("12800");
    expect(markup.match(/class="odometer-reel"/gu)).toHaveLength(5);
    expect(markup.match(/<span>0<\/span>/gu)).toHaveLength(5);
    expect(markup.match(/<span>9<\/span>/gu)).toHaveLength(5);
  });

  it("не даёт читающему с экрана слушать промежуточные цифры", () => {
    // §5 исследования, пункт 27: живая область объявляет итог, а не то, что мелькает по пути.
    // Произносимую строку ставит рядом тот, кто одометр вставил, — здесь её быть не должно.
    const markup = renderToStaticMarkup(<MoneyOdometer from={1_280_000} to={1_160_000} />);

    expect(markup).toMatch(/^<span class="money odometer" aria-hidden="true">/u);
  });

  it("начинает с прежнего значения, чтобы движение показало, что число изменилось", () => {
    const markup = withReducedMotion(false, () => renderToStaticMarkup(
      <MoneyOdometer from={1_280_000} to={1_160_000} />,
    ));

    expect(digitsOf(markup)).toBe("12800");
  });

  it("при просьбе «поменьше движения» показывает итог сразу, без кадра «до»", () => {
    const markup = withReducedMotion(true, () => renderToStaticMarkup(
      <MoneyOdometer from={1_280_000} to={1_160_000} />,
    ));

    expect(digitsOf(markup)).toBe("11600");
  });

  it("держит знак валюты отдельным приглушённым элементом, а минус — типографским", () => {
    const markup = withReducedMotion(true, () => renderToStaticMarkup(
      <MoneyOdometer from={0} to={-50_000} />,
    ));

    expect(markup).toContain(`<span class="odometer-fixed">${MINUS_SIGN}</span>`);
    expect(markup).toContain('class="money-currency odometer-fixed"');
    expect(markup).not.toContain("-500");
  });

  it("объявлен в таблице стилей всеми десятью положениями катушки и табличными цифрами", () => {
    // Инлайнового стиля здесь быть не может: CSP запрещает `style` (§11), поэтому смещение
    // задаётся `data-digit`, а положения перечислены в таблице стилей — все десять.
    for (const digit of "0123456789") {
      expect(styles, `положение цифры ${digit} не объявлено`)
        .toContain(`.odometer-slot[data-digit="${digit}"] .odometer-reel`);
    }
    expect(styles).toMatch(/\.odometer \{[^}]*font-variant-numeric: lining-nums tabular-nums/u);
    expect(styles).toMatch(/\.odometer-slot \{[^}]*width: 1ch[^}]*overflow: hidden/u);
    expect(styles).toMatch(/\.odometer-reel \{[^}]*transition: transform var\(--motion-number\) var\(--ease-enter\)/u);
  });
});
