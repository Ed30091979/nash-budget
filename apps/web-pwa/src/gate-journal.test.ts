/**
 * Всё, что принимает шлюз копии, обязан нести журнал семьи.
 *
 * Шлюз (`prepareBudgetState`) и кодек журнала проверяют одни и те же поля, каждый своим кодом. Если
 * шлюз пропускает значение, которое кодек отвергает, семья сохраняет его у себя, а первая же
 * синхронизация бросает на каждой записи: значение застревает на устройстве, которое его записало.
 * Так было со сроком цели в 2200 году и порядком счёта 1 000 001. Проверка ниже перебирает краевые
 * значения каждого поля волны и требует двух вещей: каждая правка кончается так, как должна, — принята
 * или отвергнута по названной причине, а не по случайной, — и принятое шлюзом проходит
 * `budgetJournalDrafts` и `createLocalOperation`, то есть настоящий кодек. Одних общих счётчиков
 * «принято/отвергнуто» было мало: шаблон перевода отвергался за лишнее поле, оставленное самой
 * проверкой, и свойство «шлюз ⇒ кодек» для него не проверялось вовсе.
 */
import {
  HOUSEHOLD_ID,
  makePlanningSeed,
  materializeRecurring,
  MAX_LOCAL_DATE,
  MAX_MONEY_MINOR,
  MAX_RECURRENCE_INTERVAL,
  MAX_SORT_ORDER,
  MIN_LOCAL_DATE,
  RATE_PART_MAX,
  type BudgetState,
} from "@family-budget/domain";
import { createClock, createLocalOperation } from "@family-budget/sync-protocol";
import { G002, toDomainBudgetState } from "@family-budget/test-fixtures";
import { describe, expect, it } from "vitest";

import { prepareBudgetState } from "./backup";
import { budgetJournalDrafts } from "./features/family/journal";

const DEVICE = "0000000a-0000-4000-8000-000000000001";
const TAG_ID = "c1111111-1111-4111-8111-111111111111";

/** Принято шлюзом — и тогда обязано пройти кодек журнала. */
const ACCEPTED = "accepted";
/** Чем кончается правка: принята или отвергнута, и тогда — с какой причиной. */
type Expected = typeof ACCEPTED | RegExp;
type Mutation = readonly [string, (state: BudgetState) => unknown, Expected];

function stampAll(state: BudgetState): number {
  let clock = createClock(DEVICE, 0);
  let count = 0;
  for (const draft of budgetJournalDrafts(null, state)) {
    clock = createLocalOperation(clock, draft).clock;
    count += 1;
  }
  return count;
}

function firstAccount(state: BudgetState, change: Record<string, unknown>): unknown {
  return { ...state, accounts: state.accounts.map((item, index) => (index === 0 ? { ...item, ...change } : item)) };
}

function firstCategory(state: BudgetState, change: Record<string, unknown>): unknown {
  return { ...state, categories: state.categories.map((item, index) => (index === 0 ? { ...item, ...change } : item)) };
}

function firstGoal(state: BudgetState, change: Record<string, unknown>): unknown {
  return { ...state, goals: state.goals.map((item, index) => (index === 0 ? { ...item, ...change } : item)) };
}

function tagged(state: BudgetState, name: string, change: Record<string, unknown> = {}): unknown {
  return {
    ...state,
    tags: [{ id: TAG_ID, name, active: true }],
    transactions: state.transactions.map((item, index) => (index === 0 ? { ...item, tagIds: [TAG_ID], ...change } : item)),
  };
}

function noted(state: BudgetState, note: unknown): unknown {
  return { ...state, transactions: state.transactions.map((item, index) => (index === 0 ? { ...item, note } : item)) };
}

const DOLLARS = "c5555555-5555-4555-8555-555555555551";
const RATE_ID = "c5555555-5555-4555-8555-555555555553";

