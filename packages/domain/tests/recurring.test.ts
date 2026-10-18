import { describe, expect, it } from "vitest";

import {
  addDays,
  archiveRecurringRule,
  calculateAnnualPlan,
  calculateBudget,
  calculateMemberExpenses,
  COLLECTION_LIMITS,
  dayIndex,
  DEFAULT_MAX_CONSIDERED_DAYS_PER_CALL,
  DEFAULT_MAX_OCCURRENCES_PER_CALL,
  DEFAULT_MAX_OCCURRENCES_PER_RULE,
  deleteRecurringRule,
  documentIds,
  isUuid,
  makeSeedBudget,
  materializeRecurring,
  MAX_MONEY_MINOR,
  MAX_RECURRENCE_INTERVAL,
  occurrenceDates,
  recurringOccurrenceId,
  SEED_IDS,
  shiftDate,
  type Account,
  type BudgetState,
  type ExchangeRate,
  type RecurringRule,
  type RecurringTemplate,
  type Transaction,
} from "../src/index.js";

const RULE = "8b000000-0000-4000-8000-000000000001";
const OTHER_RULE = "8b000000-0000-4000-8000-000000000002";
const HOME = "8a000000-0000-4000-8000-0000000000a2";
const DOLLARS = "8c000000-0000-4000-8000-0000000000c2";
const SALARY = "8d000000-0000-4000-8000-0000000000c3";
const RATE_JULY = "8e000000-0000-4000-8000-000000000001";
const RATE_AUGUST = "8e000000-0000-4000-8000-000000000002";

/** The water delivery of G-003: 1 500 ₽ every two weeks from 4 August, onto «Продукты». */
function waterRule(overrides: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: RULE,
    name: "Доставка воды",
    template: {
      kind: "expense",
      amountMinor: 150_000,
      accountId: SEED_IDS.accounts.main,
      categoryId: SEED_IDS.categories.food,
      note: "Доставка воды",
      tagIds: [HOME],
    },
    frequency: "weekly",
    interval: 2,
    startDate: "2026-08-04",
    active: true,
    ...overrides,
  };
}

const DOLLAR_ACCOUNT: Account = { id: DOLLARS, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true };

function rate(id: string, date: string, baseMinor: number, quoteMinor = 100): ExchangeRate {
  return { id, currency: "USD", baseCurrency: "RUB", date, rate: { baseMinor, quoteMinor } };
}

/** The seed with a tag, a dollar account, an income category and the given rules. */
function withRules(rules: readonly RecurringRule[], change: Partial<BudgetState> = {}): BudgetState {
  const seed = makeSeedBudget();
  return {
    ...seed,
    tags: [{ id: HOME, name: "Дом", active: true }],
    accounts: [...seed.accounts, DOLLAR_ACCOUNT],
    categories: [...seed.categories, { id: SALARY, name: "Зарплата", type: "income", group: "income", active: true, sortOrder: 40 }],
    recurringRules: rules,
    ...change,
  };
}

function created(state: BudgetState, through: string): Transaction[] {
  return [...materializeRecurring(state, through).created];
}

function datesOf(transactions: readonly Transaction[]): string[] {
  return transactions.map((transaction) => transaction.occurredOn);
}

function ruleOf(state: BudgetState, id = RULE): RecurringRule {
  return state.recurringRules!.find((rule) => rule.id === id)!;
}

