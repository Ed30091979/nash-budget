import {
  calculateAnnualPlan,
  calculateBudget,
  calculateMemberExpenses,
  COLLECTION_LIMITS,
  HOUSEHOLD_ID,
  makePlanningSeed,
  MAX_TAGS_PER_TRANSACTION,
  NOTE_MAX_LENGTH,
  PLANNING_IDS,
  TAG_NAME_MAX_LENGTH,
  type BudgetState,
  type Member,
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
      if (transaction.kind === "income" || transaction.kind === "expense" || transaction.kind === "refund") {
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
    // семьи открывается, а файл с таким числом не пишется и не читается: восстановить его эта
    // сборка не смогла бы.
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
    await expect(createBudgetBackup(merged, vi.fn(async () => undefined))).rejects.toThrow(/допускается не более/);
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

  it("снимает метку регулярной операции: правил в этой версии модели нет", () => {
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
