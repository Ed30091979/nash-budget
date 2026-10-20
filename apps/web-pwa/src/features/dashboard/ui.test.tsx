/// <reference types="node" />
import { readFileSync } from "node:fs";
import { makePlanningSeed } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardScreen } from "./DashboardScreen";
import { ladderModel, monthsSpan, createDashboardModel } from "./model";

/**
 * Видимый текст разметки. Проверять сумму рядом с её подписью нужно по тому, что читает человек,
 * а не по тегам между ними: знак валюты набран отдельным элементом (§7), и утверждение о
 * «</span><strong>» ломалось бы от любой правки вёрстки, ничего не сказав о смысле.
 */
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/gu, " ").replaceAll("\u00a0", " ").replace(/\s+/gu, " ").trim();
}

describe("dashboard UI", () => {
  it("ведёт экран выводом-заголовком, строем месяца, лестницей месяцев и свёрнутыми точными значениями", () => {
    const html = renderToStaticMarkup(
      <DashboardScreen budget={makePlanningSeed()} startMonth="2026-07" onPlanning={() => undefined} paydays={[5, 20]} />,
    ).replaceAll("\u00a0", " ");
    const text = textOf(html);

    expect(html).toContain("aria-label=\"Горизонт планирования\"");
    expect(html).toContain("aria-pressed=\"true\">12 месяцев");
    expect(html).toContain("24 месяца");

    // §4 исследования, пункт 23: заголовок экрана — вывод, а не подпись осей. Это жанр.
    expect(html).toMatch(/<h2 id="dashboard-title">Плана хватает во все 12 месяцев<\/h2>/u);
    expect(text).toContain("Свободно от 13 191 ₽ в сентябре 2026 до 48 750 ₽ в июне 2027.");
    expect(html).toContain("Настроить план");

    // Строй месяца стоит верхним блоком: ось чисел с выплатами и платежами на своих числах.
    // Это та ось 5-го/10-го/15-го, по которой семья помнит свои платежи.
    expect(html.indexOf("Строй месяца")).toBeLessThan(html.indexOf("Двенадцать месяцев"));
    expect(html).toMatch(/class="shape-tick pay" data-day="5">5</u);
    expect(html).toMatch(/class="shape-tick pay" data-day="20">20</u);
    expect(html).toMatch(/class="shape-row" data-day="15" data-side="right"/u);
    expect(text).toContain("ЖКХ, интернет и связь 8 000 ₽");
    expect(text).toContain("Обучение детей 25 000 ₽ · сен–май");
    expect(html).toMatch(/role="img" aria-label="Числа месяца: выплаты 5-го и 20-го; платежи: Аренда \/ ипотека 5-го, 45 000 ₽/u);

    // Лестница: магнитуда — длиной, месяц на строку, одна насечка на все строки. Дно горизонта —
    // пять месяцев на одной сумме — выделено весом, а не названо одним месяцем.
    expect(html.match(/class="ladder-row (?:normal|tight|short|out)"/gu)).toHaveLength(12);
    expect(html.match(/class="ladder-row tight"/gu)).toHaveLength(5);
    expect(html).toMatch(/<ul class="ladder" data-mark="\d+"/u);
    expect(text).toContain("сен 13 191 ₽");
    expect(text).toContain("июн 48 750 ₽");
    // Донатов, пирогов и второго графика нет: количество передают длина и положение.
    expect(html).not.toMatch(/horizon-chart|<circle|conic-gradient/u);

    // Точные значения на месте, но уровнем ниже: свёрнутая секция, а не вкладка и не второй экран.
    expect(html).toContain("Месяцы по числам");
    expect(html).toContain("<table>");
    expect(html.match(/<tbody>.*?<\/tbody>/su)?.[0].match(/<tr>/g)).toHaveLength(12);
    expect(text).toContain("июл 2026");
    expect(text).toContain("сен 2026 180 000 ₽ 166 809 ₽ 19 809 ₽ 0 ₽ 13 191 ₽");
    // Столбцы, у которых во всех будущих месяцах ноль, из таблицы убраны.
    expect(text).not.toContain("Повседневные, факт");
  });

  it("не повторяет крупные платежи: строй месяца — про регулярные, крупные живут в списке «Года»", () => {
    const html = renderToStaticMarkup(<DashboardScreen budget={makePlanningSeed()} startMonth="2026-07" />);
    expect(html).not.toContain("Ближайшие активные платежи");
    expect(html).not.toContain("Страхование автомобиля");
    expect(html).not.toContain("Летний лагерь");
    // Без дат выплат ось всё равно есть: платежи стоят на своих числах, выплат на ней нет.
    expect(html).toContain("Аренда / ипотека");
    expect(html).not.toContain("shape-pay");
    // Без обработчика перехода кнопки нет: экран не обещает того, чего не умеет.
    expect(html).not.toContain("Настроить план");
  });

  it("называет месяц нехватки прежде всего остального и ставит его полосу перед насечкой", () => {
    const source = makePlanningSeed();
    const poor = {
      ...source,
      budgets: source.budgets.map((budget) => ({ ...budget, plannedIncomeMinor: 12_000_000 })),
    };
    const html = renderToStaticMarkup(<DashboardScreen budget={poor} startMonth="2026-07" />)
      .replaceAll("\u00a0", " ");

    expect(html).toContain("horizon-card danger");
    expect(textOf(html)).toContain("Плана больше дохода");
    expect(html).toContain('class="ladder-row short"');
    expect(html).toContain('class="limit-bar short"');
  });

  it("прижимает заливку лестницы к нужной стороне насечки после квантования", () => {
    const model = createDashboardModel(makePlanningSeed(), "2026-07", 12);
    const ladder = ladderModel(model.months, model.tightest.freeMinor);
    // Шкала — самый широкий месяц: июнь 2027, 48 750 свободно + 53 000 конвертов = 101 750.
    // Насечка конвертов на ней — 53 000 / 101 750 → 52 %.
    expect(ladder.envelopesMinor).toBe(5_300_000);
    expect(ladder.markPercent).toBe(52);
    for (const row of ladder.rows) {
      if (row.spendableMinor >= 0) expect(row.fill, row.month).toBeGreaterThanOrEqual(ladder.markPercent);
      else expect(row.fill, row.month).toBeLessThan(ladder.markPercent);
    }
    expect(ladder.rows.find((row) => row.month === "2027-01")?.yearBreak).toBe(true);
  });

  it("называет выбранные месяцы расписания фразой, а не перечнем сокращений", () => {
    expect(monthsSpan([1, 2, 3, 4, 5, 9, 10, 11, 12])).toBe("сентябрь — май");
    expect(monthsSpan([1, 2, 3, 4, 5, 9, 10, 11, 12], "short")).toBe("сен–май");
    expect(monthsSpan([6, 7, 8])).toBe("июнь — август");
    expect(monthsSpan([12, 1])).toBe("декабрь — январь");
    expect(monthsSpan([9])).toBe("сентябрь");
    expect(monthsSpan([1, 4, 7, 10])).toBe("янв, апр, июл, окт");
    expect(monthsSpan([1, 3, 5, 7, 9, 11])).toBe("6 месяцев в году");
    expect(monthsSpan([])).toBe("месяцы не выбраны");
    expect(monthsSpan([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe("каждый месяц");
  });

  it("keeps implementation CSP-safe and free of unsafe search/log sinks", () => {
    const source = readFileSync(new URL("./DashboardScreen.tsx", import.meta.url), "utf8")
      + readFileSync(new URL("./model.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|URLSearchParams|location\.|console\./);
    expect(source).not.toMatch(/new RegExp|\.splice\(|\.sort\(\s*state\.transactions/);
    expect(source).not.toMatch(/style=\{|style=\{\{/);
    // Донатов и пирогов на экране нет и быть не может: количество передают длина и положение
    // (§4 исследования, пункт 19). Заодно и любой круговой заливки в разметке.
    expect(source).not.toMatch(/conic-gradient|<circle|stroke-dasharray/);
    // Поиска по операциям здесь нет вовсе: он живёт в «Операциях» (`features/feed/feed-model.ts`),
    // а прежняя модель поиска этого экрана удалена как мёртвая (ревью 2d, LOW-9).
    expect(source).not.toMatch(/searchOperations|buildOperationSearchIndex|OPERATION_PAGE_SIZE|OperationsSearch/u);
  });
});
