import {
  calculateBudget,
  CategoryValidationError,
  HOUSEHOLD_ID,
  makePlanningSeed,
  moveCategory,
  PLANNING_IDS,
  type BudgetState,
  type Category,
} from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BudgetWriteRefusal } from "../../write-refusal";
import { overviewModel } from "../overview/overview-model";
import { PlanningValidationError } from "../planning/model";
import { CategoriesScreen, categoryCardLabel } from "./CategoriesScreen";
import {
  archiveCategoryWithLimits,
  categoriesView,
  categoryArchiveText,
  categoryDraftDiffers,
  categoryDraftOf,
  categoryFormError,
  categoryLimit,
  categoryPosition,
  categoryPositionWords,
  categoryPreviewWords,
  categorySave,
  nextMonthWord,
  planMonthWord,
  restoreCategory,
} from "./category-model";
import { CategoryFormView, CategoryScreen } from "./CategoryScreen";
import { currencyName } from "../../components/CurrencyPicker";
import { blankEntryDraft } from "../entry/entry-model";
import { pickOptions } from "../entry/TargetPicker";

const FOOD = PLANNING_IDS.categories.food;
const LEISURE = PLANNING_IDS.categories.leisure;
const TRANSPORT = PLANNING_IDS.categories.transport;
const CHILDREN = PLANNING_IDS.categories.children;
const SALARY = "e2c00000-0000-4000-8000-0000000000b1";
const OLD = "e2c00000-0000-4000-8000-0000000000b2";

function state(): BudgetState {
  const seed = makePlanningSeed();
  return {
    ...seed,
    categories: [
      ...seed.categories,
      { id: SALARY, name: "Зарплата", type: "income", group: "income", active: true, sortOrder: 100 },
      { id: OLD, name: "Старая", type: "expense", group: "personal", active: false, sortOrder: 200 },
    ],
  };
}
const category = (budget: BudgetState, id: string) => budget.categories.find((item) => item.id === id) as Category;
const activeLine = (budget: BudgetState, id: string) =>
  budget.budgets.find((item) => item.id === budget.activeBudgetId)?.lines.find((line) => line.categoryId === id);

