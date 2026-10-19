/// <reference types="node" />
import { readFileSync } from "node:fs";
import {
  calculateAnnualPlan,
  calculateBudget,
  makeSeedBudget,
  type BudgetState,
} from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TodayScreen } from "./features/today/TodayScreen";
import { MEMBER_FILTER_ALL } from "./features/family";
import { OperationsScreen } from "./features/operations";
import { periodClock, reach } from "./reach";
import { readAppSource } from "./app/shell-source";

const design = readFileSync(new URL("../../../DESIGN.md", import.meta.url), "utf8");

/**
 * Голос о нехватке — факт и путь (§6 `DESIGN.md`).
 *
 * Нехватка никогда не называется без числа, которым её закрывают: «до 20-го не дотягивает» и
 * сразу «чтобы дотянуть — 2 077 ₽ в день». Код это соблюдал на герое и молчал на строке лимита и
 * на конверте; правило теперь записано, и эта проверка держит его на всех трёх местах.
 */
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/gu, " ").replaceAll(" ", " ").replace(/\s+/gu, " ").trim();
}

/** 13 июля внутри июльского плана: «Транспорт» из образца — 10 000 плана, 5 000 факта — не дотягивает. */
const TODAY = "2026-07-13";

function renderToday(state: BudgetState): string {
  const active = state.budgets.find((budget) => budget.id === state.activeBudgetId)!;
  const metrics = calculateBudget(state);
  const plan = calculateAnnualPlan(state, active.startDate.slice(0, 7), 24);
  const planned = new Set(active.lines.filter((line) => line.active !== false).map((line) => line.categoryId));
  const flexibleRows = state.categories
    .filter((category) => category.active && category.type === "expense" && planned.has(category.id))
    .map((category) => ({ category, metric: metrics.categoryMetrics[category.id] }));
  const flexibleSpentMinor = flexibleRows.reduce((total, row) => total + (row.metric?.actualMinor ?? 0), 0);
  return renderToStaticMarkup(
    <TodayScreen
      budget={state}
      plan={plan}
      flexibleRows={flexibleRows}
      safeToSpendMinor={plan.currentMonth.flexiblePlanMinor - flexibleSpentMinor}
      flexibleSpentMinor={flexibleSpentMinor}
      clock={periodClock(active, [], TODAY)}
      recentTransactions={[]}
      categoryById={new Map(state.categories.map((category) => [category.id, category]))}
      memberById={new Map()}
      memberOptions={[]}
      memberFilter={MEMBER_FILTER_ALL}
      onMemberFilterChange={() => undefined}
      hasRecords
      monthToOpen={null}
      onAdd={() => undefined}
      onYear={() => undefined}
      onPlanning={() => undefined}
      familyNews={[]}
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

  it("строка лимита: за «до …» сразу идёт «чтобы дотянуть — N ₽ в день»", () => {
    const markup = renderToday(seed);
    // Сумма внутри строки — собственный `<span>`, поэтому строка берётся до конца своего блока.
    const shortRows = [...markup.matchAll(/<span class="short">(.*?)<\/div>/gu)].map((match) => textOf(match[1] ?? ""));
    expect(shortRows.length).toBeGreaterThan(0);
    for (const row of shortRows) {
      expect(row).toMatch(/^до \S+ \S+ · чтобы дотянуть — \d[\d ]* ₽ в день$/u);
    }
  });

  it("герой: «не дотягивает» никогда не стоит без «чтобы дотянуть»", () => {
    const text = textOf(renderToday(seed));
    if (text.includes("не дотягивает")) {
      expect(text).toMatch(/не дотягивает\.\s*Тратим \d[\d ]* ₽ в день; чтобы дотянуть — \d[\d ]* ₽ в день\./u);
    }
    // Правило держится на самой строке героя, а не на удаче образца.
    const source = readAppSource();
    expect(source).toMatch(/не дотягивает\.<\/b> Тратим <Money value=\{rate\} \/> в день; чтобы дотянуть — <Money value=\{needPerDay\} \/> в день\./u);
  });

  it("конверт на табло: «не дотянет» сразу с «чтобы дотянуть — N ₽ в день»", () => {
    const clock = periodClock(seed.budgets[0]!, [], TODAY);
    const markup = renderToStaticMarkup(<OperationsScreen budget={seed} clock={clock} onChange={vi.fn(async () => undefined)} />);
    const feet = [...markup.matchAll(/<span class="envelope-foot">(.*?)<\/span><\/button>/gu)].map((match) => textOf(match[1] ?? ""));
    const short = feet.filter((foot) => foot.includes("не дотянет"));
    expect(short.length).toBeGreaterThan(0);
    for (const foot of short) {
      expect(foot).toMatch(/не дотянет · чтобы дотянуть — \d[\d ]* ₽ в день/u);
    }
    // Тот же путь — и в произносимом имени конверта.
    expect(markup).toMatch(/aria-label="[^"]*не дотянет · чтобы дотянуть — [^"]* в день/u);
  });

  it("правило записано в документе дизайна", () => {
    expect(design).toMatch(/факт и путь/iu);
    expect(design).toMatch(/чтобы дотянуть/u);
  });
});
