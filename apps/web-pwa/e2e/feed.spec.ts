import { expect, test } from "./fixtures";
import { applyFontScale } from "./font-scale";
import { entrySheet, loadDemo, measureSheetTargets, recordExpense } from "./sheet";
import type { Page } from "@playwright/test";

/**
 * «Операции» (подволна 2d, макет 08) на демо: поиск по сумме в любом виде, фильтр в адресе, правка
 * из строки и возврат к ленте с тем же поиском. Строка поиска — память экрана: её нет ни в адресе,
 * ни в состоянии записи истории; лист правки она переживает, а уход с экрана и перезагрузку — нет.
 */

const hash = (page: Page) => page.evaluate(() => window.location.hash);
const historyState = (page: Page) => page.evaluate(() => JSON.stringify(window.history.state));
const tab = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const search = (page: Page) => page.getByRole("searchbox", { name: "Поиск по операциям" });
const feed = (page: Page) => page.getByRole("region", { name: "Операции" });
const rows = (page: Page) => feed(page).locator(".feed-row");

async function openFeed(page: Page): Promise<void> {
  await tab(page, "Операции").click();
  await expect(page.getByRole("heading", { level: 1, name: "Операции" })).toBeVisible();
}

/** Ничего не выезжает за край, и каждая цель экрана — не меньше 48 pt. */
async function expectContained(page: Page, label: string): Promise<void> {
  const geometry = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    const small = [...main.querySelectorAll<HTMLElement>("button, input, summary")]
      .filter((element) => element.checkVisibility() && element.getBoundingClientRect().width > 0)
      .map((element) => ({ name: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40), rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height < 47.5 || rect.width < 47.5)
      .map(({ name, rect }) => `${name} ${Math.round(rect.width)}×${Math.round(rect.height)}`);
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, small };
  });
  expect(geometry.scrollWidth, `${label}: горизонтальная прокрутка страницы`).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.small, `${label}: цели меньше 48`).toEqual([]);
}