/** Долларовый счёт, курс и покупка по нему: поля шага 8, все разом, с правкой поверх. */
function dollars(state: BudgetState, expense: Record<string, unknown> = {}, rate: Record<string, unknown> = {}): unknown {
  const categoryId = state.categories.find((item) => item.type === "expense")!.id;
  return {
    ...state,
    household: { id: HOUSEHOLD_ID, baseCurrency: "RUB" },
    exchangeRates: [{ id: RATE_ID, currency: "USD", baseCurrency: "RUB", date: "2026-06-30", rate: { baseMinor: 9_000, quoteMinor: 100 }, ...rate }],
    accounts: [...state.accounts, { id: DOLLARS, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true }],
    transactions: [...state.transactions, {
      id: "c5555555-5555-4555-8555-555555555552", occurredOn: "2026-07-10", status: "posted", kind: "expense", amountMinor: 4_000,
      accountId: DOLLARS, categoryId, baseAmountMinor: 360_000, baseCurrency: "RUB", rate: { baseMinor: 9_000, quoteMinor: 100 }, ...expense,
    }],
  };
}

/** Долг шага 10 с правкой поверх. */
function indebted(state: BudgetState, change: Record<string, unknown> = {}): unknown {
  return {
    ...state,
    debts: [{ id: "c7777777-7777-4777-8777-777777777771", counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 300_000, active: true, ...change }],
  };
}

const RULE_ID = "c9999999-9999-4999-8999-999999999991";

/** Правило шагов 12–13 с правкой поверх: расход по первому счёту в первую расходную категорию. */
function scheduled(state: BudgetState, change: Record<string, unknown> = {}, template: Record<string, unknown> = {}): unknown {
  const categoryId = state.categories.find((item) => item.type === "expense")!.id;
  return withTemplate(state, { kind: "expense", amountMinor: 150_000, accountId: state.accounts[0]!.id, categoryId, ...template }, change);
}

/** Правило с шаблоном ровно таким, какой дан: ни одного поля от шаблона расхода. */
function withTemplate(state: BudgetState, template: Record<string, unknown>, change: Record<string, unknown> = {}): unknown {
  return {
    ...state,
    recurringRules: [{ id: RULE_ID, template, frequency: "weekly", interval: 2, startDate: "2026-07-07", active: true, ...change }],
  };
}

const MOVEMENT_ID = "c7777777-7777-4777-8777-777777777772";

/** Движение по долгу шага 11 с правкой поверх: 5 000 ₽ ушли с первого счёта Пете. */
function lent(state: BudgetState, change: Record<string, unknown> = {}, currency = "RUB"): unknown {
  const withDebt = indebted(state, { currency }) as BudgetState;
  return {
    ...withDebt,
    transactions: [...withDebt.transactions, {
      id: MOVEMENT_ID, kind: "debt_out", status: "posted", occurredOn: "2026-07-09",
      amountMinor: 500_000, accountId: withDebt.accounts[0]!.id, debtId: "c7777777-7777-4777-8777-777777777771", ...change,
    }],
  };
}

/** Перевод с первого счёта на долларовый с суммой зачисления, с правкой поверх. */
function exchanged(state: BudgetState, change: Record<string, unknown> = {}): unknown {
  const withDollars = dollars(state) as BudgetState;
  return {
    ...withDollars,
    transactions: [...withDollars.transactions, {
      id: "c5555555-5555-4555-8555-555555555554", kind: "transfer", status: "posted", occurredOn: "2026-07-05",
      amountMinor: 1_800_000, fromAccountId: withDollars.accounts[0]!.id, toAccountId: DOLLARS, toAmountMinor: 20_000, ...change,
    }],
  };
}


/** Краевые значения: по обе стороны каждой границы и то, что граница должна отвергнуть. */
const SORT_ORDER = /sortOrder: порядок вне диапазона ±1000000/u;
const DISPLAY_KEY = /недопустимый ключ оформления/u;
const WINDOW = /дата вне диапазона 1900-01-01…2199-12-31/u;
const FIELD_AMOUNT = /сумма от 1 до 10000000000 minor units/u;
const STORED_NOTE = /заметка в несколько строк, с лишними пробелами или служебными символами/u;

