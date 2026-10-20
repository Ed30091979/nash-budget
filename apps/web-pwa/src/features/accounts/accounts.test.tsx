import {
  AccountValidationError,
  makePlanningSeed,
  PLANNING_IDS,
  SEED_IDS,
  calculateBudget,
  type BudgetState,
} from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BudgetWriteRefusal } from "../../write-refusal";
import { BUDGET_WRITE_CONFLICT_MESSAGE } from "../../app/budget-store";
import {
  accountDraftDiffers,
  accountDraftOf,
  accountEstimate,
  accountFormError,
  accountOffset,
  accountPatch,
  accountSave,
  accountsList,
  accountsTotal,
  blankAccountDraft,
  currencyLock,
  minorToInput,
  parseOpening,
  totalRateWords,
  type AccountFormDraft,
} from "./account-model";
import { AccountFormView, AccountScreen } from "./AccountScreen";
import { AccountsScreen, accountRowLabel } from "./AccountsScreen";

const MAIN = SEED_IDS.accounts.main;
const SAVINGS = SEED_IDS.accounts.savings;
const DOLLARS = "e2c00000-0000-4000-8000-0000000000d1";
const ARCHIVED = "e2c00000-0000-4000-8000-0000000000d2";
const TODAY = "2026-07-20";

const RATE_ID = "e2c00000-0000-4000-8000-0000000000a1";

/** Тот же бюджет с курсом доллара: 92,50 ₽ с 15 июля. */
function withRate(budget: BudgetState): BudgetState {
  return { ...budget, exchangeRates: [{ id: RATE_ID, currency: "USD", baseCurrency: "RUB", date: "2026-07-15", rate: { baseMinor: 9_250, quoteMinor: 100 } }] };
}

function state(): BudgetState {
  const seed = makePlanningSeed();
  return {
    ...seed,
    accounts: [
      ...seed.accounts,
      { id: DOLLARS, name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 50_000, active: true, color: "lilac", icon: "dollar-sign" },
      { id: ARCHIVED, name: "Старая карта", type: "current", currency: "RUB", openingBalanceMinor: 120_000, active: false, includeInTotal: false },
    ],
  };
}

const ids = (...list: string[]) => {
  let index = 0;
  return () => list[index++] ?? `e2c00000-0000-4000-8000-00000000${String(index).padStart(4, "0")}`;
};

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return accountFormError(error);
  }
  return null;
};

