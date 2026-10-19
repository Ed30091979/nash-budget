import {
  calculateAnnualPlan,
  calculateBudget,
  calculateDebts,
  calculateHoldings,
  calculateTagExpenses,
  categoryNameKey,
  DEFAULT_CATEGORIES,
  HOUSEHOLD_ID,
  makePlanningSeed,
  monthOfDate,
  PLANNING_IDS,
  type AnnualPlanMetrics,
  type BudgetState,
} from "@family-budget/domain";
import { describe, expect, it } from "vitest";

import { prepareBudgetState } from "../backup";
import { categoryVisual } from "../category-visual";
import { paydayDays, periodClock } from "../reach";
import { reachLineModel } from "../features/overview/overview-model";
import { buildDemoBudgetState, CANONICAL_DEMO_MONTH, DEMO_IDS } from "./demo";

/** Дни, на которых демо проверяется: разный отступ от канонического июля и разное число месяца. */
const DAYS = ["2026-07-04", "2026-09-04", "2026-09-30", "2026-12-01", "2027-02-28", "2031-01-15"];

/**
 * Каркас плана: период, лимиты, крупные платежи и расписания демо уносит из канонического набора как
 * есть. Словарь категорий, операции, счета, цель и новые коллекции v5 — свои (проверены ниже).
 */
function scene(state: BudgetState) {
  const {
    categories: _categories, transactions: _transactions, accounts: _accounts, goals: _goals, household: _household,
    tags: _tags, exchangeRates: _rates, debts: _debts, recurringRules: _rules, ...rest
  } = state;
  return rest;
}

/** Месяцы плана без их имён: сравнивать надо суммы, а имена месяцев как раз и переезжают. */
function amountsByMonth(plan: AnnualPlanMetrics) {
  return plan.months.map(({ month: _month, ...amounts }) => amounts);
}

function activeBudgetOf(state: BudgetState) {
  return state.budgets.find((budget) => budget.id === state.activeBudgetId)!;
}

