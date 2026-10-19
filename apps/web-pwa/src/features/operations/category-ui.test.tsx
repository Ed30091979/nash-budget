/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { calculateAnnualPlan, categoriesInListOrder, makeDefaultCategories, type BudgetState, type Category } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { blankEntryDraft, endpoints, submitCheck } from "../entry/entry-model";
import { pickOptions, TargetPicker } from "../entry/TargetPicker";
import { OverviewScreen } from "../overview/OverviewScreen";
import { periodClock } from "../../reach";
import { ENTRY_CATEGORY_DESCRIPTION } from "../overview/AddCategorySheet";
import { CategorySheet, type CategorySheetDraft } from "../categories/CategorySheet";

const sheetSource = readFileSync(new URL("../entry/EntrySheet.tsx", import.meta.url), "utf8");

const accountId = "10000000-0000-4000-8000-000000000001";
const budgetId = "20000000-0000-4000-8000-000000000001";
const lineId = "30000000-0000-4000-8000-000000000001";
const archivedId = "40000000-0000-4000-8000-000000000001";
const TODAY = "2026-07-13";

function categoryIds(): () => string {
  let counter = 1;
  return () => `50000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`;
}

function fullCatalogue(extra: readonly Category[] = []): BudgetState {
  const categories = [...makeDefaultCategories(categoryIds()), ...extra];
  const firstExpense = categories.find((item) => item.type === "expense")!;
  return {
    activeBudgetId: budgetId,
    accounts: [{ id: accountId, name: "Основной", type: "current", currency: "RUB", openingBalanceMinor: 0, active: true }],
    categories,
    budgets: [{
      id: budgetId,
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      status: "open",
      plannedIncomeMinor: 10_000_000,
      warningThreshold: 0.8,
      lines: [{ id: lineId, categoryId: firstExpense.id, plannedMinor: 3_000_000 }],
    }],
    goals: [],
    annualCommitments: [],
    scheduledExpenses: [],
    transactions: [],
  };
}

function overviewMarkup(state: BudgetState = fullCatalogue()): string {
  const plan = calculateAnnualPlan(state, "2026-07", 24);
  return renderToStaticMarkup(
    <OverviewScreen
      budget={state}
      today={TODAY}
      month="2026-07"
      onMonth={vi.fn()}
      clock={periodClock({ startDate: "2026-07-01", endDate: "2026-07-31" }, [], TODAY)}
      flexiblePlanMinor={plan.currentMonth.flexiblePlanMinor}
      familyNews={[]}
      monthToOpen={null}
      openingMonth={false}
      onOpenMonth={vi.fn()}
      onOpenSheet={vi.fn()}
      onAddCategory={vi.fn()}
      onPlan={vi.fn()}
      onEdit={vi.fn()}
    />,
  );
}

