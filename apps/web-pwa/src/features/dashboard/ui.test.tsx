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
  it("ведёт экран одним крупным числом, одним графиком с выводом и свёрнутыми точными значениями", () => {
    const html = renderToStaticMarkup(
      <DashboardScreen budget={makePlanningSeed()} startMonth="2026-07" onPlanning={() => undefined} />,
    ).replaceAll("\u00a0", " ");
    const text = textOf(html);

    expect(html).toContain("Финансовый горизонт семьи");
    expect(html).toContain("aria-label=\"Горизонт планирования\"");
    expect(html).toContain("aria-pressed=\"true\">12 месяцев");
    expect(html).toContain("24 месяца");

    // Одно крупное число на экране — самый тесный месяц горизонта, и оно же ведёт к плану.
    expect(text).toContain("Меньше всего свободно");
    // Дно горизонта редко бывает одним месяцем: подпись считает их вслух, а не называет один.
    expect(text).toContain("Столько остаётся после всех планов в сентябре 2026 и ещё в 4 месяцах горизонта.");
    expect(text).toContain("13 191 ₽");
    expect(html.match(/class="hero-card/g)).toHaveLength(1);
    expect(html).toContain("Настроить план");

    // §4 исследования, пункт 23: заголовок графика сообщает вывод, а не подписывает оси.
    expect(text).toContain("Плана хватает во все 12 месяцев");
    expect(html).toContain("role=\"img\"");
    expect(html).toContain('aria-labelledby="horizon-chart-title"');
    // Один график на экран (пункт 22): второго ряда колонок и ленты карточек месяцев больше нет.
    expect(html.match(/<figure/g)).toHaveLength(1);
    expect(html).not.toContain("dashboard-month-card");
    expect(html).not.toContain("dashboard-totals");

    // Точные значения на месте, но уровнем ниже: свёрнутая секция, а не вкладка и не второй экран.
    expect(html).toContain("Месяцы по числам");
    expect(html).toContain("<table>");
    expect(html.match(/<tbody>.*?<\/tbody>/su)?.[0].match(/<tr>/g)).toHaveLength(12);
    expect(text).toContain("июл 2026");
    expect(text).toContain("сен 2026 180 000 ₽ 166 809 ₽ 19 809 ₽ 0 ₽ 13 191 ₽");
    // Столбцы, у которых во всех будущих месяцах ноль, из таблицы убраны.
    expect(text).not.toContain("Повседневные, факт");
  });

  it("не повторяет крупные и регулярные платежи третьим списком", () => {
    const html = renderToStaticMarkup(<DashboardScreen budget={makePlanningSeed()} startMonth="2026-07" />);
    expect(html).not.toContain("Ближайшие активные платежи");
    expect(html).not.toContain("Страхование автомобиля");
    expect(html).not.toContain("Обучение детей");
    // Без обработчика перехода кнопки в герое нет: экран не обещает того, чего не умеет.
    expect(html).not.toContain("Настроить план");
  });

  it("называет месяц нехватки прежде всего остального", () => {
    const source = makePlanningSeed();
    const poor = {
      ...source,
      budgets: source.budgets.map((budget) => ({ ...budget, plannedIncomeMinor: 12_000_000 })),
    };
    const html = renderToStaticMarkup(<DashboardScreen budget={poor} startMonth="2026-07" />)
      .replaceAll("\u00a0", " ");

    expect(html).toContain("hero-card danger");
    expect(textOf(html)).toContain("Плана больше, чем дохода, в сентябре 2026");
    expect(textOf(html)).toContain("Плана больше дохода");
    expect(html).toContain("horizon-chart__bar short");
  });

  it("keeps implementation CSP-safe and free of unsafe search/log sinks", () => {
    const source = readFileSync(new URL("./DashboardScreen.tsx", import.meta.url), "utf8")
      + readFileSync(new URL("./model.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|URLSearchParams|location\.|console\./);
    expect(source).not.toMatch(/new RegExp|\.splice\(|\.sort\(\s*state\.transactions/);
    expect(source).not.toMatch(/style=\{|style=\{\{/);
    // Донатов и пирогов на экране нет и быть не может: количество передают длина и положение
    // (§4 исследования, пункт 19). Заодно и любой круговой заливки в разметке графика.
    expect(source).not.toMatch(/conic-gradient|<circle|stroke-dasharray/);
    // Поиск по операциям переехал на экран «Записать» — к списку, который он фильтрует.
    // Здесь остаётся его модель: сравнение подстрокой, без сборки регулярного выражения.
    expect(source).toContain(".includes(query)");
    expect(source).not.toContain("OperationsSearch");
  });
});
