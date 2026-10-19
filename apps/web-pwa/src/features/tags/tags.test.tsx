import { createTag, makePlanningSeed, renameTag, TagValidationError, type BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BudgetWriteRefusal } from "../../write-refusal";
import { archivedNamesake, deleteRefusal, tagCountWords, tagErrorText, tagsView } from "./tags-model";
import { QUICK_TAGS, tagRowLabel, TagsScreen } from "./TagsScreen";

const TRIP = "e2c00000-0000-4000-8000-0000000000c1";
const REPAIR = "e2c00000-0000-4000-8000-0000000000c2";
const DACHA = "e2c00000-0000-4000-8000-0000000000c3";
const SPARE = "e2c00000-0000-4000-8000-0000000000c4";

function state(): BudgetState {
  const seed = makePlanningSeed();
  const [first, second] = seed.transactions;
  return {
    ...seed,
    tags: [
      { id: TRIP, name: "Отпуск", active: true },
      { id: REPAIR, name: "Ремонт", active: true },
      { id: DACHA, name: "Дача", active: false },
      { id: SPARE, name: "Арбуз", active: true },
    ],
    transactions: seed.transactions.map((transaction) => (
      transaction === first ? { ...transaction, tagIds: [TRIP] }
        : transaction === second ? { ...transaction, tagIds: [REPAIR, TRIP].sort() }
          : transaction
    )),
  };
}

describe("метки: модель", () => {
  it("активные и архивные — по алфавиту, у каждой — число операций", () => {
    const view = tagsView(state());
    expect(view.active.map((row) => [row.tag.name, row.count])).toEqual([["Арбуз", 0], ["Отпуск", 2], ["Ремонт", 1]]);
    expect(view.archived.map((row) => [row.tag.name, row.count])).toEqual([["Дача", 0]]);
    expect(tagsView(makePlanningSeed())).toEqual({ active: [], archived: [] });
  });

  it("число словами — через счётные формы", () => {
    expect([0, 1, 2, 5, 11, 21, 104].map(tagCountWords)).toEqual([
      "ни одной операции", "1 операция", "2 операции", "5 операций", "11 операций", "21 операция", "104 операции",
    ]);
  });

  it("удалить можно только неиспользуемую: на операциях — отказ словами домена до вопроса", () => {
    const budget = state();
    expect(deleteRefusal(budget, TRIP)).toBe("Метка стоит на операциях. Её можно убрать в архив: на операциях она останется.");
    expect(deleteRefusal(budget, SPARE)).toBeNull();
    expect(deleteRefusal(budget, DACHA)).toBeNull();
    expect(deleteRefusal(budget, "e2c00000-0000-4000-8000-0000000000ff")).toBe("Метка не найдена.");
  });

  it("архивная тёзка предлагается к возврату, пока активной тёзки нет", () => {
    const budget = state();
    expect(archivedNamesake(budget, "  дача ")?.id).toBe(DACHA);
    expect(archivedNamesake(budget, "Отпуск")).toBeNull();
    expect(archivedNamesake(budget, "")).toBeNull();
    const twin = createTag(budget, "Дача", () => "e2c00000-0000-4000-8000-0000000000c5").state;
    expect(archivedNamesake(twin, "Дача")).toBeNull();
  });

  it("переименование не трогает ни одной операции; отказы — словами домена, задержка — своими", () => {
    const budget = state();
    const renamed = renameTag(budget, TRIP, "Отпуск 2026");
    expect(renamed.transactions).toBe(budget.transactions);
    expect(renamed.tags?.find((tag) => tag.id === TRIP)?.name).toBe("Отпуск 2026");
    let refusal = "";
    try {
      renameTag(budget, TRIP, "ремонт");
    } catch (error) {
      refusal = tagErrorText(error);
    }
    expect(refusal).toBe("Активная метка с таким названием уже существует.");
    expect(tagErrorText(new TagValidationError("name_required", "name", "x"))).toBe("x");
    expect(tagErrorText(new BudgetWriteRefusal("held"))).toBe(new BudgetWriteRefusal("held").userMessage);
  });
});

