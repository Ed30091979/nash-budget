import {
  calculateAnnualPlan,
  calculateBudget,
  calculateMonthlySeries,
  calculatePeriodBreakdown,
  carryBudgetForward,
  convertMinor,
  monthAfterPeriod,
  shiftMonth,
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
import { overviewModel, reachLineModel } from "../features/overview/overview-model";
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

  it("сцена — прошлое: в любой день месяца нет записанной операции позже сегодня, а 27 000 ₽ — те же (ревью R2, L-10)", () => {
    const seedTotals = calculateBudget(makePlanningSeed());
    for (const today of ["2026-10-01", "2026-10-15", "2026-10-19", "2026-10-28", "2026-10-31"]) {
      const demo = buildDemoBudgetState(today);
      // Будущее бывает только ожидаемым — это выплаты; всё ожидаемое — в будущем.
      const future = demo.transactions.filter((item) => item.occurredOn > today);
      expect(future.every((item) => item.kind === "income" && item.status === "pending"), today).toBe(true);
      expect(demo.transactions.filter((item) => item.status === "pending").every((item) => item.occurredOn > today), today).toBe(true);
      // Канонические числа месяца — в любой день: расходы, повседневный план и «Можно на повседневные».
      const plan = calculateAnnualPlan(demo, "2026-10", 24);
      expect(calculateBudget(demo).expensesMinor, today).toBe(seedTotals.expensesMinor);
      expect(plan.currentMonth.flexiblePlanMinor, today).toBe(5_300_000);
      expect(reachLineModel(demo, plan.currentMonth.flexiblePlanMinor).safeToSpendMinor, today).toBe(2_700_000);
    }
    // До 5-го вся сцена — сегодняшним числом; с 19-го — по дням макетов.
    expect(new Set(buildDemoBudgetState("2026-10-01").transactions.filter((item) => item.kind !== "income" && item.occurredOn >= "2026-10-01").map((item) => item.occurredOn))).toEqual(new Set(["2026-10-01"]));
    expect(buildDemoBudgetState("2026-10-19").transactions.find((item) => item.kind === "debt_out")?.occurredOn).toBe("2026-10-12");
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
    // Курсы макетов и ещё один — дня покупки в долларах из истории (три месяца назад, 14-го).
    expect(demo.exchangeRates?.map((rate) => [rate.date, rate.rate.baseMinor])).toEqual([["2026-07-14", 8_960], ["2026-09-15", 9_310], ["2026-10-01", 9_180], ["2026-10-15", 9_250]]);
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
    // Метки в месяце плана: «дача» на двух операциях 18-го, «отпуск» — только в истории.
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

  it("показывает весь стартовый набор расходов, а не семь его категорий; из доходов — только «Зарплату»", () => {
    const demo = buildDemoBudgetState("2026-09-04");
    const catalogue = DEFAULT_CATEGORIES.map((template) => categoryNameKey(template.name));

    expect(demo.categories).toHaveLength(DEFAULT_CATEGORIES.length);
    expect(demo.categories.map((category) => categoryNameKey(category.name))).toEqual(catalogue);
    expect(demo.categories.filter((category) => category.type === "expense").every((category) => category.active)).toBe(true);
    // Макет 06: в ряду «Доходы и счета» — «Зарплата» и сразу счета. Источники без единой операции —
    // в архиве, как у набора; тот, по которому есть записи или регулярная запись, — активен.
    const income = demo.categories.filter((category) => category.type === "income");
    expect(income.filter((category) => category.active).map((category) => category.name)).toEqual(["Зарплата"]);
    const used = new Set(demo.transactions.flatMap((item) => ("categoryId" in item && item.categoryId ? [item.categoryId] : [])));
    for (const category of income) expect(category.active, category.name).toBe(used.has(category.id));
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

describe("демо: пять прошлых месяцев трат — история «Отчётов» (макет 09)", () => {
  /** Дни проверки: начало, середина, 19-е макетов, конец месяца — и другие месяцы и годы сцены. */
  const MONTH_DAYS = ["2026-10-01", "2026-10-15", "2026-10-19", "2026-10-28", "2026-10-31", "2027-02-28", "2031-01-15"];

  it("на 19 октября «По месяцам» — 76 200 · 81 500 · 74 300 · 88 900 · 79 400 · 71 000 ₽, доход прошлых месяцев — 180 000", () => {
    const demo = buildDemoBudgetState("2026-10-19");
    const months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
    const series = calculateMonthlySeries(demo, months);
    expect(series.months.map((row) => row.expenseMinor)).toEqual([7_620_000, 8_150_000, 7_430_000, 8_890_000, 7_940_000, 7_100_000]);
    expect(series.months.slice(0, 5).map((row) => row.incomeMinor)).toEqual([18_000_000, 18_000_000, 18_000_000, 18_000_000, 18_000_000]);
    // До истории — пусто: апрель ни трат, ни доходов не знает.
    expect(calculateMonthlySeries(demo, ["2026-04"]).months[0]).toMatchObject({ expenseMinor: 0, incomeMinor: 0 });
    // Сентябрь против октября — то сравнение, что видно в «Отчётах»: на 8 400 ₽ меньше.
    expect(series.months[4]!.expenseMinor - series.months[5]!.expenseMinor).toBe(840_000);
  });

  it("в любой день месяца и в любом месяце сцены: прошлые месяцы — от 70 до 90 тыс., разные; текущий — 71 000; будущего записанного нет", () => {
    for (const today of MONTH_DAYS) {
      const demo = buildDemoBudgetState(today);
      const month = monthOfDate(today);
      const past = [5, 4, 3, 2, 1].map((back) => shiftMonth(month, -back));
      const series = calculateMonthlySeries(demo, [...past, month]).months;
      const values = series.slice(0, 5).map((row) => row.expenseMinor);
      for (const value of values) {
        expect(value, today).toBeGreaterThanOrEqual(7_000_000);
        expect(value, today).toBeLessThanOrEqual(9_000_000);
      }
      expect(new Set(values).size, today).toBe(5);
      expect(series[5]!.expenseMinor, today).toBe(7_100_000);
      expect(demo.transactions.filter((item) => item.occurredOn > today).every((item) => item.status === "pending"), today).toBe(true);
      // Каждый прошлый месяц — продукты, транспорт, кафе, аренда и ЖКХ по разным дням.
      const breakdown = calculatePeriodBreakdown(demo, { from: `${past[4]}-01`, to: `${past[4]}-28` });
      expect(breakdown.expense.categories.length, today).toBeGreaterThanOrEqual(5);
      expect(new Set(demo.transactions.filter((item) => monthOfDate(item.occurredOn) === past[0] && item.kind === "expense").map((item) => item.occurredOn)).size, today).toBeGreaterThanOrEqual(8);
    }
  });

  it("«На счетах» на 19-е — те же 554 000 ₽ и та же карта: история сходится в остатках на начало", () => {
    for (const today of ["2026-10-19", "2027-02-19", "2031-01-19"]) {
      const demo = buildDemoBudgetState(today);
      const holdings = calculateHoldings(demo, today);
      expect(holdings.totalInBaseMinor, today).toBe(55_400_000);
      expect(holdings.accountBalancesMinor[DEMO_IDS.accounts.card], today).toBe(41_800_000);
      expect(holdings.accountBalancesMinor[DEMO_IDS.accounts.dollars], today).toBe(120_000);
      // Ни один счёт ни в один день истории не уходит в минус.
      const month = monthOfDate(today);
      for (let back = 5; back >= 0; back -= 1) {
        for (const day of ["01", "09", "16", "27"]) {
          const at = `${shiftMonth(month, -back)}-${day}`;
          if (at > today) continue;
          const balances = calculateHoldings(demo, at).accountBalancesMinor;
          for (const [id, value] of Object.entries(balances)) expect(value ?? 0, `${at} ${id}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("метки и доллары в истории: «отпуск» три месяца назад, с покупкой в долларах по курсу её дня; «дача» — два и четыре месяца назад", () => {
    const today = "2026-10-19";
    const demo = buildDemoBudgetState(today);
    const tagged = (tag: string, month: string) => calculatePeriodBreakdown(demo, { from: `${month}-01`, to: `${month}-28` }).tags.find((row) => row.tagId === tag)!;
    expect(tagged(DEMO_IDS.tags.vacation, "2026-07").transactionCount).toBe(2);
    expect(tagged(DEMO_IDS.tags.dacha, "2026-08").transactionCount).toBe(2);
    expect(tagged(DEMO_IDS.tags.dacha, "2026-06").transactionCount).toBe(1);
    const usd = demo.transactions.filter((item) => item.kind === "expense" && item.accountId === DEMO_IDS.accounts.dollars);
    expect(usd).toHaveLength(1);
    const [purchase] = usd;
    if (purchase?.kind !== "expense") throw new Error("покупка в долларах ожидалась");
    expect(purchase).toMatchObject({ occurredOn: "2026-07-14", amountMinor: 5_000, baseAmountMinor: 448_000, baseCurrency: "RUB" });
    const rate = demo.exchangeRates!.find((item) => item.date === purchase.occurredOn)!;
    expect(purchase.rate).toEqual(rate.rate);
    expect(purchase.baseAmountMinor).toBe(convertMinor(purchase.amountMinor, rate.rate));
  });

  it("прошлые месяцы — без плана: «Обзор» показывает их траты без лимитов, а «Открыть …» — только про месяц плана", () => {
    const today = "2026-10-19";
    const demo = buildDemoBudgetState(today);
    expect(demo.budgets).toHaveLength(1);
    for (const [month, spent] of [["2026-09", 7_940_000], ["2026-07", 7_430_000], ["2026-04", 0]] as const) {
      const model = overviewModel(demo, month, today);
      expect(model.spentMinor, month).toBe(spent);
      expect(model.limitsMinor, month).toBeNull();
      expect(model.categories.every((tile) => tile.status === "none"), month).toBe(true);
    }
    // Месяц плана кончился: «Открыть ноябрь» переносит план, а история его чисел не трогает.
    const budget = activeBudgetOf(demo);
    expect(periodClock(budget, [], today).position).toBe("inside");
    expect(periodClock(budget, [], "2026-11-03").position).toBe("after");
    expect(monthAfterPeriod(budget, "2026-11-03")).toBe("2026-11");
    const opened = carryBudgetForward(demo, "2026-11").state;
    const november = calculateBudget(opened);
    expect(november.expensesMinor).toBe(0);
    expect(activeBudgetOf(opened).startDate).toBe("2026-11-01");
  });
});
