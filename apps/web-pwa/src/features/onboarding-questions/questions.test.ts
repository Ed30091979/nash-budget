/// <reference types="node" />
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { categoryNameKey, householdPaydays, setHouseholdPaydays, type BudgetState } from "@family-budget/domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CategoriesQuestion } from "./CategoriesQuestion";
import { buildOnboardingBudgetState } from "../../onboarding/model";
import {
  createFirstRunMemory,
  createFirstRunStore,
  EMPTY_FIRST_RUN,
  FIRST_RUN_DATABASE,
  readFirstRunState,
  type FirstRunState,
} from "./memory";
import {
  applyCategoryChoice,
  beginFirstRun,
  categoryChips,
  CHIP_LOCK_WORDS,
  initialChoice,
  LATER_RETURN_DAYS,
  markAnswered,
  markAsked,
  markLater,
  nextQuestion,
  OFFERED_SUGGESTIONS,
  PAYDAY_OPTIONS,
  paydayAnswer,
  toggleCustomPayday,
} from "./questions-model";

const TODAY = "2026-10-19";

function preset(): BudgetState {
  let next = 0;
  return buildOnboardingBudgetState({ today: TODAY, makeId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` });
}

const activeExpense = (state: BudgetState) => state.categories.filter((item) => item.type === "expense" && item.active).map((item) => item.name);

describe("вопросы первого запуска: какой задать сейчас", () => {
  it("по одному и по порядку: категории, места для денег, дни выплат — и только после набора на этом устройстве", () => {
    expect(nextQuestion(EMPTY_FIRST_RUN, TODAY)).toBeNull();
    let state = beginFirstRun(TODAY);
    expect(state).toMatchObject({ startedOn: TODAY, coach: "pending", closedHints: [] });
    expect(nextQuestion(state, TODAY)).toBe("categories");
    state = markAnswered(state, "categories", TODAY);
    expect(nextQuestion(state, TODAY)).toBe("accounts");
    state = markLater(state, "accounts", TODAY);
    expect(nextQuestion(state, TODAY)).toBe("payday");
    state = markAnswered(state, "payday", TODAY);
    expect(nextQuestion(state, TODAY)).toBeNull();
  });

  it("показанный, но не отвеченный («спрошен») возвращается — его закрыли перезагрузкой", () => {
    const asked = markAsked(beginFirstRun(TODAY), "categories", TODAY);
    expect(asked.questions.categories?.status).toBe("asked");
    expect(nextQuestion(asked, TODAY)).toBe("categories");
    // «Спрошен» ставится только на свежий вопрос: отвеченный так и остаётся отвеченным.
    const answered = markAnswered(asked, "categories", TODAY);
    expect(markAsked(answered, "categories", TODAY)).toBe(answered);
  });

  it("отвеченный не возвращается никогда; отложенный — один раз, через неделю; отложенный дважды — больше нет", () => {
    let state = markAnswered(markAnswered(beginFirstRun("2026-10-01"), "categories", "2026-10-01"), "accounts", "2026-10-01");
    state = markLater(state, "payday", "2026-10-01");
    expect(state.questions.payday).toEqual({ status: "later", on: "2026-10-01", postponed: 1 });
    expect(LATER_RETURN_DAYS).toBe(7);
    expect(nextQuestion(state, "2026-10-07")).toBeNull();
    expect(nextQuestion(state, "2026-10-08")).toBe("payday");
    state = markLater(state, "payday", "2026-10-08");
    expect(state.questions.payday?.postponed).toBe(2);
    expect(nextQuestion(state, "2027-10-08")).toBeNull();
    // Ответ после повтора закрывает вопрос так же, как с первого раза.
    expect(nextQuestion(markAnswered(markLater(beginFirstRun(TODAY), "categories", TODAY), "categories", "2026-10-30"), "2027-01-01")).toBe("accounts");
  });
});

describe("«На что вы тратите?»: чипы и что делает «Готово»", () => {
  it("частые — одиннадцать категорий набора в порядке листа, «Прочего» нет; «Добавить» — три стартовые и три подсказки", () => {
    const chips = categoryChips(preset());
    expect(chips.frequent.map((chip) => chip.name)).toEqual([
      "Продукты", "Кафе и доставка", "Транспорт", "Дом и хозяйство", "Жильё", "ЖКХ", "Связь и подписки",
      "Здоровье и аптека", "Одежда и обувь", "Развлечения и хобби", "Подарки и праздники",
    ]);
    expect(chips.more.map((chip) => [chip.name, chip.source])).toEqual([
      ["Кредиты и рассрочки", "archived"], ["Дети", "archived"], ["Красота и уход", "archived"],
      ["Автомобиль", "suggestion"], ["Питомцы", "suggestion"], ["Отпуск и поездки", "suggestion"],
    ]);
    expect(OFFERED_SUGGESTIONS).toEqual(["Автомобиль", "Питомцы", "Отпуск и поездки"]);
    expect([...initialChoice(chips)]).toEqual(chips.frequent.map((chip) => chip.key));
    // У каждого чипа свой глиф и тон — те же, что у плитки на «Обзоре».
    expect(chips.frequent.find((chip) => chip.name === "Продукты")).toMatchObject({ icon: "shopping-basket", tone: "mint" });
  });

  it("«Готово» без правок ничего не меняет", () => {
    const state = preset();
    const chips = categoryChips(state);
    expect(applyCategoryChoice(state, chips, initialChoice(chips))).toBe(state);
  });

  it("неотмеченные частые — в архив, отмеченные архивные — обратно, отмеченные подсказки — заводятся; «Прочее» на месте", () => {
    const state = preset();
    const chips = categoryChips(state);
    const chosen = new Set(initialChoice(chips));
    chosen.delete(categoryNameKey("Жильё"));
    chosen.delete(categoryNameKey("Одежда и обувь"));
    chosen.add(categoryNameKey("Дети"));
    chosen.add(categoryNameKey("Питомцы"));
    let id = 100;
    const next = applyCategoryChoice(state, chips, chosen, () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`);
    const names = activeExpense(next);
    expect(names).not.toContain("Жильё");
    expect(names).not.toContain("Одежда и обувь");
    expect(names).toEqual(expect.arrayContaining(["Дети", "Питомцы", "Прочее", "Продукты"]));
    expect(names).toHaveLength(12);
    // Архив — та же строка, а не удаление; возврат — та же строка, а не тёзка.
    expect(next.categories.find((item) => item.name === "Жильё")?.active).toBe(false);
    expect(next.categories.filter((item) => item.name === "Дети")).toHaveLength(1);
    expect(next.categories.find((item) => item.name === "Питомцы")).toMatchObject({ type: "expense", group: "everyday", active: true });
    // И следующий лист показывает выбор таким, каким его оставили.
    const after = categoryChips(next);
    expect(after.frequent.map((chip) => chip.name)).toContain("Дети");
    expect(after.more.map((chip) => chip.name)).toEqual(expect.arrayContaining(["Жильё", "Одежда и обувь"]));
  });

  it("своя категория, заведённая в листе «Своя категория», встаёт в частые — значит, отмеченной", () => {
    const state = preset();
    const own = { ...state, categories: [...state.categories, { id: "00000000-0000-4000-8000-000000000999", name: "Рыбалка", type: "expense" as const, group: "personal" as const, active: true, sortOrder: 999 }] };
    const chips = categoryChips(own);
    expect(chips.frequent.at(-1)?.name).toBe("Рыбалка");
    expect(initialChoice(chips).has(categoryNameKey("Рыбалка"))).toBe(true);
  });
});

