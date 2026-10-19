/**
 * «Назад» — браузерное и системное (план волны 2, §2.1).
 *
 * История ведётся по правилам приложения: «Обзор» — корень, вкладка на вкладку заменяет запись,
 * подэкран кладёт свою, а «Назад» ведёт к родителю. Несохранённый черновик «Назад» не теряет:
 * адрес возвращается на место, и приложение спрашивает своим диалогом — системного окна нет
 * (`fixtures.ts` роняет тест на любом). Android передаёт системную кнопку той же истории
 * (`MainActivity.java`), поэтому здесь проверяется то, на что она опирается.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Загрузить демонстрационный бюджет" }).click();
  await expect(page.locator(".hero-card")).toBeVisible();
}

const tab = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const hash = (page: Page) => page.evaluate(() => location.hash);
const focusedTag = (page: Page) => page.evaluate(() => document.activeElement?.tagName);

async function back(page: Page): Promise<void> {
  await page.goBack();
}

test("«Назад» с подэкрана ведёт к его родителю, с вкладки — на «Обзор»", async ({ page }) => {
  await loadDemo(page);
  expect(await hash(page)).toBe("#/");

  await tab(page, "Ещё").click();
  await page.getByRole("button", { name: /^План на год/u }).click();
  await expect(page.getByRole("heading", { name: /Плана хватает/u })).toBeVisible();
  expect(await hash(page)).toBe("#/more/plan-year");

  await back(page);
  await expect(page.getByRole("button", { name: /^План на год/u })).toBeVisible();
  expect(await hash(page)).toBe("#/more");
  await expect(tab(page, "Ещё")).toHaveAttribute("aria-current", "page");
  // Переход по истории — тоже переход: фокус на заголовке экрана, куда пришли.
  await expect.poll(() => focusedTag(page)).toBe("H1");

  await back(page);
  await expect(page.locator(".hero-card")).toBeVisible();
  expect(await hash(page)).toBe("#/");

  // Вкладка на вкладку заменяет запись: «Назад» с любой вкладки — на «Обзор», а не по кругу вкладок.
  await tab(page, "Операции").click();
  await tab(page, "Отчёты").click();
  await tab(page, "Ещё").click();
  await expect(page.getByRole("button", { name: /^План месяца/u })).toBeVisible();
  await back(page);
  await expect(page.locator(".hero-card")).toBeVisible();
  expect(await hash(page)).toBe("#/");

  // Кнопка «назад» экрана тоже ведёт к родителю и не оставляет в истории дубля.
  await tab(page, "Ещё").click();
  await page.getByRole("button", { name: /Семья и синхронизация/u }).click();
  await page.getByRole("button", { name: /К разделу «Ещё»/u }).click();
  expect(await hash(page)).toBe("#/more");
  await back(page);
  await expect(page.locator(".hero-card")).toBeVisible();
});

test("«+» кладётся поверх вкладки, и «Назад» возвращает на неё", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Операции").click();
  await tab(page, "Записать").click();
  await expect(page.getByLabel("Сумма, ₽")).toBeVisible();
  expect(await hash(page)).toBe("#/new");
  await back(page);
  await expect(page.getByRole("region", { name: "Операции" })).toBeVisible();
  expect(await hash(page)).toBe("#/operations");
});

test("несохранённый черновик «Назад» не теряет: адрес на месте, вопрос — диалогом приложения", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Записать").click();
  const amount = page.getByLabel("Сумма, ₽");
  await amount.fill("1234");

  await back(page);
  const dialog = page.getByRole("alertdialog", { name: "Уйти без сохранения?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Не записано: операция, которую вы набирали.");
  expect(await hash(page)).toBe("#/new");
  // Фокус в диалоге — на безопасном ответе.
  await expect(dialog.getByRole("button", { name: "Продолжить ввод" })).toBeFocused();

  // «Продолжить ввод»: всё как было.
  await dialog.getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(amount).toHaveValue("1234");
  expect(await hash(page)).toBe("#/new");

  // Вкладка с черновиком спрашивает то же самое; Esc — безопасный ответ.
  await tab(page, "Отчёты").click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(amount).toHaveValue("1234");

  // «Не сохранять»: туда, куда шли, и без системного окна на всём пути.
  await back(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Не сохранять" }).click();
  await expect(page.locator(".hero-card")).toBeVisible();
  expect(await hash(page)).toBe("#/");
});

test("адрес, набранный руками поверх черновика, не расходится с экраном: «Не сохранять» → «Обзор» и в адресе, и после перезагрузки", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Записать").click();
  const amount = page.getByLabel("Сумма, ₽");
  await amount.fill("1234");

  // Набранный адрес — переход по якорю внутри открытой страницы, как из адресной строки.
  await page.goto("/#/reports");
  const dialog = page.getByRole("alertdialog", { name: "Уйти без сохранения?" });
  await expect(dialog).toBeVisible();
  expect(await hash(page)).toBe("#/new");
  await dialog.getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(amount).toHaveValue("1234");

  await tab(page, "Обзор").click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Не сохранять" }).click();
  await expect(page.locator(".hero-card")).toBeVisible();
  await expect.poll(() => hash(page)).toBe("#/");

  // Перезагрузка открывает то, что было на экране, а не «+».
  await page.reload();
  await expect(page.locator(".hero-card")).toBeVisible();
  await expect(amount).toHaveCount(0);
  expect(await hash(page)).toBe("#/");
});

test("ссылка на подэкран достраивает историю родителями, мусор в адресе — «Запись не найдена»", async ({ page }) => {
  await loadDemo(page);
  // Открытие по ссылке — новая загрузка страницы, а не переход по якорю внутри открытой.
  await page.goto("about:blank");
  await page.goto("/#/more/plan-month");
  await expect(page.getByRole("heading", { name: "Плановые расходы" })).toBeVisible();
  await back(page);
  expect(await hash(page)).toBe("#/more");
  await back(page);
  await expect(page.locator(".hero-card")).toBeVisible();

  await page.goto("/#/bogus/route");
  await expect(page.locator(".message-toast")).toContainText("Запись не найдена");
  await expect(page.locator(".hero-card")).toBeVisible();
  expect(await hash(page)).toBe("#/");

  // Перезагрузка оставляет на том же месте: адрес — это маршрут.
  await tab(page, "Отчёты").click();
  await expect(page.getByRole("heading", { name: "Отчёты" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Отчёты" })).toBeVisible();
  await back(page);
  await expect(page.locator(".hero-card")).toBeVisible();
});
