import { makePlanningSeed, PLANNING_IDS, SEED_IDS, type BudgetState, type Transaction } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import { localToday } from "../../reach";
import { missingRateMessage, OperationsValidationError } from "../operations/model";
import { createEntryDraftStore } from "../../app/entry-draft-store";
import {
  blankEntryDraft,
  dateChoice,
  draftFromTransaction,
  draftReady,
  effectLine,
  foreignValue,
  foreignValueLine,
  frequentTags,
  GOAL_EDIT_REFUSAL,
  needsArrivedAmount,
  newEntryDraft,
  refundDraftFor,
  sheetTitle,
  submitLabel,
  switchMode,
  tagRoom,
  writeEntry,
  yesterdayOf,
  type EntryDraft,
} from "./entry-model";

const MAIN = SEED_IDS.accounts.main;
const RESERVE = "22222222-2222-4222-8222-222222222222";
const DOLLARS = "e1000000-0000-4000-8000-0000000000d1";
const SALARY = "e1000000-0000-4000-8000-0000000000c1";
const TAG_HOME = "e1000000-0000-4000-8000-0000000000a1";
const TAG_TRIP = "e1000000-0000-4000-8000-0000000000a2";
const TODAY = "2026-07-13";

/** G-002 с долларовым счётом, источником дохода и двумя метками. */
function state(): BudgetState {
  const seed = makePlanningSeed();
  return {
    ...seed,
    accounts: [...seed.accounts, { id: DOLLARS, name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 74_400, active: true }],
    categories: [...seed.categories, { id: SALARY, name: "Зарплата", type: "income", group: "income", active: true, sortOrder: 100 }],
    tags: [{ id: TAG_HOME, name: "Дом", active: true }, { id: TAG_TRIP, name: "Отпуск", active: true }],
  };
}

