/**
 * Операция в другой валюте в настоящем браузере (план волны 2, §1.2, §1.6): курса нет — лист
 * говорит это до записи, курс задаётся тут же, и оценка в рублях встаёт под суммой.
 *
 * Ревью 2b, HIGH-1: форма курса была вложена в форму листа, и в Chromium её отправка не доходила
 * до обработчика — курс не записывался ни кнопкой, ни Enter, а с набранной суммой браузер уходил со
 * страницы с системным «Покинуть сайт?». `fixtures.ts` валит прогон на любом системном окне.
 */
import { expect, test } from "./fixtures";
import { demoBudget, DOLLARS_NAME, restoreBudget, withDollarAccount } from "./budgets";
import { amountField, entrySheet, goToOverview, loadDemo, submitButton, tile, toast } from "./sheet";

test("курса нет — «Задать курс» в листе: Enter и кнопка его записывают, оценка встаёт под суммой, расход записывается", async ({ page }) => {
  await loadDemo(page);
  await restoreBudget(page, withDollarAccount(demoBudget()));
  await goToOverview(page);

  await tile(page, DOLLARS_NAME).click();
  await tile(page, "Продукты").click();
  const sheet = entrySheet(page);
  await expect(sheet).toHaveAccessibleName(`Расход: ${DOLLARS_NAME} → Продукты`);
  const missing = sheet.getByText(/^Курса USD на день операции нет/u);
  await expect(missing).toBeVisible();
  const estimate = sheet.locator(".entry-foreign");

  // Enter в поле курса записывает курс — и не отправляет лист.
  await sheet.getByRole("button", { name: "Задать курс" }).click();
  const rate = sheet.getByRole("textbox", { name: "Сколько ₽ за 1 USD" });
  await rate.fill("92,50");
  await rate.press("Enter");
  await expect(missing).toHaveCount(0);
  await expect(estimate).toContainText("по курсу 92,50");
  await expect(sheet).toBeVisible();

  // Вчера курса ещё не было: лист снова говорит это, и кнопка «Сохранить курс» его задаёт.
  await sheet.getByRole("button", { name: "Вчера", exact: true }).click();
  await expect(missing).toBeVisible();
  await sheet.getByRole("button", { name: "Задать курс" }).click();
  await sheet.getByRole("textbox", { name: "Сколько ₽ за 1 USD" }).fill("91");
  await sheet.getByRole("button", { name: "Сохранить курс" }).click();
  await expect(missing).toHaveCount(0);
  await expect(estimate).toContainText("по курсу 91,00");

  // Сумма — и оценка считает от неё; запись уходит в долларах.
  await amountField(page).fill("10");
  await expect(estimate).toContainText(/≈ 910\s₽ по курсу 91,00/u);
  await submitButton(page).click();
  await expect(sheet).toHaveCount(0);
  await expect(toast(page, /Записано: расход 10\s\$/u)).toBeVisible();
});
