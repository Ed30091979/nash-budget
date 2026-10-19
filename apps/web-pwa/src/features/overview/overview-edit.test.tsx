import { calculateAnnualPlan, makePlanningSeed } from "@family-budget/domain";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { periodClock } from "../../reach";
import { OverviewScreen, ROW_EDIT_LABELS } from "./OverviewScreen";

function render(): string {
  const budget = makePlanningSeed();
  return renderToStaticMarkup(
    <OverviewScreen
      budget={budget}
      today="2026-07-13"
      month="2026-07"
      onMonth={vi.fn()}
      clock={periodClock({ startDate: "2026-07-01", endDate: "2026-07-31" }, [], "2026-07-13")}
      flexiblePlanMinor={calculateAnnualPlan(budget, "2026-07", 24).currentMonth.flexiblePlanMinor}
      familyNews={[]}
      monthToOpen={null}
      openingMonth={false}
      onOpenMonth={vi.fn()}
      onOpenSheet={vi.fn()}
      onAddCategory={vi.fn()}
      onPlan={vi.fn()}
      onEdit={vi.fn()}
    />,
  );
}

describe("«Обзор»: «Изменить» у каждого ряда (план волны 2, §5.1)", () => {
  it("у кикеров «Доходы», «Счета», «Расходы» — кнопка «Изменить», и её доступное имя называет ряд", () => {
    const markup = render();
    for (const [title, row] of [["Доходы", "incomes"], ["Счета", "accounts"], ["Расходы", "expenses"]] as const) {
      expect(markup).toMatch(new RegExp(`<div class="row-head"><h2 id="overview-${row === "incomes" ? "incomes" : row === "accounts" ? "accounts" : "expenses"}" class="row-kicker">${title}</h2><button class="quiet-button row-edit" type="button" aria-label="${ROW_EDIT_LABELS[row]}">`, "u"));
    }
    // Видимое слово — часть доступного имени (WCAG 2.5.3).
    for (const label of Object.values(ROW_EDIT_LABELS)) expect(label.startsWith("Изменить")).toBe(true);
    expect(markup.match(/>Изменить<\/span><\/button>/gu)).toHaveLength(3);
  });

  it("итоги — одна колонка: «Всего на счетах», затем блок «Потрачено» с «по лимитам» под ним", () => {
    const markup = render();
    expect(markup).toMatch(/<dl class="overview-totals"><div class="overview-balance"><dt>Всего на счетах<\/dt>[^]*?<\/div><div class="overview-spent"><dt>Потрачено<\/dt><dd>[^]*?<\/dd><dd class="overview-limits">по лимитам /u);
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    // Правой колонки, падавшей строкой по центру, больше нет: блок «Потрачено» — под итогом, по левому краю.
    expect(styles).not.toContain(".overview-totals > div:last-child { text-align: right; }");
    expect(styles).toMatch(/\.overview-totals \{ display: grid;/u);
    expect(styles).toMatch(/\.overview-spent \{[^}]*border-top: 1px solid var\(--border\)/u);
  });
});
