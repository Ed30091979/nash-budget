/// <reference types="node" />
import { readFileSync } from "node:fs";
import { makePlanningSeed } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardScreen } from "./DashboardScreen";

/**
 * Видимый текст разметки. Проверять сумму рядом с её подписью нужно по тому, что читает человек,
 * а не по тегам между ними: знак валюты набран отдельным элементом (§7), и утверждение о
 * «</span><strong>» ломалось бы от любой правки вёрстки, ничего не сказав о смысле.
 */
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/gu, " ").replaceAll("\u00a0", " ").replace(/\s+/gu, " ").trim();
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
    expect(textOf(html)).toContain("Доход, факт 180 000 ₽");
    expect(textOf(html)).toContain("Расходы, факт 71 000 ₽");
    expect(textOf(html)).toContain("Капитал 124 000 ₽");
    expect(textOf(html)).toContain("Повседневные, факт 26 000 ₽");
    expect(textOf(html)).toContain("Остаток повседневного лимита 27 000 ₽");
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

  it("keeps implementation CSP-safe and free of unsafe search/log sinks", () => {
    const source = readFileSync(new URL("./DashboardScreen.tsx", import.meta.url), "utf8")
      + readFileSync(new URL("./model.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|URLSearchParams|location\.|console\./);
    expect(source).not.toMatch(/new RegExp|\.splice\(|\.sort\(\s*state\.transactions/);
    expect(source).not.toMatch(/style=\{|style=\{\{/);
    // Поиск по операциям переехал на экран «Записать» — к списку, который он фильтрует.
    // Здесь остаётся его модель: сравнение подстрокой, без сборки регулярного выражения.
    expect(source).toContain(".includes(query)");
    expect(source).not.toContain("OperationsSearch");
  });
});
