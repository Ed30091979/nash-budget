import { makePlanningSeed, PLANNING_IDS, SEED_IDS, type BudgetState } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute, type Route } from "../../navigation/routes";
import type { SheetRequest } from "../overview/pick-model";
import { draftOfSheet, editVanished, sheetChoosesMode, sheetEditOf, sheetOpeningOf } from "./sheet-address";
import { blankEntryDraft, carriedDraft, draftSummary, newEntryDraft } from "./entry-model";

const MAIN = SEED_IDS.accounts.main;
const RESERVE = SEED_IDS.accounts.savings;
const FOOD = PLANNING_IDS.categories.food;
const SALARY = "a2000000-0000-4000-8000-0000000000c1";
const TODAY = "2026-07-13";

function state(): BudgetState {
  const seed = makePlanningSeed();
  return { ...seed, categories: [...seed.categories, { id: SALARY, name: "Зарплата", type: "income", group: "income", active: true, sortOrder: 100 }] };
}

/** Касания плиток — адрес — разбор адреса — черновик: тот же, что из касаний напрямую. */
function viaAddress(request: SheetRequest): Route {
  const route = { name: "overview", sheet: "entry", ...sheetOpeningOf(request) } as Route;
  return parseRoute(formatRoute(route)).route;
}

describe("лист ввода в адресе", () => {
  it("каждое касание плиток доходит до черновика через адрес без потерь", () => {
    const requests: readonly SheetRequest[] = [
      { kind: "expense", accountId: null, categoryId: FOOD },
      { kind: "expense", accountId: RESERVE, categoryId: FOOD },
      { kind: "income", categoryId: SALARY, accountId: MAIN },
      { kind: "income", categoryId: null, accountId: RESERVE },
      { kind: "transfer", fromAccountId: MAIN, toAccountId: RESERVE },
    ];
    for (const request of requests) {
      expect(draftOfSheet(state(), viaAddress(request), TODAY), request.kind).toEqual(newEntryDraft(state(), request, TODAY));
    }
  });

  it("в адресе — только вид и UUID строчными; «+» — без вида, и вид выбирают в листе", () => {
    expect(formatRoute({ name: "overview", sheet: "entry", ...sheetOpeningOf({ kind: "expense", accountId: null, categoryId: FOOD.toUpperCase() }) }))
      .toBe(`#/?sheet=entry&op=expense&dst=${FOOD}`);
    expect(sheetOpeningOf({ kind: "expense", accountId: "Основной", categoryId: "Продукты 1 250 ₽" })).toEqual({ op: "expense" });
    expect(sheetEditOf({ id: "кофе" })).toBeNull();
    expect(sheetEditOf({ id: FOOD.toUpperCase() })).toEqual({ edit: FOOD });
    expect(sheetChoosesMode({ name: "overview", sheet: "entry" })).toBe(true);
    expect(sheetChoosesMode({ name: "overview", sheet: "entry", op: "income" })).toBe(false);
    expect(sheetChoosesMode({ name: "operations", sheet: "entry", edit: FOOD })).toBe(false);
  });

  it("идентификатор, которого в бюджете нет или который закрыт, не подставляется: вид остаётся, «куда» выбирают", () => {
    const missing = "a2000000-0000-4000-8000-0000000000ff";
    const closed: BudgetState = { ...state(), accounts: state().accounts.map((account) => account.id === RESERVE ? { ...account, active: false } : account) };
    expect(draftOfSheet(state(), { name: "overview", sheet: "entry", op: "expense", dst: missing }, TODAY)).toEqual(blankEntryDraft(state(), "expense", TODAY));
    expect(draftOfSheet(closed, { name: "overview", sheet: "entry", op: "expense", src: RESERVE, dst: FOOD }, TODAY).accountId).toBe(MAIN);
    const transfer = draftOfSheet(closed, { name: "overview", sheet: "entry", op: "transfer", src: MAIN, dst: RESERVE }, TODAY);
    expect(transfer.mode).toBe("transfer");
    expect(transfer.accountId).toBe(MAIN);
    expect(transfer.toAccountId).not.toBe(MAIN);
    expect(draftOfSheet(state(), { name: "overview", sheet: "entry", op: "income", src: SALARY }, TODAY)).toMatchObject({ mode: "income", accountId: MAIN, incomeCategoryId: SALARY });
    // Категория расхода не годится в источник дохода, и наоборот.
    expect(draftOfSheet(state(), { name: "overview", sheet: "entry", op: "income", src: FOOD, dst: MAIN }, TODAY).incomeCategoryId).toBe("");
  });

  it("адрес пишет UUID строчными, а бюджет хранит как пришло: черновик — с хранимым идентификатором", () => {
    const upper = FOOD.toUpperCase();
    const shouting: BudgetState = { ...state(), categories: state().categories.map((category) => category.id === FOOD ? { ...category, id: upper } : category) };
    expect(draftOfSheet(shouting, { name: "overview", sheet: "entry", op: "expense", dst: FOOD }, TODAY).categoryId).toBe(upper);
  });
});

describe("операцию удалили, пока её правили", () => {
  const ID = "e3000000-0000-4000-8000-000000000001";

  it("пропажа узнаётся, только если операция была в листе и её удалил не сам лист", () => {
    // Ревью 2b, LOW-6: лист молча исчезал, адрес держал `edit=`, фокус падал, набранное терялось.
    expect(editVanished(ID, ID, false, false)).toBe(true);
    // На адрес пришли, а операции нет — это «Запись не найдена» оболочки, а не пропажа.
    expect(editVanished(null, ID, false, false)).toBe(false);
    // Операция на месте; удалил сам лист («Удалить»); другой адрес.
    expect(editVanished(ID, ID, true, false)).toBe(false);
    expect(editVanished(ID, ID, false, true)).toBe(false);
    expect(editVanished(ID, "e3000000-0000-4000-8000-000000000002", false, false)).toBe(false);
    expect(editVanished(ID, undefined, false, false)).toBe(false);
  });

  it("набранное становится новой операцией и называется словами", () => {
    const typed = { ...newEntryDraft(state(), { kind: "expense", accountId: MAIN, categoryId: FOOD }, TODAY), editId: ID, status: "pending" as const, amount: "48123", note: " сверено " };
    expect(carriedDraft(typed)).toMatchObject({ editId: null, status: "posted", amount: "48123", categoryId: FOOD });
    expect(draftSummary(state(), typed)).toBe("расход 48\u00a0123\u00a0₽, «сверено»");
    expect(draftSummary(state(), { ...typed, amount: "", note: "" })).toBe("расход без суммы");
  });
});
