/**
 * Мягкие переносы — только для глаза (ревью 2b, раунд 3, NEW-3).
 *
 * Имена плиток набраны с U+00AD, чтобы слово переносилось с дефисом. Из приложения они не уходят:
 * копирование снимает их с выделенного, а поля имён и комментария снимают их со вставленного —
 * мягкими переносами полны и чужие страницы. Правило домена о скрытых символах при этом то же:
 * поле просто не передаёт ему U+00AD.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { amountField, entrySheet, loadDemo, submitButton, tile, toast } from "./sheet";

const SOFT = "\u00ad";

/** Выделить содержимое элемента так, как его выделила бы мышь, и нажать Ctrl+C. */
async function copySelection(page: Page, selector: string, text?: string): Promise<string> {
  await page.evaluate(({ selector, text }) => {
    const element = [...document.querySelectorAll(selector)].find((item) => text === undefined || item.textContent?.replaceAll("\u00ad", "") === text);
    if (element === undefined) throw new Error(`nothing to select: ${selector} ${text ?? ""}`);
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, { selector, text });
  await page.keyboard.press("Control+C");
  return page.evaluate(() => navigator.clipboard.readText());
}

test("скопированное из приложения — без мягких переносов: и имя плитки, и весь «Обзор»", async ({ page, context }) => {
  // Было: «Транспорт» с плитки копировался как «Тра\u00adн\u00adс\u00adпорт», а в копии всего «Обзора»
  // поиск не находил «Продукты».
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // Имена на плитках и правда несут мягкие переносы — иначе проверять нечего.
  expect(await page.locator(".overview-screen .tile-name").first().textContent()).toContain(SOFT);

  const name = await copySelection(page, ".overview-screen .tile-name", "Транспорт");
  expect(name).toBe("Транспорт");

  const overview = await copySelection(page, ".overview-screen");
  expect(overview).not.toContain(SOFT);
  expect(overview).toContain("Продукты");
  expect(overview).toContain("Транспорт");
  // Выделение остаётся выделением: текст по-прежнему можно выделить и скопировать.
  expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(100);
});

test("вставленное с мягкими переносами в «Комментарий» записывается — и хранится без них", async ({ page, context }) => {
  // Было: вставка «Тра\u00adн\u00adс\u00adпорт» в комментарий — и «Записать» отказывал: «Уберите из
  // комментария скрытые или служебные символы.»
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await tile(page, "Продукты").click();
  await amountField(page).fill("777");
  const note = entrySheet(page).getByRole("textbox", { name: "Комментарий" });
  await note.fill("Чек: ");
  await page.evaluate((text) => navigator.clipboard.writeText(text), `Тра${SOFT}н${SOFT}с${SOFT}порт и до${SOFT}став${SOFT}ка`);
  await note.press("End");
  await page.keyboard.press("Control+V");
  await expect(note).toHaveValue("Чек: Транспорт и доставка");
  // Каретка — за вставленным, а не в начале или где-то посередине.
  expect(await note.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe("Чек: Транспорт и доставка".length);
  await submitButton(page).click();
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(toast(page, /^Записано: расход 777\s₽/u)).toBeVisible();

  // Что записано — видно в правке: поле комментария берёт значение из сохранённой операции.
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  await page.locator('button[aria-label^="Изменить операцию «Расход 777"]').first().click();
  await expect(entrySheet(page)).toBeVisible();
  const stored = await entrySheet(page).getByRole("textbox", { name: "Комментарий" }).inputValue();
  expect(stored).toBe("Чек: Транспорт и доставка");
  expect(stored).not.toContain(SOFT);
});

test("имя новой метки тоже снимает мягкие переносы со вставленного", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await loadDemo(page);
  await tile(page, "Продукты").click();
  await entrySheet(page).getByRole("button", { name: "+ метка" }).click();
  const field = entrySheet(page).getByRole("textbox", { name: "Новая метка" });
  await field.focus();
  await page.evaluate((text) => navigator.clipboard.writeText(text), `Да${SOFT}ча`);
  await page.keyboard.press("Control+V");
  await expect(field).toHaveValue("Дача");
});
