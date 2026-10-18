import { describe, expect, it } from "vitest";
import { G002, toDomainBudgetState } from "@family-budget/test-fixtures";

import { carriedId, documentIds, makePlanningSeed, type BudgetState } from "../src/index.js";
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

  it("keeps carriedId reachable where rollover always offered it", () => {
    expect(carriedIdFromRollover).toBe(carriedId);
  });
});
