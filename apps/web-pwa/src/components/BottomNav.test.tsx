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
  });

  it("«вы здесь» — `aria-current` и точка у своей вкладки; подэкраны «Ещё» подсвечивают «Ещё»", () => {
    const overview = renderToStaticMarkup(<BottomNav route={{ name: "overview" }} onTab={vi.fn()} onAdd={vi.fn()} />);
    expect(overview.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(overview).toMatch(/<button class="nav-button active" type="button" aria-current="page">[\s\S]*?Обзор/u);
    const family = renderToStaticMarkup(<BottomNav route={{ name: "family" }} onTab={vi.fn()} onAdd={vi.fn()} />);
    expect(family).toMatch(/<button class="nav-button active" type="button" aria-current="page">[\s\S]*?Ещё/u);
    // На записи «+» — текущая страница, а вкладки ни одной.
    const entry = renderToStaticMarkup(<BottomNav route={{ name: "entry" }} onTab={vi.fn()} onAdd={vi.fn()} />);
    expect(entry).toContain('<button class="nav-fab active" type="button" aria-label="Записать" aria-current="page">');
    expect(entry).not.toContain("nav-button active");
  });
});
