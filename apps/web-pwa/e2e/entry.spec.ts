/**
 * Лист ввода суммы (план волны 2, §1.2) в настоящем браузере.
 *
 * Прежний экран «Записать» с табло конвертов (`keypad.spec.ts`) ушёл в 2b; его проверки живут
 * здесь, на листе поверх «Обзора»: число касаний от плитки до записанной покупки — измеренное, а не
 * объявленное; арифметика; физическая клавиатура, каретка и буфер рядом с клавишами; сумма, которая
 * не уходит из виду при наборе; клавиатура, которая уступает системной при крупном шрифте и в
 * альбоме; правка, удаление и «Отменить» из тоста.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { applyFontScale } from "./font-scale";
import {
  amountField,
  entrySheet,
  keypadKey,
  leaveDialog,
  loadDemo,
  submitButton,
  tile,
  toast,
  typeOnKeypad,
} from "./sheet";

interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

const PHONE_VIEWPORTS: readonly Viewport[] = [
  { name: "phone-320", width: 320, height: 568 },
  { name: "phone-375", width: 375, height: 667 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "phone-430", width: 430, height: 932 },
];

/** Закрыть лист с набранным: вопрос приложения и «Не сохранять». */
async function discardSheet(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const dialog = leaveDialog(page);
  if (await dialog.count()) await dialog.getByRole("button", { name: "Не сохранять" }).click();
  await expect(entrySheet(page)).toHaveCount(0);
}

test("наименьшее число касаний от плитки до записанной покупки — шесть, и ни одного по системной клавиатуре", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  let taps = 0;
  const tap = async (target: Locator) => {
    await target.click();
    taps += 1;
  };
  // 1 — плитка категории (счёт — основной, вид — расход, дата — сегодня); 2–5 — цифры; 6 — запись.
  await tap(tile(page, "Продукты"));
  await expect(entrySheet(page)).toBeVisible();
  await expect(amountField(page)).toBeFocused();
  await expect(amountField(page)).toHaveAttribute("inputmode", "none");
  for (const digit of ["1", "2", "0", "0"]) await tap(keypadKey(page, digit));
  await expect(submitButton(page)).toHaveText(/^Записать 1\s200\s₽$/u);
  await tap(submitButton(page));
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(toast(page, /Записано: расход 1\s200\s₽/u)).toBeVisible();
  expect(taps, "касаний от плитки до записанной покупки").toBe(6);
  test.info().annotations.push({ type: "taps tile → recorded purchase", description: String(taps) });
  // Фокус вернулся на плитку, которая открыла лист.
  await expect(tile(page, "Продукты")).toBeFocused();

  // «Отменить» в тосте снимает покупку тем же путём записи и говорит об этом.
  const before = await tile(page, "Продукты").getAttribute("aria-label");
  await toast(page, /Записано/u).getByRole("button", { name: "Отменить" }).click();
  await expect(toast(page, /Отменено: расход 1\s200\s₽/u)).toBeVisible();
  await expect(tile(page, "Продукты")).not.toHaveAttribute("aria-label", before ?? "");
});

test("арифметика: два чека складываются, итог назван до записи, а записывается число", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await tile(page, "Продукты").click();
  const amount = amountField(page);

  await typeOnKeypad(page, ["1", "2", "0", "0", "Плюс", "3", "5", "0"]);
  await expect(amount).toHaveValue("1200+350");
  await expect(page.locator(".amount-total")).toHaveText(/=\s*1\s*550\s*₽/u);
  // Читающему с экрана итог нажатий произносится отдельно: поле не обязано быть в фокусе.
  await expect(page.locator(".sheet-foot [role='status']")).toHaveText(/1200\+350, итого 1\s550\s₽/u);
  await expect(page.locator(".entry-effect")).toContainText("В категории «Продукты»");
  await submitButton(page).click();
  await expect(toast(page, /Записано: расход 1\s550\s₽/u)).toBeVisible();

  // Счёт пополам — и знак после знака заменяет его, а не встаёт вторым.
  await tile(page, "Продукты").click();
  await typeOnKeypad(page, ["3", "0", "0", "0", "Плюс", "Разделить", "2"]);
  await expect(amount).toHaveValue("3000÷2");
  await expect(page.locator(".amount-total")).toHaveText(/=\s*1\s*500\s*₽/u);
  await discardSheet(page);
});