describe("демонстрационный бюджет", () => {
  it("всегда попадает в текущий месяц, а не в июль 2026", () => {
    for (const today of DAYS) {
      const demo = buildDemoBudgetState(today);
      const budget = activeBudgetOf(demo);
      const clock = periodClock(
        budget,
        demo.transactions.filter((item) => item.kind === "income").map((item) => item.occurredOn),
        today,
      );

      expect(monthOfDate(budget.startDate)).toBe(monthOfDate(today));
      expect(budget.startDate.endsWith("-01")).toBe(true);
      // Месяц открыт, значит на «Сегодня» есть линейка до выплаты и предпросмотр покупки в
      // конвертах — то, ради чего демо и показывают.
      expect(clock.inPeriod).toBe(true);
      expect(clock.position).toBe("inside");
    }
  });

  it("оставляет канонические суммы G-002 нетронутыми, в какой бы месяц ни переехала сцена", () => {
    const seed = makePlanningSeed();
    const seedPlan = calculateAnnualPlan(seed, CANONICAL_DEMO_MONTH, 24);
    const seedTotals = calculateBudget(seed);

    // Июль 2026: демо стоит ровно на каноническом наборе, и сцена не двигается вовсе.
    expect(scene(buildDemoBudgetState("2026-07-04"))).toEqual(scene(seed));

    for (const today of DAYS) {
      const demo = buildDemoBudgetState(today);
      const month = monthOfDate(today);
      const plan = calculateAnnualPlan(demo, month, 24);

      // Двадцать четыре месяца горизонта, месяц в месяц: ни одна сумма плана не сдвинулась —
      // сдвинулись только имена месяцев, которыми они названы.
      expect(amountsByMonth(plan)).toEqual(amountsByMonth(seedPlan));
      // Те самые числа приёмки, названные поимённо.
      expect(plan.months[0]).toMatchObject({
        month,
        annualReserveMinor: 1_980_900,
        spendableAfterPlanMinor: 4_419_100,
      });
      // Дно горизонта — третий месяц сцены, где начинается сезон обучения.
      expect(plan.months[2]).toMatchObject({
        seasonalExpenseMinor: 3_100_000,
        spendableAfterPlanMinor: 1_319_100,
      });
      expect(plan.months[6]?.annualDueMinor).toBe(7_200_000);
      // Резервы крупных платежей считаются от расстояния до срока, и оно тоже сохранено.
      for (const [id, metrics] of Object.entries(seedPlan.commitments)) {
        expect(plan.commitments[id]).toEqual(metrics);
      }

      // Расходы месяца и каждая категория — до копейки те же: 71 000 ₽ разбиты на покупки по дням,
      // а не изменены. Доход месяца — то, что уже пришло: выплата, день которой не наступил, ожидается.
      const totals = calculateBudget(demo);
      expect(totals).toMatchObject({ expensesMinor: seedTotals.expensesMinor, refundsMinor: seedTotals.refundsMinor });
      const day = Number(today.slice(8, 10));
      expect(totals.incomeMinor).toBe((day >= 5 ? 7_000_000 : 0) + (day >= 20 ? 11_000_000 : 0));
      expect(demo.budgets[0]!.plannedIncomeMinor).toBe(18_000_000);
      for (const [categoryId, metric] of Object.entries(seedTotals.categoryMetrics)) {
        expect(totals.categoryMetrics[categoryId]).toEqual(metric);
      }
      // «Можно на повседневные» G-002 — 27 000 ₽ в любом месяце сцены.
      expect(reachLineModel(demo, plan.currentMonth.flexiblePlanMinor).safeToSpendMinor).toBe(2_700_000);
      const added = Object.values(totals.categoryMetrics)
        .filter((metric) => seedTotals.categoryMetrics[metric.categoryId] === undefined);
      const addedExpenses = DEFAULT_CATEGORIES.filter((template) => template.type === "expense").length
        - seed.categories.filter((category) => category.type === "expense").length;
      expect(added).toHaveLength(addedExpenses);
      expect(added.every((metric) => metric.actualMinor === 0 && metric.status === "no_plan")).toBe(true);
    }
  });

  it("помнит регулярные доходы, поэтому ось года и линейка знают про аванс и получку", () => {
    for (const today of DAYS) {
      const demo = buildDemoBudgetState(today);
      const incomes = demo.transactions.filter((item) => item.kind === "income");
      const month = monthOfDate(today);
      const thisMonth = incomes.filter((item) => monthOfDate(item.occurredOn) === month);

      // Числа выплат выводятся из истории — и выводятся в любой день месяца, включая первый,
      // когда обе выплаты этого месяца ещё впереди.
      expect(paydayDays(incomes.map((item) => item.occurredOn), today)).toEqual([5, 20]);
      // В самом месяце — аванс и получка, и вместе они дают канонические 180 000 ₽.
      expect(thisMonth.map((item) => item.occurredOn)).toEqual([`${month}-05`, `${month}-20`]);
      expect(thisMonth.reduce((total, item) => total + item.amountMinor, 0)).toBe(18_000_000);
      // Каждая выплата названа категорией дохода, а не безымянным «Доходом».
      const salary = demo.categories.find((category) => categoryNameKey(category.name) === categoryNameKey("Зарплата"));
      expect(incomes.every((item) => item.kind === "income" && item.categoryId === salary?.id)).toBe(true);
    }
  });

  it("данные макетов v5 на 19 октября: четыре счёта на те же 554 000 ₽, курс, метки, долг, цель и ожидаемая получка", () => {
    const today = "2026-10-19";
    const demo = buildDemoBudgetState(today);
    const holdings = calculateHoldings(demo, today);
    const balance = (id: string) => holdings.accountBalancesMinor[id];
    expect(demo.accounts.map((account) => [account.name, account.currency])).toEqual([
      ["Карта", "RUB"], ["Резерв платежей", "RUB"], ["Наличные", "RUB"], ["Доллары", "USD"],
    ]);
    expect(balance(DEMO_IDS.accounts.card)).toBe(41_800_000);
    expect(balance(DEMO_IDS.accounts.cash)).toBe(1_000_000);
    expect(balance(DEMO_IDS.accounts.reserve)).toBe(1_500_000);
    expect(balance(DEMO_IDS.accounts.dollars)).toBe(120_000);
    // 1 200 $ по 92,50 — 111 000 ₽, и итог «На счетах» тот же, что в прежнем демо: 554 000 ₽.
    expect(holdings.totalInBaseMinor).toBe(55_400_000);
    expect(demo.exchangeRates?.map((rate) => [rate.date, rate.rate.baseMinor])).toEqual([["2026-09-15", 9_310], ["2026-10-01", 9_180], ["2026-10-15", 9_250]]);
    // Расходы октября 71 000 = Жильё 45 000 + Продукты 22 000 + Транспорт 4 000, по дням макета.
    const totals = calculateBudget(demo);
    expect(totals.expensesMinor).toBe(7_100_000);
    expect(totals.categoryMetrics[PLANNING_IDS.categories.food]?.actualMinor).toBe(2_200_000);
    expect(totals.categoryMetrics[PLANNING_IDS.categories.transport]?.actualMinor).toBe(400_000);
    expect(totals.categoryMetrics[PLANNING_IDS.categories.housing]?.actualMinor).toBe(4_500_000);
    // Доходы октября на сегодня — 70 000: получка 20-го ожидается, а не записана будущей датой.
    expect(totals.incomeMinor).toBe(7_000_000);
    const salary20 = demo.transactions.find((item) => item.kind === "income" && item.occurredOn === "2026-10-20");
    expect(salary20?.status).toBe("pending");
    expect(demo.transactions.filter((item) => item.status === "posted").every((item) => item.occurredOn <= today)).toBe(true);
    // Метки: «дача» на двух операциях 18-го, «отпуск» пока пустая.
    expect(demo.tags?.map((tag) => tag.name)).toEqual(["отпуск", "дача"]);
    const byTag = calculateTagExpenses(demo).byTag;
    expect(byTag[DEMO_IDS.tags.dacha]).toMatchObject({ expenseMinor: 590_000, transactionCount: 2 });
    expect(byTag[DEMO_IDS.tags.vacation]).toMatchObject({ expenseMinor: 0, transactionCount: 0 });
    // Долг: Саша должен 5 000 ₽ до 1 ноября.
    expect(demo.debts).toEqual([{ id: DEMO_IDS.debt, counterparty: "Саша", direction: "owed_to_me", currency: "RUB", openingMinor: 0, dueDate: "2026-11-01", active: true }]);
    expect(calculateDebts(demo, today).debts[0]).toMatchObject({ balanceMinor: 500_000, overdue: false });
    // Цель «Отпуск»: 45 000 из 150 000 ₽ — прежняя цель набора, взнос по плану тот же.
    expect(demo.goals.map((goal) => [goal.name, goal.openingContributedMinor, goal.targetMinor, goal.plannedContributionMinor])).toEqual([["Отпуск", 4_500_000, 15_000_000, 1_000_000]]);
    // Регулярные: зарплата 20-го и аренда 5-го, водяной знак — на конце месяца сцены.
    expect(demo.recurringRules?.map((rule) => [rule.name, rule.template.amountMinor, rule.startDate.slice(8), rule.materializedThrough])).toEqual([
      ["Зарплата", 11_000_000, "20", "2026-10-31"], ["Аренда", 4_500_000, "05", "2026-10-31"],
    ]);
    // Дни выплат названы: «хватает до 20 октября».
    expect(demo.household).toEqual({ id: HOUSEHOLD_ID, baseCurrency: "RUB", paydays: [5, 20] });
    const budget = activeBudgetOf(demo);
    expect(periodClock(budget, [], today, demo.household?.paydays).payday.date).toBe("2026-10-20");
  });

  it("показывает весь стартовый набор, а не семь его категорий", () => {
    const demo = buildDemoBudgetState("2026-09-04");
    const catalogue = DEFAULT_CATEGORIES.map((template) => categoryNameKey(template.name));

    expect(demo.categories).toHaveLength(DEFAULT_CATEGORIES.length);
    expect(demo.categories.map((category) => categoryNameKey(category.name))).toEqual(catalogue);
    expect(demo.categories.every((category) => category.active)).toBe(true);
  });

  it("даёт каждой строке демо собственную иконку, а не общий ярлык группы", () => {
    const demo = buildDemoBudgetState("2026-09-04");
    const planned = new Set([
      ...demo.budgets.flatMap((budget) => budget.lines.map((line) => line.categoryId)),
      ...demo.scheduledExpenses.map((item) => item.categoryId),
      ...demo.annualCommitments.map((item) => item.categoryId),
    ]);
    const shown = demo.categories.filter((category) => planned.has(category.id));

    // Строки, у которых есть суммы, — те самые, что человек видит на «Сегодня» и на «Годе».
    expect(shown).toHaveLength(7);
    expect(shown.map((category) => categoryVisual(category).icon)).not.toContain("tag");
    // Тон метит категорию: соседние строки списка лимитов обязаны различаться.
    const limitTones = demo.budgets[0]!.lines
      .map((line) => demo.categories.find((category) => category.id === line.categoryId)!)
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((category) => categoryVisual(category).tone);
    expect(limitTones.some((tone, index) => index > 0 && tone === limitTones[index - 1])).toBe(false);
  });

  it("проходит ту же проверку состояния, что и восстановленная резервная копия", () => {
    for (const today of DAYS) {
      const demo = buildDemoBudgetState(today);
      expect(prepareBudgetState(JSON.parse(JSON.stringify(demo)) as unknown)).toEqual(demo);
      // Дважды подряд — одно и то же состояние: демо попадает в журнал семьи и в резервную копию.
      expect(buildDemoBudgetState(today)).toEqual(demo);
    }
  });
});
