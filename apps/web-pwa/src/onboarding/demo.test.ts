import {
  calculateAnnualPlan,
  calculateBudget,
  categoryNameKey,
  DEFAULT_CATEGORIES,
  makePlanningSeed,
  type BudgetState,
} from "@family-budget/domain";
import { describe, expect, it } from "vitest";

import { prepareBudgetState } from "../backup";
import { categoryVisual } from "../category-visual";
import { buildDemoBudgetState } from "./demo";

/** Всё, кроме словаря категорий: именно это демо обязано унести из канонического набора без правок. */
function withoutCategories(state: BudgetState): Omit<BudgetState, "categories"> {
  const { categories: _categories, ...rest } = state;
  return rest;
}

describe("демонстрационный бюджет", () => {
  it("оставляет канонические суммы G-002 нетронутыми", () => {
    const seed = makePlanningSeed();
    const demo = buildDemoBudgetState();

    // Ни одной суммы, даты и ссылки: демо меняет словарь категорий и только его.
    expect(withoutCategories(demo)).toEqual(withoutCategories(seed));

    // Итоги совпадают до копейки. Разбор по категориям сравнивается только там, где у категории
    // есть суммы: у шестнадцати новых строк каталога нет ни плана, ни операций, и домен честно
    // заводит им нулевую метрику — это не изменение сумм, а появление имени в словаре.
    const demoTotals = calculateBudget(demo);
    const seedTotals = calculateBudget(seed);
    expect(demoTotals).toMatchObject({
      incomeMinor: seedTotals.incomeMinor,
      expensesMinor: seedTotals.expensesMinor,
      capitalMinor: seedTotals.capitalMinor,
      accountBalancesMinor: seedTotals.accountBalancesMinor,
    });
    for (const [categoryId, metric] of Object.entries(seedTotals.categoryMetrics)) {
      expect(demoTotals.categoryMetrics[categoryId]).toEqual(metric);
    }
    const added = Object.values(demoTotals.categoryMetrics)
      .filter((metric) => seedTotals.categoryMetrics[metric.categoryId] === undefined);
    const addedExpenses = DEFAULT_CATEGORIES.filter((template) => template.type === "expense").length
      - seed.categories.filter((category) => category.type === "expense").length;
    expect(added).toHaveLength(addedExpenses);
    expect(added.every((metric) => metric.actualMinor === 0 && metric.status === "no_plan")).toBe(true);

    const plan = calculateAnnualPlan(demo, "2026-07", 24);
    expect(plan.months[0]).toMatchObject({
      month: "2026-07",
      annualReserveMinor: 1_980_900,
      spendableAfterPlanMinor: 4_419_100,
    });
    expect(plan.months.find((month) => month.month === "2026-09")).toMatchObject({
      seasonalExpenseMinor: 3_100_000,
      spendableAfterPlanMinor: 1_319_100,
    });
    expect(plan.months.find((month) => month.month === "2027-01")?.annualDueMinor).toBe(7_200_000);
    expect(calculateAnnualPlan(demo, "2026-07", 24)).toEqual(calculateAnnualPlan(seed, "2026-07", 24));
  });

  it("показывает весь стартовый набор, а не семь его категорий", () => {
    const demo = buildDemoBudgetState();
    const catalogue = DEFAULT_CATEGORIES.map((template) => categoryNameKey(template.name));

    expect(demo.categories).toHaveLength(DEFAULT_CATEGORIES.length);
    expect(demo.categories.map((category) => categoryNameKey(category.name))).toEqual(catalogue);
    expect(demo.categories.every((category) => category.active)).toBe(true);
  });

  it("даёт каждой строке демо собственную иконку, а не общий ярлык группы", () => {
    const demo = buildDemoBudgetState();
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
    const demo = buildDemoBudgetState();
    expect(prepareBudgetState(JSON.parse(JSON.stringify(demo)) as unknown)).toEqual(demo);
    // Дважды подряд — одно и то же состояние: демо попадает в журнал семьи и в резервную копию.
    expect(buildDemoBudgetState()).toEqual(demo);
  });
});
