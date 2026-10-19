/**
 * Сумма операции — в валюте её счёта везде, где операция названа одна, а не только в истории.
 *
 * Второе ревью волны 1, LOW-7: «Последние записи» на «Сегодня», квитанция записи и подтверждение
 * удаления в «Записать» показывали покупку по долларовому счёту с «₽». Валюта строки — валюта
 * счёта (`transactionCurrency`), так же, как в «Вся история»; суммы бюджета и конвертов остаются
 * в рублях, потому что считаются по снимкам.
 */
import { readFileSync } from "node:fs";
import {
  calculateAnnualPlan,
  calculateBudget,
  makeSeedBudget,
  SEED_IDS,
  type BudgetState,
} from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TodayScreen } from "./features/today/TodayScreen";
import { MEMBER_FILTER_ALL } from "./features/family";
import { OperationAmount } from "./features/operations/OperationAmount";
import { SaveReceiptView } from "./features/operations/OperationsScreen";
import { draftCurrency, moneyIn, operationLabel } from "./features/operations/transaction-words";
import { formatMoney } from "./money";
import { periodClock } from "./reach";

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

function renderToday(state: BudgetState): string {
  const active = state.budgets.find((budget) => budget.id === state.activeBudgetId)!;
  const metrics = calculateBudget(state);
  const plan = calculateAnnualPlan(state, active.startDate.slice(0, 7), 24);
  return renderToStaticMarkup(
    <TodayScreen
      budget={state}
      plan={plan}
      flexibleRows={[]}
      safeToSpendMinor={plan.currentMonth.flexiblePlanMinor}
      flexibleSpentMinor={metrics.expensesMinor}
      clock={periodClock(active, [], "2026-07-15")}
      recentTransactions={state.transactions.filter((item) => item.status === "posted").slice(0, 5)}
      categoryById={new Map(state.categories.map((category) => [category.id, category]))}
      memberById={new Map()}
      memberOptions={[]}
      memberFilter={MEMBER_FILTER_ALL}
      onMemberFilterChange={() => undefined}
      hasRecords
      monthToOpen={null}
      onAdd={() => undefined}
      onYear={() => undefined}
      onPlanning={() => undefined}
      familyNews={[]}
    />,
  );
}

describe("сумма операции в валюте её счёта", () => {
  it("«Последние записи» на «Сегодня» подписывают долларовую покупку долларами", () => {
    const state = withDollarExpense();
    const markup = plainText(renderToday(state));
    expect(markup).toContain("−40,50 $");
    expect(markup).not.toContain("40,50 ₽");
    // A rouble row next to it is drawn exactly as before.
    const rouble = state.transactions.find((item) => item.kind === "expense" && item.id !== DOLLAR_EXPENSE && item.status === "posted")!;
    expect(markup).toContain(plainText(formatMoney(rouble.amountMinor)));
  });

  it("квитанция записи называет сумму в валюте счёта, с которого записано", () => {
    const state = withDollarExpense();
    const currency = draftCurrency({ kind: "expense", accountId: DOLLARS }, state);
    expect(currency).toBe("USD");
    expect(draftCurrency({ kind: "transfer", fromAccountId: DOLLARS }, state)).toBe("USD");
    expect(draftCurrency({ kind: "expense", accountId: SEED_IDS.accounts.main }, state)).toBe("RUB");
    const receipt = (value: string) => plainText(renderToStaticMarkup(
      <SaveReceiptView receipt={{ verb: "Записано", kind: "expense", amountMinor: 4_050, currency: value, target: null, beforeMinor: 0 }} afterMinor={null} />,
    ));
    expect(receipt(currency)).toContain("Записано: расход 40,50 $");
    expect(receipt(currency)).not.toContain("₽");
    expect(receipt("RUB")).toContain(`Записано: расход ${plainText(formatMoney(4_050))}`);
  });

  it("подтверждение удаления и правки называет операцию с её валютой", () => {
    const state = withDollarExpense();
    const dollar = state.transactions[0]!;
    expect(plainText(operationLabel(dollar, state))).toBe("Расход 40,50 $ от 2026-07-10");
    const source = readFileSync(new URL("./features/operations/OperationsScreen.tsx", import.meta.url), "utf8");
    expect(source).toContain('setConfirmation({ type: "delete", id: transaction.id, label: operationLabel(transaction, budget) });');
    expect(source).toContain("? operationLabel(editingTransaction, budget)");
    // The receipt is handed the account's currency at the moment of writing.
    expect(source).toContain("currency: draftCurrency(pending, budget),");
    // Every other figure on that screen is the budget's, in roubles, as before.
    expect(plainText(moneyIn(4_050, "USD"))).toBe("40,50 $");
    expect(moneyIn(4_050, "RUB")).toBe(formatMoney(4_050));
    expect(plainText(renderToStaticMarkup(<OperationAmount value={4_050} currency="USD" sign="−" />))).toBe("−40,50 $");
  });
});
