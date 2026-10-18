import { describe, expect, it } from "vitest";
import { G002, toDomainBudgetState } from "@family-budget/test-fixtures";

import {
  archiveDebt,
  calculateAnnualPlan,
  calculateBudget,
  calculateDebts,
  calculateMemberExpenses,
  COLLECTION_LIMITS,
  createDebt,
  DebtValidationError,
  deleteDebt,
  makeSeedBudget,
  normalizeCounterparty,
  SEED_IDS,
  type BudgetState,
  type Debt,
  type DebtId,
  type Transaction,
} from "../src/index.js";

const PETYA = "8f100000-0000-4000-8000-0000000000d1";
const SERGEY = "8f100000-0000-4000-8000-0000000000d2";

function ids(...values: DebtId[]): () => DebtId {
  let next = 0;
  return () => values[next++] ?? `debt-${next}`;
}

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof DebtValidationError) return error.code;
    throw error;
  }
}

/** The seed with the two debts of G-003: Петя owes 3 000 ₽, the family owes Сергей 50 $. */
function withDebts(state: BudgetState = makeSeedBudget()): BudgetState {
  return {
    ...state,
    exchangeRates: [
      { id: "8e000000-0000-4000-8000-000000000001", currency: "USD", baseCurrency: "RUB", date: "2026-07-31", rate: { baseMinor: 9_000, quoteMinor: 100 } },
      { id: "8e000000-0000-4000-8000-000000000002", currency: "USD", baseCurrency: "RUB", date: "2026-08-15", rate: { baseMinor: 9_250, quoteMinor: 100 } },
    ],
    debts: [
      { id: PETYA, counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 300_000, active: true },
      { id: SERGEY, counterparty: "Сергей", direction: "i_owe", currency: "USD", openingMinor: 5_000, dueDate: "2026-12-31", active: true },
    ],
  };
}