describe("лист чипов, показанный снова через неделю: что снять уже нельзя (ревью R2, L-7)", () => {
  function lived(): BudgetState {
    const state = preset();
    const id = (name: string) => state.categories.find((item) => item.name === name)!.id;
    const budget = state.budgets[0]!;
    return {
      ...state,
      budgets: [{ ...budget, lines: [{ id: "00000000-0000-4000-8000-0000000000a1", categoryId: id("Транспорт"), plannedMinor: 1_000_000 }] }],
      scheduledExpenses: [{ id: "00000000-0000-4000-8000-0000000000a2", name: "Интернет", categoryId: id("Связь и подписки"), accountId: state.accounts[0]!.id, amountMinor: 70_000, dueDay: 10, mode: "monthly", active: true }],
      transactions: [{ id: "00000000-0000-4000-8000-0000000000a3", kind: "expense", status: "posted", occurredOn: TODAY, amountMinor: 50_000, accountId: state.accounts[0]!.id, categoryId: id("Продукты") }],
    };
  }

  it("категория с записями, лимитом или регулярным платежом отмечена и заперта, с пометкой почему", () => {
    const chips = categoryChips(lived());
    const lockOf = (name: string) => chips.frequent.find((chip) => chip.name === name)?.locked;
    expect(lockOf("Продукты")).toBe("records");
    expect(lockOf("Транспорт")).toBe("limit");
    expect(lockOf("Связь и подписки")).toBe("payment");
    expect(lockOf("Жильё")).toBeNull();
    expect(chips.more.every((chip) => chip.locked === null)).toBe(true);
    expect(CHIP_LOCK_WORDS).toEqual({ records: "есть записи", limit: "есть лимит", payment: "есть платёж" });
  });

  it("«Готово» без отметки на запертых их не трогает: лимит открытого месяца жив, записи — на месте", () => {
    const state = lived();
    const chips = categoryChips(state);
    const chosen = new Set(initialChoice(chips));
    for (const name of ["Продукты", "Транспорт", "Связь и подписки", "Жильё"]) chosen.delete(categoryNameKey(name));
    const next = applyCategoryChoice(state, chips, chosen);
    for (const name of ["Продукты", "Транспорт", "Связь и подписки"]) expect(activeExpense(next), name).toContain(name);
    expect(activeExpense(next)).not.toContain("Жильё");
    expect(next.budgets[0]!.lines[0]!.active).not.toBe(false);
  });

  it("на листе запертый чип нажат и недоступен, пометка — словами", () => {
    const markup = renderToStaticMarkup(createElement(CategoriesQuestion, { budget: lived(), write: { run: async (change) => change({} as BudgetState) }, onAnswered: () => undefined, onLater: () => undefined, onCustom: () => undefined }));
    expect(markup.match(/aria-pressed="true" aria-disabled="true"/gu)).toHaveLength(3);
    expect(markup).toContain('<small class="q-chip-lock"><span class="sr-only">, </span>есть записи</small>');
    expect(markup).toContain("есть лимит</small>");
  });
});

