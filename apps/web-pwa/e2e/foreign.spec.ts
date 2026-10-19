/**
 * Операция в другой валюте в настоящем браузере (план волны 2, §1.2, §1.6): курса нет — лист
 * говорит это до записи, курс задаётся тут же, и оценка в рублях встаёт под суммой.
 *
 * Ревью 2b, HIGH-1: форма курса была вложена в форму листа, и в Chromium её отправка не доходила
 * до обработчика — курс не записывался ни кнопкой, ни Enter, а с набранной суммой браузер уходил со
 * страницы с системным «Покинуть сайт?». `fixtures.ts` валит прогон на любом системном окне.
 */
import { expect, test } from "./fixtures";
import { addDays } from "@family-budget/domain";
import { demoBudget, dollarExpenseDay, DOLLARS_NAME, restoreBudget, withDollarAccount, withDollarExpenseAtOldRate } from "./budgets";
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

test("правка операции в долларах оценивает её тем курсом, который запишется, а новый день — курсом нового дня", async ({ page }) => {
  // Ревью 2b, MEDIUM-2: лист говорил «≈ 1 000 ₽ по курсу 100,00», а записывал 925 ₽ по курсу,
  // с которым операция была записана.
  await loadDemo(page);
  await restoreBudget(page, withDollarExpenseAtOldRate(demoBudget()));
  await goToOverview(page);
  const before = await tile(page, "Продукты").getAttribute("aria-label");

  await page.getByRole("button", { name: "Операции", exact: true }).click();
  const day = dollarExpenseDay();
  await page.getByRole("button", { name: `Изменить операцию «Расход 10\u00a0$ от ${day}»` }).click();
  const sheet = entrySheet(page);
  const estimate = sheet.locator(".entry-foreign");
  await expect(estimate).toContainText(/^≈ 925\s₽ по курсу 92,50, с которым операция записана/u);
  await expect(sheet.getByText(/^Курса USD/u)).toHaveCount(0);

  // Другой день (поле даты уже открыто: операция не сегодняшняя) — курс нового дня, и лист
  // говорит, почему цифра другая.
  await page.locator("#entry-date").fill(addDays(day, 1));
  await expect(estimate).toContainText(/^≈ 1\s000\s₽ по курсу 100,00 от .+ — дата или счёт изменились, курс нового дня/u);

  // Тот же день и только комментарий: записано по своему курсу — «Продукты» не сдвинулись.
  await page.locator("#entry-date").fill(day);
  await expect(estimate).toContainText(/^≈ 925\s₽/u);
  await sheet.getByRole("textbox", { name: "Комментарий" }).fill("сверено");
  await submitButton(page).click();
  await expect(toast(page, /Изменено: расход 10\s\$/u)).toBeVisible();
  await goToOverview(page);
  await expect(tile(page, "Продукты")).toHaveAttribute("aria-label", before ?? "");
});

test("«Задать курс»: «Отмена» и Esc возвращают фокус на «Задать курс», и следующий Esc закрывает лист", async ({ page }) => {
  // Ревью 2b, раунд 3, NEW-1: фокус падал на тело страницы, и Esc лист уже не закрывал.
  await loadDemo(page);
  await restoreBudget(page, withDollarAccount(demoBudget()));
  await goToOverview(page);
  const open = async () => {
    await tile(page, DOLLARS_NAME).click();
    await tile(page, "Продукты").click();
    await expect(entrySheet(page)).toBeVisible();
  };
  const sheet = entrySheet(page);
  const setRate = sheet.getByRole("button", { name: "Задать курс" });

  // «Отмена» с клавиатуры.
  await open();
  await setRate.click();
  await sheet.getByRole("button", { name: "Отмена" }).focus();
  await page.keyboard.press("Enter");
  await expect(sheet.getByRole("textbox", { name: "Сколько ₽ за 1 USD" })).toHaveCount(0);
  await expect(setRate).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Esc в поле курса.
  await open();
  await setRate.click();
  await sheet.getByRole("textbox", { name: "Сколько ₽ за 1 USD" }).focus();
  await page.keyboard.press("Escape");
  await expect(setRate).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
});
