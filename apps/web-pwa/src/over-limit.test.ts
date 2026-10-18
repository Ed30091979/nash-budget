/**
 * Документ, в котором записей больше предела, правится, чистится и копируется.
 *
 * Пределы числа записей ограничивают только рост: новую запись вида, которого уже столько, сколько
 * позволено, форма не создаёт. Всё остальное работает всегда. Документ за пределом — обычное
 * следствие слияния офлайн-правок нескольких устройств семьи, и прежде формы записи и плана
 * отвергали в нём любое действие — «Слишком много счетов.», — включая удаление того, что лишнее,
 * а копия не записывалась. Это навсегда держало семью за пределом и без резервной копии.
 */
import {
  createDebt,
  createTag,
  makePlanningSeed,
  makeSeedBudget,
  PLANNING_IDS,
  SEED_IDS,
  type BudgetState,
} from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";

import { BACKUP_LIMITS, createBudgetBackup, parseAndValidateBudgetBackup, prepareBudgetState } from "./backup";
import {
  archiveCategory,
  createOperationCategory,
  createTransaction,
  deleteTransaction,
  editTransaction,
  OPERATIONS_LIMITS,
} from "./features/operations/model";
import {
  archiveFlexibleLine,
  createCommitment,
  createFlexibleLine,
  createSchedule,
  editCommitment,
  editSchedule,
  PLANNING_LIMITS,
  setCommitmentActive,
} from "./features/planning/model";

const uuid = (lead: string, index: number): string => `${lead}-0000-4000-8000-${String(index).padStart(12, "0")}`;
let nextId = 0;
const makeId = (): string => uuid("cf000000", (nextId += 1));

/** Ещё `count` записей вида, сделанных из образца, с новыми идентификаторами. */
function more<T extends { readonly id: string }>(sample: T, count: number, lead: string, change: (index: number) => Partial<T> = () => ({})): T[] {
  return Array.from({ length: count }, (_, index) => ({ ...sample, ...change(index), id: uuid(lead, index) }));
}

const seed = makePlanningSeed();
const expense = seed.categories.find((category) => category.type === "expense")!;
const active = seed.budgets.find((budget) => budget.id === seed.activeBudgetId)!;

/** Категорий ровно `total`, расходных, — по одной строке активного бюджета на каждую можно завести. */
function categoriesUpTo(total: number): BudgetState["categories"] {
  return [
    ...seed.categories,
    ...more(expense, total - seed.categories.length, "c2000000", (index) => ({ name: `Категория ${index}`, sortOrder: 1_000 + index })),
  ];
}

/** Строки бюджета на каждую расходную категорию, с идентификаторами одного ведущего префикса. */
function linesFor(categories: BudgetState["categories"], lead: string): BudgetState["budgets"][number]["lines"] {
  return categories.filter((category) => category.type === "expense").map((category, index) => ({ id: uuid(lead, index), categoryId: category.id, plannedMinor: 100 }));
}