test("физическая клавиатура, каретка и буфер работают вместе с клавишами", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await tile(page, "Продукты").click();
  const amount = amountField(page);

  // Физическая клавиатура набирает как обычно — цифры и знаки, включая дефис и косую черту.
  await expect(amount).toBeFocused();
  await page.keyboard.type("1500-300");
  await expect(amount).toHaveValue("1500-300");
  await expect(page.locator(".amount-total")).toHaveText(/=\s*1\s*200\s*₽/u);
  // Клавиша не уводит фокус из поля и правит по каретке: цифра встаёт туда, где каретка.
  await page.evaluate(() => {
    const input = document.getElementById("entry-amount") as HTMLInputElement;
    input.setSelectionRange(1, 1);
  });
  await keypadKey(page, "9").click();
  await expect(amount).toHaveValue("19500-300");
  await expect(amount).toBeFocused();
  expect(await amount.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(2);
  // Стирание — тоже по каретке: уходит «9», а не последний символ, и каретка остаётся на месте.
  await keypadKey(page, "Стереть").click();
  await expect(amount).toHaveValue("1500-300");
  expect(await amount.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(1);
  // Каретка в конец касанием правого края поля: клавиша End на macOS каретку не двигает.
  const box = await amount.boundingBox();
  if (!box) throw new Error("Поле суммы без размеров.");
  await amount.click({ position: { x: box.width - 12, y: box.height / 2 } });
  await page.keyboard.type("/2");
  await expect(amount).toHaveValue("1500-300/2");
  await expect(page.locator(".amount-total")).toHaveText(/=\s*600\s*₽/u);

  // Вставка из буфера: «1 234,56» из банковской СМС — с пробелом и запятой.
  await page.evaluate(() => navigator.clipboard.writeText("1 234,56"));
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+V");
  await expect(amount).toHaveValue("1 234,56");
  await expect(submitButton(page)).toHaveText(/^Записать 1\s234,56\s₽$/u);
  await discardSheet(page);
});

test("сумма и кнопка записи не уходят из виду, пока сумму набирают с клавиш", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  for (const viewport of PHONE_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await tile(page, "Продукты").click();
    await expect(page.getByRole("group", { name: "Клавиатура суммы" })).toBeVisible();
    await typeOnKeypad(page, ["1", "2", "0", "0"]);
    await expect(amountField(page)).toHaveValue("1200");
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect() ?? null;
      const amount = rect("#entry-amount");
      const keypad = rect(".keypad");
      const submit = rect(".entry-submit");
      const body = rect(".sheet-body");
      if (!amount || !keypad || !submit || !body) throw new Error("Лист без поля, клавиатуры или кнопки.");
      return {
        amountWhole: amount.top >= body.top - 0.5 && amount.bottom <= body.bottom + 0.5 && amount.bottom <= keypad.top + 0.5,
        submitWhole: submit.top >= 0 && submit.bottom <= innerHeight + 0.5,
        keypadWhole: keypad.top >= 0 && keypad.bottom <= innerHeight + 0.5,
        heights: { amount: Math.round(amount.height), keypad: Math.round(keypad.height), body: Math.round(body.height) },
      };
    });
    expect(geometry.amountWhole, `${viewport.name}: сумма целиком над клавишами (${JSON.stringify(geometry.heights)})`).toBe(true);
    expect(geometry.keypadWhole, `${viewport.name}: клавиши целиком на экране`).toBe(true);
    expect(geometry.submitWhole, `${viewport.name}: кнопка записи целиком на экране`).toBe(true);
    test.info().annotations.push({ type: `sheet ${viewport.name}`, description: JSON.stringify(geometry.heights) });
    await discardSheet(page);
  }
});

