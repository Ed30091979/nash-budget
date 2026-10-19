import { renderToStaticMarkup } from "react-dom/server";
import { calculateBudget, makeSeedBudget, type BudgetState } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import { categorySpend, ReportsScreen } from "./ReportsScreen";

function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/gu, " ").replaceAll(" ", " ").replaceAll("&nbsp;", " ").replace(/\s+/gu, " ").trim();
}

describe("«Отчёты» подволны 2a — только посчитанное", () => {
  it("расходы месяца по категориям: по убыванию, без пустых, доли складываются в целое", () => {
    const budget = makeSeedBudget();
    const metrics = calculateBudget(budget);
    const rows = categorySpend(budget, metrics);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.spentMinor).toBe(metrics.categoryMetrics[row.category.id]?.actualMinor);
      expect(row.spentMinor).toBeGreaterThan(0);
      expect(row.category.type).toBe("expense");
    }
    expect([...rows].sort((left, right) => right.spentMinor - left.spentMinor)).toEqual(rows);
    expect(rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 10);
  });

  it("рисует ту же сумму и долю, что посчитал бюджет, и итоги со счетами", () => {
    const budget = makeSeedBudget();
    const metrics = calculateBudget(budget);
    const [top] = categorySpend(budget, metrics);
    const text = textOf(renderToStaticMarkup(<ReportsScreen budget={budget} metrics={metrics} />));
    expect(text).toContain("Отчёты");
    expect(text).toContain("Расходы по категориям");
    expect(text).toContain(top?.category.name ?? "?");
    expect(text).toMatch(/\d+ % расходов месяца/u);
    expect(text).toContain("Итоги и остатки");
  });

  it("без расходов честно говорит, что их нет, и не рисует нулей", () => {
    const seed = makeSeedBudget();
    const empty: BudgetState = { ...seed, transactions: seed.transactions.filter((item) => item.kind !== "expense" && item.kind !== "refund") };
    const metrics = calculateBudget(empty);
    expect(categorySpend(empty, metrics)).toEqual([]);
    const markup = renderToStaticMarkup(<ReportsScreen budget={empty} metrics={metrics} />);
    expect(markup).toContain("Расходов в этом месяце ещё нет");
    expect(markup).not.toContain("0 % расходов");
  });
});
