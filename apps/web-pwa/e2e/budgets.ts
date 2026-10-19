import { expect, type Page } from "@playwright/test";
import type { BudgetState } from "@family-budget/domain";
import { serializeBackup } from "@family-budget/storage";
import { prepareBudgetState } from "../src/backup";
import { buildDemoBudgetState } from "../src/onboarding/demo";

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