function ids(): () => string {
  let next = 1;
  return () => `e9000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

function written(result: { readonly state: BudgetState; readonly transactionId: string }): Transaction {
  return result.state.transactions.find((item) => item.id === result.transactionId)!;
}

describe("лист ввода: виды 2b", () => {
  it("расход с плитки категории — с выбранного или основного счёта; запись одним изменением", () => {
    const draft: EntryDraft = { ...newEntryDraft(state(), { kind: "expense", accountId: null, categoryId: PLANNING_IDS.categories.food }, TODAY), amount: "1200+50" };
    expect(draft).toMatchObject({ mode: "expense", accountId: MAIN, categoryId: PLANNING_IDS.categories.food, occurredOn: TODAY });
    expect(draftReady(state(), draft)).toBe(true);
    expect(submitLabel(state(), draft)).toBe("Записать 1\u00a0250\u00a0₽");
    expect(sheetTitle(state(), draft)).toBe("Расход: Основной → Продукты");
    expect(written(writeEntry(state(), draft, ids()))).toMatchObject({ kind: "expense", amountMinor: 125_000, accountId: MAIN, categoryId: PLANNING_IDS.categories.food });
    // Счёт с плитки — тот, что выбран.
    expect(newEntryDraft(state(), { kind: "expense", accountId: RESERVE, categoryId: PLANNING_IDS.categories.food }, TODAY).accountId).toBe(RESERVE);
  });

  it("доход с плитки источника на счёт — и без категории (D-026)", () => {
    const draft = { ...newEntryDraft(state(), { kind: "income", categoryId: SALARY, accountId: MAIN }, TODAY), amount: "80000" };
    expect(sheetTitle(state(), draft)).toBe("Доход: Зарплата → Основной");
    expect(written(writeEntry(state(), draft, ids()))).toMatchObject({ kind: "income", amountMinor: 8_000_000, categoryId: SALARY });
    const bare = { ...newEntryDraft(state(), { kind: "income", categoryId: null, accountId: MAIN }, TODAY), amount: "100" };
    expect(sheetTitle(state(), bare)).toBe("Доход: Без категории → Основной");
    expect(Object.hasOwn(written(writeEntry(state(), bare, ids())), "categoryId")).toBe(false);
  });

  it("перевод со счёта на счёт; между валютами — с суммой зачисления", () => {
    const draft = { ...newEntryDraft(state(), { kind: "transfer", fromAccountId: MAIN, toAccountId: RESERVE }, TODAY), amount: "5000" };
    expect(needsArrivedAmount(state(), draft)).toBe(false);
    expect(written(writeEntry(state(), draft, ids()))).toMatchObject({ kind: "transfer", fromAccountId: MAIN, toAccountId: RESERVE, amountMinor: 500_000 });
    const toDollars = { ...draft, toAccountId: DOLLARS };
    expect(needsArrivedAmount(state(), toDollars)).toBe(true);
    expect(() => writeEntry(state(), toDollars, ids())).toThrow(expect.objectContaining({ field: "toAmount" }));
    expect(written(writeEntry(state(), { ...toDollars, toAmount: "54,05" }, ids()))).toMatchObject({ toAmountMinor: 5_405 });
    // Перевод на тот же счёт не готов к записи.
    expect(draftReady(state(), { ...draft, toAccountId: MAIN })).toBe(false);
  });

  it("возврат оформляется из правки расхода: тот же счёт, та же сумма, не раньше самого расхода", () => {
    const base = state();
    const expense = base.transactions.find((item): item is Extract<Transaction, { kind: "expense" }> => item.kind === "expense" && item.categoryId === PLANNING_IDS.categories.food)!;
    const refund = refundDraftFor(expense, base, TODAY);
    expect(refund).toMatchObject({ mode: "refund", accountId: expense.accountId, originalTransactionId: expense.id, amount: "22000", occurredOn: TODAY });
    expect(refundDraftFor(expense, base, "2026-07-01").occurredOn).toBe(expense.occurredOn);
    expect(sheetTitle(base, refund)).toBe("Возврат: Продукты → Основной");
    const result = written(writeEntry(base, { ...refund, amount: "1500" }, ids()));
    expect(result).toMatchObject({ kind: "refund", amountMinor: 150_000, categoryId: PLANNING_IDS.categories.food, originalTransactionId: expense.id });
  });

  it("правка: черновик из операции и «Сохранить»; долг и взнос в цель — отказ словами", () => {
    const base = state();
    const expense = base.transactions.find((item) => item.kind === "expense")!;
    const opening = draftFromTransaction(base, expense);
    expect(opening.kind).toBe("draft");
    if (opening.kind !== "draft") return;
    expect(opening.draft).toMatchObject({ mode: "expense", editId: expense.id, amount: "45000" });
    expect(submitLabel(base, opening.draft)).toBe("Сохранить");
    expect(sheetTitle(base, opening.draft)).toBe("Изменить: расход: Основной → Жильё");
    // Правка уже учтена в остатках: строка «останется» её не вычитает второй раз.
    expect(effectLine(base, opening.draft, TODAY)).toBeNull();
    const edited = writeEntry(base, { ...opening.draft, amount: "44000", note: "аренда" }, ids());
    expect(edited.transactionId).toBe(expense.id);
    expect(written(edited)).toMatchObject({ amountMinor: 4_400_000, note: "аренда" });
    const goal: Transaction = { id: "e1000000-0000-4000-8000-0000000000f1", kind: "goal_contribution", status: "posted", occurredOn: TODAY, amountMinor: 100, fromAccountId: MAIN, toAccountId: RESERVE, goalId: "x" };
    expect(draftFromTransaction(base, goal)).toEqual({ kind: "refused", message: GOAL_EDIT_REFUSAL, transaction: goal });
    const debt: Transaction = { id: "e1000000-0000-4000-8000-0000000000f2", kind: "debt_out", status: "posted", occurredOn: TODAY, amountMinor: 100, accountId: MAIN, debtId: "y" };
    expect(draftFromTransaction(base, debt)).toMatchObject({ kind: "refused", message: "Операцию по долгу этот лист пока не изменяет." });
  });

  it("правка операции «в ожидании» или черновика оставляет её такой: статус не становится «проведена»", () => {
    // Ревью 2b, MEDIUM-1: черновик правки статуса не нёс, и запись делала её проведённой — правка
    // одного комментария двигала «Потрачено». До 2b `draftFromTransaction` статус переносил.
    const base = state();
    const posted = base.transactions.find((item) => item.kind === "expense")!;
    for (const status of ["pending", "draft"] as const) {
      const waiting = { ...posted, status };
      const budget = { ...base, transactions: base.transactions.map((item) => (item.id === posted.id ? waiting : item)) };
      const opening = draftFromTransaction(budget, waiting);
      if (opening.kind !== "draft") throw new Error("expense must open as a draft");
      expect(written(writeEntry(budget, { ...opening.draft, note: "сверено" }, ids()))).toMatchObject({ status, note: "сверено" });
    }
    // Новая операция с листа — проведённая, как и прежде.
    expect(written(writeEntry(base, { ...newEntryDraft(base, { kind: "expense", accountId: MAIN, categoryId: PLANNING_IDS.categories.food }, TODAY), amount: "100" }, ids())).status).toBe("posted");
  });

  it("смена вида на месте оставляет сумму, дату, комментарий и метки", () => {
    const draft: EntryDraft = { ...blankEntryDraft(state(), "expense", TODAY), amount: "300", note: "кофе", tagIds: [TAG_HOME], occurredOn: "2026-07-12" };
    const income = switchMode(state(), draft, "income");
    expect(income).toMatchObject({ mode: "income", amount: "300", note: "кофе", tagIds: [TAG_HOME], occurredOn: "2026-07-12", accountId: MAIN });
    const transfer = switchMode(state(), income, "transfer");
    expect(transfer).toMatchObject({ mode: "transfer", accountId: MAIN, toAccountId: RESERVE, amount: "300" });
    expect(blankEntryDraft(state(), "expense", TODAY)).toMatchObject({ mode: "expense", accountId: MAIN, categoryId: "" });
    expect(draftReady(state(), { ...blankEntryDraft(state(), "expense", TODAY), amount: "10" })).toBe(false);
  });
});

describe("лист ввода: другая валюта", () => {
  const dollarExpense = (): EntryDraft => ({ ...newEntryDraft(state(), { kind: "expense", accountId: DOLLARS, categoryId: PLANNING_IDS.categories.food }, TODAY), amount: "12,50" });

  it("без курса — понятный отказ и строка без выдуманной цифры", () => {
    expect(foreignValue(state(), dollarExpense())).toEqual({ kind: "missing", currency: "USD", baseCurrency: "RUB", date: TODAY });
    expect(foreignValueLine(foreignValue(state(), dollarExpense()))).toBeNull();
    let refusal: unknown;
    try {
      writeEntry(state(), dollarExpense(), ids());
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(OperationsValidationError);
    expect(refusal).toMatchObject({ field: "baseAmount", message: missingRateMessage("USD", "RUB", TODAY) });
    expect(submitLabel(state(), dollarExpense())).toBe("Записать 12,50\u00a0$");
  });

  it("с курсом дня — «≈ 1 157 ₽ по курсу 92,50 от 1 июля», и запись несёт снимок", () => {
    const priced: BudgetState = {
      ...state(),
      exchangeRates: [{ id: "e1000000-0000-4000-8000-0000000000e1", currency: "USD", baseCurrency: "RUB", date: "2026-07-01", rate: { baseMinor: 9_250, quoteMinor: 100 } }],
    };
    const value = foreignValue(priced, dollarExpense());
    expect(value).toMatchObject({ kind: "rate", baseMinor: 115_625 });
    expect(foreignValueLine(value)).toBe("≈ 1\u00a0156,25\u00a0₽ по курсу 92,50 от 1\u00a0июля");
    expect(written(writeEntry(priced, dollarExpense(), ids()))).toMatchObject({ amountMinor: 1_250, baseAmountMinor: 115_625 });
    // Строка «останется» считает в базовой валюте по той же оценке.
    expect(effectLine(priced, dollarExpense(), TODAY)).toBe("В категории «Продукты» останется 6\u00a0843,75\u00a0₽ из 30\u00a0000\u00a0₽");
  });

  it("правка: оценка — та, что запишется: свой курс операции, пока день и счёт те же; новый день — курс нового дня", () => {
    // Ревью 2b, MEDIUM-2: $10 по 92,50 (925 ₽), позже добавлен курс 100,00. Лист говорил
    // «≈ 1 000 ₽ по курсу 100,00», а записывал 925 ₽; без курса — «Курса нет», а запись проходила.
    const rate = (id: string, date: string, baseMinor: number) => ({ id, currency: "USD", baseCurrency: "RUB", date, rate: { baseMinor, quoteMinor: 100 } });
    const recorded = writeEntry({ ...state(), exchangeRates: [rate("e1000000-0000-4000-8000-0000000000e1", "2026-07-01", 9_250)] }, { ...dollarExpense(), amount: "10" }, ids());
    const bought = written(recorded);
    expect(bought).toMatchObject({ baseAmountMinor: 92_500 });
    const later: BudgetState = { ...recorded.state, exchangeRates: [...(recorded.state.exchangeRates ?? []), rate("e1000000-0000-4000-8000-0000000000e2", "2026-07-05", 10_000)] };
    const opening = draftFromTransaction(later, bought);
    if (opening.kind !== "draft") throw new Error("expense must open as a draft");
    const edit = { ...opening.draft, note: "сверено" };
    const value = foreignValue(later, edit);
    expect(value).toMatchObject({ kind: "kept", baseMinor: 92_500 });
    expect(foreignValueLine(value)).toBe("≈ 925\u00a0₽ по курсу 92,50, с которым операция записана");
    expect(written(writeEntry(later, edit, ids()))).toMatchObject({ baseAmountMinor: 92_500 });
    // Курсы удалили: оценка та же, и запись проходит — лист не говорит «курса нет».
    const noRates: BudgetState = { ...later, exchangeRates: [] };
    expect(foreignValue(noRates, edit)).toMatchObject({ kind: "kept", baseMinor: 92_500 });
    expect(written(writeEntry(noRates, edit, ids()))).toMatchObject({ baseAmountMinor: 92_500 });
    // Новый день — курс нового дня, и лист называет причину.
    const moved = { ...edit, occurredOn: "2026-07-06" };
    const movedValue = foreignValue(later, moved);
    expect(movedValue).toMatchObject({ kind: "rate", baseMinor: 100_000, changed: true });
    expect(foreignValueLine(movedValue)).toBe("≈ 1\u00a0000\u00a0₽ по курсу 100,00 от 5\u00a0июля — дата или счёт изменились, курс нового дня");
    expect(written(writeEntry(later, moved, ids()))).toMatchObject({ baseAmountMinor: 100_000 });
    // Без курса на новый день — «курса нет», и запись отказывает теми же словами.
    expect(foreignValue(noRates, moved)).toMatchObject({ kind: "missing" });
  });

  it("сумма в рублях вручную — точный курс «сумма за сумму», курс не нужен", () => {
    const manual = { ...dollarExpense(), baseAmount: "1157" };
    expect(foreignValue(state(), manual)).toEqual({ kind: "manual", baseMinor: 115_700, baseCurrency: "RUB" });
    expect(written(writeEntry(state(), manual, ids()))).toMatchObject({ baseAmountMinor: 115_700, rate: { baseMinor: 115_700, quoteMinor: 1_250 } });
    // Обратно в лист — та же вписанная сумма, а не курс.
    const opening = draftFromTransaction(state(), written(writeEntry(state(), manual, ids())));
    expect(opening.kind === "draft" ? opening.draft.baseAmount : null).toBe("1157");
  });
});

describe("лист ввода: комментарий и метки", () => {
  it("«+ метка» создаёт метку той же записью; тёзка активной — та же метка, а не вторая", () => {
    const draft: EntryDraft = { ...newEntryDraft(state(), { kind: "expense", accountId: MAIN, categoryId: PLANNING_IDS.categories.food }, TODAY), amount: "500", note: " Пятёрочка ", tagIds: [TAG_HOME], newTags: ["Дача", "отпуск"] };
    const result = writeEntry(state(), draft, ids());
    const created = result.state.tags?.find((tag) => tag.name === "Дача");
    expect(created).toBeDefined();
    expect(result.state.tags).toHaveLength(3);
    expect(written(result)).toMatchObject({ note: "Пятёрочка", tagIds: [TAG_HOME, TAG_TRIP, created!.id].sort() });
    expect(() => writeEntry(state(), { ...draft, newTags: ["\u202e"] }, ids())).toThrow(expect.objectContaining({ field: "tagIds" }));
    expect(tagRoom({ ...draft, tagIds: [TAG_HOME, TAG_TRIP] })).toBe(10 - 2 - 2);
  });

  it("частые метки — по числу операций, только активные", () => {
    const base = state();
    const used: BudgetState = {
      ...base,
      tags: [...(base.tags ?? []), { id: "e1000000-0000-4000-8000-0000000000a3", name: "Архив", active: false }],
      transactions: base.transactions.map((item, index) => (index < 2 ? { ...item, tagIds: [TAG_TRIP] } : item)),
    };
    expect(frequentTags(used).map((tag) => tag.name)).toEqual(["Отпуск", "Дом"]);
    expect(frequentTags(used, 1).map((tag) => tag.name)).toEqual(["Отпуск"]);
  });
});

describe("лист ввода: «Сегодня» и «Вчера» по местному календарю", () => {
  it("вчера — день календаря перед сегодня, через границы месяца и года", () => {
    expect(yesterdayOf("2026-03-01")).toBe("2026-02-28");
    expect(yesterdayOf("2024-03-01")).toBe("2024-02-29");
    expect(yesterdayOf("2026-01-01")).toBe("2025-12-31");
    expect(dateChoice("2026-07-13", "2026-07-13")).toBe("today");
    expect(dateChoice("2026-07-12", "2026-07-13")).toBe("yesterday");
    expect(dateChoice("2026-07-10", "2026-07-13")).toBe("other");
  });

  it("сегодня — по часам семьи, а не по UTC: поздний вечер остаётся своим днём", () => {
    // Местные 23:30 и 00:10 — свои числа, как бы ни лёг на них UTC.
    expect(localToday(new Date(2026, 9, 19, 23, 30))).toBe("2026-10-19");
    expect(localToday(new Date(2026, 9, 20, 0, 10))).toBe("2026-10-20");
    expect(yesterdayOf(localToday(new Date(2026, 9, 20, 0, 10)))).toBe("2026-10-19");
  });
});

describe("лист ввода: что станет после записи", () => {
  it("в категории с лимитом месяца — остаток лимита; без лимита и у дохода — остаток счёта", () => {
    const expense = { ...newEntryDraft(state(), { kind: "expense", accountId: MAIN, categoryId: PLANNING_IDS.categories.food }, TODAY), amount: "1250" };
    expect(effectLine(state(), expense, TODAY)).toBe("В категории «Продукты» останется 6\u00a0750\u00a0₽ из 30\u00a0000\u00a0₽");
    expect(effectLine(state(), { ...expense, amount: "9000" }, TODAY)).toBe("В категории «Продукты» будет перелимит 1\u00a0000\u00a0₽ при лимите 30\u00a0000\u00a0₽");
    // «Жильё» без лимита: остаток счёта (G-002: 180 000 − 45 000 − 22 000 − 4 000 = 109 000).
    const housing = { ...expense, categoryId: PLANNING_IDS.categories.housing };
    expect(effectLine(state(), housing, TODAY)).toBe("На счёте «Основной» останется 107\u00a0750\u00a0₽");
    const income = { ...newEntryDraft(state(), { kind: "income", categoryId: SALARY, accountId: MAIN }, TODAY), amount: "1000" };
    expect(effectLine(state(), income, TODAY)).toBe("На счёте «Основной» станет 110\u00a0000\u00a0₽");
    // Дату ещё набирают — строки нет, лист стоит.
    expect(effectLine(state(), { ...expense, occurredOn: "" }, TODAY)).toBeNull();
  });
});

describe("черновик вне листа", () => {
  it("переживает закрытие листа и неудачную запись, а «грязно» — только против снимка открытия", () => {
    const store = createEntryDraftStore();
    const init = () => newEntryDraft(state(), { kind: "expense", accountId: MAIN, categoryId: PLANNING_IDS.categories.food }, TODAY);
    const opened = store.openEntry("#/?sheet=entry", init);
    expect(store.isDirty()).toBe(false);
    store.update((draft) => ({ ...draft, amount: "100" }));
    expect(store.isDirty()).toBe(true);
    // Записать: с этой секунды не «несохранённый», и правка в полёте не принимается.
    const ticket = store.beginSaving();
    expect(store.isDirty()).toBe(false);
    store.update((draft) => ({ ...draft, amount: "999" }));
    expect(store.current()?.draft.amount).toBe("100");
    store.fail(ticket, "Сервер семьи недоступен.");
    expect(store.failed()).toMatchObject({ status: "failed", failure: "Сервер семьи недоступен.", draft: { amount: "100" } });
    expect(store.isDirty()).toBe(true);
    // «Вернуться к черновику» — то же открытие: тот же черновик и снимок.
    const back = store.openEntry("#/?sheet=entry", init);
    expect(back.draft.amount).toBe("100");
    expect(back.pristine).toEqual(opened.pristine);
    expect(store.current()?.status).toBe("editing");
    // Удача снимает черновик; другое открытие — новый черновик.
    const second = store.beginSaving();
    store.succeed(second);
    expect(store.current()).toBeNull();
    store.openEntry("#/?sheet=entry", init);
    store.update((draft) => ({ ...draft, amount: "5" }));
    expect(store.openEntry("#/operations?sheet=entry", init).draft.amount).toBe("");
  });
});
