import { describe, expect, it } from "vitest";

import { G000, G001, G002, parseCanonicalFixture, toDomainBudgetState } from "../src/index.js";

describe("canonical fixtures", () => {
  it("validates and adapts G-000, G-001, and G-002 from the canonical JSON files", () => {
    expect(G000.fixtureId).toBe("G-000");
    expect(G001.fixtureId).toBe("G-001");
    expect(G002.fixtureId).toBe("G-002");
    expect(toDomainBudgetState(G000).transactions).toHaveLength(4);
    expect(toDomainBudgetState(G001).transactions).toHaveLength(5);
    expect(toDomainBudgetState(G002).annualCommitments.map((item) => item.dueDate)).toEqual([
      "2027-01-15",
      "2027-05-01",
      "2027-06-15",
    ]);
  });

  it("rejects duplicate IDs after schema validation", () => {
    const duplicate = structuredClone(G002) as unknown as { state: { accounts: { id: string }[] } };
    duplicate.state.accounts[1]!.id = duplicate.state.accounts[0]!.id;
    expect(() => parseCanonicalFixture(duplicate)).toThrow(/duplicate id/i);
  });

  it("rejects unsafe integer money at the schema boundary", () => {
    const unsafe = structuredClone(G002) as unknown as { state: { accounts: { openingBalanceMinor: number }[] } };
    unsafe.state.accounts[0]!.openingBalanceMinor = Number.MAX_SAFE_INTEGER + 1;
    expect(() => parseCanonicalFixture(unsafe)).toThrow(/schema validation/i);
  });

  it("rejects flipped movements, mismatched splits, and unsafe signed movements", () => {
    type MutableBudget = { transactions: { movements: { signedAmountMinor: number }[]; splits: { amountMinor: number }[] }[] };
    const flipped = structuredClone(G000) as unknown as MutableBudget;
    flipped.transactions[1]!.movements[0]!.signedAmountMinor = 4_000_000;
    expect(() => parseCanonicalFixture(flipped)).toThrow(/source movement/);

    const splitMismatch = structuredClone(G000) as unknown as MutableBudget;
    splitMismatch.transactions[1]!.splits[0]!.amountMinor = 1;
    expect(() => parseCanonicalFixture(splitMismatch)).toThrow(/splits must equal/);

    const unsafe = structuredClone(G000) as unknown as MutableBudget;
    unsafe.transactions[1]!.movements[0]!.signedAmountMinor = Number.MAX_SAFE_INTEGER + 1;
    expect(() => parseCanonicalFixture(unsafe)).toThrow(/schema validation/i);
  });

  it("accepts a linked canonical refund and rejects missing, non-expense, or cross-category originals", () => {
    type MutableFixture = { transactions: Record<string, unknown>[] };
    const fixture = structuredClone(G000) as unknown as MutableFixture;
    const original = fixture.transactions[1]!;
    const refund = {
      id: "99999999-9999-4999-8999-999999999901",
      householdId: original.householdId,
      externalCode: "T-REFUND",
      kind: "refund",
      amountMinor: 100,
      memberId: original.memberId,
      optionalGoalId: null,
      originalTransactionId: original.id,
      occurredOn: "2026-07-07",
      createdAt: "2026-07-07T05:00:00Z",
      updatedAt: "2026-07-07T05:00:00Z",
      revision: 1,
      deletedAt: null,
      status: "posted",
      movements: [{ id: "99999999-9999-4999-8999-999999999902", accountId: (original.movements as Record<string, unknown>[])[0]!.accountId, signedAmountMinor: 100, role: "destination" }],
      splits: [{ id: "99999999-9999-4999-8999-999999999903", categoryId: (original.splits as Record<string, unknown>[])[0]!.categoryId, amountMinor: 100 }],
    };
    fixture.transactions.push(refund);
    expect(parseCanonicalFixture(fixture).fixtureId).toBe("G-000");

    const missing = structuredClone(fixture) as MutableFixture;
    missing.transactions.at(-1)!.originalTransactionId = null;
    expect(() => parseCanonicalFixture(missing)).toThrow(/schema validation/i);

    const income = structuredClone(fixture) as MutableFixture;
    income.transactions.at(-1)!.originalTransactionId = income.transactions[0]!.id;
    expect(() => parseCanonicalFixture(income)).toThrow(/posted expense/);

    const wrongCategory = structuredClone(fixture) as MutableFixture;
    wrongCategory.transactions.at(-1)!.splits = [{ ...(wrongCategory.transactions.at(-1)!.splits as Record<string, unknown>[])[0], categoryId: (wrongCategory.transactions[2]!.splits as Record<string, unknown>[])[0]!.categoryId }];
    expect(() => parseCanonicalFixture(wrongCategory)).toThrow(/original expense category/);
  });

  it("rejects overlong strings and oversized collections at a bounded schema boundary", () => {
    const longName = structuredClone(G002) as unknown as { state: { accounts: { name: string }[] } };
    longName.state.accounts[0]!.name = "x".repeat(201);
    expect(() => parseCanonicalFixture(longName)).toThrow(/schema validation/i);

    const oversized = structuredClone(G002) as unknown as { state: { accounts: unknown[] } };
    oversized.state.accounts = Array.from({ length: 1001 }, () => structuredClone(oversized.state.accounts[0]));
    expect(() => parseCanonicalFixture(oversized)).toThrow(/schema validation/i);

    const oversizedExpected = structuredClone(G000) as unknown as { expected: { accountBalances: unknown[] } };
    oversizedExpected.expected.accountBalances = Array.from({ length: 1001 }, () => structuredClone(oversizedExpected.expected.accountBalances[0]));
    expect(() => parseCanonicalFixture(oversizedExpected)).toThrow(/schema validation/i);
  });
});