describe("категории: модель", () => {
  it("расходы — по группам в их порядке, доходы — одной группой; архив отдельно; лимит — план строки месяца", () => {
    const budget = state();
    const expense = categoriesView(budget, "expense");
    expect(expense.groups.map((group) => group.title)).toEqual(["Каждый день", "Обязательные платежи", "Личное и досуг", "Прочее"]);
    const everyday = expense.groups.find((group) => group.key === "everyday")!;
    expect(everyday.cards.map((card) => card.category.name)).toEqual(["Дети", "Продукты", "Транспорт", "Дом и мелкие покупки"]);
    expect(everyday.cards.find((card) => card.category.id === FOOD)?.limitMinor).toBe(categoryLimit(budget, FOOD));
    expect(categoryLimit(budget, FOOD)).toBeGreaterThan(0);
    expect(expense.archived.map((card) => card.category.name)).toEqual(["Старая"]);
    const income = categoriesView(budget, "income");
    expect(income.groups.map((group) => [group.title, group.cards.map((card) => card.category.name)])).toEqual([["Доходы", ["Зарплата"]]]);
    expect(income.groups[0]?.cards[0]?.limitMinor).toBeNull();
    expect(planMonthWord(budget)).toBe("июль");
  });

  it("порядок плиток один: «Обзор» и выбор при записи — как список категорий, группа за группой (подсказка «Место в группе» — правда)", () => {
    // Ревью 2c, LOW-6: «Обзор» ставил плитки по общему `sortOrder`, выбор при записи — по порядку
    // документа, а экран категорий — по группам; подсказка обещала один порядок для всех.
    const seed = state();
    // Перемешанный документ: общий `sortOrder` и порядок записей расходятся с порядком групп.
    const budget: BudgetState = { ...seed, categories: [...seed.categories].reverse().map((item, index) => ({ ...item, sortOrder: (index * 37) % 101 })) };
    const listed = (type: "expense" | "income") => categoriesView(budget, type).groups.flatMap((group) => group.cards.map((card) => card.category.id));
    expect(overviewModel(budget, "2026-07", "2026-07-20").categories.map((tile) => tile.id)).toEqual(listed("expense"));
    expect(pickOptions(budget, blankEntryDraft(budget, "expense", "2026-07-20"), "to", {}).map((option) => option.id)).toEqual(listed("expense"));
    expect(pickOptions(budget, blankEntryDraft(budget, "income", "2026-07-20"), "from", {}).map((option) => option.id).filter((id) => id !== "")).toEqual(listed("income"));
    const moved = moveCategory(budget, listed("expense")[1]!, "up");
    expect(overviewModel(moved, "2026-07", "2026-07-20").categories.map((tile) => tile.id)).toEqual(categoriesView(moved, "expense").groups.flatMap((group) => group.cards.map((card) => card.category.id)));
  });

  it("место словами — в роде записи: категория «2-я из 4», источник дохода «2-й из 3» (ревью 2c, LOW-7)", () => {
    const budget = state();
    expect(categoryPositionWords(category(budget, FOOD), 2, 4)).toBe("2-я из 4");
    expect(categoryPositionWords(category(budget, SALARY), 2, 3)).toBe("2-й из 3");
  });

  it("отказ суммы лимита называет базовую валюту, а не всегда рубли (ревью 2c, LOW-7)", () => {
    const budget = state();
    const food = category(budget, FOOD);
    const pristine = categoryDraftOf(budget, food);
    const refusal = (state: BudgetState) => {
      try {
        categorySave(food, { ...pristine, limit: "кофе" }, pristine)(state);
      } catch (error) {
        return categoryFormError(error).message;
      }
      return null;
    };
    expect(refusal(budget)).toBe("Введите положительную сумму в рублях, не более двух знаков после запятой.");
    const euro: BudgetState = { ...budget, household: { id: HOUSEHOLD_ID, baseCurrency: "EUR" }, accounts: budget.accounts.map((account) => ({ ...account, currency: "EUR" })) };
    expect(refusal(euro)).toBe(`Введите положительную сумму в валюте «${currencyName("EUR")}», не более двух знаков после запятой.`);
  });

  it("место в группе — для «Выше / Ниже»; перестановка меняет только двух соседей группы", () => {
    const budget = state();
    expect(categoryPosition(budget, category(budget, FOOD))).toEqual({ position: 2, count: 4 });
    expect(categoryPosition(budget, category(budget, OLD))).toEqual({ position: 0, count: 0 });
    const moved = moveCategory(budget, FOOD, "up");
    expect(categoryPosition(moved, category(moved, FOOD))).toEqual({ position: 1, count: 4 });
    const changed = moved.categories.filter((item, index) => item !== budget.categories[index]).map((item) => item.id);
    expect(changed.sort()).toEqual([CHILDREN, FOOD].sort());
  });

  it("форма: снимок при открытии; «грязно» — по имени без краевых пробелов и по сумме лимита", () => {
    const budget = state();
    const pristine = categoryDraftOf(budget, category(budget, FOOD));
    expect(pristine).toMatchObject({ name: "Продукты", group: "everyday", icon: null, tone: null });
    expect(pristine.limit).toBe(String((categoryLimit(budget, FOOD) ?? 0) / 100));
    expect(categoryDraftDiffers(pristine, pristine)).toBe(false);
    expect(categoryDraftDiffers({ ...pristine, name: " Продукты " }, pristine)).toBe(false);
    expect(categoryDraftDiffers({ ...pristine, limit: `${pristine.limit},00` }, pristine)).toBe(false);
    expect(categoryDraftDiffers({ ...pristine, limit: "" }, pristine)).toBe(true);
    expect(categoryDraftDiffers({ ...pristine, tone: "lilac" }, pristine)).toBe(true);
    expect(categoryDraftOf(budget, category(budget, SALARY)).limit).toBe("");
  });

  it("одна запись: имя, иконка, тон и лимит; ни одна сумма бюджета, кроме лимита, не двигается", () => {
    const budget = state();
    const food = category(budget, FOOD);
    const pristine = categoryDraftOf(budget, food);
    const next = categorySave(food, { ...pristine, name: "Еда", icon: "cup", tone: "lilac", limit: "32000" }, pristine)(budget);
    expect(category(next, FOOD)).toMatchObject({ name: "Еда", icon: "cup", color: "lilac", group: "everyday" });
    expect(activeLine(next, FOOD)).toMatchObject({ plannedMinor: 3_200_000 });
    const before = calculateBudget(budget);
    const after = calculateBudget(next);
    expect(after.expensesMinor).toBe(before.expensesMinor);
    expect(after.categoryMetrics[FOOD]?.actualMinor).toBe(before.categoryMetrics[FOOD]?.actualMinor);
    // Без изменений — то же состояние: журнал не видит правки.
    expect(categorySave(food, pristine, pristine)(budget)).toBe(budget);
  });

  it("лимит: пусто снимает, сумма возвращает снятый, у категории без строки — заводит её", () => {
    const budget = state();
    const food = category(budget, FOOD);
    const pristine = categoryDraftOf(budget, food);
    const cleared = categorySave(food, { ...pristine, limit: "" }, pristine)(budget);
    expect(activeLine(cleared, FOOD)?.active).toBe(false);
    expect(categoryLimit(cleared, FOOD)).toBeNull();
    const back = categorySave(food, { ...pristine, limit: "15000" }, { ...pristine, limit: "" })(cleared);
    expect(activeLine(back, FOOD)).toMatchObject({ active: true, plannedMinor: 1_500_000 });
    // «Дети» без лимита: строка месяца плана заводится на ту же категорию, а не на тёзку.
    const children = category(budget, CHILDREN);
    const noLimit = categoryDraftOf(budget, children);
    expect(noLimit.limit).toBe("");
    const created = categorySave(children, { ...noLimit, limit: "5000" }, noLimit)(budget);
    expect(activeLine(created, CHILDREN)).toMatchObject({ plannedMinor: 500_000, active: true });
    expect(created.categories).toHaveLength(budget.categories.length);
  });

  it("архив прячет категорию с «Обзора» и снимает лимит месяца плана; операции остаются; возврат — без лимита", () => {
    const budget = state();
    expect(overviewModel(budget, "2026-07", "2026-07-20").categories.some((tile) => tile.id === FOOD)).toBe(true);
    const archived = archiveCategoryWithLimits(budget, FOOD);
    expect(category(archived, FOOD).active).toBe(false);
    expect(activeLine(budget, FOOD)?.active).not.toBe(false);
    expect(activeLine(archived, FOOD)?.active).toBe(false);
    expect(overviewModel(archived, "2026-07", "2026-07-20").categories.some((tile) => tile.id === FOOD)).toBe(false);
    expect(archived.transactions).toEqual(budget.transactions);
    expect(calculateBudget(archived).expensesMinor).toBe(calculateBudget(budget).expensesMinor);
    const restored = restoreCategory(archived, FOOD);
    expect(category(restored, FOOD).active).toBe(true);
    expect(categoryLimit(restored, FOOD)).toBeNull();
  });

  it("архив и «Вернуть» не трогают закрытые месяцы: лимит июня на месте, лимит июля и черновика августа снят и не возвращается", () => {
    // Ревью 2c, HIGH-2: архив гасил строки категории во всех месяцах, и «Вернуть» навсегда стирал
    // лимиты закрытых месяцев. Июнь закрыт, июль — месяц плана, август — черновик.
    const JUNE = "e2c00000-0000-4000-8000-0000000000c1";
    const AUGUST = "e2c00000-0000-4000-8000-0000000000c2";
    const seed = state();
    const july = seed.budgets[0]!;
    const budget: BudgetState = {
      ...seed,
      budgets: [
        { ...july, id: JUNE, startDate: "2026-06-01", endDate: "2026-06-30", status: "closed", lines: [{ id: "e2c00000-0000-4000-8000-0000000000c3", categoryId: FOOD, plannedMinor: 3_000_000 }] },
        july,
        { ...july, id: AUGUST, startDate: "2026-08-01", endDate: "2026-08-31", status: "draft", lines: [{ id: "e2c00000-0000-4000-8000-0000000000c4", categoryId: FOOD, plannedMinor: 3_200_000, active: true }] },
      ],
    };
    const june = calculateBudget(budget, JUNE).categoryMetrics[FOOD];
    expect(june?.availableMinor).toBe(3_000_000);
    const archived = archiveCategoryWithLimits(budget, FOOD);
    expect(archived.budgets[0]).toBe(budget.budgets[0]);
    expect(activeLine(archived, FOOD)?.active).toBe(false);
    expect(archived.budgets[2]?.lines[0]?.active).toBe(false);
    const restored = restoreCategory(archived, FOOD);
    expect(restored.budgets[0]).toBe(budget.budgets[0]);
    expect(calculateBudget(restored, JUNE).categoryMetrics[FOOD]).toEqual(june);
    expect(categoryLimit(restored, FOOD)).toBeNull();
    expect(restored.budgets[2]?.lines[0]?.active).toBe(false);
    // Только закрытый месяц с лимитом — архиву не помеха: прошлое не держит категорию.
    const onlyJune: BudgetState = { ...budget, budgets: [budget.budgets[0]!, { ...july, lines: july.lines.filter((line) => line.categoryId !== FOOD) }] };
    expect(category(archiveCategoryWithLimits(onlyJune, FOOD), FOOD).active).toBe(false);
    // Вопрос перед архивом говорит ровно это.
    expect(categoryArchiveText(budget, category(budget, FOOD))).toBe(
      "Категория уйдёт с «Обзора» и из выбора при записи. Записанные операции останутся в «Операциях» и отчётах. "
      + "Лимиты на июль и август снимутся и при возврате не вернутся — их можно будет задать заново. "
      + "Закрытые месяцы не меняются: их лимиты по ней останутся как были. Вернуть можно в любой момент.",
    );
    expect(categoryArchiveText(onlyJune, category(onlyJune, FOOD))).toBe(
      "Категория уйдёт с «Обзора» и из выбора при записи. Записанные операции останутся в «Операциях» и отчётах. "
      + "Закрытые месяцы не меняются: их лимиты по ней останутся как были. Вернуть можно в любой момент.",
    );
    expect(categoryArchiveText(state(), category(state(), FOOD))).toContain("Лимит на июль снимется и при возврате не вернётся — его можно будет задать заново.");
    expect(categoryArchiveText(state(), category(state(), SALARY))).toBe(
      "Источник уйдёт с «Обзора» и из выбора при записи. Записанные операции останутся в «Операциях» и отчётах. Вернуть можно в любой момент.",
    );
  });

  it("архив не пропускает категорию с крупным или регулярным платежом — словами формы операции", () => {
    const budget = state();
    expect(() => archiveCategoryWithLimits(budget, TRANSPORT)).toThrow("Сначала отключите активные лимиты и регулярные платежи этой категории.");
  });

  it("лимит архивной категории не трогается: план не завёл бы ей тёзку", () => {
    const budget = state();
    const old = category(budget, OLD);
    const pristine = categoryDraftOf(budget, old);
    const next = categorySave(old, { ...pristine, name: "Совсем старая", limit: "1000" }, pristine)(budget);
    expect(next.categories).toHaveLength(budget.categories.length);
    expect(category(next, OLD).name).toBe("Совсем старая");
    expect(activeLine(next, OLD)).toBeUndefined();
  });

  it("отказы — у своего поля: имя и группа домена, сумма лимита плана; задержка — у формы", () => {
    const budget = state();
    const food = category(budget, FOOD);
    const pristine = categoryDraftOf(budget, food);
    const refusal = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return categoryFormError(error);
      }
      return null;
    };
    expect(refusal(() => categorySave(food, { ...pristine, name: "транспорт" }, pristine)(budget)))
      .toEqual({ field: "name", message: "Активная категория с таким названием уже существует." });
    expect(refusal(() => categorySave(food, { ...pristine, name: "" }, pristine)(budget))?.field).toBe("name");
    expect(refusal(() => categorySave(food, { ...pristine, limit: "кофе" }, pristine)(budget)))
      .toEqual({ field: "limit", message: "Введите положительную сумму в рублях, не более двух знаков после запятой." });
    expect(categoryFormError(new CategoryValidationError("invalid_color", "color", "Выберите цвет из списка."))).toEqual({ field: "tone", message: "Выберите цвет из списка." });
    expect(categoryFormError(new PlanningValidationError("lines", "Достигнут лимит повседневных категорий."))).toEqual({ field: "form", message: "Достигнут лимит повседневных категорий." });
    expect(categoryFormError(new BudgetWriteRefusal("notReady"))).toEqual({ field: "form", message: new BudgetWriteRefusal("notReady").userMessage });
  });
});

