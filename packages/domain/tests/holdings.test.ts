import { describe, expect, it } from "vitest";

import {
  calculateBudget,
  calculateDebts,
  calculateHoldings,
  makeSeedBudget,
  SEED_IDS,
  type Account,
  type BudgetState,
  type Debt,
  type DebtMetrics,
  type ExchangeRate,
  type Transaction,
} from "../src/index.js";

const AUGUST = "44444444-4444-4444-8444-4444444444a8";
const DOLLARS = "8c000000-0000-4000-8000-0000000000c2";
const MAIN = SEED_IDS.accounts.main;
const SAVINGS = SEED_IDS.accounts.savings;

const DOLLAR_ACCOUNT: Account = { id: DOLLARS, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true };
const RATES: readonly ExchangeRate[] = [
  { id: "8e000000-0000-4000-8000-000000000001", currency: "USD", baseCurrency: "RUB", date: "2026-07-31", rate: { baseMinor: 9_000, quoteMinor: 100 } },
  { id: "8e000000-0000-4000-8000-000000000002", currency: "USD", baseCurrency: "RUB", date: "2026-08-15", rate: { baseMinor: 9_250, quoteMinor: 100 } },
];

/** The seed with an empty August budget made active: July's operations are outside its window. */
function inAugust(state: BudgetState = makeSeedBudget()): BudgetState {
  return {
    ...state,
    activeBudgetId: AUGUST,
    budgets: [...state.budgets, { id: AUGUST, startDate: "2026-08-01", endDate: "2026-08-31", status: "open", plannedIncomeMinor: 0, warningThreshold: 0.8, lines: [] }],
  };
}

function withTransactions(state: BudgetState, ...transactions: Transaction[]): BudgetState {
  return { ...state, transactions: [...state.transactions, ...transactions] };
}

function withDollars(state: BudgetState = makeSeedBudget(), rates: readonly ExchangeRate[] = RATES): BudgetState {
  return { ...state, accounts: [...state.accounts, DOLLAR_ACCOUNT], exchangeRates: rates };
}

