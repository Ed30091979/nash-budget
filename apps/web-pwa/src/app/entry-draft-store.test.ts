import { makePlanningSeed, PLANNING_IDS, SEED_IDS } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { newEntryDraft, type EntryDraft } from "../features/entry/entry-model";
import { createEntryDraftStore } from "./entry-draft-store";

const FOOD_KEY = `#/?sheet=entry&op=expense&dst=${PLANNING_IDS.categories.food}`;
const PLUS_KEY = "#/operations?sheet=entry";

function food(): EntryDraft {
  return newEntryDraft(makePlanningSeed(), { kind: "expense", accountId: SEED_IDS.accounts.main, categoryId: PLANNING_IDS.categories.food }, "2026-07-13");
}

describe("черновик листа ввода живёт вне листа", () => {
  it("то же открытие — тот же черновик, другое — новый; грязный — только отличный от открытия", () => {
    const store = createEntryDraftStore();
    const init = vi.fn(food);
    const opened = store.openEntry(FOOD_KEY, init);
    expect(opened.draft).toEqual(food());
    expect(store.isDirty()).toBe(false);
    store.update((draft) => ({ ...draft, amount: "1250" }));
    expect(store.isDirty()).toBe(true);
    // Лист закрыли и открыли тем же адресом («Вперёд»): набранное на месте, `init` не зовётся.
    expect(store.openEntry(FOOD_KEY, init).draft.amount).toBe("1250");
    expect(init).toHaveBeenCalledOnce();
    // Набрали обратно то, что было при открытии, — снова чисто.
    store.update((draft) => ({ ...draft, amount: "" }));
    expect(store.isDirty()).toBe(false);
    // Другое открытие — новый черновик.
    expect(store.openEntry(PLUS_KEY, () => ({ ...food(), categoryId: "" })).draft.categoryId).toBe("");
  });

  it("с нажатия «Записать» черновик не «несохранённый»; записанный — уходит, новый не трогается", () => {
    const store = createEntryDraftStore();
    store.openEntry(FOOD_KEY, food);
    store.update((draft) => ({ ...draft, amount: "1250" }));
    const ticket = store.beginSaving();
    expect(store.current()?.status).toBe("saving");
    expect(store.isDirty()).toBe(false);
    // Правка во время записи не принимается: уходит то, что было на нажатии.
    store.update((draft) => ({ ...draft, amount: "9" }));
    expect(store.current()?.draft.amount).toBe("1250");
    store.succeed(ticket);
    expect(store.current()).toBeNull();

    // Пока первая запись летела, человек открыл новый лист: удача первой его не стирает.
    store.openEntry(FOOD_KEY, food);
    store.update((draft) => ({ ...draft, amount: "100" }));
    const first = store.beginSaving();
    store.openEntry(FOOD_KEY, food);
    store.update((draft) => ({ ...draft, amount: "200" }));
    store.succeed(first);
    expect(store.current()?.draft.amount).toBe("200");
  });

  it("неудача: черновик ждёт со своей причиной, снова «несохранённый», и лист открывается с ним", () => {
    const store = createEntryDraftStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.openEntry(FOOD_KEY, food);
    store.update((draft) => ({ ...draft, amount: "1250", note: "к ужину" }));
    const ticket = store.beginSaving();
    store.fail(ticket, "Сервер семьи недоступен.");
    expect(store.failed()).toMatchObject({ key: FOOD_KEY, status: "failed", failure: "Сервер семьи недоступен." });
    expect(store.isDirty()).toBe(true);
    // «Вернуться к черновику»: тот же адрес — тот же черновик и та же причина, уже в правке.
    const back = store.openEntry(FOOD_KEY, food);
    expect(back).toMatchObject({ status: "editing", failure: "Сервер семьи недоступен." });
    expect(back.draft).toMatchObject({ amount: "1250", note: "к ужину" });
    expect(store.failed()).toBeNull();
    // Первая же правка — новая попытка: причина прошлой уходит.
    store.update((draft) => ({ ...draft, amount: "1300" }));
    expect(store.current()?.failure).toBeNull();
    expect(listener).toHaveBeenCalled();
  });

  it("запись упала, когда в листе уже другой черновик: оба целы, и «Вернуться к черновику» находит первый", () => {
    const store = createEntryDraftStore();
    store.openEntry(FOOD_KEY, food);
    store.update((draft) => ({ ...draft, amount: "1250" }));
    const first = store.beginSaving();
    store.openEntry(PLUS_KEY, () => ({ ...food(), categoryId: "" }));
    store.update((draft) => ({ ...draft, amount: "70" }));
    store.fail(first, "Сервер семьи недоступен.");
    expect(store.current()?.draft.amount).toBe("70");
    expect(store.failed()).toMatchObject({ key: FOOD_KEY, failure: "Сервер семьи недоступен." });
    // «Не сохранять» для второго не трогает первый.
    store.clear();
    expect(store.failed()?.key).toBe(FOOD_KEY);
    expect(store.openEntry(FOOD_KEY, food)).toMatchObject({ status: "editing", failure: "Сервер семьи недоступен." });
    expect(store.current()?.draft.amount).toBe("1250");
    expect(store.failed()).toBeNull();
    // «Начать новую» забывает не записанный — и только его.
    const again = store.beginSaving();
    store.fail(again, "Сервер семьи недоступен.");
    store.discardFailed();
    expect(store.failed()).toBeNull();
    expect(store.current()).toBeNull();
  });

  it("смена вида на «Оформить возврат» — новый снимок; «Не сохранять» — черновика нет", () => {
    const store = createEntryDraftStore();
    store.openEntry(FOOD_KEY, food);
    store.update((draft) => ({ ...draft, amount: "1250" }));
    store.replace({ ...food(), mode: "refund", amount: "500" });
    expect(store.isDirty()).toBe(false);
    expect(store.current()?.draft.mode).toBe("refund");
    store.clear();
    expect(store.current()).toBeNull();
    expect(store.isDirty()).toBe(false);
  });
});
