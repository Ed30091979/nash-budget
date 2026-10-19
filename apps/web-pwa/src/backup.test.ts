import {
  calculateAnnualPlan,
  calculateBudget,
  calculateDebts,
  calculateMemberExpenses,
  carryBudgetForward,
  COLLECTION_LIMITS,
  HOUSEHOLD_ID,
  makePlanningSeed,
  setHouseholdPaydays,
  materializeRecurring,
  MAX_TAGS_PER_TRANSACTION,
  NOTE_MAX_LENGTH,
  PLANNING_IDS,
  SEED_IDS,
  TAG_NAME_MAX_LENGTH,
  type BudgetState,
  type Debt,
  type Member,
  type RecurringRule,
  type Tag,
  type Transaction,
} from "@family-budget/domain";
import { serializeBackup } from "@family-budget/storage";
import { describe, expect, it, vi } from "vitest";
import {
  BACKUP_LIMITS,
  MAX_BACKUP_FILE_BYTES,
  createBudgetBackup,
  parseAndValidateBudgetBackup,
  prepareBudgetState,
  restoreBudgetBackup,
  type BackupRepair,
} from "./backup";

function backupFile(payload: unknown, size?: number): { size: number; text(): Promise<string> } {
  const text = serializeBackup(payload);
  return { size: size ?? text.length, text: async () => text };
}

const DOLLAR_ACCOUNT_ID = "c5555555-5555-4555-8555-555555555551";
const DOLLAR_EXPENSE_ID = "c5555555-5555-4555-8555-555555555552";
const DOLLAR_RATE_ID = "c5555555-5555-4555-8555-555555555553";

/** Копия волны 1 с долларовым счётом, курсом и покупкой на 40 $ по 90 ₽ — 3 600 ₽. */
function withDollars(state: BudgetState): BudgetState {
  return {
    ...state,
    household: { id: HOUSEHOLD_ID, baseCurrency: "RUB" },
    exchangeRates: [{ id: DOLLAR_RATE_ID, currency: "USD", baseCurrency: "RUB", date: "2026-06-30", rate: { baseMinor: 9_000, quoteMinor: 100 } }],
    accounts: [...state.accounts, { id: DOLLAR_ACCOUNT_ID, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true }],
    transactions: [
      ...state.transactions,
      {
        id: DOLLAR_EXPENSE_ID, occurredOn: "2026-07-10", status: "posted", kind: "expense", amountMinor: 4_000,
        accountId: DOLLAR_ACCOUNT_ID, categoryId: PLANNING_IDS.categories.food,
        baseAmountMinor: 360_000, baseCurrency: "RUB", rate: { baseMinor: 9_000, quoteMinor: 100 },
      },
    ],
  };
}

function withoutSnapshot(state: BudgetState): BudgetState {
  return {
    ...state,
    transactions: state.transactions.map((transaction) => {
      if (transaction.id !== DOLLAR_EXPENSE_ID || transaction.kind !== "expense") return transaction;
      const { baseAmountMinor: _amount, baseCurrency: _currency, rate: _rate, ...plain } = transaction;
      return plain;
    }),
  };
}

function withCrossCollectionDuplicate(state: BudgetState): BudgetState {
  const duplicateId = state.accounts[0]!.id;
  const originalCategoryId = state.categories[5]!.id;
  return {
    ...state,
    categories: state.categories.map((category) => (
      category.id === originalCategoryId ? { ...category, id: duplicateId } : category
    )),
    budgets: state.budgets.map((budget) => ({
      ...budget,
      lines: budget.lines.map((line) => (
        line.categoryId === originalCategoryId ? { ...line, categoryId: duplicateId } : line
      )),
    })),
  };
}

function withRelinkedMalformedAccountId(state: BudgetState): BudgetState {
  const originalId = state.accounts[0]!.id;
  const malformedId = "relinked-but-not-a-uuid";
  return {
    ...state,
    accounts: state.accounts.map((account) => (
      account.id === originalId ? { ...account, id: malformedId } : account
    )),
    annualCommitments: state.annualCommitments.map((item) => (
      item.accountId === originalId ? { ...item, accountId: malformedId } : item
    )),
    scheduledExpenses: state.scheduledExpenses.map((item) => (
      item.accountId === originalId ? { ...item, accountId: malformedId } : item
    )),
    transactions: state.transactions.map((transaction) => {
      if (transaction.kind === "income" || transaction.kind === "expense" || transaction.kind === "refund"
        || transaction.kind === "debt_out" || transaction.kind === "debt_in") {
        return transaction.accountId === originalId ? { ...transaction, accountId: malformedId } : transaction;
      }
      return {
        ...transaction,
        fromAccountId: transaction.fromAccountId === originalId ? malformedId : transaction.fromAccountId,
        toAccountId: transaction.toAccountId === originalId ? malformedId : transaction.toAccountId,
      };
    }),
  };
}

function withRefund(
  state: BudgetState,
  occurredOn: string,
  amountMinor = 150_000,
): BudgetState {
  const original = state.transactions.find(
    (transaction) => transaction.kind === "expense" && transaction.occurredOn === "2026-07-08",
  );
  if (!original || original.kind !== "expense") throw new Error("Test fixture expense is missing.");
  return {
    ...state,
    transactions: [
      ...state.transactions,
      {
        id: "75555555-5555-4555-8555-555555555559",
        occurredOn,
        status: "posted",
        kind: "refund",
        amountMinor,
        accountId: original.accountId,
        categoryId: original.categoryId,
        originalTransactionId: original.id,
      },
    ],
  };
}

function withActiveBudgetPeriod(
  state: BudgetState,
  startDate: string,
  endDate: string,
): BudgetState {
  return {
    ...state,
    budgets: state.budgets.map((budget) => (
      budget.id === state.activeBudgetId ? { ...budget, startDate, endDate } : budget
    )),
  };
}