describe("createDebt", () => {
  it("creates an active debt with the name as it will be stored, and moves no figure", () => {
    const seed = makeSeedBudget();
    const { state, debt } = createDebt(seed, { counterparty: "  Петя ", direction: "owed_to_me", currency: "RUB", openingMinor: 300_000 }, ids(PETYA));
    expect(debt).toEqual({ id: PETYA, counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 300_000, active: true });
    expect(state.debts).toEqual([debt]);
    expect(calculateBudget(state)).toEqual(calculateBudget(seed));
    expect(calculateMemberExpenses(state)).toEqual(calculateMemberExpenses(seed));
    const { debt: dated } = createDebt(seed, { counterparty: "Сергей", direction: "i_owe", currency: "USD", openingMinor: 0, dueDate: "2026-12-31" }, ids(SERGEY));
    expect(dated.dueDate).toBe("2026-12-31");
  });

  it("refuses a counterparty nobody can read, an unknown direction or currency, a bad amount or date", () => {
    const seed = makeSeedBudget();
    const draft = { counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 0 } as const;
    expect(code(() => createDebt(seed, { ...draft, counterparty: "  " }, ids(PETYA)))).toBe("counterparty_required");
    expect(code(() => createDebt(seed, { ...draft, counterparty: "я".repeat(81) }, ids(PETYA)))).toBe("counterparty_too_long");
    expect(code(() => createDebt(seed, { ...draft, counterparty: "Пе\u200bтя" }, ids(PETYA)))).toBe("counterparty_forbidden_characters");
    expect(code(() => createDebt(seed, { ...draft, counterparty: "Петя Smith" }, ids(PETYA)))).toBe("counterparty_mixed_scripts");
    expect(code(() => createDebt(seed, { ...draft, counterparty: "???" }, ids(PETYA)))).toBe("counterparty_unreadable");
    expect(code(() => createDebt(seed, { ...draft, direction: "lent" as never }, ids(PETYA)))).toBe("unknown_direction");
    expect(code(() => createDebt(seed, { ...draft, currency: "XYZ" }, ids(PETYA)))).toBe("unknown_currency");
    for (const openingMinor of [-1, 1.5, 10 ** 10 + 1]) {
      expect(code(() => createDebt(seed, { ...draft, openingMinor }, ids(PETYA))), String(openingMinor)).toBe("invalid_amount");
    }
    for (const dueDate of ["2026-02-30", "2200-01-01", "tomorrow"]) {
      expect(code(() => createDebt(seed, { ...draft, dueDate }, ids(PETYA))), dueDate).toBe("invalid_due_date");
    }
    expect(normalizeCounterparty("Чаи\u0306ка")).toBe("Чайка");
  });

  it("refuses an identifier taken anywhere in the document, and the debt past the limit", () => {
    const seed = makeSeedBudget();
    const draft = { counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 0 } as const;
    expect(code(() => createDebt(seed, draft, () => seed.transactions[0]!.id))).toBe("duplicate_id");
    expect(code(() => createDebt(seed, draft, () => " "))).toBe("id_required");
    const full: BudgetState = {
      ...seed,
      debts: Array.from({ length: COLLECTION_LIMITS.debts }, (_, index): Debt => ({
        id: `8f200000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        counterparty: `Сосед ${index}`,
        direction: "owed_to_me",
        currency: "RUB",
        openingMinor: 0,
        active: false,
      })),
    };
    expect(code(() => createDebt(full, draft, ids(PETYA)))).toBe("limit_reached");
  });
});

describe("archiveDebt and deleteDebt", () => {
  it("archives a debt, which stays in every total", () => {
    const state = withDebts();
    const archived = archiveDebt(state, PETYA);
    expect(archived.debts?.find((item) => item.id === PETYA)?.active).toBe(false);
    expect(archiveDebt(archived, PETYA)).toBe(archived);
    expect(calculateDebts(archived, "2026-08-31").receivableInBaseMinor).toBe(300_000);
  });

  it("deletes a debt nothing refers to and refuses one it does not hold", () => {
    const state = withDebts();
    expect(deleteDebt(state, PETYA).debts?.map((item) => item.id)).toEqual([SERGEY]);
    expect(code(() => deleteDebt(makeSeedBudget(), PETYA))).toBe("unknown_debt");
    expect(code(() => archiveDebt(makeSeedBudget(), PETYA))).toBe("unknown_debt");
  });
});

describe("calculateDebts", () => {
  it("values each debt in its currency and in the base one at the latest rate on or before the day", () => {
    const metrics = calculateDebts(withDebts(), "2026-08-31");
    expect(metrics.asOf).toBe("2026-08-31");
    expect(metrics.baseCurrency).toBe("RUB");
    expect(metrics.debts.map((item) => item.debtId)).toEqual([PETYA, SERGEY]);
    expect(metrics.byDebt[PETYA]).toEqual({
      debtId: PETYA, direction: "owed_to_me", currency: "RUB", outMinor: 0, inMinor: 0,
      balanceMinor: 300_000, balanceInBaseMinor: 300_000, overdue: false,
    });
    // 50 $ at 92,50 ₽ on 15 August.
    expect(metrics.byDebt[SERGEY]).toMatchObject({ balanceMinor: 5_000, balanceInBaseMinor: 462_500, overdue: false });
    expect(metrics.receivableInBaseMinor).toBe(300_000);
    expect(metrics.payableInBaseMinor).toBe(462_500);
    expect(metrics.netInBaseMinor).toBe(-162_500);
    expect(metrics.unvaluedDebtIds).toEqual([]);
    // Ten days earlier the August rate is not there yet.
    expect(calculateDebts(withDebts(), "2026-08-10").byDebt[SERGEY]?.balanceInBaseMinor).toBe(450_000);
  });

  it("reports a debt it cannot value instead of throwing", () => {
    const state: BudgetState = { ...withDebts(), exchangeRates: [] };
    const metrics = calculateDebts(state, "2026-08-31");
    expect(metrics.byDebt[SERGEY]?.balanceInBaseMinor).toBeNull();
    expect(metrics.unvaluedDebtIds).toEqual([SERGEY]);
    expect(metrics.payableInBaseMinor).toBe(0);
    expect(metrics.receivableInBaseMinor).toBe(300_000);
  });

  it("calls a debt overdue past its due date while something is owed", () => {
    expect(calculateDebts(withDebts(), "2027-01-01").byDebt[SERGEY]?.overdue).toBe(true);
    expect(calculateDebts(withDebts(), "2026-12-31").byDebt[SERGEY]?.overdue).toBe(false);
    const settled: BudgetState = { ...withDebts(), debts: withDebts().debts!.map((item) => ({ ...item, openingMinor: 0 })) };
    expect(calculateDebts(settled, "2027-01-01").byDebt[SERGEY]?.overdue).toBe(false);
  });

  it("moves no figure of any budget, plan or split", () => {
    const g002 = toDomainBudgetState(G002) as BudgetState;
    const indebted = withDebts(g002);
    expect(calculateBudget(indebted)).toEqual(calculateBudget(g002));
    expect(calculateAnnualPlan(indebted, G002.startMonth, 12)).toEqual(calculateAnnualPlan(g002, G002.startMonth, 12));
    expect(calculateMemberExpenses(indebted)).toEqual(calculateMemberExpenses(g002));
  });

  it("refuses a debt the domain does not store, in every calculation", () => {
    const state = withDebts();
    const broken = (change: Partial<Debt>): BudgetState => ({ ...state, debts: [{ ...state.debts![0]!, ...change }] });
    expect(() => calculateBudget(broken({ counterparty: " Петя" }))).toThrow(/counterparty must be stored text of at most 80/);
    expect(() => calculateBudget(broken({ direction: "lent" as never }))).toThrow(/direction has unknown value lent/);
    expect(() => calculateBudget(broken({ currency: "XYZ" }))).toThrow(/debt .* currency has unknown value XYZ/);
    expect(() => calculateBudget(broken({ openingMinor: -1 }))).toThrow(/openingMinor must not be negative/);
    expect(() => calculateBudget(broken({ openingMinor: 10 ** 10 + 1 }))).toThrow(/openingMinor must be at most 10000000000/);
    expect(() => calculateMemberExpenses(broken({ dueDate: "2200-01-01" }))).toThrow(/dueDate must be from 1900-01-01 to 2199-12-31/);
    expect(() => calculateDebts(broken({ active: "yes" as never }), "2026-08-31")).toThrow(/active must be a boolean/);
    expect(() => calculateDebts({ ...state, debts: [state.debts![0]!, state.debts![0]!] }, "2026-08-31")).toThrow(/debts contains duplicate id/);
    expect(() => calculateDebts(state, "2026-02-30")).toThrow(/asOf must be a valid calendar date/);
  });
});

const DOLLARS = "8c000000-0000-4000-8000-0000000000a2";

/**
 * The debt movements of G-003 on the seed: 5 000 ₽ lent to Петя and 2 000 ₽ of it back, 100 $
 * borrowed from Сергей onto the dollar account and 50 $ of it paid back from the rouble account.
 */
function withMovements(): BudgetState {
  const state = withDebts();
  const movement = (id: string, occurredOn: string, kind: "debt_out" | "debt_in", amountMinor: number, accountId: string, debtId: string, extra: Partial<Transaction> = {}): Transaction =>
    ({ id, occurredOn, status: "posted", kind, amountMinor, accountId, debtId, ...extra }) as Transaction;
  return {
    ...state,
    debts: state.debts!.map((debt) => ({ ...debt, openingMinor: 0 })),
    accounts: [...state.accounts, { id: DOLLARS, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true }],
    transactions: [
      ...state.transactions,
      movement("8d100000-0000-4000-8000-000000000007", "2026-07-07", "debt_out", 500_000, SEED_IDS.accounts.main, PETYA),
      movement("8d100000-0000-4000-8000-000000000008", "2026-07-25", "debt_in", 200_000, SEED_IDS.accounts.main, PETYA),
      movement("8d100000-0000-4000-8000-000000000009", "2026-07-08", "debt_in", 10_000, DOLLARS, SERGEY),
      movement("8d100000-0000-4000-8000-000000000010", "2026-07-28", "debt_out", 462_500, SEED_IDS.accounts.main, SERGEY, { debtAmountMinor: 5_000 } as Partial<Transaction>),
    ],
  };
}

describe("debt movements", () => {
  it("moves each debt by its own amount, by the direction of the debt", () => {
    const metrics = calculateDebts(withMovements(), "2026-08-31");
    expect(metrics.byDebt[PETYA]).toMatchObject({ outMinor: 500_000, inMinor: 200_000, balanceMinor: 300_000, balanceInBaseMinor: 300_000 });
    // Borrowed 100 $, paid back 50 $ — in dollars, whatever the account it was paid from.
    expect(metrics.byDebt[SERGEY]).toMatchObject({ outMinor: 5_000, inMinor: 10_000, balanceMinor: 5_000, balanceInBaseMinor: 462_500 });
    expect(metrics.receivableInBaseMinor).toBe(300_000);
    expect(metrics.payableInBaseMinor).toBe(462_500);
    expect(metrics.netInBaseMinor).toBe(-162_500);
  });

  it("counts posted movements dated on or before the day, and no other", () => {
    const state = withMovements();
    expect(calculateDebts(state, "2026-07-24").byDebt[PETYA]?.balanceMinor).toBe(500_000);
    const drafted: BudgetState = {
      ...state,
      transactions: state.transactions.map((item) => (item.id === "8d100000-0000-4000-8000-000000000008" ? { ...item, status: "pending" } : item)),
    };
    expect(calculateDebts(drafted, "2026-08-31").byDebt[PETYA]?.balanceMinor).toBe(500_000);
  });

  it("shows an overpayment as a balance below zero", () => {
    const state = withMovements();
    const overpaid: BudgetState = {
      ...state,
      transactions: state.transactions.map((item) => (item.id === "8d100000-0000-4000-8000-000000000008" ? { ...item, amountMinor: 600_000 } : item)),
    };
    expect(calculateDebts(overpaid, "2026-08-31").byDebt[PETYA]).toMatchObject({ balanceMinor: -100_000, overdue: false });
    expect(calculateDebts(overpaid, "2026-08-31").receivableInBaseMinor).toBe(-100_000);
  });

  it("moves the account and no figure of the budget", () => {
    const seed = withDebts();
    const state = withMovements();
    const before = calculateBudget({ ...seed, accounts: state.accounts });
    const after = calculateBudget(state);
    expect(after.incomeMinor).toBe(before.incomeMinor);
    expect(after.expensesMinor).toBe(before.expensesMinor);
    expect(after.categoryMetrics).toEqual(before.categoryMetrics);
    // 5 000 out, 2 000 back, 4 625 paid back to Сергей: the main account is 7 625 ₽ lighter.
    expect(after.accountBalancesMinor[SEED_IDS.accounts.main]).toBe(before.accountBalancesMinor[SEED_IDS.accounts.main]! - 500_000 + 200_000 - 462_500);
    expect(after.accountBalancesMinor[DOLLARS]).toBe(50_000 + 10_000);
    expect(after.capitalMinor).toBe(before.capitalMinor - 762_500);
    expect(calculateMemberExpenses(state)).toEqual(calculateMemberExpenses({ ...seed, accounts: state.accounts }));
  });

  it("refuses to delete a debt an operation names, and points to the archive", () => {
    const state = withMovements();
    expect(code(() => deleteDebt(state, PETYA))).toBe("debt_in_use");
    expect(() => deleteDebt(state, PETYA)).toThrow(/убрать в архив/);
    expect(() => calculateBudget(archiveDebt(state, PETYA))).not.toThrow();
  });

  it("refuses a movement on a debt it does not hold, or with the wrong amounts", () => {
    const state = withMovements();
    const change = (id: string, patch: Record<string, unknown>): BudgetState => ({
      ...state,
      transactions: state.transactions.map((item) => (item.id === id ? ({ ...item, ...patch } as Transaction) : item)),
    });
    const lent = "8d100000-0000-4000-8000-000000000007";
    const repaid = "8d100000-0000-4000-8000-000000000010";
    expect(() => calculateBudget(change(lent, { debtId: "8f100000-0000-4000-8000-0000000000ff" }))).toThrow(/debtId references unknown id/);
    expect(() => calculateBudget(change(lent, { debtAmountMinor: 500_000 }))).toThrow(/is in the debt's currency and must not carry debtAmountMinor/);
    const { debtAmountMinor: _amount, ...unconverted } = state.transactions.find((item) => item.id === repaid) as Extract<Transaction, { kind: "debt_out" }>;
    expect(() => calculateBudget({ ...state, transactions: state.transactions.map((item) => (item.id === repaid ? unconverted : item)) }))
      .toThrow(/moves RUB against a debt in USD and must carry debtAmountMinor/);
    expect(() => calculateBudget(change(repaid, { debtAmountMinor: 10 ** 10 + 1 }))).toThrow(/debtAmountMinor must be at most 10000000000/);
    expect(() => calculateBudget(change(lent, { baseAmountMinor: 1, baseCurrency: "RUB", rate: { baseMinor: 1, quoteMinor: 1 } }))).toThrow(/moves a debt and must not carry baseAmountMinor/);
    expect(() => calculateMemberExpenses(change(lent, { toAmountMinor: 1 }))).toThrow(/moves a debt and must not carry toAmountMinor/);
    expect(() => calculateAnnualPlan(change(lent, { accountId: "missing" }), "2026-07", 12)).toThrow(/references unknown id missing/);
  });
});
