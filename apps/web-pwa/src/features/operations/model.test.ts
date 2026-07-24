import { describe, expect, it } from "vitest";
import {
  archiveCategory,
  calculateOperationsMetrics,
  createTransaction,
  deleteTransaction,
  editTransaction,
  OPERATIONS_LIMITS,
  OperationsValidationError,
  toOperationsErrorView,
  type TransactionDraft,
} from "./model";
import { fixedOperationId, makeG000State, OPERATIONS_TEST_IDS as ids } from "./test-fixture";

const refundDraft = {
  kind: "refund",
  status: "posted",
  occurredOn: "2026-07-07",
  amount: "1500",
  accountId: ids.accounts.main,
  originalTransactionId: ids.transactions.products,
} as const;

const transferDraft = (amount: string) => ({
  kind: "transfer" as const,
  status: "posted" as const,
  occurredOn: "2026-07-08",
  amount,
  fromAccountId: ids.accounts.main,
  toAccountId: ids.accounts.savings,
});

describe("operations canonical financial flow", () => {
  it("matches every exact G-000 value through refund and reversible transfer CRUD", () => {
    let state = makeG000State();
    let metrics = calculateOperationsMetrics(state);
    expect(state.transactions).toHaveLength(4);
    expect(metrics).toMatchObject({ incomeMinor: 10_000_000, expensesMinor: 7_650_000, capitalMinor: 2_350_000 });
    expect(metrics.accountBalancesMinor).toMatchObject({ [ids.accounts.main]: 2_350_000, [ids.accounts.savings]: 0 });
    expect(metrics.categoryMetrics[ids.categories.products]).toMatchObject({ actualMinor: 3_150_000, overMinor: 150_000, status: "over_limit" });

    state = createTransaction(state, refundDraft, fixedOperationId);
    metrics = calculateOperationsMetrics(state);
    expect(state.transactions).toHaveLength(5);
    expect(metrics).toMatchObject({ grossExpensesMinor: 7_650_000, refundsMinor: 150_000, expensesMinor: 7_500_000, capitalMinor: 2_500_000 });
    expect(metrics.categoryMetrics[ids.categories.products]).toMatchObject({ actualMinor: 3_000_000, overMinor: 0, status: "exhausted" });
    expect(metrics.accountBalancesMinor).toMatchObject({ [ids.accounts.main]: 2_500_000, [ids.accounts.savings]: 0 });

    const transferId = "77000000-0000-4000-8000-000000000002";
    state = createTransaction(state, transferDraft("5000"), () => transferId);
    metrics = calculateOperationsMetrics(state);
    expect(state.transactions).toHaveLength(6);
    expect(metrics).toMatchObject({ expensesMinor: 7_500_000, capitalMinor: 2_500_000 });
    expect(metrics.accountBalancesMinor).toMatchObject({ [ids.accounts.main]: 2_000_000, [ids.accounts.savings]: 500_000 });

    state = editTransaction(state, transferId, transferDraft("7000"));
    metrics = calculateOperationsMetrics(state);
    expect(state.transactions).toHaveLength(6);
    expect(state.transactions.at(-1)?.id).toBe(transferId);
    expect(metrics.accountBalancesMinor).toMatchObject({ [ids.accounts.main]: 1_800_000, [ids.accounts.savings]: 700_000 });

    state = deleteTransaction(state, transferId);
    metrics = calculateOperationsMetrics(state);
    expect(state.transactions).toHaveLength(5);
    expect(metrics).toMatchObject({ expensesMinor: 7_500_000, capitalMinor: 2_500_000 });
    expect(metrics.accountBalancesMinor).toMatchObject({ [ids.accounts.main]: 2_500_000, [ids.accounts.savings]: 0 });
  });

  it("matches G-001 goal contribution create/edit/delete without changing capital", () => {
    let state = makeG000State();
    const id = fixedOperationId();
    const contribution = (amount: string) => ({
      kind: "goal_contribution" as const,
      status: "posted" as const,
      occurredOn: "2026-07-07",
      amount,
      fromAccountId: ids.accounts.main,
      toAccountId: ids.accounts.savings,
      goalId: ids.goal,
    });
    state = createTransaction(state, contribution("10000"), () => id);
    let metrics = calculateOperationsMetrics(state);
    expect(state.transactions).toHaveLength(5);
    expect(metrics).toMatchObject({ capitalMinor: 2_350_000, goalContributionMinor: 1_000_000 });
    expect(metrics.accountBalancesMinor).toMatchObject({ [ids.accounts.main]: 1_350_000, [ids.accounts.savings]: 1_000_000 });
    expect(metrics.goalContributionsMinor[ids.goal]).toBe(1_000_000);

    state = editTransaction(state, id, contribution("12000"));
    metrics = calculateOperationsMetrics(state);
    expect(state.transactions).toHaveLength(5);
    expect(metrics.accountBalancesMinor).toMatchObject({ [ids.accounts.main]: 1_150_000, [ids.accounts.savings]: 1_200_000 });
    expect(metrics.goalContributionsMinor[ids.goal]).toBe(1_200_000);

    state = deleteTransaction(state, id);
    metrics = calculateOperationsMetrics(state);
    expect(state.transactions).toHaveLength(4);
    expect(metrics.accountBalancesMinor).toMatchObject({ [ids.accounts.main]: 2_350_000, [ids.accounts.savings]: 0 });
    expect(metrics.goalContributionsMinor[ids.goal]).toBe(0);
  });
});

