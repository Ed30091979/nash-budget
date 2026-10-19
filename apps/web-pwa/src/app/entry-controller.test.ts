import { makePlanningSeed, PLANNING_IDS, SEED_IDS, type BudgetState } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import type { ToastMessage } from "../components/Toast";
import { draftFromTransaction, newEntryDraft, type EntryDraft } from "../features/entry/entry-model";
import { routeKey, withoutSheet, type Route } from "../navigation/routes";
import { BudgetWriteRefusal, WRITE_REFUSAL_TEXT } from "../write-refusal";
import type { BudgetChange, BudgetWriter } from "../write/useBudgetWrite";
import { createEntryController } from "./entry-controller";
import { createEntryDraftStore } from "./entry-draft-store";

const MAIN = SEED_IDS.accounts.main;
const FOOD = PLANNING_IDS.categories.food;
const TODAY = "2026-07-13";
const SHEET: Route = { name: "overview", sheet: "entry", op: "expense", dst: FOOD };

const plain = (text: string) => text.replace(/[\u00a0\u202f]/gu, " ");

/** Оболочка в миниатюре: бюджет, маршрут, тосты и писатель, который отвечает тем, что ему велели. */
function harness(fails: () => unknown = () => null) {
  let budget: BudgetState = makePlanningSeed();
  let route: Route = SHEET;
  let id = 0;
  const redirects: Route[] = [];
  const navigations: Route[] = [];
  const toasts: Omit<ToastMessage, "key">[] = [];
  const writes: BudgetChange[] = [];
  const pending: (() => void)[] = [];
  let hold = false;
  const write: BudgetWriter = {
    run: (change) => {
      writes.push(change);
      const finish = () => {
        const failure = fails();
        if (failure !== null) throw failure;
        budget = change(budget);
        return budget;
      };
      if (!hold) return Promise.resolve().then(finish);
      return new Promise((resolve, reject) => {
        pending.push(() => {
          try { resolve(finish()); } catch (error) { reject(error); }
        });
      });
    },
  };
  const store = createEntryDraftStore();
  const controller = createEntryController({
    store,
    write,
    current: () => budget,
    route: () => route,
    redirect: (next) => { redirects.push(next); route = next; },
    navigate: (next) => { navigations.push(next); route = next; },
    showToast: (toast) => { toasts.push(toast); },
    makeId: () => `e3000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
  });
  const open = (draft: EntryDraft, at: Route = SHEET) => {
    route = at;
    store.openEntry(routeKey(at), () => draft);
  };
  return {
    store, controller, toasts, redirects, navigations, writes,
    budget: () => budget,
    open,
    holdWrites: () => { hold = true; },
    releaseWrites: () => {
      hold = false;
      for (const next of pending.splice(0)) next();
    },
  };
}

const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
const food = (amount = "1250"): EntryDraft => ({ ...newEntryDraft(makePlanningSeed(), { kind: "expense", accountId: MAIN, categoryId: FOOD }, TODAY), amount });

describe("запись из листа ввода", () => {
  it("«Записать»: лист закрывается сразу, черновик с этой секунды не «несохранённый», итог — тост с числом и «Отменить»", async () => {
    const shell = harness();
    shell.open(food());
    shell.holdWrites();
    expect(shell.controller.submit(shell.store.current()!.draft)).toBeNull();
    // Синхронно, до первого ответа координатора: лист закрыт, черновик записывается.
    expect(shell.redirects).toEqual([withoutSheet(SHEET)]);
    expect(shell.store.current()?.status).toBe("saving");
    expect(shell.store.isDirty()).toBe(false);
    // Второе нажатие, пока запись летит, — не вторая запись.
    expect(shell.controller.submit(food())).toBeNull();
    shell.releaseWrites();
    await settle();
    expect(shell.writes).toHaveLength(1);
    expect(shell.store.current()).toBeNull();
    const toast = shell.toasts[0]!;
    expect(plain(toast.text)).toBe("Записано: расход 1 250 ₽");
    expect(toast.detail).toBeDefined();
    expect(toast.action?.label).toBe("Отменить");
    const written = shell.budget().transactions.length;
    toast.action?.run();
    await settle();
    expect(shell.budget().transactions).toHaveLength(written - 1);
    expect(plain(shell.toasts[1]!.text)).toBe("Отменено: расход 1 250 ₽");
  });

  it("отказ домена — в листе: лист остаётся, ничего не записано", () => {
    // Пустую категорию лист ловит раньше (`submitCheck`); здесь — то, что видит только домен.
    const shell = harness();
    shell.open(food());
    expect(shell.controller.submit({ ...food(), occurredOn: "2026-02-30" })).toBe("Выберите существующую календарную дату.");
    expect(shell.redirects).toEqual([]);
    expect(shell.writes).toEqual([]);
    expect(shell.store.current()?.status).toBe("editing");
  });

  it("неудача записи: «Не записано: …» с «Вернуться к черновику», и лист открывается с тем же черновиком", async () => {
    const shell = harness(() => new BudgetWriteRefusal("held"));
    shell.open({ ...food(), note: "к ужину" });
    expect(shell.controller.submit(shell.store.current()!.draft)).toBeNull();
    await settle();
    expect(shell.store.failed()).toMatchObject({ key: routeKey(SHEET), failure: WRITE_REFUSAL_TEXT.held });
    const toast = shell.toasts[0]!;
    expect(toast.text).toBe(`Не записано: ${WRITE_REFUSAL_TEXT.held}`);
    expect(toast.action?.label).toBe("Вернуться к черновику");
    toast.action?.run();
    expect(shell.navigations).toEqual([SHEET]);
    expect(shell.store.openEntry(routeKey(SHEET), food).draft.note).toBe("к ужину");
  });

  it("правка: «Изменено», а «Отменить» возвращает операцию как была", async () => {
    const shell = harness();
    const expense = shell.budget().transactions.find((item) => item.kind === "expense")!;
    const opening = draftFromTransaction(shell.budget(), expense);
    if (opening.kind !== "draft") throw new Error("expense must open as a draft");
    const at: Route = { name: "operations", sheet: "entry", edit: expense.id };
    shell.open(opening.draft, at);
    expect(shell.controller.submit({ ...opening.draft, amount: "999" })).toBeNull();
    await settle();
    expect(shell.redirects).toEqual([{ name: "operations" }]);
    expect(plain(shell.toasts[0]!.text)).toBe("Изменено: расход 999 ₽");
    expect(shell.budget().transactions.find((item) => item.id === expense.id)?.amountMinor).toBe(99_900);
    shell.toasts[0]!.action?.run();
    await settle();
    expect(shell.budget().transactions.find((item) => item.id === expense.id)).toEqual(expense);
  });

  it("«Удалить»: лист закрывается, тост с «Отменить» возвращает операцию", async () => {
    const shell = harness();
    const expense = shell.budget().transactions.find((item) => item.kind === "expense")!;
    shell.open(food(), { name: "operations", sheet: "entry", edit: expense.id });
    await expect(shell.controller.remove(expense)).resolves.toBeNull();
    expect(shell.budget().transactions.some((item) => item.id === expense.id)).toBe(false);
    expect(shell.redirects).toEqual([{ name: "operations" }]);
    expect(shell.store.current()).toBeNull();
    expect(shell.toasts[0]!.text.startsWith("Удалено: расход")).toBe(true);
    shell.toasts[0]!.action?.run();
    await settle();
    const back = shell.budget().transactions.find((item) => item.kind === "expense" && item.amountMinor === expense.amountMinor && item.occurredOn === expense.occurredOn);
    expect(back).toBeDefined();
  });

  it("курс из листа: неверный — словами, верный — записан тем же путём", async () => {
    const shell = harness();
    await expect(shell.controller.saveRate({ currency: "RUB", date: TODAY, rate: { baseMinor: 1, quoteMinor: 1 } })).resolves.not.toBeNull();
    expect(shell.writes).toEqual([]);
    await expect(shell.controller.saveRate({ currency: "USD", date: TODAY, rate: { baseMinor: 9_250, quoteMinor: 100 } })).resolves.toBeNull();
    expect(shell.budget().exchangeRates?.some((rate) => rate.currency === "USD")).toBe(true);
  });
});
