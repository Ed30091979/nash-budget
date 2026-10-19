/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  hasChangedRestoreDrafts,
  isPlanningEditorDirty,
  PlanningScreen,
} from "./PlanningScreen";
import { createDraftRegistry, type DraftEntry } from "../../navigation/draft-guard";
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

    // Три редактора — три черновика в реестре: любой грязный держит переход, чистые — нет.
    for (const editor of ["commitment", "schedule", "flexible"] as const) {
      const registry = createDraftRegistry();
      for (const name of ["commitment", "schedule", "flexible"] as const) {
        const entry: DraftEntry = { label: name, isDirty: () => name === editor };
        registry.register({ current: entry });
      }
      expect(registry.hasUnsavedDrafts("navigation")).toBe(true);
      expect(registry.dirtyLabels("navigation")).toEqual([editor]);
    }
    const clean = createDraftRegistry();
    for (const name of ["commitment", "schedule", "flexible"]) clean.register({ current: { label: name, isDirty: () => false } });
    expect(clean.hasUnsavedDrafts("navigation")).toBe(false);
  });

  it("держит черновик каждого редактора в реестре: переход спрашивает его синхронно, запись снимает до ожидания", () => {
    const source = readFileSync(new URL("./PlanningScreen.tsx", import.meta.url), "utf8");

    // Пассивного флага больше нет: экран не сообщает о черновике, а отвечает на вопрос реестра.
    expect(source).not.toContain("onDirtyChange");
    expect(source.match(/usePlanningDraft\(/gu)).toHaveLength(4);
    expect(source).toContain("useDraftGuard({ label, isDirty: () => dirty && !saving.saving, discard });");
    // Черновик, отправленный в запись, «записывается» — синхронно, до первого ожидания; неудача
    // возвращает его, удача держит, пока сброшенная форма не нарисована.
    expect(source).toMatch(/if \(submitsDraft\) saving\.begin\(\);\s*dispatch\(\{ type: "submit" \}\);\s*try \{\s*await onChange\(change\);/u);
    expect(source).toMatch(/\} catch \(error\) \{\s*\/\/[^\n]*\n\s*saving\.end\(\);/u);
    expect(source).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(!dirty\) saving\.end\(\);/u);
    // Архив и возврат строки черновик не уносят; уносят только «Добавить» и «Сохранить».
    expect(source.match(/, true\);/gu)).toHaveLength(2);
    expect(source).toMatch(/\(\) => \{ resetDraft\(\); setEditingId\(\(current\) => nextEditingId\(current, \{ type: "saved" \}\)\); \},\s*true,/u);
  });

  it("печатает заголовки групп там же, где предлагает выбрать категорию", () => {
    const html = renderToStaticMarkup(<PlanningScreen budget={makePlanningTestState()} onChange={vi.fn(async () => undefined)} />);

    // Тестовое состояние написано ещё свободными подписями групп; закрытый перечень домена
    // разбирает их сам, и заголовки печатаются его, а не те, что лежат в документе.
    expect(html).toContain('<optgroup label="Обязательные платежи">');
    expect(html).toContain('<optgroup label="Каждый день">');
    expect(html).not.toContain('<optgroup label="Семья">');
  });
});
