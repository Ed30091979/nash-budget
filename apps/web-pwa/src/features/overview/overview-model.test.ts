import {
  calculateAnnualPlan,
  makePlanningSeed,
  PLANNING_IDS,
  SEED_IDS,
  type BudgetState,
} from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import { formatMoney } from "../../money";
import { defaultAccountOf, limitStatus, overviewModel, reachLineModel, UNCATEGORIZED_INCOME_NAME } from "./overview-model";

/** G-002 — канонический плановый набор: июль 2026, гибкие лимиты 53 000 ₽. */
function g002(): BudgetState {
  return makePlanningSeed();
}

const DOLLARS = "a1000000-0000-4000-8000-0000000000d1";
const SALARY = "a1000000-0000-4000-8000-0000000000c1";

describe("строка «Можно на повседневные»", () => {
  it("G-002: можно на повседневные 27 000 ₽ — лимиты месяца плана минус потраченное по ним", () => {
    const state = g002();
    const plan = calculateAnnualPlan(state, "2026-07", 24);
    const line = reachLineModel(state, plan.currentMonth.flexiblePlanMinor);
    expect(line.planMonth).toBe("2026-07");
    expect(formatMoney(line.safeToSpendMinor)).toBe(formatMoney(2_700_000));
    expect(line.safeToSpendMinor).toBe(2_700_000);
    expect(line.flexibleSpentMinor).toBe(2_600_000);
  });
});

