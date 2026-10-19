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
  accountFormError,
  accountPatch,
  accountSave,
  accountsList,
  blankAccountDraft,
  currencyLock,
  minorToInput,
  parseOpening,
  type AccountFormDraft,
} from "./account-model";
import { AccountFormView } from "./AccountScreen";
import { AccountsScreen, accountRowLabel } from "./AccountsScreen";

const MAIN = SEED_IDS.accounts.main;
const SAVINGS = SEED_IDS.accounts.savings;
const DOLLARS = "e2c00000-0000-4000-8000-0000000000d1";
const ARCHIVED = "e2c00000-0000-4000-8000-0000000000d2";
const TODAY = "2026-07-20";

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

  it("записанный счёт — в форму: остаток без разрядов и знака, знак — отметкой, ключи — только известные", () => {
    const dollars = state().accounts.find((account) => account.id === DOLLARS)!;
    expect(accountDraftOf(dollars)).toEqual({ name: "Доллары", type: "cash", currency: "USD", opening: "500", negative: false, icon: "dollar-sign", tone: "lilac", includeInTotal: true });
    expect(accountDraftOf({ ...dollars, openingBalanceMinor: -125_050, icon: "coins-stack", color: "toString" })).toMatchObject({ opening: "1250,50", negative: true, icon: null, tone: null });
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

  it("список: активные по порядку с местом, архив отдельно; остаток — в валюте счёта, на сегодня", () => {
    const list = accountsList(state(), TODAY);
    expect(list.active.map((row) => [row.account.name, row.position])).toEqual([["Основной", 1], ["Резерв платежей", 2], ["Доллары", 3]]);
    expect(list.archived.map((row) => row.account.name)).toEqual(["Старая карта"]);
    const dollars = list.active[2]!;
    expect(dollars).toMatchObject({ icon: "dollar-sign", tone: "lilac", balanceMinor: 50_000, meta: "Наличные · USD" });
    expect(list.archived[0]).toMatchObject({ meta: "Карта или счёт · вне итога", tone: null, icon: "credit-card" });
    // Код валюты — как его пишут и читают: «USD», а не «usd» (ревью 2c, LOW-7).
    expect(accountRowLabel(dollars)).toBe("Доллары: 500\u00a0$, наличные · USD. Изменить");
    expect(accountRowLabel(list.archived[0]!)).toMatch(/, карта или счёт · вне итога\. Изменить$/u);
  });
});

describe("счета: разметка", () => {
  const render = () => renderToStaticMarkup(
    <AccountsScreen budget={state()} today={TODAY} write={{ run: vi.fn() }} onBack={vi.fn()} onOpen={vi.fn()} onCreate={vi.fn()} />,
  );

  it("заголовок, «Новый счёт», активные с «Выше / Ниже», архив с «Вернуть»; остаток — в валюте счёта", () => {
    const markup = render();
    expect(markup).toContain("<h1>Счета</h1>");
    // «Новый счёт» — действие строки заголовка: глиф «+» и имя словами.
    expect(markup).toContain('<div class="title-bar-action"><button class="icon-button" type="button" aria-label="Новый счёт">');
    expect(markup).toContain('aria-label="Основной — выше" aria-disabled="true"');
    expect(markup).toContain('aria-label="Доллары — ниже" aria-disabled="true"');
    expect(markup).toContain('aria-label="Вернуть «Старая карта» из архива"');
    expect(markup).toMatch(/Доллары<\/bdi>[^]*?500<span class="money-currency">\u00a0\$<\/span>/u);
    // Тон счёта — подложка глифа; без тона — тёмная, как плитка «Обзора».
    expect(markup).toContain('class="icon-plate tone-lilac"');
    expect(markup).toContain('class="icon-plate account-plate"');
    // Чужое имя изолировано от слов приложения.
    expect(markup).toContain('<bdi dir="auto">Старая карта</bdi>');
  });
});

describe("форма счёта: разметка", () => {
  const view = (overrides: Partial<Parameters<typeof AccountFormView>[0]> = {}) => {
    const budget = state();
    const account = overrides.account === undefined ? budget.accounts.find((item) => item.id === DOLLARS)! : overrides.account;
    const pristine = account === null ? blankAccountDraft(budget) : accountDraftOf(account);
    return renderToStaticMarkup(
      <AccountFormView budget={budget} account={account} draft={pristine} pristine={pristine} error={null} busy={false} onPatch={vi.fn()} onSubmit={vi.fn()} {...overrides} />,
    );
  };

  it("поля по порядку: название, вид, валюта, остаток, цвет, иконка, «Учитывать в итоге»; форма — с обработчиком", () => {
    const markup = view({ account: null });
    const order = ['for="account-name"', "<legend>Вид счёта</legend>", 'for="account-currency"', 'for="account-opening"', "<legend>Цвет на «Обзоре»</legend>", "<legend>Иконка</legend>", "Учитывать в итоге «Всего на счетах»", "Завести счёт"];
    const at = order.map((piece) => markup.indexOf(piece));
    expect(at.every((index) => index > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(markup).toMatch(/^<form class="manage-form" noValidate="">/u);
    expect(markup).toContain("Сколько на счёте сейчас: с этой суммы начнётся его остаток.");
    expect(markup).toContain('<option value="RUB" selected="">Российский рубль — RUB</option>');
  });

  it("правка: остаток предупреждает о прошлом, а изменённый — называет сдвиг; запертая валюта говорит почему", () => {
    const budget = state();
    const main = budget.accounts.find((item) => item.id === MAIN)!;
    const pristine = accountDraftOf(main);
    const markup = view({ account: main, pristine, draft: { ...pristine, opening: "1500" } });
    expect(markup).toContain("Начальный остаток меняет остатки в прошлом");
    expect(markup).toMatch(/Остатки «<bdi dir="auto">Основной<\/bdi>» за все прошлые дни сдвинутся на <span class="money">\+1\u00a0500<span class="money-currency">\u00a0₽<\/span><\/span>/u);
    expect(markup).toMatch(/<select id="account-currency" disabled="" aria-describedby="account-currency-lock">/u);
    expect(markup).toContain("Цели и планы ведутся только в базовой валюте RUB.");
  });

  it("отказ у поля — рядом с ним и связан с ним; отказ формы — над кнопкой", () => {
    const named = view({ error: { field: "name", message: "Активный счёт с таким названием уже есть." } });
    expect(named).toMatch(/<input id="account-name"[^>]*aria-invalid="true" aria-describedby="account-name-error"/u);
    expect(named).toContain('<p class="field-error" id="account-name-error" role="alert">Активный счёт с таким названием уже есть.</p>');
    const form = view({ error: { field: "form", message: "Изменение не сохранилось. Повторите его." } });
    expect(form).toContain('aria-describedby="account-form-error"');
    expect(form).toMatch(/role="alert" tabindex="-1">Изменение не сохранилось\. Повторите его\.<\/p><button class="primary-button wide" type="submit"/u);
  });

  it("счёт в другой валюте говорит, как его операции попадут в бюджет; запись — выключенная форма", () => {
    const markup = view({ account: null, draft: { ...blankAccountDraft(state()), currency: "USD" } });
    expect(markup).toContain("Счёт в USD: каждая операция по нему запишется и в RUB");
    expect(markup).toContain("Начальный остаток, $");
    const busy = view({ busy: true });
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toMatch(/<fieldset class="option-grid" disabled="">/u);
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
