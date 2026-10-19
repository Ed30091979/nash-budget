import { expect, type Page } from "@playwright/test";
import { PLANNING_IDS, type BudgetState } from "@family-budget/domain";
import { serializeBackup } from "@family-budget/storage";
import { prepareBudgetState } from "../src/backup";
import { buildDemoBudgetState } from "../src/onboarding/demo";
import { localToday } from "../src/reach";

/**
 * Бюджеты прогона, которых нет в демо: счёт в долларах без курса, операция «в ожидании». Они
 * собираются из того же демо, что и кнопка «Загрузить демонстрационный бюджет», и приходят в
 * приложение тем же путём, что и у семьи, — резервной копией на экране «Ещё».
 */

/** Счёт в долларах, которого в демо нет: курса USD в бюджете тоже нет. */
export const DOLLARS_ID = "e2b00000-0000-4000-8000-0000000000d1";
export const DOLLARS_NAME = "Доллары";

/** Демо на сегодняшний день прогона — тот же, что видит браузер. */
export function demoBudget(): BudgetState {
  return buildDemoBudgetState();
}

/** Демо со счётом «Доллары» — 500 $, курса нет. */
export function withDollarAccount(state: BudgetState): BudgetState {
  return {
    ...state,
    accounts: [...state.accounts, { id: DOLLARS_ID, name: DOLLARS_NAME, type: "cash", currency: "USD", openingBalanceMinor: 50_000, active: true }],
  };
}

/** Расход «в ожидании»: банк его ещё не провёл, и в «Потрачено» он не входит. */
export const PENDING_EXPENSE_ID = "e2b00000-0000-4000-8000-0000000000e1";

/** Демо с расходом 5 432 ₽ в «Продуктах» сегодняшним числом — «в ожидании». */
export function withPendingExpense(state: BudgetState): BudgetState {
  const main = state.transactions.find((item) => item.kind === "income")?.accountId ?? state.accounts[0]!.id;
  return {
    ...state,
    transactions: [
      ...state.transactions,
      { id: PENDING_EXPENSE_ID, kind: "expense", status: "pending", occurredOn: localToday(new Date()), amountMinor: 543_200, accountId: main, categoryId: PLANNING_IDS.categories.food },
    ],
  };
}

/** «Ещё» → восстановить копию с этим бюджетом и дождаться слов приложения. */
export async function restoreBudget(page: Page, state: BudgetState): Promise<void> {
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.locator("#backup-file").setInputFiles({
    name: "family-budget-e2e.json",
    mimeType: "application/json",
    buffer: Buffer.from(serializeBackup(prepareBudgetState(state), { createdAt: new Date().toISOString() }), "utf8"),
  });
  await expect(page.getByRole("status").filter({ hasText: "Резервная копия восстановлена." })).toBeVisible();
}
