import { makePlanningSeed, type BudgetState } from "@family-budget/domain";
import { serializeBackup } from "@family-budget/storage";
import { describe, expect, it, vi } from "vitest";
import {
  BACKUP_LIMITS,
  MAX_BACKUP_FILE_BYTES,
  prepareBudgetState,
  restoreBudgetBackup,
} from "./backup";

function backupFile(payload: unknown, size?: number): { size: number; text(): Promise<string> } {
  const text = serializeBackup(payload);
  return { size: size ?? text.length, text: async () => text };
}

describe("восстановление бюджета", () => {
  it("дополняет legacy state, не заменяя счета, категории, бюджеты, цели и операции", () => {
    const seed = makePlanningSeed();
    const uniqueTransaction = {
      id: "legacy-unique-transaction",
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

  it("не публикует state, если IndexedDB не сохранил восстановление", async () => {
    const publish = vi.fn<(_: BudgetState) => void>();
    const save = vi.fn<(_: BudgetState) => Promise<void>>().mockRejectedValue(new Error("quota"));

    await expect(restoreBudgetBackup(backupFile(makePlanningSeed()), save, publish)).rejects.toThrow("quota");
    expect(publish).not.toHaveBeenCalled();
  });
});
