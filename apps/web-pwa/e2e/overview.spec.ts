/**
 * «Обзор» (план волны 2, §1.1) в настоящем браузере: плитки и что из их касаний выходит.
 *
 * Автомат касаний проверен целиком в `pick-model.test.ts`; здесь — что настоящие плитки доводят
 * его до настоящего листа: четыре последовательности касаний, перетаскивание мышью (только там,
 * где указатель точный), путь одной клавиатурой, месяц в адресе и раскладка, которая не выезжает
 * за экран ни на 320 pt, ни при ×2.7.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { designTouchTargetMinimum } from "../src/design-contract";
import { applyFontScale } from "./font-scale";
import { amountField, entrySheet, loadDemo, measureSheetTargets, tile, toast } from "./sheet";

const TOUCH_TARGET_MINIMUM = designTouchTargetMinimum();
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const hash = (page: Page) => page.evaluate(() => location.hash);
const hint = (page: Page) => page.locator(".pick-hint[role='status']");

/** Лист открылся с этими «откуда → куда» — и закрывается без вопроса: набранного нет. */
async function expectSheet(page: Page, name: RegExp): Promise<void> {
  await expect(entrySheet(page)).toBeVisible();
  await expect(entrySheet(page)).toHaveAccessibleName(name);
  await page.keyboard.press("Escape");
  await expect(entrySheet(page)).toHaveCount(0);
}

test("четыре последовательности касаний — четыре листа, и адрес называет только вид и плитки", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(hint(page)).toHaveText(/^Коснитесь категории/u);

  // 1. Категория — расход с основного счёта.
  await tile(page, "Продукты").click();
  expect(await hash(page)).toMatch(new RegExp(`^#/\\?sheet=entry&op=expense&src=${UUID}&dst=${UUID}$`, "u"));
  await expectSheet(page, /^Расход: Основной → Продукты$/u);

  // 2. Счёт, затем категория — расход с этого счёта.
  await tile(page, "Резерв платежей").click();
  await expect(tile(page, "Резерв платежей")).toHaveAttribute("aria-pressed", "true");
  await expect(hint(page)).toHaveText(/^Выбран счёт «Резерв платежей»/u);
  await tile(page, "Продукты").click();
  await expectSheet(page, /^Расход: Резерв платежей → Продукты$/u);
  await expect(tile(page, "Резерв платежей")).toHaveAttribute("aria-pressed", "false");

  // 3. Источник дохода, затем счёт — доход на этот счёт.
  await tile(page, "Зарплата").click();
  await expect(tile(page, "Зарплата")).toHaveAttribute("aria-pressed", "true");
  await expect(hint(page)).toHaveText(/^Выбран доход «Зарплата»/u);
  await tile(page, "Основной").click();
  expect(await hash(page)).toMatch(new RegExp(`^#/\\?sheet=entry&op=income&src=${UUID}&dst=${UUID}$`, "u"));
  await expectSheet(page, /^Доход: Зарплата → Основной$/u);

  // 4. Счёт, затем другой счёт — перевод.
  await tile(page, "Основной").click();
  await tile(page, "Резерв платежей").click();
  expect(await hash(page)).toMatch(new RegExp(`^#/\\?sheet=entry&op=transfer&src=${UUID}&dst=${UUID}$`, "u"));
  await expectSheet(page, /^Перевод: Основной → Резерв платежей$/u);

  // Тот же счёт ещё раз — снять выбор; Esc — тоже.
  await tile(page, "Основной").click();
  await tile(page, "Основной").click();
  await expect(tile(page, "Основной")).toHaveAttribute("aria-pressed", "false");
  await expect(hint(page)).toHaveText(/^Коснитесь категории/u);
  await tile(page, "Основной").click();
  await page.keyboard.press("Escape");
  await expect(tile(page, "Основной")).toHaveAttribute("aria-pressed", "false");
  expect(await hash(page)).toBe("#/");
});

/**
 * Перетащить плитку мышью: нажать, сдвинуть за порог перетаскивания и вести шагами до цели —
 * как рука, а не прыжком: Chromium начинает перетаскивание только после движения с зажатой кнопкой.
 */
async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  await to.scrollIntoViewIfNeeded();
  await from.scrollIntoViewIfNeeded();
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("Плитка без размеров.");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("перетаскивание мышью — те же переходы, что и касания", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 1024, height: 1400 });
  // Указатель в прогоне точный (Desktop Chrome): плитки, которые можно взять, перетаскиваются.
  expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
  await expect(tile(page, "Резерв платежей")).toHaveAttribute("draggable", "true");

  await drag(page, tile(page, "Резерв платежей"), tile(page, "Продукты"));
  await expectSheet(page, /^Расход: Резерв платежей → Продукты$/u);
  await drag(page, tile(page, "Зарплата"), tile(page, "Основной"));
  await expectSheet(page, /^Доход: Зарплата → Основной$/u);
  await drag(page, tile(page, "Основной"), tile(page, "Резерв платежей"));
  await expectSheet(page, /^Перевод: Основной → Резерв платежей$/u);
  // Категорию не берут: она — только цель.
  await expect(tile(page, "Продукты")).not.toHaveAttribute("draggable", "true");
});

