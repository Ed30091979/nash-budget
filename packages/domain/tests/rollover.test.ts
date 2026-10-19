import { describe, expect, it } from "vitest";

import {
  budgetMonth,
  calculateAnnualPlan,
  calculateBudget,
  carriedBudgetId,
  carriedBudgetLineId,
  carryBudgetForward,
  findBudgetForMonth,
  HOUSEHOLD_ID,
  makeSeedBudget,
  monthAfterPeriod,
  SEED_IDS,
  type BudgetState,
} from "../src/index.js";

/**
 * Приёмка переноса месяца на конкретных числах.
 *
 * G-000: план 40 000 / 30 000 / 10 000 ₽ по трём конвертам, факт 40 000 / 31 500 / 5 000 ₽. То
 * есть жильё сошлось в ноль, продукты ушли за лимит на 1 500 ₽, транспорт сберёг 5 000 ₽ —
 * ровно три случая, которые перенос обязан различать.
 */
const HOUSING = SEED_IDS.categories.housing;
const FOOD = SEED_IDS.categories.food;
const TRANSPORT = SEED_IDS.categories.transport;

function lineOf(state: BudgetState, budgetId: string, categoryId: string) {
  const budget = state.budgets.find((item) => item.id === budgetId);
  return budget?.lines.find((line) => line.categoryId === categoryId);
}