const MUTATIONS: readonly Mutation[] = [
  ...([[0, ACCEPTED], [1, ACCEPTED], [-1, ACCEPTED], [MAX_SORT_ORDER, ACCEPTED], [-MAX_SORT_ORDER, ACCEPTED],
    [MAX_SORT_ORDER + 1, SORT_ORDER], [-MAX_SORT_ORDER - 1, SORT_ORDER], [Number.MAX_SAFE_INTEGER, SORT_ORDER],
    [1.5, /accounts\[0\]\.sortOrder: ожидалось целое число/u]] as const)
    .map(([sortOrder, expected]): Mutation => [`account.sortOrder ${sortOrder}`, (state) => firstAccount(state, { sortOrder }), expected]),
  ...([["sage", ACCEPTED], ["shopping-basket", ACCEPTED], ["a", ACCEPTED], ["x".repeat(40), ACCEPTED], ["x".repeat(41), DISPLAY_KEY],
    ["Sage", DISPLAY_KEY], ["#00ff00", DISPLAY_KEY], ["icon.svg", DISPLAY_KEY], ["", /ожидалась непустая строка/u]] as const)
    .flatMap(([key, expected]): Mutation[] => [
      [`account.icon ${key}`, (state) => firstAccount(state, { icon: key }), expected],
      [`account.color ${key}`, (state) => firstAccount(state, { color: key }), expected],
      [`category.icon ${key}`, (state) => firstCategory(state, { icon: key }), expected],
      [`goal.icon ${key}`, (state) => firstGoal(state, { icon: key }), expected],
    ]),
  ...([[true, ACCEPTED], [false, ACCEPTED], ["yes", /accounts\[0\]\.includeInTotal: ожидалось логическое значение/u]] as const)
    .map(([value, expected]): Mutation => [`account.includeInTotal ${String(value)}`, (state) => firstAccount(state, { includeInTotal: value }), expected]),
  ...([[MIN_LOCAL_DATE, ACCEPTED], [MAX_LOCAL_DATE, ACCEPTED], ["1899-12-31", WINDOW], ["2200-01-01", WINDOW], ["9999-12-31", WINDOW],
    ["2027-02-28", ACCEPTED], ["2027-02-29", /goals\[0\]\.deadline: невозможная календарная дата/u], ["0001-01-01", WINDOW]] as const)
    .map(([deadline, expected]): Mutation => [`goal.deadline ${deadline}`, (state) => firstGoal(state, { deadline }), expected]),
  ...([["Пятёрочка у дома", ACCEPTED], ["я".repeat(500), ACCEPTED], ["я".repeat(501), /transactions\[0\]\.note: строка длиннее 500 символов/u],
    [" Пятёрочка", STORED_NOTE], ["Кофе в Starbucks", ACCEPTED], ["Цветы \u2764", ACCEPTED], ["A\u030a", ACCEPTED], ["\u00c5", ACCEPTED],
    ["Пятёрочка\u202e", STORED_NOTE], ["Пятёрочка\nу дома", STORED_NOTE], ["мягкий\u00adперенос", STORED_NOTE], ["\u{1f334} пальма", ACCEPTED],
    ["", /transactions\[0\]\.note: ожидалась непустая строка/u]] as const)
    .map(([note, expected]): Mutation => [`note ${JSON.stringify(note)}`, (state) => noted(state, note), expected]),
  ...([["Дом", ACCEPTED], ["Отпуск 2027", ACCEPTED], ["я".repeat(40), ACCEPTED], ["я".repeat(41), /tags\[0\]\.name: строка длиннее 40 символов/u],
    ["Дом ", /tags\[0\]\.name: название метки с лишними пробелами/u], [" Дом", /tags\[0\]\.name: название метки с лишними пробелами/u],
    ["Дом Home", ACCEPTED], ["Чаи\u0306", ACCEPTED], ["Ча\u0439", ACCEPTED]] as const)
    .map(([name, expected]): Mutation => [`tag.name ${JSON.stringify(name)}`, (state) => tagged(state, name), expected]),
  ["dollars", (state) => dollars(state), ACCEPTED],
  // A base sum is the amount at its rate, exactly; a sum entered by hand is its own rate, sum per amount.
  ...([[1, ACCEPTED], [MAX_MONEY_MINOR, ACCEPTED], [MAX_MONEY_MINOR + 1, FIELD_AMOUNT], [0, FIELD_AMOUNT], [1.5, FIELD_AMOUNT]] as const)
    .map(([baseAmountMinor, expected]): Mutation => [
      `baseAmountMinor ${baseAmountMinor}`,
      (state) => dollars(state, { baseAmountMinor, rate: { baseMinor: baseAmountMinor, quoteMinor: 4_000 } }),
      expected,
    ]),
  ["snapshot a kopeck off its rate", (state) => dollars(state, { baseAmountMinor: 360_001 }), /transactions\[\d+\]\.baseAmountMinor: сумма в базовой валюте не равна сумме операции по её курсу — 360000/u],
  ["snapshot at a rate far from the day's", (state) => dollars(state, { baseAmountMinor: 40, rate: { baseMinor: 1, quoteMinor: 100 } }), ACCEPTED],
  ...([[1, ACCEPTED], [RATE_PART_MAX, ACCEPTED], [RATE_PART_MAX + 1, null], [0, null]] as const)
    .flatMap(([part, expected]): Mutation[] => [
      // Both parts at the edge and the snapshot exact: 40 $ at part per part is 4 000.
      [`snapshot rate ${part}`, (state) => dollars(state, { baseAmountMinor: 4_000, rate: { baseMinor: part, quoteMinor: part } }), expected ?? /transactions\[\d+\]\.rate: части курса — целые числа от 1 до 10¹²/u],
      [`exchange rate ${part}`, (state) => dollars(state, {}, { rate: { baseMinor: 9_000, quoteMinor: part } }), expected ?? /exchangeRates\[0\]\.rate: части курса — целые числа от 1 до 10¹²/u],
    ]),
  ...([[MIN_LOCAL_DATE, ACCEPTED], [MAX_LOCAL_DATE, ACCEPTED], ["1899-12-31", WINDOW], ["2200-01-01", WINDOW]] as const)
    .map(([date, expected]): Mutation => [`exchange rate date ${date}`, (state) => dollars(state, {}, { date }), expected]),
  ...([["RUB", ACCEPTED], ["EUR", /transactions\[\d+\]\.baseCurrency: сумма записана не в базовой валюте RUB/u],
    ["XYZ", /transactions\[\d+\]\.baseCurrency: недопустимое значение/u], ["rub", /transactions\[\d+\]\.baseCurrency: недопустимое значение/u]] as const)
    .map(([baseCurrency, expected]): Mutation => [`snapshot baseCurrency ${baseCurrency}`, (state) => dollars(state, { baseCurrency }), expected]),
  ...([["USD", ACCEPTED], ["JPY", ACCEPTED], ["KWD", ACCEPTED], ["XYZ", /exchangeRates\[0\]\.currency: недопустимое значение/u]] as const)
    .map(([currency, expected]): Mutation => [`exchange rate currency ${currency}`, (state) => dollars(state, {}, { currency }), expected]),
  // The amount and the day of a foreign purchase, of a transfer between currencies and of a debt
  // movement: the codec bounds them on the wire, so the gate does too, or the value is stranded.
  ...([[MAX_MONEY_MINOR, ACCEPTED], [MAX_MONEY_MINOR + 1, /transactions\[\d+\]\.amountMinor: сумма от 1 до 10000000000 minor units/u]] as const)
    .flatMap(([amountMinor, expected]): Mutation[] => [
      // At half a rouble a cent the snapshot stays within its own ceiling, so the amount is what is measured.
      [`foreign purchase amountMinor ${amountMinor}`, (state) => dollars(state, { amountMinor, baseAmountMinor: Math.floor(amountMinor / 2) + (amountMinor % 2), rate: { baseMinor: 1, quoteMinor: 2 } }), expected],
      [`transfer between currencies amountMinor ${amountMinor}`, (state) => exchanged(state, { amountMinor }), expected],
      [`debt movement amountMinor ${amountMinor}`, (state) => lent(state, { amountMinor }), expected],
    ]),
  ...([[MIN_LOCAL_DATE, ACCEPTED], [MAX_LOCAL_DATE, ACCEPTED], ["1899-12-31", /transactions\[\d+\]\.occurredOn: дата вне диапазона 1900-01-01…2199-12-31/u],
    ["2200-01-01", /transactions\[\d+\]\.occurredOn: дата вне диапазона 1900-01-01…2199-12-31/u]] as const)
    .flatMap(([occurredOn, expected]): Mutation[] => [
      [`foreign purchase occurredOn ${occurredOn}`, (state) => dollars(state, { occurredOn }), expected],
      [`transfer between currencies occurredOn ${occurredOn}`, (state) => exchanged(state, { occurredOn }), expected],
      [`debt movement occurredOn ${occurredOn}`, (state) => lent(state, { occurredOn }), expected],
    ]),
  ["debt", (state) => indebted(state), ACCEPTED],
  ...([["Петя", ACCEPTED], ["я".repeat(80), ACCEPTED], ["я".repeat(81), /debts\[0\]\.counterparty: строка длиннее 80 символов/u],
    [" Петя", /debts\[0\]\.counterparty: имя с лишними пробелами или служебными символами/u], ["Петя Smith", ACCEPTED],
    ["Пе\u00adтя", /debts\[0\]\.counterparty: имя с лишними пробелами или служебными символами/u], ["???", ACCEPTED]] as const)
    .map(([counterparty, expected]): Mutation => [`debt.counterparty ${JSON.stringify(counterparty)}`, (state) => indebted(state, { counterparty }), expected]),
  ...([[0, ACCEPTED], [MAX_MONEY_MINOR, ACCEPTED], [MAX_MONEY_MINOR + 1, /debts\[0\]\.openingMinor: сумма от 0 до 10000000000/u],
    [-1, /debts\[0\]\.openingMinor: сумма от 0 до 10000000000/u]] as const)
    .map(([openingMinor, expected]): Mutation => [`debt.openingMinor ${openingMinor}`, (state) => indebted(state, { openingMinor }), expected]),
  ...([[MIN_LOCAL_DATE, ACCEPTED], [MAX_LOCAL_DATE, ACCEPTED], ["2200-01-01", WINDOW], ["1899-12-31", WINDOW]] as const)
    .map(([dueDate, expected]): Mutation => [`debt.dueDate ${dueDate}`, (state) => indebted(state, { dueDate }), expected]),
  ...([["USD", ACCEPTED], ["XYZ", /debts\[0\]\.currency: недопустимое значение/u]] as const)
    .map(([currency, expected]): Mutation => [`debt.currency ${currency}`, (state) => indebted(state, { currency }), expected]),
  ...([
    [{}, ACCEPTED, /операция по счёту в RUB и долгу в USD без суммы в валюте долга/u],
    [{ debtAmountMinor: 5_000 }, /transactions\[\d+\]\.debtAmountMinor: счёт и долг в одной валюте/u, ACCEPTED],
    [{ debtAmountMinor: MAX_MONEY_MINOR + 1 }, FIELD_AMOUNT, FIELD_AMOUNT],
    [{ kind: "debt_in" }, ACCEPTED, /операция по счёту в RUB и долгу в USD без суммы в валюте долга/u],
    [{ debtId: "c7777777-7777-4777-8777-7777777777ff" }, /transactions\[\d+\]\.debtId: неизвестный долг/u, /transactions\[\d+\]\.debtId: неизвестный долг/u],
  ] as const).flatMap(([change, inRoubles, inDollars]): Mutation[] => [
    [`debt movement ${JSON.stringify(change)} on a debt in RUB`, (state) => lent(state, change, "RUB"), inRoubles],
    [`debt movement ${JSON.stringify(change)} on a debt in USD`, (state) => lent(state, change, "USD"), inDollars],
  ]),
  ["recurring rule", (state) => scheduled(state), ACCEPTED],
  ["recurring rule with its occurrences", (state) => materializeRecurring(scheduled(state) as BudgetState, "2026-07-31").state, ACCEPTED],
  ["an occurrence of a rule the copy lacks", (state) => ({
    ...state, transactions: state.transactions.map((item, index) => (index === 0 ? { ...item, recurringRuleId: RULE_ID } : item)),
  }), ACCEPTED],
  ...([[1, ACCEPTED], [MAX_RECURRENCE_INTERVAL, ACCEPTED], [MAX_RECURRENCE_INTERVAL + 1, /recurringRules\[0\]\.interval: целое число от 1 до 999/u],
    [0, /recurringRules\[0\]\.interval: целое число от 1 до 999/u], [1.5, /recurringRules\[0\]\.interval: целое число от 1 до 999/u]] as const)
    .map(([interval, expected]): Mutation => [`rule.interval ${interval}`, (state) => scheduled(state, { interval }), expected]),
  ...([[MIN_LOCAL_DATE, ACCEPTED], [MAX_LOCAL_DATE, ACCEPTED], ["2200-01-01", WINDOW], ["1899-12-31", WINDOW], ["2026-02-30", /невозможная календарная дата/u]] as const)
    .flatMap(([date, expected]): Mutation[] => [
      [`rule.startDate ${date}`, (state) => scheduled(state, { startDate: date }), expected],
      [`rule.endDate ${date}`, (state) => scheduled(state, { startDate: MIN_LOCAL_DATE, endDate: date }), expected],
      [`rule.materializedThrough ${date}`, (state) => scheduled(state, { materializedThrough: date }), expected],
    ]),
  ...([["Доставка воды", ACCEPTED], ["я".repeat(80), ACCEPTED], ["я".repeat(81), /recurringRules\[0\]\.name: строка длиннее 80 символов/u],
    [" Вода", /recurringRules\[0\]\.name: название с лишними пробелами/u], ["Во\u00adда", /recurringRules\[0\]\.name: название с лишними пробелами/u],
    ["", /recurringRules\[0\]\.name: ожидалась непустая строка/u]] as const)
    .map(([name, expected]): Mutation => [`rule.name ${JSON.stringify(name)}`, (state) => scheduled(state, { name }), expected]),
  ...([[1, ACCEPTED], [MAX_MONEY_MINOR, ACCEPTED], [MAX_MONEY_MINOR + 1, FIELD_AMOUNT], [0, FIELD_AMOUNT]] as const)
    .map(([amountMinor, expected]): Mutation => [`template.amountMinor ${amountMinor}`, (state) => scheduled(state, {}, { amountMinor }), expected]),
  ...([["Доставка воды", ACCEPTED], ["я".repeat(500), ACCEPTED], ["я".repeat(501), /recurringRules\[0\]\.template\.note: строка длиннее 500 символов/u],
    ["Вода\nи хлеб", STORED_NOTE], [" Вода", STORED_NOTE]] as const)
    .map(([note, expected]): Mutation => [`template.note ${JSON.stringify(note)}`, (state) => scheduled(state, {}, { note }), expected]),
  // Templates of the other kinds, built with their own fields and nothing of the expense template:
  // left over as `accountId: undefined`, those keys made the gate refuse every transfer template for
  // a field it does not have, and the transfer case never reached the codec.
  ["income template", (state) => withTemplate(state, { kind: "income", amountMinor: 150_000, accountId: state.accounts[0]!.id }), ACCEPTED],
  ["transfer template", (state) => withTemplate(state, { kind: "transfer", amountMinor: 150_000, fromAccountId: state.accounts[0]!.id, toAccountId: state.accounts[1]!.id }), ACCEPTED],
  ["transfer template into itself", (state) => withTemplate(state, { kind: "transfer", amountMinor: 150_000, fromAccountId: state.accounts[0]!.id, toAccountId: state.accounts[0]!.id }),
    /recurringRules\[0\]\.template: перевод со счёта на него же/u],
  ["transfer template within roubles naming what arrived", (state) => withTemplate(state, { kind: "transfer", amountMinor: 150_000, fromAccountId: state.accounts[0]!.id, toAccountId: state.accounts[1]!.id, toAmountMinor: 100 }),
    /recurringRules\[0\]\.template\.toAmountMinor: перевод в одной валюте без отдельной суммы зачисления/u],
  ["template with an id", (state) => scheduled(state, {}, { id: RULE_ID }), /recurringRules\[0\]\.template: лишнее поле id/u],
];

describe("шлюз копии и журнал семьи", () => {
  it.each([
    ["G-002", () => toDomainBudgetState(G002) as BudgetState],
    ["makePlanningSeed", makePlanningSeed],
  ] as const)("каждая правка кончается так, как должна, а принятое шлюзом проходит кодек журнала: %s", (_label, base) => {
    for (const [label, mutate, expected] of MUTATIONS) {
      if (expected === ACCEPTED) {
        let prepared: BudgetState | undefined;
        expect(() => {
          prepared = prepareBudgetState(mutate(base()));
        }, label).not.toThrow();
        expect(() => stampAll(prepared!), label).not.toThrow();
      } else {
        expect(() => prepareBudgetState(mutate(base())), label).toThrow(expected);
      }
    }
    // Не пустая проверка: значения по обе стороны каждой границы.
    expect(MUTATIONS.filter(([, , expected]) => expected === ACCEPTED).length).toBeGreaterThan(25);
    expect(MUTATIONS.filter(([, , expected]) => expected !== ACCEPTED).length).toBeGreaterThan(25);
  });
});
