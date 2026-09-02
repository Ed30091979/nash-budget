import { describe, expect, it } from "vitest";
import { G000, G002, toDomainBudgetState } from "@family-budget/test-fixtures";

import {
  calculateAnnualPlan,
  calculateBudget,
  CATEGORY_GROUPS,
  CATEGORY_SUGGESTIONS,
  categoryGroupDefinition,
  CategoryValidationError,
  createCategory,
  DEFAULT_CATEGORIES,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
  findCategoryByName,
  isCategoryGroup,
  makeDefaultCategories,
  makeSeedBudget,
  resolveCategoryGroup,
  SEED_IDS,
  suggestedCategories,
  type BudgetState,
  type CategoryGroup,
  type CategoryId,
} from "../src/index.js";

function sequentialIds(prefix = "cat"): () => CategoryId {
  let next = 0;
  return () => `${prefix}-${(next += 1)}`;
}

/** Round-trips through JSON the way a restored backup file does. */
function throughBackup(state: BudgetState): BudgetState {
  return JSON.parse(JSON.stringify(state)) as BudgetState;
}

describe("category groups", () => {
  it("is a closed set of four expense groups and one income group, in display order", () => {
    expect(CATEGORY_GROUPS.map((group) => group.key)).toEqual([
      "mandatory",
      "everyday",
      "personal",
      "other",
      "income",
    ]);
    expect(CATEGORY_GROUPS.filter((group) => group.type === "expense")).toHaveLength(4);
    expect(CATEGORY_GROUPS.filter((group) => group.type === "income")).toHaveLength(1);
    expect(CATEGORY_GROUPS.map((group) => group.order)).toEqual([...CATEGORY_GROUPS]
      .map((group) => group.order)
      .sort((left, right) => left - right));
    expect(CATEGORY_GROUPS.map((group) => group.title)).toEqual([
      "Обязательные платежи",
      "Каждый день",
      "Личное и досуг",
      "Прочее",
      "Доходы",
    ]);
    expect(isCategoryGroup("Повседневные")).toBe(false);
    expect(categoryGroupDefinition("everyday").title).toBe("Каждый день");
  });

  it("resolves the free-form labels of older documents instead of losing the category", () => {
    expect(resolveCategoryGroup({ type: "expense", group: "Обязательные расходы" })).toBe("mandatory");
    expect(resolveCategoryGroup({ type: "expense", group: "Повседневные" })).toBe("everyday");
    expect(resolveCategoryGroup({ type: "expense", group: "Семья" })).toBe("everyday");
    expect(resolveCategoryGroup({ type: "expense", group: "everyday" })).toBe("everyday");
    expect(resolveCategoryGroup({ type: "expense", group: "что-то своё" })).toBe("other");
    expect(resolveCategoryGroup({ type: "expense", group: "" })).toBe("other");
    expect(resolveCategoryGroup({ type: "income", group: "Повседневные" })).toBe("income");
  });

  it("resolves every group written by the shipped seeds", () => {
    for (const category of [...makeSeedBudget().categories, ...toDomainBudgetState(G002).categories]) {
      expect(isCategoryGroup(resolveCategoryGroup(category))).toBe(true);
    }
  });
});

