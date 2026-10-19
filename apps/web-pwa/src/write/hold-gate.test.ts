import type { DocumentHold } from "@family-budget/sync-client";
import { describe, expect, it } from "vitest";
import { ALL_ROUTE_FIXTURES } from "../navigation/test-fixture";
import { formatRoute, parentRoute } from "../navigation/routes";
import { WRITE_REFUSAL_TEXT } from "../write-refusal";
import { HOLD_DETAILS_LABEL, opensWriteForm, writeFormRefusal } from "./hold-gate";
import { readAppSource } from "../app/shell-source";

const HELD: DocumentHold = { reason: "rejected_by_app", document: "kept" };

describe("задержка документа: форма записи не открывается (ревью 2a, п. 6)", () => {
  it("форма записи — «+» и правка, «План месяца», «Выписка»; остальное только показывает", () => {
    const writing = ALL_ROUTE_FIXTURES.filter(opensWriteForm).map(formatRoute);
    expect(writing).toEqual([
      "#/new", "#/new?edit=7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b", "#/new?sheet=entry",
      "#/new?edit=7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b&sheet=entry",
      "#/more/plan-month", "#/more/plan-month?sheet=entry", "#/more/import", "#/more/import?sheet=entry",
    ]);
  });

  it("при задержке — слова отказа записи и родитель вместо формы; без задержки — ничего", () => {
    for (const route of ALL_ROUTE_FIXTURES) {
      expect(writeFormRefusal(null, route), formatRoute(route)).toBeNull();
      const refusal = writeFormRefusal(HELD, route);
      if (!opensWriteForm(route)) {
        expect(refusal, formatRoute(route)).toBeNull();
        continue;
      }
      expect(refusal?.message).toBe(WRITE_REFUSAL_TEXT.held);
      expect(refusal?.fallback).toEqual(parentRoute(route));
    }
    // Слова следуют причине задержки — те же, что у отказа записи.
    for (const reason of ["rejected_by_app", "journal_not_ready"] as const) {
      const refusal = writeFormRefusal({ reason, document: "kept" }, { name: "entry" });
      expect(refusal?.message).toBe(WRITE_REFUSAL_TEXT[reason === "rejected_by_app" ? "held" : "notReady"]);
    }
    expect(HOLD_DETAILS_LABEL).toBe("Подробнее в «Семье»");
  });

  it("оболочка спрашивает задержку на каждом переходе и на каждом приходе, а тост ведёт в «Семью»", () => {
    const source = readAppSource();
    // Каждая точка входа в форму — через `navigate`: «+», «Записать» обзора, правка из «Операций»,
    // «План месяца» и «Выписка» из «Ещё» и обзора.
    for (const entry of [
      '<BottomNav navRef={navRef} route={route} onTab={(tab) => navigate({ name: tab })} onAdd={() => navigate({ name: "entry" })} />',
      'onEdit={(transaction) => navigate({ name: "entry", edit: transaction.id })}',
      'onPlanMonth={() => navigate({ name: "plan-month" })}',
      'onImportStatement={() => navigate({ name: "import" })}',
      'onImport={() => navigate({ name: "import" })}',
    ]) expect(source, entry).toContain(entry);
    expect(source).toMatch(/const refusal = writeFormRefusal\(hold, destination\);\s*if \(refusal !== null\) \{\s*refuseWriteForm\(refusal\.message\);\s*return;\s*\}\s*router\.navigate\(destination\);/u);
    // Приход набранным адресом, «Назад» или «Вперёд» — тоже: маршрут уходит к родителю.
    expect(source).toMatch(/const refusal = writeFormRefusal\(holdRef\.current, router\.current\(\)\);\s*if \(refusal === null\) return;\s*router\.redirect\(refusal\.fallback\);\s*refuseWriteForm\(refusal\.message\);\s*\}, \[currentRouteKey, router, refuseWriteForm\]\);/u);
    // Кнопка «Подробнее в «Семье»» стоит только у сообщения отказа, а не у любого, что встало на его место.
    expect(source).toContain("{messageToFamily === message ? <>");
    expect(source).toContain('onClick={() => { setMessage(null); navigate({ name: "family" }); }}>{HOLD_DETAILS_LABEL}</button>');
  });
});