describe("перенос месяца", () => {
  it("создаёт август из июля: план сохранён, остаток уехал в rolloverMinor и виден в доступном", () => {
    const july = makeSeedBudget();
    const { state, budget, created } = carryBudgetForward(july, "2026-08");

    expect(created).toBe(true);
    expect(budgetMonth(budget)).toBe("2026-08");
    expect(budget.startDate).toBe("2026-08-01");
    expect(budget.endDate).toBe("2026-08-31");
    expect(budget.status).toBe("open");
    expect(state.activeBudgetId).toBe(budget.id);
    expect(state.budgets).toHaveLength(2);

    // План перенесён строка в строку.
    expect(budget.lines.map((line) => [line.categoryId, line.plannedMinor])).toEqual([
      [HOUSING, 4_000_000],
      [FOOD, 3_000_000],
      [TRANSPORT, 1_000_000],
    ]);

    // Транспорт: 10 000 плана, 5 000 факта — 5 000 ₽ остатка уходят в новый месяц.
    expect(lineOf(state, budget.id, TRANSPORT)?.rolloverMinor).toBe(500_000);
    // Жильё сошлось в ноль: переносить нечего, и поля нет вовсе.
    expect(lineOf(state, budget.id, HOUSING)?.rolloverMinor).toBeUndefined();
    // Продукты ушли за лимит на 1 500 ₽: перерасход не переносится ни минусом, ни как-то ещё.
    expect(lineOf(state, budget.id, FOOD)?.rolloverMinor).toBeUndefined();

    // И это видно в доступном: транспорт августа — план плюс перенос.
    const august = calculateBudget(state);
    expect(august.categoryMetrics[TRANSPORT]?.availableMinor).toBe(1_500_000);
    expect(august.categoryMetrics[TRANSPORT]?.remainingMinor).toBe(1_500_000);
    expect(august.categoryMetrics[FOOD]?.availableMinor).toBe(3_000_000);
    expect(august.categoryMetrics[HOUSING]?.availableMinor).toBe(4_000_000);

    // «Можно на повседневные расходы» августа больше июльского плана ровно на перенос.
    const plan = calculateAnnualPlan(state, "2026-08", 12);
    expect(plan.currentMonth.flexiblePlanMinor).toBe(8_500_000);
    // Июль закрыт записью, а не только календарём.
    expect(state.budgets.find((item) => item.id === july.activeBudgetId)?.status).toBe("closed");
  });

  it("не создаёт второго бюджета на тот же месяц: повторное открытие только переводит указатель", () => {
    const july = makeSeedBudget();
    const first = carryBudgetForward(july, "2026-08");
    const second = carryBudgetForward(first.state, "2026-08");

    expect(second.created).toBe(false);
    expect(second.budget.id).toBe(first.budget.id);
    expect(second.state.budgets).toHaveLength(2);
    expect(second.state).toEqual(first.state);

    // И даже если указатель успел уехать на июль, второй август не появляется.
    const pointedBack = { ...first.state, activeBudgetId: july.activeBudgetId };
    const third = carryBudgetForward(pointedBack, "2026-08");
    expect(third.created).toBe(false);
    expect(third.state.budgets).toHaveLength(2);
    expect(third.state.activeBudgetId).toBe(first.budget.id);
  });

  it("даёт двум устройствам одно и то же имя месяца: идентификатор выведен, а не выдуман", () => {
    const july = makeSeedBudget();
    const anna = carryBudgetForward(july, "2026-08");
    const boris = carryBudgetForward(july, "2026-08");

    expect(boris.budget.id).toBe(anna.budget.id);
    expect(boris.budget.id).toBe(carriedBudgetId(july.activeBudgetId, "2026-08"));
    expect(boris.state).toEqual(anna.state);
    for (const line of anna.budget.lines) {
      const source = july.budgets[0]!.lines.find((item) => item.categoryId === line.categoryId)!;
      expect(line.id).toBe(carriedBudgetLineId(source.id, "2026-08"));
    }

    // Имя — UUID: иначе состояние нельзя выгрузить в резервную копию, где проверяется форма.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    expect(anna.budget.id).toMatch(uuid);
    expect(anna.budget.lines.every((line) => uuid.test(line.id))).toBe(true);
    // Разные месяцы — разные имена, и ни одно не совпадает с именем предка.
    const september = carryBudgetForward(anna.state, "2026-09");
    expect(new Set([july.activeBudgetId, anna.budget.id, september.budget.id]).size).toBe(3);
  });

  it("выводит те же имена, что сборка 1.0.0: значения закреплены литералами", () => {
    // Имя — функция и частей ключа, и разделителя между ними. Устройство на новой сборке и
    // устройство на старой обязаны назвать один и тот же август одинаково, иначе семья получит
    // два августа, поэтому запись разделителя в исходнике (U+0000) может меняться только так,
    // чтобы эти строки остались прежними. Значения вычислены кодом 1.0.0.
    expect(carriedBudgetId(SEED_IDS.budget, "2026-08")).toBe("e509f49c-d23c-8f28-a5fa-8c8825f728e2");
    expect(carriedBudgetLineId("44444444-4444-4444-8444-444444444451", "2026-08"))
      .toBe("f97df4be-d7b2-8abc-ae43-cbb8fdd5bd33");
    expect(carryBudgetForward(makeSeedBudget(), "2026-08").budget.id).toBe("e509f49c-d23c-8f28-a5fa-8c8825f728e2");
  });

  it("переносит остаток дальше по цепочке месяцев, накапливая его в конверте", () => {
    const august = carryBudgetForward(makeSeedBudget(), "2026-08").state;
    // В августе по транспорту ничего не потрачено: 10 000 плана и 5 000 переноса целы.
    const september = carryBudgetForward(august, "2026-09");
    expect(lineOf(september.state, september.budget.id, TRANSPORT)?.rolloverMinor).toBe(1_500_000);
    expect(lineOf(september.state, september.budget.id, TRANSPORT)?.plannedMinor).toBe(1_000_000);
  });

  it("перепрыгивает пропущенные месяцы: остаток июля уходит в сентябрь целиком", () => {
    const july = makeSeedBudget();
    const september = carryBudgetForward(july, "2026-09");

    expect(september.state.budgets.map(budgetMonth)).toEqual(["2026-07", "2026-09"]);
    expect(lineOf(september.state, september.budget.id, TRANSPORT)?.rolloverMinor).toBe(500_000);
    expect(findBudgetForMonth(september.state, "2026-08")).toBeUndefined();
  });

  it("оставляет строку архивной категории в прошлом месяце, а архивную строку — без переноса", () => {
    const source = makeSeedBudget();
    const state: BudgetState = {
      ...source,
      // Транспорт архивирован как категория: хозяйство его больше не ведёт.
      categories: source.categories.map((category) =>
        category.id === TRANSPORT ? { ...category, active: false } : category),
      // Продукты остаются категорией, но конверт на месяц выключен.
      budgets: source.budgets.map((budget) => ({
        ...budget,
        lines: budget.lines.map((line) => (line.categoryId === FOOD ? { ...line, active: false } : line)),
      })),
    };
    const { state: next, budget } = carryBudgetForward(state, "2026-08");

    expect(budget.lines.map((line) => line.categoryId)).toEqual([HOUSING, FOOD]);
    const food = lineOf(next, budget.id, FOOD)!;
    expect(food.active).toBe(false);
    expect(food.plannedMinor).toBe(3_000_000);
    expect(food.rolloverMinor).toBeUndefined();
    expect(calculateBudget(next).categoryMetrics[FOOD]?.availableMinor).toBe(0);
  });

  it("не трогает цели, крупные платежи, расписания и операции", () => {
    const july = makeSeedBudget();
    const { state } = carryBudgetForward(july, "2026-08");

    expect(state.goals).toEqual(july.goals);
    expect(state.annualCommitments).toEqual(july.annualCommitments);
    expect(state.scheduledExpenses).toEqual(july.scheduledExpenses);
    expect(state.transactions).toEqual(july.transactions);
    expect(state.categories).toEqual(july.categories);
    expect(state.accounts).toEqual(july.accounts);
  });

  it("переносит излишек возврата и не переносит корректировку месяца", () => {
    const source = makeSeedBudget();
    const state: BudgetState = {
      ...source,
      budgets: source.budgets.map((budget) => ({
        ...budget,
        lines: budget.lines.map((line) =>
          line.categoryId === TRANSPORT ? { ...line, adjustmentMinor: 200_000 } : line),
      })),
    };
    const { state: next, budget } = carryBudgetForward(state, "2026-08");
    const transport = lineOf(next, budget.id, TRANSPORT)!;

    // Доступного было 12 000, потрачено 5 000 — переносится 7 000 ₽.
    expect(transport.rolloverMinor).toBe(700_000);
    // А сама разовая корректировка в новый месяц не едет.
    expect(transport.adjustmentMinor).toBeUndefined();
  });

  it("называет месяц, который стоит открыть, по сегодняшнему дню, а не по номеру месяца плана", () => {
    const july = makeSeedBudget().budgets[0]!;

    expect(monthAfterPeriod(july, "2026-09-04")).toBe("2026-09");
    expect(monthAfterPeriod(july, "2026-08-01")).toBe("2026-08");
    expect(monthAfterPeriod(july, "2027-01-31")).toBe("2027-01");
    // Период короче месяца: следующим предлагается август, а не тот же июль.
    const half = { ...july, endDate: "2026-07-15" };
    expect(monthAfterPeriod(half, "2026-07-20")).toBe("2026-08");
  });

  it("отказывается открывать месяц, которому не из чего расти", () => {
    expect(() => carryBudgetForward(makeSeedBudget(), "2026-06")).toThrow("nothing to carry forward");
    expect(() => carryBudgetForward(makeSeedBudget(), "2026-13")).toThrow("valid calendar month");
  });

  it("считает конец месяца по календарю, включая февраль високосного года", () => {
    const july = makeSeedBudget();
    const february = carryBudgetForward(july, "2028-02");
    expect(february.budget.endDate).toBe("2028-02-29");
    const april = carryBudgetForward(july, "2027-04");
    expect(april.budget.endDate).toBe("2027-04-30");
  });

  it("не трогает метки и помеченные операции, а выведенное имя проверяет и против них", () => {
    const july = makeSeedBudget();
    const tagged: BudgetState = {
      ...july,
      tags: [{ id: "8a000000-0000-4000-8000-0000000000a1", name: "Отпуск", active: true }],
      transactions: july.transactions.map((transaction) => ({
        ...transaction,
        note: "Заметка",
        tagIds: ["8a000000-0000-4000-8000-0000000000a1"],
      })),
    };
    const { state } = carryBudgetForward(tagged, "2026-08");
    expect(state.tags).toEqual(tagged.tags);
    expect(state.transactions).toEqual(tagged.transactions);

    // Метка, занявшая имя будущего августа, — та же коллизия, что и любая другая сущность.
    const clash: BudgetState = {
      ...tagged,
      tags: [{ id: carriedBudgetId(july.activeBudgetId, "2026-08"), name: "Совпадение", active: true }],
      transactions: july.transactions,
    };
    expect(() => carryBudgetForward(clash, "2026-08")).toThrow(/is already used/);
  });
  it("не трогает хозяйство, курсы и валютные счета и переносит остаток конверта в базовой валюте", () => {
    const july = makeSeedBudget();
    const usd = "8c000000-0000-4000-8000-0000000000a2";
    const state: BudgetState = {
      ...july,
      household: { id: HOUSEHOLD_ID, baseCurrency: "RUB" },
      exchangeRates: [{ id: "8e000000-0000-4000-8000-000000000001", currency: "USD", baseCurrency: "RUB", date: "2026-06-30", rate: { baseMinor: 9_000, quoteMinor: 100 } }],
      accounts: [...july.accounts, { id: usd, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true }],
      transactions: [
        ...july.transactions,
        // 10 $ на транспорт по 90 ₽: в конверт попадают 900 ₽, а не 10 «копеек».
        { id: "8d000000-0000-4000-8000-000000000003", occurredOn: "2026-07-10", status: "posted", kind: "expense", amountMinor: 1_000, accountId: usd, categoryId: TRANSPORT, baseAmountMinor: 90_000, baseCurrency: "RUB", rate: { baseMinor: 9_000, quoteMinor: 100 } },
      ],
    };
    const { state: next, budget } = carryBudgetForward(state, "2026-08");

    expect(next.household).toEqual(state.household);
    expect(next.exchangeRates).toEqual(state.exchangeRates);
    expect(next.accounts).toEqual(state.accounts);
    expect(next.transactions).toEqual(state.transactions);
    // Доступно 10 000 ₽, потрачено 5 000 ₽ и ещё 900 ₽ долларами — переносится 4 100 ₽.
    expect(lineOf(next, budget.id, TRANSPORT)?.rolloverMinor).toBe(410_000);
  });
});