describe("default categories", () => {
  it("ships fifteen expense categories across the four expense groups", () => {
    expect(DEFAULT_EXPENSE_CATEGORIES).toHaveLength(15);
    expect(DEFAULT_EXPENSE_CATEGORIES.map((item) => item.name)).toEqual([
      "Жильё",
      "ЖКХ",
      "Связь и подписки",
      "Кредиты и рассрочки",
      "Продукты",
      "Транспорт",
      "Дом и хозяйство",
      "Здоровье и аптека",
      "Дети",
      "Кафе и доставка",
      "Одежда и обувь",
      "Красота и уход",
      "Развлечения и хобби",
      "Подарки и праздники",
      "Прочее",
    ]);
    const byGroup = new Map<CategoryGroup, number>();
    for (const item of DEFAULT_EXPENSE_CATEGORIES) {
      byGroup.set(item.group, (byGroup.get(item.group) ?? 0) + 1);
    }
    expect([...byGroup.entries()]).toEqual([
      ["mandatory", 4],
      ["everyday", 5],
      ["personal", 5],
      ["other", 1],
    ]);
  });

  it("keeps housing and utilities apart and carries a loan article of its own", () => {
    const mandatory = DEFAULT_EXPENSE_CATEGORIES.filter((item) => item.group === "mandatory");
    expect(mandatory.map((item) => item.name)).toContain("Жильё");
    expect(mandatory.map((item) => item.name)).toContain("ЖКХ");
    expect(mandatory.map((item) => item.name)).toContain("Кредиты и рассрочки");
  });

  it("ships eight income categories, so income finally has a vocabulary", () => {
    expect(DEFAULT_INCOME_CATEGORIES).toHaveLength(8);
    expect(DEFAULT_INCOME_CATEGORIES.map((item) => item.name)).toEqual([
      "Зарплата",
      "Премия и бонусы",
      "Подработка и самозанятость",
      "Пособия и выплаты",
      "Пенсия",
      "Кешбэк и проценты",
      "Подарки и помощь",
      "Прочие доходы",
    ]);
    expect(DEFAULT_INCOME_CATEGORIES.every((item) => item.group === "income")).toBe(true);
  });

  it("builds twenty-three active categories with unique ids and ascending sort order", () => {
    const categories = makeDefaultCategories(sequentialIds());

    expect(categories).toHaveLength(DEFAULT_CATEGORIES.length);
    expect(categories).toHaveLength(23);
    expect(new Set(categories.map((item) => item.id)).size).toBe(23);
    expect(categories.every((item) => item.active)).toBe(true);
    expect(categories.map((item) => item.sortOrder)).toEqual(
      categories.map((_, index) => (index + 1) * 10),
    );
    expect(categories.every((item) => isCategoryGroup(item.group))).toBe(true);
  });

  it("refuses to build two categories on one identifier", () => {
    expect(() => makeDefaultCategories(() => "same")).toThrow(CategoryValidationError);
  });
});

describe("second-tier catalogue", () => {
  it("is data only: nothing in it repeats a default category of the same type", () => {
    const defaults = new Set(DEFAULT_CATEGORIES.map((item) => `${item.type} ${item.name}`));
    for (const suggestion of CATEGORY_SUGGESTIONS) {
      expect(defaults.has(`${suggestion.type} ${suggestion.name}`)).toBe(false);
      expect(isCategoryGroup(suggestion.group)).toBe(true);
      expect(categoryGroupDefinition(suggestion.group).type).toBe(suggestion.type);
    }
    expect(CATEGORY_SUGGESTIONS.filter((item) => item.type === "expense")).toHaveLength(14);
    expect(CATEGORY_SUGGESTIONS.filter((item) => item.type === "income")).toHaveLength(9);
    expect(CATEGORY_SUGGESTIONS.map((item) => item.name)).toContain("Страхование");
  });

  it("stops suggesting a name once an active category carries it", () => {
    const seed = makeSeedBudget();
    const withTaxi = createCategory(seed, { name: " такси ", type: "expense", group: "everyday" }).state;

    expect(suggestedCategories(seed).map((item) => item.name)).toContain("Такси");
    expect(suggestedCategories(withTaxi).map((item) => item.name)).not.toContain("Такси");
    expect(suggestedCategories(withTaxi, "income").every((item) => item.type === "income")).toBe(true);
  });
});

