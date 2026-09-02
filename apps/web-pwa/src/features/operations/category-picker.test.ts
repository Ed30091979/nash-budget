import {
  CATEGORY_GROUPS,
  makeDefaultCategories,
  type Category,
} from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import {
  categoryNameOutcome,
  categoryPickerView,
  categorySuggestions,
  CUSTOM_CATEGORY_VALUE,
  groupChoicesFor,
  groupedCategoryOptions,
  matchesCategoryQuery,
} from "./category-picker";

function idFactory(): () => string {
  let counter = 1;
  return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`;
}

function defaults(): { readonly categories: readonly Category[] } {
  return { categories: makeDefaultCategories(idFactory()) };
}

function withArchived(name: string, type: "expense" | "income" = "expense") {
  const base = defaults();
  return {
    categories: [
      ...base.categories,
      {
        id: "99999999-9999-4999-8999-999999999999",
        name,
        type,
        group: type === "income" ? "income" : "personal",
        active: false,
        sortOrder: 900,
      } satisfies Category,
    ],
  };
}

describe("выбор категории", () => {
  it("раскладывает категории по группам домена в порядке групп", () => {
    const groups = groupedCategoryOptions(defaults(), "expense");

    expect(groups.map((group) => group.title)).toEqual([
      "Обязательные платежи",
      "Каждый день",
      "Личное и досуг",
      "Прочее",
    ]);
    expect(groups[0]?.options.map((option) => option.name)).toEqual([
      "Жильё", "ЖКХ", "Связь и подписки", "Кредиты и рассрочки",
    ]);
    expect(groups.flatMap((group) => group.options)).toHaveLength(15);
    // Порядок групп — из закрытого перечня домена, а не из порядка появления категорий.
    expect(groups.map((group) => group.key)).toEqual(
      CATEGORY_GROUPS.filter((group) => group.type === "expense").map((group) => group.key),
    );
  });

  it("держит доходные и расходные категории раздельно", () => {
    expect(groupedCategoryOptions(defaults(), "income").map((group) => group.title)).toEqual(["Доходы"]);
    expect(groupedCategoryOptions(defaults(), "income").flatMap((group) => group.options)).toHaveLength(8);
  });

  it("ищет подстрокой, без регистра и без учёта совместимых форм", () => {
    expect(matchesCategoryQuery("Здоровье и аптека", "аптек")).toBe(true);
    expect(matchesCategoryQuery("Такси", "ТАКСИ")).toBe(true);
    expect(matchesCategoryQuery("Такси", "ＴＡＫ")).toBe(false);
    expect(matchesCategoryQuery("Продукты", "  ")).toBe(true);
    expect(matchesCategoryQuery("Продукты", "транспорт")).toBe(false);

    const view = categoryPickerView(defaults(), "expense", "дет");
    expect(view.groups.flatMap((group) => group.options).map((option) => option.name)).toEqual(["Дети"]);
    expect(view.status).toBe("Найдена 1 категория");
    expect(view.empty).toBe(false);
    expect(view.createLabel).toBe("Своя категория");
  });

  it("склоняет счётчик найденного по-русски", () => {
    expect(categoryPickerView(defaults(), "expense", "и").status).toBe("Найдено 11 категорий");
    expect(categoryPickerView(defaults(), "expense", "дом").status).toBe("Найдена 1 категория");
    expect(categoryPickerView(defaults(), "expense", "под").status).toBe("Найдено 2 категории");
  });

  it("без совпадений оставляет единственным результатом создание набранного", () => {
    const view = categoryPickerView(defaults(), "expense", "  Каршеринг  ");

    expect(view.empty).toBe(true);
    expect(view.groups).toEqual([]);
    expect(view.createLabel).toBe("Создать «Каршеринг»");
    expect(view.createName).toBe("Каршеринг");
    expect(view.status).toBe("Ничего не найдено. Можно создать «Каршеринг».");
  });

  it("никогда не теряет выбранную категорию — ни из-за фильтра, ни из-за архива", () => {
    const state = withArchived("Дача");
    const archivedId = "99999999-9999-4999-8999-999999999999";

    const filtered = categoryPickerView(state, "expense", "транспорт", "00000000-0000-4000-8000-000000000001");
    expect(filtered.groups.flatMap((group) => group.options).map((option) => option.name))
      .toEqual(["Жильё", "Транспорт"]);

    const archived = groupedCategoryOptions(state, "expense", "", archivedId)
      .flatMap((group) => group.options)
      .find((option) => option.id === archivedId);
    expect(archived).toEqual({ id: archivedId, name: "Дача", archived: true });
    // Без выбора архивная категория в списке не появляется.
    expect(groupedCategoryOptions(state, "expense").flatMap((group) => group.options)).toHaveLength(15);
  });

  it("значение последнего элемента не может совпасть с идентификатором категории", () => {
    expect(CUSTOM_CATEGORY_VALUE).toBe("#custom");
    expect(defaults().categories.some((item) => item.id === CUSTOM_CATEGORY_VALUE)).toBe(false);
  });

  it("предлагает выбирать группу только из перечня своего вида", () => {
    expect(groupChoicesFor("expense").map((group) => group.key))
      .toEqual(["mandatory", "everyday", "personal", "other"]);
    expect(groupChoicesFor("income")).toEqual([{ key: "income", title: "Доходы" }]);
  });
});

describe("совпадение имени новой категории", () => {
  it("предлагает вернуть тёзку из архива, а не заводить вторую", () => {
    const outcome = categoryNameOutcome(withArchived("Дача"), " дача ", "expense");

    expect(outcome.kind).toBe("restore");
    expect(outcome.kind === "restore" && outcome.category.name).toBe("Дача");
    expect(outcome.kind === "restore" && outcome.message).toContain("в архиве");
  });

  it("на активную тёзку предлагает выбрать её, а не отказывает", () => {
    const outcome = categoryNameOutcome(defaults(), "ПРОДУКТЫ", "expense");

    expect(outcome.kind).toBe("duplicate");
    expect(outcome.kind === "duplicate" && outcome.category.name).toBe("Продукты");
  });

  it("на похожую активную только подсказывает — создание остаётся возможным", () => {
    const outcome = categoryNameOutcome(defaults(), "Продукты для дачи", "expense");

    expect(outcome.kind).toBe("similar");
    expect(outcome.kind === "similar" && outcome.category.name).toBe("Продукты");
    expect(outcome.kind === "similar" && outcome.message).toContain("выберите её в списке");
  });

  it("не путает виды и не подсказывает по двум буквам", () => {
    expect(categoryNameOutcome(defaults(), "Продукты", "income").kind).toBe("free");
    expect(categoryNameOutcome(defaults(), "Ж", "expense").kind).toBe("free");
    expect(categoryNameOutcome(defaults(), "   ", "expense").kind).toBe("free");
    expect(categoryNameOutcome(defaults(), "Каршеринг", "expense").kind).toBe("free");
  });
});

describe("готовые названия", () => {
  it("берёт каталог второго эшелона без уже заведённого и сужает его набранным", () => {
    const names = categorySuggestions(defaults(), "expense").map((template) => template.name);
    expect(names).toContain("Такси");
    expect(names).toContain("Питомцы");
    expect(names).not.toContain("Продукты");

    expect(categorySuggestions(defaults(), "expense", "такс").map((item) => item.name)).toEqual(["Такси"]);
    expect(categorySuggestions(defaults(), "income", "аренд").map((item) => item.name)).toEqual(["Аренда"]);
    expect(categorySuggestions(defaults(), "expense", "каршеринг")).toEqual([]);
  });
});
