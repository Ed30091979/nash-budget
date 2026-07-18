import { describe, expect, it, vi } from "vitest";
import {
  changeRestoreDraft,
  createSubmissionGate,
  failRestoreDraft,
  INITIAL_PLANNING_FORM_STATE,
  planningFormReducer,
  nextEditingId,
  resolveErrorTarget,
  restoreControlId,
} from "./form-state";

describe("pure planning form controller", () => {
  it("moves through submit/failure/change/success without retaining stale errors", () => {
    const busy = planningFormReducer(INITIAL_PLANNING_FORM_STATE, { type: "submit" });
    expect(busy).toEqual({ busy: true, errorField: null, errorMessage: null });
    expect(planningFormReducer(busy, { type: "change" })).toBe(busy);
    const failed = planningFormReducer(busy, { type: "failure", error: { field: "amount", message: "Исправьте сумму." } });
    expect(failed).toEqual({ busy: false, errorField: "amount", errorMessage: "Исправьте сумму." });
    expect(planningFormReducer(failed, { type: "change" })).toEqual(INITIAL_PLANNING_FORM_STATE);
    expect(planningFormReducer(busy, { type: "success" })).toEqual(INITIAL_PLANNING_FORM_STATE);
  });

  it("maps visible fields to a unique focus target and unknown failures to the form", () => {
    expect(resolveErrorTarget("schedule", { field: "dueDay", message: "День" }, ["dueDay"])).toEqual({ field: "dueDay", id: "schedule-dueDay", message: "День" });
    expect(resolveErrorTarget("schedule", { field: "internal", message: "Ошибка" }, ["dueDay"])).toEqual({ field: "form", id: "schedule-form", message: "Ошибка" });
    expect(restoreControlId("30000000-0000-4000-8000-000000000004")).toBe("restore-30000000-0000-4000-8000-000000000004");
  });

  it("navigates predictably between create, edit, cancel and saved modes", () => {
    const editing = nextEditingId(null, { type: "edit", id: "item-1" });
    expect(editing).toBe("item-1");
    expect(nextEditingId(editing, { type: "cancel" })).toBeNull();
    expect(nextEditingId(editing, { type: "saved" })).toBeNull();
  });

  it("ignores a same-tick double submit and unlocks after failure", async () => {
    const gate = createSubmissionGate();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const operation = vi.fn(async () => blocker);
    const first = gate.run(operation);
    const second = await gate.run(operation);
    expect(second).toEqual({ status: "ignored" });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(gate.locked).toBe(true);
    release();
    await first;
    expect(gate.locked).toBe(false);
    await expect(gate.run(async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    expect(gate.locked).toBe(false);
  });

  it("keeps per-category restore drafts and clears only the changed control error", () => {
    const failed = failRestoreDraft({}, "cat-a", "bad", "Введите сумму.");
    const withSecond = failRestoreDraft(failed, "cat-b", "also bad", "Ошибка B");
    const changed = changeRestoreDraft(withSecond, "cat-a", "12000");
    expect(changed["cat-a"]).toEqual({ amount: "12000", error: null });
    expect(changed["cat-b"]).toEqual({ amount: "also bad", error: "Ошибка B" });
  });
});
