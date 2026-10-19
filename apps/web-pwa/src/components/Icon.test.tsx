/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, sep } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Icon, ICON_NAMES, IconSprite } from "./Icon";

function sourceFiles(): readonly string[] {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
  return walk(root).filter((path) => /\.tsx?$/u.test(path) && !/\.test\.tsx?$/u.test(path));
}

describe("иконки", () => {
  it("спрайт объявляет каждый глиф ровно один раз и ничего не тянет из сети", () => {
    const markup = renderToStaticMarkup(<IconSprite />);
    const ids = [...markup.matchAll(/<symbol id="([^"]+)"/gu)].map((match) => match[1]);

    expect(ids).toHaveLength(ICON_NAMES.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(25);
    // Набор закрытый, но не замороженный: он вырос ровно на глифы категорий (§6). Мерой
    // закрытости служит не круглое число, а то, что каждый глиф кем-то назван по имени —
    // спрайт не носит в сборке ни одной иконки, которую никто не рисует.
    const sources = sourceFiles()
      .filter((path) => !path.endsWith(`${sep}Icon.tsx`))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(ICON_NAMES.filter((name) => !sources.includes(`"${name}"`))).toEqual([]);
    // §1.5: ни одного внешнего источника — ни ссылки, ни картинки, ни шрифта.
    expect(markup).not.toMatch(/https?:\/\/(?!www\.w3\.org)/u);
    expect(markup).not.toContain("<image");
    // Цвет задаётся на месте вставки, поэтому внутри спрайта его нет.
    expect(markup).not.toMatch(/(?:fill|stroke)="(?!none)(?!currentColor)[^"]+"/u);
  });

  it("каждый глиф рисуется на канве 24×24", () => {
    const markup = renderToStaticMarkup(<IconSprite />);
    const boxes = [...markup.matchAll(/viewBox="([^"]+)"/gu)].map((match) => match[1]);
    expect(boxes).toHaveLength(ICON_NAMES.length);
    expect(new Set(boxes)).toEqual(new Set(["0 0 24 24"]));
  });

  it("иконка без подписи декоративна, иконка с подписью имеет роль и доступное имя", () => {
    const decorative = renderToStaticMarkup(<Icon name="wallet" />);
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain("role=");
    expect(decorative).toContain('href="#glyph-wallet"');

    const named = renderToStaticMarkup(<Icon name="wallet" label="Кошелёк" />);
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Кошелёк"');
    expect(named).not.toContain("aria-hidden");
  });

  it("штрих 1.75, скруглённые концы и currentColor — по §6", () => {
    const markup = renderToStaticMarkup(<Icon name="calendar-clock" size={20} />);
    expect(markup).toContain('stroke-width="1.75"');
    expect(markup).toContain('stroke-linecap="round"');
    expect(markup).toContain('stroke-linejoin="round"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('width="20"');
  });

  it("§6: в интерфейсе не осталось текстовых глифов в роли иконок", () => {
    // Эти символы работали иконками: плитки «Сегодня», строки плана, строки операций,
    // статусы лимитов, стрелки возврата, знак валюты в логотипе шапки.
    const forbidden = ["↻", "◎", "◌", "◍", "○", "✓", "←", "↔"];
    const offenders = sourceFiles().flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return forbidden.filter((glyph) => text.includes(glyph)).map((glyph) => `${path}: ${glyph}`);
    });
    expect(offenders).toEqual([]);
  });

  it("§6: знак валюты остаётся текстом только в подписях полей, а не в роли логотипа", () => {
    const offenders = sourceFiles().filter((path) => />₽</u.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