describe("«Когда приходит зарплата?»: ответ листа", () => {
  it("варианты 04: четыре пары, «Другие числа» и «Нет постоянной»", () => {
    expect(PAYDAY_OPTIONS.map((item) => item.label)).toEqual(["5-го и 20-го", "10-го и 25-го", "15-го и 30-го", "1-го и 15-го", "Другие числа", "Нет постоянной"]);
    expect(paydayAnswer(null, [])).toBeUndefined();
    expect(paydayAnswer("5-20", [])).toEqual([5, 20]);
    expect(paydayAnswer("15-30", [])).toEqual([15, 30]);
    expect(paydayAnswer("none", [])).toBeNull();
    expect(paydayAnswer("custom", [])).toBeUndefined();
    expect(paydayAnswer("custom", [25, 3])).toEqual([3, 25]);
  });

  it("«Другие числа»: до четырёх, по возрастанию, повторное касание снимает", () => {
    let days: readonly number[] = [];
    for (const day of [20, 5, 31, 1, 15]) days = toggleCustomPayday(days, day);
    expect(days).toEqual([1, 5, 20, 31]);
    expect(toggleCustomPayday(days, 5)).toEqual([1, 20, 31]);
  });

  it("ответ ложится в household.paydays, «Нет постоянной» снимает поле", () => {
    const state = preset();
    const named = setHouseholdPaydays(state, paydayAnswer("10-25", [])!);
    expect(householdPaydays(named)).toEqual([10, 25]);
    expect(householdPaydays(setHouseholdPaydays(named, paydayAnswer("none", []) as null))).toEqual([]);
  });
});

