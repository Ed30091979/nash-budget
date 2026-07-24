import { describe, expect, it } from "vitest";
import {
  createOperationsSubmissionGate,
  INITIAL_OPERATIONS_FORM_STATE,
  operationsFormReducer,
} from "./form-state";

describe("operations form state", () => {
  it("tracks submit, safe validation failure, change, and success", () => {
    const busy = operationsFormReducer(INITIAL_OPERATIONS_FORM_STATE, { type: "submit" });
    expect(busy.busy).toBe(true);
    expect(operationsFormReducer(busy, { type: "change" })).toBe(busy);
    const failed = operationsFormReducer(busy, { type: "failure", error: { field: "amount", message: "Проверьте сумму." } });
    expect(failed).toEqual({ busy: false, errorField: "amount", errorMessage: "Проверьте сумму." });
    expect(operationsFormReducer(failed, { type: "change" })).toBe(INITIAL_OPERATIONS_FORM_STATE);
    expect(operationsFormReducer(busy, { type: "success" })).toBe(INITIAL_OPERATIONS_FORM_STATE);
  });

  it("synchronously ignores same-tick double submission and unlocks after rejection", async () => {
    const gate = createOperationsSubmissionGate();
    let release!: () => void;
    const first = gate.run(() => new Promise<number>((resolve) => { release = () => resolve(1); }));
    const second = gate.run(async () => 2);
    expect(gate.locked).toBe(true);
    expect(await second).toEqual({ status: "ignored" });
    release();
    expect(await first).toEqual({ status: "completed", value: 1 });
    expect(gate.locked).toBe(false);
    await expect(gate.run(async () => { throw new Error("save"); })).rejects.toThrow("save");
    expect(gate.locked).toBe(false);
  });
});
