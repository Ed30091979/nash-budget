/// <reference types="node" />
import { readFileSync } from "node:fs";
import { makePlanningSeed, PLANNING_IDS, SEED_IDS, type BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DashboardScreen,
  OperationsSearch,
  reduceOperationSearchView,
} from "./DashboardScreen";

function sixOperations(): BudgetState {
  const source = makePlanningSeed();
  return {
    ...source,
    transactions: [...source.transactions, {
      id: "95555555-5555-4555-8555-555555555551",
      occurredOn: "2026-07-10",
      status: "posted",
      kind: "refund",
      amountMinor: 100_000,
      accountId: SEED_IDS.accounts.main,
      categoryId: PLANNING_IDS.categories.food,
      originalTransactionId: source.transactions[2]!.id,
    }, {
      id: "95555555-5555-4555-8555-555555555552",
      occurredOn: "2026-07-11",
      status: "posted",
      kind: "transfer",
      amountMinor: 500_000,
      fromAccountId: SEED_IDS.accounts.main,
      toAccountId: SEED_IDS.accounts.savings,
    }],
  };
}

describe("dashboard UI", () => {
  it("renders an accessible chart, exact numeric table, text summary and non-color values", () => {
    const html = renderToStaticMarkup(<DashboardScreen budget={makePlanningSeed()} startMonth="2026-07" />)
      .replaceAll("\u00a0", " ");
    expect(html).toContain("Финансовый горизонт семьи");
    expect(html).toContain("aria-label=\"Горизонт планирования\"");
    expect(html).toContain("aria-pressed=\"true\">12 месяцев");
    expect(html).toContain("24 месяца");
    expect(html).toContain("role=\"img\"");
    expect(html).toContain("План дохода и расходов по месяцам");
    expect(html).toContain("<table>");
    expect(html).toContain("Точные значения графика по месяцам");
    expect(html).toContain("Горизонт: 12 месяцев.");
    expect(html).toContain("aria-label=\"12 карточек месяцев\"");
    expect(html.match(/class="dashboard-month-card"/g)).toHaveLength(12);
    expect(html).toContain("Доход, факт</span><strong>180 000");
    expect(html).toContain("Расходы, факт</span><strong>71 000");
    expect(html).toContain("Капитал</span><strong>124 000");
    expect(html).toContain("Повседневные, факт</span><strong>26 000");
    expect(html).toContain("Остаток повседневного лимита</span><strong>27 000");
    expect(html).toContain("Страхование автомобиля");
    expect(html).toContain("2027-01-15");
    expect(html).toContain("Обучение детей");
    expect(html).toContain("2026-09-10");
    expect(html).toContain("Секции");
    expect(html).toContain("2026-09-12");
    expect(html).toContain("Летний лагерь");
    expect(html).not.toContain("2028-06-15");
    expect(html).toContain("Для каждого расписания показан один ближайший платёж");
    expect(html).not.toContain("Поиск операций");
  });

  it("renders all six operations and explains totals are independent of filtering", () => {
    const html = renderToStaticMarkup(<OperationsSearch budget={sixOperations()} />);
    expect(html).toContain("Найдено операций: <strong>6</strong> из 6");
    expect(html).toContain("Показано 1–6 из 6");
    expect(html).toContain("Общие итоги дашборда не меняются");
    expect(html).toContain("Продукты возврат расхода Продукты");
    expect(html).toContain("maxLength=\"80\"");
  });

  it("resets pagination when query or kind changes and reset restores the unfiltered state", () => {
    const paged = { query: "", kind: "all" as const, page: 4 };
    expect(reduceOperationSearchView(paged, { type: "query", value: "Продукты" }))
      .toEqual({ query: "Продукты", kind: "all", page: 0 });
    expect(reduceOperationSearchView(paged, { type: "kind", value: "expense" }))
      .toEqual({ query: "", kind: "expense", page: 0 });
    expect(reduceOperationSearchView(
      { query: "Продукты", kind: "expense", page: 2 },
      { type: "reset" },
    )).toEqual({ query: "", kind: "all", page: 0 });
  });

  it("renders only one bounded page for a 50k-operation budget and exposes exact paging totals", () => {
    const source = makePlanningSeed();
    const state: BudgetState = {
      ...source,
      transactions: Array.from({ length: 50_000 }, (_, index) => ({
        id: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        occurredOn: `2026-07-${String(index % 28 + 1).padStart(2, "0")}`,
        status: "posted" as const,
        kind: "income" as const,
        amountMinor: index + 1,
        accountId: SEED_IDS.accounts.main,
      })),
    };
    const html = renderToStaticMarkup(<OperationsSearch budget={state} />);
    expect(html).toContain("Найдено операций: <strong>50000</strong> из 50000");
    expect(html).toContain("Показано 1–50 из 50000");
    expect(html).toContain("Страница 1 из 1000");
    expect(html.match(/<li>/g)).toHaveLength(50);
  });

  it("keeps implementation CSP-safe and free of unsafe search/log sinks", () => {
    const source = readFileSync(new URL("./DashboardScreen.tsx", import.meta.url), "utf8")
      + readFileSync(new URL("./model.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|URLSearchParams|location\.|console\./);
    expect(source).not.toMatch(/new RegExp|\.splice\(|\.sort\(\s*state\.transactions/);
    expect(source).not.toMatch(/style=\{|style=\{\{/);
    expect(source).toContain(".includes(query)");
    expect(source).toContain("maxLength={80}");
    expect(source).toContain("buildOperationSearchIndex(budget)");
  });
});
