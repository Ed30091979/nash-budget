import { calculateBudget, makeDefaultCategories, type BudgetState } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import { classifyStatement, merchantKey } from "./classify";
import { amountInput, applyImportPlan, buildImportPlan, undoImport, type ImportChoices } from "./plan";
import { parseStatement } from "./statement";
import { SAMPLE_EXPECTED, sampleStatementBytes } from "./test-fixture";

const ids = {
  accounts: { main: "11000000-0000-4000-8000-000000000001", savings: "11000000-0000-4000-8000-000000000002" },
  budget: "33000000-0000-4000-8000-000000000001",
} as const;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `bbbbbbbb-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

/** Семья после онбординга: два счёта, 23 категории, месяц плана — август 2026, записей нет. */
function household(): BudgetState {
  return {
    activeBudgetId: ids.budget,
    accounts: [
      { id: ids.accounts.main, name: "Основной", type: "current", currency: "RUB", openingBalanceMinor: 0, active: true },
      { id: ids.accounts.savings, name: "Накопительный", type: "savings", currency: "RUB", openingBalanceMinor: 0, active: true },
    ],
    categories: makeDefaultCategories(nextId),
    budgets: [{ id: ids.budget, startDate: "2026-08-01", endDate: "2026-08-31", status: "open", plannedIncomeMinor: 0, warningThreshold: 0.8, lines: [] }],
    goals: [],
    annualCommitments: [],
    scheduledExpenses: [],
    transactions: [],
  };
}

function choices(overrides: Partial<ImportChoices> = {}): ImportChoices {
  return { accountId: ids.accounts.main, transferAccountId: null, assignments: {}, includeDuplicates: false, ...overrides };
}

const NOW = new Date("2026-09-01T10:00:00.000Z");

describe("план импорта", () => {
  it("не делает перевод себе тратой и приход расходом, а незнакомое без назначения — не добавляет", () => {
    const state = household();
    const { rows } = classifyStatement(parseStatement(sampleStatementBytes()).operations, state);
    const plan = buildImportPlan(rows, state, choices(), NOW);

    expect(plan.counts).toMatchObject({ included: 9, expenses: 7, incomes: 2, transfers: 0, unassigned: 3, selfTransfersExcluded: 2, duplicates: 0, outsidePeriod: 0 });
    // Переводы себе — 15 000 туда и 15 000 обратно — не попали ни в траты, ни в доходы.
    expect(plan.totals.selfTransferExcludedMinor).toBe(3_000_000);
    // Из расходов файла вычтены только перевод себе и три незнакомые строки без назначения.
    expect(plan.totals.expenseMinor).toBe(SAMPLE_EXPECTED.outMinor - 1_500_000 - 319_990 - 99_000 - 300_000);
    expect(plan.totals.incomeMinor).toBe(SAMPLE_EXPECTED.inMinor - 1_500_000);
    expect(plan.drafts.every((draft) => draft.kind !== "transfer")).toBe(true);
    expect(plan.drafts.filter((draft) => draft.kind === "income")).toHaveLength(2);
    expect(plan.memoryUpdates).toEqual([]);
  });

  it("назначенная вручную категория применяется ко второму такому же продавцу и запоминается", () => {
    const state = household();
    const home = state.categories.find((category) => category.name === "Дом и хозяйство")!;
    const rent = state.categories.find((category) => category.name === "Жильё")!;
    const { rows } = classifyStatement(parseStatement(sampleStatementBytes()).operations, state);
    const plan = buildImportPlan(rows, state, choices({
      assignments: {
        [merchantKey('ООО "Ромашка"')]: { kind: "category", categoryId: home.id },
        [merchantKey("Перевод по номеру телефона Мария П.")]: { kind: "category", categoryId: rent.id },
      },
    }), NOW);

    expect(plan.counts.unassigned).toBe(0);
    expect(plan.counts.included).toBe(12);
    const homeDrafts = plan.drafts.filter((draft) => draft.kind === "expense" && draft.categoryId === home.id);
    expect(homeDrafts.map((draft) => draft.amount).sort()).toEqual(["3199.90", "990"]);
    expect(plan.memoryUpdates).toEqual([
      { key: "ооо ромашка", categoryName: "Дом и хозяйство", type: "expense", updatedAt: NOW.toISOString() },
      { key: "перевод по номеру телефона мария п", categoryName: "Жильё", type: "expense", updatedAt: NOW.toISOString() },
    ]);
  });

  it("«Пропустить» не добавляет и не запоминает; переводы себе становятся переводами, если назван второй счёт", () => {
    const state = household();
    const { rows } = classifyStatement(parseStatement(sampleStatementBytes()).operations, state);
    const plan = buildImportPlan(rows, state, choices({
      transferAccountId: ids.accounts.savings,
      assignments: { [merchantKey('ООО "Ромашка"')]: { kind: "skip" } },
    }), NOW);

    expect(plan.counts).toMatchObject({ skipped: 2, unassigned: 1, transfers: 2, selfTransfersExcluded: 0 });
    const transfers = plan.drafts.filter((draft) => draft.kind === "transfer");
    expect(transfers).toEqual([
      { kind: "transfer", status: "posted", occurredOn: "2026-08-04", amount: "15000", fromAccountId: ids.accounts.main, toAccountId: ids.accounts.savings },
      { kind: "transfer", status: "posted", occurredOn: "2026-08-20", amount: "15000", fromAccountId: ids.accounts.savings, toAccountId: ids.accounts.main },
    ]);
    expect(plan.memoryUpdates).toEqual([]);
  });

  it("узнаёт уже записанные операции и не удваивает их, пока человек не попросит", () => {
    const state = household();
    const { rows } = classifyStatement(parseStatement(sampleStatementBytes()).operations, state);
    const first = applyImportPlan(state, buildImportPlan(rows, state, choices(), NOW).drafts, nextId);
    expect(first.ids).toHaveLength(9);

    const again = buildImportPlan(rows, first.state, choices(), NOW);
    expect(again.counts).toMatchObject({ included: 0, duplicates: 9, duplicateCandidates: 9, unassigned: 3 });
    const forced = buildImportPlan(rows, first.state, choices({ includeDuplicates: true }), NOW);
    // Похожие остаются названными и после включения: переключатель обязан пережить своё нажатие.
    expect(forced.counts).toMatchObject({ included: 9, duplicates: 0, duplicateCandidates: 9 });
  });

  it("добавляет пачкой тем же путём, что ручная запись, и отменяет ровно её", () => {
    const state = household();
    const products = state.categories.find((category) => category.name === "Продукты")!;
    const { rows } = classifyStatement(parseStatement(sampleStatementBytes()).operations, state);
    const plan = buildImportPlan(rows, state, choices(), NOW);
    const applied = applyImportPlan(state, plan.drafts, nextId);

    expect(applied.state.transactions).toHaveLength(9);
    const metrics = calculateBudget(applied.state);
    expect(metrics.categoryMetrics[products.id]?.expenseMinor).toBe(123_456 + 256_000);
    expect(metrics.incomeMinor).toBe(12_000_000 + 35_025);
    expect(metrics.expensesMinor).toBe(plan.totals.expenseMinor);
    // Отмена возвращает состояние побайтно.
    expect(JSON.stringify(undoImport(applied.state, applied.ids))).toBe(JSON.stringify(state));
  });

  it("считает записи вне месяца плана и не отбрасывает их", () => {
    const state = { ...household(), budgets: [{ ...household().budgets[0]!, startDate: "2026-09-01", endDate: "2026-09-30" }] };
    const { rows } = classifyStatement(parseStatement(sampleStatementBytes()).operations, state);
    const plan = buildImportPlan(rows, state, choices(), NOW);
    expect(plan.counts.outsidePeriod).toBe(plan.counts.included);
  });

  it("переводит копейки в строку суммы без потерь", () => {
    expect(amountInput(123_456)).toBe("1234.56");
    expect(amountInput(99_000)).toBe("990");
    expect(amountInput(5)).toBe("0.05");
  });
});