describe("форма счёта: модель", () => {
  it("новый счёт — в базовой валюте, карта, без остатка, в итоге и с видом «Авто»", () => {
    expect(blankAccountDraft(state())).toEqual({ name: "", type: "current", currency: "RUB", opening: "", negative: false, icon: null, tone: null, includeInTotal: true });
  });

  it("записанный счёт — в форму: остаток без разрядов, долг — минусом в поле, ключи — только известные", () => {
    const dollars = state().accounts.find((account) => account.id === DOLLARS)!;
    expect(accountDraftOf(dollars)).toEqual({ name: "Доллары", type: "cash", currency: "USD", opening: "500", negative: false, icon: "dollar-sign", tone: "lilac", includeInTotal: true });
    // Долг — минусом в самом поле, отметка снята: набранное поверх число заменяет и знак (ревью R3, M-1).
    expect(accountDraftOf({ ...dollars, openingBalanceMinor: -125_050, icon: "coins-stack", color: "toString" })).toMatchObject({ opening: "\u22121250,50", negative: false, icon: null, tone: null });
    expect(minorToInput(1_234_567, "RUB")).toBe("12345,67");
    expect(minorToInput(1500, "JPY")).toBe("1500");
    expect(minorToInput(1_000, "KWD")).toBe("1");
    expect(minorToInput(1_005, "KWD")).toBe("1,005");
  });

  it("начальный остаток: пусто и ноль — ноль, запятая и точка, знаки по валюте, минус — отметкой или в поле", () => {
    const opening = (text: string, currency = "RUB", negative = false) => parseOpening({ opening: text, negative, currency });
    expect(opening("")).toEqual({ kind: "amount", minor: 0 });
    expect(opening("0,00")).toEqual({ kind: "amount", minor: 0 });
    expect(opening("12 500")).toEqual({ kind: "amount", minor: 1_250_000 });
    expect(opening("1250.5")).toEqual({ kind: "amount", minor: 125_050 });
    expect(opening("1250,5", "RUB", true)).toEqual({ kind: "amount", minor: -125_050 });
    expect(opening("−300")).toEqual({ kind: "amount", minor: -30_000 });
    expect(opening("1500", "JPY")).toEqual({ kind: "amount", minor: 1500 });
    expect(opening("1,5", "JPY")).toEqual({ kind: "error", message: "Введите положительную сумму целым числом." });
    expect(opening("12,345")).toEqual({ kind: "error", message: "Введите положительную сумму, не более двух знаков после запятой." });
    expect(opening("кофе").kind).toBe("error");
    expect(opening("100000001")).toEqual({ kind: "error", message: "Начальный остаток — сумма не больше ста миллионов по модулю." });
  });

  it("«грязно» — отличие от снимка при открытии: остаток сравнивается суммой, имя — без краевых пробелов", () => {
    const pristine = accountDraftOf(state().accounts.find((account) => account.id === MAIN)!);
    expect(accountDraftDiffers(pristine, pristine)).toBe(false);
    expect(accountDraftDiffers({ ...pristine, name: ` ${pristine.name} ` }, pristine)).toBe(false);
    expect(accountDraftDiffers({ ...pristine, opening: "0,00" }, { ...pristine, opening: "" })).toBe(false);
    expect(accountDraftDiffers({ ...pristine, opening: "10" }, pristine)).toBe(true);
    expect(accountDraftDiffers({ ...pristine, tone: "mint" }, pristine)).toBe(true);
    expect(accountDraftDiffers({ ...pristine, includeInTotal: false }, pristine)).toBe(true);
    expect(accountDraftDiffers({ ...pristine, opening: "кофе" }, pristine)).toBe(true);
  });

  it("правка — только изменённые поля: чужая правка другого поля остаётся той, что пришла", () => {
    const pristine = accountDraftOf(state().accounts.find((account) => account.id === MAIN)!);
    expect(accountPatch(pristine, pristine, 0)).toEqual({});
    expect(accountPatch({ ...pristine, name: "Зарплатная", tone: "mint", icon: "landmark" }, pristine, 0))
      .toEqual({ name: "Зарплатная", color: "mint", icon: "landmark" });
    expect(accountPatch({ ...pristine, tone: null }, { ...pristine, tone: "mint" }, 0)).toEqual({ color: null });
    expect(accountPatch(pristine, pristine, -500)).toEqual({ openingBalanceMinor: -500 });
    // «Сколько сейчас» правит остаток сегодня: начальный — набранное минус движения к сегодняшнему дню.
    const shown = { ...pristine, opening: "120" };
    expect(accountPatch(shown, { ...pristine, opening: "100" }, 12_000, 2_000)).toEqual({ openingBalanceMinor: 10_000 });
    expect(accountPatch({ ...pristine, opening: "100" }, { ...pristine, opening: "100" }, 10_000, 2_000)).toEqual({});
    // Другое устройство переименовало счёт, пока здесь меняли только цвет: имя остаётся пришедшим.
    const save = accountSave({ ...pristine, tone: "peach" }, { account: state().accounts[0]!, pristine });
    expect(save.kind).toBe("change");
    if (save.kind !== "change") return;
    const remote = { ...state(), accounts: state().accounts.map((account) => (account.id === MAIN ? { ...account, name: "Переименован там" } : account)) };
    const next = save.change(remote).accounts.find((account) => account.id === MAIN)!;
    expect(next).toMatchObject({ name: "Переименован там", color: "peach" });
  });

  it("новый счёт — через домен: в долларах, с иконкой и тоном, вне итога; состояние валидно", () => {
    const save = accountSave(
      { name: "Наличные $", type: "cash", currency: "USD", opening: "250", negative: false, icon: "dollar-sign", tone: "sage", includeInTotal: false },
      null,
      ids("e2c00000-0000-4000-8000-0000000000e1"),
    );
    expect(save.kind).toBe("change");
    if (save.kind !== "change") return;
    const next = save.change(state());
    expect(save.created()).toBe("e2c00000-0000-4000-8000-0000000000e1");
    expect(next.accounts.at(-1)).toEqual({
      id: "e2c00000-0000-4000-8000-0000000000e1", name: "Наличные $", type: "cash", currency: "USD", openingBalanceMinor: 25_000, active: true,
      sortOrder: expect.any(Number), icon: "dollar-sign", color: "sage", includeInTotal: false,
    });
    expect(() => calculateBudget(next)).not.toThrow();
  });

  it("отказы — словами поля: имя, дубль, остаток; задержка и конфликт — у формы", () => {
    const blank = blankAccountDraft(state());
    const run = (draft: AccountFormDraft) => {
      const save = accountSave(draft, null, ids());
      return save.kind === "error" ? save.error : refusal(() => save.change(state()));
    };
    expect(run(blank)).toEqual({ field: "name", message: "Укажите название счёта." });
    expect(run({ ...blank, name: "основной" })).toEqual({ field: "name", message: "Активный счёт с таким названием уже есть." });
    // Архивный тёзка — не дубль: его можно вернуть, а можно завести новый.
    expect(run({ ...blank, name: "Старая карта" })).toBeNull();
    expect(run({ ...blank, name: "Кошелёк", opening: "1,234" })).toEqual({ field: "opening", message: "Введите положительную сумму, не более двух знаков после запятой." });
    expect(run({ ...blank, name: "Кошелёк\u200b" })).toEqual({ field: "name", message: "Уберите скрытые или служебные символы." });
    expect(accountFormError(new AccountValidationError("currency_in_use", "currency", "x"))).toEqual({ field: "currency", message: "x" });
    expect(accountFormError(new BudgetWriteRefusal("held"))).toEqual({ field: "form", message: new BudgetWriteRefusal("held").userMessage });
    expect(accountFormError(new Error(BUDGET_WRITE_CONFLICT_MESSAGE))).toEqual({ field: "form", message: BUDGET_WRITE_CONFLICT_MESSAGE });
    expect(accountFormError(new Error("boom"))).toEqual({ field: "form", message: "Изменение не сохранилось. Повторите его." });
  });

  it("валюта заперта, пока на счёт ссылаются: операции — своими словами, цель и план — словами D-032", () => {
    const budget = state();
    const account = (id: string) => budget.accounts.find((item) => item.id === id)!;
    expect(currencyLock(budget, null)).toBeNull();
    expect(currencyLock(budget, account(DOLLARS))).toBeNull();
    expect(currencyLock(budget, account(MAIN))).toMatch(/^Валюту не сменить: по счёту есть операции и плановые платежи\. Цели и планы ведутся только в базовой валюте RUB\.$/u);
    expect(currencyLock(budget, account(SAVINGS))).toMatch(/цель/u);
    const spent = {
      ...budget,
      transactions: [...budget.transactions, { id: "e2c00000-0000-4000-8000-0000000000f1", kind: "expense" as const, status: "posted" as const, occurredOn: TODAY, amountMinor: 1_000, accountId: DOLLARS, categoryId: PLANNING_IDS.categories.food, baseAmountMinor: 92_50, baseCurrency: "RUB", rate: { baseMinor: 9_250, quoteMinor: 100 } }],
    };
    expect(currencyLock(spent, account(DOLLARS))).toBe("Валюту не сменить: по счёту есть операции. Суммы записаны в USD.");
  });

  it("«Сколько сейчас на счёте»: у записанного счёта — остаток сегодня; правка сдвигает начальный на разницу", () => {
    const budget = state();
    const main = budget.accounts.find((account) => account.id === MAIN)!;
    const offset = accountOffset(budget, main, TODAY);
    const balance = accountsList(budget, TODAY).active.find((row) => row.account.id === MAIN)!.balanceMinor!;
    expect(offset).toBe(balance - main.openingBalanceMinor);
    const pristine = accountDraftOf(main, offset);
    expect(parseOpening(pristine)).toEqual({ kind: "amount", minor: balance });
    // Набрали на 1 000 ₽ больше, чем сейчас: начальный остаток вырос на те же 1 000 ₽ — и только он.
    const save = accountSave({ ...pristine, opening: minorToInput(balance + 100_000, "RUB") }, { account: main, pristine, offsetMinor: offset });
    expect(save.kind).toBe("change");
    if (save.kind !== "change") return;
    const next = save.change(budget);
    expect(next.accounts.find((account) => account.id === MAIN)!.openingBalanceMinor).toBe(main.openingBalanceMinor + 100_000);
    expect(accountsList(next, TODAY).active.find((row) => row.account.id === MAIN)!.balanceMinor).toBe(balance + 100_000);
    // Нетронутое поле не пишет ничего: снимок и набранное совпали.
    const same = accountSave(pristine, { account: main, pristine, offsetMinor: offset });
    expect(same.kind === "change" ? same.change(budget).accounts : null).toEqual(budget.accounts);
  });

  it("«Всего на счетах»: итог в базе, курс, по которому оценена чужая валюта, и счета без курса — словами", () => {
    const without = accountsTotal(state(), TODAY);
    expect(without.base).toBe("RUB");
    expect(without.rates).toEqual([]);
    expect(without.unvalued).toEqual([{ name: "Доллары", currency: "USD" }]);
    const valued = accountsTotal(withRate(state()), TODAY);
    expect(valued.unvalued).toEqual([]);
    expect(valued.totalInBaseMinor).toBe(without.totalInBaseMinor + 4_625_000);
    expect(valued.rates.map(totalRateWords)).toEqual(["доллар — по курсу 92,50\u00a0₽ от 15\u00a0июля"]);
    // Строка счёта в чужой валюте — и в базе, по тому же курсу.
    expect(accountsList(withRate(state()), TODAY).active.find((row) => row.account.id === DOLLARS)).toMatchObject({ balanceMinor: 50_000, baseMinor: 4_625_000 });
    expect(accountRowLabel(accountsList(withRate(state()), TODAY).active.find((row) => row.account.id === DOLLARS)!)).toBe("Доллары: 500\u00a0$ (≈ 46\u00a0250\u00a0₽), наличные · USD. Изменить");
  });

  it("пересчёт набранного в базу: «≈ 111 000 ₽ по курсу 92,50 ₽ от 15 июля»; база и валюта без курса — без строки", () => {
    expect(accountEstimate(withRate(state()), "USD", 120_000, TODAY)).toEqual({ inBaseMinor: 11_100_000, words: "≈ 111\u00a0000\u00a0₽ по курсу 92,50\u00a0₽ от 15\u00a0июля" });
    expect(accountEstimate(withRate(state()), "RUB", 120_000, TODAY)).toBeNull();
    expect(accountEstimate(withRate(state()), "EUR", 120_000, TODAY)).toBeNull();
    // Курс задан позже дня — на сегодня его ещё нет.
    expect(accountEstimate(withRate(state()), "USD", 120_000, "2026-07-01")).toBeNull();
  });

  it("список: активные по порядку с местом, архив отдельно; остаток — в валюте счёта, на сегодня", () => {
    const list = accountsList(state(), TODAY);
    expect(list.active.map((row) => [row.account.name, row.position])).toEqual([["Основной", 1], ["Резерв платежей", 2], ["Доллары", 3]]);
    expect(list.archived.map((row) => row.account.name)).toEqual(["Старая карта"]);
    const dollars = list.active[2]!;
    expect(dollars).toMatchObject({ icon: "dollar-sign", tone: "lilac", balanceMinor: 50_000, baseMinor: null, meta: "Наличные · USD" });
    expect(list.archived[0]).toMatchObject({ meta: "Карта или счёт · вне итога", tone: null, icon: "credit-card" });
    // Код валюты — как его пишут и читают: «USD», а не «usd» (ревью 2c, LOW-7).
    expect(accountRowLabel(dollars)).toBe("Доллары: 500\u00a0$, наличные · USD. Изменить");
    expect(accountRowLabel(list.archived[0]!)).toMatch(/, карта или счёт · вне итога\. Изменить$/u);
  });
});

