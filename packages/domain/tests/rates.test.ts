import { describe, expect, it } from "vitest";

import {
  addExchangeRate,
  baseSnapshot,
  calculateBudget,
  COLLECTION_LIMITS,
  convertMinor,
  deleteExchangeRate,
  HOUSEHOLD_ID,
  indexRates,
  makeSeedBudget,
  manualSnapshot,
  MAX_MONEY_MINOR,
  RATE_PART_MAX,
  RateValidationError,
  SEED_IDS,
  snapshotAt,
  type BudgetState,
  type ExchangeRate,
} from "../src/index.js";

const DOLLARS = "8c000000-0000-4000-8000-0000000000c2";
const RATE_ID = "8e000000-0000-4000-8000-0000000000e1";
const OTHER_RATE_ID = "8e000000-0000-4000-8000-0000000000e2";
const EXPENSE_ID = "8f000000-0000-4000-8000-0000000000f1";

/** 1 USD = 92,50 ₽: 100 cents are worth 9 250 kopecks. */
const RATE_92_50 = { baseMinor: 9_250, quoteMinor: 100 } as const;

function withDollarAccount(): BudgetState {
  const seed = makeSeedBudget();
  return {
    ...seed,
    accounts: [...seed.accounts, { id: DOLLARS, name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 74_400, active: true }],
  };
}

function rateOf(id: string, date: string, rate: ExchangeRate["rate"] = RATE_92_50): ExchangeRate {
  return { id, currency: "USD", baseCurrency: "RUB", date, rate };
}

describe("курс дня — общий для листа ввода и регулярных операций", () => {
  it("берёт последний курс не позже дня и считает снимок той же арифметикой, что и домен", () => {
    const rates = indexRates([rateOf(RATE_ID, "2026-10-15"), rateOf(OTHER_RATE_ID, "2026-10-20", { baseMinor: 9_400, quoteMinor: 100 })]);
    expect(baseSnapshot(1_250, "USD", "RUB", rates, "2026-10-19")).toEqual({
      baseAmountMinor: 115_625,
      baseCurrency: "RUB",
      rate: RATE_92_50,
    });
    expect(baseSnapshot(1_250, "USD", "RUB", rates, "2026-10-20")?.baseAmountMinor).toBe(117_500);
    // До первого курса — снимка нет: отказ, а не догадка.
    expect(baseSnapshot(1_250, "USD", "RUB", rates, "2026-10-14")).toBeNull();
    expect(baseSnapshot(1_250, "EUR", "RUB", rates, "2026-10-19")).toBeNull();
  });

  it("не принимает курс, который оценивает сумму в ноль или выше потолка поля", () => {
    expect(snapshotAt(1, "RUB", { baseMinor: 1, quoteMinor: 1_000 })).toBeNull();
    expect(snapshotAt(MAX_MONEY_MINOR, "RUB", { baseMinor: 2, quoteMinor: 1 })).toBeNull();
    expect(snapshotAt(100, "RUB", { baseMinor: 9_250, quoteMinor: 100 })).toEqual({ baseAmountMinor: 9_250, baseCurrency: "RUB", rate: RATE_92_50 });
  });

  it("сумма в базе вручную — точный курс «сумма за сумму», и домен принимает операцию без округления", () => {
    const snapshot = manualSnapshot(1_250, 115_700, "RUB");
    expect(snapshot).toEqual({ baseAmountMinor: 115_700, baseCurrency: "RUB", rate: { baseMinor: 115_700, quoteMinor: 1_250 } });
    expect(convertMinor(1_250, snapshot!.rate)).toBe(115_700);
    const state: BudgetState = {
      ...withDollarAccount(),
      transactions: [{
        id: EXPENSE_ID, kind: "expense", occurredOn: "2026-07-10", status: "posted", amountMinor: 1_250,
        accountId: DOLLARS, categoryId: SEED_IDS.categories.food, ...snapshot!,
      }],
    };
    expect(calculateBudget(state).categoryMetrics[SEED_IDS.categories.food]?.expenseMinor).toBe(115_700);
    // Части курса — в пределах модели; иначе снимка нет.
    expect(manualSnapshot(0, 100, "RUB")).toBeNull();
    expect(manualSnapshot(100, 0, "RUB")).toBeNull();
    expect(manualSnapshot(100, MAX_MONEY_MINOR + 1, "RUB")).toBeNull();
    expect(manualSnapshot(1.5, 100, "RUB")).toBeNull();
  });
});

