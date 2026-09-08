/// <reference types="node" />
import { readFileSync } from "node:fs";
import {
  calculateAnnualPlan,
  calculateBudget,
  carryBudgetForward,
  makePlanningSeed,
  monthAfterPeriod,
  type BudgetState,
} from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TodayScreen } from "./App";
import { MEMBER_FILTER_ALL } from "./features/family";
import { periodClock } from "./reach";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

/**
 * Выход из закрытого месяца — приёмка того самого дефекта, из-за которого приложение жило один
 * месяц: бюджет месяца заводился только в онбординге, и семья, прошедшая его в июле, в августе
 * упиралась в тупик — закрытый июль, покупки мимо конвертов, лимиты ни о чём.
 *
 * Проверяется то, что читает человек: экран называет месяц, который предлагает открыть, говорит,
 * что при этом произойдёт, и даёт кнопку. И не даёт её, пока месяц плана идёт: открывать нечего.
 */
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/gu, " ").replaceAll(" ", " ").replace(/\s+/gu, " ").trim();
}

function renderToday(state: BudgetState, today: string) {
  const active = state.budgets.find((budget) => budget.id === state.activeBudgetId)!;
  const metrics = calculateBudget(state);
  const plan = calculateAnnualPlan(state, active.startDate.slice(0, 7), 24);
  const planned = new Set(active.lines.filter((line) => line.active !== false).map((line) => line.categoryId));
  const flexibleRows = state.categories
    .filter((category) => category.active && category.type === "expense" && planned.has(category.id))
    .map((category) => ({ category, metric: metrics.categoryMetrics[category.id] }));
  const flexibleSpentMinor = flexibleRows.reduce((total, row) => total + (row.metric?.actualMinor ?? 0), 0);
  const clock = periodClock(
    active,
    state.transactions.filter((item) => item.kind === "income").map((item) => item.occurredOn),
    today,
  );
  const opened: string[] = [];
  const markup = renderToStaticMarkup(
    <TodayScreen
      budget={state}
      plan={plan}
      flexibleRows={flexibleRows}
      safeToSpendMinor={plan.currentMonth.flexiblePlanMinor - flexibleSpentMinor}
      flexibleSpentMinor={flexibleSpentMinor}
      clock={clock}
      recentTransactions={[]}
      categoryById={new Map(state.categories.map((category) => [category.id, category]))}
      memberById={new Map()}
      memberOptions={[]}
      memberFilter={MEMBER_FILTER_ALL}
      onMemberFilterChange={() => undefined}
      hasRecords
      monthToOpen={clock.position === "after" ? monthAfterPeriod(active, today) : null}
      onOpenMonth={(month) => opened.push(month)}
      onAdd={() => undefined}
      onYear={() => undefined}
      onPlanning={() => undefined}
      familyNews={[]}
    />,
  );
  return { markup, text: textOf(markup), heroActions: heroActions(markup), opened };
}

/** Кнопки карточки героя по порядку: чем они названы и какого веса. */
function heroActions(markup: string): readonly { readonly weight: string; readonly label: string }[] {
  const hero = markup.slice(0, markup.indexOf("</section>"));
  return [...hero.matchAll(/<button class="(primary|secondary)-button"[^>]*>(.*?)<\/button>/gu)]
    .map(([, weight, body]) => ({ weight: weight!, label: textOf(body!) }));
}

describe("выход из закрытого месяца", () => {
  it("называет месяц, который предлагает открыть, и что при этом перенесётся", () => {
    const { text, heroActions: actions } = renderToday(makePlanningSeed(), "2026-09-04");

    expect(text).toContain("Июль закончился.");
    expect(text).toContain("Открыть сентябрь — значит перенести в него те же лимиты и положить сверху остатки конвертов июля.");
    expect(text).toContain("Июль останется в истории со своими числами.");
    // Тупик назван — и тут же назван выход из него, с именем месяца в самой кнопке. Действий на
    // карточке два, и главное из них одно: запись покупки уступает открытию месяца.
    expect(actions).toEqual([
      { weight: "primary", label: "Открыть сентябрь" },
      { weight: "secondary", label: "Записать покупку" },
    ]);
  });

  it("молчит про открытие месяца, пока месяц плана идёт", () => {
    const { text, heroActions: actions } = renderToday(makePlanningSeed(), "2026-07-09");

    expect(text).not.toContain("Открыть");
    expect(text).toContain("Можно на повседневные расходы");
    expect(actions).toEqual([{ weight: "primary", label: "Записать покупку" }]);
  });

  it("после открытия месяца герой говорит уже про него, а не про закрытый", () => {
    const july = makePlanningSeed();
    const september = carryBudgetForward(july, "2026-09").state;
    const { markup, text } = renderToday(september, "2026-09-04");

    // Эйбрау называет месяц чисел и молчит про день: месяц идёт, сообщать нечего.
    expect(text).toContain("сентябрь");
    expect(text).not.toMatch(/сентябрь\s*·/u);
    expect(text).toContain("Можно на повседневные расходы");
    expect(text).not.toContain("закончился");
    expect(markup).toContain("hero-reach");
  });

  it("ведёт себя одинаково при отсутствии в два дня и в девять месяцев", () => {
    // Внимание к деньгам падает, когда дела плохи: тот, кто открыл приложение после долгого
    // перерыва, уже преодолел избегание, и экран не вправе взять с него за это плату — ни
    // словом о перерыве, ни другим устройством экрана. Разница между двумя открытиями — только
    // имя месяца, который предлагается открыть: тот, в котором семья живёт сейчас.
    const twoDays = renderToday(makePlanningSeed(), "2026-08-02");
    const nineMonths = renderToday(makePlanningSeed(), "2027-04-15");
    const normalize = (text: string) => text.replace(/Открыть (?:август|апрель)/gu, "Открыть месяц").replace(/(?:2 августа|15 апреля)/gu, "сегодня");

    expect(normalize(twoDays.text)).toBe(normalize(nineMonths.text));
    expect(twoDays.heroActions.map((action) => action.weight)).toEqual(nineMonths.heroActions.map((action) => action.weight));
    expect(twoDays.heroActions[0]?.label).toBe("Открыть август");
    expect(nineMonths.heroActions[0]?.label).toBe("Открыть апрель");
    for (const text of [twoDays.text, nineMonths.text]) {
      expect(text).not.toMatch(/давно|долго|перерыв|отсутств|не были|вернулись|пропустили|соскучил/iu);
    }
  });

  it("ведёт открытие месяца тем же путём записи, что и всякое другое изменение", () => {
    // Не своим путём в хранилище, а через координатор: значит — через журнал семьи, когда она
    // есть. Второе устройство узнаёт про новый месяц оттуда же, откуда узнаёт про покупку.
    expect(appSource).toContain("await budgetSave.apply((state) => carryBudgetForward(state, month).state);");
    expect(appSource).toContain("const monthToOpen = clock.position === \"after\" ? monthAfterPeriod(activeBudget, today) : null;");
    expect(appSource).toContain("onOpenMonth={(month) => void openMonth(month)}");
    // И никакого автоматического открытия: месяц открывается нажатием, а не приходом даты.
    expect(appSource).not.toMatch(/useEffect\([^)]*carryBudgetForward/u);
  });
});
