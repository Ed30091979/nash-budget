/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  hasChangedRestoreDrafts,
  hasUnsavedPlanningDrafts,
  isPlanningEditorDirty,
  PlanningScreen,
} from "./PlanningScreen";
import { archiveFlexibleLine } from "./model";
import { makePlanningTestState, TEST_IDS } from "./test-fixture";

describe("planning UI", () => {
  it("renders four friendly layers with accessible labels and reversible archive actions", () => {
    const html = renderToStaticMarkup(<PlanningScreen budget={makePlanningTestState()} onChange={vi.fn(async () => undefined)} />);
    expect(html).toContain("Плановые расходы");
    expect(html).toContain("Ежегодные и разовые платежи");
    expect(html).toContain("Ежемесячные и сезонные платежи");
    expect(html).toContain("Повседневные лимиты");
    expect(html).toContain("29, 30 или 31 в коротком месяце становятся последним днём месяца");
    expect(html).toContain("Обучение может идти с сентября по май");
    expect(html).toContain("Сейчас отложено и не потрачено, ₽");
    expect(html).toContain("сохраняется между годовщинами, пока вы не измените её вручную");
    expect(html).toContain("В архив");
    expect(html).toContain("aria-label=\"Изменить повседневный лимит «Дети»\"");
    expect(html).toContain("aria-label=\"Архивировать повседневный лимит «Дети»\"");
    expect(html).toContain("<label for=");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("renders unique IDs and a restore control bound to the soft-archived line", () => {
    const archived = archiveFlexibleLine(makePlanningTestState(), TEST_IDS.lines[0]);
    const html = renderToStaticMarkup(<PlanningScreen budget={archived} onChange={vi.fn(async () => undefined)} />);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    const restoreId = `restore-${TEST_IDS.categories.children}`;
    expect(html).toContain(`for="${restoreId}"`);
    expect(html).toContain(`id="${restoreId}"`);
    expect(html).toContain("value=\"10000\"");
    expect(html).toContain("Вернуть лимит");
    expect(html).toContain("aria-label=\"Вернуть повседневный лимит «Дети»\"");
  });

  it("keeps financial and label data out of URL, storage shortcuts and logs", () => {
    const source = readFileSync(new URL("./PlanningScreen.tsx", import.meta.url), "utf8") + readFileSync(new URL("./model.ts", import.meta.url), "utf8") + readFileSync(new URL("./form-state.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|URLSearchParams|location\.|console\./);
    expect(source).not.toMatch(/\.splice\(|delete\s+/);
    expect(source).toContain("repository.save(next)");
    expect(source.indexOf("repository.save(next)")).toBeLessThan(source.indexOf("options.publish(next)"));
    expect(source).toContain("maxLength={80}");
    expect(source).toContain("maxLength={24}");
  });

  it("tracks every lossy planning draft category and aggregates them conservatively", () => {
    expect(isPlanningEditorDirty(
      { name: "Новая страховка", dueDate: "", amount: "" },
      { name: "", dueDate: "", amount: "" },
      null,
    )).toBe(true);
    expect(isPlanningEditorDirty(
      { name: "", dueDay: "15", months: [9, 10] },
      { name: "", dueDay: "1", months: [] },
      null,
    )).toBe(true);
    expect(isPlanningEditorDirty(
      { name: "Продукты", amount: "30000" },
      { name: "", amount: "" },
      null,
    )).toBe(true);
    expect(isPlanningEditorDirty(
      { name: "", amount: "" },
      { name: "", amount: "" },
      "editing-existing-line",
    )).toBe(true);
    expect(isPlanningEditorDirty(
      { name: "", amount: "" },
      { name: "", amount: "" },
      null,
    )).toBe(false);

    const baselines = new Map([
      [TEST_IDS.categories.children, "10000"],
    ]);
    expect(hasChangedRestoreDrafts({
      [TEST_IDS.categories.children]: { amount: "12000", error: null },
    }, baselines)).toBe(true);
    expect(hasChangedRestoreDrafts({
      [TEST_IDS.categories.children]: { amount: "10000", error: null },
    }, baselines)).toBe(false);
    expect(hasChangedRestoreDrafts({
      "stale-category": { amount: "999", error: null },
    }, baselines)).toBe(false);

    for (const editor of ["commitment", "schedule", "flexible"] as const) {
      expect(hasUnsavedPlanningDrafts({
        commitment: editor === "commitment",
        schedule: editor === "schedule",
        flexible: editor === "flexible",
      })).toBe(true);
    }
    expect(hasUnsavedPlanningDrafts({
      commitment: false,
      schedule: false,
      flexible: false,
    })).toBe(false);
  });

  it("wires one aggregate dirty callback through every editor with unmount cleanup", () => {
    const source = readFileSync(new URL("./PlanningScreen.tsx", import.meta.url), "utf8");

    expect(source).toContain("onDirtyChange?: (dirty: boolean) => void");
    expect(source).toContain("<CommitmentsEditor {...props} onDirtyChange={reportCommitmentDirty} />");
    expect(source).toContain("<SchedulesEditor {...props} onDirtyChange={reportScheduleDirty} />");
    expect(source).toContain("<FlexibleEditor {...props} onDirtyChange={reportFlexibleDirty} />");
    expect(source).toMatch(/useEffect\(\(\) => \(\) => \{\s*onDirtyChange\(false\);/);
    expect(source).toContain("onDirtyChange?.(false)");
  });
});
