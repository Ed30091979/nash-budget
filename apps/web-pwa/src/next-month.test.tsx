/// <reference types="node" />
import { readFileSync } from "node:fs";
import {
  calculateAnnualPlan,
  carryBudgetForward,
  makePlanningSeed,
  monthAfterPeriod,
  type BudgetState,
} from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OverviewScreen } from "./features/overview/OverviewScreen";
import { periodClock } from "./reach";
import { readAppSource } from "./app/shell-source";

const appSource = readAppSource();

/**
 * Выход из закрытого месяца — приёмка того самого дефекта, из-за которого приложение жило один
 * месяц: бюджет месяца заводился только в онбординге, и семья, прошедшая его в июле, в августе
 * упиралась в тупик — закрытый июль, покупки мимо лимитов, лимиты ни о чём.
 *
 * Проверяется то, что читает человек на «Обзоре»: строка повседневных лимитов называет месяц,
 * который предлагает открыть, говорит, что при этом произойдёт, и даёт кнопку. И не даёт её, пока
 * месяц плана идёт: открывать нечего.
 */
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/gu, " ").replace(/[\u00a0\u202f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function renderOverview(state: BudgetState, today: string) {
  const active = state.budgets.find((budget) => budget.id === state.activeBudgetId)!;
  const plan = calculateAnnualPlan(state, active.startDate.slice(0, 7), 24);
  const clock = periodClock(
    active,
    state.transactions.filter((item) => item.kind === "income").map((item) => item.occurredOn),
    today,
  );
  const opened: string[] = [];
  const markup = renderToStaticMarkup(
    <OverviewScreen
      budget={state}
      today={today}
      month={today.slice(0, 7)}
      onMonth={() => undefined}
      clock={clock}
      flexiblePlanMinor={plan.currentMonth.flexiblePlanMinor}
      familyNews={[]}
      monthToOpen={clock.position === "after" ? monthAfterPeriod(active, today) : null}
      openingMonth={false}
      onOpenMonth={(month) => opened.push(month)}
      onOpenSheet={() => undefined}
      onAddCategory={() => undefined}
      onPlan={() => undefined}
      onReports={() => undefined}
      onEdit={() => undefined}
    />,
  );
  const hero = heroOf(markup);
  return { markup, text: textOf(markup), heroText: textOf(hero), heroActions: heroActions(hero), opened };
}

/** Карточка «Хватает до …» под итогами — то, что на «Обзоре» стоит на месте прежнего героя. */
function heroOf(markup: string): string {
  const start = markup.indexOf('<section class="card reach-card');
  return markup.slice(start, markup.indexOf("</section>", start));
}

/** Кнопки строки по порядку: чем они названы и какого веса. */
function heroActions(hero: string): readonly { readonly weight: string; readonly label: string }[] {
  return [...hero.matchAll(/<button class="(primary|secondary)-button[^"]*"[^>]*>(.*?)<\/button>/gu)]
    .map(([, weight, body]) => ({ weight: weight!, label: textOf(body!) }));
}

describe("выход из закрытого месяца", () => {
  it("называет месяц, который предлагает открыть, и что при этом перенесётся", () => {
    const { heroText, heroActions: actions } = renderOverview(makePlanningSeed(), "2026-09-04");

    expect(heroText).toContain("Июль закрыт: осталось от повседневных лимитов июля");
    expect(heroText).toContain("Открыть сентябрь — значит перенести в него те же лимиты и положить сверху остатки июля.");
    expect(heroText).toContain("Июль останется в истории со своими числами");
    // Тупик назван — и тут же назван выход из него, с именем месяца в самой кнопке. Главное
    // действие одно: записывают плитками и «+», а здесь — открывают месяц.
    expect(actions).toEqual([{ weight: "primary", label: "Открыть сентябрь" }]);
  });

  it("молчит про открытие месяца, пока месяц плана идёт", () => {
    const { text, heroText, heroActions: actions } = renderOverview(makePlanningSeed(), "2026-07-09");

    expect(text).not.toContain("Открыть");
    expect(heroText).toMatch(/^(?:Хватает до |Повседневные лимиты исчерпаны)/u);
    expect(actions).toEqual([]);
  });

  it("после открытия месяца строка говорит уже про него, а не про закрытый", () => {
    const july = makePlanningSeed();
    const september = carryBudgetForward(july, "2026-09").state;
    const { markup, text, heroText } = renderOverview(september, "2026-09-04");

    // Заголовок называет месяц плиток и молчит про день: месяц идёт, сообщать нечего.
    expect(text).toContain("Сентябрь 2026");
    expect(text).not.toMatch(/сентябрь\s*·/iu);
    expect(heroText).toMatch(/^(?:Хватает до |Повседневные лимиты исчерпаны)/u);
    expect(text).not.toContain("закрыт");
    expect(markup).toMatch(/class="card reach-card (?:reaches|short|out)"/u);
  });

  it("ведёт себя одинаково при отсутствии в два дня и в девять месяцев", () => {
    // Внимание к деньгам падает, когда дела плохи: тот, кто открыл приложение после долгого
    // перерыва, уже преодолел избегание, и экран не вправе взять с него за это плату — ни
    // словом о перерыве, ни другим устройством экрана. Разница между двумя открытиями — только
    // имя месяца, который предлагается открыть: тот, в котором семья живёт сейчас.
    const twoDays = renderOverview(makePlanningSeed(), "2026-08-02");
    const nineMonths = renderOverview(makePlanningSeed(), "2027-04-15");
    const normalize = (text: string) => text.replace(/Открыть (?:август|апрель)/gu, "Открыть месяц");

    expect(normalize(twoDays.heroText)).toBe(normalize(nineMonths.heroText));
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
    expect(appSource).toContain("await write.run((state) => carryBudgetForward(state, month).state);");
    expect(appSource).toContain("const monthToOpen = clock.position === \"after\" ? monthAfterPeriod(activeBudget, today) : null;");
    expect(appSource).toContain("onOpenMonth={(month) => void openMonth(month)}");
    // И никакого автоматического открытия: месяц открывается нажатием, а не приходом даты.
    expect(appSource).not.toMatch(/useEffect\([^)]*carryBudgetForward/u);
  });
});