const OVER: readonly (readonly [string, string, () => BudgetState])[] = [
  ["accounts", "счетов", () => ({ ...seed, accounts: [...seed.accounts, ...more(seed.accounts[0]!, BACKUP_LIMITS.accounts + 1 - seed.accounts.length, "c2100000", (index) => ({ name: `Счёт ${index}` }))] })],
  ["categories", "категорий", () => ({ ...seed, categories: categoriesUpTo(BACKUP_LIMITS.categories + 1) })],
  ["budgets", "бюджетных периодов", () => ({
    ...seed,
    budgets: [...seed.budgets, ...more({ ...active, status: "closed" as const, lines: [] }, BACKUP_LIMITS.budgets + 1 - seed.budgets.length, "c2200000", (index) => ({
      startDate: `${1990 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`,
      endDate: `${1990 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-28`,
    }))],
  })],
  ["budgets[0].lines", "строк в одном бюджете", () => {
    const categories = categoriesUpTo(BACKUP_LIMITS.linesPerBudget + seed.categories.length - seed.categories.filter((category) => category.type === "expense").length + 1);
    return { ...seed, categories, budgets: seed.budgets.map((budget) => (budget.id === active.id ? { ...budget, lines: linesFor(categories, "c2300000") } : budget)) };
  }],
  ["budget lines", "строк во всех бюджетах", () => {
    // Категорий ровно предел, по строке на каждую расходную в двадцати одном бюджете: каждый бюджет
    // в пределе одного, а все вместе — за общим.
    const categories = categoriesUpTo(BACKUP_LIMITS.categories);
    const budgets = [
      { ...active, lines: linesFor(categories, "c2400000") },
      ...more<BudgetState["budgets"][number]>({ ...active, status: "closed", lines: [] }, 20, "c2500000", (index) => ({
        startDate: `2000-${String((index % 12) + 1).padStart(2, "0")}-01`.replace("2000", String(2000 + Math.floor(index / 12))),
        endDate: `2000-${String((index % 12) + 1).padStart(2, "0")}-28`.replace("2000", String(2000 + Math.floor(index / 12))),
        lines: linesFor(categories, `c26${String(index).padStart(5, "0")}`),
      })),
    ];
    return { ...seed, categories, budgets };
  }],
  ["goals", "целей", () => ({ ...seed, goals: [...seed.goals, ...more(seed.goals[0]!, BACKUP_LIMITS.goals + 1 - seed.goals.length, "c2700000")] })],
  ["annualCommitments", "крупных платежей", () => ({ ...seed, annualCommitments: [...seed.annualCommitments, ...more(seed.annualCommitments[0]!, BACKUP_LIMITS.annualCommitments + 1 - seed.annualCommitments.length, "c2800000", () => ({ active: false }))] })],
  ["scheduledExpenses", "регулярных расходов", () => ({ ...seed, scheduledExpenses: [...seed.scheduledExpenses, ...more(seed.scheduledExpenses[0]!, BACKUP_LIMITS.scheduledExpenses + 1 - seed.scheduledExpenses.length, "c2900000", () => ({ active: false }))] })],
  ["members", "участников", () => ({ ...seed, members: more({ id: "", name: "Участник", role: "member" as const, active: true }, BACKUP_LIMITS.members + 1, "c3000000") })],
  ["tags", "меток", () => ({ ...seed, tags: more({ id: "", name: "Метка", active: true }, BACKUP_LIMITS.tags + 1, "c3100000", (index) => ({ name: `Метка ${index}` })) })],
  ["exchangeRates", "курсов валют", () => ({
    ...seed,
    exchangeRates: more({ id: "", currency: "USD", baseCurrency: "RUB", date: "2026-07-01", rate: { baseMinor: 9_000, quoteMinor: 100 } }, BACKUP_LIMITS.exchangeRates + 1, "c3200000"),
  })],
  ["debts", "долгов", () => ({
    ...seed,
    debts: more({ id: "", counterparty: "Сосед", direction: "owed_to_me" as const, currency: "RUB", openingMinor: 0, active: true }, BACKUP_LIMITS.debts + 1, "c3300000", (index) => ({ counterparty: `Сосед ${index}` })),
  })],
  ["recurringRules", "регулярных операций", () => ({
    ...seed,
    recurringRules: more({
      id: "", template: { kind: "expense" as const, amountMinor: 100, accountId: seed.accounts[0]!.id, categoryId: expense.id },
      frequency: "monthly" as const, interval: 1, startDate: "2026-07-05", active: false,
    }, BACKUP_LIMITS.recurringRules + 1, "c3400000"),
  })],
];

const plainExpense = seed.transactions.find((transaction) => transaction.kind === "expense" && !seed.transactions.some((item) => item.kind === "refund" && item.originalTransactionId === transaction.id))!;
const expenseDraft = { kind: "expense" as const, status: "posted" as const, occurredOn: "2026-07-15", amount: "100", accountId: seed.accounts[0]!.id, categoryId: PLANNING_IDS.categories.food };
const commitment = seed.annualCommitments[0]!;
const commitmentDraft = {
  name: commitment.name, categoryId: commitment.categoryId, accountId: commitment.accountId, dueDate: commitment.dueDate,
  amount: "1000", reserved: "0", recurrence: commitment.recurrence,
};
const schedule = seed.scheduledExpenses[0]!;
const scheduleDraft = {
  name: schedule.name, categoryId: schedule.categoryId, accountId: schedule.accountId, amount: "100",
  dueDay: String(schedule.dueDay), mode: schedule.mode, months: schedule.months ?? [],
};

