/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LargeTitle } from "./LargeTitle";
import { TitleBar, TitleBarAction } from "./TitleBar";

function accessibleName(markup: string): string {
  return markup.replace(/<[^>]*>/gu, "").trim();
}

function backButton(markup: string): string {
  return /<button class="title-bar-back"[^>]*>[\s\S]*?<\/button>/u.exec(markup)?.[0] ?? "";
}

describe("строка заголовка подэкрана", () => {
  it("«назад» — кнопка; видимое слово — родитель, а имя на слух — «Назад: Ещё»", () => {
    const markup = renderToStaticMarkup(<TitleBar back={{ label: "Ещё", onClick: vi.fn() }} title="Счета" />);
    const back = backButton(markup);

    expect(back).toMatch(/^<button class="title-bar-back" type="button">/u);
    // Видимое слово стоит в имени целиком (WCAG 2.5.3); от вкладки «Ещё» кнопка отличается на слух.
    expect(accessibleName(back)).toBe("Назад: Ещё");
    expect(back).toContain('<span class="visually-hidden">Назад: </span>Ещё');
    expect(back).not.toContain("aria-label");
  });

  it("шеврон — украшение и скрыт от читающих с экрана; текстовых стрелок нет", () => {
    const back = backButton(renderToStaticMarkup(<TitleBar back={{ label: "Счета", onClick: vi.fn() }} title="Новый счёт" />));

    expect(back).toContain('href="#glyph-chevron-left"');
    expect(back).toMatch(/<svg[^>]*aria-hidden="true"/u);
    expect(back).not.toMatch(/[←‹<]\s*Счета/u);
  });

  it("заголовок — единственный `h1` строки, а действие справа — иконка с именем словами", () => {
    const markup = renderToStaticMarkup(
      <TitleBar back={{ label: "Ещё", onClick: vi.fn() }} title="Счета" action={<TitleBarAction icon="plus" label="Новый счёт" onClick={vi.fn()} />} />,
    );

    expect(markup.match(/<h1/gu)).toHaveLength(1);
    expect(markup).toContain("<h1>Счета</h1>");
    expect(markup).toMatch(/<div class="title-bar-action"><button class="icon-button" type="button" aria-label="Новый счёт"><svg[^>]*aria-hidden="true"/u);
    // Без действия место справа остаётся: заголовок стоит между «назад» и пустой колонкой.
    expect(renderToStaticMarkup(<TitleBar back={{ label: "Ещё", onClick: vi.fn() }} title="Метки" />)).toContain('<div class="title-bar-action"></div>');
  });

  it("«назад» к шагу экрана называется своим словом; заголовок, на который экран сам ставит фокус, — с `tabindex=-1`", () => {
    const markup = renderToStaticMarkup(
      <TitleBar back={{ label: "Другой файл", name: "Другой файл", onClick: vi.fn() }} title="Разобрано: 3 операции" titleId="import-title" titleFocusable />,
    );

    expect(backButton(markup)).toMatch(/^<button class="title-bar-back" type="button" aria-label="Другой файл">/u);
    expect(markup).toContain('<h1 id="import-title" tabindex="-1">Разобрано: 3 операции</h1>');
  });

  it("цели строки — по 48, и при крупном шрифте заголовок встаёт под «назад» во всю ширину", () => {
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(styles).toMatch(/button\.title-bar-back \{[^}]*min-height: 48px/u);
    expect(styles).toMatch(/button\.icon-button \{[^}]*width: 48px; height: 48px/u);
    expect(styles).toMatch(/\.title-bar \{[^}]*min-height: var\(--titlebar-height\)/u);
    expect(styles).toMatch(/@media \(max-width: 18em\) \{\s*\.title-bar \{[^}]*\}\s*\.title-bar h1 \{ grid-column: 1 \/ -1; grid-row: 2;/u);
  });
});

describe("крупный заголовок вкладки", () => {
  it("`h1` слева и одно действие справа", () => {
    const markup = renderToStaticMarkup(<LargeTitle id="tab-title" title="Операции" />);
    expect(markup).toBe('<header class="large-title"><h1 id="tab-title">Операции</h1></header>');
  });
});
