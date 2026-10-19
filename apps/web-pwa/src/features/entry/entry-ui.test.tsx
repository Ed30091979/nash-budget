import { makePlanningSeed, PLANNING_IDS, SEED_IDS, type BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WRITE_REFUSAL_TEXT } from "../../write-refusal";
import { handleDialogKeyboard } from "../data-management/dialog-accessibility";
import { RateQuickSheet } from "../rates/RateQuickSheet";
import { EntrySheet, isolateSiblings, RefusedEntrySheet, type EntrySheetProps } from "./EntrySheet";
import { blankEntryDraft, draftFromTransaction, newEntryDraft, submitCheck, type EntryDraft } from "./entry-model";
import { FromToTiles } from "./FromToTiles";
import { TargetPicker } from "./TargetPicker";

const MAIN = SEED_IDS.accounts.main;
const DOLLARS = "e2000000-0000-4000-8000-0000000000d1";
const TODAY = "2026-07-13";

function state(): BudgetState {
  const seed = makePlanningSeed();
  return {
    ...seed,
    accounts: [...seed.accounts, { id: DOLLARS, name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 74_400, active: true }],
    tags: [{ id: "e2000000-0000-4000-8000-0000000000a1", name: "Дом", active: true }],
  };
}

function render(draft: EntryDraft, overrides: Partial<EntrySheetProps> = {}): string {
  const props: EntrySheetProps = {
    budget: state(),
    draft,
    today: TODAY,
    balances: { [MAIN]: 10_900_000 },
    modeSwitch: false,
    failure: null,
    writeRefusal: null,
    editing: null,
    onChange: vi.fn(),
    onRefund: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(() => null),
    onDelete: vi.fn(async () => null),
    onSaveRate: vi.fn(async () => null),
    onCategoryChange: vi.fn(async () => undefined),
    isDirty: () => false,
    onDiscard: vi.fn(),
    fallbackFocus: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(<EntrySheet {...props} />);
}

const plain = (markup: string) => markup.replace(/<[^>]+>/gu, "").replace(/[\u00a0\u202f]/gu, " ");
const food = () => ({ ...newEntryDraft(state(), { kind: "expense", accountId: MAIN, categoryId: PLANNING_IDS.categories.food }, TODAY), amount: "1250" });

describe("лист ввода: разметка", () => {
  it("модальный диалог с именем «откуда → куда», «Закрыть» 48 и полем суммы, которое не просит системную клавиатуру", () => {
    const markup = render(food());
    expect(markup).toMatch(/<section class="sheet entry-sheet" role="dialog" aria-modal="true" aria-labelledby="entry-sheet-title" tabindex="-1">/u);
    expect(markup).toContain('<h2 id="entry-sheet-title" class="visually-hidden">Расход: Основной → Продукты</h2>');
    expect(markup).toContain('aria-label="Закрыть"');
    // Сумма без рамки, с подписью для диктора и знаком валюты рядом с числом (5.0, макет 07).
    expect(markup).toMatch(/<label for="entry-amount" class="visually-hidden">Сумма, ₽<\/label><div class="entry-amount-row"><input id="entry-amount" inputMode="none"[^>]*><span class="entry-amount-sign" aria-hidden="true">₽<\/span><\/div>/u);
    // Плашка «останется»: под суммой, глиф и строка; поле описано ею.
    expect(markup).toContain('aria-describedby="entry-state"');
    expect(markup).toMatch(/<div class="entry-state normal" id="entry-state"><svg[^>]*aria-hidden="true"[^>]*><use href="#glyph-circle-check"><\/use><\/svg><p><span class="entry-effect" id="entry-effect">В категории «Продукты» останется/u);
    expect(markup).not.toMatch(/<input id="entry-amount"[^>]*readonly/u);
    const text = plain(markup);
    expect(text).toContain("В категории «Продукты» останется 6 750 ₽ из 30 000 ₽");
    expect(text).toContain("Записать 1 250 ₽");
  });

  it("плашка «останется»: почти лимит — словом и треугольником, перелимит — кругом и словом в строке, остаток счёта — кошельком", () => {
    // 24 000 из 30 000 — ровно порог 80 %: уже «почти», как у плитки «Обзора» (`limitStatus`).
    const near = render({ ...food(), amount: "2000" });
    expect(near).toMatch(/<div class="entry-state near" id="entry-state"><svg[^>]*><use href="#glyph-triangle-alert"><\/use><\/svg><p><b>Почти лимит:<\/b> <span class="entry-effect" id="entry-effect">В категории «Продукты» останется 6[\u00a0 ]000/u);
    const over = render({ ...food(), amount: "9000" });
    expect(over).toMatch(/<div class="entry-state over" id="entry-state"><svg[^>]*><use href="#glyph-circle-alert"><\/use><\/svg><p><span class="entry-effect" id="entry-effect">В категории «Продукты» будет перелимит 1[\u00a0 ]000/u);
    const income = render({ ...newEntryDraft(state(), { kind: "income", accountId: MAIN, categoryId: null }, TODAY), amount: "500" });
    expect(income).toMatch(/<div class="entry-state account" id="entry-state"><svg[^>]*><use href="#glyph-wallet"><\/use><\/svg><p><span class="entry-effect" id="entry-effect">На счёте «Основной» станет/u);
  });

  it("клавиатура: тот же набор клавиш с «÷», четыре колонки, кнопка записи — своей строкой под ней", () => {
    const markup = render(food());
    expect(markup).toContain('role="group" aria-label="Клавиатура суммы"');
    for (const name of ["Стереть", "Плюс", "Минус", "Разделить", "Запятая"]) expect(markup).toContain(`aria-label="${name}"`);
    expect(markup).toMatch(/<\/div><button class="primary-button wide entry-submit" type="submit"/u);
    // Ни одного текстового глифа в роли иконки: стирание — глиф спрайта.
    expect(markup).toContain("#glyph-delete");
  });

  it("дата — «Сегодня / Вчера / другой день», комментарий справа налево и метки чипами 48", () => {
    const markup = render(food());
    expect(markup).toMatch(/<button class="chip" type="button" aria-pressed="true"><span class="chip-face">Сегодня<\/span><\/button>/u);
    expect(markup).toMatch(/aria-pressed="false"><span class="chip-face">Вчера<\/span>/u);
    expect(markup).toContain(">Другой день<");
    expect(markup).toMatch(/<input id="entry-note" dir="auto" autoComplete="off" maxLength="500"/u);
    expect(markup).toMatch(/<legend class="visually-hidden">Метки<\/legend>/u);
    expect(markup).toContain('<bdi dir="auto">Дом</bdi>');
    // Метка — глиф «#» и имя; «+ метка» — глиф «+», а имя кнопки — по-прежнему «+ метка».
    expect(markup).toContain('#glyph-hash');
    expect(plain(markup)).toContain("+ метка");
    expect(render({ ...food(), occurredOn: "2026-07-01" })).toMatch(/aria-pressed="true" aria-expanded="true" aria-controls="entry-date"><span class="chip-face">1[\u00a0 ]июля<\/span>/u);
  });

  it("с «+» вид выбирают в листе; с плитки — он уже назван", () => {
    const blank = render(blankEntryDraft(state(), "expense", TODAY), { modeSwitch: true });
    expect(blank).toContain('role="group" aria-label="Вид операции"');
    for (const word of ["Расход", "Доход", "Перевод"]) expect(blank).toContain(`<span class="chip-face">${word}</span>`);
    expect(blank).toContain('aria-label="В категорию: категория не выбрана. Изменить"');
    expect(render(food())).toContain('<p class="eyebrow sheet-kind" aria-hidden="true">Расход</p>');
  });

  it("счёт в другой валюте без курса — лист говорит это до записи и предлагает выход", () => {
    const dollars = { ...newEntryDraft(state(), { kind: "expense", accountId: DOLLARS, categoryId: PLANNING_IDS.categories.food }, TODAY), amount: "12,50" };
    const markup = render(dollars);
    expect(markup).toMatch(/<label for="entry-amount" class="visually-hidden">Сумма, \$<\/label>/u);
    const text = plain(markup);
    expect(text).toContain("Курса USD на день операции нет: оценить её в RUB нечем.");
    expect(text).toContain("Задать курс");
    expect(text).toContain("Сумма в RUB вручную");
    expect(text).toContain("Записать 12,50 $");
    // Знака рубля в сумме долларовой покупки нет нигде.
    expect(/12,50[\u00a0 ]₽/u.test(text)).toBe(false);
  });

  it("«Задать курс» — группа внутри формы листа, а не вторая форма: Enter и кнопка записывают курс сами", () => {
    // Ревью 2b, HIGH-1: вложенная форма в Chromium отправлялась браузером мимо обработчика, и курс
    // не записывался. Форма в листе одна; путь в браузере проверяет e2e `foreign.spec.ts`.
    const quick = renderToStaticMarkup(<RateQuickSheet currency="USD" baseCurrency="RUB" date={TODAY} onSave={vi.fn(async () => null)} onCancel={vi.fn()} />);
    expect(quick).not.toContain("<form");
    expect(quick).toMatch(/^<div class="rate-quick" role="group" aria-labelledby="[^"]+">/u);
    expect(quick).toMatch(/<button class="primary-button" type="button"[^>]*>Сохранить курс<\/button>/u);
    expect(quick).not.toContain('type="submit"');
    const sheet = render({ ...newEntryDraft(state(), { kind: "expense", accountId: DOLLARS, categoryId: PLANNING_IDS.categories.food }, TODAY), amount: "12,50" });
    expect(sheet.match(/<form[\s>]/gu)).toHaveLength(1);
  });

  it("правка: «Сохранить», «Удалить» и у расхода — «Оформить возврат»; не записанный черновик — тревогой", () => {
    const budget = state();
    const expense = budget.transactions.find((item) => item.kind === "expense")!;
    const opening = draftFromTransaction(budget, expense);
    if (opening.kind !== "draft") throw new Error("expense must open as a draft");
    const markup = render(opening.draft, { editing: expense, failure: "Сервер семьи недоступен." });
    const text = plain(markup);
    expect(text).toContain("Сохранить");
    expect(text).toContain("Удалить");
    expect(text).toContain("Оформить возврат");
    expect(markup).toMatch(/<div class="write-refusal" role="alert">[\s\S]*Не записано:[\s\S]*Сервер семьи недоступен\./u);
    expect(markup).not.toMatch(/\sstyle=/u);
  });

  it("долг и взнос в цель лист не правит: отказ словами и только «Удалить»", () => {
    const budget = state();
    const debt = { id: "e2000000-0000-4000-8000-0000000000f2", kind: "debt_out" as const, status: "posted" as const, occurredOn: TODAY, amountMinor: 100, accountId: MAIN, debtId: "e2000000-0000-4000-8000-0000000000f3" };
    const markup = renderToStaticMarkup(<RefusedEntrySheet budget={budget} transaction={debt} message="Операцию по долгу этот лист пока не изменяет." onClose={vi.fn()} onDelete={vi.fn(async () => null)} fallbackFocus={vi.fn()} />);
    expect(markup).toContain('role="dialog" aria-modal="true"');
    expect(plain(markup)).toContain("Операцию по долгу этот лист пока не изменяет. Удалить её можно.");
    expect(markup).not.toContain('id="entry-amount"');
  });
});

describe("имена на плитках листа (ревью 2b, раунд 3, NEW-2)", () => {
  const SOFT = "\u00ad";
  const labels = (markup: string) => [...markup.matchAll(/aria-label="([^"]*)"/gu)].map((match) => match[1]!);
  const names = (markup: string, className: string) => [...markup.matchAll(new RegExp(`<span class="${className}"( aria-hidden="true")?><bdi dir="auto">([^<]*)</bdi>`, "gu"))]
    .map((match) => ({ hidden: match[1] !== undefined, text: match[2]! }));

  it("выбор стороны: имя с мягкими переносами и скрыто от диктора, доступное имя — целое", () => {
    const budget = state();
    const categories = renderToStaticMarkup(<TargetPicker budget={budget} draft={blankEntryDraft(budget, "expense", TODAY)} side="to" balances={{}} onPick={vi.fn()} onBack={vi.fn()} onCreate={vi.fn()} />);
    const shown = names(categories, "tile-name");
    expect(shown.length).toBeGreaterThan(5);
    expect(shown.every((name) => name.hidden)).toBe(true);
    expect(shown.find((name) => name.text.replaceAll(SOFT, "") === "Транспорт")?.text).toBe(`Тра${SOFT}н${SOFT}с${SOFT}порт`);
    expect(labels(categories)).toContain("Транспорт");
    expect(labels(categories).filter((label) => label.includes(SOFT))).toEqual([]);

    const accounts = renderToStaticMarkup(<TargetPicker budget={budget} draft={blankEntryDraft(budget, "expense", TODAY)} side="from" balances={{ [MAIN]: 10_900_000 }} onPick={vi.fn()} onBack={vi.fn()} />);
    expect(labels(accounts).map((label) => label.replace(/[\u00a0\u202f]/gu, " "))).toContain("Основной: остаток 109 000 ₽");
    expect(names(accounts, "tile-name").every((name) => name.hidden)).toBe(true);
    expect(accounts).toMatch(/<span class="tile-sum" aria-hidden="true">/u);
  });

  it("«откуда → куда»: имя с мягкими переносами только для глаза; у возврата — группа с целым именем", () => {
    const budget = state();
    const tiles = renderToStaticMarkup(<FromToTiles budget={budget} draft={food()} balances={{ [MAIN]: 10_900_000 }} onPick={vi.fn()} />);
    expect(names(tiles, "endpoint-name")).toEqual([{ hidden: true, text: `Ос${SOFT}но${SOFT}в${SOFT}ной` }, { hidden: true, text: `Про${SOFT}ду${SOFT}к${SOFT}ты` }]);
    expect(labels(tiles)).toEqual(["Со счёта: Основной. Изменить", "В категорию: Продукты. Изменить"]);
    const expense = budget.transactions.find((item) => item.kind === "expense" && item.categoryId === PLANNING_IDS.categories.food);
    if (expense === undefined || expense.kind !== "expense") throw new Error("the seed has a food expense");
    const refund = renderToStaticMarkup(<FromToTiles budget={budget} draft={{ ...food(), mode: "refund", originalTransactionId: expense.id }} balances={{}} onPick={vi.fn()} />);
    expect(refund).toMatch(/<div class="endpoint fixed" role="group" aria-label="Возврат из категории: Продукты"><span class="endpoint-plate tone-[a-z]+"/u);
    expect(refund).toMatch(/role="group" aria-label="Возврат из категории: Продукты"/u);
    expect(labels(refund).filter((label) => label.includes(SOFT))).toEqual([]);
  });
});

describe("лист ввода: поведение без браузера", () => {
  it("документ семьи задержан — «Записать» отвечает словами задержки, лист и черновик остаются", () => {
    const refusal = WRITE_REFUSAL_TEXT.held;
    expect(submitCheck(state(), food(), refusal)).toEqual({ kind: "refused", message: refusal });
    expect(submitCheck(state(), food(), null)).toEqual({ kind: "write" });
    expect(submitCheck(state(), { ...food(), amount: "" }, null)).toEqual({ kind: "incomplete", message: "Введите сумму." });
    expect(submitCheck(state(), { ...blankEntryDraft(state(), "expense", TODAY), amount: "5" }, null)).toEqual({ kind: "incomplete", message: "Выберите категорию." });
  });

  // Ревью 2b: это не лист, а `handleDialogKeyboard`, которым лист ловит фокус, — на подставных
  // элементах. Сам лист в браузере держит фокус в e2e `entry.spec.ts` («лист держит фокус: Tab ходит
  // внутри…») и `accessibility.spec.ts`.
  it("handleDialogKeyboard листа: Tab с последней цели — на первую, Shift+Tab с первой — на последнюю, Esc — закрыть (подставные элементы)", () => {
    const focused: string[] = [];
    const target = (name: string) => ({ focus: () => { focused.push(name); } });
    const first = target("Закрыть");
    const last = target("Записать");
    let active: unknown = last;
    const sheet = { ownerDocument: { get activeElement() { return active; } }, contains: () => true, focus: () => undefined, querySelectorAll: () => [first, target("сумма"), last] };
    const key = (name: string, shiftKey = false) => ({ key: name, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    handleDialogKeyboard(key("Tab"), sheet, true, vi.fn());
    active = first;
    handleDialogKeyboard(key("Tab", true), sheet, true, vi.fn());
    expect(focused).toEqual(["Закрыть", "Записать"]);
    const close = vi.fn();
    handleDialogKeyboard(key("Escape"), sheet, true, close);
    expect(close).toHaveBeenCalledOnce();
  });

  it("пока лист открыт, всё рядом с ним выключено из обхода и дерева доступности — и возвращается как было", () => {
    const attributes = (initial: Record<string, string>) => {
      const values = new Map(Object.entries(initial));
      return {
        values,
        hasAttribute: (name: string) => values.has(name),
        getAttribute: (name: string) => values.get(name) ?? null,
        setAttribute: (name: string, value: string) => { values.set(name, value); },
        removeAttribute: (name: string) => { values.delete(name); },
      };
    };
    const header = attributes({});
    const nav = attributes({ "aria-hidden": "false" });
    const sheet = { parentElement: null as unknown };
    const parent = { children: [header, sheet, nav] };
    sheet.parentElement = parent;
    const restore = isolateSiblings(sheet as unknown as Pick<HTMLElement, "parentElement">);
    expect(header.values.get("inert")).toBe("");
    expect(nav.values.get("aria-hidden")).toBe("true");
    restore();
    expect(header.values.has("inert")).toBe(false);
    expect(header.values.has("aria-hidden")).toBe(false);
    expect(nav.values.get("aria-hidden")).toBe("false");
  });
});
