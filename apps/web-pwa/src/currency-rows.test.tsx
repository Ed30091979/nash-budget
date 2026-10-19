/**
 * Сумма операции — в валюте её счёта везде, где операция названа одна, а не только в истории.
 *
 * Второе ревью волны 1, LOW-7: «Последние записи» на «Сегодня», квитанция записи и подтверждение
 * удаления в «Записать» показывали покупку по долларовому счёту с «₽». С 2b операцию называют строка
 * «Операций», тост «Записано» листа ввода и его вопрос «Удалить операцию?» — правило то же: валюта
 * строки — валюта счёта (`transactionCurrency`); суммы бюджета и лимитов остаются в базовой валюте,
 * потому что считаются по снимкам.
 */
import { readFileSync } from "node:fs";
import { makeSeedBudget, SEED_IDS, type BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { operationWords } from "./app/entry-controller";
import { draftCurrency, newEntryDraft } from "./features/entry/entry-model";
import { EntryReceipt } from "./features/entry/EntryReceipt";
import { FeedScreen } from "./features/feed/FeedScreen";
import { OperationAmount } from "./features/operations/OperationAmount";
import { moneyIn, operationLabel } from "./features/operations/transaction-words";
import { formatMoney } from "./money";

const DOLLARS = "c5555555-5555-4555-8555-555555555561";
const DOLLAR_EXPENSE = "c5555555-5555-4555-8555-555555555562";

/** Цифры и знаки без неразрывных пробелов, как их читает глаз. */
function plainText(value: string): string {
  return value.replace(/<[^>]+>/gu, "").replace(/[\u00a0\u202f]/gu, " ");
}

function withDollarExpense(): BudgetState {
  const seed = makeSeedBudget();
  return {
    ...seed,
    accounts: [...seed.accounts, { id: DOLLARS, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true }],
    transactions: [{
      id: DOLLAR_EXPENSE, occurredOn: "2026-07-10", status: "posted", kind: "expense", amountMinor: 4_050,
      accountId: DOLLARS, categoryId: SEED_IDS.categories.food, baseAmountMinor: 364_500, baseCurrency: "RUB", rate: { baseMinor: 9_000, quoteMinor: 100 },
    }, ...seed.transactions],
  };
}

describe("сумма операции в валюте её счёта", () => {
  it("строка «Операций» подписывает долларовую покупку долларами", () => {
    const state = withDollarExpense();
    const markup = plainText(renderToStaticMarkup(<FeedScreen budget={state} today="2026-07-13" filters={{}} onFilters={vi.fn()} onEdit={vi.fn()} onAdd={vi.fn()} onImport={vi.fn()} />));
    expect(markup).toContain("−40,50 $");
    // Под суммой в долларах — снимок в рублях, которым её считает бюджет (DESIGN §7).
    expect(markup).toContain("≈ 3 645 ₽");
    expect(markup).not.toContain("40,50 ₽");
    // A rouble row next to it is drawn exactly as before.
    const rouble = state.transactions.find((item) => item.kind === "expense" && item.id !== DOLLAR_EXPENSE && item.status === "posted")!;
    expect(markup).toContain(plainText(formatMoney(rouble.amountMinor)));
  });

  it("тост «Записано» называет сумму в валюте счёта, с которого записано", () => {
    const state = withDollarExpense();
    const dollars = newEntryDraft(state, { kind: "expense", accountId: DOLLARS, categoryId: SEED_IDS.categories.food }, "2026-07-10");
    expect(draftCurrency(state, dollars)).toBe("USD");
    expect(draftCurrency(state, { ...dollars, mode: "transfer", toAccountId: SEED_IDS.accounts.main })).toBe("USD");
    expect(draftCurrency(state, { ...dollars, accountId: SEED_IDS.accounts.main })).toBe("RUB");
    const dollar = state.transactions[0]!;
    expect(plainText(operationWords("Записано", dollar, state))).toBe("Записано: расход 40,50 $");
    const rouble = state.transactions.find((item) => item.kind === "expense" && item.id !== DOLLAR_EXPENSE)!;
    expect(plainText(operationWords("Записано", rouble, state))).toBe(`Записано: расход ${plainText(formatMoney(rouble.amountMinor))}`);
    // Остаток счёта под тостом — тоже в валюте счёта.
    const receipt = plainText(renderToStaticMarkup(<EntryReceipt value={{ label: "Остаток на счёте «Доллары»", beforeMinor: 50_000, afterMinor: 45_950, currency: "USD" }} />));
    expect(receipt).toContain("$");
    expect(receipt).not.toContain("₽");
  });

  it("вопрос «Удалить операцию?» и тост «Удалено» называют операцию с её валютой", () => {
    const state = withDollarExpense();
    const dollar = state.transactions[0]!;
    expect(plainText(operationLabel(dollar, state))).toBe("Расход 40,50 $ от 2026-07-10");
    const sheet = readFileSync(new URL("./features/entry/EntrySheet.tsx", import.meta.url), "utf8");
    expect(sheet).toContain("description={`${operationLabel(editing, budget)}. Все суммы и лимиты будут пересчитаны.`}");
    expect(sheet).toContain("description={`${operationLabel(transaction, budget)}. Все суммы будут пересчитаны.`}");
    const controller = readFileSync(new URL("./app/entry-controller.tsx", import.meta.url), "utf8");
    expect(controller).toContain('const label = operationWords("Удалено", transaction, before);');
    // Every other figure on that screen is the budget's, in roubles, as before.
    expect(plainText(moneyIn(4_050, "USD"))).toBe("40,50 $");
    expect(moneyIn(4_050, "RUB")).toBe(formatMoney(4_050));
    expect(plainText(renderToStaticMarkup(<OperationAmount value={4_050} currency="USD" sign="−" />))).toBe("−40,50 $");
  });
});
