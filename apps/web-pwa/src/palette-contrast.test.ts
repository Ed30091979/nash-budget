/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * §3 `DESIGN.md`: пары контраста — договор, а не справка.
 *
 * Таблица §3 называет пару, измеренное число и порог; здесь каждая пара пересчитывается по hex из
 * `:root` таблицы стилей. Разойдутся документ и токены — упадёт проверка, а не продукт: раньше числа
 * жили в комментариях `:root`, и новый токен мог встать рядом без единого измерения.
 */
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const design = readFileSync(new URL("../../../DESIGN.md", import.meta.url), "utf8");

type Rgba = readonly [number, number, number, number];

/** Значения `:root`, которые проверка умеет прочитать: `#rrggbb`, `#rrggbbaa` и `rgb(r g b / a%)`. */
function rootColors(): ReadonlyMap<string, Rgba> {
  const root = styles.slice(styles.indexOf(":root {"), styles.indexOf("\n}", styles.indexOf(":root {")));
  const colors = new Map<string, Rgba>();
  for (const match of root.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gu)) {
    const [, name, raw] = match;
    const value = (raw ?? "").trim();
    const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/iu.exec(value);
    if (hex) {
      const digits = hex[1] ?? "";
      colors.set(name ?? "", [
        Number.parseInt(digits.slice(0, 2), 16),
        Number.parseInt(digits.slice(2, 4), 16),
        Number.parseInt(digits.slice(4, 6), 16),
        hex[2] === undefined ? 1 : Number.parseInt(hex[2], 16) / 255,
      ]);
      continue;
    }
    const rgb = /^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/u.exec(value);
    if (rgb) colors.set(name ?? "", [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4]) / 100]);
  }
  return colors;
}

const COLORS = rootColors();

function color(name: string): Rgba {
  const value = COLORS.get(name);
  expect(value, `${name} не объявлен цветом в :root`).toBeDefined();
  return value ?? [0, 0, 0, 1];
}