describe("данные «Обзора» за месяц", () => {
  it("G-002, июль: «Потрачено 26 000 из 53 000» — расход категорий с лимитом против их лимитов", () => {
    const model = overviewModel(g002(), "2026-07", "2026-07-13");
    expect(model.spentWithLimitMinor).toBe(2_600_000);
    expect(model.limitsMinor).toBe(5_300_000);
    // Весь расход месяца больше: «Жильё» оплачено по расписанию и лимита не имеет.
    expect(model.spentMinor).toBe(7_100_000);
    const housing = model.categories.find((tile) => tile.id === PLANNING_IDS.categories.housing)!;
    expect(housing).toMatchObject({ spentMinor: 4_500_000, limitMinor: null, status: "none", fill: 0 });
    const food = model.categories.find((tile) => tile.id === PLANNING_IDS.categories.food)!;
    expect(food).toMatchObject({ spentMinor: 2_200_000, limitMinor: 3_000_000, status: "normal", fill: 75 });
    // Плитки — активные категории расходов по порядку списка.
    expect(model.categories.map((tile) => tile.name)).toEqual(g002().categories.filter((item) => item.type === "expense").map((item) => item.name));
  });

  it("порог «почти лимит» — `warningThreshold` бюджета; ровно лимит — тоже «почти», сверх — «перелимит»", () => {
    expect(limitStatus(799, 1_000, 0.8)).toBe("normal");
    expect(limitStatus(800, 1_000, 0.8)).toBe("near");
    expect(limitStatus(1_000, 1_000, 0.8)).toBe("near");
    expect(limitStatus(1_001, 1_000, 0.8)).toBe("over");
    expect(limitStatus(500, 1_000, 0.5)).toBe("near");
    expect(limitStatus(5_000, null, 0.8)).toBe("none");
    expect(limitStatus(1, 0, 0.8)).toBe("over");
    expect(limitStatus(0, 0, 0.8)).toBe("normal");
    // В модели: лишний возврат даёт отрицательный расход, и это «в норме», а не перелимит.
    const state = g002();
    const over: BudgetState = {
      ...state,
      transactions: [...state.transactions, {
        id: "a1000000-0000-4000-8000-0000000000e1", kind: "expense", status: "posted", occurredOn: "2026-07-20",
        amountMinor: 900_000, accountId: SEED_IDS.accounts.main, categoryId: PLANNING_IDS.categories.food,
      }],
    };
    const food = overviewModel(over, "2026-07", "2026-07-20").categories.find((tile) => tile.id === PLANNING_IDS.categories.food)!;
    expect(food).toMatchObject({ spentMinor: 3_100_000, status: "over", fill: 100 });
    const transport = overviewModel(over, "2026-07", "2026-07-20").categories.find((tile) => tile.id === PLANNING_IDS.categories.transport)!;
    expect(transport).toMatchObject({ spentMinor: 400_000, limitMinor: 1_000_000, status: "normal", fill: 40 });
  });

  it("месяц без бюджета: лимитов нет, расход — по операциям его дней", () => {
    const state = g002();
    const august: BudgetState = {
      ...state,
      transactions: [...state.transactions, {
        id: "a1000000-0000-4000-8000-0000000000e2", kind: "expense", status: "posted", occurredOn: "2026-08-02",
        amountMinor: 150_000, accountId: SEED_IDS.accounts.main, categoryId: PLANNING_IDS.categories.food,
      }],
    };
    const model = overviewModel(august, "2026-08", "2026-08-03");
    expect(model.limitsMinor).toBeNull();
    expect(model.spentMinor).toBe(150_000);
    expect(model.categories.find((tile) => tile.id === PLANNING_IDS.categories.food)).toMatchObject({ spentMinor: 150_000, limitMinor: null, status: "none" });
    expect(model.incomes.every((tile) => tile.amountMinor === 0)).toBe(true);
  });

  it("доходы месяца по категориям дохода и плитка «Без категории» (D-026)", () => {
    const state = g002();
    const withSalary: BudgetState = {
      ...state,
      categories: [...state.categories, { id: SALARY, name: "Зарплата", type: "income", group: "income", active: true, sortOrder: 100 }],
      transactions: [...state.transactions, {
        id: "a1000000-0000-4000-8000-0000000000e3", kind: "income", status: "posted", occurredOn: "2026-07-20",
        amountMinor: 3_000_000, accountId: SEED_IDS.accounts.main, categoryId: SALARY,
      }],
    };
    const model = overviewModel(withSalary, "2026-07", "2026-07-20");
    expect(model.incomes).toEqual([
      { id: SALARY, name: "Зарплата", icon: "banknote", amountMinor: 3_000_000, archived: false },
      // G-002 записал зарплату без категории: она стоит своей плиткой, а не теряется.
      { id: null, name: UNCATEGORIZED_INCOME_NAME, icon: "banknote", amountMinor: 18_000_000, archived: false },
    ]);
    // В месяце без такого дохода плитки «Без категории» нет.
    expect(overviewModel(withSalary, "2026-09", "2026-09-01").incomes.map((tile) => tile.id)).toEqual([SALARY]);
    // Источник в архиве — плиткой-итогом, пока у него есть доход месяца; без дохода — его нет.
    const archived: BudgetState = { ...withSalary, categories: withSalary.categories.map((item) => (item.id === SALARY ? { ...item, active: false } : item)) };
    expect(overviewModel(archived, "2026-07", "2026-07-20").incomes[0]).toMatchObject({ id: SALARY, archived: true, amountMinor: 3_000_000 });
    expect(overviewModel(archived, "2026-09", "2026-09-01").incomes.map((tile) => tile.id)).toEqual([]);
  });

  it("«Всего на счетах» — итог holdings: долларовый счёт по курсу, счёт вне итога не входит, без курса — назван", () => {
    const state = g002();
    const withDollars: BudgetState = {
      ...state,
      accounts: [
        ...state.accounts,
        { id: DOLLARS, name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 74_400, active: true },
      ],
    };
    // Без курса: доллары не оценены и названы, итог — только рубли.
    const unpriced = overviewModel(withDollars, "2026-07", "2026-07-13");
    const roublesOnly = overviewModel(state, "2026-07", "2026-07-13").totalInBaseMinor;
    expect(unpriced.totalInBaseMinor).toBe(roublesOnly);
    expect(unpriced.unvaluedAccounts.map((tile) => tile.name)).toEqual(["Доллары"]);
    expect(unpriced.accounts.find((tile) => tile.id === DOLLARS)).toMatchObject({ currency: "USD", balanceMinor: 74_400, inTotal: false, unvalued: true });
    // С курсом 92,50: 744 $ — 68 820 ₽ в итоге.
    const priced: BudgetState = {
      ...withDollars,
      exchangeRates: [{ id: "a1000000-0000-4000-8000-0000000000f1", currency: "USD", baseCurrency: "RUB", date: "2026-07-01", rate: { baseMinor: 9_250, quoteMinor: 100 } }],
    };
    const model = overviewModel(priced, "2026-07", "2026-07-13");
    expect(model.totalInBaseMinor).toBe(roublesOnly + 6_882_000);
    expect(model.unvaluedAccounts).toEqual([]);
    // Счёт вне итога остаётся плиткой, но итог его не видит.
    const outside: BudgetState = { ...priced, accounts: priced.accounts.map((item) => (item.id === DOLLARS ? { ...item, includeInTotal: false } : item)) };
    const excluded = overviewModel(outside, "2026-07", "2026-07-13");
    expect(excluded.totalInBaseMinor).toBe(roublesOnly);
    expect(excluded.accounts.find((tile) => tile.id === DOLLARS)).toMatchObject({ includeInTotal: false, inTotal: false, unvalued: false });
  });

  it("архивный счёт — в итоге, как велит контракт (правило 9), и итог говорит, сколько в нём архива; архивный без курса назван", () => {
    // Ревью 2c, LOW-5: архивный счёт уходил с «Обзора», но его остаток молча оставался во «Всего на
    // счетах», а архивный счёт без курса не назывался в «В итог не вошли».
    const state = g002();
    const OLD_CARD = "a1000000-0000-4000-8000-0000000000d2";
    const withArchive: BudgetState = {
      ...state,
      accounts: [
        ...state.accounts,
        { id: OLD_CARD, name: "Старая карта", type: "cash", currency: "RUB", openingBalanceMinor: 1_500_000, active: false },
        { id: DOLLARS, name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 74_400, active: false },
      ],
    };
    const roublesOnly = overviewModel(state, "2026-07", "2026-07-13").totalInBaseMinor;
    const model = overviewModel(withArchive, "2026-07", "2026-07-13");
    expect(model.totalInBaseMinor).toBe(roublesOnly + 1_500_000);
    expect(model.archivedInTotalMinor).toBe(1_500_000);
    expect(model.accounts.map((tile) => tile.id)).not.toContain(OLD_CARD);
    expect(model.unvaluedAccounts).toEqual([{ id: DOLLARS, name: "Доллары", currency: "USD", archived: true }]);
    // Архив вне итога — не в итоге и не в словах о нём; без архива — слов нет.
    const outside: BudgetState = { ...withArchive, accounts: withArchive.accounts.map((item) => (item.active ? item : { ...item, includeInTotal: false })) };
    expect(overviewModel(outside, "2026-07", "2026-07-13")).toMatchObject({ totalInBaseMinor: roublesOnly, archivedInTotalMinor: null, unvaluedAccounts: [] });
    expect(overviewModel(state, "2026-07", "2026-07-13").archivedInTotalMinor).toBeNull();
  });

  it("остатки прошлого месяца — на его последний день, текущего — на сегодня", () => {
    const state = g002();
    expect(overviewModel(state, "2026-07", "2026-10-19").asOf).toBe("2026-07-31");
    expect(overviewModel(state, "2026-10", "2026-10-19").asOf).toBe("2026-10-19");
    expect(overviewModel(state, "2026-06", "2026-10-19").asOf).toBe("2026-06-30");
  });

  it("основной счёт — первый активный в базовой валюте по порядку списка", () => {
    const state = g002();
    expect(defaultAccountOf(state)?.id).toBe(state.accounts[0]!.id);
    const dollarsFirst: BudgetState = {
      ...state,
      accounts: [
        { id: DOLLARS, name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 0, active: true, sortOrder: -1 },
        ...state.accounts.map((item, index) => ({ ...item, sortOrder: index })),
      ],
    };
    expect(defaultAccountOf(dollarsFirst)?.id).toBe(state.accounts[0]!.id);
    const archivedFirst: BudgetState = { ...state, accounts: state.accounts.map((item, index) => (index === 0 ? { ...item, active: false } : item)) };
    expect(defaultAccountOf(archivedFirst)?.id).toBe(state.accounts[1]!.id);
    expect(defaultAccountOf({ ...state, accounts: [] })).toBeNull();
  });
});