describe("createCategory", () => {
  it("creates a category without any everyday limit and leaves every figure alone", () => {
    const seed = makeSeedBudget();
    const before = calculateBudget(seed);
    const { state, category } = createCategory(
      seed,
      { name: "Страхование", type: "expense", group: "mandatory" },
      sequentialIds(),
    );

    expect(category).toMatchObject({
      id: "cat-1",
      name: "Страхование",
      type: "expense",
      group: "mandatory",
      active: true,
    });
    expect(state.categories).toHaveLength(seed.categories.length + 1);
    expect(state.budgets).toEqual(seed.budgets);
    expect(seed.categories).toHaveLength(3);

    const after = calculateBudget(state);
    expect(after.incomeMinor).toBe(before.incomeMinor);
    expect(after.expensesMinor).toBe(before.expensesMinor);
    expect(after.capitalMinor).toBe(before.capitalMinor);
    expect(after.categoryMetrics[category.id]).toMatchObject({ status: "no_plan", actualMinor: 0 });
  });

  it("gives a large payment and a schedule a category of their own, with no limit anywhere", () => {
    const { state, category } = createCategory(
      makeSeedBudget(),
      { name: "Страхование", type: "expense", group: "mandatory" },
      sequentialIds(),
    );
    const planned: BudgetState = {
      ...state,
      annualCommitments: [{
        id: "commitment-1",
        name: "ОСАГО",
        categoryId: category.id,
        accountId: SEED_IDS.accounts.main,
        dueDate: "2027-01-15",
        amountMinor: 1_200_000,
        reservedMinor: 0,
        recurrence: "annual",
        active: true,
      }],
      scheduledExpenses: [{
        id: "schedule-1",
        name: "Страховка квартиры",
        categoryId: category.id,
        accountId: SEED_IDS.accounts.main,
        amountMinor: 50_000,
        dueDay: 10,
        mode: "monthly",
        active: true,
      }],
    };

    const plan = calculateAnnualPlan(planned, "2026-07", 12);
    expect(plan.currentMonth.scheduledExpenseMinor).toBe(50_000);
    // 12 000 ₽ due in January, seven months out, rounded up to the whole rouble per payment.
    expect(plan.commitments["commitment-1"]?.monthlyReserveMinor).toBe(171_500);
    expect(planned.budgets[0]?.lines).toHaveLength(3);
  });

  it("creates an income category and files it in the single income group", () => {
    const { state, category } = createCategory(
      makeSeedBudget(),
      { name: "Зарплата", type: "income" },
      sequentialIds(),
    );

    expect(category.type).toBe("income");
    expect(category.group).toBe("income");
    expect(resolveCategoryGroup(category)).toBe("income");
    expect(calculateBudget(state).categoryMetrics[category.id]).toBeUndefined();
  });

  it("puts an expense with no group named into «Прочее»", () => {
    const { category } = createCategory(makeSeedBudget(), { name: "Ремонт", type: "expense" }, sequentialIds());
    expect(category.group).toBe("other");
  });

  it("refuses an empty name, a blank name and a name of only spaces", () => {
    const seed = makeSeedBudget();
    for (const name of ["", "   ", " "]) {
      expect(() => createCategory(seed, { name, type: "expense" })).toThrow(/Укажите название/);
    }
    try {
      createCategory(seed, { name: " ", type: "expense" });
      expect.unreachable("empty name must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(CategoryValidationError);
      expect((error as CategoryValidationError).code).toBe("name_required");
      expect((error as CategoryValidationError).field).toBe("name");
    }
  });

  it("refuses a duplicate of an active category of the same type, whatever the spacing and case", () => {
    const seed = makeSeedBudget();
    for (const name of ["Продукты", "  продукты  ", "ПРОДУКТЫ"]) {
      try {
        createCategory(seed, { name, type: "expense" });
        expect.unreachable(`duplicate ${name} must be refused`);
      } catch (error) {
        expect((error as CategoryValidationError).code).toBe("duplicate_name");
      }
    }
  });

  it("lets income and expense carry the same name, because they are different lists", () => {
    const seed = makeSeedBudget();
    const { category } = createCategory(seed, { name: "Продукты", type: "income" }, sequentialIds());
    expect(category.type).toBe("income");
  });

  it("treats an archived namesake as free, and points the caller at it", () => {
    const seed = makeSeedBudget();
    const archived: BudgetState = {
      ...seed,
      categories: seed.categories.map((item) =>
        item.id === SEED_IDS.categories.food ? { ...item, active: false } : item),
    };

    expect(findCategoryByName(archived, "продукты", "expense")?.id).toBe(SEED_IDS.categories.food);
    expect(findCategoryByName(archived, "продукты", "income")).toBeUndefined();
    const { category } = createCategory(archived, { name: "Продукты", type: "expense" }, sequentialIds());
    expect(category.active).toBe(true);
    expect(calculateBudget({ ...archived, categories: [...archived.categories, category] })
      .categoryMetrics[SEED_IDS.categories.food]).toBeDefined();
  });

  it("refuses a name that hides formatting characters or mixes look-alike alphabets", () => {
    const seed = makeSeedBudget();
    expect(() => createCategory(seed, { name: "Стра​хование", type: "expense" }))
      .toThrow(/скрытые или служебные/);
    expect(() => createCategory(seed, { name: "Кафе Starbucks", type: "expense" }))
      .toThrow(/разных алфавитов/);
    expect(() => createCategory(seed, { name: "я".repeat(81), type: "expense" }))
      .toThrow(/Не более 80 символов/);
  });

  it("refuses a group outside the closed set and a group belonging to the other side", () => {
    const seed = makeSeedBudget();
    expect(() => createCategory(seed, { name: "Своё", type: "expense", group: "Повседневные" as CategoryGroup }))
      .toThrow(/Выберите группу из списка/);
    expect(() => createCategory(seed, { name: "Своё", type: "expense", group: "income" }))
      .toThrow(/не подходит для этого вида/);
    expect(() => createCategory(seed, { name: "Своё", type: "income", group: "everyday" }))
      .toThrow(/не подходит для этого вида/);
  });

  it("refuses an identifier that is empty or already taken", () => {
    const seed = makeSeedBudget();
    expect(() => createCategory(seed, { name: "Своё", type: "expense" }, () => " "))
      .toThrow(/идентификатор/);
    expect(() => createCategory(seed, { name: "Своё", type: "expense" }, () => SEED_IDS.categories.food))
      .toThrow(/уникальный идентификатор/);
  });

  it("appends after the last category of the same group", () => {
    const first = createCategory(makeSeedBudget(), { name: "ЖКХ", type: "expense", group: "mandatory" }, sequentialIds());
    // Жильё is the only mandatory category of the seed, and it sorts at 10.
    expect(first.category.sortOrder).toBe(20);
    const second = createCategory(first.state, { name: "Зарплата", type: "income" }, sequentialIds("inc"));
    // No income category exists yet, so the new one lands after the whole list.
    expect(second.category.sortOrder).toBe(40);
  });
});

describe("income categories on operations", () => {
  it("labels income without moving a kopeck", () => {
    const seed = makeSeedBudget();
    const before = calculateBudget(seed);
    const { state, category } = createCategory(seed, { name: "Зарплата", type: "income" }, sequentialIds());
    const labelled: BudgetState = {
      ...state,
      transactions: state.transactions.map((item) =>
        item.id === SEED_IDS.transactions.income ? { ...item, categoryId: category.id } : item),
    };

    const after = calculateBudget(labelled);
    expect(after.incomeMinor).toBe(before.incomeMinor);
    expect(after.expensesMinor).toBe(before.expensesMinor);
    expect(after.capitalMinor).toBe(before.capitalMinor);
    expect(after.accountBalancesMinor).toEqual(before.accountBalancesMinor);
    expect(after.categoryMetrics).toEqual(before.categoryMetrics);
  });

  it("keeps the canonical G-000 figures at 100 000 / 76 500 / 23 500 with income labelled", () => {
    const canonical = toDomainBudgetState(G000);
    const { state, category } = createCategory(canonical, { name: "Зарплата", type: "income" }, sequentialIds());
    const labelled: BudgetState = {
      ...state,
      transactions: state.transactions.map((item) =>
        item.kind === "income" ? { ...item, categoryId: category.id } : item),
    };

    for (const candidate of [canonical, labelled]) {
      const metrics = calculateBudget(candidate);
      expect(metrics.incomeMinor).toBe(10_000_000);
      expect(metrics.expensesMinor).toBe(7_650_000);
      expect(metrics.capitalMinor).toBe(2_350_000);
    }
  });

  it("keeps the canonical G-002 July reserve at 19 809 ₽ and free at 44 191 ₽ with income labelled", () => {
    const canonical = toDomainBudgetState(G002);
    const { state, category } = createCategory(canonical, { name: "Зарплата", type: "income" }, sequentialIds());
    const labelled: BudgetState = {
      ...state,
      transactions: state.transactions.map((item) =>
        item.kind === "income" ? { ...item, categoryId: category.id } : item),
    };

    for (const candidate of [canonical, labelled]) {
      const july = calculateAnnualPlan(candidate, "2026-07", 24).months[0];
      expect(july?.annualReserveMinor).toBe(1_980_900);
      expect(july?.spendableAfterPlanMinor).toBe(4_419_100);
    }
  });

  it("restores a backup written before income had categories without a single edit", () => {
    const legacy = throughBackup(makeSeedBudget());
    expect(legacy.transactions.some((item) => item.kind === "income" && "categoryId" in item)).toBe(false);
    expect(() => calculateBudget(legacy)).not.toThrow();

    const restored = throughBackup(
      createCategory(legacy, { name: "Зарплата", type: "income" }, sequentialIds()).state,
    );
    expect(() => calculateBudget(restored)).not.toThrow();
  });

  it("refuses income that names an unknown category or an expense category", () => {
    const seed = makeSeedBudget();
    const withUnknown: BudgetState = {
      ...seed,
      transactions: seed.transactions.map((item) =>
        item.id === SEED_IDS.transactions.income ? { ...item, categoryId: "missing" } : item),
    };
    expect(() => calculateBudget(withUnknown)).toThrow(/unknown id missing/);

    const withExpenseCategory: BudgetState = {
      ...seed,
      transactions: seed.transactions.map((item) =>
        item.id === SEED_IDS.transactions.income
          ? { ...item, categoryId: SEED_IDS.categories.food }
          : item),
    };
    expect(() => calculateBudget(withExpenseCategory)).toThrow(/must reference an income category/);
  });
});