const databases = new Set<string>();
function memory(label: string) {
  const name = `${FIRST_RUN_DATABASE}-${label}-${crypto.randomUUID()}`;
  databases.add(name);
  return createFirstRunMemory({ databaseName: name });
}
afterEach(async () => {
  await Promise.all([...databases].map((name) => new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  })));
  databases.clear();
});

describe("память первого запуска — IndexedDB этого устройства", () => {
  it("своя база, не localStorage: записанное читается обратно, «Удалить данные» стирает", async () => {
    const store = memory("roundtrip");
    expect(await store.load()).toEqual(EMPTY_FIRST_RUN);
    const state: FirstRunState = { ...markLater(beginFirstRun(TODAY), "accounts", TODAY), coach: "done", closedHints: ["backup"] };
    await store.save(state);
    expect(await memory("other").load()).toEqual(EMPTY_FIRST_RUN);
    expect(await store.load()).toEqual(state);
    await store.clear();
    expect(await store.load()).toEqual(EMPTY_FIRST_RUN);
    expect(FIRST_RUN_DATABASE).toBe("family-budget-first-run");
    const source = readFileSync(new URL("./memory.ts", import.meta.url), "utf8");
    expect(source).toContain("indexedDB.open(name, VERSION)");
    expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "")).not.toMatch(/localStorage|sessionStorage/u);
  });

  it("хранилище сессии: правка видна сразу, на диск уходит следом, перечитанное не перетирает новое", async () => {
    const disk = memory("store");
    const store = createFirstRunStore(disk);
    expect(store.snapshot()).toBeNull();
    let notified = 0;
    store.subscribe(() => { notified += 1; });
    await store.replace(beginFirstRun(TODAY));
    store.load();
    await store.update((current) => markAnswered(current, "categories", TODAY));
    expect(store.snapshot()?.questions.categories?.status).toBe("answered");
    expect(notified).toBe(2);
    expect((await disk.load()).questions.categories?.status).toBe("answered");
    await store.clear();
    expect(store.snapshot()).toEqual(EMPTY_FIRST_RUN);
    expect(await disk.load()).toEqual(EMPTY_FIRST_RUN);
  });

  it("чужое и испорченное с диска забывается, а не роняет «Обзор»", () => {
    expect(readFirstRunState(null)).toEqual(EMPTY_FIRST_RUN);
    expect(readFirstRunState("x")).toEqual(EMPTY_FIRST_RUN);
    expect(readFirstRunState({
      startedOn: "вчера",
      questions: { categories: { status: "maybe", on: TODAY }, payday: { status: "later", on: TODAY, postponed: -1 }, __proto__: { x: 1 } },
      coach: "sometimes",
      closedHints: ["backup", "unknown", 5],
    })).toEqual({ startedOn: null, budgetId: null, questions: { payday: { status: "later", on: TODAY, postponed: 0 } }, coach: null, closedHints: ["backup"] });
    // Привязка к месяцу плана — только идентификатор: чужая строка забывается.
    expect(readFirstRunState({ budgetId: "00000000-0000-4000-8000-000000000042" }).budgetId).toBe("00000000-0000-4000-8000-000000000042");
    expect(readFirstRunState({ budgetId: "../etc" }).budgetId).toBeNull();
  });
});