describe("calculateHoldings", () => {
  it("counts a July operation in August's holdings, and not in August's budget", () => {
    const state = inAugust();
    // July: 100 000 ₽ of income, 76 500 ₽ spent, 10 000 ₽ put aside for the goal.
    expect(calculateBudget(state).accountBalancesMinor[MAIN]).toBe(0);
    const holdings = calculateHoldings(state, "2026-08-31");
    expect(holdings.accountBalancesMinor).toEqual({ [MAIN]: 1_350_000, [SAVINGS]: 1_000_000 });
    expect(holdings.accountBalancesInBaseMinor).toEqual({ [MAIN]: 1_350_000, [SAVINGS]: 1_000_000 });
    expect(holdings.totalInBaseMinor).toBe(2_350_000);
    expect(holdings.netWorthInBaseMinor).toBe(2_350_000);
    expect(holdings.unvaluedAccountIds).toEqual([]);
    expect(holdings).toMatchObject({ asOf: "2026-08-31", baseCurrency: "RUB" });
    // On the last day of July it is July's own balance.
    expect(calculateHoldings(makeSeedBudget(), "2026-07-31").accountBalancesMinor[MAIN])
      .toBe(calculateBudget(makeSeedBudget()).accountBalancesMinor[MAIN]);
  });

  it("counts only what is posted and has happened by the day", () => {
    const later: Transaction = { id: "55555555-5555-4555-8555-5555555555a1", occurredOn: "2026-09-01", status: "posted", kind: "expense", amountMinor: 100_000, accountId: MAIN, categoryId: SEED_IDS.categories.food };
    const pending: Transaction = { ...later, id: "55555555-5555-4555-8555-5555555555a2", occurredOn: "2026-07-20", status: "pending" };
    const draft: Transaction = { ...later, id: "55555555-5555-4555-8555-5555555555a3", occurredOn: "2026-07-21", status: "draft" };
    const state = withTransactions(inAugust(), later, pending, draft);
    expect(calculateHoldings(state, "2026-08-31").accountBalancesMinor[MAIN]).toBe(1_350_000);
    expect(calculateHoldings(state, "2026-09-01").accountBalancesMinor[MAIN]).toBe(1_250_000);
    // Before anything happened, an account holds its opening balance.
    expect(calculateHoldings(state, "2026-06-30").accountBalancesMinor).toEqual({ [MAIN]: 0, [SAVINGS]: 0 });
  });

  it("values a foreign account at the latest rate on or before the day, and says when it cannot", () => {
    const transfer: Transaction = {
      id: "55555555-5555-4555-8555-5555555555b1", occurredOn: "2026-07-20", status: "posted", kind: "transfer",
      amountMinor: 1_000_000, fromAccountId: MAIN, toAccountId: DOLLARS, toAmountMinor: 11_000,
    };
    const state = withTransactions(withDollars(inAugust()), transfer);

    const august = calculateHoldings(state, "2026-08-31");
    expect(august.accountBalancesMinor[DOLLARS]).toBe(61_000);
    expect(august.accountBalancesMinor[MAIN]).toBe(350_000);
    // 610 $ at 92,50 ₽.
    expect(august.accountBalancesInBaseMinor[DOLLARS]).toBe(5_642_500);
    expect(august.totalInBaseMinor).toBe(350_000 + 1_000_000 + 5_642_500);
    // At 90 ₽ before the August rate.
    expect(calculateHoldings(state, "2026-08-14").accountBalancesInBaseMinor[DOLLARS]).toBe(5_490_000);

    // No rate yet on 30 July: the dollars are held, listed and left out of the total.
    const early = calculateHoldings(state, "2026-07-30");
    expect(early.accountBalancesMinor[DOLLARS]).toBe(61_000);
    expect(early.accountBalancesInBaseMinor[DOLLARS]).toBeNull();
    expect(early.unvaluedAccountIds).toEqual([DOLLARS]);
    expect(early.totalInBaseMinor).toBe(350_000 + 1_000_000);
  });

  it("leaves an account out of the total when the family asks, and still values it", () => {
    const seed = inAugust();
    const state = { ...seed, accounts: seed.accounts.map((item) => (item.id === SAVINGS ? { ...item, includeInTotal: false } : item)) };
    const holdings = calculateHoldings(state, "2026-08-31");
    expect(holdings.accountBalancesInBaseMinor[SAVINGS]).toBe(1_000_000);
    expect(holdings.unvaluedAccountIds).toEqual([]);
    expect(holdings.totalInBaseMinor).toBe(1_350_000);
    // capitalMinor does not read the flag.
    expect(calculateBudget({ ...state, activeBudgetId: SEED_IDS.budget }).capitalMinor).toBe(calculateBudget(makeSeedBudget()).capitalMinor);
  });

  it("counts archived accounts: archiving spends nothing", () => {
    const seed = inAugust();
    const state = { ...seed, accounts: seed.accounts.map((item) => (item.id === SAVINGS ? { ...item, active: false } : item)) };
    expect(calculateHoldings(state, "2026-08-31").totalInBaseMinor).toBe(2_350_000);
  });

  it("adds the debts on the same day, at the same rates, and nets them", () => {
    const state: BudgetState = {
      ...withDollars(inAugust()),
      debts: [
        { id: "8f100000-0000-4000-8000-0000000000d1", counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 300_000, active: false },
        { id: "8f100000-0000-4000-8000-0000000000d2", counterparty: "Сергей", direction: "i_owe", currency: "USD", openingMinor: 5_000, active: true },
      ],
    };
    const holdings = calculateHoldings(state, "2026-08-31");
    expect(holdings.debts).toEqual(calculateDebts(state, "2026-08-31"));
    expect(holdings.debts.receivableInBaseMinor).toBe(300_000);
    expect(holdings.debts.payableInBaseMinor).toBe(462_500);
    expect(holdings.netWorthInBaseMinor).toBe(holdings.totalInBaseMinor + 300_000 - 462_500);
  });

  it("values at null instead of throwing when a sum cannot be represented", () => {
    // A rate a field allows, at which 500 $ is worth more than any safe integer.
    const steep = withDollars(inAugust(), [{ ...RATES[0]!, rate: { baseMinor: 10 ** 12, quoteMinor: 1 } }]);
    const unrepresentable = calculateHoldings(steep, "2026-08-31");
    expect(unrepresentable.accountBalancesInBaseMinor[DOLLARS]).toBeNull();
    expect(unrepresentable.unvaluedAccountIds).toEqual([DOLLARS]);
    expect(unrepresentable.totalInBaseMinor).toBe(2_350_000);

    // Two balances each within range whose total is not: the second is not valued either.
    const seed = makeSeedBudget();
    const huge = Number.MAX_SAFE_INTEGER - 1_000;
    const rich: BudgetState = {
      ...seed,
      accounts: [...seed.accounts, { id: "8c000000-0000-4000-8000-0000000000c3", name: "Сейф", type: "cash", currency: "RUB", openingBalanceMinor: huge, active: true }],
    };
    const capped = calculateHoldings(rich, "2026-06-30");
    expect(capped.accountBalancesMinor["8c000000-0000-4000-8000-0000000000c3"]).toBe(huge);
    expect(capped.totalInBaseMinor).toBe(huge);
    expect(capped.unvaluedAccountIds).toEqual([]);
    const twice: BudgetState = { ...rich, accounts: rich.accounts.map((item) => (item.id === MAIN ? { ...item, openingBalanceMinor: huge } : item)) };
    const overflow = calculateHoldings(twice, "2026-06-30");
    expect(overflow.totalInBaseMinor).toBe(huge);
    expect(overflow.unvaluedAccountIds).toEqual(["8c000000-0000-4000-8000-0000000000c3"]);

    // A net worth past the safe range is null, not a rounded number.
    const owed: BudgetState = { ...rich, debts: [{ id: "8f100000-0000-4000-8000-0000000000d1", counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 10_000_000_000, active: true }] };
    expect(calculateHoldings(owed, "2026-06-30").netWorthInBaseMinor).toBeNull();

    // An account whose own balance leaves the range is not valued, and nothing throws.
    const income = (id: string, occurredOn: string): Transaction => ({ id, occurredOn, status: "posted", kind: "income", amountMinor: 5_000_000_000_000_000, accountId: MAIN });
    const runaway = withTransactions(seed, income("55555555-5555-4555-8555-5555555555c1", "2026-05-01"), income("55555555-5555-4555-8555-5555555555c2", "2026-06-01"));
    const lost = calculateHoldings(runaway, "2026-06-30");
    expect(lost.accountBalancesMinor[MAIN]).toBeNull();
    expect(lost.accountBalancesInBaseMinor[MAIN]).toBeNull();
    expect(lost.unvaluedAccountIds).toEqual([MAIN]);
  });

  it("refuses a day that is not one, and a state the domain refuses", () => {
    expect(() => calculateHoldings(makeSeedBudget(), "2026-02-30")).toThrow(/asOf/);
    const dangling = withTransactions(makeSeedBudget(), { id: "55555555-5555-4555-8555-5555555555d1", occurredOn: "2026-07-01", status: "posted", kind: "income", amountMinor: 1, accountId: "8c000000-0000-4000-8000-0000000000ff" });
    expect(() => calculateHoldings(dangling, "2026-07-31")).toThrow(/references unknown id/);
  });
});