describe("документ за пределом числа записей", () => {
  it("строит каждое состояние за своим пределом", () => {
    const counts = (state: BudgetState) => ({
      lines: Math.max(...state.budgets.map((budget) => budget.lines.length)),
      total: state.budgets.reduce((sum, budget) => sum + budget.lines.length, 0),
    });
    const lines = OVER.find(([key]) => key === "budgets[0].lines")![2]();
    expect(counts(lines).lines).toBeGreaterThan(BACKUP_LIMITS.linesPerBudget);
    const total = OVER.find(([key]) => key === "budget lines")![2]();
    expect(counts(total).lines).toBeLessThanOrEqual(BACKUP_LIMITS.linesPerBudget);
    expect(counts(total).total).toBeGreaterThan(BACKUP_LIMITS.totalBudgetLines);
    expect(total.categories.length).toBeLessThanOrEqual(BACKUP_LIMITS.categories);
  });

  it("воспроизведение ревью: 101 счёт — операции записываются и удаляются, платёж заводится", () => {
    const base = makeSeedBudget();
    const unused = { ...base.categories.find((category) => category.type === "expense")!, id: uuid("c3510000", 1), name: "Без лимита", sortOrder: 999 };
    const state: BudgetState = {
      ...base,
      categories: [...base.categories, unused],
      accounts: [...base.accounts, ...more(base.accounts[0]!, 101 - base.accounts.length, "c3500000")],
    };
    expect(state.accounts).toHaveLength(101);
    expect(() => prepareBudgetState(state)).not.toThrow();
    const recorded = createTransaction(state, { ...expenseDraft, accountId: SEED_IDS.accounts.main, categoryId: SEED_IDS.categories.food }, makeId);
    expect(recorded.transactions).toHaveLength(state.transactions.length + 1);
    expect(deleteTransaction(recorded, recorded.transactions.at(-1)!.id).transactions).toHaveLength(state.transactions.length);
    const planned = createCommitment(state, { ...commitmentDraft, categoryId: SEED_IDS.categories.housing, accountId: SEED_IDS.accounts.main, dueDate: "2026-12-01" }, makeId);
    expect(planned.annualCommitments).toHaveLength(state.annualCommitments.length + 1);
    expect(archiveCategory(state, unused.id).categories.find((item) => item.id === unused.id)?.active).toBe(false);
  });

  it.each(OVER)("%s за пределом: правка, удаление и копия работают, а копию восстановление называет по пределу", async (key, label, build) => {
    const state = build();
    expect(() => prepareBudgetState(state)).not.toThrow();

    // Edits and deletes of every kind the forms touch.
    const edited = editTransaction(state, plainExpense.id, { ...expenseDraft, amount: "777" });
    expect(edited.transactions.find((item) => item.id === plainExpense.id)?.amountMinor).toBe(77_700);
    expect(deleteTransaction(state, plainExpense.id).transactions).toHaveLength(state.transactions.length - 1);
    expect(editCommitment(state, commitment.id, commitmentDraft).annualCommitments.find((item) => item.id === commitment.id)?.amountMinor).toBe(100_000);
    expect(setCommitmentActive(state, commitment.id, false).annualCommitments.find((item) => item.id === commitment.id)?.active).toBe(false);
    expect(editSchedule(state, schedule.id, scheduleDraft).scheduledExpenses.find((item) => item.id === schedule.id)?.amountMinor).toBe(10_000);
    const line = state.budgets.find((budget) => budget.id === state.activeBudgetId)!.lines[0]!;
    expect(archiveFlexibleLine(state, line.id).budgets.find((item) => item.id === state.activeBudgetId)?.lines.find((item) => item.id === line.id)?.active).toBe(false);

    // The copy is written whole; that this build would not restore it is said at once, naming the count.
    const backup = await createBudgetBackup(state, vi.fn(async () => undefined));
    expect(backup.restoreWarning).toContain(label);
    expect(backup.restoreWarning).toContain("Восстановить эту копию эта версия приложения не сможет");
    // A budget past 500 lines has a category per line, so the restore names the categories first.
    const named = key === "budgets[0].lines" ? "categories" : key;
    expect(() => parseAndValidateBudgetBackup(backup.text)).toThrow(`${named}: допускается не более`);
  }, 60_000);

  it("копия в пределах восстанавливается и предупреждения не несёт", async () => {
    const backup = await createBudgetBackup(seed, vi.fn(async () => undefined));
    expect(backup.restoreWarning).toBeNull();
    expect(parseAndValidateBudgetBackup(backup.text)).toEqual(seed);
  });

  it("операций за пределом — правка и удаление работают, новая запись не создаётся, файл копии их не вмещает", async () => {
    const state: BudgetState = {
      ...seed,
      transactions: [...seed.transactions, ...more({ ...plainExpense, status: "pending" as const }, OPERATIONS_LIMITS.transactions + 1 - seed.transactions.length, "c3600000")],
    };
    expect(() => prepareBudgetState(state)).not.toThrow();
    expect(() => createTransaction(state, expenseDraft, makeId)).toThrow("лимит операций");
    expect(deleteTransaction(state, plainExpense.id).transactions).toHaveLength(state.transactions.length - 1);
    expect(editTransaction(state, plainExpense.id, { ...expenseDraft, amount: "1" }).transactions).toHaveLength(state.transactions.length);
    // The file format bounds the whole file — 100 000 nodes, 50 000 entries in a list, 5 MB — so a
    // copy of 50 001 operations cannot be written in it at all; the refusal says so instead of a
    // count of a kind.
    await expect(createBudgetBackup(state, vi.fn(async () => undefined))).rejects.toThrow(/Резервная копия содержит слишком/u);
  }, 60_000);

  it("новую запись вида, которого уже столько, сколько позволено, форма не создаёт", () => {
    const atCategories: BudgetState = { ...seed, categories: categoriesUpTo(PLANNING_LIMITS.categories) };
    expect(() => createOperationCategory(atCategories, { name: "Новая", type: "expense", group: "everyday", limit: "" }, makeId)).toThrow("лимит категорий");
    expect(() => createFlexibleLine(atCategories, { name: "Новая", amount: "100" }, makeId)).toThrow("лимит категорий");

    const atCommitments: BudgetState = { ...seed, annualCommitments: [...seed.annualCommitments, ...more(commitment, PLANNING_LIMITS.commitments - seed.annualCommitments.length, "c3700000", () => ({ active: false }))] };
    expect(() => createCommitment(atCommitments, commitmentDraft, makeId)).toThrow("лимит крупных платежей");
    const atSchedules: BudgetState = { ...seed, scheduledExpenses: [...seed.scheduledExpenses, ...more(schedule, PLANNING_LIMITS.schedules - seed.scheduledExpenses.length, "c3800000", () => ({ active: false }))] };
    expect(() => createSchedule(atSchedules, scheduleDraft, makeId)).toThrow("лимит регулярных платежей");

    const perBudget = OVER.find(([key]) => key === "budgets[0].lines")![2]();
    expect(() => createFlexibleLine(perBudget, { name: "Новая", amount: "100" }, makeId)).toThrow(/лимит/u);
    // Room in the active budget and among the categories, none in all budgets together: one added
    // category and its lines taken out of every budget leave the total still past its limit.
    const total = OVER.find(([key]) => key === "budget lines")![2]();
    const dropped = total.categories.at(-1)!.id;
    const roomInBudget: BudgetState = {
      ...total,
      categories: total.categories.slice(0, -1),
      budgets: total.budgets.map((budget) => ({ ...budget, lines: budget.lines.filter((item) => item.categoryId !== dropped) })),
    };
    expect(roomInBudget.budgets.reduce((sum, budget) => sum + budget.lines.length, 0)).toBeGreaterThanOrEqual(OPERATIONS_LIMITS.totalBudgetLines);
    expect(() => createFlexibleLine(roomInBudget, { name: "Новая", amount: "100" }, makeId)).toThrow("во всех месяцах");
    expect(() => createOperationCategory(roomInBudget, { name: "Новая", type: "expense", group: "everyday", limit: "100" }, makeId))
      .toThrow("Достигнут лимит бюджетных лимитов.");

    const atTags: BudgetState = OVER.find(([key]) => key === "tags")![2]();
    expect(() => createTag(atTags, "Ещё одна", makeId)).toThrow(/предел/u);
    const atDebts: BudgetState = OVER.find(([key]) => key === "debts")![2]();
    expect(() => createDebt(atDebts, { counterparty: "Ещё один", direction: "owed_to_me", currency: "RUB", openingMinor: 0 }, makeId)).toThrow(/предел/u);

    // Growth of another kind is not refused because one kind is over its limit.
    const overAccounts = OVER.find(([key]) => key === "accounts")![2]();
    expect(createTransaction(overAccounts, expenseDraft, makeId).transactions).toHaveLength(overAccounts.transactions.length + 1);
  }, 60_000);
});
