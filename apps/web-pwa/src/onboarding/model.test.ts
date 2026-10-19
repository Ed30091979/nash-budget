import {
  baseCurrencyOf,
  calculateAnnualPlan,
  calculateBudget,
  canBeBaseCurrency,
  categoryNameKey,
  DEFAULT_CATEGORIES,
  type BudgetState,
} from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import { prepareBudgetState } from "../backup";
import { categoryPickerView } from "../features/operations/category-picker";
import {
  ARCHIVED_STARTERS,
  buildOnboardingBudgetState,
  createAsyncOperationLock,
  currencyForLocale,
  onboardingFailureMessage,
  PRESET_ACCOUNTS,
  PRESET_EXPENSES,
  PRESET_INCOME,
} from "./model";

function idFactory(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}

function preset(today = "2026-10-19", currency?: Parameters<typeof buildOnboardingBudgetState>[0]["currency"]): BudgetState {
  return buildOnboardingBudgetState({ today, makeId: idFactory(), ...(currency === undefined ? {} : { currency }) });
}

const active = (state: BudgetState, type: "expense" | "income") =>
  state.categories.filter((category) => category.type === type && category.active).map((category) => category.name);

describe("набор первого запуска (DIRECTION §e, п. 2)", () => {
  it("счета «Карта» и «Наличные», доход «Зарплата», двенадцать категорий — и пустой месяц плана", () => {
    const state = preset();
    expect(state.accounts.map((account) => [account.name, account.type, account.currency, account.openingBalanceMinor, account.active]))
      .toEqual([["Карта", "current", "RUB", 0, true], ["Наличные", "cash", "RUB", 0, true]]);
    expect(PRESET_ACCOUNTS.map((account) => account.name)).toEqual(["Карта", "Наличные"]);
    expect(active(state, "income")).toEqual([PRESET_INCOME]);
    expect(active(state, "expense").sort()).toEqual([...PRESET_EXPENSES].sort());
    expect(PRESET_EXPENSES).toEqual([
      "Продукты", "Кафе и доставка", "Транспорт", "Дом и хозяйство", "Жильё", "ЖКХ", "Связь и подписки",
      "Здоровье и аптека", "Одежда и обувь", "Развлечения и хобби", "Подарки и праздники", "Прочее",
    ]);
    // Период — как у прежнего онбординга: текущий месяц, открыт, порог «почти» 80 %.
    expect(state.budgets).toEqual([{
      id: state.activeBudgetId, startDate: "2026-10-01", endDate: "2026-10-31", status: "open",
      plannedIncomeMinor: 0, warningThreshold: 0.8, lines: [],
    }]);
    expect([state.transactions, state.goals, state.annualCommitments, state.scheduledExpenses]).toEqual([[], [], [], []]);
    // Рубль — база по умолчанию: записи хозяйства набор не заводит.
    expect(state.household).toBeUndefined();
    expect(baseCurrencyOf(state)).toBe("RUB");
  });

  it("остальные стартовые категории лежат в архиве до выбора — те же строки, без тёзок", () => {
    const state = preset();
    expect(state.categories.map((category) => categoryNameKey(category.name))).toEqual(DEFAULT_CATEGORIES.map((template) => categoryNameKey(template.name)));
    expect(ARCHIVED_STARTERS).toEqual(["Кредиты и рассрочки", "Дети", "Красота и уход"]);
    const archived = state.categories.filter((category) => !category.active);
    expect(archived.filter((category) => category.type === "expense").map((category) => category.name)).toEqual(ARCHIVED_STARTERS);
    expect(archived.filter((category) => category.type === "income")).toHaveLength(7);
  });

  it("план, расход и выбор категорий работают на наборе как прежде: «лимитов нет», ничего не потрачено", () => {
    const state = preset("2026-07-09");
    const plan = calculateAnnualPlan(state, "2026-07", 12);
    expect(plan.currentMonth.flexiblePlanMinor).toBe(0);
    expect(plan.months).toHaveLength(12);
    expect(calculateBudget(state)).toMatchObject({ incomeMinor: 0, expensesMinor: 0, capitalMinor: 0 });
    const picker = categoryPickerView(state, "expense");
    expect(picker.groups.map((group) => group.title)).toEqual(["Обязательные платежи", "Каждый день", "Личное и досуг", "Прочее"]);
    expect(picker.status).toBe("Найдено 12 категорий");
    // Тот же шлюз, что у восстановленной копии.
    expect(prepareBudgetState(JSON.parse(JSON.stringify(state)) as unknown)).toEqual(state);
  });

  it("каждый идентификатор уникален, а повтор UUID — отказ, а не тихий дубль", () => {
    const state = preset();
    const ids = [state.activeBudgetId, ...state.accounts.map(({ id }) => id), ...state.categories.map(({ id }) => id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(1 + 2 + 23);
    expect(() => buildOnboardingBudgetState({ today: "2026-10-19", makeId: () => "00000000-0000-4000-8000-000000000001" }))
      .toThrow(/уникальн/u);
  });

  it("валюта не рубль ставится доменом вместе со счетами, пока бюджет пуст", () => {
    const state = preset("2026-10-19", "KZT");
    expect(state.household).toEqual({ id: expect.any(String), baseCurrency: "KZT" });
    expect(state.accounts.every((account) => account.currency === "KZT")).toBe(true);
    expect(() => preset("2026-10-19", "JPY")).toThrow(/двумя знаками/u);
  });
});

describe("валюта набора по языку устройства (§e; D-031)", () => {
  it("ru → рубль, kk → тенге, be → белорусский рубль — по языку, а не по региону", () => {
    expect(currencyForLocale("ru")).toBe("RUB");
    expect(currencyForLocale("ru-RU")).toBe("RUB");
    expect(currencyForLocale("ru-KZ")).toBe("RUB");
    expect(currencyForLocale("ru-UA")).toBe("RUB");
    expect(currencyForLocale("kk")).toBe("KZT");
    expect(currencyForLocale("kk-KZ")).toBe("KZT");
    expect(currencyForLocale("be-BY")).toBe("BYN");
  });

  it("иначе — по региону, а у тега без региона — по вероятному региону языка", () => {
    expect(currencyForLocale("en-US")).toBe("USD");
    expect(currencyForLocale("en-GB")).toBe("GBP");
    expect(currencyForLocale("de-DE")).toBe("EUR");
    expect(currencyForLocale("de")).toBe("EUR");
    expect(currencyForLocale("uk")).toBe("UAH");
    expect(currencyForLocale("hy-AM")).toBe("AMD");
    expect(currencyForLocale("uz-Latn-UZ")).toBe("UZS");
  });

  it("базовой бывает только валюта с двумя знаками: иена, вона, донг и крона Исландии — рубль", () => {
    for (const tag of ["ja-JP", "ko-KR", "vi-VN", "is-IS"]) expect(currencyForLocale(tag), tag).toBe("RUB");
    for (const tag of ["ru", "kk", "be", "en-US", "de-DE", "uk-UA", "fr-FR", "pl-PL", "tr-TR", "zh-CN"]) {
      expect(canBeBaseCurrency(currencyForLocale(tag)), tag).toBe(true);
    }
  });

  it("запасной вариант — рубль: нет языка, неизвестный регион, испорченный тег", () => {
    for (const tag of [null, undefined, "", "   ", "xx-ZZ", "es-AR", "not a tag!", "--"]) {
      expect(currencyForLocale(tag), String(tag)).toBe("RUB");
    }
  });
});

describe("служебное онбординга", () => {
  it("возвращает только фиксированные слова для неудач — без текста исключения", () => {
    expect(onboardingFailureMessage("save")).toBe("Не удалось сохранить бюджет.");
    expect(onboardingFailureMessage("demo")).toBe("Не удалось загрузить пример.");
  });

  it("синхронно блокирует вторую async-операцию до завершения первой", async () => {
    const lock = createAsyncOperationLock();
    let finish: (() => void) | undefined;
    let calls = 0;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const first = lock.run(async () => { calls += 1; await pending; });
    const second = lock.run(async () => { calls += 1; });

    expect(lock.locked).toBe(true);
    expect(await second).toBe(false);
    expect(calls).toBe(1);
    finish?.();
    expect(await first).toBe(true);
    expect(lock.locked).toBe(false);
    expect(await lock.run(async () => { calls += 1; })).toBe(true);
    expect(calls).toBe(2);
  });
});