describe("holdings at scale", () => {
  it("reuses the debts the caller already has, and only those of the same day", () => {
    const state = withDollars(inAugust());
    const debts = calculateDebts(state, "2026-08-31");
    const marked: DebtMetrics = { ...debts, unvaluedDebtIds: ["marker"] };
    expect(calculateHoldings(state, "2026-08-31", { debts: marked }).debts).toBe(marked);
    // Another day's debts would be another day's figures: they are recomputed instead.
    expect(calculateHoldings(state, "2026-08-30", { debts: marked }).debts).toEqual(calculateDebts(state, "2026-08-30"));
  });

  it("values twenty thousand debts against twenty thousand rates in well under a second", () => {
    // The security review measured 5.9 s a call here, with every lookup a pass over every rate.
    // Counts the journal reports and does not refuse (collection_limit), so a family can hold them.
    const currencies = ["USD", "EUR", "CNY", "KZT", "GBP"];
    const rates: ExchangeRate[] = Array.from({ length: 20_000 }, (_, index) => ({
      id: `8e000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      currency: currencies[index % currencies.length]!,
      baseCurrency: "RUB",
      date: `20${String(10 + (index % 16)).padStart(2, "0")}-${String(1 + (index % 12)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}`,
      rate: { baseMinor: 9_000 + (index % 500), quoteMinor: 100 },
    }));
    const debts: Debt[] = Array.from({ length: 20_000 }, (_, index) => ({
      id: `8f100000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      counterparty: `Должник ${index}`,
      direction: index % 2 === 0 ? "owed_to_me" : "i_owe",
      currency: currencies[index % currencies.length]!,
      openingMinor: 1_000 + index,
      active: true,
    }));
    const accounts = currencies.map((currency, index): Account => ({
      id: `8c000000-0000-4000-8000-${String(index).padStart(12, "0")}`, name: currency, type: "savings", currency, openingBalanceMinor: 50_000, active: true,
    }));
    const seed = makeSeedBudget();
    const state: BudgetState = { ...seed, accounts: [...seed.accounts, ...accounts], exchangeRates: rates, debts };

    const started = performance.now();
    const holdings = calculateHoldings(state, "2026-08-31");
    const elapsed = performance.now() - started;

    expect(holdings.debts.unvaluedDebtIds).toEqual([]);
    expect(holdings.unvaluedAccountIds).toEqual([]);
    expect(holdings.debts.debts).toHaveLength(20_000);
    // Generous on purpose: it measures the shape of the work, not the machine it runs on.
    expect(elapsed).toBeLessThan(1_000);
  }, 60_000);
});
