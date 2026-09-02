/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { makeDefaultCategories, type BudgetState, type Category } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { OperationsScreen } from "./OperationsScreen";
import { CategorySheet, type CategorySheetDraft } from "./CategorySheet";

const screenSource = readFileSync(new URL("./OperationsScreen.tsx", import.meta.url), "utf8");

const accountId = "10000000-0000-4000-8000-000000000001";
const budgetId = "20000000-0000-4000-8000-000000000001";
const lineId = "30000000-0000-4000-8000-000000000001";
const archivedId = "40000000-0000-4000-8000-000000000001";

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

function screenMarkup(state: BudgetState = fullCatalogue()): string {
  return renderToStaticMarkup(<OperationsScreen budget={state} onChange={vi.fn(async () => undefined)} />);
}

describe("выбор категории на экране операций", () => {
  it("печатает заголовки групп над категориями", () => {
    const markup = screenMarkup();

    for (const title of ["Обязательные платежи", "Каждый день", "Личное и досуг", "Прочее"]) {
      expect(markup).toContain(`<optgroup label="${title}">`);
    }
    // Доходная группа в расходной форме не показывается.
    expect(markup).not.toContain('<optgroup label="Доходы">');
    for (const name of ["Кредиты и рассрочки", "Здоровье и аптека", "Подарки и праздники"]) {
      expect(markup).toContain(name);
    }
  });

  it("ставит поле поиска над списком и объявляет число найденного", () => {
    const markup = screenMarkup();

    expect(markup).toContain('<label for="operation-category-search">Поиск по категориям</label>');
    expect(markup).toContain('id="operation-category-search" type="search"');
    expect(markup).toContain('aria-describedby="operation-category-status"');
    expect(markup).toContain('<p class="field-hint" id="operation-category-status" role="status">Найдено 15 категорий</p>');
    // Поиск стоит перед списком, а не после него.
    expect(markup.indexOf("operation-category-search")).toBeLessThan(markup.indexOf('id="operation-categoryId"'));
  });

  it("держит «Свою категорию» последним элементом списка", () => {
    const markup = screenMarkup();
    const select = markup.slice(markup.indexOf('id="operation-categoryId"'));
    const options = [...select.slice(0, select.indexOf("</select>")).matchAll(/<option[^>]*>([^<]*)</gu)]
      .map((match) => match[1]);

    expect(options.at(-1)).toBe("Своя категория");
    expect(options[0]).toBe("Выберите категорию");
    expect(select).toContain(`<option value="#custom">Своя категория</option>`);
  });

  it("оставляет архивную выбранную категорию видимой и подписанной", () => {
    const archived: Category = { id: archivedId, name: "Дача", type: "expense", group: "personal", active: false, sortOrder: 900 };
    const markup = screenMarkup(fullCatalogue([archived]));

    expect(markup).not.toContain("Дача (в архиве)");
    expect(screenSource).toContain('{option.archived ? " (в архиве)" : ""}');
  });

  it("не теряет сумму, дату и счёт при открытии листа", () => {
    // Лист — брат формы, а не её замена: форма остаётся смонтированной, и единственное, что
    // после сохранения меняется в черновике, — выбранная категория.
    expect(screenSource).toContain("{sheet ? <CategorySheet");
    expect(screenSource).toContain('patchDraft(current, "categoryId", id)');
    expect(screenSource).not.toContain("setDraft(defaultDraft(draft.kind, budget)); // sheet");
    const formEnd = screenSource.indexOf("</form>");
    expect(screenSource.indexOf("{sheet ? <CategorySheet")).toBeGreaterThan(formEnd);
  });

  it("даёт доходу необязательную категорию", () => {
    expect(screenSource).toContain('label="Категория дохода — не обязательно"');
    expect(screenSource).toContain('type="income"');
    expect(screenSource).toContain('optional onQuery');
    expect(screenSource).toContain('{optional ? "Без категории" : "Выберите категорию"}');
  });
});

const expenseDraft: CategorySheetDraft = { name: "", type: "expense", group: "everyday", limit: "" };

function sheetMarkup(draft: CategorySheetDraft, state: BudgetState = fullCatalogue()): string {
  return renderToStaticMarkup(
    <CategorySheet
      budget={state}
      draft={draft}
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
    expect(markup).toContain("Сумма, дата и счёт в форме останутся на месте.");
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