describe("счета: разметка", () => {
  const render = (budget = state()) => renderToStaticMarkup(
    <AccountsScreen budget={budget} today={TODAY} write={{ run: vi.fn() }} onBack={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />,
  );

  it("«‹ Ещё · Счета · +», «Всего на счетах», карточка строк, «Изменить порядок», архив с «Вернуть»; абзаца под заголовком нет", () => {
    const hyphenated = render(withRate(state()));
    // Имя строки для глаза — с мягкими переносами и скрыто от диктора; доступное имя строки — целое.
    expect(hyphenated).toMatch(/<span class="dir-copy" aria-hidden="true"><strong><bdi dir="auto">Ста\u00ad?р/u);
    expect([...hyphenated.matchAll(/aria-label="([^"]*)"/gu)].map((match) => match[1]).join(" ")).not.toContain("\u00ad");
    const markup = hyphenated.replace(/\u00ad/gu, "");
    expect(markup).toContain("<h1>Счета</h1>");
    // «Новый счёт» — действие строки заголовка: глиф «+» и имя словами.
    expect(markup).toContain('<div class="title-bar-action"><button class="icon-button" type="button" aria-label="Новый счёт">');
    expect(markup).not.toContain("manage-lead");
    expect(markup).not.toContain("Остаток каждого счёта — на сегодня");
    // Итог в базе крупно и курс, по которому оценены доллары (макет 11).
    expect(markup).toMatch(/<p class="dir-total-label">Всего на счетах<\/p><p class="dir-total-sum">/u);
    expect(markup).toContain("доллар — по курсу 92,50\u00a0₽ от 15\u00a0июля");
    // Строка — одна цель: имя, вид, остаток в валюте счёта и «≈ N ₽» у чужой валюты.
    expect(markup).toMatch(/<ul class="card dir-card" aria-label="Активные счета">/u);
    expect(markup).toMatch(/aria-label="Доллары: 500\u00a0\$ \(≈ 46\u00a0250\u00a0₽\), наличные · USD\. Изменить"/u);
    expect(markup).toMatch(/Доллары<\/bdi>[^]*?500<span class="money-currency">\u00a0\$<\/span>[^]*?<small>≈ /u);
    // «Выше / Ниже» у строк нет — порядок меняется отдельным режимом.
    expect(markup).not.toContain("— выше");
    expect(markup).toContain("Изменить порядок");
    expect(markup).toContain('href="#glyph-arrow-up-down"');
    expect(markup).toContain('aria-label="Вернуть «Старая карта» из архива"');
    expect(markup).toContain('<h2 id="accounts-archived-title" class="dir-kicker">В архиве</h2>');
    // Тон счёта — подложка глифа; без тона — тёмная, как плитка «Обзора».
    expect(markup).toContain('class="icon-plate dir-plate tone-lilac"');
    expect(markup).toContain('class="icon-plate dir-plate account-plate"');
    // Чужое имя изолировано от слов приложения.
    expect(markup).toContain('<bdi dir="auto">Старая карта</bdi>');
  });

  it("счёт без курса назван под итогом, а не выброшен молча; экран под листом — без строки состояния", () => {
    const markup = render();
    expect(markup).toMatch(/В итог не вошли: <span>«<bdi dir="auto">Доллары<\/bdi>» — нет курса USD<\/span>\./u);
    expect(markup).toContain('<p class="manage-status" role="status">');
    const under = renderToStaticMarkup(<AccountsScreen background budget={state()} today={TODAY} write={{ run: vi.fn() }} onBack={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(under).not.toContain('role="status"');
  });
});

describe("лист счёта: разметка", () => {
  const view = (overrides: Partial<Parameters<typeof AccountFormView>[0]> = {}) => {
    const budget = overrides.budget ?? state();
    const account = overrides.account === undefined ? budget.accounts.find((item) => item.id === DOLLARS)! : overrides.account;
    const pristine = account === null ? blankAccountDraft(budget) : accountDraftOf(account);
    return renderToStaticMarkup(
      <AccountFormView budget={budget} today={TODAY} account={account} draft={pristine} pristine={pristine} error={null} busy={false} onPatch={vi.fn()} {...overrides} />,
    );
  };

  it("разделы по порядку (макет 12): образец, название, вид 2×2, валюта чипами, «Сколько сейчас», цвет, значок, переключатель", () => {
    const markup = view({ account: null });
    const order = ['class="card dir-preview"', 'for="account-name"', '<legend class="dir-label">Вид</legend>', 'id="account-currency-label">Валюта', 'for="account-opening">Сколько сейчас на счёте', '<legend class="dir-label">Цвет</legend>', '<legend class="dir-label">Значок</legend>', "Считать во «Всего на счетах»"];
    const at = order.map((piece) => markup.indexOf(piece));
    expect(at.every((index) => index >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Вид — карточки с глифами; валюта — радиогруппа чипов без <select>.
    expect(markup).toMatch(/<input id="account-type-current" type="radio" name="[^"]+" checked="" value="current"\/><svg[^>]*><use href="#glyph-credit-card"/u);
    expect(markup).toContain('href="#glyph-piggy-bank"');
    expect(markup).not.toContain("<select");
    expect(markup).toContain('role="radio" aria-checked="true" aria-label="Рубль — RUB" tabindex="0"');
    expect(markup).toContain("Другая");
    // Переключатель — настоящая отметка с ролью переключателя.
    expect(markup).toMatch(/<input id="account-include" type="checkbox" role="switch" checked=""/u);
    // Новый счёт: подсказки о прошлом нет — сдвигать нечего.
    expect(markup).not.toContain("account-opening-hint");
  });

  it("правка: «Сколько сейчас» предупреждает о прошлом, а изменённое — называет сдвиг; запертая валюта говорит почему", () => {
    const budget = state();
    const main = budget.accounts.find((item) => item.id === MAIN)!;
    const pristine = accountDraftOf(main);
    const markup = view({ account: main, pristine, draft: { ...pristine, opening: "1500" } });
    expect(markup).toContain("Остаток считается от начального: правка сдвинет и остатки всех прошлых дней.");
    expect(markup).toMatch(/Остатки «<bdi dir="auto">Основной<\/bdi>» за все прошлые дни сдвинутся на <span class="money">\+1\u00a0500<span class="money-currency">\u00a0₽<\/span><\/span>/u);
    expect(markup).toMatch(/role="radiogroup" tabindex="-1" aria-labelledby="account-currency-label" aria-describedby="account-currency-lock" aria-disabled="true"/u);
    expect(markup).toContain("Цели и планы ведутся только в базовой валюте RUB.");
    expect(markup).not.toContain("Другая");
  });

  it("отказ у поля — рядом с ним и связан с ним; отказ формы — в подвале над «Сохранить»", () => {
    const named = view({ error: { field: "name", message: "Активный счёт с таким названием уже есть." } });
    expect(named).toMatch(/<input id="account-name"[^>]*aria-invalid="true" aria-describedby="account-name-error"/u);
    expect(named).toContain('<p class="field-error" id="account-name-error" role="alert">Активный счёт с таким названием уже есть.</p>');
    const budget = state();
    const sheet = renderToStaticMarkup(<AccountScreen budget={budget} today={TODAY} accountId={DOLLARS} write={{ run: vi.fn() }} onBack={vi.fn()} onDone={vi.fn()} />);
    expect(sheet).toMatch(/^<div class="sheet-backdrop dir-backdrop" role="presentation"><section class="sheet dir-sheet" role="dialog" aria-modal="true" aria-labelledby="account-sheet-title"/u);
    expect(sheet).toContain('<h1 id="account-sheet-title" tabindex="-1">Счёт</h1>');
    expect(sheet).toMatch(/<div class="dir-sheet-foot"><button class="primary-button wide dir-save" type="submit"( aria-busy="false")?>Сохранить<\/button><\/div>/u);
    // Архив — последним в теле листа, тихой красной строкой; удаления нет.
    expect(sheet).toMatch(/<section class="dir-archive" aria-label="Архив"><button id="account-archive" class="quiet-button dir-danger" type="button">/u);
    expect(sheet.indexOf("dir-archive")).toBeGreaterThan(sheet.indexOf("Считать во «Всего на счетах»"));
    expect(sheet.indexOf("dir-archive")).toBeLessThan(sheet.indexOf("dir-sheet-foot"));
    expect(sheet).not.toContain("Удалить");
    const fresh = renderToStaticMarkup(<AccountScreen budget={budget} today={TODAY} accountId={null} initialType="savings" write={{ run: vi.fn() }} onBack={vi.fn()} onDone={vi.fn()} />);
    expect(fresh).toContain('<h1 id="account-sheet-title" tabindex="-1">Новый счёт</h1>');
    expect(fresh).toMatch(/<input id="account-type-savings" type="radio" name="[^"]+" checked=""/u);
    expect(fresh).not.toContain("dir-archive");
  });

  it("счёт в другой валюте: пересчёт набранного в базу или слова о курсе; D-032 — одной строкой; запись — выключенные разделы", () => {
    const blank = blankAccountDraft(state());
    const markup = view({ account: null, draft: { ...blank, currency: "USD", opening: "1200" } });
    expect(markup).toContain("Счёт в USD: операции по нему запишутся и в RUB по курсу дня, а цели и платежи плана на нём не ведутся.");
    expect(markup).toContain("Курса USD на сегодня нет");
    expect(markup).toContain('<span class="sr-only">, $</span>');
    const valued = view({ budget: withRate(state()), account: null, draft: { ...blank, currency: "USD", opening: "1200" } });
    expect(valued).toContain('<p class="field-hint" id="account-opening-estimate">≈ 111\u00a0000\u00a0₽ по курсу 92,50\u00a0₽ от 15\u00a0июля</p>');
    const busy = view({ busy: true });
    expect(busy).toMatch(/<fieldset class="dir-options" disabled="">/u);
    expect(busy).toContain('<fieldset class="picker tone-picker" disabled="">');
  });
});

describe("тон и иконка счёта — на «Обзоре»", () => {
  it("плитка счёта несёт выбранные иконку и тон: квадрат его цвета; без тона — графитовый", async () => {
    const { overviewModel } = await import("../overview/overview-model");
    const { AccountTile } = await import("../../components/tiles/AccountTile");
    const tiles = overviewModel(state(), "2026-07", TODAY).accounts;
    const dollars = tiles.find((tile) => tile.id === DOLLARS)!;
    expect(dollars).toMatchObject({ icon: "dollar-sign", tone: "lilac", currency: "USD" });
    expect(tiles.find((tile) => tile.id === MAIN)).toMatchObject({ icon: "credit-card", tone: null });
    // Архивный счёт с «Обзора» уходит.
    expect(tiles.some((tile) => tile.id === ARCHIVED)).toBe(false);
    const markup = renderToStaticMarkup(<AccountTile tile={dollars} pressed={false} onPick={vi.fn()} />);
    expect(markup).toContain('<span class="tile-square tone-lilac" aria-hidden="true">');
    expect(markup).toContain('href="#glyph-dollar-sign"');
    const plain = renderToStaticMarkup(<AccountTile tile={tiles.find((tile) => tile.id === MAIN)!} pressed={false} onPick={vi.fn()} />);
    expect(plain).toContain('<span class="tile-square account" aria-hidden="true">');
  });
});

describe("ревью R3: «Сколько сейчас», имя строки в базе, глиф валюты", () => {
  const FOOD = PLANNING_IDS.categories.food;
  let serial = 0;
  const spend = (accountId: string, amountMinor: number, occurredOn: string, kind: "expense" | "income" = "expense") => ({
    id: `e2c00000-0000-4000-8000-${String(700_000_000_000 + serial++).padStart(12, "0")}`,
    kind,
    status: "posted" as const,
    occurredOn,
    amountMinor,
    accountId,
    // Доход без категории — законное состояние (D-026).
    ...(kind === "expense" ? { categoryId: FOOD } : {}),
  }) as BudgetState["transactions"][number];
  /** Основной счёт с начальным `opening` и операциями `transactions` — других движений нет. */
  const withMain = (opening: number, transactions: BudgetState["transactions"]): BudgetState => {
    const budget = state();
    return { ...budget, transactions, accounts: budget.accounts.map((account) => (account.id === MAIN ? { ...account, openingBalanceMinor: opening } : account)) };
  };
  const mainOf = (budget: BudgetState) => budget.accounts.find((account) => account.id === MAIN)!;
  const todayOf = (budget: BudgetState) => accountsList(budget, TODAY).active.find((row) => row.account.id === MAIN)!.balanceMinor;
  /** Лист открыт на сегодня: снимок формы и движений — как у `AccountScreen`. */
  const open = (budget: BudgetState) => {
    const account = mainOf(budget);
    const offsetMinor = accountOffset(budget, account, TODAY);
    const pristine = accountDraftOf(account, offsetMinor);
    return { account, offsetMinor, pristine, target: { account, pristine, offsetMinor, today: TODAY } };
  };

  it("M-1: долг сегодня −1 500 ₽ — в поле «−1500» без отметки «долг»; набранное заново 50 000 записывается плюсом", () => {
    const budget = withMain(0, [spend(MAIN, 150_000, "2026-07-10")]);
    expect(todayOf(budget)).toBe(-150_000);
    const { pristine, target } = open(budget);
    expect(pristine).toMatchObject({ opening: "−1500", negative: false });
    expect(parseOpening(pristine)).toEqual({ kind: "amount", minor: -150_000 });
    expect(accountDraftDiffers(pristine, pristine)).toBe(false);
    // Человек стёр поле и набрал остаток карты: знак ушёл вместе с прежним текстом.
    const save = accountSave({ ...pristine, opening: "50000" }, target);
    expect(save.kind).toBe("change");
    if (save.kind !== "change") return;
    expect(todayOf(save.change(budget))).toBe(5_000_000);
    // Долг по-прежнему набирается минусом в поле или отметкой.
    for (const draft of [{ ...pristine, opening: "-2000" }, { ...pristine, opening: "2000", negative: true }]) {
      const debt = accountSave(draft, target);
      expect(debt.kind === "change" ? todayOf(debt.change(budget)) : debt).toBe(-200_000);
    }
    // Лист показывает то же: минус в поле, отметка снята.
    const sheet = renderToStaticMarkup(<AccountScreen budget={budget} today={TODAY} accountId={MAIN} write={{ run: vi.fn() }} onBack={vi.fn()} onDone={vi.fn()} />);
    expect(sheet).toMatch(/<input id="account-opening"[^>]* value="−1500"/u);
    expect(sheet).toMatch(/<input id="account-negative" type="checkbox"\/>/u);
  });

  it("LOW-1: остаток сегодня больше ста миллионов не мешает правке имени — нетронутое поле не разбирается и не пишется", () => {
    const budget = withMain(9_000_000_000, [spend(MAIN, 2_000_000_000, "2026-07-01", "income")]);
    expect(todayOf(budget)).toBe(11_000_000_000);
    const { pristine, target } = open(budget);
    const save = accountSave({ ...pristine, name: "Переименован" }, target);
    expect(save.kind).toBe("change");
    if (save.kind !== "change") return;
    expect(mainOf(save.change(budget))).toMatchObject({ name: "Переименован", openingBalanceMinor: 9_000_000_000 });
    // И набранное сверх ста миллионов годится, пока начальный остаток в пределе: 115 млн − 20 млн = 95 млн.
    const more = accountSave({ ...pristine, opening: "115000000" }, target);
    expect(more.kind === "change" ? todayOf(more.change(budget)) : more).toBe(11_500_000_000);
  });

  it("LOW-1: сдвиг за предел начального остатка — отказ у поля словами о сдвиге и о том, сколько можно указать", () => {
    const budget = withMain(0, [spend(MAIN, 5_000_000_000, "2026-07-01")]);
    expect(todayOf(budget)).toBe(-5_000_000_000);
    const { pristine, target } = open(budget);
    const save = accountSave({ ...pristine, opening: "60000000" }, target);
    expect(save).toEqual({
      kind: "error",
      error: { field: "opening", message: "Слишком большой сдвиг: начальный остаток, от которого считается этот, ушёл бы за предел суммы. Сейчас на счёте можно указать не больше 50\u00a0000\u00a0000\u00a0₽." },
    });
    const low = accountSave({ ...pristine, opening: "-160000000" }, target);
    expect(low.kind === "error" ? low.error.message : low).toMatch(/можно указать не меньше −150\u00a0000\u00a0000\u00a0₽\.$/u);
  });

  it("LOW-2: движение, пришедшее синхронизацией, пока лист открыт, не сбивает набранное — сдвиг считается на записи", () => {
    const budget = withMain(1_000_000, []);
    const { pristine, target } = open(budget);
    const save = accountSave({ ...pristine, opening: "20000" }, target);
    // Пока набирали, другое устройство записало трату 300 ₽ по этому счёту.
    const synced = { ...budget, transactions: [spend(MAIN, 30_000, "2026-07-19")] };
    expect(save.kind === "change" ? todayOf(save.change(synced)) : save).toBe(2_000_000);
    // Нетронутое поле — остаток с пришедшей тратой, без записи начального.
    const rename = accountSave({ ...pristine, name: "Карта" }, target);
    expect(rename.kind === "change" ? todayOf(rename.change(synced)) : rename).toBe(970_000);
  });

});