const plain = (markup: string) => markup.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").replace(/[\u00a0\u00ad]/gu, (char) => (char === "\u00ad" ? "" : " ")).trim();

describe("категории: разметка", () => {
  const render = (type: "expense" | "income") => renderToStaticMarkup(
    <CategoriesScreen budget={state()} type={type} write={{ run: vi.fn() }} onBack={vi.fn()} onType={vi.fn()} onOpen={vi.fn()} onMessage={vi.fn()} />,
  );

  it("расходы (макет 13): чипы видов, «+» и плитка «Своя» вместо чёрной кнопки, сетки по группам D-041, архив с «Вернуть»", () => {
    const markup = render("expense");
    expect(markup).toContain('aria-pressed="true"><span class="chip-face">Расходы</span>');
    expect(markup).toContain('aria-pressed="false"><span class="chip-face">Доходы</span>');
    // Новая — «+» строки заголовка и пунктирная плитка «Своя» последней в сетке; чёрной кнопки нет.
    expect(markup).toContain('<div class="title-bar-action"><button class="icon-button" type="button" aria-label="Новая категория">');
    expect(markup).not.toContain("primary-button manage-add");
    expect(markup).toMatch(/<button class="add-tile" type="button" aria-label="Своя категория"><span class="tile-square add" aria-hidden="true">[^]*?<span class="tile-name" aria-hidden="true">Своя<\/span><\/button><\/li><\/ul><\/section>/u);
    expect(markup.match(/class="add-tile"/gu)).toHaveLength(1);
    // Абзаца-пояснения под строкой заголовка нет (R3, п. 1).
    expect(markup).not.toContain("manage-head");
    expect(markup).not.toContain("Коснитесь категории, чтобы");
    // Группы — в порядке D-041: «Каждый день» первой.
    const titles = [...markup.matchAll(/class="dir-kicker">([^<]+)<\/h2>/gu)].map((match) => match[1]);
    expect(titles).toEqual(["Каждый день", "Обязательные платежи", "Личное и досуг", "Прочее", "В архиве"]);
    expect(markup).toMatch(/aria-label="Продукты: лимит [^"]+ на июль\. Изменить"/u);
    expect(markup).toContain('aria-label="Дети: без лимита. Изменить"');
    // Анатомия плитки «Обзора»: под именем — лимит суммой и подпись «лимит».
    expect(markup).toMatch(/<span class="tile-sum" aria-hidden="true"><span class="money">[^]*?<\/span><\/span><span class="tile-limit" aria-hidden="true">лимит<\/span>/u);
    expect(markup).toContain('href="#glyph-pencil"');
    expect(markup).toContain('aria-label="Вернуть «Старая» из архива"');
    expect(markup).toContain("Изменить порядок");
  });

  it("доходы: та же сетка без лимитов; плитка называет источник и действие; «+ Свой»", () => {
    const markup = render("income");
    expect(markup).toContain('aria-label="Новый источник дохода"');
    expect(markup).toContain('aria-label="Свой источник дохода"');
    expect(markup).toContain('aria-label="Зарплата. Изменить"');
    expect(markup).not.toContain("без лимита");
    // Группа одна — её имя повторило бы чип «Доходы»: только для слуха.
    expect(markup).toMatch(/<h2 id="categories-income" class="sr-only">/u);
    const card = categoriesView(state(), "income").groups[0]!.cards[0]!;
    expect(categoryCardLabel(card, "RUB", "июль")).toBe("Зарплата. Изменить");
  });
});