/** Полупрозрачный слой поверх непрозрачного фона — с округлением до 8 бит, как его рисует экран. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const alpha = top[3];
  const channel = (index: 0 | 1 | 2) => Math.round(top[index] * alpha + bottom[index] * (1 - alpha));
  return [channel(0), channel(1), channel(2), 1];
}

/** Фон ячейки: токен или «токен поверх токена». */
function background(cell: string): Rgba {
  const [top, bottom] = cell.split(" поверх ").map((part) => part.replace(/`/gu, "").trim());
  return bottom === undefined ? color(top ?? "") : over(color(top ?? ""), color(bottom));
}

function luminance([r, g, b]: Rgba): number {
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(foreground: Rgba, back: Rgba): number {
  const [light, dark] = [luminance(foreground), luminance(back)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

interface PairRow {
  readonly foreground: string;
  readonly background: string;
  readonly declared: string;
  readonly last: string;
}

/** Строки таблицы под заголовком `### {title}` раздела §3. */
function tableRows(title: string): PairRow[] {
  const start = design.indexOf(`### ${title}`);
  expect(start, `§3 потерял таблицу «${title}»`).toBeGreaterThan(-1);
  const end = design.indexOf("\n### ", start + 4);
  const section = design.slice(start, end === -1 ? undefined : end);
  return section.split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .map(([foreground = "", back = "", declared = "", last = ""]) => ({ foreground, background: back, declared, last }));
}

/** `*` — каждый тон или каждая серия; подстановка одна и та же во всех ячейках строки. */
function expand(row: PairRow): { readonly foreground: string; readonly background: string }[] {
  const pattern = /`(--[a-z-]*)\*([a-z-]*)`/u.exec(row.foreground) ?? /`(--[a-z-]*)\*([a-z-]*)`/u.exec(row.background);
  if (pattern === null) return [{ foreground: row.foreground, background: row.background }];
  const [, prefix = "", suffix = ""] = pattern;
  const family = new RegExp(`^${prefix}([a-z0-9]+)${suffix}$`, "u");
  const keys = [...COLORS.keys()].map((name) => family.exec(name)?.[1]).filter((key): key is string => key !== undefined);
  expect(keys.length, `${prefix}*${suffix}: в :root нет ни одного токена семейства`).toBeGreaterThan(1);
  return keys.map((key) => ({
    foreground: row.foreground.replaceAll("*", key),
    background: row.background.replaceAll("*", key),
  }));
}

function measured(row: PairRow): number[] {
  return expand(row).map((pair) => contrast(background(pair.foreground), background(pair.background)));
}

/** «15.57» или «14.76–15.44»: заявленное число или диапазон худшего и лучшего. */
function declaredRange(cell: string): readonly [number, number] {
  const [low, high] = cell.split("–").map(Number);
  return [low ?? Number.NaN, high ?? low ?? Number.NaN];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

describe("пары контраста §3", () => {
  const pairs = tableRows("Пары контраста");

  it("таблица на месте и называет пары всех ролей 5.0", () => {
    expect(pairs.length).toBeGreaterThan(30);
    const named = pairs.map((row) => `${row.foreground} ${row.background}`).join("\n");
    for (const token of [
      "--accent", "--on-accent", "--positive-ink", "--tile-account", "--on-tile-account", "--on-tile-account-muted",
      "--tone-*-ink", "--track", "--line", "--focus",
    ]) {
      expect(named, `§3 не называет ни одной пары с ${token}`).toContain(`\`${token}\``);
    }
  });

  it.each(tableRows("Пары контраста").map((row) => [`${row.foreground} на ${row.background}`, row] as const))(
    "%s — измерено так, как записано, и не ниже порога",
    (_label, row) => {
      const values = measured(row);
      const [low, high] = declaredRange(row.declared);
      expect(round2(Math.min(...values)), `${row.foreground} на ${row.background}: худшее`).toBeCloseTo(low, 2);
      expect(round2(Math.max(...values)), `${row.foreground} на ${row.background}: лучшее`).toBeCloseTo(high, 2);
      expect(Math.min(...values)).toBeGreaterThanOrEqual(Number(row.last));
    },
  );
});

describe("запреты §3", () => {
  it.each(tableRows("Запреты").map((row) => [`${row.foreground} на ${row.background}`, row] as const))(
    "%s — действительно ниже порога, и число записано верно",
    (_label, row) => {
      const values = measured(row);
      const [low, high] = declaredRange(row.declared);
      expect(round2(Math.min(...values))).toBeCloseTo(low, 2);
      expect(round2(Math.max(...values))).toBeCloseTo(high, 2);
      // Запрет держится, пока пара не проходит свой порог: текст — 4.5, графика — 3.
      const threshold = row.foreground === "`--accent`" ? 4.5 : 3;
      expect(Math.max(...values)).toBeLessThan(threshold);
    },
  );
});

describe("роли цвета §3", () => {
  it("каждый цвет :root назван в §3, и hex в документе тот же", () => {
    for (const [name, value] of COLORS) {
      if (name.startsWith("--shadow") || name === "--scrim") continue;
      expect(design, `${name} не описан в §3`).toContain(`\`${name}\``);
      if (value[3] === 1) {
        const hex = `#${value.slice(0, 3).map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
        expect(design, `${name}: §3 не называет ${hex}`).toContain(`\`${hex}\``);
      }
    }
  });

  it("оставляет марке её hex: значок, заставки и Android читают их из :root", () => {
    expect(COLORS.get("--canvas")).toEqual([0xf6, 0xf3, 0xee, 1]);
    expect(COLORS.get("--ink")).toEqual([0x17, 0x14, 0x10, 1]);
    expect(COLORS.get("--ink-muted")).toEqual([0x5d, 0x57, 0x4c, 1]);
    expect(COLORS.get("--border")).toEqual([0xe6, 0xe0, 0xd5, 1]);
    expect(COLORS.get("--orange")).toEqual([0xb8, 0x47, 0x1a, 1]);
  });

  it("не пускает оранжевый марки в интерфейс: «вы здесь» и действие — акцент", () => {
    const rules = styles.slice(styles.indexOf("\n}", styles.indexOf(":root {")));
    expect(rules).not.toContain("var(--orange)");
    expect(rules).toContain("var(--accent)");
  });
});