/** Имена плиток сетки «Расходы» — по порядку, из их доступных имён. */
function expenseTiles(markup: string): string[] {
  const grid = markup.slice(markup.indexOf('class="tile-grid tile-grid-grid"'));
  return [...grid.matchAll(/<button class="tile tile-expense[^"]*"[^>]*aria-label="([^":]+):/gu)].map((match) => match[1] ?? "");
}

describe("выбор категории: плитки «Обзора» и выбор в листе", () => {
  it("категория без лимита достижима: каждая активная расходная — плиткой и в выборе листа, доходных среди них нет", () => {
    // Пятнадцать расходных категорий — стена, из-за которой «приходится всё время мотать». Табло
    // конвертов прятало всё, у чего лимита нет, за свёрнутой строкой; плитки стоят все — сеткой,
    // по четыре в ряд, и та, у которой лимит есть, отличается полосой, а не местом.
    const state = fullCatalogue();
    // Порядок — один на «Обзор» и лист: группа за группой, «Каждый день» первым (D-041).
    const expense = categoriesInListOrder(state.categories, "expense").map((item) => item.name);
    const income = state.categories.filter((item) => item.type === "income").map((item) => item.name);
    expect(expense.length).toBeGreaterThan(10);
    expect(expense.length).toBe(state.categories.filter((item) => item.type === "expense" && item.active).length);
    expect(expense[0]).toBe("Продукты");
    expect(expenseTiles(overviewMarkup(state))).toEqual(expense);
    const picker = pickOptions(state, blankEntryDraft(state, "expense", TODAY), "to", {}).map((option) => option.name);
    expect(picker).toEqual(expense);
    for (const name of income) expect(picker).not.toContain(name);
  });

  it("не показывает категорию дважды: плитка одна, и в выборе листа — одна", () => {
    const state = fullCatalogue();
    const tiles = expenseTiles(overviewMarkup(state));
    expect(new Set(tiles).size).toBe(tiles.length);
    const picker = pickOptions(state, blankEntryDraft(state, "expense", TODAY), "to", {}).map((option) => option.id);
    expect(new Set(picker).size).toBe(picker.length);
  });

  it("держит «Свою категорию» последней плиткой — и на «Обзоре», и в выборе листа", () => {
    const markup = overviewMarkup();
    const grid = markup.slice(markup.indexOf('class="tile-grid tile-grid-grid"'), markup.indexOf("</ul>", markup.indexOf('class="tile-grid tile-grid-grid"')));
    const items = grid.split("<li").slice(1);
    expect(items.at(-1)).toContain('aria-label="Добавить категорию расходов"');
    const state = fullCatalogue();
    const picker = renderToStaticMarkup(<TargetPicker budget={state} draft={blankEntryDraft(state, "expense", TODAY)} side="to" balances={{}} onPick={vi.fn()} onBack={vi.fn()} onCreate={vi.fn()} />);
    const tiles = picker.split("<li").slice(1);
    expect(tiles.length).toBeGreaterThan(10);
    expect(tiles.at(-1)).toContain('aria-label="Своя категория расходов"');
  });

  it("архивную категорию новым операциям не предлагает, а в правке старой — называет и подписывает", () => {
    const archived: Category = { id: archivedId, name: "Дача", type: "expense", group: "personal", active: false, sortOrder: 900 };
    const state = fullCatalogue([archived]);
    // Невыбранная архивная категория новых операций не получает: ни плитки, ни строки в выборе.
    expect(overviewMarkup(state)).not.toContain("Дача");
    expect(pickOptions(state, blankEntryDraft(state, "expense", TODAY), "to", {}).map((option) => option.name)).not.toContain("Дача");
    // Выбранная — названа там, где лист говорит, что выбрано, и подписана: лист, из которого
    // исчезло собственное значение, врал бы о том, что выбрано.
    expect(endpoints(state, { ...blankEntryDraft(state, "expense", TODAY), categoryId: archivedId }).to).toBe("Дача (в архиве)");
  });

  it("«Своя категория» из листа не теряет сумму, дату и счёт: выбирается только категория", () => {
    // Лист «Своя категория» — брат листа ввода, а не его замена: черновик живёт в хранилище, лист
    // ввода остаётся смонтированным, и после сохранения в черновике меняется только категория.
    expect(sheetSource).toContain("<AddCategorySheet");
    expect(sheetSource).toContain("description={ENTRY_CATEGORY_DESCRIPTION}");
    expect(sheetSource).toContain("patch((current) => withPicked(current, side, categoryId));");
    expect(sheetSource.indexOf("<AddCategorySheet")).toBeGreaterThan(sheetSource.indexOf("</section>"));
  });

  it("даёт доходу необязательную категорию", () => {
    const state = fullCatalogue();
    const draft = { ...blankEntryDraft(state, "income", TODAY), amount: "1000" };
    const options = pickOptions(state, draft, "from", {});
    expect(options.at(-1)).toMatchObject({ id: "", name: "Без категории" });
    expect(submitCheck(state, draft, null)).toEqual({ kind: "write" });
  });
});

const expenseDraft: CategorySheetDraft = { name: "", type: "expense", group: "everyday", limit: "" };

function sheetMarkup(draft: CategorySheetDraft, state: BudgetState = fullCatalogue()): string {
  return renderToStaticMarkup(
    <CategorySheet
      budget={state}
      draft={draft}
      description={ENTRY_CATEGORY_DESCRIPTION}
      busy={false}
      error={null}
      onPatch={vi.fn()}
      onSave={vi.fn()}
      onCancel={vi.fn()}
      onSelectExisting={vi.fn()}
      onRestore={vi.fn()}
    />,
  );
}

describe("лист «Своя категория»", () => {
  it("объявляет себя диалогом, обещает сохранить черновик и предлагает готовые названия", () => {
    const markup = sheetMarkup(expenseDraft);

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="category-sheet-title"');
    expect(markup).toContain("Сумма, дата и счёт в листе останутся на месте.");
    expect(markup).toContain("Готовые названия");
    expect(markup).toContain("Такси");
    expect(markup).toContain("Питомцы");
  });

  it("предлагает группы своего вида и необязательный лимит только расходной категории", () => {
    const expense = sheetMarkup(expenseDraft);
    expect(expense).toContain('<option value="mandatory">Обязательные платежи</option>');
    expect(expense).toContain('<option value="other">Прочее</option>');
    expect(expense).toContain("Месячный лимит, ₽ — не обязательно");
    expect(expense).toContain("Без суммы категория заводится без плана");

    const income = sheetMarkup({ name: "", type: "income", group: "income", limit: "" });
    expect(income).toContain('<option value="income" selected="">Доходы</option>');
    // Выбирать нечего: у доходов ровно одна группа, и селект честно не предлагает выбора.
    expect(income).toContain('id="category-sheet-group" disabled=""');
    expect(income).not.toContain('<option value="mandatory">');
    expect(income).not.toContain("Месячный лимит");
    expect(income).toContain("Аренда");
  });

  it("на активную тёзку предлагает выбрать её и запрещает создать дубль", () => {
    const markup = sheetMarkup({ ...expenseDraft, name: "продукты" });

    expect(markup).toContain("«Продукты» уже есть в списке. Выбрать её?");
    expect(markup).toContain("Выбрать «Продукты»");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toMatch(/Сохранить категорию<\/button>/u);
    expect(markup.slice(markup.indexOf("Сохранить категорию") - 200)).toContain("disabled");
  });

  it("на архивную тёзку предлагает вернуть её из архива", () => {
    const archived: Category = { id: archivedId, name: "Дача", type: "expense", group: "personal", active: false, sortOrder: 900 };
    const markup = sheetMarkup({ ...expenseDraft, name: " ДАЧА " }, fullCatalogue([archived]));

    expect(markup).toContain("сейчас в архиве");
    expect(markup).toContain("Вернуть «Дача» из архива");
    expect(markup).not.toContain("Выбрать «Дача»");
  });

  it("на похожую только подсказывает и сохранить не мешает", () => {
    const markup = sheetMarkup({ ...expenseDraft, name: "Продукты для дачи" });

    expect(markup).toContain("Похоже на «Продукты»");
    expect(markup).not.toContain('aria-invalid="true"');
    expect(markup).not.toContain("Выбрать «Продукты»");
  });

  it("не даёт сохранить пустое название", () => {
    expect(sheetMarkup(expenseDraft).slice(0, -1)).toContain("disabled");
    expect(sheetMarkup({ ...expenseDraft, name: "Каршеринг" })).toContain("Сохранить категорию");
  });
});
