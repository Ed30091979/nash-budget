import { makePlanningSeed, type BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PLACEHOLDER_NOTE, PLACEHOLDER_WORDS, PlaceholderScreen, placeholderItems } from "../features/placeholders/PlaceholderScreen";
import { EmptyState } from "./EmptyState";
import { GoalsIllustration } from "./illustrations/GoalsIllustration";

describe("пустое состояние одной анатомии (DIRECTION §c)", () => {
  it("иллюстрация скрыта от читающих с экрана, название — h2, одна строка, одна кнопка, быстрые шаблоны", () => {
    const onClick = vi.fn();
    const markup = renderToStaticMarkup(
      <EmptyState
        illustration={<GoalsIllustration />}
        title="Целей пока нет"
        text="Покажем, сколько откладывать в месяц."
        action={{ label: "Поставить цель", onClick }}
        quick={{ label: "Или начните с готовой:", items: [{ key: "a", label: "Отпуск", onClick }] }}
      />,
    );
    expect(markup).toMatch(/^<section class="empty-state" aria-labelledby="[^"]+-title"><div class="empty-art" aria-hidden="true"><svg viewBox="0 0 200 160"[^>]*aria-hidden="true"/u);
    expect(markup.match(/<h2 /gu)).toHaveLength(1);
    expect(markup.match(/class="primary-button wide empty-action"/gu)).toHaveLength(1);
    expect(markup).toContain('<ul class="chip-row"');
    expect(markup).toContain('<bdi dir="auto">Отпуск</bdi>');
    expect(markup).not.toMatch(/\sstyle=|https?:/u);
  });

  it("без иллюстрации — глиф на подложке; без действия — без кнопки, а строка о разделе тише основной", () => {
    const markup = renderToStaticMarkup(<EmptyState glyph="calendar-clock" title="Регулярных пока нет" text="Строка." note="Раздел появится позже." />);
    expect(markup).toContain('<span class="icon-plate empty-glyph">');
    expect(markup).not.toContain("<button");
    expect(markup).toContain('<p class="empty-note">Раздел появится позже.</p>');
  });
});

describe("заглушки 2e: «Долги», «Цели», «Регулярные»", () => {
  const render = (budget: BudgetState, kind: "debts" | "goals" | "recurring") =>
    renderToStaticMarkup(<PlaceholderScreen budget={budget} kind={kind} onBack={vi.fn()} />);

  it("пусто — название состояния и строка из таблицы текстов, без кнопки-пустышки, с честной строкой о разделе", () => {
    const seed = { ...makePlanningSeed(), goals: [] };
    for (const kind of ["debts", "goals", "recurring"] as const) {
      const markup = render(seed, kind);
      expect(markup, kind).toContain(`<h1>${PLACEHOLDER_WORDS[kind].title}</h1>`);
      expect(markup, kind).toContain(`<span class="sr-only">${PLACEHOLDER_WORDS[kind].empty.title}</span></h2>`);
      expect(markup, kind).toContain(PLACEHOLDER_NOTE);
      expect(markup, kind).not.toContain("empty-action");
    }
    expect(PLACEHOLDER_WORDS.goals.empty.title).toBe("Целей пока нет");
    expect(PLACEHOLDER_WORDS.debts.empty.title).toBe("Долгов нет");
    expect(PLACEHOLDER_WORDS.recurring.empty.title).toBe("Регулярных пока нет");
    expect(render(seed, "goals")).toMatch(/<div class="empty-art" aria-hidden="true"><svg /u);
  });

  it("что уже есть в бюджете — названо по имени, а не спрятано за «пока нет»", () => {
    const seed = makePlanningSeed();
    expect(placeholderItems(seed, "goals").map((item) => item.name)).toEqual(["Финансовая подушка"]);
    const markup = render(seed, "goals");
    expect(markup).toContain("<span class=\"sr-only\">В плане 1 цель</span></h2>");
    expect(markup).toContain('<ul class="placeholder-list"><li><bdi dir="auto">Финансовая подушка</bdi></li></ul>');
  });
});
