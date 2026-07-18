import { calculateAnnualPlan } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import {
  buildOnboardingBudgetState,
  createAsyncOperationLock,
  createInitialOnboardingDraft,
  MAX_ONBOARDING_PERIOD_START,
  moveOnboardingStep,
  normalizeOnboardingLabel,
  onboardingFailureMessage,
  type OnboardingDraft,
  type OnboardingStep,
  validateCompleteOnboarding,
  validateOnboardingStep,
} from "./model";

function validDraft(): OnboardingDraft {
  return {
    ...createInitialOnboardingDraft("2026-07-01"),
    householdLabel: "Наш план",
    accountLabel: "Основной счёт",
    monthlyIncome: "180 000",
    mandatoryName: "Жильё и счета",
    mandatoryAmount: "53 000",
    categories: [
      { key: "1", name: "Продукты", limit: "30 000" },
      { key: "2", name: "Транспорт", limit: "15 000" },
      { key: "3", name: "Дом", limit: "8 000" },
    ],
  };
}

function idFactory(): () => string {
  let counter = 1;
  return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`;
}

describe("onboarding model", () => {
  it("создаёт пустой план с точными значениями acceptance-сценария", () => {
    const state = buildOnboardingBudgetState(validDraft(), idFactory());
    const plan = calculateAnnualPlan(state, "2026-07", 12);

    expect({
      startDate: state.budgets[0]?.startDate,
      endDate: state.budgets[0]?.endDate,
      incomeMinor: state.budgets[0]?.plannedIncomeMinor,
      mandatoryMinor: state.scheduledExpenses[0]?.amountMinor,
      everydayMinor: state.budgets[0]?.lines.reduce((sum, line) => sum + line.plannedMinor, 0),
      transactions: state.transactions.length,
      goals: state.goals.length,
      annualCommitments: state.annualCommitments.length,
      scheduledExpenses: state.scheduledExpenses.length,
      spendableMinor: plan.currentMonth.spendableAfterPlanMinor,
    }).toEqual({
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      incomeMinor: 18_000_000,
      mandatoryMinor: 5_300_000,
      everydayMinor: 5_300_000,
      transactions: 0,
      goals: 0,
      annualCommitments: 0,
      scheduledExpenses: 1,
      spendableMinor: 7_400_000,
    });
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]?.name).toBe("Для семьи · Наш план · Основной счёт");
    expect(state.categories).toHaveLength(4);
    expect(state.budgets[0]?.lines).toHaveLength(3);
    expect(new Set([
      state.activeBudgetId,
      ...state.accounts.map(({ id }) => id),
      ...state.categories.map(({ id }) => id),
      ...state.budgets.flatMap(({ id, lines }) => [id, ...lines.map((line) => line.id)]),
      ...state.scheduledExpenses.map(({ id }) => id),
    ]).size).toBe(10);
  });

  it("принимает русский десятичный формат и високосный февраль", () => {
    const draft = {
      ...validDraft(),
      periodStart: "2028-02-01",
      monthlyIncome: "180 000,50",
      mandatoryAmount: "53 000,25",
    };
    const state = buildOnboardingBudgetState(draft, idFactory());
    expect(state.budgets[0]).toEqual(expect.objectContaining({
      startDate: "2028-02-01",
      endDate: "2028-02-29",
      plannedIncomeMinor: 18_000_050,
    }));
    expect(state.scheduledExpenses[0]?.amountMinor).toBe(5_300_025);
  });

  it("отклоняет не первое число, повторы, мало категорий и небезопасные суммы", () => {
    const invalid = {
      ...validDraft(),
      periodStart: "2026-07-17",
      monthlyIncome: "90071992547410",
      categories: [
        { key: "1", name: "Продукты", limit: "30 000" },
        { key: "2", name: " продукты ", limit: "15 000" },
      ],
    };
    const validation = validateCompleteOnboarding(invalid);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.objectContaining({
      periodStart: expect.any(String),
      monthlyIncome: expect.any(String),
      categories: expect.any(String),
      "category-1-name": expect.any(String),
    }));
  });

  it("сохраняет NFC, а ключи сравнения приводит к NFKC", () => {
    const draft = {
      ...validDraft(),
      composition: "couple" as const,
      householdLabel: "\u0418\u0306ога и бюджет",
      categories: [
        { key: "1", name: "\u0418\u0306ога", limit: "30 000" },
        { key: "2", name: "Транспорт", limit: "15 000" },
        { key: "3", name: "Дом", limit: "8 000" },
      ],
    };
    const state = buildOnboardingBudgetState(draft, idFactory());
    expect(normalizeOnboardingLabel("\u0418\u0306ога")).toBe("Йога");
    expect(state.accounts[0]?.name).toContain("Для пары · Йога и бюджет");
    expect(state.categories[1]?.name).toBe("Йога");

    const duplicate = {
      ...validDraft(),
      categories: [
        { key: "1", name: "\u0418\u0306ога", limit: "30 000" },
        { key: "2", name: "йога", limit: "15 000" },
        { key: "3", name: "Дом", limit: "8 000" },
      ],
    };
    expect(validateOnboardingStep(duplicate, 4).errors["category-1-name"]).toMatch(/повтор/iu);

    const compatibilityDuplicate = {
      ...validDraft(),
      categories: [
        { key: "1", name: "ＡRENT", limit: "30 000" },
        { key: "2", name: "arent", limit: "15 000" },
        { key: "3", name: "Home", limit: "8 000" },
      ],
    };
    expect(validateOnboardingStep(compatibilityDuplicate, 4).errors["category-1-name"]).toMatch(/повтор/iu);

    const compatibleDisplay = buildOnboardingBudgetState({
      ...validDraft(),
      categories: [
        { key: "1", name: "ＡRENT", limit: "30 000" },
        { key: "2", name: "Транспорт", limit: "15 000" },
        { key: "3", name: "Дом", limit: "8 000" },
      ],
    }, idFactory());
    expect(compatibleDisplay.categories[1]?.name).toBe("ＡRENT");
  });

  it.each([
    ["латиница + кириллица", "Aренда"],
    ["греческий + латиница", "Αlpha"],
    ["греческий + кириллица", "Αренда"],
  ])("отклоняет смешанные алфавиты: %s", (_label, name) => {
    const spoof = { ...validDraft(), householdLabel: name };
    expect(validateOnboardingStep(spoof, 1).errors.householdLabel).toMatch(/смешивайте/iu);
  });

  it("разрешает чистую латиницу, кириллицу и греческий как разные подписи", () => {
    const separateScripts = {
      ...validDraft(),
      categories: [
        { key: "1", name: "Аренда", limit: "30 000" },
        { key: "2", name: "Rent", limit: "15 000" },
        { key: "3", name: "Σπίτι", limit: "8 000" },
      ],
    };
    expect(validateOnboardingStep(separateScripts, 4).valid).toBe(true);
  });

  it("возвращает только фиксированные user-safe сообщения для async-ошибок", () => {
    expect(onboardingFailureMessage("save")).toBe("Не удалось сохранить бюджет.");
    expect(onboardingFailureMessage("demo")).toBe("Не удалось загрузить демонстрационные данные.");
  });

  it.each([
    ["ALM U+061C", "\u061c"],
    ["soft hyphen U+00AD", "\u00ad"],
    ["CGJ U+034F", "\u034f"],
    ["MVS U+180E", "\u180e"],
    ["RLO U+202E", "\u202e"],
    ["LRI U+2066", "\u2066"],
    ["zero-width U+200B", "\u200b"],
    ["LRM U+200E", "\u200e"],
    ["word joiner U+2060", "\u2060"],
    ["BOM U+FEFF", "\ufeff"],
  ])("отклоняет %s", (_label, hidden) => {
      const validation = validateOnboardingStep({ ...validDraft(), householdLabel: `План${hidden}семьи` }, 1);
      expect(validation.errors.householdLabel).toMatch(/скрыт/iu);
  });

  it("отклоняет несуществующий календарный год 0000", () => {
    const validation = validateOnboardingStep({ ...validDraft(), periodStart: "0000-01-01" }, 2);
    expect(validation.errors.periodStart).toMatch(/календар/iu);
  });

  it("ограничивает старт 9997-12-01, чтобы 24-месячный горизонт оставался в четырёхзначном году", () => {
    expect(MAX_ONBOARDING_PERIOD_START).toBe("9997-12-01");
    const maximumDraft = { ...validDraft(), periodStart: MAX_ONBOARDING_PERIOD_START };
    expect(validateOnboardingStep(maximumDraft, 2).valid).toBe(true);
    const state = buildOnboardingBudgetState(maximumDraft, idFactory());
    expect(state.budgets[0]?.endDate).toBe("9997-12-31");
    expect(calculateAnnualPlan(state, "9997-12", 24).months.at(-1)?.month).toBe("9999-11");

    const above = validateOnboardingStep({ ...validDraft(), periodStart: "9998-01-01" }, 2);
    expect(above.errors.periodStart).toContain(MAX_ONBOARDING_PERIOD_START);
  });

  it("получает точные minor units из десятичной строки у границы safe integer", () => {
    const state = buildOnboardingBudgetState({
      ...validDraft(),
      monthlyIncome: "90 071 992 547 409,90",
      mandatoryAmount: "0,01",
      categories: [
        { key: "1", name: "Продукты", limit: "0,01" },
        { key: "2", name: "Транспорт", limit: "0,01" },
        { key: "3", name: "Дом", limit: "0,01" },
      ],
    }, idFactory());
    expect(state.budgets[0]?.plannedIncomeMinor).toBe(9_007_199_254_740_990);
    expect(state.scheduledExpenses[0]?.amountMinor).toBe(1);
    expect(state.budgets[0]?.lines.map(({ plannedMinor }) => plannedMinor)).toEqual([1, 1, 1]);
    expect(validateOnboardingStep({ ...validDraft(), monthlyIncome: "90071992547409,92" }, 3).errors.monthlyIncome).toMatch(/сумм/iu);
  });

  it("отклоняет подмену composition через ключ прототипа", () => {
    const draft = { ...validDraft(), composition: "__proto__" as OnboardingDraft["composition"] };
    expect(validateOnboardingStep(draft, 1).errors.composition).toMatch(/выберите/iu);
    expect(() => buildOnboardingBudgetState(draft, idFactory())).toThrow(/заполните/iu);
  });

  it("проходит 4 шага вперёд/назад, не меняя черновик", () => {
    const draft = validDraft();
    const before = JSON.stringify(draft);
    let step: OnboardingStep = 1;
    step = moveOnboardingStep(step, "forward");
    expect(step).toBe(2);
    step = moveOnboardingStep(step, "forward");
    expect(step).toBe(3);
    step = moveOnboardingStep(step, "back");
    expect(step).toBe(2);
    step = moveOnboardingStep(step, "forward");
    step = moveOnboardingStep(step, "forward");
    expect(step).toBe(4);
    expect(JSON.stringify(draft)).toBe(before);
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

  it("указывает первое ошибочное поле шага и не принимает пустые подписи", () => {
    const validation = validateOnboardingStep({ ...validDraft(), householdLabel: " " }, 1);
    expect(validation.valid).toBe(false);
    expect(Object.keys(validation.errors)[0]).toBe("householdLabel");
  });

  it("не строит модель при повторе UUID", () => {
    expect(() => buildOnboardingBudgetState(validDraft(), () => "00000000-0000-4000-8000-000000000001"))
      .toThrow(/\u0443\u043d\u0438\u043a\u0430\u043b\u044c\u043d/iu);
  });
});
