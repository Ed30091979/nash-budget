import { makePlanningSeed, type BudgetState } from "@family-budget/domain";
import { serializeBackup } from "@family-budget/storage";
import { describe, expect, it, vi } from "vitest";
import {
  BACKUP_LIMITS,
  MAX_BACKUP_FILE_BYTES,
  createBudgetBackup,
  parseAndValidateBudgetBackup,
  prepareBudgetState,
  restoreBudgetBackup,
} from "./backup";

function backupFile(payload: unknown, size?: number): { size: number; text(): Promise<string> } {
  const text = serializeBackup(payload);
  return { size: size ?? text.length, text: async () => text };
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
