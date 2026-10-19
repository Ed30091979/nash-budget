/**
 * Тост «Записано» с «Отменить» во времени (ревью 2b, MEDIUM-5 и раунд 3, NEW-4; WCAG 2.2.1, 2.4.3).
 *
 * Часы страницы — поддельные (`page.clock`): десять секунд тоста проходят мгновенно и ровно тогда,
 * когда их отматывает проверка. Тост ждёт, пока на нём фокус или указатель и пока поверх лист или
 * любой другой вопрос приложения; закрытый — отдаёт фокус туда, откуда тот пришёл, а не телу страницы.
 */
import { expect, test } from "./fixtures";
import { amountField, entrySheet, loadDemo, submitButton, tile, toast } from "./sheet";

test("тост ждёт, пока на нём фокус, указатель или лист поверх, а закрытый — возвращает фокус на плитку", async ({ page }) => {
  await page.clock.install();
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const record = async (amount: string) => {
    await tile(page, "Продукты").click();
    await amountField(page).fill(amount);
    await submitButton(page).click();
    await expect(entrySheet(page)).toHaveCount(0);
    // Указатель — прочь с места, где встанет тост: его наведение тоже держит время.
    await page.mouse.move(1, 1);
  };

  // Фокус на «Отменить» — время стоит; Enter снимает запись, и фокус — на плитке, не на теле.
  await record("120");
  const written = toast(page, /^Записано: расход 120\s₽/u);
  await expect(written).toBeVisible();
  await expect(tile(page, "Продукты")).toBeFocused();
  await written.getByRole("button", { name: "Отменить" }).focus();
  await page.clock.fastForward(30_000);
  await expect(written).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(toast(page, /^Отменено: расход 120\s₽/u)).toBeVisible();
  await expect(tile(page, "Продукты")).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");

  // Указатель на тосте — время стоит; ушёл — тост досчитывает своё и уходит.
  const undone = toast(page, /^Отменено/u);
  await undone.hover();
  await page.clock.fastForward(30_000);
  await expect(undone).toBeVisible();
  await page.mouse.move(1, 1);
  await page.clock.fastForward(7_000);
  await expect(undone).toHaveCount(0);

  // Лист поверх — время стоит: тост под затемнением, его не прочесть.
  await record("130");
  const again = toast(page, /^Записано: расход 130\s₽/u);
  await expect(again).toBeVisible();
  await tile(page, "Продукты").click();
  await expect(entrySheet(page)).toBeVisible();
  await page.clock.fastForward(30_000);
  await page.keyboard.press("Escape");
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(again).toBeVisible();
  // Без фокуса, указателя и листа — десять секунд, и тоста нет.
  await page.mouse.move(1, 1);
  await page.clock.fastForward(11_000);
  await expect(again).toHaveCount(0);
});

test("тост ждёт и под любым вопросом приложения — «Удалить данные…», «Своя категория», — а после стоит ещё не меньше трёх секунд", async ({ page }) => {
  // Ревью 2b, раунд 3, NEW-4: пауза знала только лист, вопрос об уходе и вопрос о замене черновика,
  // и под диалогом «Удалить весь семейный бюджет с устройства?» тост с «Отменить» уходил за 10 с.
  await page.clock.install();
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const record = async (amount: string) => {
    await tile(page, "Продукты").click();
    await amountField(page).fill(amount);
    await submitButton(page).click();
    await expect(entrySheet(page)).toHaveCount(0);
    await page.mouse.move(1, 1);
  };
  /** Вопрос закрыт: тост стоит ещё три секунды — и потом уходит сам. */
  const expectResumed = async (shown: ReturnType<typeof toast>) => {
    await page.mouse.move(1, 1);
    await page.clock.fastForward(2_900);
    await expect(shown).toBeVisible();
    await page.clock.fastForward(8_000);
    await expect(shown).toHaveCount(0);
  };

  // Вопрос экрана «Данные» — свой диалог, не `ConfirmDialog`.
  await record("120");
  const written = toast(page, /^Записано: расход 120\s₽/u);
  await expect(written).toBeVisible();
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.getByRole("button", { name: /^Удалить данные с этого устройства/u }).click();
  const clear = page.getByRole("alertdialog", { name: "Удалить весь семейный бюджет с устройства?" });
  await expect(clear).toBeVisible();
  await page.mouse.move(1, 1);
  await page.clock.fastForward(11_000);
  await expect(written).toBeVisible();
  await clear.getByRole("button", { name: "Отмена" }).click();
  await expect(clear).toHaveCount(0);
  await expectResumed(written);

  // «Своя категория» над «Обзором» — лист-диалог поверх плиток.
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await record("130");
  const again = toast(page, /^Записано: расход 130\s₽/u);
  await expect(again).toBeVisible();
  await page.locator(".overview-screen").getByRole("button", { name: "Своя категория расходов" }).click();
  const own = page.getByRole("dialog", { name: "Своя категория" });
  await expect(own).toBeVisible();
  await page.mouse.move(1, 1);
  await page.clock.fastForward(11_000);
  await expect(again).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(own).toHaveCount(0);
  await expectResumed(again);
});