describe("восстановление бюджета", () => {
  it("дополняет legacy state, не заменяя счета, категории, бюджеты, цели и операции", () => {
    const seed = makePlanningSeed();
    const uniqueTransaction = {
      id: "95555555-5555-4555-8555-555555555559",
      occurredOn: seed.budgets[0]!.startDate,
      status: "posted" as const,
      kind: "expense" as const,
      amountMinor: 987_654,
      accountId: seed.accounts[0]!.id,
      categoryId: seed.budgets[0]!.lines[0]!.categoryId,
    };
    const { annualCommitments: _annual, scheduledExpenses: _scheduled, ...legacy } = {
      ...seed,
      transactions: [...seed.transactions, uniqueTransaction],
    };

    const restored = prepareBudgetState(legacy);

    expect(restored.accounts).toEqual(legacy.accounts);
    expect(restored.categories).toEqual(legacy.categories);
    expect(restored.budgets).toEqual(legacy.budgets);
    expect(restored.goals).toEqual(legacy.goals);
    expect(restored.transactions).toEqual(legacy.transactions);
    expect(restored.transactions.at(-1)).toMatchObject({ id: uniqueTransaction.id, amountMinor: 987_654 });
    expect(restored.annualCommitments).toEqual([]);
    expect(restored.scheduledExpenses).toEqual([]);
  });

  it("принимает последнюю стартовую дату, отображаемую полным 24-месячным горизонтом", () => {
    const boundary = withActiveBudgetPeriod(
      makePlanningSeed(),
      "9997-12-01",
      "9997-12-31",
    );

    const prepared = prepareBudgetState(boundary);
    const plan = calculateAnnualPlan(prepared, "9997-12", 24);

    expect(plan.months).toHaveLength(24);
    expect(plan.months.at(-1)?.month).toBe("9999-11");
  });

  it(
    "отклоняет старт 9998-02 за границей 24-месячного UI до save/publish",
    async () => {
      const previous = makePlanningSeed();
      let stored = previous;
      let published = previous;
      const save = vi.fn(async (next: BudgetState) => { stored = next; });
      const publish = vi.fn((next: BudgetState) => { published = next; });
      const invalid = withActiveBudgetPeriod(
        makePlanningSeed(),
        "9998-02-01",
        "9998-02-28",
      );

      expect(() => prepareBudgetState(invalid)).toThrow(
        "planning horizon exceeds supported calendar range",
      );
      await expect(
        restoreBudgetBackup(backupFile(invalid), save, publish),
      ).rejects.toThrow("planning horizon exceeds supported calendar range");

      expect(save).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(stored).toBe(previous);
      expect(published).toBe(previous);
    },
  );

  // План §6: тест «USD отвергается» стал тремя — валюта вне таблицы отвергается, USD без суммы в
  // рублях отвергается, USD с ней принимается. Счёт в долларах теперь законен (D-031).
  it("отклоняет modern backup со счётом в неизвестной валюте и корректной checksum до save/publish", async () => {
    const previous = makePlanningSeed();
    let stored = previous;
    let published = previous;
    const save = vi.fn(async (next: BudgetState) => { stored = next; });
    const publish = vi.fn((next: BudgetState) => { published = next; });
    const candidate = makePlanningSeed();
    const unknown = {
      ...candidate,
      accounts: candidate.accounts.map((account, index) => (
        index === 0 ? { ...account, currency: "XYZ" } : account
      )),
    };
    const text = serializeBackup(unknown);
    const envelope = JSON.parse(text) as {
      formatVersion: number;
      integrity: { algorithm: string; checksum: string };
    };
    const file = { size: text.length, text: async () => text };

    expect(envelope).toMatchObject({
      formatVersion: 2,
      integrity: { algorithm: "sha256" },
    });
    expect(envelope.integrity.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(() => parseAndValidateBudgetBackup(text)).toThrow(
      /accounts\[0\]\.currency: недопустимое значение/,
    );
    await expect(restoreBudgetBackup(file, save, publish)).rejects.toThrow(
      /accounts\[0\]\.currency: недопустимое значение/,
    );

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(stored).toBe(previous);
    expect(published).toBe(previous);
  });

  it("отклоняет операцию по счёту в USD без суммы в рублях до save/publish", async () => {
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();
    const plain = withoutSnapshot(withDollars(makePlanningSeed()));

    expect(() => prepareBudgetState(plain)).toThrow(/transactions\[\d+\]: операция по счёту в USD без суммы в базовой валюте RUB/u);
    await expect(restoreBudgetBackup(backupFile(plain), save, publish)).rejects.toThrow(/без суммы в базовой валюте/u);
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("принимает счёт в USD с суммой в рублях: копия восстанавливается байт в байт", async () => {
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();
    const dollars = withDollars(makePlanningSeed());

    await expect(restoreBudgetBackup(backupFile(dollars), save, publish)).resolves.toEqual(dollars);
    expect(save).toHaveBeenCalledExactlyOnceWith(dollars);
    const exported = await createBudgetBackup(dollars, vi.fn(async () => undefined));
    expect(parseAndValidateBudgetBackup(exported.text)).toEqual(dollars);
    // Расход в долларах попал в рубли по своей сумме в рублях, а капитал — только рубли.
    const metrics = calculateBudget(dollars);
    expect(metrics.grossExpensesMinor).toBe(calculateBudget(makePlanningSeed()).grossExpensesMinor + 360_000);
    expect(metrics.capitalMinor).toBe(calculateBudget(makePlanningSeed()).capitalMinor);
  });

  it.each([
    ["неизвестный active budget", (state: BudgetState) => ({ ...state, activeBudgetId: "missing-budget" })],
    ["неизвестный счёт операции", (state: BudgetState) => ({ ...state, transactions: [{ ...state.transactions[0]!, accountId: "missing-account" }] })],
    ["неизвестная категория регулярного расхода", (state: BudgetState) => ({ ...state, scheduledExpenses: [{ ...state.scheduledExpenses[0]!, categoryId: "missing-category" }] })],
    ["невозможная дата", (state: BudgetState) => ({ ...state, budgets: [{ ...state.budgets[0]!, startDate: "2026-02-30" }] })],
    ["дробные minor units", (state: BudgetState) => ({ ...state, transactions: [{ ...state.transactions[0]!, amountMinor: 10.5 }] })],
    ["отрицательная сумма", (state: BudgetState) => ({ ...state, annualCommitments: [{ ...state.annualCommitments[0]!, amountMinor: -1 }] })],
  ])("отклоняет payload: %s", async (_name, mutate) => {
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();

    await expect(restoreBudgetBackup(backupFile(mutate(makePlanningSeed())), save, publish)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("отклоняет файл больше 5 МБ до чтения и изменения данных", async () => {
    const text = vi.fn<() => Promise<string>>();
    const save = vi.fn<(_: BudgetState) => Promise<void>>();
    const publish = vi.fn<(_: BudgetState) => void>();

    await expect(restoreBudgetBackup({ size: MAX_BACKUP_FILE_BYTES + 1, text }, save, publish)).rejects.toThrow(/5 МБ/);
    expect(text).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("отклоняет вычислительно опасную cardinality до доменных расчётов и записи", async () => {
    const seed = makePlanningSeed();
    const budgets = Array.from({ length: BACKUP_LIMITS.budgets + 1 }, (_, index) => ({
      ...seed.budgets[0]!,
      id: `budget-${index}`,
      lines: seed.budgets[0]!.lines.map((line, lineIndex) => ({
        ...line,
        id: `budget-${index}-line-${lineIndex}`,
      })),
      // Если лимит не сработает первым, семантическая/доменная проверка упадёт с другой ошибкой.
      startDate: "not-a-date",
    }));
    const transactions = Array.from({ length: 4_000 }, (_, index) => ({
      ...seed.transactions[0]!,
      id: `transaction-${index}`,
    }));
    const file = backupFile({ ...seed, activeBudgetId: budgets[0]!.id, budgets, transactions });
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();

    expect(file.size).toBeLessThan(MAX_BACKUP_FILE_BYTES);
    await expect(restoreBudgetBackup(file, save, publish)).rejects.toThrow(
      `budgets: допускается не более ${BACKUP_LIMITS.budgets} элементов`,
    );
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("публикует state только после успешного сохранения", async () => {
    const events: string[] = [];
    const save = vi.fn(async () => { events.push("saved"); });
    const publish = vi.fn(() => { events.push("published"); });

    await restoreBudgetBackup(backupFile(makePlanningSeed()), save, publish);

    expect(events).toEqual(["saved", "published"]);
  });

  it("сохраняет optional active строки бюджета и legacy-отсутствие флага при round-trip", () => {
    const seed = makePlanningSeed();
    const firstBudget = seed.budgets[0]!;
    const state: BudgetState = {
      ...seed,
      budgets: [{
        ...firstBudget,
        lines: firstBudget.lines.map((line, index) => (
          index === 0 ? { ...line, active: false } : line
        )),
      }],
    };

    const restored = parseAndValidateBudgetBackup(serializeBackup(state));

    expect(restored).toEqual(state);
    expect(restored.budgets[0]!.lines[0]!.active).toBe(false);
    expect(restored.budgets[0]!.lines[1]!.active).toBeUndefined();
  });

  it("отклоняет не-boolean active строки бюджета до save/publish", async () => {
    const seed = makePlanningSeed();
    const firstBudget = seed.budgets[0]!;
    const malformed = {
      ...seed,
      budgets: [{
        ...firstBudget,
        lines: firstBudget.lines.map((line, index) => (
          index === 0 ? { ...line, active: "false" } : line
        )),
      }],
    };
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();

    await expect(restoreBudgetBackup(backupFile(malformed), save, publish)).rejects.toThrow(
      /active.*логическое значение/,
    );
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("не публикует state, если IndexedDB не сохранил восстановление", async () => {
    const publish = vi.fn<(_: BudgetState) => void>();
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockRejectedValue(new Error("quota"));

    await expect(restoreBudgetBackup(backupFile(makePlanningSeed()), save, publish)).rejects.toThrow("quota");
    expect(publish).not.toHaveBeenCalled();
  });

  it("отклоняет одинаковый UUID в разных коллекциях до save/publish и сохраняет старый документ", async () => {
    let stored = makePlanningSeed();
    const before = JSON.stringify(stored);
    const save = vi.fn(async (next: BudgetState) => { stored = next; });
    const publish = vi.fn<(_: BudgetState) => void>();
    const duplicate = withCrossCollectionDuplicate(makePlanningSeed());

    expect(() => parseAndValidateBudgetBackup(serializeBackup(duplicate))).toThrow(/повторяющийся идентификатор/);
    await expect(restoreBudgetBackup(backupFile(duplicate), save, publish)).rejects.toThrow(/повторяющийся идентификатор/);

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(JSON.stringify(stored)).toBe(before);
  });

  it("отклоняет связанный внутри state, но невалидный UUID до save/publish", async () => {
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();
    const malformed = withRelinkedMalformedAccountId(makePlanningSeed());

    await expect(restoreBudgetBackup(backupFile(malformed), save, publish)).rejects.toThrow(/UUID/);

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("отклоняет возврат раньше исходного расхода до save/publish и сохраняет прежний state", async () => {
    let stored = makePlanningSeed();
    const before = JSON.stringify(stored);
    const save = vi.fn(async (next: BudgetState) => { stored = next; });
    const publish = vi.fn<(_: BudgetState) => void>();
    const malformed = withRefund(makePlanningSeed(), "2026-07-07");

    expect(() => prepareBudgetState(malformed)).toThrow(/must not occur before the original expense/);
    await expect(restoreBudgetBackup(backupFile(malformed), save, publish)).rejects.toThrow(
      /must not occur before the original expense/,
    );

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(JSON.stringify(stored)).toBe(before);
  });

  it("принимает резервную копию с возвратом в день исходного расхода", async () => {
    const sameDay = withRefund(makePlanningSeed(), "2026-07-08");
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();

    expect(prepareBudgetState(sameDay)).toEqual(sameDay);
    await expect(restoreBudgetBackup(backupFile(sameDay), save, publish)).resolves.toEqual(sameDay);

    expect(save).toHaveBeenCalledExactlyOnceWith(sameDay);
    expect(publish).toHaveBeenCalledExactlyOnceWith(sameDay);
  });

  it("сохраняет D-013: возврат может превышать сумму исходного расхода", async () => {
    const excess = withRefund(makePlanningSeed(), "2026-07-09", 4_000_000);
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();

    expect(prepareBudgetState(excess)).toEqual(excess);
    await expect(restoreBudgetBackup(backupFile(excess), save, publish)).resolves.toEqual(excess);

    expect(save).toHaveBeenCalledExactlyOnceWith(excess);
    expect(publish).toHaveBeenCalledExactlyOnceWith(excess);
  });
});

describe("экспорт бюджета", () => {
  const exactCreatedAt = "2026-07-17T12:00:00.000Z";
  const previousCreatedAt = "2026-07-16T08:30:00.000Z";

  it("возвращает валидный текст и записывает точное время только после сериализации", async () => {
    let storedCreatedAt = previousCreatedAt;
    const persist = vi.fn(async (createdAt: string) => { storedCreatedAt = createdAt; });

    const result = await createBudgetBackup(makePlanningSeed(), persist, { createdAt: exactCreatedAt });

    expect(result.createdAt).toBe(exactCreatedAt);
    expect((JSON.parse(result.text) as { createdAt: string }).createdAt).toBe(exactCreatedAt);
    expect(parseAndValidateBudgetBackup(result.text)).toEqual(makePlanningSeed());
    expect(persist).toHaveBeenCalledExactlyOnceWith(exactCreatedAt);
    expect(storedCreatedAt).toBe(exactCreatedAt);
  });

  it("сохраняет прежнее время, если сериализация не прошла", async () => {
    let storedCreatedAt = previousCreatedAt;
    const persist = vi.fn(async (createdAt: string) => { storedCreatedAt = createdAt; });

    await expect(
      createBudgetBackup(withCrossCollectionDuplicate(makePlanningSeed()), persist, { createdAt: exactCreatedAt }),
    ).rejects.toThrow(/повторяющийся идентификатор/);

    expect(persist).not.toHaveBeenCalled();
    expect(storedCreatedAt).toBe(previousCreatedAt);
  });

  it("не меняет metadata при экспорте согласованно перелинкованного не-UUID", async () => {
    let storedCreatedAt = previousCreatedAt;
    const persist = vi.fn(async (createdAt: string) => { storedCreatedAt = createdAt; });

    await expect(
      createBudgetBackup(withRelinkedMalformedAccountId(makePlanningSeed()), persist, { createdAt: exactCreatedAt }),
    ).rejects.toThrow(/UUID/);

    expect(persist).not.toHaveBeenCalled();
    expect(storedCreatedAt).toBe(previousCreatedAt);
  });

  it("не возвращает данные для скачивания и сохраняет прежнее время при ошибке metadata", async () => {
    let storedCreatedAt = previousCreatedAt;
    const persist = vi.fn(async (_createdAt: string) => {
      throw new Error("metadata quota");
    });

    await expect(
      createBudgetBackup(makePlanningSeed(), persist, { createdAt: exactCreatedAt }),
    ).rejects.toThrow("metadata quota");

    expect(persist).toHaveBeenCalledExactlyOnceWith(exactCreatedAt);
    expect(storedCreatedAt).toBe(previousCreatedAt);
  });
});

const OWNER: Member = { id: "b1111111-1111-4111-8111-111111111111", name: "Аня", role: "owner", active: true };
const PARTNER: Member = { id: "b2222222-2222-4222-8222-222222222222", name: "Пётр", role: "member", active: false };
const DELETED_MEMBER_ID = "b3333333-3333-4333-8333-333333333333";

function withMembers(state: BudgetState, members: readonly unknown[]): unknown {
  return { ...state, members };
}

/** A posted expense inside the active budget window: the one the split by participant counts. */
function countedExpense(state: BudgetState): Transaction {
  const budget = state.budgets.find((item) => item.id === state.activeBudgetId)!;
  const found = state.transactions.find((transaction) => (
    transaction.kind === "expense"
    && transaction.status === "posted"
    && transaction.occurredOn >= budget.startDate
    && transaction.occurredOn <= budget.endDate
  ));
  if (!found) throw new Error("Test fixture posted expense is missing.");
  return found;
}

function withAttribution(state: unknown, memberId: string): unknown {
  const budget = state as BudgetState;
  const target = countedExpense(budget);
  return {
    ...budget,
    transactions: budget.transactions.map((transaction) => (
      transaction.id === target.id ? { ...transaction, memberId } : transaction
    )),
  };
}

describe("участники в резервной копии", () => {
  it("восстанавливает копию без участников без единой ошибки и без выдуманной коллекции", () => {
    const legacy = makePlanningSeed();

    const restored = prepareBudgetState(legacy);

    expect(restored).toEqual(legacy);
    expect(restored.members).toBeUndefined();
    expect("members" in restored).toBe(false);
    const breakdown = calculateMemberExpenses(restored);
    expect(breakdown.members).toEqual([]);
    expect(breakdown.attributedMinor).toBe(0);
    expect(breakdown.unattributed.actualMinor).toBe(breakdown.expensesMinor);
  });

  it("сохраняет участников и метку операции при round-trip", async () => {
    const labelled = withAttribution(withMembers(makePlanningSeed(), [OWNER, PARTNER]), OWNER.id);
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();

    const restored = parseAndValidateBudgetBackup(serializeBackup(labelled));

    expect(restored).toEqual(labelled);
    expect(restored.members).toEqual([OWNER, PARTNER]);
    expect(calculateMemberExpenses(restored).byMember[OWNER.id]!.transactionCount).toBe(1);
    await expect(restoreBudgetBackup(backupFile(labelled), save, publish)).resolves.toEqual(labelled);
    expect(save).toHaveBeenCalledExactlyOnceWith(labelled);
    expect(publish).toHaveBeenCalledExactlyOnceWith(labelled);
  });

  it.each([
    ["роль вне домена", [{ ...OWNER, role: "ГЛАВНЫЙ" }], /members\[0\]\.role: недопустимое значение/],
    ["признак активности строкой", [{ ...OWNER, active: "yes" }], /members\[0\]\.active: ожидалось логическое значение/],
    ["идентификатор не UUID", [{ ...OWNER, id: "member-1" }], /members\[0\]\.id: некорректный UUID/],
    ["пустой идентификатор", [{ ...OWNER, id: "" }], /members\[0\]\.id: ожидалась непустая строка/],
    ["имя не строка", [{ ...OWNER, name: 42 }], /members\[0\]\.name: ожидалась строка/],
    ["имя длиннее допустимого", [{ ...OWNER, name: "я".repeat(BACKUP_LIMITS.nameLength + 1) }], /members\[0\]\.name: строка длиннее/],
    ["участник не объект", ["Аня"], /members\[0\]: ожидался объект/],
    ["участники не список", null, /members: ожидался список/],
  ])("отклоняет копию: %s — до save/publish", async (_name, members, expected) => {
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();
    const malformed = withMembers(makePlanningSeed(), members as readonly unknown[]);

    expect(() => prepareBudgetState(malformed)).toThrow(expected);
    await expect(restoreBudgetBackup(backupFile(malformed), save, publish)).rejects.toThrow(expected);

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("отклоняет не-UUID метку участника у операции", async () => {
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();
    const malformed = withAttribution(withMembers(makePlanningSeed(), [{ ...OWNER, id: "member-1" }]), "member-1");

    expect(() => prepareBudgetState(malformed)).toThrow(/некорректный UUID/);
    await expect(restoreBudgetBackup(backupFile(malformed), save, publish)).rejects.toThrow(/некорректный UUID/);

    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("ограничивает число участников наравне с прочими коллекциями", async () => {
    const excess = Array.from({ length: BACKUP_LIMITS.members + 1 }, (_, index) => ({
      ...OWNER,
      id: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      // Если лимит не сработает первым, проверка формы упадёт с другой ошибкой.
      role: "ГЛАВНЫЙ",
    }));
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();
    const file = backupFile(withMembers(makePlanningSeed(), excess));

    expect(file.size).toBeLessThan(MAX_BACKUP_FILE_BYTES);
    await expect(restoreBudgetBackup(file, save, publish)).rejects.toThrow(
      `members: допускается не более ${BACKUP_LIMITS.members} элементов`,
    );
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("отклоняет двух участников с одним идентификатором", () => {
    const duplicate = withMembers(makePlanningSeed(), [OWNER, { ...PARTNER, id: OWNER.id }]);

    expect(() => prepareBudgetState(duplicate)).toThrow(/members contains duplicate id/);
  });

  it("снимает метку на несуществующего участника, не трогая ни операцию, ни суммы", async () => {
    const seed = makePlanningSeed();
    const labelled = withAttribution(withMembers(seed, [OWNER]), DELETED_MEMBER_ID);
    const target = countedExpense(seed);
    const repairs: unknown[] = [];
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();

    const restored = await restoreBudgetBackup(
      backupFile(labelled),
      save,
      publish,
      (repair) => repairs.push(repair),
    );

    expect(repairs).toEqual([
      { kind: "unknown_member_attribution", transactionId: target.id, memberId: DELETED_MEMBER_ID },
    ]);
    expect(restored.transactions).toHaveLength(seed.transactions.length);
    expect(restored.transactions.find((item) => item.id === target.id)).toEqual(target);
    expect(restored.transactions.find((item) => item.id === target.id)?.memberId).toBeUndefined();
    expect(restored.members).toEqual([OWNER]);
    expect(save).toHaveBeenCalledExactlyOnceWith(restored);
    expect(publish).toHaveBeenCalledExactlyOnceWith(restored);

    const before = calculateMemberExpenses(seed);
    const after = calculateMemberExpenses(restored);
    expect(after.expensesMinor).toBe(before.expensesMinor);
    expect(after.attributedMinor).toBe(0);
    expect(after.unattributed.actualMinor).toBe(before.unattributed.actualMinor);
  });

  it("снимает метку и когда коллекции участников в копии нет вовсе", () => {
    const seed = makePlanningSeed();
    const target = countedExpense(seed);
    const repairs: unknown[] = [];

    const restored = prepareBudgetState(
      withAttribution(seed, DELETED_MEMBER_ID),
      (repair) => repairs.push(repair),
    );

    expect(repairs).toHaveLength(1);
    expect(restored).toEqual(seed);
    expect(() => calculateMemberExpenses(restored)).not.toThrow();
    expect(restored.transactions.find((item) => item.id === target.id)).toEqual(target);
  });

  it("не даёт создать копию из состояния, которое уронило бы разбивку по участникам", async () => {
    const persist = vi.fn(async (_createdAt: string) => undefined);
    const broken = withAttribution(
      withMembers(makePlanningSeed(), [{ ...OWNER, id: "member-1", role: "ГЛАВНЫЙ", active: "yes" }]),
      DELETED_MEMBER_ID,
    ) as BudgetState;

    await expect(
      createBudgetBackup(broken, persist, { createdAt: "2026-07-17T12:00:00.000Z" }),
    ).rejects.toThrow(/members\[0\]\.role: недопустимое значение/);
    expect(persist).not.toHaveBeenCalled();
  });

  it("не сохраняет метку на несуществующего участника в созданной копии", async () => {
    const seed = makePlanningSeed();
    const persist = vi.fn(async (_createdAt: string) => undefined);
    const labelled = withAttribution(withMembers(seed, [OWNER]), DELETED_MEMBER_ID) as BudgetState;

    const created = await createBudgetBackup(labelled, persist, { createdAt: "2026-07-17T12:00:00.000Z" });
    const restored = parseAndValidateBudgetBackup(created.text);

    expect(created.text).not.toContain(DELETED_MEMBER_ID);
    expect(restored.transactions).toEqual(seed.transactions);
    expect(() => calculateMemberExpenses(restored)).not.toThrow();
  });
});

const INCOME_CATEGORY_ID = "7c000000-0000-4000-8000-00000000c001";

/** Копия, в которой один доход отнесён к доходной категории — то, чего до сих пор не бывало. */
function withIncomeCategory(state: BudgetState, categoryId = INCOME_CATEGORY_ID): BudgetState {
  return {
    ...state,
    categories: [
      ...state.categories,
      { id: INCOME_CATEGORY_ID, name: "Зарплата", type: "income", group: "income", active: true, sortOrder: 900 },
    ],
    transactions: state.transactions.map((transaction) =>
      transaction.kind === "income" ? { ...transaction, categoryId } : transaction),
  };
}

describe("категория дохода в резервной копии", () => {
  it("копия без категории у дохода остаётся годной и поля не приобретает", () => {
    const legacy = makePlanningSeed();

    const restored = parseAndValidateBudgetBackup(serializeBackup(legacy));

    expect(restored).toEqual(legacy);
    const income = restored.transactions.find((item) => item.kind === "income");
    expect(income).toBeDefined();
    expect(Object.hasOwn(income ?? {}, "categoryId")).toBe(false);
  });

  it("сохраняет категорию дохода при round-trip и публикует её", async () => {
    const labelled = withIncomeCategory(makePlanningSeed());
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();

    const restored = parseAndValidateBudgetBackup(serializeBackup(labelled));
    expect(restored).toEqual(labelled);
    expect(restored.transactions.find((item) => item.kind === "income"))
      .toMatchObject({ categoryId: INCOME_CATEGORY_ID });

    await expect(restoreBudgetBackup(backupFile(labelled), save, publish)).resolves.toEqual(labelled);
    expect(save).toHaveBeenCalledExactlyOnceWith(labelled);
    expect(publish).toHaveBeenCalledExactlyOnceWith(labelled);

    const exported = await createBudgetBackup(labelled, vi.fn(async () => undefined));
    expect(parseAndValidateBudgetBackup(exported.text)).toEqual(labelled);
  });

  it.each([
    ["неизвестная категория", "7c000000-0000-4000-8000-00000000c009", /неизвестная категория/u],
    ["расходная категория", PLANNING_IDS.categories.food, /категория должна быть доходной/u],
  ])("отклоняет доход, отнесённый не туда: %s", async (_label, categoryId, message) => {
    const broken = withIncomeCategory(makePlanningSeed(), categoryId);
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();

    await expect(restoreBudgetBackup(backupFile(broken), save, publish)).rejects.toThrow(message);
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("отклоняет пустую и нестроковую категорию дохода", () => {
    const seed = withIncomeCategory(makePlanningSeed());
    const replace = (value: unknown) => ({
      ...seed,
      transactions: seed.transactions.map((transaction) =>
        transaction.kind === "income" ? { ...transaction, categoryId: value } : transaction),
    });

    expect(() => prepareBudgetState(replace("")))
      .toThrow(/transactions\[\d+\]\.categoryId: ожидалась непустая строка/u);
    expect(() => prepareBudgetState(replace(42)))
      .toThrow(/transactions\[\d+\]\.categoryId: ожидалась непустая строка/u);
  });
});

const TAG_HOME: Tag = { id: "c1111111-1111-4111-8111-111111111111", name: "Дом", active: true };
const TAG_OLD: Tag = { id: "c2222222-2222-4222-8222-222222222222", name: "Старое", active: false };
const DELETED_TAG_ID = "c3333333-3333-4333-8333-333333333333";
const RULE_ID = "c4444444-4444-4444-8444-444444444444";

/** Копия волны 1: метки, заметки и оформление на всём, что их принимает. */
function withLabels(state: BudgetState): BudgetState {
  const target = countedExpense(state);
  return {
    ...state,
    tags: [TAG_HOME, TAG_OLD],
    accounts: state.accounts.map((account, index) => ({
      ...account,
      sortOrder: (index + 1) * 10,
      icon: "banknote",
      color: "sage",
      ...(index === 1 ? { includeInTotal: false } : {}),
    })),
    categories: state.categories.map((category) => ({ ...category, icon: "shopping-basket", color: "mint" })),
    goals: state.goals.map((goal) => ({ ...goal, deadline: "2027-06-01", icon: "plane" })),
    transactions: state.transactions.map((transaction) => (
      transaction.id === target.id
        ? { ...transaction, note: "Пятёрочка у дома", tagIds: [TAG_HOME.id, TAG_OLD.id] }
        : transaction
    )),
  };
}

/** Меняет одно поле у одной сущности, не заботясь о типах: так выглядит чужой файл. */
function mutate(state: BudgetState, collection: "accounts" | "categories" | "goals" | "transactions" | "tags", change: Record<string, unknown>): unknown {
  const target = countedExpense(state);
  const items = (state[collection] ?? []) as readonly { readonly id: string }[];
  const index = collection === "transactions" ? items.findIndex((item) => item.id === target.id) : 0;
  return { ...state, [collection]: items.map((item, position) => (position === index ? { ...item, ...change } : item)) };
}

describe("метки, заметки и оформление в резервной копии", () => {
  it("держит пределы копии вровень с доменом", () => {
    expect(BACKUP_LIMITS.textLength).toBe(NOTE_MAX_LENGTH);
    expect(BACKUP_LIMITS.tagsPerTransaction).toBe(MAX_TAGS_PER_TRANSACTION);
    expect(BACKUP_LIMITS.tagNameLength).toBe(TAG_NAME_MAX_LENGTH);
  });

  it("копия без новых полей их не приобретает: ни меток, ни пустых списков", () => {
    const legacy = makePlanningSeed();

    const restored = parseAndValidateBudgetBackup(serializeBackup(legacy));

    expect(JSON.stringify(restored)).toBe(JSON.stringify(legacy));
    expect("tags" in restored).toBe(false);
    for (const transaction of restored.transactions) {
      expect(Object.hasOwn(transaction, "note") || Object.hasOwn(transaction, "tagIds")).toBe(false);
    }
  });

  it("сохраняет метки, заметки и оформление при round-trip и пишет копию версии 2", async () => {
    const labelled = withLabels(makePlanningSeed());
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();
    const repairs: BackupRepair[] = [];

    const exported = await createBudgetBackup(labelled, vi.fn(async () => undefined), { createdAt: "2026-10-18T09:00:00.000Z" });
    expect((JSON.parse(exported.text) as { schemaVersion: number }).schemaVersion).toBe(2);

    const restored = parseAndValidateBudgetBackup(exported.text, (repair) => repairs.push(repair));
    expect(repairs).toEqual([]);
    expect(restored).toEqual(labelled);
    await expect(restoreBudgetBackup(backupFile(labelled), save, publish)).resolves.toEqual(labelled);
    expect(save).toHaveBeenCalledExactlyOnceWith(labelled);
    // Ни одна цифра не сдвинулась оттого, что всё помечено.
    expect(calculateBudget(restored)).toEqual(calculateBudget(makePlanningSeed()));
  });

  it.each([
    ["заметка с пробелом в начале", "transactions", { note: " Пятёрочка" }, /transactions\[\d+\]\.note: заметка/u],
    ["заметка в две строки", "transactions", { note: "Пятёрочка\nу дома" }, /transactions\[\d+\]\.note: заметка/u],
    ["заметка с bidi-символом", "transactions", { note: "Пятёрочка\u202e" }, /transactions\[\d+\]\.note: заметка/u],
    ["пустая заметка", "transactions", { note: "" }, /transactions\[\d+\]\.note: ожидалась непустая строка/u],
    ["заметка длиннее 500", "transactions", { note: "я".repeat(501) }, /transactions\[\d+\]\.note: строка длиннее 500/u],
    ["заметка не строка", "transactions", { note: 42 }, /transactions\[\d+\]\.note: ожидалась непустая строка/u],
    ["пустой список меток", "transactions", { tagIds: [] }, /transactions\[\d+\]\.tagIds: ожидался непустой список/u],
    ["больше десяти меток", "transactions", { tagIds: Array.from({ length: 11 }, () => TAG_HOME.id) }, /tagIds: допускается не более 10/u],
    ["повтор метки", "transactions", { tagIds: [TAG_HOME.id, TAG_HOME.id] }, /tagIds: метка повторяется/u],
    ["метка не UUID", "transactions", { tagIds: ["tag-1"] }, /tagIds\[0\]: некорректный UUID/u],
    ["метки не список", "transactions", { tagIds: TAG_HOME.id }, /tagIds: ожидался список/u],
    ["правило не UUID", "transactions", { recurringRuleId: "rule-1" }, /recurringRuleId: некорректный UUID/u],
    ["название метки с пробелом", "tags", { name: "Дом " }, /tags\[0\]\.name: название метки/u],
    ["название метки длиннее 40", "tags", { name: "я".repeat(41) }, /tags\[0\]\.name: строка длиннее 40/u],
    ["название метки с мягким переносом", "tags", { name: "Д\u00adом" }, /tags\[0\]\.name: название метки/u],
    ["признак метки строкой", "tags", { active: "yes" }, /tags\[0\]\.active: ожидалось логическое значение/u],
    ["метка не UUID в списке меток", "tags", { id: "tag-1" }, /tags\[0\]\.id: некорректный UUID/u],
    ["иконка счёта цветом", "accounts", { icon: "#00ff00" }, /accounts\[0\]\.icon: недопустимый ключ оформления/u],
    ["цвет счёта именем файла", "accounts", { color: "sage.png" }, /accounts\[0\]\.color: недопустимый ключ оформления/u],
    ["дробный порядок счёта", "accounts", { sortOrder: 1.5 }, /accounts\[0\]\.sortOrder: ожидалось целое число/u],
    ["includeInTotal строкой", "accounts", { includeInTotal: "yes" }, /accounts\[0\]\.includeInTotal: ожидалось логическое значение/u],
    ["цвет категории с заглавной", "categories", { color: "Mint" }, /categories\[0\]\.color: недопустимый ключ оформления/u],
    ["невозможный срок цели", "goals", { deadline: "2027-02-29" }, /goals\[0\]\.deadline: невозможная календарная дата/u],
    ["срок цели за окном журнала", "goals", { deadline: "2200-01-01" }, /goals\[0\]\.deadline: дата вне диапазона 1900-01-01…2199-12-31/u],
    ["срок цели до окна журнала", "goals", { deadline: "1899-12-31" }, /goals\[0\]\.deadline: дата вне диапазона/u],
    ["порядок счёта за пределом", "accounts", { sortOrder: 1_000_001 }, /accounts\[0\]\.sortOrder: порядок вне диапазона ±1000000/u],
    ["отрицательный порядок счёта за пределом", "accounts", { sortOrder: -1_000_001 }, /accounts\[0\]\.sortOrder: порядок вне диапазона/u],
    ["иконка цели не строка", "goals", { icon: 7 }, /goals\[0\]\.icon: ожидалась непустая строка/u],
  ] as const)("отклоняет копию: %s — до save/publish", async (_name, collection, change, expected) => {
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();
    const malformed = mutate(withLabels(makePlanningSeed()), collection, change);

    expect(() => prepareBudgetState(malformed)).toThrow(expected);
    await expect(restoreBudgetBackup(backupFile(malformed), save, publish)).rejects.toThrow(expected);
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("принимает хранимую метку, которую правило ввода отвергло бы: алфавиты и новые буквы — дело ввода", () => {
    // Ревью безопасности HIGH-1: копия держится правила хранения, которое не спрашивает движок о
    // Unicode, — иначе копия, сделанная вчера, после обновления браузера перестала бы читаться.
    for (const name of ["Дом Home", "Дача\ua7cd", "\u0378"]) {
      const state = mutate(withLabels(makePlanningSeed()), "tags", { name });
      expect(() => prepareBudgetState(state), JSON.stringify(name)).not.toThrow();
    }
    const noted = mutate(withLabels(makePlanningSeed()), "transactions", { note: "кофе \u{16d67}\u{16d67}" });
    expect(() => prepareBudgetState(noted)).not.toThrow();
  });

  it("ограничивает число участников и меток в файле, но не в документе, который приложение уже держит", async () => {
    // Несколько устройств, добавляя метки без связи, вместе переходят предел. Документ из журнала
    // семьи открывается, файл с таким числом пишется — с предупреждением, что восстановить его эта
    // сборка не сможет, — и не читается.
    const tags = Array.from({ length: BACKUP_LIMITS.tags + 1 }, (_, index) => ({
      id: `c0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Метка ${index}`,
      active: true,
    }));
    const members = Array.from({ length: BACKUP_LIMITS.members + 1 }, (_, index) => ({
      ...OWNER,
      id: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const merged: BudgetState = { ...makePlanningSeed(), tags, members };

    expect(prepareBudgetState(merged)).toEqual(merged);
    expect(prepareBudgetState(merged, undefined, "document")).toEqual(merged);
    expect(() => prepareBudgetState(merged, undefined, "file")).toThrow(`members: допускается не более ${BACKUP_LIMITS.members} элементов`);
    const exported = await createBudgetBackup(merged, vi.fn(async () => undefined));
    expect(exported.restoreWarning).toContain(`участников ${BACKUP_LIMITS.members + 1} при пределе ${BACKUP_LIMITS.members}`);
    expect(exported.restoreWarning).toContain(`меток ${BACKUP_LIMITS.tags + 1} при пределе ${BACKUP_LIMITS.tags}`);
    expect(() => parseAndValidateBudgetBackup(exported.text)).toThrow(`members: допускается не более ${BACKUP_LIMITS.members} элементов`);
    expect(() => parseAndValidateBudgetBackup(serializeBackup({ ...makePlanningSeed(), tags })))
      .toThrow(`tags: допускается не более ${BACKUP_LIMITS.tags} элементов`);
    // Предел общий с доменом: createTag отказывает на той же цифре.
    expect(BACKUP_LIMITS.tags).toBe(COLLECTION_LIMITS.tags);
    expect(BACKUP_LIMITS.members).toBe(COLLECTION_LIMITS.members);
  });

  it("ограничивает число меток наравне с прочими коллекциями", async () => {
    const tags = Array.from({ length: BACKUP_LIMITS.tags + 1 }, (_, index) => ({
      id: `c0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      // Если лимит не сработает первым, проверка формы упадёт с другой ошибкой.
      name: " ",
      active: true,
    }));
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();

    await expect(restoreBudgetBackup(backupFile({ ...makePlanningSeed(), tags }), save, publish)).rejects.toThrow(
      `tags: допускается не более ${BACKUP_LIMITS.tags} элементов`,
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("снимает метку, которой в копии нет, оставляя операцию, её деньги и остальные метки", async () => {
    const labelled = withLabels(makePlanningSeed());
    const target = countedExpense(labelled);
    const dangling = mutate(labelled, "transactions", { tagIds: [TAG_HOME.id, DELETED_TAG_ID] });
    const repairs: BackupRepair[] = [];
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();

    const restored = await restoreBudgetBackup(backupFile(dangling), save, publish, (repair) => repairs.push(repair));

    expect(repairs).toEqual([{ kind: "unknown_tag", transactionId: target.id, tagId: DELETED_TAG_ID }]);
    expect(restored.transactions.find((item) => item.id === target.id)).toEqual({
      ...labelled.transactions.find((item) => item.id === target.id),
      tagIds: [TAG_HOME.id],
    });
    expect(restored.transactions).toHaveLength(labelled.transactions.length);
    expect(save).toHaveBeenCalledExactlyOnceWith(restored);
    expect(calculateBudget(restored)).toEqual(calculateBudget(labelled));
  });

  it("снимает поле целиком, когда не осталось ни одной известной метки, и когда меток в копии нет вовсе", () => {
    const seed = makePlanningSeed();
    const target = countedExpense(seed);
    const repairs: BackupRepair[] = [];

    const restored = prepareBudgetState(
      mutate(seed, "transactions", { tagIds: [DELETED_TAG_ID] }),
      (repair) => repairs.push(repair),
    );

    expect(repairs).toEqual([{ kind: "unknown_tag", transactionId: target.id, tagId: DELETED_TAG_ID }]);
    expect(restored).toEqual(seed);
    expect(Object.hasOwn(restored.transactions.find((item) => item.id === target.id)!, "tagIds")).toBe(false);
  });

  // Orchestrator step 12: rules are part of the model now, so the label is taken off only when the
  // copy does not carry the rule; the next test keeps one that it does.
  it("снимает метку регулярной операции, правила которой в копии нет", () => {
    const seed = makePlanningSeed();
    const target = countedExpense(seed);
    const repairs: BackupRepair[] = [];

    const restored = prepareBudgetState(
      mutate(seed, "transactions", { recurringRuleId: RULE_ID }),
      (repair) => repairs.push(repair),
    );

    expect(repairs).toEqual([{ kind: "unknown_recurring_rule", transactionId: target.id, recurringRuleId: RULE_ID }]);
    expect(restored).toEqual(seed);
  });

  it("оставляет метку регулярной операции, правило которой копия несёт", () => {
    const seed = makePlanningSeed();
    const target = countedExpense(seed);
    if (target.kind !== "expense") throw new Error("Test fixture expense is not an expense.");
    const rule = {
      id: RULE_ID,
      template: { kind: "expense", amountMinor: 150_000, accountId: target.accountId, categoryId: target.categoryId },
      frequency: "weekly",
      interval: 2,
      startDate: "2026-08-04",
      active: true,
    };
    const labelled = mutate({ ...seed, recurringRules: [rule] } as BudgetState, "transactions", { recurringRuleId: RULE_ID });
    const repairs: BackupRepair[] = [];

    const restored = parseAndValidateBudgetBackup(serializeBackup(labelled as BudgetState), (repair) => repairs.push(repair));

    expect(repairs).toEqual([]);
    expect(restored).toEqual(labelled);
  });

  it("не сохраняет висячую метку в созданной копии", async () => {
    const labelled = withLabels(makePlanningSeed());
    const dangling = mutate(labelled, "transactions", { tagIds: [DELETED_TAG_ID] }) as BudgetState;

    const created = await createBudgetBackup(dangling, vi.fn(async () => undefined), { createdAt: "2026-07-17T12:00:00.000Z" });

    expect(created.text).not.toContain(DELETED_TAG_ID);
    expect(() => calculateBudget(parseAndValidateBudgetBackup(created.text))).not.toThrow();
  });
});

describe("валюты в резервной копии", () => {
  const dollarExpense = (state: BudgetState, change: Record<string, unknown>): unknown => ({
    ...state,
    transactions: state.transactions.map((item) => (item.id === DOLLAR_EXPENSE_ID ? { ...item, ...change } : item)),
  });
  const transfer = (toAccountId: string, extra: Record<string, unknown> = {}) => (state: BudgetState): unknown => ({
    ...state,
    transactions: [...state.transactions, {
      id: "c5555555-5555-4555-8555-555555555559", occurredOn: "2026-07-05", status: "posted", kind: "transfer",
      amountMinor: 1_800_000, fromAccountId: state.accounts[0]!.id, toAccountId, ...extra,
    }],
  });
  const rate = (change: Record<string, unknown>) => (state: BudgetState): unknown => ({
    ...state,
    exchangeRates: [{ ...state.exchangeRates![0]!, ...change }],
  });

  it.each([
    ["хозяйство под чужим идентификатором", (state: BudgetState) => ({ ...state, household: { id: "c5555555-5555-4555-8555-5555555555ff", baseCurrency: "RUB" } }), /household\.id: хозяйство записывается под выведенным идентификатором/u],
    ["база в неизвестной валюте", (state: BudgetState) => ({ ...state, household: { id: HOUSEHOLD_ID, baseCurrency: "XYZ" } }), /household\.baseCurrency: недопустимое значение/u],
    ["курс валюты к ней самой", rate({ currency: "RUB" }), /exchangeRates\[0\]: курс валюты к ней самой/u],
    ["курс неизвестной валюты", rate({ currency: "XAU" }), /exchangeRates\[0\]\.currency: недопустимое значение/u],
    ["курс за окном журнала", rate({ date: "2200-01-01" }), /exchangeRates\[0\]\.date: дата вне диапазона/u],
    ["курс с нулевой частью", rate({ rate: { baseMinor: 0, quoteMinor: 100 } }), /exchangeRates\[0\]\.rate: части курса/u],
    ["курс с лишним полем", rate({ rate: { baseMinor: 9_000, quoteMinor: 100, scale: 2 } }), /exchangeRates\[0\]\.rate: лишнее поле scale/u],
    ["курс не UUID", rate({ id: "rate-1" }), /exchangeRates\[0\]\.id: некорректный UUID/u],
    ["полснимка", (state: BudgetState) => ({
      ...state,
      transactions: state.transactions.map((item) => {
        if (item.id !== DOLLAR_EXPENSE_ID || item.kind !== "expense") return item;
        const { rate: _rate, ...partial } = item;
        return partial;
      }),
    }), /сумма в базовой валюте записывается тремя полями/u],
    ["снимок вне потолка поля", (state: BudgetState) => dollarExpense(state, { baseAmountMinor: 10 ** 10 + 1 }), /baseAmountMinor: сумма от 1 до 10000000000/u],
    ["снимок в другой базе", (state: BudgetState) => dollarExpense(state, { baseCurrency: "EUR" }), /baseCurrency: сумма записана не в базовой валюте RUB/u],
    ["снимок не равен сумме по курсу", (state: BudgetState) => dollarExpense(state, { baseAmountMinor: 370_000 }), /baseAmountMinor: сумма в базовой валюте не равна сумме операции по её курсу — 360000/u],
    ["долларовая покупка за потолком поля", (state: BudgetState) => dollarExpense(state, { amountMinor: 10 ** 10 + 1, baseAmountMinor: 5_000_000_001, rate: { baseMinor: 1, quoteMinor: 2 } }), /transactions\[\d+\]\.amountMinor: сумма от 1 до 10000000000/u],
    ["долларовая покупка за окном журнала", (state: BudgetState) => dollarExpense(state, { occurredOn: "2200-01-01" }), /transactions\[\d+\]\.occurredOn: дата вне диапазона/u],
    ["снимок у рублёвой операции", (state: BudgetState) => ({ ...state, transactions: state.transactions.map((item, index) => (index === 1 ? { ...item, baseAmountMinor: 1, baseCurrency: "RUB", rate: { baseMinor: 1, quoteMinor: 1 } } : item)) }), /операция в базовой валюте RUB не несёт второй суммы/u],
    ["сумма зачисления у расхода", (state: BudgetState) => dollarExpense(state, { toAmountMinor: 100 }), /toAmountMinor: сумма зачисления бывает только у перевода/u],
    ["перевод в доллары без суммы зачисления", transfer(DOLLAR_ACCOUNT_ID), /перевод из RUB в USD без суммы зачисления/u],
    ["перевод в рублях с суммой зачисления", (state: BudgetState) => transfer(state.accounts[1]!.id, { toAmountMinor: 100 })(state), /toAmountMinor: перевод в одной валюте/u],
  ] as const)("отклоняет копию: %s — до save/publish", async (_name, mutate, expected) => {
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();
    const malformed = mutate(withDollars(makePlanningSeed()));

    expect(() => prepareBudgetState(malformed)).toThrow(expected);
    await expect(restoreBudgetBackup(backupFile(malformed), save, publish)).rejects.toThrow(expected);
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("принимает перевод в доллары с суммой зачисления", () => {
    const state = transfer(DOLLAR_ACCOUNT_ID, { toAmountMinor: 20_000 })(withDollars(makePlanningSeed())) as BudgetState;
    expect(prepareBudgetState(state)).toEqual(state);
  });

  it("дни выплат (D-039) проходят копию туда и обратно в schemaVersion 2, и неверный список отвергается словами", () => {
    const state = setHouseholdPaydays(makePlanningSeed(), [5, 20]);
    const text = serializeBackup(state);
    expect(JSON.parse(text).schemaVersion).toBe(2);
    const restored = parseAndValidateBudgetBackup(text);
    expect(restored.household).toEqual({ id: HOUSEHOLD_ID, baseCurrency: "RUB", paydays: [5, 20] });
    expect(restored).toEqual(state);
    for (const paydays of [[], [20, 5], [5, 5], [0], [32], [1, 2, 3, 4, 5], ["5"]]) {
      const broken = { ...state, household: { id: HOUSEHOLD_ID, baseCurrency: "RUB", paydays } };
      expect(() => prepareBudgetState(broken), JSON.stringify(paydays)).toThrow(/household\.paydays: дни выплат/u);
    }
  });

  it("копия без хозяйства и курсов их не приобретает", () => {
    const legacy = makePlanningSeed();
    const restored = parseAndValidateBudgetBackup(serializeBackup(legacy));
    expect("household" in restored || "exchangeRates" in restored).toBe(false);
  });

  it("ограничивает число курсов в файле, но не в документе", () => {
    const base = withDollars(makePlanningSeed());
    const exchangeRates = Array.from({ length: BACKUP_LIMITS.exchangeRates + 1 }, (_, index) => ({
      ...base.exchangeRates![0]!,
      id: `c6000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const many: BudgetState = { ...base, exchangeRates };
    expect(BACKUP_LIMITS.exchangeRates).toBe(COLLECTION_LIMITS.exchangeRates);
    expect(prepareBudgetState(many)).toEqual(many);
    expect(() => prepareBudgetState(many, undefined, "file")).toThrow(`exchangeRates: допускается не более ${BACKUP_LIMITS.exchangeRates} элементов`);
  });
});

describe("долги в резервной копии", () => {
  const PETYA = "c7777777-7777-4777-8777-777777777771";
  const indebted = (change: Record<string, unknown> = {}): BudgetState => ({
    ...makePlanningSeed(),
    // Чужой файл: в поле может оказаться что угодно, поэтому запись приводится к типу, а не собирается по нему.
    debts: [{ id: PETYA, counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 300_000, active: true, ...change } as Debt],
  });

  it("восстанавливает долг байт в байт, а копия без долгов их не приобретает", async () => {
    const state = indebted({ dueDate: "2026-12-31", currency: "USD", direction: "i_owe" });
    expect(parseAndValidateBudgetBackup(serializeBackup(state))).toEqual(state);
    const exported = await createBudgetBackup(state, vi.fn(async () => undefined));
    expect(parseAndValidateBudgetBackup(exported.text)).toEqual(state);
    expect("debts" in parseAndValidateBudgetBackup(serializeBackup(makePlanningSeed()))).toBe(false);
  });

  it.each([
    ["имя с пробелом", { counterparty: "Петя " }, /debts\[0\]\.counterparty: имя с лишними пробелами/u],
    ["имя длиннее 80", { counterparty: "я".repeat(81) }, /debts\[0\]\.counterparty: строка длиннее 80/u],
    ["чужое направление", { direction: "lent" }, /debts\[0\]\.direction: недопустимое значение/u],
    ["неизвестная валюта", { currency: "XYZ" }, /debts\[0\]\.currency: недопустимое значение/u],
    ["отрицательная сумма", { openingMinor: -1 }, /debts\[0\]\.openingMinor: сумма от 0/u],
    ["срок за окном журнала", { dueDate: "2200-01-01" }, /debts\[0\]\.dueDate: дата вне диапазона/u],
    ["признак строкой", { active: "yes" }, /debts\[0\]\.active: ожидалось логическое значение/u],
    ["не UUID", { id: "debt-1" }, /debts\[0\]\.id: некорректный UUID/u],
  ] as const)("отклоняет копию: %s", (_name, change, expected) => {
    expect(() => prepareBudgetState(indebted(change))).toThrow(expected);
  });

  const lending = (change: Record<string, unknown> = {}, debt: Record<string, unknown> = {}): unknown => {
    const state = indebted(debt);
    return {
      ...state,
      transactions: [...state.transactions, {
        id: "c7777777-7777-4777-8777-777777777772", kind: "debt_out", status: "posted", occurredOn: "2026-07-09",
        amountMinor: 500_000, accountId: state.accounts[0]!.id, debtId: PETYA, ...change,
      }],
    };
  };

  it("восстанавливает движение по долгу и отвергает движение без долга — его деньгам не к чему относиться", async () => {
    const state = lending() as BudgetState;
    expect(parseAndValidateBudgetBackup(serializeBackup(state))).toEqual(state);
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockResolvedValue(undefined);
    const publish = vi.fn<(_: BudgetState) => void>();
    const orphan = lending({ debtId: "c7777777-7777-4777-8777-7777777777ff" });
    await expect(restoreBudgetBackup(backupFile(orphan), save, publish)).rejects.toThrow(/transactions\[\d+\]\.debtId: неизвестный долг/u);
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    ["долг не UUID", { debtId: "debt-1" }, {}, /transactions\[\d+\]\.debtId: некорректный UUID/u],
    ["без долга", { debtId: undefined }, {}, /transactions\[\d+\]\.debtId: ожидалась непустая строка/u],
    ["сумма в валюте долга при одной валюте", { debtAmountMinor: 5_000 }, {}, /debtAmountMinor: счёт и долг в одной валюте/u],
    ["без суммы в валюте долга при разных валютах", {}, { currency: "USD" }, /без суммы в валюте долга/u],
    ["сумма в валюте долга у перевода", { kind: "transfer", fromAccountId: "x", toAccountId: "y", debtAmountMinor: 1 }, {}, /debtAmountMinor: сумма в валюте долга бывает только у операции по долгу/u],
    ["снимок у движения", { baseAmountMinor: 1, baseCurrency: "RUB", rate: { baseMinor: 1, quoteMinor: 1 } }, {}, /baseAmountMinor: у такой операции нет суммы в базовой валюте/u],
  ] as const)("отклоняет движение по долгу: %s", (_name, change, debt, expected) => {
    expect(() => prepareBudgetState(JSON.parse(JSON.stringify(lending(change, debt))) as unknown)).toThrow(expected);
  });

  it("ограничивает число долгов в файле, но не в документе", () => {
    const debts = Array.from({ length: BACKUP_LIMITS.debts + 1 }, (_, index) => ({
      id: `c7000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      counterparty: `Сосед ${index}`, direction: "owed_to_me" as const, currency: "RUB", openingMinor: 0, active: true,
    }));
    const many: BudgetState = { ...makePlanningSeed(), debts };
    expect(BACKUP_LIMITS.debts).toBe(COLLECTION_LIMITS.debts);
    expect(prepareBudgetState(many)).toEqual(many);
    expect(() => prepareBudgetState(many, undefined, "file")).toThrow(`debts: допускается не более ${BACKUP_LIMITS.debts} элементов`);
  });
});

describe("пределы числа записей: файл, а не документ", () => {
  const uuid = (prefix: string, index: number): string => `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;

  /**
   * План-образец, в котором каждой коллекции на одну запись больше предела: столько семья набирает
   * честно, когда устройства создают офлайн и сливаются, — два устройства по шестьдесят счетов
   * дают сто двадцать.
   */
  const overEveryLimit = (): BudgetState => {
    const seed = makePlanningSeed();
    const expense = seed.categories.find((category) => category.type === "expense")!;
    const account = seed.accounts[0]!.id;
    const categories = [
      ...seed.categories,
      ...Array.from({ length: BACKUP_LIMITS.categories + 1 - seed.categories.length }, (_, index) => ({
        ...expense, id: uuid("c1000000", index), name: `Категория ${index}`, sortOrder: 1_000 + index,
      })),
    ];
    const expenseIds = categories.filter((category) => category.type === "expense").map((category) => category.id);
    const active = seed.budgets.find((budget) => budget.id === seed.activeBudgetId)!;
    // Строк в активном бюджете больше предела одного бюджета, а во всех вместе — больше общего.
    const lines = expenseIds.map((categoryId, index) => ({ id: uuid("c1100000", index), categoryId, plannedMinor: 100 }));
    const budgets = [
      { ...active, lines },
      ...Array.from({ length: BACKUP_LIMITS.budgets }, (_, index) => ({
        id: uuid("c1200000", index),
        startDate: `${1990 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`,
        endDate: `${1990 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-28`,
        status: "closed" as const, plannedIncomeMinor: 0, warningThreshold: 0.8,
        lines: index < 20 ? lines.map((line, lineIndex) => ({ ...line, id: uuid(`c13${String(index).padStart(5, "0")}`, lineIndex) })) : [],
      })),
    ];
    return {
      ...seed,
      accounts: [
        ...seed.accounts,
        ...Array.from({ length: BACKUP_LIMITS.accounts + 1 - seed.accounts.length }, (_, index) => ({
          id: uuid("c1400000", index), name: `Счёт ${index}`, type: "cash" as const, currency: "RUB", openingBalanceMinor: 0, active: true,
        })),
      ],
      categories,
      budgets,
      goals: Array.from({ length: BACKUP_LIMITS.goals + 1 }, (_, index) => ({
        id: uuid("c1500000", index), name: `Цель ${index}`, linkedAccountId: account, targetMinor: 100, openingContributedMinor: 0,
        plannedContributionMinor: 0, status: "active" as const,
      })),
      annualCommitments: Array.from({ length: BACKUP_LIMITS.annualCommitments + 1 }, (_, index) => ({
        id: uuid("c1600000", index), name: `Платёж ${index}`, categoryId: expense.id, accountId: account, dueDate: "2026-12-01",
        amountMinor: 100, reservedMinor: 0, recurrence: "annual" as const, active: index === 0,
      })),
      scheduledExpenses: Array.from({ length: BACKUP_LIMITS.scheduledExpenses + 1 }, (_, index) => ({
        id: uuid("c1700000", index), name: `Расход ${index}`, categoryId: expense.id, accountId: account, amountMinor: 100,
        dueDay: 5, mode: "monthly" as const, active: index === 0,
      })),
      transactions: [
        ...seed.transactions,
        ...Array.from({ length: BACKUP_LIMITS.transactions + 1 - seed.transactions.length }, (_, index): Transaction => ({
          id: uuid("c1800000", index), occurredOn: "2026-06-15", status: "posted", kind: "expense", amountMinor: 1, accountId: account, categoryId: expense.id,
        })),
      ],
    };
  };

  it("документ сверх любого предела открывается, а файл с ним не восстанавливается и не пишется", async () => {
    const state = overEveryLimit();
    expect(state.accounts.length).toBe(BACKUP_LIMITS.accounts + 1);
    expect(state.categories.length).toBe(BACKUP_LIMITS.categories + 1);
    expect(state.budgets.length).toBe(BACKUP_LIMITS.budgets + 1);
    expect(state.budgets[0]!.lines.length).toBeGreaterThan(BACKUP_LIMITS.linesPerBudget);
    expect(state.budgets.reduce((total, budget) => total + budget.lines.length, 0)).toBeGreaterThan(BACKUP_LIMITS.totalBudgetLines);
    expect(state.transactions.length).toBe(BACKUP_LIMITS.transactions + 1);

    // A state the app holds — its own, or the family's from the journal — is never refused for a count.
    expect(prepareBudgetState(state)).toEqual(state);
    // A file is refused, naming the first collection over its limit. Writing a copy of this state is
    // refused too, but by the file format, not by a count of a kind: it carries about 12 500 plain
    // operations (100 000 nodes, 5 MB; measured in over-limit.test.ts), and 50 001 are four times
    // that (over-limit.test.ts writes every other kind past its limit).
    expect(() => prepareBudgetState(state, undefined, "file")).toThrow(`accounts: допускается не более ${BACKUP_LIMITS.accounts} элементов`);
    await expect(createBudgetBackup(state, vi.fn(async () => undefined))).rejects.toThrow(/Резервная копия содержит слишком/u);
  }, 60_000);

  it("файл называет каждый предел по очереди, пока семья не приведёт число в рамки", () => {
    const cut = (state: BudgetState, key: "accounts" | "categories" | "budgets" | "goals" | "transactions" | "annualCommitments", limit: number): BudgetState =>
      ({ ...state, [key]: state[key].slice(0, limit) });
    const steps: readonly (readonly [string, (state: BudgetState) => BudgetState])[] = [
      [`accounts: допускается не более ${BACKUP_LIMITS.accounts} элементов`, (state) => state],
      [`categories: допускается не более ${BACKUP_LIMITS.categories} элементов`, (state) => cut(state, "accounts", BACKUP_LIMITS.accounts)],
      [`budgets: допускается не более ${BACKUP_LIMITS.budgets} элементов`, (state) => cut(state, "categories", BACKUP_LIMITS.categories)],
      [`budgets[0].lines: допускается не более ${BACKUP_LIMITS.linesPerBudget} элементов`, (state) => cut(state, "budgets", BACKUP_LIMITS.budgets)],
      [`budget lines: допускается не более ${BACKUP_LIMITS.totalBudgetLines} элементов суммарно`, (state) => ({
        ...state, budgets: state.budgets.map((budget) => ({ ...budget, lines: budget.lines.slice(0, BACKUP_LIMITS.linesPerBudget) })),
      })],
      [`goals: допускается не более ${BACKUP_LIMITS.goals} элементов`, (state) => ({
        ...state, budgets: state.budgets.map((budget, index) => (index === 0 ? budget : { ...budget, lines: [] })),
      })],
      [`transactions: допускается не более ${BACKUP_LIMITS.transactions} элементов`, (state) => cut(state, "goals", BACKUP_LIMITS.goals)],
      [`annualCommitments: допускается не более ${BACKUP_LIMITS.annualCommitments} элементов`, (state) => cut(state, "transactions", BACKUP_LIMITS.transactions)],
      [`scheduledExpenses: допускается не более ${BACKUP_LIMITS.scheduledExpenses} элементов`, (state) => cut(state, "annualCommitments", BACKUP_LIMITS.annualCommitments)],
    ];
    let state = overEveryLimit();
    for (const [message, bringDown] of steps) {
      state = bringDown(state);
      expect(() => prepareBudgetState(state, undefined, "file"), message).toThrow(message);
    }
  }, 60_000);

  it("каждый предел копии — предел домена, который журнал называет", () => {
    for (const key of ["accounts", "categories", "budgets", "goals", "annualCommitments", "scheduledExpenses", "transactions", "linesPerBudget"] as const) {
      expect(BACKUP_LIMITS[key], key).toBe(COLLECTION_LIMITS[key]);
    }
    expect(BACKUP_LIMITS.totalBudgetLines).toBe(COLLECTION_LIMITS.budgetLines);
  });
});

describe("суммы, которые задаёт участник семьи", () => {
  const KWD_RATE = "c7000000-0000-4000-8000-0000000000b1";
  const LENT = "c7000000-0000-4000-8000-0000000000b2";
  const OWED = "c7000000-0000-4000-8000-0000000000b3";
  const MOVED = "c7000000-0000-4000-8000-0000000000b4";

  /**
   * Сценарий ревью безопасности из значений, которые принимает каждый шлюз: динар по 9 000 ₽ за
   * филс с 1900 года, долг семье на потолок поля в динарах и копейка, отданная по долгу семьи с
   * суммой в динарах на тот же потолок. Каждый остаток в рублях помещается в безопасный диапазон —
   * 9·10¹⁵ и −9·10¹⁵, — а их разность нет: прежде расчёт долгов бросал, и шлюз отвергал состояние
   * на каждом устройстве семьи.
   */
  const kuwaiti = (movedOn: string): BudgetState => {
    const seed = makePlanningSeed();
    return {
      ...seed,
      exchangeRates: [{ id: KWD_RATE, currency: "KWD", baseCurrency: "RUB", date: "1900-01-01", rate: { baseMinor: 900_000, quoteMinor: 1 } }],
      debts: [
        { id: LENT, counterparty: "Али", direction: "owed_to_me", currency: "KWD", openingMinor: 10 ** 10, active: true },
        { id: OWED, counterparty: "Омар", direction: "i_owe", currency: "KWD", openingMinor: 0, active: true },
      ],
      transactions: [...seed.transactions, {
        id: MOVED, occurredOn: movedOn, status: "posted", kind: "debt_out", amountMinor: 1,
        accountId: seed.accounts[0]!.id, debtId: OWED, debtAmountMinor: 10 ** 10,
      }],
    };
  };

  it("принимает состояние, чьи итоги по долгам не представимы, вместо того чтобы отвергнуть его", () => {
    const state = kuwaiti("2026-07-15");
    expect(prepareBudgetState(state)).toEqual(state);
    expect(calculateDebts(state, "2026-07-31").netInBaseMinor).toBeNull();
  });

  it("не ломается при переходе месяца, когда движение после конца бюджета входит в окно", () => {
    const state = kuwaiti("2026-08-05");
    expect(prepareBudgetState(state)).toEqual(state);
    const august = carryBudgetForward(state, "2026-08").state;
    expect(august.activeBudgetId).not.toBe(state.activeBudgetId);
    expect(prepareBudgetState(august)).toEqual(august);
    expect(calculateDebts(august, "2026-08-31").netInBaseMinor).toBeNull();
  });
});

describe("регулярные операции в резервной копии", () => {
  const RULE = "c8888888-8888-4888-8888-888888888881";
  const TAG = "c8888888-8888-4888-8888-888888888882";
  const WATER = {
    kind: "expense", amountMinor: 150_000, accountId: SEED_IDS.accounts.main, categoryId: PLANNING_IDS.categories.food,
    note: "Доставка воды", tagIds: [TAG],
  };
  // Чужой файл: в поле может оказаться что угодно, поэтому запись приводится к типу, а не собирается по нему.
  const withRule = (change: Record<string, unknown> = {}, template: Record<string, unknown> = WATER): BudgetState => ({
    ...makePlanningSeed(),
    tags: [{ id: TAG, name: "Дом", active: true }],
    recurringRules: [{
      id: RULE, name: "Доставка воды", template, frequency: "weekly", interval: 2, startDate: "2026-07-07", active: true, ...change,
    } as unknown as RecurringRule],
  });

  it("восстанавливает правило и его вхождения байт в байт, а копия без правил их не приобретает", async () => {
    const state = materializeRecurring(withRule({ endDate: "2026-12-31" }), "2026-07-31").state;
    expect(state.transactions.filter((item) => item.recurringRuleId === RULE)).toHaveLength(2);
    expect(parseAndValidateBudgetBackup(serializeBackup(state))).toEqual(state);
    const exported = await createBudgetBackup(state, vi.fn(async () => undefined));
    expect(parseAndValidateBudgetBackup(exported.text)).toEqual(state);
    expect("recurringRules" in parseAndValidateBudgetBackup(serializeBackup(makePlanningSeed()))).toBe(false);
    const transfer = withRule({}, { kind: "transfer", amountMinor: 100_000, fromAccountId: SEED_IDS.accounts.main, toAccountId: SEED_IDS.accounts.savings });
    expect(parseAndValidateBudgetBackup(serializeBackup(transfer))).toEqual(transfer);
  });

  it.each([
    ["интервал 0", { interval: 0 }, WATER, /recurringRules\[0\]\.interval: целое число от 1 до 999/u],
    ["интервал 1000", { interval: 1_000 }, WATER, /recurringRules\[0\]\.interval: целое число от 1 до 999/u],
    ["своя частота", { frequency: "hourly" }, WATER, /recurringRules\[0\]\.frequency: недопустимое значение/u],
    ["конец раньше начала", { endDate: "2026-07-06" }, WATER, /recurringRules\[0\]\.endDate: последняя дата раньше первой/u],
    ["начало за окном журнала", { startDate: "2200-01-01" }, WATER, /recurringRules\[0\]\.startDate: дата вне диапазона/u],
    ["водяной знак в несуществующий день", { materializedThrough: "2026-02-30" }, WATER, /recurringRules\[0\]\.materializedThrough: невозможная календарная дата/u],
    ["имя с пробелом", { name: "Вода " }, WATER, /recurringRules\[0\]\.name: название с лишними пробелами/u],
    ["имя длиннее 80", { name: "я".repeat(81) }, WATER, /recurringRules\[0\]\.name: строка длиннее 80/u],
    ["признак строкой", { active: "yes" }, WATER, /recurringRules\[0\]\.active: ожидалось логическое значение/u],
    ["не UUID", { id: "rule-1" }, WATER, /recurringRules\[0\]\.id: некорректный UUID/u],
    ["без шаблона", { template: undefined }, WATER, /recurringRules\[0\]\.template: ожидался объект/u],
    ["шаблон возврата", {}, { ...WATER, kind: "refund" }, /recurringRules\[0\]\.template\.kind: недопустимое значение/u],
    ["лишнее поле шаблона", {}, { ...WATER, id: "c8888888-8888-4888-8888-888888888883" }, /recurringRules\[0\]\.template: лишнее поле id/u],
    ["снимок в шаблоне", {}, { ...WATER, baseAmountMinor: 1 }, /recurringRules\[0\]\.template: лишнее поле baseAmountMinor/u],
    ["шаблон на ноль", {}, { ...WATER, amountMinor: 0 }, /recurringRules\[0\]\.template\.amountMinor: сумма от 1/u],
    ["заметка в две строки", {}, { ...WATER, note: "Вода\nи хлеб" }, /recurringRules\[0\]\.template\.note: заметка в несколько строк/u],
    ["пустой список меток", {}, { ...WATER, tagIds: [] }, /recurringRules\[0\]\.template\.tagIds: ожидался непустой список/u],
    ["метка не UUID", {}, { ...WATER, tagIds: ["tag-1"] }, /recurringRules\[0\]\.template\.tagIds\[0\]: некорректный UUID/u],
    ["неизвестная метка", {}, { ...WATER, tagIds: ["c8888888-8888-4888-8888-8888888888ff"] }, /recurringRules\[0\]\.template\.tagIds: неизвестная метка/u],
    ["неизвестный счёт", {}, { ...WATER, accountId: "c8888888-8888-4888-8888-8888888888fe" }, /recurringRules\[0\]\.template\.accountId: неизвестный счёт/u],
    ["счёт не UUID", {}, { ...WATER, accountId: "account-1" }, /recurringRules\[0\]\.template\.accountId: некорректный UUID/u],
    ["расход без категории", {}, { kind: "expense", amountMinor: 1, accountId: SEED_IDS.accounts.main }, /recurringRules\[0\]\.template\.categoryId: ожидалась непустая строка/u],
    ["доход в расходной категории", {}, { kind: "income", amountMinor: 1, accountId: SEED_IDS.accounts.main, categoryId: PLANNING_IDS.categories.food }, /recurringRules\[0\]\.template\.categoryId: категория должна быть доходной/u],
    ["перевод на тот же счёт", {}, { kind: "transfer", amountMinor: 1, fromAccountId: SEED_IDS.accounts.main, toAccountId: SEED_IDS.accounts.main }, /recurringRules\[0\]\.template: перевод со счёта на него же/u],
    ["сумма зачисления в одной валюте", {}, { kind: "transfer", amountMinor: 1, fromAccountId: SEED_IDS.accounts.main, toAccountId: SEED_IDS.accounts.savings, toAmountMinor: 1 }, /toAmountMinor: перевод в одной валюте/u],
  ] as const)("отклоняет копию: %s", (_name, change, template, expected) => {
    expect(() => prepareBudgetState(JSON.parse(JSON.stringify(withRule(change, template))) as unknown)).toThrow(expected);
  });

  it("ограничивает число правил в файле, но не в документе", () => {
    const rules = Array.from({ length: BACKUP_LIMITS.recurringRules + 1 }, (_, index) => ({
      ...withRule().recurringRules![0]!,
      id: `c8000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const many: BudgetState = { ...withRule(), recurringRules: rules };
    expect(BACKUP_LIMITS.recurringRules).toBe(COLLECTION_LIMITS.recurringRules);
    expect(prepareBudgetState(many)).toEqual(many);
    expect(() => prepareBudgetState(many, undefined, "file")).toThrow(`recurringRules: допускается не более ${BACKUP_LIMITS.recurringRules} элементов`);
  });
});
