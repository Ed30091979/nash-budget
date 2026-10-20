import { createTag, makePlanningSeed, renameTag, TagValidationError, type BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BudgetWriteRefusal } from "../../write-refusal";
import { archivedNamesake, deleteRefusal, tagCountWords, tagErrorText, tagsView } from "./tags-model";
import { QUICK_TAGS, TagsScreen } from "./TagsScreen";

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

  it("новая метка — форма с обработчиком; список — имя, число операций и три действия у каждой", () => {
    const html = markup();
    expect(html).toContain("<h1>Метки</h1>");
    expect(html).toMatch(/<form class="tag-new manage-new-tag" noValidate=""><div class="field"><label for="tag-new-name">Новая метка<\/label>/u);
    expect(html).toContain(">Добавить</button>");
    expect(html).toMatch(/<bdi dir="auto">Отпуск<\/bdi><\/strong><small>2 операции<\/small>/u);
    for (const label of ["Переименовать метку «Отпуск»", "Убрать метку «Отпуск» в архив", "Удалить метку «Отпуск»", "Вернуть метку «Дача» из архива", "Удалить метку «Дача»"]) {
      expect(html, label).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain("Архивная метка не предлагается при записи, но остаётся на своих операциях.");
    // Без меток — пустое состояние с тем, где и как их завести (подробно — ниже, «пустое состояние»).
    const empty = renderToStaticMarkup(<TagsScreen budget={makePlanningSeed()} write={{ run: vi.fn() }} onBack={vi.fn()} />);
    expect(empty).toContain("Меток пока нет</span></h2>");
    expect(empty).toContain(">Создать метку</button>");
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
    expect(markup).toContain('<button class="icon-button" type="button" aria-label="Добавить метку">');
  });

  it("есть хоть одна метка, пусть в архиве, — прежний список и поле новой метки, без пустого состояния", () => {
    const seed = makePlanningSeed();
    const markup = renderToStaticMarkup(<TagsScreen budget={{ ...seed, tags: [{ id: DACHA, name: "Дача", active: false }] }} write={{ run: vi.fn() }} onBack={vi.fn()} />);
    expect(markup).toContain('id="tag-new-name"');
    expect(markup).not.toContain("Меток пока нет</span></h2>");
  });
});