describe("addExchangeRate / deleteExchangeRate", () => {
  it("записывает курс к базовой валюте семьи и не трогает ничего больше", () => {
    const state = withDollarAccount();
    const { state: next, rate } = addExchangeRate(state, { currency: "USD", date: "2026-10-15", rate: RATE_92_50 }, () => RATE_ID);
    expect(rate).toEqual(rateOf(RATE_ID, "2026-10-15"));
    expect(next.exchangeRates).toEqual([rate]);
    expect({ ...next, exchangeRates: undefined }).toEqual({ ...state, exchangeRates: undefined });
    // База — валюта семьи, а не рубли по умолчанию.
    const inEuro = { ...state, household: { id: HOUSEHOLD_ID, baseCurrency: "EUR" } };
    expect(addExchangeRate(inEuro, { currency: "USD", date: "2026-10-15", rate: RATE_92_50 }, () => RATE_ID).rate.baseCurrency).toBe("EUR");
  });

  it("второй курс того же дня — не дубль: оба остаются, выбор между ними делает findRate", () => {
    const first = addExchangeRate(withDollarAccount(), { currency: "USD", date: "2026-10-15", rate: RATE_92_50 }, () => RATE_ID).state;
    const second = addExchangeRate(first, { currency: "USD", date: "2026-10-15", rate: { baseMinor: 9_300, quoteMinor: 100 } }, () => OTHER_RATE_ID).state;
    expect(second.exchangeRates).toHaveLength(2);
    expect(baseSnapshot(100, "USD", "RUB", indexRates(second.exchangeRates ?? []), "2026-10-15")?.baseAmountMinor).toBe(9_300);
  });

  it("отказывает словами: неизвестная валюта, база, дата вне окна, курс вне пределов, предел числа, чужой id", () => {
    const state = withDollarAccount();
    const refusal = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(RateValidationError);
        return (error as RateValidationError).code;
      }
      return "accepted";
    };
    const draft = { currency: "USD", date: "2026-10-15", rate: RATE_92_50 };
    expect(refusal(() => addExchangeRate(state, { ...draft, currency: "XAU" }, () => RATE_ID))).toBe("unknown_currency");
    expect(refusal(() => addExchangeRate(state, { ...draft, currency: "toString" }, () => RATE_ID))).toBe("unknown_currency");
    expect(refusal(() => addExchangeRate(state, { ...draft, currency: "RUB" }, () => RATE_ID))).toBe("base_currency");
    expect(refusal(() => addExchangeRate(state, { ...draft, date: "2026-02-30" }, () => RATE_ID))).toBe("invalid_date");
    expect(refusal(() => addExchangeRate(state, { ...draft, date: "1899-12-31" }, () => RATE_ID))).toBe("invalid_date");
    expect(refusal(() => addExchangeRate(state, { ...draft, rate: { baseMinor: 0, quoteMinor: 100 } }, () => RATE_ID))).toBe("invalid_rate");
    expect(refusal(() => addExchangeRate(state, { ...draft, rate: { baseMinor: RATE_PART_MAX + 1, quoteMinor: 1 } }, () => RATE_ID))).toBe("invalid_rate");
    expect(refusal(() => addExchangeRate(state, { ...draft, rate: { baseMinor: 92.5, quoteMinor: 1 } }, () => RATE_ID))).toBe("invalid_rate");
    expect(refusal(() => addExchangeRate(state, draft, () => "not-a-uuid"))).toBe("id_required");
    expect(refusal(() => addExchangeRate(state, draft, () => SEED_IDS.accounts.main))).toBe("duplicate_id");
    const full = { ...state, exchangeRates: Array.from({ length: COLLECTION_LIMITS.exchangeRates }, (_unused, index) => rateOf(`8e000000-0000-4000-8000-${String(index).padStart(12, "0")}`, "2026-01-01")) };
    expect(refusal(() => addExchangeRate(full, draft, () => RATE_ID))).toBe("limit_reached");
    expect(refusal(() => deleteExchangeRate(state, RATE_ID))).toBe("unknown_rate");
  });

  it("удаление курса не переоценивает записанное: снимок операции остаётся её цифрой", () => {
    const { state: withRate } = addExchangeRate(withDollarAccount(), { currency: "USD", date: "2026-07-01", rate: RATE_92_50 }, () => RATE_ID);
    const snapshot = baseSnapshot(1_000, "USD", "RUB", indexRates(withRate.exchangeRates ?? []), "2026-07-10")!;
    const written: BudgetState = {
      ...withRate,
      transactions: [{
        id: EXPENSE_ID, kind: "expense", occurredOn: "2026-07-10", status: "posted", amountMinor: 1_000,
        accountId: DOLLARS, categoryId: SEED_IDS.categories.food, ...snapshot,
      }],
    };
    const before = calculateBudget(written).categoryMetrics[SEED_IDS.categories.food]?.expenseMinor;
    const removed = deleteExchangeRate(written, RATE_ID);
    expect(removed.exchangeRates).toEqual([]);
    expect(calculateBudget(removed).categoryMetrics[SEED_IDS.categories.food]?.expenseMinor).toBe(before);
    expect(before).toBe(92_500);
  });
});