describe("occurrenceDates", () => {
  const rule = (frequency: RecurringRule["frequency"], interval: number, startDate: string, endDate?: string) =>
    ({ frequency, interval, startDate, ...(endDate === undefined ? {} : { endDate }) });

  it("counts days and weeks from the start", () => {
    expect(occurrenceDates(rule("daily", 1, "2026-07-30"), "2026-07-29", "2026-08-02"))
      .toEqual(["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
    expect(occurrenceDates(rule("daily", 3, "2026-07-30"), "2026-07-30", "2026-08-08"))
      .toEqual(["2026-08-02", "2026-08-05", "2026-08-08"]);
    expect(occurrenceDates(rule("weekly", 2, "2026-08-04"), "2026-08-03", "2026-08-31")).toEqual(["2026-08-04", "2026-08-18"]);
    expect(occurrenceDates(rule("weekly", 2, "2026-08-04"), "2026-08-04", "2026-08-31")).toEqual(["2026-08-18"]);
    expect(occurrenceDates(rule("weekly", 1, "2026-12-28"), "2026-12-27", "2027-01-11"))
      .toEqual(["2026-12-28", "2027-01-04", "2027-01-11"]);
  });

  it("counts every month from the start date, so the 31st does not drift to the 28th", () => {
    expect(occurrenceDates(rule("monthly", 1, "2027-01-31"), "2027-01-30", "2027-05-31"))
      .toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
    // Asked from inside the clipped month, the clipped day is still found.
    expect(occurrenceDates(rule("monthly", 1, "2027-01-31"), "2027-02-27", "2027-03-31")).toEqual(["2027-02-28", "2027-03-31"]);
    expect(occurrenceDates(rule("monthly", 1, "2027-01-31"), "2027-02-28", "2027-03-31")).toEqual(["2027-03-31"]);
    expect(occurrenceDates(rule("monthly", 3, "2026-01-15"), "2026-01-14", "2026-12-31"))
      .toEqual(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"]);
  });

  it("falls on 28 February in a common year and on the 29th again in a leap one", () => {
    expect(occurrenceDates(rule("yearly", 1, "2024-02-29"), "2024-02-28", "2029-03-01"))
      .toEqual(["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29", "2029-02-28"]);
    expect(occurrenceDates(rule("yearly", 4, "2096-02-29"), "2096-02-28", "2108-12-31"))
      // 2100 is not a leap year.
      .toEqual(["2096-02-29", "2100-02-28", "2104-02-29", "2108-02-29"]);
  });

  it("includes the end date and stops there", () => {
    expect(occurrenceDates(rule("weekly", 1, "2026-08-04", "2026-08-18"), "2026-08-03", "2026-08-31"))
      .toEqual(["2026-08-04", "2026-08-11", "2026-08-18"]);
    expect(occurrenceDates(rule("weekly", 1, "2026-08-04", "2026-08-17"), "2026-08-03", "2026-08-31"))
      .toEqual(["2026-08-04", "2026-08-11"]);
    expect(occurrenceDates(rule("daily", 1, "2026-08-04", "2026-08-04"), "2026-08-03", "2026-08-31")).toEqual(["2026-08-04"]);
  });

  it("gives nothing before the start, after the end, or for an empty window, and at most the limit", () => {
    expect(occurrenceDates(rule("daily", 1, "2026-08-04"), "2026-07-01", "2026-08-03")).toEqual([]);
    expect(occurrenceDates(rule("daily", 1, "2026-08-04", "2026-08-10"), "2026-08-10", "2026-08-31")).toEqual([]);
    expect(occurrenceDates(rule("daily", 1, "2026-08-04"), "2026-08-20", "2026-08-20")).toEqual([]);
    expect(occurrenceDates(rule("daily", 1, "2026-08-04"), "2026-08-03", "2026-08-31", 2)).toEqual(["2026-08-04", "2026-08-05"]);
  });

  it("agrees with counting every occurrence from the start, wherever the window begins", () => {
    const cases = [
      rule("daily", 1, "2026-01-31"),
      rule("daily", 5, "2026-01-31"),
      rule("weekly", 3, "2026-01-31"),
      rule("monthly", 1, "2026-01-31"),
      rule("monthly", 2, "2026-01-30"),
      rule("yearly", 1, "2024-02-29"),
    ];
    for (const item of cases) {
      const all: string[] = [];
      for (let k = 0; all.length < 60; k += 1) {
        const step = item.interval * (item.frequency === "weekly" ? 7 : 1);
        if (item.frequency === "daily" || item.frequency === "weekly") all.push(addDays(item.startDate, k * step));
        else all.push(shiftDate(item.startDate, k * item.interval * (item.frequency === "yearly" ? 12 : 1)));
      }
      const through = all.at(-1)!;
      for (let offset = -3; offset < 140; offset += 1) {
        const after = addDays(item.startDate, offset);
        expect(occurrenceDates(item, after, through), `${JSON.stringify(item)} after ${after}`)
          .toEqual(all.filter((date) => date > after));
      }
    }
  });
});

describe("materializeRecurring", () => {
  it("writes ordinary posted operations under derived identifiers and closes the days it covered", () => {
    const state = withRules([waterRule()]);
    const result = materializeRecurring(state, "2026-08-31");

    expect(result.skipped).toEqual([]);
    expect(result.created).toEqual([
      {
        id: recurringOccurrenceId(RULE, "2026-08-04"), occurredOn: "2026-08-04", status: "posted", kind: "expense", amountMinor: 150_000,
        accountId: SEED_IDS.accounts.main, categoryId: SEED_IDS.categories.food, note: "Доставка воды", tagIds: [HOME], recurringRuleId: RULE,
      },
      {
        id: recurringOccurrenceId(RULE, "2026-08-18"), occurredOn: "2026-08-18", status: "posted", kind: "expense", amountMinor: 150_000,
        accountId: SEED_IDS.accounts.main, categoryId: SEED_IDS.categories.food, note: "Доставка воды", tagIds: [HOME], recurringRuleId: RULE,
      },
    ]);
    expect(result.created.every((transaction) => isUuid(transaction.id))).toBe(true);
    expect(result.state.transactions).toEqual([...state.transactions, ...result.created]);
    expect(ruleOf(result.state).materializedThrough).toBe("2026-08-31");
    expect(ruleOf(result.state)).toEqual({ ...waterRule(), materializedThrough: "2026-08-31" });
  });

  it("is idempotent: a second call writes nothing and returns the same state", () => {
    const first = materializeRecurring(withRules([waterRule()]), "2026-08-31").state;
    const second = materializeRecurring(first, "2026-08-31");
    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.state).toBe(first);
    // An earlier day than the watermark moves nothing either: the watermark never goes back.
    expect(materializeRecurring(first, "2026-08-10").state).toBe(first);
  });

  it("writes in steps what it writes at once", () => {
    const state = withRules([waterRule()]);
    const stepped = materializeRecurring(materializeRecurring(state, "2026-08-10").state, "2026-08-31");
    expect(datesOf(stepped.created)).toEqual(["2026-08-18"]);
    expect(stepped.state).toEqual(materializeRecurring(state, "2026-08-31").state);
  });

  it("does not bring back an occurrence the family deleted", () => {
    const materialized = materializeRecurring(withRules([waterRule()]), "2026-08-31").state;
    const deleted: BudgetState = {
      ...materialized,
      transactions: materialized.transactions.filter((transaction) => transaction.id !== recurringOccurrenceId(RULE, "2026-08-04")),
    };
    const later = materializeRecurring(deleted, "2026-09-30");
    expect(datesOf(later.created)).toEqual(["2026-09-01", "2026-09-15", "2026-09-29"]);
    expect(later.state.transactions.some((transaction) => transaction.occurredOn === "2026-08-04")).toBe(false);
  });

  it("writes the same operations on two devices that never met, so the journal meets each once", () => {
    const state = withRules([waterRule(), waterRule({ id: OTHER_RULE, frequency: "monthly", interval: 1, startDate: "2026-07-31" })]);
    const byId = (items: readonly Transaction[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
    const phone = materializeRecurring(state, "2026-09-30").state;
    const laptop = materializeRecurring(materializeRecurring(state, "2026-08-15").state, "2026-09-30").state;
    // The same operations and the same watermarks; only the order of the list may differ.
    expect(byId(laptop.transactions)).toEqual(byId(phone.transactions));
    expect(laptop.recurringRules).toEqual(phone.recurringRules);

    // The laptop has received the phone's August occurrences, but not its watermark: it skips
    // what it already holds and writes the rest under the same identifiers.
    const synced: BudgetState = {
      ...state,
      transactions: [...state.transactions, ...phone.transactions.filter((item) => item.occurredOn <= "2026-08-31" && item.recurringRuleId !== undefined)],
    };
    const caughtUp = materializeRecurring(synced, "2026-09-30");
    expect(caughtUp.created.every((transaction) => transaction.occurredOn > "2026-08-31")).toBe(true);
    expect(byId(caughtUp.state.transactions)).toEqual(byId(phone.transactions));
    expect(caughtUp.state.recurringRules).toEqual(phone.recurringRules);
  });

  it("counts its occurrences in every figure, like any other operation", () => {
    const july = withRules([waterRule({ startDate: "2026-07-07" })]);
    const before = calculateBudget(july);
    const after = calculateBudget(materializeRecurring(july, "2026-07-31").state);
    const food = SEED_IDS.categories.food;
    expect(after.categoryMetrics[food]!.expenseMinor).toBe(before.categoryMetrics[food]!.expenseMinor + 300_000);
    expect(after.expensesMinor).toBe(before.expensesMinor + 300_000);
    expect(after.accountBalancesMinor[SEED_IDS.accounts.main]).toBe(before.accountBalancesMinor[SEED_IDS.accounts.main]! - 300_000);
  });

  it("values a foreign occurrence at the rate of its own day", () => {
    const rule = waterRule({
      template: { kind: "expense", amountMinor: 4_000, accountId: DOLLARS, categoryId: SEED_IDS.categories.food },
      frequency: "weekly",
      interval: 1,
    });
    const state = withRules([rule], { exchangeRates: [rate(RATE_JULY, "2026-07-31", 9_000), rate(RATE_AUGUST, "2026-08-15", 9_250)] });
    const result = materializeRecurring(state, "2026-08-31");
    expect(result.created.map((item) => [item.occurredOn, item.kind === "expense" ? item.baseAmountMinor : null])).toEqual([
      ["2026-08-04", 360_000],
      ["2026-08-11", 360_000],
      ["2026-08-18", 370_000],
      ["2026-08-25", 370_000],
    ]);
    expect(result.created[2]).toMatchObject({ baseCurrency: "RUB", rate: { baseMinor: 9_250, quoteMinor: 100 } });
    // A rate entered later does not revalue an occurrence already written.
    const revalued = { ...result.state, exchangeRates: [...result.state.exchangeRates!, rate("8e000000-0000-4000-8000-000000000003", "2026-08-01", 1_000)] };
    expect(materializeRecurring(revalued, "2026-08-31").state).toBe(revalued);
    expect(calculateBudget(revalued)).toEqual(calculateBudget(result.state));
  });

  it("stops on a day with no usable rate and leaves the watermark on the day before", () => {
    const rule = waterRule({
      template: { kind: "expense", amountMinor: 4_000, accountId: DOLLARS, categoryId: SEED_IDS.categories.food },
      interval: 1,
    });
    // No rate before 15 August: the very first day stops the rule, and nothing moves.
    const early = withRules([rule], { exchangeRates: [rate(RATE_AUGUST, "2026-08-15", 9_250)] });
    const stopped = materializeRecurring(early, "2026-08-31");
    expect(stopped.created).toEqual([]);
    expect(stopped.skipped).toEqual([{ ruleId: RULE, from: "2026-08-04", to: "2026-08-04", reason: "missing_rate" }]);
    expect(stopped.state).toBe(early);

    // Once the rate is entered the same call writes every day, the stopped one included.
    const entered = { ...early, exchangeRates: [...early.exchangeRates!, rate(RATE_JULY, "2026-07-31", 9_000)] };
    expect(datesOf(created(entered, "2026-08-31"))).toEqual(["2026-08-04", "2026-08-11", "2026-08-18", "2026-08-25"]);

    // A rate that values the amount at nothing is no usable rate: the rule stops in the middle.
    const worthless = withRules([rule], {
      exchangeRates: [rate(RATE_JULY, "2026-07-31", 9_000), rate(RATE_AUGUST, "2026-08-15", 1, 1_000_000_000_000)],
    });
    const middle = materializeRecurring(worthless, "2026-08-31");
    expect(datesOf(middle.created)).toEqual(["2026-08-04", "2026-08-11"]);
    expect(middle.skipped).toEqual([{ ruleId: RULE, from: "2026-08-18", to: "2026-08-18", reason: "missing_rate" }]);
    expect(ruleOf(middle.state).materializedThrough).toBe("2026-08-17");
  });

  it("writes nothing for a rule that is stopped, and moves nothing", () => {
    const state = withRules([waterRule({ active: false })]);
    const result = materializeRecurring(state, "2026-08-31");
    expect(result).toEqual({ state, created: [], skipped: [] });
    expect(result.state).toBe(state);
  });

  it("passes over a day on an archived account or category, says so, and closes it", () => {
    const seed = withRules([waterRule()]);
    const archivedAccount = { ...seed, accounts: seed.accounts.map((item) => (item.id === SEED_IDS.accounts.main ? { ...item, active: false } : item)) };
    const onAccount = materializeRecurring(archivedAccount, "2026-08-31");
    expect(onAccount.created).toEqual([]);
    // Two days of the rule, passed over for one reason with nothing written between them: one run.
    expect(onAccount.skipped).toEqual([{ ruleId: RULE, from: "2026-08-04", to: "2026-08-18", reason: "archived_account" }]);
    expect(ruleOf(onAccount.state).materializedThrough).toBe("2026-08-31");
    expect(onAccount.state.transactions).toBe(archivedAccount.transactions);

    const archivedCategory = { ...seed, categories: seed.categories.map((item) => (item.id === SEED_IDS.categories.food ? { ...item, active: false } : item)) };
    expect(materializeRecurring(archivedCategory, "2026-08-31").skipped).toEqual([{ ruleId: RULE, from: "2026-08-04", to: "2026-08-18", reason: "archived_category" }]);

    const transfer = waterRule({ template: { kind: "transfer", amountMinor: 100_000, fromAccountId: SEED_IDS.accounts.main, toAccountId: SEED_IDS.accounts.savings } });
    const archivedTarget = withRules([transfer], {
      accounts: withRules([]).accounts.map((item) => (item.id === SEED_IDS.accounts.savings ? { ...item, active: false } : item)),
    });
    expect(materializeRecurring(archivedTarget, "2026-08-31").skipped.map((item) => item.reason)).toEqual(["archived_account"]);
  });

  it("writes at most maxPerRule occurrences of a rule in one call and the rest in the next", () => {
    const daily = waterRule({ frequency: "daily", interval: 1, startDate: "2026-01-01" });
    const state = withRules([daily]);
    const first = materializeRecurring(state, "2026-12-31", { maxPerRule: 100 });
    expect(first.created).toHaveLength(100);
    expect(first.created.at(-1)!.occurredOn).toBe("2026-04-10");
    expect(first.skipped).toEqual([{ ruleId: RULE, from: "2026-04-11", to: "2026-04-11", reason: "limit" }]);
    expect(ruleOf(first.state).materializedThrough).toBe("2026-04-10");
    const second = materializeRecurring(first.state, "2026-12-31", { maxPerRule: 100 });
    expect(second.created[0]!.occurredOn).toBe("2026-04-11");

    // Exactly the bound is no stop at all.
    const exact = materializeRecurring(state, "2026-01-05", { maxPerRule: 5 });
    expect(exact.created).toHaveLength(5);
    expect(exact.skipped).toEqual([]);
    expect(ruleOf(exact.state).materializedThrough).toBe("2026-01-05");

    const defaulted = materializeRecurring(withRules([waterRule({ frequency: "daily", interval: 1, startDate: "2025-01-01" })]), "2026-12-31");
    expect(defaulted.created).toHaveLength(DEFAULT_MAX_OCCURRENCES_PER_RULE);
    for (const maxPerRule of [0, -1, 1.5, Number.NaN]) {
      expect(() => materializeRecurring(state, "2026-12-31", { maxPerRule }), String(maxPerRule)).toThrow(/maxPerRule must be a positive integer/);
    }
  });

  it("passes over a derived identifier another entity already holds, says so, and never throws", () => {
    // A UUID of version 8 passes isUuid, so any device may plant an entity on the identifier a day of
    // the rule is derived to. Throwing on it threw on every device that holds the state.
    const id = recurringOccurrenceId(RULE, "2026-08-18");
    const state = withRules([waterRule()]);
    const taken = { ...state, tags: [...state.tags!, { id, name: "Совпадение", active: true }] };
    const result = materializeRecurring(taken, "2026-08-31");
    expect(datesOf(result.created)).toEqual(["2026-08-04"]);
    expect(result.skipped).toEqual([{ ruleId: RULE, from: "2026-08-18", to: "2026-08-18", reason: "id_conflict" }]);
    // The day can never be written, so it is closed like an archived one, and nothing is overwritten.
    expect(ruleOf(result.state).materializedThrough).toBe("2026-08-31");
    expect(result.state.tags).toEqual(taken.tags);
    expect(materializeRecurring(result.state, "2026-08-31").state).toBe(result.state);
  });

  it("does not write over an occurrence the family deleted, whatever the watermark says", () => {
    // A rule's watermark can go back — a concurrent edit of the rule wins with an older one — while
    // the journal keeps the delete of the occurrence for good. Written again, it would show on this
    // device alone; it is passed over and reported instead.
    const deleted = new Set([recurringOccurrenceId(RULE, "2026-08-04")]);
    const result = materializeRecurring(withRules([waterRule()]), "2026-08-31", { deletedIds: deleted });
    expect(datesOf(result.created)).toEqual(["2026-08-18"]);
    expect(result.skipped).toEqual([{ ruleId: RULE, from: "2026-08-04", to: "2026-08-04", reason: "deleted" }]);
    expect(ruleOf(result.state).materializedThrough).toBe("2026-08-31");
  });

  it("loses no occurrence when the days after the watermark are already written", () => {
    // The review's case: a daily rule from 1 January without a watermark, its first ten days written
    // already (by another device), and a bound of five. The list of days used to be cut to six before
    // anything was looked at, the ten written days were passed over without counting, and the
    // watermark jumped to 30 January: twenty occurrences gone for good.
    const daily = waterRule({ frequency: "daily", interval: 1, startDate: "2026-01-01" });
    const firstTen = materializeRecurring(withRules([daily]), "2026-01-10").created;
    const state = withRules([daily], { transactions: [...makeSeedBudget().transactions, ...firstTen] });
    expect(ruleOf(state).materializedThrough).toBeUndefined();

    const first = materializeRecurring(state, "2026-01-30", { maxPerRule: 5 });
    expect(datesOf(first.created)).toEqual(["2026-01-11", "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15"]);
    expect(first.skipped).toEqual([{ ruleId: RULE, from: "2026-01-16", to: "2026-01-16", reason: "limit" }]);
    expect(ruleOf(first.state).materializedThrough).toBe("2026-01-15");

    let current = first.state;
    for (let call = 0; call < 10; call += 1) current = materializeRecurring(current, "2026-01-30", { maxPerRule: 5 }).state;
    const days = current.transactions.filter((transaction) => transaction.recurringRuleId === RULE).map((transaction) => transaction.occurredOn);
    expect(days).toEqual(Array.from({ length: 30 }, (_, index) => `2026-01-${String(index + 1).padStart(2, "0")}`));
    expect(ruleOf(current).materializedThrough).toBe("2026-01-30");
  });

  it("bounds one call across all rules, with each rule's watermark where it stopped", () => {
    const daily = (index: number) => waterRule({ id: `8b100000-0000-4000-8000-${String(index).padStart(12, "0")}`, frequency: "daily", interval: 1, startDate: "2026-01-01" });
    const state = withRules([daily(1), daily(2), daily(3)]);
    const first = materializeRecurring(state, "2026-01-31", { maxTotal: 50 });
    expect(first.created).toHaveLength(50);
    expect(first.skipped).toEqual([
      { ruleId: daily(2).id, from: "2026-01-20", to: "2026-01-20", reason: "limit" },
      { ruleId: daily(3).id, from: "2026-01-01", to: "2026-01-01", reason: "limit" },
    ]);
    const marks = (value: BudgetState) => (value.recurringRules ?? []).map((rule) => rule.materializedThrough);
    // The first rule is done, the second stopped after nineteen days, the third did not start.
    expect(marks(first.state)).toEqual(["2026-01-31", "2026-01-19", undefined]);
    const second = materializeRecurring(first.state, "2026-01-31", { maxTotal: 50 });
    expect(second.created).toHaveLength(12 + 31);
    expect(second.skipped).toEqual([]);
    expect(marks(second.state)).toEqual(["2026-01-31", "2026-01-31", "2026-01-31"]);
    for (const maxTotal of [0, -1, 1.5]) {
      expect(() => materializeRecurring(state, "2026-01-31", { maxTotal }), String(maxTotal)).toThrow(/maxTotal must be a positive integer/);
    }
  });

  it("writes at most a thousand occurrences in one call by default, whatever the number of rules", () => {
    // Three hundred daily rules from 1900 used to be 120 000 operations in one call: more than one
    // batch of the journal and more operations than a backup may hold.
    const rules = Array.from({ length: 300 }, (_, index) =>
      waterRule({ id: `8b200000-0000-4000-8000-${String(index).padStart(12, "0")}`, frequency: "daily", interval: 1, startDate: "1900-01-01" }));
    const result = materializeRecurring(withRules(rules), "2026-08-31");
    expect(result.created).toHaveLength(DEFAULT_MAX_OCCURRENCES_PER_CALL);
    expect(DEFAULT_MAX_OCCURRENCES_PER_CALL).toBeLessThan(COLLECTION_LIMITS.transactions);
    expect(result.skipped.filter((item) => item.reason === "limit")).toHaveLength(300);
    // 400, 400 and 200 written, the rest not started: each watermark on the day before its stop.
    expect((result.state.recurringRules ?? []).slice(0, 4).map((rule) => rule.materializedThrough))
      .toEqual([addDays("1900-01-01", 399), addDays("1900-01-01", 399), addDays("1900-01-01", 199), undefined]);
  });

  it("considers at most twenty thousand days in one call, and reports days passed over as runs", () => {
    // Second review of wave 1, LOW-6, the exact case: ten daily rules from 1900 on an archived
    // account, one occurrence per rule and per call. Days passed over counted toward no bound, so the
    // call walked every day of every rule — 2.7 s and 462 640 entries, one per day.
    const rules = Array.from({ length: 10 }, (_, index) =>
      waterRule({ id: `8b300000-0000-4000-8000-${String(index).padStart(12, "0")}`, frequency: "daily", interval: 1, startDate: "1900-01-01" }));
    const seed = withRules(rules);
    const archived = { ...seed, accounts: seed.accounts.map((item) => (item.id === SEED_IDS.accounts.main ? { ...item, active: false } : item)) };

    const started = performance.now();
    const first = materializeRecurring(archived, "2026-08-31", { maxPerRule: 1, maxTotal: 1 });
    const elapsed = performance.now() - started;
    expect(first.created).toEqual([]);
    // One run for the first rule's twenty thousand archived days, then the bound: the first rule on
    // the day after, and every other rule on its first day.
    expect(first.skipped).toEqual([
      { ruleId: rules[0]!.id, from: "1900-01-01", to: addDays("1900-01-01", DEFAULT_MAX_CONSIDERED_DAYS_PER_CALL - 1), reason: "archived_account" },
      { ruleId: rules[0]!.id, from: addDays("1900-01-01", DEFAULT_MAX_CONSIDERED_DAYS_PER_CALL), to: addDays("1900-01-01", DEFAULT_MAX_CONSIDERED_DAYS_PER_CALL), reason: "limit" },
      ...rules.slice(1).map((rule) => ({ ruleId: rule.id, from: "1900-01-01", to: "1900-01-01", reason: "limit" })),
    ]);
    const marks = (value: BudgetState) => (value.recurringRules ?? []).map((rule) => rule.materializedThrough);
    // The watermark is the last day considered, so the next call goes on from there.
    expect(marks(first.state)).toEqual([addDays("1900-01-01", DEFAULT_MAX_CONSIDERED_DAYS_PER_CALL - 1), ...rules.slice(1).map(() => undefined)]);
    // Bounded in time: the old walk took 2.7 s on the reviewer's machine; this is a fifth of a run.
    expect(elapsed).toBeLessThan(1_500);

    // Call after call, every rule is walked to the end, and no day is skipped twice or left out.
    let current = first.state;
    let calls = 1;
    while ((current.recurringRules ?? []).some((rule) => rule.materializedThrough !== "2026-08-31")) {
      const next = materializeRecurring(current, "2026-08-31", { maxPerRule: 1, maxTotal: 1 });
      expect(next.skipped.length).toBeLessThanOrEqual(rules.length + 1);
      current = next.state;
      calls += 1;
      expect(calls).toBeLessThan(40);
    }
    const days = rules.length * (dayIndex("2026-08-31") - dayIndex("1900-01-01") + 1);
    expect(calls).toBe(Math.ceil(days / DEFAULT_MAX_CONSIDERED_DAYS_PER_CALL));
    expect(current.transactions).toBe(archived.transactions);

    // The bound is an option like the other two, and a day already written counts toward it too.
    const daily = waterRule({ frequency: "daily", interval: 1, startDate: "2026-01-01" });
    const written = materializeRecurring(withRules([daily]), "2026-01-10").created;
    const partly = withRules([daily], { transactions: [...makeSeedBudget().transactions, ...written] });
    const bounded = materializeRecurring(partly, "2026-01-31", { maxConsidered: 12 });
    expect(datesOf(bounded.created)).toEqual(["2026-01-11", "2026-01-12"]);
    expect(bounded.skipped).toEqual([{ ruleId: RULE, from: "2026-01-13", to: "2026-01-13", reason: "limit" }]);
    expect(ruleOf(bounded.state).materializedThrough).toBe("2026-01-12");
    for (const maxConsidered of [0, -1, 1.5, Number.NaN]) {
      expect(() => materializeRecurring(partly, "2026-01-31", { maxConsidered }), String(maxConsidered)).toThrow(/maxConsidered must be a positive integer/);
    }
  }, 60_000);

  it("closes a run of days passed over at a day written or found written, and at a change of reason", () => {
    const daily = waterRule({ frequency: "daily", interval: 1, startDate: "2026-01-01" });
    // 3 and 4 January deleted, 5 January written already, 6 and 7 deleted, 8 January taken by a tag.
    const deletedIds = new Set(["2026-01-03", "2026-01-04", "2026-01-06", "2026-01-07"].map((date) => recurringOccurrenceId(RULE, date)));
    const written = materializeRecurring(withRules([daily]), "2026-01-05").created.filter((item) => item.occurredOn === "2026-01-05");
    const base = withRules([daily], { transactions: [...makeSeedBudget().transactions, ...written] });
    const state = { ...base, tags: [...base.tags!, { id: recurringOccurrenceId(RULE, "2026-01-08"), name: "Совпадение", active: true }] };
    const result = materializeRecurring(state, "2026-01-09", { deletedIds });
    expect(datesOf(result.created)).toEqual(["2026-01-01", "2026-01-02", "2026-01-09"]);
    expect(result.skipped).toEqual([
      { ruleId: RULE, from: "2026-01-03", to: "2026-01-04", reason: "deleted" },
      { ruleId: RULE, from: "2026-01-06", to: "2026-01-07", reason: "deleted" },
      { ruleId: RULE, from: "2026-01-08", to: "2026-01-08", reason: "id_conflict" },
    ]);
  });

  it("writes no occurrence past the last day the journal carries", () => {
    const yearly = waterRule({ frequency: "yearly", interval: 1, startDate: "2190-03-01" });
    const result = materializeRecurring(withRules([yearly]), "2300-01-01");
    expect(datesOf(result.created).at(-1)).toBe("2199-03-01");
    expect(result.created).toHaveLength(10);
    expect(ruleOf(result.state).materializedThrough).toBe("2199-12-31");
  });

  it("credits an occurrence to no participant: the rule wrote it, not the device that materialised it", () => {
    const state = withRules([waterRule()], { members: [{ id: "8f200000-0000-4000-8000-000000000001", name: "Анна", role: "owner", active: true }] });
    const result = materializeRecurring(state, "2026-08-31");
    expect(result.created).toHaveLength(2);
    expect(result.created.every((transaction) => !("memberId" in transaction))).toBe(true);
    expect(() => calculateMemberExpenses(result.state)).not.toThrow();
  });

  it("writes income and transfers too, with the template's own fields", () => {
    const salary = waterRule({
      id: OTHER_RULE,
      template: { kind: "income", amountMinor: 12_000_000, accountId: SEED_IDS.accounts.main, categoryId: SALARY },
      frequency: "monthly",
      interval: 1,
      startDate: "2026-08-05",
    });
    const exchange = waterRule({
      template: { kind: "transfer", amountMinor: 1_800_000, fromAccountId: SEED_IDS.accounts.main, toAccountId: DOLLARS, toAmountMinor: 20_000 },
      frequency: "monthly",
      interval: 1,
      startDate: "2026-08-06",
    });
    const result = materializeRecurring(withRules([salary, exchange]), "2026-08-31");
    expect(result.created).toEqual([
      {
        id: recurringOccurrenceId(OTHER_RULE, "2026-08-05"), occurredOn: "2026-08-05", status: "posted", kind: "income", amountMinor: 12_000_000,
        accountId: SEED_IDS.accounts.main, categoryId: SALARY, recurringRuleId: OTHER_RULE,
      },
      {
        id: recurringOccurrenceId(RULE, "2026-08-06"), occurredOn: "2026-08-06", status: "posted", kind: "transfer", amountMinor: 1_800_000,
        fromAccountId: SEED_IDS.accounts.main, toAccountId: DOLLARS, toAmountMinor: 20_000, recurringRuleId: RULE,
      },
    ]);
    // Income on a foreign account carries its snapshot like an expense does.
    const dollarSalary = waterRule({ template: { kind: "income", amountMinor: 100_000, accountId: DOLLARS }, startDate: "2026-08-05" });
    const valued = created(withRules([dollarSalary], { exchangeRates: [rate(RATE_JULY, "2026-07-31", 9_000)] }), "2026-08-05");
    expect(valued[0]).toMatchObject({ kind: "income", baseAmountMinor: 9_000_000, baseCurrency: "RUB" });
    expect("categoryId" in valued[0]!).toBe(false);
  });

  it("stops at the end date and does not rewrite a rule that has ended", () => {
    const ending = waterRule({ interval: 1, endDate: "2026-08-11" });
    const result = materializeRecurring(withRules([ending]), "2026-08-31");
    expect(datesOf(result.created)).toEqual(["2026-08-04", "2026-08-11"]);
    // Nothing can fall after the end, so closing those days would add nothing but another write.
    expect(ruleOf(result.state).materializedThrough).toBe("2026-08-11");
    expect(materializeRecurring(result.state, "2026-12-31").state).toBe(result.state);
  });

  it("moves no figure for a rule that has not started", () => {
    const state = withRules([waterRule()]);
    expect(materializeRecurring(state, "2026-08-03").state).toBe(state);
  });
});

describe("recurring rules in the state", () => {
  const withRule = (rule: unknown): BudgetState => withRules([rule as RecurringRule]);
  const withTemplate = (template: unknown): BudgetState => withRule({ ...waterRule(), template: template as RecurringTemplate });
  const expense = waterRule().template;

  it("accepts a rule and moves no figure until it writes", () => {
    const seed = withRules([]);
    const { name: _name, ...unnamed } = waterRule({ id: OTHER_RULE, endDate: "2026-08-04", materializedThrough: "2026-08-04" });
    const state = withRules([waterRule(), unnamed]);
    expect(calculateBudget(state)).toEqual(calculateBudget(seed));
    expect(calculateAnnualPlan(state, "2026-07", 12)).toEqual(calculateAnnualPlan(seed, "2026-07", 12));
    expect(calculateMemberExpenses(state)).toEqual(calculateMemberExpenses(seed));
    expect(documentIds(state)).toEqual(expect.arrayContaining([RULE, OTHER_RULE]));
  });

  it("refuses a schedule outside its bounds", () => {
    expect(() => calculateBudget(withRule(waterRule({ frequency: "hourly" as never })))).toThrow(/recurring rule .* frequency/);
    for (const interval of [0, MAX_RECURRENCE_INTERVAL + 1, 1.5, -2]) {
      expect(() => calculateBudget(withRule(waterRule({ interval }))), String(interval)).toThrow(/interval must be an integer from 1 to 999/);
    }
    expect(() => calculateBudget(withRule(waterRule({ interval: MAX_RECURRENCE_INTERVAL })))).not.toThrow();
    expect(() => calculateBudget(withRule(waterRule({ endDate: "2026-08-03" })))).toThrow(/endDate must not be before startDate/);
    expect(() => calculateBudget(withRule(waterRule({ startDate: "2200-01-01" })))).toThrow(/startDate must be from 1900-01-01 to 2199-12-31/);
    expect(() => calculateBudget(withRule(waterRule({ endDate: "2026-02-30" })))).toThrow(/endDate/);
    expect(() => calculateBudget(withRule(waterRule({ materializedThrough: "1899-12-31" })))).toThrow(/materializedThrough must be from/);
    expect(() => calculateBudget(withRule(waterRule({ active: "yes" as never })))).toThrow(/active must be a boolean/);
    expect(() => calculateBudget(withRule(waterRule({ name: " Вода" })))).toThrow(/name must be stored text of at most 80 characters/);
    expect(() => calculateBudget(withRule(waterRule({ name: "я".repeat(81) })))).toThrow(/name must be stored text/);
    expect(() => calculateBudget(withRules([waterRule(), waterRule()]))).toThrow(/duplicate|repeat/i);
  });

  it("refuses a template the operation it writes would be refused for", () => {
    const refusals: readonly [string, unknown, RegExp][] = [
      ["no template", null, /must be an operation template/],
      ["a refund", { ...expense, kind: "refund" }, /template kind/],
      ["a debt movement", { ...expense, kind: "debt_out" }, /template kind/],
      ["no money", { ...expense, amountMinor: 0 }, /amountMinor/],
      ["more than a field holds", { ...expense, amountMinor: MAX_MONEY_MINOR + 1 }, /amountMinor must be at most/],
      ["an unknown account", { ...expense, accountId: "8c000000-0000-4000-8000-0000000000ff" }, /references unknown id/],
      ["an income category for an expense", { ...expense, categoryId: SALARY }, /must reference an expense category/],
      ["an expense category for income", { kind: "income", amountMinor: 1, accountId: SEED_IDS.accounts.main, categoryId: SEED_IDS.categories.food }, /must reference an income category/],
      ["an unknown tag", { ...expense, tagIds: ["8a000000-0000-4000-8000-0000000000ff"] }, /tagIds references unknown id/],
      ["a repeated tag", { ...expense, tagIds: [HOME, HOME] }, /tagIds repeats tag/],
      ["no tags in a list", { ...expense, tagIds: [] }, /tagIds must list from 1 to 10 tags/],
      ["a note on two lines", { ...expense, note: "Вода\nи хлеб" }, /note must be one trimmed line/],
      ["one account on both sides", { kind: "transfer", amountMinor: 1, fromAccountId: SEED_IDS.accounts.main, toAccountId: SEED_IDS.accounts.main }, /two different accounts/],
      ["a foreign transfer without what arrives", { kind: "transfer", amountMinor: 1, fromAccountId: SEED_IDS.accounts.main, toAccountId: DOLLARS }, /must carry toAmountMinor/],
      ["what arrives within one currency", { kind: "transfer", amountMinor: 1, fromAccountId: SEED_IDS.accounts.main, toAccountId: SEED_IDS.accounts.savings, toAmountMinor: 1 }, /must not carry toAmountMinor/],
      ["what arrives beyond a field", { kind: "transfer", amountMinor: 1, fromAccountId: SEED_IDS.accounts.main, toAccountId: DOLLARS, toAmountMinor: MAX_MONEY_MINOR + 1 }, /toAmountMinor must be at most/],
    ];
    for (const [label, template, error] of refusals) {
      expect(() => calculateBudget(withTemplate(template)), label).toThrow(error);
    }
    // An archived tag, category or account is still a valid reference, as on an operation.
    const archived = withRules([waterRule()], { tags: [{ id: HOME, name: "Дом", active: false }] });
    expect(() => calculateBudget(archived)).not.toThrow();
  });

  it("holds an occurrence's label to a rule the state carries", () => {
    const occurrence = (state: BudgetState, recurringRuleId: string): BudgetState => ({
      ...state,
      transactions: state.transactions.map((item) => (item.id === SEED_IDS.transactions.food ? { ...item, recurringRuleId } : item)),
    });
    expect(() => calculateBudget(occurrence(withRules([waterRule()]), RULE))).not.toThrow();
    expect(() => calculateBudget(occurrence(withRules([waterRule()]), OTHER_RULE)))
      .toThrow(new RegExp(`recurringRuleId references unknown id ${OTHER_RULE}`));
  });

  it("names the occurrence of a day the same way on every device and in every version", () => {
    expect(recurringOccurrenceId(RULE, "2026-08-04")).toBe("f20a372a-f29b-8225-bf72-d219da902bb3");
    expect(recurringOccurrenceId(RULE, "2026-08-05")).not.toBe(recurringOccurrenceId(RULE, "2026-08-04"));
    expect(recurringOccurrenceId(OTHER_RULE, "2026-08-04")).not.toBe(recurringOccurrenceId(RULE, "2026-08-04"));
    expect(isUuid(recurringOccurrenceId(RULE, "2026-08-04"))).toBe(true);
  });

  it("shares its count limit with the journal", () => {
    expect(COLLECTION_LIMITS.recurringRules).toBe(1_000);
  });
});

describe("archiveRecurringRule and deleteRecurringRule", () => {
  it("stops a rule and keeps every occurrence it wrote", () => {
    const materialized = materializeRecurring(withRules([waterRule()]), "2026-08-31").state;
    const stopped = archiveRecurringRule(materialized, RULE);
    expect(ruleOf(stopped).active).toBe(false);
    expect(stopped.transactions).toBe(materialized.transactions);
    expect(materializeRecurring(stopped, "2026-12-31").state).toBe(stopped);
    expect(archiveRecurringRule(stopped, RULE)).toBe(stopped);
    expect(() => archiveRecurringRule(stopped, OTHER_RULE)).toThrow(/is not in the state/);
  });

  // Security review L3 (orchestrator decision): the plan had the delete take the label off every
  // occurrence, one whole-entity update per operation through the journal; a rule with occurrences
  // is stopped instead.
  it("refuses a rule with occurrences and deletes one without", () => {
    const materialized = materializeRecurring(withRules([waterRule()]), "2026-08-31").state;
    expect(() => deleteRecurringRule(materialized, RULE)).toThrow(/has occurrences; stop it instead of deleting it/);
    expect(() => deleteRecurringRule(archiveRecurringRule(materialized, RULE), RULE)).toThrow(/has occurrences/);

    const unused = withRules([waterRule()]);
    const deleted = deleteRecurringRule(unused, RULE);
    expect(deleted.recurringRules).toEqual([]);
    expect(deleted.transactions).toBe(unused.transactions);
    expect(calculateBudget(deleted)).toEqual(calculateBudget(unused));
    expect(() => deleteRecurringRule(deleted, RULE)).toThrow(/is not in the state/);
  });
});