describe("лист категории: разметка", () => {
  const view = (id: string, overrides: Partial<Parameters<typeof CategoryFormView>[0]> = {}) => {
    const budget = state();
    const item = category(budget, id);
    return renderToStaticMarkup(
      <CategoryFormView budget={budget} category={item} draft={categoryDraftOf(budget, item)} error={null} busy={false} onPatch={vi.fn()} {...overrides} />,
    );
  };

  it("расходная (макет 13): образец, название, лимит с одной строкой подсказки, цвет, значок, группа 2×2", () => {
    const markup = view(LEISURE);
    const order = ['class="card dir-preview"', 'for="category-name"', 'for="category-limit"', '<legend class="dir-label">Цвет</legend>', '<legend class="dir-label">Значок</legend>', '<legend class="dir-label">Группа</legend>'];
    const at = order.map((piece) => markup.indexOf(piece));
    expect(at.every((index) => index >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(markup).toContain('for="category-limit">Лимит на июль<span class="sr-only">, ₽ — не обязательно</span>');
    expect(markup).toContain('<p class="field-hint" id="category-limit-hint">Пусто — без лимита. Лимит перейдёт и на август.</p>');
    // Группа — карточки-радиокнопки, а не <select>.
    expect(markup).not.toContain("<select");
    expect(markup).toMatch(/<input id="category-group-personal" type="radio" name="[^"]+" checked="" value="personal"\/>/u);
    expect(markup.match(/id="category-group-[a-z]+"/gu)).toHaveLength(4);
  });

  it("источник дохода — без группы и без лимита; архивная — без лимита", () => {
    const income = view(SALARY);
    expect(income).not.toContain("Группа");
    expect(income).not.toContain('for="category-limit"');
    expect(income).toContain("Источник дохода");
    expect(view(OLD)).not.toContain('for="category-limit"');
    expect(view(OLD)).toContain("В архиве");
  });

  it("отказ у поля связан с полем; образец — набранное имя с переносами для глаза и целое для слуха, иконка и тон", () => {
    const budget = state();
    const draft = { ...categoryDraftOf(budget, category(budget, FOOD)), name: "Благотворительность", icon: "cup" as const, tone: "coral" as const };
    const markup = view(FOOD, { draft, error: { field: "limit", message: "Введите положительную сумму в рублях, не более двух знаков после запятой." } });
    expect(markup).toMatch(/<input id="category-limit"[^>]*aria-invalid="true" aria-describedby="category-limit-hint category-limit-error"/u);
    expect(markup).toContain('id="category-limit-error" role="alert"');
    expect(markup).toMatch(/<div class="card dir-preview"><span class="tile-square tone-coral" aria-hidden="true">[^]*?glyph-cup[^]*?<span class="dir-preview-name" aria-hidden="true"><bdi dir="auto">Бла[^<]*\u00ad[^<]*<\/bdi><\/span><span class="sr-only"><bdi dir="auto">Благотворительность<\/bdi>: <\/span>/u);
  });

  it("подпись образца: потрачено против лимита в месяце плана, без лимита — так и сказано", () => {
    const budget = state();
    const spent = calculateBudget(budget).categoryMetrics[FOOD]?.actualMinor ?? 0;
    const limit = categoryLimit(budget, FOOD)!;
    expect(categoryPreviewWords(budget, category(budget, FOOD), "RUB")).toBe(`${(spent / 100).toLocaleString("ru-RU").replace(/\s/gu, "\u00a0")} из ${(limit / 100).toLocaleString("ru-RU").replace(/\s/gu, "\u00a0")}\u00a0₽ в июле`);
    expect(categoryPreviewWords(budget, category(budget, CHILDREN), "RUB")).toMatch(/^\d[\d\u00a0]*\u00a0₽ в июле, без лимита$/u);
    expect(categoryPreviewWords(budget, category(budget, SALARY), "RUB")).toBe("Источник дохода");
    expect(nextMonthWord(budget)).toBe("август");
  });

  it("лист — модальный диалог маршрута: «Категория», «Сохранить» в подвале, архив последним в теле", () => {
    const budget = state();
    const sheet = renderToStaticMarkup(<CategoryScreen budget={budget} categoryId={FOOD} write={{ run: vi.fn() }} onBack={vi.fn()} onDone={vi.fn()} />);
    expect(sheet).toMatch(/^<div class="sheet-backdrop dir-backdrop" role="presentation"><section class="sheet dir-sheet" role="dialog" aria-modal="true" aria-labelledby="category-sheet-title"/u);
    expect(sheet).toContain('<h1 id="category-sheet-title" tabindex="-1">Категория</h1>');
    expect(sheet).toMatch(/<section class="dir-archive" aria-label="Архив"><button id="category-archive" class="quiet-button dir-danger" type="button">/u);
    expect(sheet).toContain("Удалить категорию нельзя: прошлые месяцы ссылаются на неё.");
    expect(sheet.indexOf("dir-archive")).toBeLessThan(sheet.indexOf("dir-sheet-foot"));
    // Порядок в группе — режимом в списке, а не «Выше / Ниже» в листе.
    expect(sheet).not.toContain("— выше");
    const income = renderToStaticMarkup(<CategoryScreen budget={budget} categoryId={SALARY} write={{ run: vi.fn() }} onBack={vi.fn()} onDone={vi.fn()} />);
    expect(income).toContain('<h1 id="category-sheet-title" tabindex="-1">Источник дохода</h1>');
    expect(income).toContain("Удалить источник дохода нельзя: прошлые месяцы ссылаются на него.");
  });
});