describe("operation integrity and validation", () => {
  it("creates, edits in place, and deletes income, expense, and refund records", () => {
    const scenarios: readonly { readonly draft: TransactionDraft; readonly edit: TransactionDraft }[] = [
      {
        draft: { kind: "income", status: "draft", occurredOn: "2026-07-09", amount: "100", accountId: ids.accounts.main },
        edit: { kind: "income", status: "posted", occurredOn: "2026-07-10", amount: "200", accountId: ids.accounts.main },
      },
      {
        draft: { kind: "expense", status: "draft", occurredOn: "2026-07-09", amount: "100", accountId: ids.accounts.main, categoryId: ids.categories.housing },
        edit: { kind: "expense", status: "posted", occurredOn: "2026-07-10", amount: "200", accountId: ids.accounts.main, categoryId: ids.categories.housing },
      },
      {
        draft: { ...refundDraft, status: "draft", amount: "100" },
        edit: { ...refundDraft, status: "posted", occurredOn: "2026-07-10", amount: "200" },
      },
    ];
    for (const { draft, edit } of scenarios) {
      const created = createTransaction(makeG000State(), draft, fixedOperationId);
      expect(created.transactions).toHaveLength(5);
      const edited = editTransaction(created, fixedOperationId(), edit);
      expect(edited.transactions).toHaveLength(5);
      expect(edited.transactions.at(-1)).toMatchObject({ id: fixedOperationId(), kind: edit.kind, occurredOn: "2026-07-10", amountMinor: 20_000 });
      const deleted = deleteTransaction(edited, fixedOperationId());
      expect(deleted.transactions).toHaveLength(4);
      expect(deleted.transactions.some((item) => item.id === fixedOperationId())).toBe(false);
      expect(() => calculateOperationsMetrics(deleted)).not.toThrow();
    }
  });

  it("derives refund category, permits an excess refund, and protects the source expense", () => {
    let state = createTransaction(
      makeG000State(),
      { ...refundDraft, amount: "40000" },
      fixedOperationId,
    );
    const refund = state.transactions.at(-1);
    expect(refund).toMatchObject({ kind: "refund", categoryId: ids.categories.products, originalTransactionId: ids.transactions.products });
    expect(calculateOperationsMetrics(state)).toMatchObject({
      grossExpensesMinor: 7_650_000,
      refundsMinor: 4_000_000,
      expensesMinor: 3_650_000,
      capitalMinor: 6_350_000,
      categoryMetrics: {
        [ids.categories.products]: {
          expenseMinor: 3_150_000,
          refundMinor: 4_000_000,
          actualMinor: -850_000,
          remainingMinor: 3_850_000,
          overMinor: 0,
          status: "normal",
        },
      },
    });

    expect(() => deleteTransaction(state, ids.transactions.products)).toThrow("связанные возвраты");
    expect(() => editTransaction(state, ids.transactions.products, {
      kind: "expense", status: "posted", occurredOn: "2026-07-06", amount: "31500",
      accountId: ids.accounts.main, categoryId: ids.categories.housing,
    })).toThrow("тип, категорию или статус");
    expect(() => editTransaction(state, ids.transactions.products, {
      kind: "income", status: "posted", occurredOn: "2026-07-06", amount: "31500", accountId: ids.accounts.main,
    })).toThrow("тип, категорию или статус");
    expect(() => editTransaction(state, ids.transactions.products, {
      kind: "expense", status: "pending", occurredOn: "2026-07-06", amount: "31500",
      accountId: ids.accounts.main, categoryId: ids.categories.products,
    })).toThrow("тип, категорию или статус");
    expect(() => editTransaction(state, ids.transactions.products, {
      kind: "expense", status: "posted", occurredOn: "2026-07-07", amount: "31500",
      accountId: ids.accounts.main, categoryId: ids.categories.products,
    })).toThrow("дату расхода");

    state = editTransaction(state, ids.transactions.products, {
      kind: "expense", status: "posted", occurredOn: "2026-07-06", amount: "1000",
      accountId: ids.accounts.main, categoryId: ids.categories.products,
    });
    expect(calculateOperationsMetrics(state).categoryMetrics[ids.categories.products]).toMatchObject({
      expenseMinor: 100_000,
      refundMinor: 4_000_000,
      actualMinor: -3_900_000,
    });
  });

  it("requires a refund date on or after its source expense and accepts the same date boundary", () => {
    expect(() => createTransaction(
      makeG000State(),
      { ...refundDraft, occurredOn: "2026-07-05" },
      fixedOperationId,
    )).toThrow("раньше даты исходного расхода");

    const sameDay = createTransaction(
      makeG000State(),
      { ...refundDraft, occurredOn: "2026-07-06" },
      fixedOperationId,
    );
    expect(sameDay.transactions.at(-1)?.occurredOn).toBe("2026-07-06");

    expect(() => editTransaction(
      sameDay,
      fixedOperationId(),
      { ...refundDraft, occurredOn: "2026-07-05" },
    )).toThrow("раньше даты исходного расхода");
  });

  it("blocks archiving categories used by active planning and preserves exact G-000 metrics", () => {
    const state = makeG000State();
    const before = calculateOperationsMetrics(state).categoryMetrics[ids.categories.products];
    expect(before).toMatchObject({
      availableMinor: 3_000_000,
      actualMinor: 3_150_000,
      overMinor: 150_000,
      status: "over_limit",
    });
    expect(() => archiveCategory(state, ids.categories.products)).toThrow(
      "Сначала отключите активные лимиты",
    );
    expect(state.categories.find((item) => item.id === ids.categories.products)?.active).toBe(true);
    expect(calculateOperationsMetrics(state).categoryMetrics[ids.categories.products]).toEqual(before);
  });

  it("blocks a category used by an active line in a non-active future budget without mutating the plan", () => {
    const source = makeG000State();
    const state = {
      ...source,
      budgets: [
        {
          ...source.budgets[0]!,
          lines: source.budgets[0]!.lines.map((line) => line.categoryId === ids.categories.products
            ? { ...line, active: false }
            : line),
        },
        {
          id: "33000000-0000-4000-8000-000000000002",
          startDate: "2027-07-01",
          endDate: "2027-07-31",
          status: "draft" as const,
          plannedIncomeMinor: 11_000_000,
          warningThreshold: 0.8,
          lines: [{
            id: "44000000-0000-4000-8000-000000000003",
            categoryId: ids.categories.products,
            plannedMinor: 3_500_000,
            active: true,
          }],
        },
      ],
    };
    const exactPlan = structuredClone(state);
    const exactMetrics = calculateOperationsMetrics(state);

    expect(() => archiveCategory(state, ids.categories.products)).toThrow(
      "Сначала отключите активные лимиты",
    );
    expect(state).toEqual(exactPlan);
    expect(state.activeBudgetId).toBe(ids.budget);
    expect(state.budgets[1]?.lines[0]).toMatchObject({
      categoryId: ids.categories.products,
      plannedMinor: 3_500_000,
      active: true,
    });
    expect(calculateOperationsMetrics(state)).toEqual(exactMetrics);
  });

  it("blocks active schedules and commitments, then archives without deleting history", () => {
    const source = makeG000State();
    const inactiveLine = {
      ...source,
      budgets: source.budgets.map((budget) => ({
        ...budget,
        lines: budget.lines.map((line) => line.categoryId === ids.categories.products
          ? { ...line, active: false }
          : line),
      })),
    };
    const withSchedule = {
      ...inactiveLine,
      scheduledExpenses: [{
        id: "88000000-0000-4000-8000-000000000001",
        name: "Продукты",
        categoryId: ids.categories.products,
        accountId: ids.accounts.main,
        amountMinor: 100,
        dueDay: 1,
        mode: "monthly" as const,
        active: true,
      }],
    };
    expect(() => archiveCategory(withSchedule, ids.categories.products)).toThrow(
      "Сначала отключите активные лимиты",
    );

    const withCommitment = {
      ...inactiveLine,
      annualCommitments: [{
        id: "88000000-0000-4000-8000-000000000002",
        name: "Закупка",
        categoryId: ids.categories.products,
        accountId: ids.accounts.main,
        dueDate: "2027-01-01",
        amountMinor: 100,
        reservedMinor: 0,
        recurrence: "annual" as const,
        active: true,
      }],
    };
    expect(() => archiveCategory(withCommitment, ids.categories.products)).toThrow(
      "Сначала отключите активные лимиты",
    );

    let state = archiveCategory(inactiveLine, ids.categories.products);
    expect(state.categories.find((item) => item.id === ids.categories.products)?.active).toBe(false);
    expect(state.transactions.find((item) => item.id === ids.transactions.products)).toBeDefined();
    state = editTransaction(state, ids.transactions.products, {
      kind: "expense", status: "posted", occurredOn: "2026-07-06", amount: "31000",
      accountId: ids.accounts.main, categoryId: ids.categories.products,
    });
    expect(state.transactions).toHaveLength(4);
    expect(() => createTransaction(state, {
      kind: "expense", status: "posted", occurredOn: "2026-07-09", amount: "1",
      accountId: ids.accounts.main, categoryId: ids.categories.products,
    }, fixedOperationId)).toThrow("активную категорию");
  });

  it("requires active refs for new records but allows unchanged historical archived accounts and goals", () => {
    const archived = {
      ...makeG000State(),
      accounts: makeG000State().accounts.map((item) => ({ ...item, active: false })),
      goals: makeG000State().goals.map((item) => ({ ...item, status: "cancelled" as const })),
    };
    expect(() => createTransaction(archived, {
      kind: "income", status: "posted", occurredOn: "2026-07-09", amount: "1", accountId: ids.accounts.main,
    }, fixedOperationId)).toThrow("активный счёт");
    const edited = editTransaction(archived, ids.transactions.income, {
      kind: "income", status: "posted", occurredOn: "2026-07-02", amount: "100000", accountId: ids.accounts.main,
    });
    expect(edited.transactions[0]?.occurredOn).toBe("2026-07-02");
  });

  it("safely surfaces a stored refund that predates its source through shared domain validation", () => {
    const valid = createTransaction(makeG000State(), refundDraft, fixedOperationId);
    const corrupt = {
      ...valid,
      transactions: valid.transactions.map((transaction) =>
        transaction.id === fixedOperationId()
          ? { ...transaction, occurredOn: "2026-07-05" }
          : transaction),
    };

    expect(() => calculateOperationsMetrics(corrupt)).toThrowError(
      new OperationsValidationError(
        "document",
        "Документ бюджета повреждён или содержит несогласованные связи.",
      ),
    );
  });

  it("rejects same-account, invalid refund sources, malformed/colliding IDs, dates, statuses and amounts", () => {
    const state = makeG000State();
    const invalids: readonly TransactionDraft[] = [
      { ...transferDraft("1"), toAccountId: ids.accounts.main },
      { ...refundDraft, originalTransactionId: ids.transactions.income },
      { ...refundDraft, originalTransactionId: "not-an-id" },
      { ...refundDraft, occurredOn: "2026-02-30" },
      { ...refundDraft, amount: "0" },
      { ...refundDraft, amount: "1.001" },
      { ...refundDraft, amount: "9".repeat(25) },
      { ...refundDraft, status: "posted " as "posted" },
    ];
    for (const draft of invalids) expect(() => createTransaction(state, draft, fixedOperationId)).toThrow(OperationsValidationError);
    expect(() => createTransaction(state, refundDraft, () => ids.accounts.main)).toThrow("уникальный");
    expect(() => editTransaction(state, "__proto__", refundDraft)).toThrow("идентификатор");
    expect(toOperationsErrorView(new Error("secret storage path /Users/x"))).toEqual({ field: "form", message: "Не удалось сохранить операцию." });
  });

  it("does not persist undeclared note fields and aligns all resource bounds with backup acceptance", () => {
    expect(OPERATIONS_LIMITS).toEqual({
      accounts: 100,
      categories: 500,
      budgets: 240,
      linesPerBudget: 500,
      totalBudgetLines: 10_000,
      goals: 200,
      commitments: 1_000,
      schedules: 1_000,
      transactions: 50_000,
    });
    const withNote = {
      kind: "income", status: "posted", occurredOn: "2026-07-09", amount: "1",
      accountId: ids.accounts.main, notes: "=WEBSERVICE(\"https://example.invalid\")".repeat(10_000),
    } as TransactionDraft & { readonly notes: string };
    const created = createTransaction(makeG000State(), withNote, fixedOperationId);
    expect(created.transactions.at(-1)).not.toHaveProperty("notes");

    const state = makeG000State();
    const extra = Array.from({ length: 49_996 }, (_, index) => ({
      id: `88000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      kind: "income" as const,
      status: "pending" as const,
      occurredOn: "2026-07-09",
      amountMinor: 1,
      accountId: ids.accounts.main,
    }));
    const atLimit = { ...state, transactions: [...state.transactions, ...extra] };
    expect(atLimit.transactions).toHaveLength(50_000);
    expect(() => createTransaction(atLimit, withNote, () => "99000000-0000-4000-8000-000000000001")).toThrow("лимит операций");
  });

  it("enforces global UUID uniqueness even for pre-existing cross-entity collisions", () => {
    const source = makeG000State();
    const corrupt = { ...source, goals: source.goals.map((goal) => ({ ...goal, id: ids.accounts.main })) };
    expect(() => calculateOperationsMetrics(corrupt)).toThrow("повторяющийся");
  });
});

describe("budget status boundaries", () => {
  function statusFor(amountMinor: number, plannedMinor = 3_000_000) {
    const state = makeG000State();
    const transactions = amountMinor === 0
      ? state.transactions.filter((item) => item.id !== ids.transactions.products)
      : state.transactions.map((item) => item.id === ids.transactions.products && item.kind === "expense" ? { ...item, amountMinor } : item);
    const budgets = state.budgets.map((budget) => ({ ...budget, lines: budget.lines.map((line) => line.categoryId === ids.categories.products ? { ...line, plannedMinor } : line) }));
    return calculateOperationsMetrics({ ...state, transactions, budgets }).categoryMetrics[ids.categories.products];
  }

  it("distinguishes 80%, 100%, 100% plus one kopeck, and zero plan", () => {
    expect(statusFor(2_399_999)).toMatchObject({ status: "normal" });
    expect(statusFor(2_400_000)).toMatchObject({ status: "near_limit" });
    expect(statusFor(3_000_000)).toMatchObject({ status: "exhausted", overMinor: 0 });
    expect(statusFor(3_000_001)).toMatchObject({ status: "over_limit", overMinor: 1 });
    expect(statusFor(1, 0)).toMatchObject({ status: "over_limit", overMinor: 1, execution: null });
    expect(statusFor(0, 0)).toMatchObject({ status: "no_plan", overMinor: 0, execution: null });
  });

  it("does not count pending or draft operations until posted", () => {
    for (const status of ["pending", "draft"] as const) {
      const state = createTransaction(makeG000State(), { ...transferDraft("5000"), status }, fixedOperationId);
      const metrics = calculateOperationsMetrics(state);
      expect(metrics.accountBalancesMinor).toMatchObject({ [ids.accounts.main]: 2_350_000, [ids.accounts.savings]: 0 });
    }
  });
});
