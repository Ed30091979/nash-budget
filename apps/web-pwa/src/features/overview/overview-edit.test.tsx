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
      onReports={vi.fn()}
      onEdit={vi.fn()}
    />,
  );
}

describe("«Обзор»: «Изменить» у каждого ряда (план волны 2, §5.1; дизайн 5.0)", () => {
  it("у кикеров «Доходы и счета» и «Расходы» — карандаш, и его доступное имя называет ряд", () => {
    const markup = render();
    for (const [title, row] of [["Доходы и счета", "accounts"], ["Расходы", "expenses"]] as const) {
      expect(markup).toMatch(new RegExp(`<div class="row-head"><h2 id="overview-${row}" class="row-kicker">${title}</h2><button class="icon-button row-edit" type="button" aria-label="${ROW_EDIT_LABELS[row]}"><svg[^>]*aria-hidden="true"`, "u"));
    }
    // Глиф — не единственный носитель смысла: имя словами начинается с «Изменить» и называет ряд.
    for (const label of Object.values(ROW_EDIT_LABELS)) expect(label).toMatch(/^Изменить \S/u);
    expect(markup.match(/class="icon-button row-edit"/gu)).toHaveLength(2);
    expect(markup).toContain('href="#glyph-pencil"');
  });

  it("итоги — три кнопки «На счетах · Расходы · Можно тратить» в ряд и закреплены вместе с месяцем", () => {
    const markup = render();
    const strip = /<div class="totals-strip" role="group" aria-label="Итоги">([\s\S]*?)<\/div>/u.exec(markup)?.[1] ?? "";
    const labels = [...strip.matchAll(/<button class="total[^"]*" type="button"><span class="total-label">([^<]+)<\/span>/gu)].map((match) => match[1]);
    expect(labels).toEqual(["На счетах", "Расходы", "Можно тратить"]);
    expect(markup).toMatch(/<header class="overview-head"><div class="month-switch">[\s\S]*?<\/div><div class="totals-strip"/u);
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    expect(styles).toMatch(/\.totals-strip \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/u);
    expect(styles).toMatch(/\.overview-head \{ position: sticky; top: var\(--header-space\);/u);
  });
});
