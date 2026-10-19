/// <reference types="node" />
import { readFileSync } from "node:fs";
import {
  calculateAnnualPlan,
  calculateBudget,
  makeSeedBudget,
  type BudgetState,
} from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OverviewScreen } from "./features/overview/OverviewScreen";
import { periodClock, reach } from "./reach";

const design = readFileSync(new URL("../../../DESIGN.md", import.meta.url), "utf8");
const reachLineSource = readFileSync(new URL("./features/overview/ReachLine.tsx", import.meta.url), "utf8");

/**
 * Голос о нехватке — факт и путь (§6 `DESIGN.md`).
 *
 * Нехватка никогда не называется без числа, которым её закрывают: «до 20-го не дотягивает» и
 * сразу «чтобы дотянуть — 2 077 ₽ в день». Прежде это держали герой «Сегодня», строка лимита и
 * конверт табло; с 2b нехватку называет одна строка «Можно на повседневные» на «Обзоре», а плитки
 * говорят состояние лимита словом и числами — и проверка держит правило на всём экране.
 */
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/gu, " ").replace(/[\u00a0\u202f]/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * 13 июля внутри июльского плана: «Транспорт» из образца — 10 000 плана, 5 000 факта — не
 * дотягивает, и повседневные лимиты в целом — тоже (3 500 ₽ на 18 дней при нынешнем темпе).
 */
const TODAY = "2026-07-13";

function renderOverview(state: BudgetState): string {
  const active = state.budgets.find((budget) => budget.id === state.activeBudgetId)!;
  const plan = calculateAnnualPlan(state, active.startDate.slice(0, 7), 24);
  return renderToStaticMarkup(
    <OverviewScreen
      budget={state}
      today={TODAY}
      month={TODAY.slice(0, 7)}
      onMonth={() => undefined}
      clock={periodClock(active, [], TODAY)}
      flexiblePlanMinor={plan.currentMonth.flexiblePlanMinor}
      familyNews={[]}
      monthToOpen={null}
      openingMonth={false}
      onOpenMonth={() => undefined}
      onOpenSheet={() => undefined}
      onAddCategory={() => undefined}
      onPlan={() => undefined}
      onEdit={() => undefined}
    />,
  );
}

describe("голос о нехватке: факт и путь", () => {
  const seed = makeSeedBudget();

  it("образец действительно не дотягивает — иначе проверять нечего", () => {
    const metrics = calculateBudget(seed);
    const transport = seed.categories.find((category) => category.name === "Транспорт")!;
    const metric = metrics.categoryMetrics[transport.id]!;
    const clock = periodClock(seed.budgets[0]!, [], TODAY);
    const line = reach({ remainingMinor: metric.remainingMinor, spentMinor: metric.actualMinor, elapsedDays: clock.elapsedDays, daysAhead: clock.payday.daysAhead });
    expect(line.state).toBe("short");
  });

  it("строка «Можно на повседневные»: за «не дотягивает» сразу идёт «чтобы дотянуть — N ₽ в день»", () => {
    const markup = renderOverview(makeSeedBudget());
    const line = markup.slice(markup.indexOf('<section class="card reach-line'), markup.indexOf("</section>", markup.indexOf('<section class="card reach-line')));
    expect(line).toContain('class="card reach-line short"');
    expect(textOf(line)).toMatch(/хватает до \S+ \S+, а до \S+ \S+ не дотягивает · чтобы дотянуть — \d[\d ]* ₽ в день/u);
    // Правило держится на самой строке, а не на удаче образца.
    expect(reachLineSource).toContain("а до {until} не дотягивает · чтобы дотянуть — <Money value={needPerDay} /> в день");
  });

  it("на всём «Обзоре» — тексте и доступных именах — нехватка не стоит без пути", () => {
    for (const state of [makeSeedBudget(), { ...makeSeedBudget(), transactions: [] }]) {
      const markup = renderOverview(state);
      const spoken = [textOf(markup), ...[...markup.matchAll(/aria-label="([^"]*)"/gu)].map((match) => match[1] ?? "")];
      for (const phrase of spoken) {
        for (const shortfall of phrase.matchAll(/не дотян[а-я]*/gu)) {
          expect(phrase.slice(shortfall.index ?? 0), phrase).toMatch(/^не дотян[а-я]* · чтобы дотянуть — \d[\d\u00a0 ]* ₽ в день/u);
        }
      }
    }
  });

  it("плитка категории называет состояние лимита словом и числами, а не одним цветом", () => {
    const markup = renderOverview(makeSeedBudget());
    const labels = [...markup.matchAll(/<button class="tile tile-expense[^"]*"[^>]*aria-label="([^"]*)"/gu)].map((match) => match[1] ?? "");
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).toMatch(/: потрачено \d/u);
  });

  it("правило записано в документе дизайна", () => {
    expect(design).toMatch(/факт и путь/iu);
    expect(design).toMatch(/чтобы дотянуть/u);
  });
});
