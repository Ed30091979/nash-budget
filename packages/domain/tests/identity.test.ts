import { describe, expect, it } from "vitest";
import { G002, toDomainBudgetState } from "@family-budget/test-fixtures";

import { carriedId, documentIds, HOUSEHOLD_ID, makePlanningSeed, type BudgetState } from "../src/index.js";
import { carriedId as carriedIdFromRollover } from "../src/rollover.js";

describe("document identity", () => {
  it("lists every identifier of the document, budget lines and members included", () => {
    const state = toDomainBudgetState(G002) as BudgetState;
    const ids = documentIds(state);

    const expected = [
      ...(state.members ?? []).map((item) => item.id),
      ...state.accounts.map((item) => item.id),
      ...state.categories.map((item) => item.id),
      ...state.budgets.map((item) => item.id),
      ...state.budgets.flatMap((item) => item.lines.map((line) => line.id)),
      ...state.goals.map((item) => item.id),
      ...state.annualCommitments.map((item) => item.id),
      ...state.scheduledExpenses.map((item) => item.id),
      ...state.transactions.map((item) => item.id),
    ];
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("treats a document written before members existed as having none", () => {
    const state = makePlanningSeed();
    expect("members" in state).toBe(false);
    expect(documentIds(state)).toContain(state.activeBudgetId);
    expect(documentIds(state)).toHaveLength(
      state.accounts.length + state.categories.length + 1 + state.budgets[0]!.lines.length
        + state.goals.length + state.annualCommitments.length + state.scheduledExpenses.length
        + state.transactions.length,
    );
  });

  it("reports a repeated identifier instead of hiding it", () => {
    const state = makePlanningSeed();
    const repeated = { ...state, transactions: [...state.transactions, state.transactions[0]!] };
    expect(documentIds(repeated).filter((id) => id === state.transactions[0]!.id)).toHaveLength(2);
  });

  it("counts tags, so nothing derived can land on one", () => {
    const state: BudgetState = { ...makePlanningSeed(), tags: [{ id: "8a000000-0000-4000-8000-0000000000a1", name: "Отпуск", active: true }] };
    expect(documentIds(state)).toContain("8a000000-0000-4000-8000-0000000000a1");
  });

  it("counts the household and the exchange rates", () => {
    const state: BudgetState = {
      ...makePlanningSeed(),
      household: { id: HOUSEHOLD_ID, baseCurrency: "RUB" },
      exchangeRates: [{ id: "8e000000-0000-4000-8000-000000000001", currency: "USD", baseCurrency: "RUB", date: "2026-07-31", rate: { baseMinor: 9_000, quoteMinor: 100 } }],
    };
    expect(documentIds(state)).toContain(HOUSEHOLD_ID);
    expect(documentIds(state)).toContain("8e000000-0000-4000-8000-000000000001");
    expect(documentIds(state)).toHaveLength(documentIds(makePlanningSeed()).length + 2);
  });

  it("names the household the same way on every device and in every version", () => {
    // Two devices that set the base currency without having met must write one entity, so the
    // name may only ever change in a way that keeps this string.
    expect(HOUSEHOLD_ID).toBe("cab5a071-8b9d-8336-819b-8e56e68973ea");
    expect(HOUSEHOLD_ID).toBe(carriedId("household"));
    expect(HOUSEHOLD_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("keeps carriedId reachable where rollover always offered it", () => {
    expect(carriedIdFromRollover).toBe(carriedId);
  });
});
