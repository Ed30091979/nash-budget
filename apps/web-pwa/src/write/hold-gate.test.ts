import type { DocumentHold } from "@family-budget/sync-client";
import { describe, expect, it } from "vitest";
import { readAppSource } from "../app/shell-source";
import { ACCOUNT, ALL_ROUTE_FIXTURES, CATEGORY } from "../navigation/test-fixture";
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
  it("форма записи — лист ввода поверх любого экрана («+», плитки, правка), «План месяца», «Выписка», счёт и категория", () => {
    const writing = ALL_ROUTE_FIXTURES.filter(opensWriteForm).map(formatRoute);
    // Экраны-формы — пять; всё остальное, что пишет бюджет, — лист ввода, с чем бы его ни открыли.
    expect(writing.filter((key) => !key.includes("sheet=entry"))).toEqual([
      "#/more/plan-month", "#/more/import",
      `#/more/accounts/${ACCOUNT}`, "#/more/accounts/new", "#/more/accounts/new?type=savings", `#/more/categories/${CATEGORY}`, `#/more/categories/${CATEGORY}?type=income`,
    ]);
    expect(writing.filter((key) => key.includes("sheet=entry"))).toEqual(ALL_ROUTE_FIXTURES.filter((route) => route.sheet === "entry").map(formatRoute));
    // Списки справочников читают — остатки, курсы, числа операций — и открываются; запись из них
    // отказывает там, где её начали.
    expect(ALL_ROUTE_FIXTURES.filter((route) => !opensWriteForm(route)).map(formatRoute)).toEqual([
      "#/", "#/?month=2026-08", "#/operations",
      // Лента с фильтрами и «Отчёты» с периодом только читают (2d): записывает лист поверх них.
      "#/operations?from=2026-10-01&to=2026-10-31",
      `#/operations?acc=${ACCOUNT}&cat=${CATEGORY}&tag=7e888888-8888-4888-8888-888888888882&member=c6666666-6666-4666-8666-666666666601&kind=expense`,
      "#/operations?to=2026-10-19&kind=debt_out",
      "#/operations?period=all",
      `#/operations?period=all&acc=${ACCOUNT}&kind=income`,
      "#/reports", "#/reports?view=income", "#/reports?view=tags&period=quarter", "#/reports?period=month&from=2026-09-01",
      `#/reports?period=custom&from=2026-10-01&to=2026-10-15&acc=${ACCOUNT}`,
      "#/more", "#/more/plan-year", "#/more/family",
      "#/more/accounts", "#/more/rates",
      "#/more/categories", "#/more/categories?type=expense", "#/more/categories?type=income",
      "#/more/tags",
      // Заглушки 2e только читают: на них нечего записывать (R2).
      "#/more/debts", "#/more/goals", "#/more/recurring",
    ]);
    expect(writeFormRefusal({ reason: "rejected_by_app", document: "kept" }, { name: "account", id: ACCOUNT })?.fallback).toEqual({ name: "accounts" });
    expect(writeFormRefusal({ reason: "rejected_by_app", document: "kept" }, { name: "category", id: CATEGORY })?.fallback).toEqual({ name: "categories", type: "expense" });
    // Лист записи закрывается на экран под ним: туда и уходит отказ.
    expect(writeFormRefusal({ reason: "rejected_by_app", document: "kept" }, { name: "reports", sheet: "entry" })?.fallback).toEqual({ name: "reports" });
    expect(writeFormRefusal({ reason: "rejected_by_app", document: "kept" }, { name: "overview", month: "2026-08", sheet: "entry", op: "expense" })?.fallback).toEqual({ name: "overview", month: "2026-08" });
    expect(writeFormRefusal({ reason: "journal_not_ready", document: "kept" }, { name: "operations", sheet: "entry", edit: "7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b" })?.fallback).toEqual({ name: "operations" });
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
