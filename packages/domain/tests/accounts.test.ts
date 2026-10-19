import { describe, expect, it } from "vitest";

import {
  accountReferences,
  accountsInOrder,
  AccountValidationError,
  archiveAccount,
  calculateAnnualPlan,
  calculateBudget,
  calculateHoldings,
  COLLECTION_LIMITS,
  createAccount,
  holdsPlans,
  isDisplayKey,
  makePlanningSeed,
  makeSeedBudget,
  MAX_SORT_ORDER,
  moveAccount,
  normalizeAccountName,
  restoreAccount,
  SEED_IDS,
  updateAccount,
  type Account,
  type AccountDraft,
  type BudgetState,
} from "../src/index.js";

const DOLLARS = "8b000000-0000-4000-8000-0000000000a1";
const CASH = "8b000000-0000-4000-8000-0000000000a2";
const SPARE = "8b000000-0000-4000-8000-0000000000a3";

const dollarsDraft: AccountDraft = { name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 50_000 };

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof AccountValidationError) return error.code;
    throw error;
  }
}

/** The seed with no operation, goal or plan: nothing names its accounts. */
function bare(): BudgetState {
  return { ...makeSeedBudget(), transactions: [], goals: [] };
}

describe("createAccount", () => {
  it("creates an active account at the end of the list, in any supported currency, and moves no figure", () => {
    const seed = makeSeedBudget();
    const { state, account } = createAccount(seed, { ...dollarsDraft, name: "  Доллары " }, () => DOLLARS);

    expect(account).toEqual({ id: DOLLARS, name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 50_000, active: true, sortOrder: 10 });
    expect(state.accounts.at(-1)).toBe(account);
    expect(accountsInOrder(state.accounts).at(-1)?.id).toBe(DOLLARS);
    // The budget counts in roubles and does not read a dollar account it has no operation on.
    expect(calculateBudget(state).expensesMinor).toBe(calculateBudget(seed).expensesMinor);
    expect(calculateBudget(state).capitalMinor).toBe(calculateBudget(seed).capitalMinor);
    // Holdings see it, and say it cannot be valued without a rate.
    expect(calculateHoldings(state, "2026-07-31").unvaluedAccountIds).toEqual([DOLLARS]);
  });

  it("stores display fields only when chosen, and «not in the total» only as false", () => {
    const { account } = createAccount(bare(), { ...dollarsDraft, icon: "banknote", color: "sage", includeInTotal: false }, () => DOLLARS);
    expect(account).toMatchObject({ icon: "banknote", color: "sage", includeInTotal: false });
    const counted = createAccount(bare(), { ...dollarsDraft, includeInTotal: true }, () => DOLLARS).account;
    expect(Object.hasOwn(counted, "includeInTotal")).toBe(false);
    expect(Object.hasOwn(counted, "icon")).toBe(false);
    expect(Object.hasOwn(counted, "color")).toBe(false);
  });

  it("refuses names the text rule refuses, unreadable ones and an active duplicate in any case", () => {
    const seed = makeSeedBudget();
    expect(code(() => createAccount(seed, { ...dollarsDraft, name: "   " }, () => DOLLARS))).toBe("name_required");
    expect(code(() => createAccount(seed, { ...dollarsDraft, name: "я".repeat(81) }, () => DOLLARS))).toBe("name_too_long");
    expect(code(() => createAccount(seed, { ...dollarsDraft, name: "Нал\u200Bичные" }, () => DOLLARS))).toBe("name_forbidden_characters");
    expect(code(() => createAccount(seed, { ...dollarsDraft, name: "Кaрта" }, () => DOLLARS))).toBe("name_mixed_scripts");
    expect(code(() => createAccount(seed, { ...dollarsDraft, name: "—" }, () => DOLLARS))).toBe("name_unreadable");
    const main = seed.accounts.find((item) => item.id === SEED_IDS.accounts.main)!;
    expect(code(() => createAccount(seed, { ...dollarsDraft, name: main.name.toUpperCase() }, () => DOLLARS))).toBe("duplicate_name");
    expect(normalizeAccountName("Карта́ ".normalize("NFD"))).toBe("Карта́".normalize("NFC"));
    // An archived namesake is not a duplicate: the interface offers it back instead.
    const archived = archiveAccount(seed, main.id);
    expect(createAccount(archived, { ...dollarsDraft, name: main.name }, () => DOLLARS).account.name).toBe(main.name);
  });

  it("refuses an unknown kind or currency, an opening balance past the field ceiling and display keys that are not keys", () => {
    const seed = makeSeedBudget();
    expect(code(() => createAccount(seed, { ...dollarsDraft, type: "crypto" as never }, () => DOLLARS))).toBe("unknown_type");
    expect(code(() => createAccount(seed, { ...dollarsDraft, currency: "XAU" }, () => DOLLARS))).toBe("unknown_currency");
    expect(code(() => createAccount(seed, { ...dollarsDraft, currency: "toString" }, () => DOLLARS))).toBe("unknown_currency");
    expect(code(() => createAccount(seed, { ...dollarsDraft, openingBalanceMinor: 10 ** 10 + 1 }, () => DOLLARS))).toBe("invalid_opening_balance");
    expect(code(() => createAccount(seed, { ...dollarsDraft, openingBalanceMinor: 0.5 }, () => DOLLARS))).toBe("invalid_opening_balance");
    // A card in debt starts below zero, down to the same ceiling.
    expect(createAccount(seed, { ...dollarsDraft, openingBalanceMinor: -(10 ** 10) }, () => DOLLARS).account.openingBalanceMinor).toBe(-(10 ** 10));
    for (const key of ["#ff0000", "Sage", "constructor", "prototype", "a".repeat(41), "icon.svg", ""]) {
      expect(isDisplayKey(key), key).toBe(false);
      expect(code(() => createAccount(seed, { ...dollarsDraft, icon: key }, () => DOLLARS)), key).toBe("invalid_icon");
      expect(code(() => createAccount(seed, { ...dollarsDraft, color: key }, () => DOLLARS)), key).toBe("invalid_color");
    }
    expect(isDisplayKey("credit-card")).toBe(true);
    expect(code(() => createAccount(seed, { ...dollarsDraft, includeInTotal: "yes" as never }, () => DOLLARS))).toBe("invalid_include_in_total");
  });

  it("refuses an identifier that is not a UUID or is taken anywhere in the document, and the account past the limit", () => {
    const seed = makeSeedBudget();
    expect(code(() => createAccount(seed, dollarsDraft, () => "account-1"))).toBe("id_required");
    expect(code(() => createAccount(seed, dollarsDraft, () => SEED_IDS.transactions.food))).toBe("duplicate_id");
    const full: BudgetState = {
      ...seed,
      accounts: Array.from({ length: COLLECTION_LIMITS.accounts }, (_, index) => ({
        id: `8b000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        name: `Счёт ${index}`,
        type: "current" as const,
        currency: "RUB",
        openingBalanceMinor: 0,
        active: index > 0,
      })),
      transactions: [],
      goals: [],
    };
    expect(code(() => createAccount(full, dollarsDraft, () => DOLLARS))).toBe("limit_reached");
  });

  it("never writes a position past the shared bound: a list near it is numbered afresh in its order", () => {
    const seed = bare();
    const crowded: BudgetState = {
      ...seed,
      accounts: seed.accounts.map((account, index) => ({ ...account, sortOrder: MAX_SORT_ORDER - 5 + index })),
    };
    const before = accountsInOrder(crowded.accounts).map((account) => account.id);
    const { state, account } = createAccount(crowded, dollarsDraft, () => DOLLARS);
    for (const item of state.accounts) expect(Math.abs(item.sortOrder ?? 0)).toBeLessThanOrEqual(MAX_SORT_ORDER);
    expect(accountsInOrder(state.accounts).map((item) => item.id)).toEqual([...before, account.id]);
    expect(() => calculateBudget(state)).not.toThrow();
  });
});

describe("updateAccount", () => {
  it("renames, retypes, recolours and takes an account out of the total, and returns the same state for no change", () => {
    const seed = makeSeedBudget();
    const next = updateAccount(seed, SEED_IDS.accounts.main, { name: "Зарплатная", type: "cash", icon: "wallet", color: "mint", includeInTotal: false });
    expect(next.accounts.find((item) => item.id === SEED_IDS.accounts.main)).toMatchObject({ name: "Зарплатная", type: "cash", icon: "wallet", color: "mint", includeInTotal: false });
    // Nothing the budget counts moved: operations name the account by identifier.
    expect(calculateBudget(next).accountBalancesMinor).toEqual(calculateBudget(seed).accountBalancesMinor);
    expect(updateAccount(seed, SEED_IDS.accounts.main, {})).toBe(seed);
    const main = seed.accounts.find((item) => item.id === SEED_IDS.accounts.main)!;
    expect(updateAccount(seed, SEED_IDS.accounts.main, { name: ` ${main.name} ` })).toBe(seed);
    // A cleared key and «back in the total» are absent fields again.
    const cleared = updateAccount(next, SEED_IDS.accounts.main, { icon: null, color: null, includeInTotal: true });
    const account = cleared.accounts.find((item) => item.id === SEED_IDS.accounts.main)!;
    for (const field of ["icon", "color", "includeInTotal"]) expect(Object.hasOwn(account, field), field).toBe(false);
  });

  it("refuses a name another active account carries, and lets an archived account keep a taken one", () => {
    const seed = makeSeedBudget();
    const savings = seed.accounts.find((item) => item.id === SEED_IDS.accounts.savings)!;
    expect(code(() => updateAccount(seed, SEED_IDS.accounts.main, { name: savings.name.toLowerCase() }))).toBe("duplicate_name");
    const archived = archiveAccount(seed, SEED_IDS.accounts.main);
    expect(updateAccount(archived, SEED_IDS.accounts.main, { name: savings.name }).accounts.find((item) => item.id === SEED_IDS.accounts.main)?.name).toBe(savings.name);
    expect(code(() => updateAccount(seed, DOLLARS, { name: "Ничей" }))).toBe("unknown_account");
  });

  it("changes the currency of an account nothing names", () => {
    const { state } = createAccount(makeSeedBudget(), dollarsDraft, () => DOLLARS);
    expect(accountReferences(state, DOLLARS)).toEqual([]);
    const euros = updateAccount(state, DOLLARS, { currency: "EUR" });
    expect(euros.accounts.find((item) => item.id === DOLLARS)?.currency).toBe("EUR");
    expect(() => calculateBudget(euros)).not.toThrow();
  });

  it("keeps the currency of an account operations or debt movements name — the amounts are counted in it", () => {
    const seed = makeSeedBudget();
    expect(accountReferences(seed, SEED_IDS.accounts.main)).toEqual(["operations"]);
    const refused = () => updateAccount(seed, SEED_IDS.accounts.main, { currency: "USD" });
    expect(code(refused)).toBe("currency_in_use");
    expect(refused).toThrow(/по счёту есть операции/u);
    // Everything else about the account still changes.
    expect(updateAccount(seed, SEED_IDS.accounts.main, { name: "Карта", openingBalanceMinor: 1_000 }).accounts.find((item) => item.id === SEED_IDS.accounts.main)).toMatchObject({ name: "Карта", currency: "RUB", openingBalanceMinor: 1_000 });

    const { state: withCash } = createAccount(bare(), { ...dollarsDraft, name: "Наличные", currency: "RUB" }, () => CASH);
    const lent: BudgetState = {
      ...withCash,
      debts: [{ id: SPARE, counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 0, active: true }],
      transactions: [{ id: "8b000000-0000-4000-8000-0000000000b1", kind: "debt_out", status: "posted", occurredOn: "2026-07-02", amountMinor: 10_000, accountId: CASH, debtId: SPARE }],
    };
    expect(accountReferences(lent, CASH)).toEqual(["debts"]);
    expect(code(() => updateAccount(lent, CASH, { currency: "USD" }))).toBe("currency_in_use");
  });

  it("keeps a goal's or a plan's account in the base currency (D-032), with words of its own", () => {
    const seed = { ...makeSeedBudget(), transactions: [] };
    expect(accountReferences(seed, SEED_IDS.accounts.savings)).toEqual(["goals"]);
    expect(holdsPlans(seed, seed.accounts.find((item) => item.id === SEED_IDS.accounts.savings)!)).toBe(true);
    const goal = () => updateAccount(seed, SEED_IDS.accounts.savings, { currency: "USD" });
    expect(code(goal)).toBe("base_currency_required");
    expect(goal).toThrow(/только в базовой валюте RUB/u);

    const planning = { ...makePlanningSeed(), transactions: [], goals: [] };
    const planned = planning.scheduledExpenses[0]!.accountId;
    expect(accountReferences(planning, planned)).toContain("plans");
    expect(code(() => updateAccount(planning, planned, { currency: "EUR" }))).toBe("base_currency_required");
    expect(() => calculateAnnualPlan(planning, "2026-07", 12)).not.toThrow();
    expect(holdsPlans(planning, { currency: "USD" })).toBe(false);
  });

  it("names a recurring rule's account as in use: its amounts are counted in the account's currency", () => {
    const { state } = createAccount(bare(), dollarsDraft, () => DOLLARS);
    const ruled: BudgetState = {
      ...state,
      recurringRules: [{
        id: SPARE,
        template: { kind: "expense", amountMinor: 1_000, accountId: DOLLARS, categoryId: SEED_IDS.categories.food },
        frequency: "monthly",
        interval: 1,
        startDate: "2026-07-01",
        active: false,
      }],
    };
    expect(accountReferences(ruled, DOLLARS)).toEqual(["recurring"]);
    expect(code(() => updateAccount(ruled, DOLLARS, { currency: "EUR" }))).toBe("currency_in_use");
  });

  it("moves every balance of the account by the change of its opening balance, and nothing else", () => {
    const seed = makeSeedBudget();
    const before = calculateHoldings(seed, "2026-07-31");
    const next = updateAccount(seed, SEED_IDS.accounts.main, { openingBalanceMinor: (seed.accounts[0]!.openingBalanceMinor) + 5_000 });
    const after = calculateHoldings(next, "2026-07-31");
    expect(after.accountBalancesMinor[SEED_IDS.accounts.main]).toBe((before.accountBalancesMinor[SEED_IDS.accounts.main] ?? 0) + 5_000);
    expect(after.accountBalancesMinor[SEED_IDS.accounts.savings]).toBe(before.accountBalancesMinor[SEED_IDS.accounts.savings]);
    expect(calculateBudget(next).expensesMinor).toBe(calculateBudget(seed).expensesMinor);
  });
});

describe("archiveAccount and restoreAccount", () => {
  it("archives without losing history or a total, and restores — each twice is once", () => {
    const seed = makeSeedBudget();
    const archived = archiveAccount(seed, SEED_IDS.accounts.savings);
    expect(archived.accounts.find((item) => item.id === SEED_IDS.accounts.savings)?.active).toBe(false);
    expect(archiveAccount(archived, SEED_IDS.accounts.savings)).toBe(archived);
    expect(archived.transactions).toBe(seed.transactions);
    expect(calculateHoldings(archived, "2026-07-31").totalInBaseMinor).toBe(calculateHoldings(seed, "2026-07-31").totalInBaseMinor);
    const restored = restoreAccount(archived, SEED_IDS.accounts.savings);
    expect(restored.accounts).toEqual(seed.accounts);
    expect(restoreAccount(restored, SEED_IDS.accounts.savings)).toBe(restored);
    expect(code(() => archiveAccount(seed, DOLLARS))).toBe("unknown_account");
  });

  it("refuses to restore an account whose name an active one now carries", () => {
    const seed = makeSeedBudget();
    const main = seed.accounts.find((item) => item.id === SEED_IDS.accounts.main)!;
    const archived = archiveAccount(seed, main.id);
    const { state } = createAccount(archived, { ...dollarsDraft, name: main.name, currency: "RUB" }, () => DOLLARS);
    expect(code(() => restoreAccount(state, main.id))).toBe("duplicate_name");
  });
});

describe("moveAccount", () => {
  function three(): BudgetState {
    let state = bare();
    state = createAccount(state, { ...dollarsDraft, name: "Наличные", currency: "RUB" }, () => CASH).state;
    return state;
  }
  const order = (state: BudgetState) => accountsInOrder(state.accounts.filter((item) => item.active)).map((item) => item.id);

  it("swaps two neighbours and changes only those two; at either end nothing moves", () => {
    const legacy = three();
    // The seed's accounts carry no position: the first move spreads them apart once, in order.
    expect(legacy.accounts.slice(0, 2).every((item) => item.sortOrder === undefined)).toBe(true);
    const start = order(legacy);
    const moved = moveAccount(legacy, start[1]!, "up");
    expect(order(moved)).toEqual([start[1], start[0], start[2]]);
    for (const item of moved.accounts) expect(Math.abs(item.sortOrder ?? 0)).toBeLessThanOrEqual(MAX_SORT_ORDER);

    const again = moveAccount(moved, start[1]!, "down");
    expect(order(again)).toEqual(start);
    const changed = again.accounts.filter((item, index) => item !== moved.accounts[index]).map((item) => item.id);
    expect(changed.sort()).toEqual([start[0], start[1]].sort());

    expect(moveAccount(again, start[0]!, "up")).toBe(again);
    expect(moveAccount(again, start[2]!, "down")).toBe(again);
  });

  it("moves among the active accounts only; an archived one stays where it was", () => {
    const state = archiveAccount(three(), SEED_IDS.accounts.savings);
    const start = order(state);
    expect(start).not.toContain(SEED_IDS.accounts.savings);
    expect(order(moveAccount(state, start[1]!, "up"))).toEqual([start[1], start[0]]);
    expect(moveAccount(state, SEED_IDS.accounts.savings, "up")).toBe(state);
  });

  it("keeps positions within the shared bound when ties sit at its edge", () => {
    const state = three();
    const edge: BudgetState = { ...state, accounts: state.accounts.map((account) => ({ ...account, sortOrder: MAX_SORT_ORDER })) };
    expect(code(() => moveAccount(edge, CASH, "up"))).toBe("sort_order_overflow");
    const spread: BudgetState = { ...state, accounts: state.accounts.map((account, index) => ({ ...account, sortOrder: MAX_SORT_ORDER - 2 + index })) };
    const moved = moveAccount(spread, CASH, "up");
    for (const item of moved.accounts) expect(item.sortOrder).toBeLessThanOrEqual(MAX_SORT_ORDER);
  });

  it("is a transition of whole accounts: the result is a state every calculation accepts", () => {
    const moved: BudgetState = moveAccount(three(), CASH, "up");
    expect(() => calculateBudget(moved)).not.toThrow();
    const account: Account | undefined = moved.accounts.find((item) => item.id === CASH);
    expect(account?.active).toBe(true);
  });
});
