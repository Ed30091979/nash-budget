import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BottomNav } from "./BottomNav";

describe("нижняя навигация из пяти мест", () => {
  it("«Обзор», «Операции», «+», «Отчёты», «Ещё» — в этом порядке, и «+» назван «Записать»", () => {
    const html = renderToStaticMarkup(<BottomNav route={{ name: "overview" }} onTab={vi.fn()} onAdd={vi.fn()} />);
    const names = [...html.matchAll(/<button ([^>]*)>([\s\S]*?)<\/button>/gu)]
      .map(([, attributes = "", inner = ""]) => /aria-label="([^"]+)"/u.exec(attributes)?.[1] ?? inner.replace(/<[^>]*>/gu, ""));
    expect(names).toEqual(["Обзор", "Операции", "Записать", "Отчёты", "Ещё"]);
    expect(html).toContain('<nav class="bottom-nav" aria-label="Основные разделы">');
    // Глиф «+» — декоративный: имя кнопке даёт подпись, а не рисунок.
    expect(html).toMatch(/<button class="nav-fab" type="button" aria-label="Записать"><svg[^>]*aria-hidden="true"/u);
    // «Отчёты» — кольцо, а не тренд; подпись переносится по слогам, а имя — целое слово.
    expect(html).toMatch(/aria-label="Отчёты"><span class="nav-icon"><svg[^>]*><use href="#glyph-chart-pie"><\/use><\/svg><\/span><span aria-hidden="true">От\u00adчё\u00adты<\/span>/u);
    expect([...html.matchAll(/aria-label="([^"]*)"/gu)].map((match) => match[1]).filter((name) => name?.includes("\u00ad"))).toEqual([]);
  });

  it("«вы здесь» — `aria-current` и точка у своей вкладки; подэкраны «Ещё» подсвечивают «Ещё»", () => {
    const overview = renderToStaticMarkup(<BottomNav route={{ name: "overview" }} onTab={vi.fn()} onAdd={vi.fn()} />);
    expect(overview.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(overview).toMatch(/<button class="nav-button active" type="button" aria-current="page" aria-label="Обзор">/u);
    const family = renderToStaticMarkup(<BottomNav route={{ name: "family" }} onTab={vi.fn()} onAdd={vi.fn()} />);
    expect(family).toMatch(/<button class="nav-button active" type="button" aria-current="page" aria-label="Ещё">/u);
    // Лист «+» поверх вкладки: текущая страница — «+», а вкладки ни одной.
    const entry = renderToStaticMarkup(<BottomNav route={{ name: "operations", sheet: "entry" }} onTab={vi.fn()} onAdd={vi.fn()} />);
    expect(entry).toContain('<button class="nav-fab active" type="button" aria-label="Записать" aria-current="page">');
    expect(entry).not.toContain("nav-button active");
    expect(entry.match(/aria-current="page"/gu)).toHaveLength(1);
    // Лист с плиток или правка — запись поверх своей вкладки: подсвечена она, а не «+».
    for (const route of [{ name: "overview", sheet: "entry", op: "expense" }, { name: "operations", sheet: "entry", edit: "7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b" }] as const) {
      const markup = renderToStaticMarkup(<BottomNav route={route} onTab={vi.fn()} onAdd={vi.fn()} />);
      expect(markup).toContain('<button class="nav-fab" type="button" aria-label="Записать">');
      expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
    }
    // Другой месяц «Обзора» — та же вкладка.
    expect(renderToStaticMarkup(<BottomNav route={{ name: "overview", month: "2026-08" }} onTab={vi.fn()} onAdd={vi.fn()} />)).toMatch(/<button class="nav-button active" type="button" aria-current="page" aria-label="Обзор">/u);
  });
});
