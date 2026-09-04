import {
  calculateAnnualPlan,
  calculateBudget,
  categoryNameKey,
  DEFAULT_CATEGORIES,
  makePlanningSeed,
  monthOfDate,
  type AnnualPlanMetrics,
  type BudgetState,
} from "@family-budget/domain";
import { describe, expect, it } from "vitest";

import { prepareBudgetState } from "../backup";
import { categoryVisual } from "../category-visual";
import { paydayDays, periodClock } from "../reach";
import { buildDemoBudgetState, CANONICAL_DEMO_MONTH } from "./demo";

/** Дни, на которых демо проверяется: разный отступ от канонического июля и разное число месяца. */
const DAYS = ["2026-07-04", "2026-09-04", "2026-09-30", "2026-12-01", "2027-02-28", "2031-01-15"];

/** Всё, кроме словаря категорий и операций: остальное демо уносит из канонического набора как есть. */
function scene(state: BudgetState) {
  const { categories: _categories, transactions: _transactions, ...rest } = state;
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

      // Итоги месяца — до копейки те же: доход 180 000 ₽ разложен на аванс и получку, а не изменён.
      const totals = calculateBudget(demo);
      expect(totals).toMatchObject({
        incomeMinor: seedTotals.incomeMinor,
        expensesMinor: seedTotals.expensesMinor,
        capitalMinor: seedTotals.capitalMinor,
        accountBalancesMinor: seedTotals.accountBalancesMinor,
      });
      for (const [categoryId, metric] of Object.entries(seedTotals.categoryMetrics)) {
        expect(totals.categoryMetrics[categoryId]).toEqual(metric);
      }
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
