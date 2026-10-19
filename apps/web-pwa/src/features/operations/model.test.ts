import { describe, expect, it } from "vitest";
import { MAX_TAGS_PER_TRANSACTION, NOTE_MAX_LENGTH } from "@family-budget/domain";
import {
  archiveCategory,
  calculateOperationsMetrics,
  createTransaction,
  DEBT_EDIT_REFUSAL,
  deleteTransaction,
  editTransaction,
  missingRateMessage,
  OPERATIONS_LIMITS,
  OperationsValidationError,
  recreateTransaction,
  restoreTransaction,
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
        draft: { kind: "income", categoryId: "", status: "draft", occurredOn: "2026-07-09", amount: "100", accountId: ids.accounts.main },
        edit: { kind: "income", categoryId: "", status: "posted", occurredOn: "2026-07-10", amount: "200", accountId: ids.accounts.main },
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
      kind: "income", categoryId: "", status: "posted", occurredOn: "2026-07-06", amount: "31500", accountId: ids.accounts.main,
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

  it("a limit in a closed month blocks the operation form's archive, but not the categories screen's", () => {
    const source = makeG000State();
    const closed = { ...source, budgets: source.budgets.map((budget) => ({ ...budget, status: "closed" as const })) };
    expect(closed.budgets.some((budget) => budget.lines.some((line) => line.categoryId === ids.categories.products && line.active !== false))).toBe(true);
    expect(() => archiveCategory(closed, ids.categories.products)).toThrow("Сначала отключите активные лимиты");
    const archived = archiveCategory(closed, ids.categories.products, { closedMonthsKeepLimits: true });
    expect(archived.categories.find((item) => item.id === ids.categories.products)?.active).toBe(false);
    expect(archived.budgets).toEqual(closed.budgets);
    expect(() => archiveCategory(source, ids.categories.products, { closedMonthsKeepLimits: true })).toThrow("Сначала отключите активные лимиты");
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
      kind: "income", categoryId: "", status: "posted", occurredOn: "2026-07-09", amount: "1", accountId: ids.accounts.main,
    }, fixedOperationId)).toThrow("активный счёт");
    const edited = editTransaction(archived, ids.transactions.income, {
      kind: "income", categoryId: "", status: "posted", occurredOn: "2026-07-02", amount: "100000", accountId: ids.accounts.main,
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
      kind: "income", categoryId: "", status: "posted", occurredOn: "2026-07-09", amount: "1",
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

describe("правка операции не теряет того, чего форма не знает", () => {
  const MEMBER = "99000000-0000-4000-8000-0000000000b1";
  const TAG_HOME = "99000000-0000-4000-8000-0000000000c1";
  const TAG_HOLIDAY = "99000000-0000-4000-8000-0000000000c2";

  /** G-000 с участником и двумя метками; расход на продукты помечен всем сразу. */
  function labelledState() {
    const state = makeG000State();
    return {
      ...state,
      members: [{ id: MEMBER, name: "Аня", role: "owner" as const, active: true }],
      tags: [
        { id: TAG_HOME, name: "Дом", active: true },
        { id: TAG_HOLIDAY, name: "Отпуск", active: false },
      ],
      transactions: state.transactions.map((transaction) => (
        transaction.id === ids.transactions.products
          ? { ...transaction, memberId: MEMBER, note: "Пятёрочка у дома", tagIds: [TAG_HOLIDAY, TAG_HOME] }
          : transaction
      )),
    };
  }

  it("переносит участника и правило, а заметку и метки берёт из черновика листа", () => {
    const state = labelledState();
    const before = state.transactions.find((item) => item.id === ids.transactions.products)!;
    const edited = editTransaction(state, ids.transactions.products, {
      kind: "expense",
      status: "posted",
      occurredOn: before.occurredOn,
      amount: "31000",
      accountId: ids.accounts.main,
      categoryId: ids.categories.products,
      note: "Пятёрочка у дома",
      // Метка в архиве остаётся на операции, которая её уже несла.
      tagIds: [TAG_HOME, TAG_HOLIDAY],
    });
    const after = edited.transactions.find((item) => item.id === ids.transactions.products)!;

    // Метки хранятся одним порядком (`normalizeTagIds`): тот же набор — то же поле на любом устройстве.
    expect(after).toMatchObject({ amountMinor: 3_100_000, memberId: MEMBER, note: "Пятёрочка у дома", tagIds: [TAG_HOME, TAG_HOLIDAY] });
    expect(after).toEqual({ ...before, amountMinor: 3_100_000, tagIds: [TAG_HOME, TAG_HOLIDAY] });
    // Лист показывает заметку и метки: стёртые в нём — стёрты и в операции. Участник остаётся.
    const cleared = editTransaction(state, ids.transactions.products, {
      kind: "expense", status: "posted", occurredOn: before.occurredOn, amount: "31000", accountId: ids.accounts.main, categoryId: ids.categories.products,
    }).transactions.find((item) => item.id === ids.transactions.products)!;
    expect(cleared.memberId).toBe(MEMBER);
    expect(Object.hasOwn(cleared, "note")).toBe(false);
    expect(Object.hasOwn(cleared, "tagIds")).toBe(false);
  });

  it("сохраняет участника и при смене вида операции, а у непомеченной ничего не появляется", () => {
    const state = labelledState();
    const edited = editTransaction(state, ids.transactions.products, {
      kind: "transfer",
      status: "posted",
      occurredOn: "2026-07-05",
      amount: "100",
      fromAccountId: ids.accounts.main,
      toAccountId: ids.accounts.savings,
      note: "Пятёрочка у дома",
      tagIds: [TAG_HOME],
    });
    expect(edited.transactions.find((item) => item.id === ids.transactions.products))
      .toMatchObject({ kind: "transfer", memberId: MEMBER, note: "Пятёрочка у дома", tagIds: [TAG_HOME] });

    const income = state.transactions.find((item) => item.id === ids.transactions.income)!;
    const plain = editTransaction(state, ids.transactions.income, {
      kind: "income", categoryId: "", status: "posted", occurredOn: income.occurredOn, amount: "1", accountId: ids.accounts.main,
    }).transactions.find((item) => item.id === ids.transactions.income)!;
    for (const field of ["memberId", "note", "tagIds", "recurringRuleId"]) {
      expect(Object.hasOwn(plain, field), field).toBe(false);
    }
  });

  it("записывает заметку и метки новой операции по правилу ввода домена", () => {
    const state = labelledState();
    const draft: TransactionDraft = {
      kind: "expense", status: "posted", occurredOn: "2026-07-12", amount: "250", accountId: ids.accounts.main, categoryId: ids.categories.products,
      note: "  кофе \u0627\u0644\u0642\u0647\u0648\u0629  ", tagIds: [TAG_HOME, TAG_HOME],
    };
    const created = createTransaction(state, draft, fixedOperationId).transactions.at(-1)!;
    // Обрезка краёв, текст справа налево — законный текст; повтор метки свёрнут.
    expect(created).toMatchObject({ note: "кофе \u0627\u0644\u0642\u0647\u0648\u0629", tagIds: [TAG_HOME] });
    // Пустая заметка — нет заметки, пустой список меток — нет поля.
    const bare = createTransaction(state, { ...draft, note: "   ", tagIds: [] }, fixedOperationId).transactions.at(-1)!;
    expect(Object.hasOwn(bare, "note")).toBe(false);
    expect(Object.hasOwn(bare, "tagIds")).toBe(false);
    const refusal = (patch: Partial<TransactionDraft>) => {
      try {
        createTransaction(state, { ...draft, ...patch } as TransactionDraft, fixedOperationId);
      } catch (error) {
        return error instanceof OperationsValidationError ? `${error.field}: ${error.message}` : String(error);
      }
      return "accepted";
    };
    expect(refusal({ note: "я".repeat(NOTE_MAX_LENGTH + 1) })).toBe(`note: Комментарий — не больше ${NOTE_MAX_LENGTH} символов.`);
    expect(refusal({ note: "кофе\u202e" })).toBe("note: Уберите из комментария скрытые или служебные символы.");
    expect(refusal({ note: "две\nстроки" })).toBe("note: Уберите из комментария скрытые или служебные символы.");
    expect(refusal({ tagIds: [TAG_HOLIDAY] })).toBe("tagIds: Метка «Отпуск» в архиве.");
    expect(refusal({ tagIds: ["99000000-0000-4000-8000-0000000000ff"] })).toMatch(/^tagIds: Метка не найдена/u);
    const many = Array.from({ length: MAX_TAGS_PER_TRANSACTION + 1 }, (_unused, index) => `99000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`);
    const crowded = { ...state, tags: [...state.tags, ...many.map((id, index) => ({ id, name: `Метка ${index}`, active: true }))] };
    expect(() => createTransaction(crowded, { ...draft, tagIds: many }, fixedOperationId))
      .toThrow(expect.objectContaining({ field: "tagIds", message: `Не больше ${MAX_TAGS_PER_TRANSACTION} меток на одной операции.` }));
  });

  it("не выдумывает меток новой операции и считает метку занятым идентификатором", () => {
    const state = labelledState();
    const created = createTransaction(state, {
      kind: "expense", status: "posted", occurredOn: "2026-07-09", amount: "1", accountId: ids.accounts.main, categoryId: ids.categories.products,
    }, fixedOperationId);
    const added = created.transactions.at(-1)!;
    expect(Object.hasOwn(added, "tagIds")).toBe(false);
    expect(Object.hasOwn(added, "memberId")).toBe(false);
    expect(() => createTransaction(state, {
      kind: "expense", status: "posted", occurredOn: "2026-07-09", amount: "1", accountId: ids.accounts.main, categoryId: ids.categories.products,
    }, () => TAG_HOME)).toThrow("уникальный");
  });
});

describe("operation date window", () => {
  it("takes a date the family journal carries and refuses one past it, naming the field", () => {
    const state = makeG000State();
    const draft = (occurredOn: string): TransactionDraft => ({ ...transferDraft("100"), occurredOn });
    expect(() => createTransaction(state, draft("2199-12-31"), fixedOperationId)).not.toThrow();
    expect(() => createTransaction(state, draft("1900-01-01"), fixedOperationId)).not.toThrow();
    for (const occurredOn of ["2200-01-01", "1899-12-31", "9999-12-31"]) {
      expect(() => createTransaction(state, draft(occurredOn), fixedOperationId)).toThrow(
        expect.objectContaining({ field: "occurredOn", message: "Выберите дату с 1900 по 2199 год." }),
      );
    }
  });
});

describe("operations in another currency", () => {
  const DOLLARS = "8c000000-0000-4000-8000-0000000000a2";
  const DOLLAR_EXPENSE = "8d000000-0000-4000-8000-000000000003";

  /** G-000 with a dollar account and one purchase on it, as a backup or another device brings them. */
  function withDollars() {
    const state = makeG000State();
    return {
      ...state,
      accounts: [...state.accounts, { id: DOLLARS, name: "Доллары", type: "savings" as const, currency: "USD", openingBalanceMinor: 50_000, active: true }],
      transactions: [...state.transactions, {
        id: DOLLAR_EXPENSE, occurredOn: "2026-07-10", status: "posted" as const, kind: "expense" as const, amountMinor: 4_000,
        accountId: DOLLARS, categoryId: ids.categories.products,
        baseAmountMinor: 360_000, baseCurrency: "RUB", rate: { baseMinor: 9_000, quoteMinor: 100 },
      }],
    };
  }

  const RATE_JULY = { id: "8e100000-0000-4000-8000-0000000000e1", currency: "USD", baseCurrency: "RUB", date: "2026-07-01", rate: { baseMinor: 9_000, quoteMinor: 100 } };
  const RATE_LATER = { id: "8e100000-0000-4000-8000-0000000000e2", currency: "USD", baseCurrency: "RUB", date: "2026-07-15", rate: { baseMinor: 9_500, quoteMinor: 100 } };

  it("записывает расход по долларовому счёту с курсом дня, а без курса отказывает словами", () => {
    const state = withDollars();
    const expense: TransactionDraft = { kind: "expense", status: "posted", occurredOn: "2026-07-11", amount: "12,50", accountId: DOLLARS, categoryId: ids.categories.products };
    expect(() => createTransaction(state, expense, fixedOperationId)).toThrow(
      expect.objectContaining({ field: "baseAmount", message: missingRateMessage("USD", "RUB", "2026-07-11") }),
    );
    expect(missingRateMessage("USD", "RUB", "2026-07-11")).toBe("Курса USD на 11\u00a0июля нет. Задайте курс или впишите сумму в RUB вручную.");
    const priced = { ...state, exchangeRates: [RATE_JULY, RATE_LATER] };
    const written = createTransaction(priced, expense, fixedOperationId).transactions.at(-1)!;
    expect(written).toMatchObject({ amountMinor: 1_250, baseAmountMinor: 112_500, baseCurrency: "RUB", rate: RATE_JULY.rate });
    // Позже — курс своего дня.
    expect(createTransaction(priced, { ...expense, occurredOn: "2026-07-20" }, fixedOperationId).transactions.at(-1))
      .toMatchObject({ baseAmountMinor: 118_750, rate: RATE_LATER.rate });
    // A rouble operation beside it records as before, without a snapshot.
    const rouble = createTransaction(state, transferDraft("100"), fixedOperationId).transactions.at(-1)!;
    expect(Object.hasOwn(rouble, "baseAmountMinor")).toBe(false);
  });

  it("сумма в рублях вручную — точный курс «сумма за сумму», и курс тогда не нужен", () => {
    const state = withDollars();
    const expense: TransactionDraft = { kind: "expense", status: "posted", occurredOn: "2026-07-11", amount: "12,50", accountId: DOLLARS, categoryId: ids.categories.products, baseAmount: "1 157" };
    const written = createTransaction(state, expense, fixedOperationId).transactions.at(-1)!;
    expect(written).toMatchObject({ amountMinor: 1_250, baseAmountMinor: 115_700, rate: { baseMinor: 115_700, quoteMinor: 1_250 } });
    expect(calculateOperationsMetrics(createTransaction(state, expense, fixedOperationId)).categoryMetrics[ids.categories.products]?.expenseMinor)
      .toBe(calculateOperationsMetrics(state).categoryMetrics[ids.categories.products]!.expenseMinor + 115_700);
    expect(() => createTransaction(state, { ...expense, baseAmount: "0" }, fixedOperationId)).toThrow(expect.objectContaining({ field: "baseAmount" }));
    // На рублёвом счёте поле не значит ничего: сумма и есть цифра.
    const rouble = createTransaction(state, { ...expense, accountId: ids.accounts.main }, fixedOperationId).transactions.at(-1)!;
    expect(rouble.amountMinor).toBe(1_250);
    expect(Object.hasOwn(rouble, "rate")).toBe(false);
  });

  it("перевод между валютами требует суммы зачисления в валюте счёта назначения", () => {
    const state = withDollars();
    const transfer: TransactionDraft = { ...transferDraft("9000"), toAccountId: DOLLARS };
    expect(() => createTransaction(state, transfer, fixedOperationId)).toThrow(
      expect.objectContaining({ field: "toAmount", message: "Впишите, сколько пришло на счёт «Доллары», в USD." }),
    );
    const written = createTransaction(state, { ...transfer, toAmount: "100" }, fixedOperationId).transactions.at(-1)!;
    expect(written).toMatchObject({ kind: "transfer", amountMinor: 900_000, toAmountMinor: 10_000 });
    // В одной валюте поле зачисления не пишется.
    const same = createTransaction(state, { ...transferDraft("100"), toAmount: "5" }, fixedOperationId).transactions.at(-1)!;
    expect(Object.hasOwn(same, "toAmountMinor")).toBe(false);
  });

  it("правка операции в другой валюте сохраняет её курс, пока день и счёт те же", () => {
    const state = { ...withDollars(), exchangeRates: [RATE_LATER] };
    const draft: TransactionDraft = { kind: "expense", status: "posted", occurredOn: "2026-07-10", amount: "50", accountId: DOLLARS, categoryId: ids.categories.products, note: "сдача" };
    const edited = editTransaction(state, DOLLAR_EXPENSE, draft).transactions.find((item) => item.id === DOLLAR_EXPENSE)!;
    // Записанный курс 90,00, а не курс позднего дня 95,00: правка заметки не переоценивает покупку.
    expect(edited).toMatchObject({ amountMinor: 5_000, baseAmountMinor: 450_000, rate: { baseMinor: 9_000, quoteMinor: 100 }, note: "сдача" });
    // Новый день — курс нового дня; дня без курса — отказ словами.
    expect(editTransaction(state, DOLLAR_EXPENSE, { ...draft, occurredOn: "2026-07-16" }).transactions.find((item) => item.id === DOLLAR_EXPENSE))
      .toMatchObject({ baseAmountMinor: 475_000, rate: RATE_LATER.rate });
    expect(() => editTransaction(state, DOLLAR_EXPENSE, { ...draft, occurredOn: "2026-07-12" })).toThrow(expect.objectContaining({ field: "baseAmount" }));
    // На рублёвый счёт — снимок уходит: сумма снова и есть цифра.
    const rouble = editTransaction(state, DOLLAR_EXPENSE, { ...draft, accountId: ids.accounts.main }).transactions.find((item) => item.id === DOLLAR_EXPENSE)!;
    expect(Object.hasOwn(rouble, "baseAmountMinor")).toBe(false);
  });

  it("сумма у иены целая, у динара — с тремя знаками", () => {
    const YEN = "8c000000-0000-4000-8000-0000000000a3";
    const base = withDollars();
    const state = {
      ...base,
      accounts: [...base.accounts, { id: YEN, name: "Иены", type: "cash" as const, currency: "JPY", openingBalanceMinor: 0, active: true }],
      exchangeRates: [{ id: "8e100000-0000-4000-8000-0000000000e3", currency: "JPY", baseCurrency: "RUB", date: "2026-07-01", rate: { baseMinor: 60, quoteMinor: 1 } }],
    };
    const yen: TransactionDraft = { kind: "expense", status: "posted", occurredOn: "2026-07-11", amount: "1500", accountId: YEN, categoryId: ids.categories.products };
    expect(createTransaction(state, yen, fixedOperationId).transactions.at(-1)).toMatchObject({ amountMinor: 1_500, baseAmountMinor: 90_000 });
    expect(() => createTransaction(state, { ...yen, amount: "15,5" }, fixedOperationId)).toThrow(
      expect.objectContaining({ field: "amount", message: "Введите положительную сумму целым числом." }),
    );
  });
});

describe("отмена из тоста", () => {
  it("правку отменяет прежняя операция целиком, удаление — та же операция под новым идентификатором", () => {
    const state = makeG000State();
    const before = state.transactions.find((item) => item.id === ids.transactions.products)!;
    const edited = editTransaction(state, before.id, {
      kind: "expense", status: "posted", occurredOn: before.occurredOn, amount: "1", accountId: ids.accounts.main, categoryId: ids.categories.products,
    });
    const restored = restoreTransaction(edited, before);
    expect(restored.transactions.find((item) => item.id === before.id)).toEqual(before);
    expect(calculateOperationsMetrics(restored)).toEqual(calculateOperationsMetrics(state));

    const removed = deleteTransaction(state, ids.transactions.housing2);
    const deleted = state.transactions.find((item) => item.id === ids.transactions.housing2)!;
    const again = recreateTransaction(removed, deleted, fixedOperationId);
    expect(again.ids).toHaveLength(1);
    expect(again.ids[0]).not.toBe(deleted.id);
    expect(again.state.transactions.at(-1)).toEqual({ ...deleted, id: again.ids[0] });
    expect(calculateOperationsMetrics(again.state)).toEqual(calculateOperationsMetrics(state));
    expect(() => restoreTransaction(removed, deleted)).toThrow(expect.objectContaining({ field: "id" }));
  });
});

describe("operations on a debt", () => {
  const DEBT = "8f100000-0000-4000-8000-0000000000d1";
  const LENT = "8d100000-0000-4000-8000-000000000007";

  function withLending() {
    const state = makeG000State();
    return {
      ...state,
      debts: [{ id: DEBT, counterparty: "Петя", direction: "owed_to_me" as const, currency: "RUB", openingMinor: 0, active: true }],
      transactions: [...state.transactions, { id: LENT, kind: "debt_out" as const, status: "posted" as const, occurredOn: "2026-07-09", amountMinor: 500_000, accountId: ids.accounts.main, debtId: DEBT }],
    };
  }

  it("refuses to edit a debt movement the form cannot show, and keeps it whole", () => {
    const state = withLending();
    const draft: TransactionDraft = { kind: "expense", status: "posted", occurredOn: "2026-07-09", amount: "5000", accountId: ids.accounts.main, categoryId: ids.categories.products };
    expect(() => editTransaction(state, LENT, draft)).toThrow(
      expect.objectContaining({ field: "kind", message: DEBT_EDIT_REFUSAL }),
    );
  });

  it("deletes a debt movement like any other operation, and records beside it as before", () => {
    const state = withLending();
    expect(deleteTransaction(state, LENT).transactions.map((item) => item.id)).not.toContain(LENT);
    expect(() => createTransaction(state, transferDraft("100"), fixedOperationId)).not.toThrow();
    expect(calculateOperationsMetrics(state).accountBalancesMinor[ids.accounts.main]).toBe(
      calculateOperationsMetrics(makeG000State()).accountBalancesMinor[ids.accounts.main]! - 500_000,
    );
  });
});