test("поиск «2400»: сумма в любом виде находит запись, и строки поиска нет ни в адресе, ни в истории", async ({ page }) => {
  await loadDemo(page);
  await recordExpense(page, { category: "Продукты", amount: "2400" });
  await openFeed(page);
  const all = await rows(page).count();
  for (const query of ["2400", "2 400", "2400,00"]) {
    await search(page).fill(query);
    await expect(rows(page), query).toHaveCount(1);
    await expect(rows(page).first()).toContainText("Продукты");
    await expect(rows(page).first()).toContainText(/−2\s400\s₽/u);
    expect(await hash(page), query).toBe("#/operations");
    expect(await historyState(page), query).not.toMatch(/2400|2 400|search|query/u);
  }
  await expect(page.getByRole("status").filter({ hasText: /^Найдено 1 из \d+\. Показано 1 из 1$/u })).toBeVisible();
  // «#дача» — по метке: две покупки этого месяца и три из истории демо; очистка возвращает всё.
  await search(page).fill("#дача");
  await expect(rows(page)).toHaveCount(5);
  await page.getByRole("button", { name: "Очистить поиск" }).click();
  await expect(rows(page)).toHaveCount(all);
  // Ничего не нашлось — своими словами и с выходом.
  await search(page).fill("тапочки");
  await expect(page.getByRole("heading", { name: "Ничего не нашлось" })).toBeVisible();
  await page.getByRole("button", { name: "Сбросить фильтры" }).click();
  await expect(search(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(all);
});

test("правка из строки и обратно — поиск на месте; «Назад» с экрана и перезагрузка его забывают", async ({ page }) => {
  await loadDemo(page);
  await recordExpense(page, { category: "Продукты", amount: "2400" });
  await openFeed(page);
  await search(page).fill("2400");
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().getByRole("button").click();
  await expect(entrySheet(page)).toBeVisible();
  expect(await hash(page)).toMatch(/^#\/operations\?sheet=entry&edit=[0-9a-f-]{36}$/u);
  expect(await historyState(page)).not.toContain("2400");
  // «Закрыть» листа — снова лента с тем же поиском и тем же найденным.
  await entrySheet(page).getByRole("button", { name: "Закрыть" }).first().click();
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(search(page)).toHaveValue("2400");
  await expect(rows(page)).toHaveCount(1);
  // Системное «Назад» с листа — то же самое.
  await rows(page).first().getByRole("button").click();
  await expect(entrySheet(page)).toBeVisible();
  await page.goBack();
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(search(page)).toHaveValue("2400");
  expect(await hash(page)).toBe("#/operations");
  // «Назад» с экрана — на «Обзор»; вернулись на вкладку — поиск пуст.
  await page.goBack();
  await expect(page.locator(".reach-card")).toBeVisible();
  await openFeed(page);
  await expect(search(page)).toHaveValue("");
  // Перезагрузка тоже не помнит набранного.
  await search(page).fill("2400");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Операции" })).toBeVisible();
  await expect(search(page)).toHaveValue("");
});

test("фильтр по категории — в адресе: правка поверх и «Назад» возвращают его, перезагрузка тоже", async ({ page }) => {
  await loadDemo(page);
  await openFeed(page);
  await search(page).fill("#дача");
  await feed(page).getByRole("button", { name: "Все категории", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Категория" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Все категории" })).toBeFocused();
  await sheet.getByRole("button", { name: "Продукты", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  // Фокус вернулся на чип, и чип называет выбранное.
  const chip = feed(page).getByRole("button", { name: "Продукты", exact: true });
  await expect(chip).toBeFocused();
  await expect(chip).toHaveAttribute("data-set", "true");
  expect(await hash(page)).toMatch(/^#\/operations\?cat=[0-9a-f-]{36}$/u);
  // Поиск и фильтр вместе: «#дача» в «Продуктах» — одна покупка 18-го (в истории «дача» — не продукты).
  await expect(rows(page)).toHaveCount(1);
  await expect(search(page)).toHaveValue("#дача");
  const filtered = await hash(page);
  await rows(page).first().getByRole("button").click();
  await expect(entrySheet(page)).toBeVisible();
  expect(await hash(page)).toMatch(/^#\/operations\?cat=[0-9a-f-]{36}&sheet=entry&edit=[0-9a-f-]{36}$/u);
  await page.goBack();
  await expect(entrySheet(page)).toHaveCount(0);
  expect(await hash(page)).toBe(filtered);
  await expect(chip).toHaveAttribute("data-set", "true");
  await expect(search(page)).toHaveValue("#дача");
  // Перезагрузка: фильтр — из адреса, строки поиска нет.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Операции" })).toBeVisible();
  expect(await hash(page)).toBe(filtered);
  await expect(search(page)).toHaveValue("");
  // «Продукты» за всё время: шесть покупок этого месяца и по шесть — в каждом из пяти прошлых.
  await expect(rows(page)).toHaveCount(36);
  // Сменить фильтр — тот же экран: запись истории заменяется, «Назад» ведёт на «Обзор».
  await feed(page).getByRole("button", { name: "Весь период", exact: true }).click();
  await page.getByRole("dialog", { name: "Период" }).getByRole("button", { name: /^Этот месяц/u }).click();
  expect(await hash(page)).toMatch(/^#\/operations\?from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}&cat=[0-9a-f-]{36}$/u);
  await page.goBack();
  await expect(page.locator(".reach-card")).toBeVisible();
});

test("на 320 pt и при ×2.7 лента не выезжает за экран, цели — не меньше 48, лист фильтра доматывается", async ({ page }) => {
  await loadDemo(page);
  await openFeed(page);
  for (const [width, height] of [[320, 640], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    for (const scale of [1, 2.7]) {
      await applyFontScale(page, scale);
      await expect(page.getByRole("heading", { level: 1, name: "Операции" })).toBeVisible();
      await expectContained(page, `${width} ×${scale}`);
      await feed(page).getByRole("button", { name: "Все счета", exact: true }).click();
      const sheet = page.locator("section.filter-sheet[role='dialog']");
      await expect(sheet).toBeVisible();
      const targets = await measureSheetTargets(page, 48, "section.filter-sheet[role='dialog']");
      expect(targets.scrollWidth, `${width} ×${scale}: лист`).toBeLessThanOrEqual(targets.clientWidth);
      expect(targets.undersized, `${width} ×${scale}: лист`).toEqual([]);
      expect(targets.unreachable, `${width} ×${scale}: лист`).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
    }
  }
  await applyFontScale(page, 1);
});