describe("метки: разметка", () => {
  const markup = () => renderToStaticMarkup(<TagsScreen budget={state()} write={{ run: vi.fn() }} onBack={vi.fn()} />);

  it("список (5.0): «#», имя, число операций и шеврон; строка — одна цель «Изменить»; архив ниже; поля на экране нет", () => {
    const hyphenated = markup();
    expect(hyphenated).toMatch(/<span class="dir-copy" aria-hidden="true"><strong><bdi dir="auto">От\u00ad?пуск<\/bdi>/u);
    const html = hyphenated.replace(/\u00ad/gu, "");
    expect(html).toContain("<h1>Метки</h1>");
    // Новая метка — листом по «+», а не полем над списком.
    expect(html).toContain('<button id="tags-add" class="icon-button" type="button" aria-label="Новая метка">');
    expect(html).not.toContain('id="tag-new-name"');
    expect(html).not.toContain("<form");
    // Абзаца-пояснения под строкой заголовка нет (R3, п. 1).
    expect(html).not.toContain("manage-head");
    expect(html).toMatch(/<ul class="card dir-card"><li><button id="tag-row-[^"]+" class="dir-row" type="button" aria-label="Арбуз: ни одной операции\. Изменить">/u);
    expect(html).toMatch(/<span class="icon-plate dir-plate tone-peach" aria-hidden="true">[^]*?glyph-hash[^]*?<bdi dir="auto">Отпуск<\/bdi><\/strong><small>2 операции<\/small>/u);
    expect(html).toContain('href="#glyph-chevron-right"');
    expect(html).toContain('<h2 id="tags-archived-title" class="dir-kicker">В архиве</h2>');
    expect(html).toContain('aria-label="Дача: ни одной операции. Изменить"');
    // Три действия у каждой строки ушли в лист метки: в списке их нет.
    expect(html).not.toContain("Переименовать метку");
    expect(html).not.toContain("Удалить метку");
    expect(tagRowLabel({ tag: { id: TRIP, name: "Отпуск", active: true }, count: 12 })).toBe("Отпуск: 12 операций. Изменить");
  });
});

describe("метки: пустое состояние (дизайн v5, 14)", () => {
  it("меток нет — иллюстрация, «Меток пока нет», одна строка, «Создать метку» и быстрые метки; поля пока нет", () => {
    const markup = renderToStaticMarkup(<TagsScreen budget={makePlanningSeed()} write={{ run: vi.fn() }} onBack={vi.fn()} />);
    expect(markup).toMatch(/<div class="empty-art" aria-hidden="true"><svg [^>]*aria-hidden="true"/u);
    expect(markup).toContain('<span class="sr-only">Меток пока нет</span></h2>');
    expect(markup).toContain('<span class="sr-only">Метка собирает траты из разных категорий: например, всё на дачу или на отпуск.</span>');
    expect(markup).toContain('<button id="tags-create" class="primary-button wide empty-action" type="button">Создать метку</button>');
    expect(markup).toContain(">Или одним касанием:</p>");
    for (const label of QUICK_TAGS) expect(markup).toContain(`aria-label="Создать метку «${label}»"`);
    expect(QUICK_TAGS).toEqual(["отпуск", "дача", "ремонт", "подарки"]);
    expect(markup).not.toContain('id="tag-new-name"');
    // Строка заголовка — «‹ Ещё · Метки · +»: единственный `h1` и «+» с именем словами (макет 14).
    expect(markup.match(/<h1/gu)).toHaveLength(1);
    expect(markup).toContain('<button id="tags-add" class="icon-button" type="button" aria-label="Новая метка">');
  });

  it("есть хоть одна метка, пусть в архиве, — список, без пустого состояния", () => {
    const seed = makePlanningSeed();
    const markup = renderToStaticMarkup(<TagsScreen budget={{ ...seed, tags: [{ id: DACHA, name: "Дача", active: false }] }} write={{ run: vi.fn() }} onBack={vi.fn()} />);
    expect(markup).not.toContain("Меток пока нет</span></h2>");
    expect(markup).toContain("Активных меток нет.");
    expect(markup).toContain('aria-label="Дача: ни одной операции. Изменить"');
  });
});
