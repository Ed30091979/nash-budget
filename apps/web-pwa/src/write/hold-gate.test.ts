import type { DocumentHold } from "@family-budget/sync-client";
import { describe, expect, it } from "vitest";
import { readAppSource } from "../app/shell-source";
import { ALL_ROUTE_FIXTURES } from "../navigation/test-fixture";
import { formatRoute, parentRoute, type Route } from "../navigation/routes";
import { WRITE_REFUSAL_TEXT } from "../write-refusal";
import { createHoldGate, HOLD_DETAILS_LABEL, opensWriteForm, writeFormRefusal, type WriteFormRefusal } from "./hold-gate";

/** Every state the family status can be in for the gate: no hold, and each reason with each kind of document. */
const HOLD_STATES: readonly (readonly [string, DocumentHold | null])[] = [
  ["no hold", null],
  ["rejected, kept", { reason: "rejected_by_app", document: "kept" }],
  ["rejected, empty", { reason: "rejected_by_app", document: "empty" }],
  ["not ready, kept", { reason: "journal_not_ready", document: "kept" }],
  ["not ready, empty", { reason: "journal_not_ready", document: "empty" }],
];

function expected(hold: DocumentHold | null, route: Route): WriteFormRefusal | null {
  if (hold === null || !opensWriteForm(route)) return null;
  return {
    message: WRITE_REFUSAL_TEXT[hold.reason === "rejected_by_app" ? "held" : "notReady"],
    fallback: parentRoute(route) ?? { name: "overview" },
  };
}

describe("задержка документа: форма записи не открывается (ревью 2a, п. 6; круг 2, LOW 4)", () => {
  it("форма записи — «+» и правка, «План месяца», «Выписка» и лист записи поверх любого экрана", () => {
    const writing = ALL_ROUTE_FIXTURES.filter(opensWriteForm).map(formatRoute);
    expect(writing).toEqual([
      "#/?sheet=entry", "#/operations?sheet=entry", "#/reports?sheet=entry", "#/more?sheet=entry",
      "#/new", "#/new?edit=7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b", "#/new?sheet=entry",
      "#/new?edit=7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b&sheet=entry",
      "#/more/plan-month", "#/more/plan-month?sheet=entry",
      "#/more/plan-year?sheet=entry", "#/more/family?sheet=entry",
      "#/more/import", "#/more/import?sheet=entry",
    ]);
    // Лист записи закрывается на экран под ним: туда и уходит отказ.
    expect(writeFormRefusal({ reason: "rejected_by_app", document: "kept" }, { name: "reports", sheet: "entry" })?.fallback).toEqual({ name: "reports" });
  });

  it("маршруты × состояния задержки × порядок прихода статуса: форма не открывается, начатый черновик остаётся", () => {
    for (const route of ALL_ROUTE_FIXTURES) {
      for (const [state, hold] of HOLD_STATES) {
        const where = `${formatRoute(route)}, ${state}`;

        // Статус известен до прихода на маршрут: отказ — на самом приходе, повторного нет.
        const known = createHoldGate();
        expect(known.statusKnown({ name: "overview" }, hold, true), where).toBeNull();
        expect(known.arrived(route, hold), where).toEqual(expected(hold, route));

        // Перезагрузка или ссылка: пришли раньше статуса — задержки ещё не видно, и форма
        // открылась. Статус пришёл, в форму ничего не набрано — отказ сейчас.
        const cold = createHoldGate();
        expect(cold.arrived(route, null), where).toBeNull();
        expect(cold.statusKnown(route, hold, true), where).toEqual(expected(hold, route));
        // Только один раз: следующий статус уже не первый.
        expect(cold.statusKnown(route, hold, true), where).toBeNull();

        // Пришли раньше статуса и успели набрать: начатый черновик не отнимается.
        const typed = createHoldGate();
        expect(typed.arrived(route, null), where).toBeNull();
        expect(typed.statusKnown(route, hold, false), where).toBeNull();
        // Но следующий приход на форму — уже отказ.
        expect(typed.arrived(route, hold), where).toEqual(expected(hold, route));
      }
    }
    expect(HOLD_DETAILS_LABEL).toBe("Подробнее в «Семье»");
  });

  it("оболочка проводит через шлюз каждый переход, каждый приход и первый статус", () => {
    // Поведение — в тестах выше; здесь только то, что оболочка его вызывает, а не дублирует.
    const source = readAppSource();
    expect(source).toContain("const refusal = writeFormRefusal(hold, destination);");
    expect(source).toContain("const refusal = holdGate.arrived(router.current(), holdRef.current);");
    expect(source).toContain('const refusal = holdGate.statusKnown(router.current(), holdRef.current, !drafts.hasUnsavedDrafts("navigation"));');
    expect(source).toContain("const holdKnown = family.inFamily && family.status !== null;");
  });
});