/** Табом до элемента, чьё доступное имя начинается с `prefix`; не дальше сотни шагов. */
async function tabTo(page: Page, prefix: string, backwards = false): Promise<void> {
  for (let step = 0; step < 100; step += 1) {
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
    const name = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
    if (name.startsWith(prefix)) return;
  }
  throw new Error(`«${prefix}» не достижим табом.`);
}

test("одной клавиатурой: плитка, сумма, запись — и выбор счёта пробелом", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#main-content").focus();

  await tabTo(page, "Продукты: ");
  await page.keyboard.press("Enter");
  await expect(entrySheet(page)).toBeVisible();
  await expect(amountField(page)).toBeFocused();
  await page.keyboard.type("1200");
  await page.keyboard.press("Enter");
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(toast(page, /Записано: расход 1\s200\s₽/u)).toBeVisible();
  await expect(tile(page, "Продукты")).toBeFocused();

  await tabTo(page, "Резерв платежей: ", true);
  await page.keyboard.press("Space");
  await expect(tile(page, "Резерв платежей")).toHaveAttribute("aria-pressed", "true");
  await tabTo(page, "Продукты: ");
  await page.keyboard.press("Enter");
  await expectSheet(page, /^Расход: Резерв платежей → Продукты$/u);
});

test("месяц — в адресе: стрелка листает плитки, фокус остаётся на стрелке, «Назад» — к текущему", async ({ page }) => {
  await loadDemo(page);
  const heading = page.getByRole("heading", { level: 1 });
  const current = (await heading.innerText()).trim();
  const previous = page.getByRole("button", { name: /^Предыдущий месяц: /u });
  await previous.click();
  await expect(heading).not.toHaveText(current);
  expect(await hash(page)).toMatch(/^#\/\?month=\d{4}-(?:0[1-9]|1[0-2])$/u);
  await expect(page.getByRole("button", { name: /^Предыдущий месяц: /u })).toBeFocused();
  // Месяц на месяц — не стопка записей истории: «Назад» сразу к текущему месяцу.
  await page.getByRole("button", { name: /^Предыдущий месяц: /u }).click();
  await page.goBack();
  await expect(heading).toHaveText(current);
  expect(await hash(page)).toBe("#/");
});

test("на 320 pt и при ×2.7 ничего не выезжает за экран — ни «Обзор», ни лист поверх него", async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page);
  for (const [width, height, scale] of [[320, 568, 1], [390, 844, 1], [320, 568, 2.7], [390, 844, 2.7]] as const) {
    const label = `${width}×${height} ×${scale}`;
    await applyFontScale(page, scale);
    await page.setViewportSize({ width, height });
    const overview = await page.evaluate((minimum) => {
      const tiles = [...document.querySelectorAll<HTMLElement>(".overview-screen .tile, .overview-screen .add-tile, .month-switch > button, .reach-line > button")];
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        undersized: tiles.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width < minimum - 0.1 || rect.height < minimum - 0.1).length,
        tiles: tiles.length,
      };
    }, TOUCH_TARGET_MINIMUM);
    expect(overview.scrollWidth, `${label}: «Обзор» без горизонтальной прокрутки`).toBeLessThanOrEqual(overview.clientWidth);
    expect(overview.tiles, `${label}: плитки на месте`).toBeGreaterThan(10);
    expect(overview.undersized, `${label}: плитки не меньше ${TOUCH_TARGET_MINIMUM}`).toBe(0);

    await tile(page, "Продукты").click();
    await expect(entrySheet(page)).toBeVisible();
    const sheet = await measureSheetTargets(page, TOUCH_TARGET_MINIMUM);
    expect(sheet.scrollWidth, `${label}: лист без горизонтальной прокрутки`).toBeLessThanOrEqual(sheet.clientWidth);
    expect(sheet.targets, `${label}: цели листа найдены`).toBeGreaterThan(5);
    expect(sheet.undersized, `${label}: цели листа не меньше ${TOUCH_TARGET_MINIMUM}`).toEqual([]);
    expect(sheet.unreachable, `${label}: каждую цель листа можно домотать и ничто её не накрывает`).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(entrySheet(page)).toHaveCount(0);
  }
  await applyFontScale(page, 1);
});