test("при крупном шрифте и на коротком экране клавиатуры нет, и поле зовёт системную", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  const keypad = page.getByRole("group", { name: "Клавиатура суммы" });

  // ×2.7: четыре ряда клавиш и кнопка записи выше любого телефона — клавиатуры нет, и системная
  // хотя бы уходит по «Готово»; условие одно на клавиши и `inputmode`.
  await applyFontScale(page, 2.7);
  for (const viewport of [PHONE_VIEWPORTS[0]!, PHONE_VIEWPORTS[2]!]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await tile(page, "Продукты").click();
    await expect(keypad, `${viewport.name} ×2.7`).toHaveCount(0);
    await expect(amountField(page)).toHaveAttribute("inputmode", "decimal");
    await amountField(page).fill("1234");
    await expect(amountField(page)).toHaveValue("1234");
    await expect(submitButton(page)).toHaveText(/^Записать 1\s234\s₽$/u);
    await discardSheet(page);
  }
  // Обратно к обычному кеглю — клавиши возвращаются без перезагрузки, с открытым листом.
  await tile(page, "Продукты").click();
  await applyFontScale(page, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(keypad).toBeVisible();
  await expect(amountField(page)).toHaveAttribute("inputmode", "none");
  // Телефон в альбоме: экран короче клавиатуры с кнопкой.
  await page.setViewportSize({ width: 667, height: 375 });
  await expect(keypad).toHaveCount(0);
  await expect(amountField(page)).toHaveAttribute("inputmode", "decimal");
  await discardSheet(page);
});

test("правка из «Операций»: «Сохранить», а «Удалить» спрашивает и даёт «Отменить»", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  const row = page.locator('button[aria-label^="Изменить операцию «Расход"]').first();
  await row.click();
  const sheet = entrySheet(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAccessibleName(/^Изменить: расход: /u);
  await expect(amountField(page)).not.toHaveValue("");
  await amountField(page).fill("777");
  await expect(submitButton(page)).toHaveText("Сохранить");
  await submitButton(page).click();
  await expect(sheet).toHaveCount(0);
  await expect(toast(page, /Изменено: расход 777\s₽/u)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Изменить операцию «Расход 777\s₽/u }).first()).toBeVisible();

  // Удалить — вопросом приложения; «Отменить» в тосте возвращает операцию.
  await page.getByRole("button", { name: /^Изменить операцию «Расход 777\s₽/u }).first().click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Удалить", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Удалить операцию?" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Не удалять" })).toBeFocused();
  await confirm.getByRole("button", { name: "Удалить" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(toast(page, /Удалено: расход 777\s₽/u)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Изменить операцию «Расход 777\s₽/u })).toHaveCount(0);
  await toast(page, /Удалено/u).getByRole("button", { name: "Отменить" }).click();
  await expect(toast(page, /Отменено: расход 777\s₽/u)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Изменить операцию «Расход 777\s₽/u }).first()).toBeVisible();
});

test("лист держит фокус: Tab ходит внутри, Esc с набранным спрашивает, без набранного — закрывает", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await tile(page, "Продукты").click();
  const sheet = entrySheet(page);
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press("Tab");
    expect(await sheet.evaluate((element) => element.contains(document.activeElement)), `Tab №${step + 1} остался в листе`).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  // Набранное — Esc спрашивает; «Продолжить ввод» оставляет всё как было.
  await amountField(page).fill("450");
  await page.keyboard.press("Escape");
  await expect(leaveDialog(page)).toBeVisible();
  await leaveDialog(page).getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(amountField(page)).toHaveValue("450");
  // Стёртое — снова не черновик: Esc закрывает без вопроса, фокус — на плитке.
  await amountField(page).fill("");
  await amountField(page).focus();
  await page.keyboard.press("Escape");
  await expect(leaveDialog(page)).toHaveCount(0);
  await expect(sheet).toHaveCount(0);
  await expect(tile(page, "Продукты")).toBeFocused();
});
