import { expect, test } from "./fixtures";
import { applyFontScale } from "./font-scale";
import { loadDemo } from "./sheet";
import type { Page } from "@playwright/test";

/**
 * «Отчёты» (подволна 2d, макет 09) на демо: вывод заголовком, кольцо с легендой и таблицей, «По
 * месяцам», вкладки и период в адресе; строка легенды — «Операции» с фильтром поверх «Отчётов», и
 * «Назад» возвращает «Отчёты» с тем же периодом. Итог месяца — тот же, что «Расходы» на «Обзоре».
 */

const hash = (page: Page) => page.evaluate(() => window.location.hash);
const tab = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const heading = (page: Page) => page.getByRole("heading", { level: 1, name: "Отчёты" });

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

test("«Расходы» с «Обзора» — в «Отчёты» с тем же числом: вывод, кольцо — картинка с долями, таблица и столбцы", async ({ page }) => {
  await loadDemo(page);
  await page.locator(".totals-strip").getByRole("button", { name: /^Расходы/u }).click();
  await expect(heading(page)).toBeFocused();
  expect(await hash(page)).toBe("#/reports");
  await expect(page.getByRole("heading", { level: 2, name: "Больше всего ушло на категорию «Жильё»" })).toBeVisible();
  await expect(page.locator(".report-compare")).toContainText(/^71\s000\s₽ за [а-я]+/u);
  await expect(page.getByRole("img", { name: /^Расходы за [а-я]+, 71\s000\s₽: Жильё 63\s%, Продукты 31\s%, Транспорт 6\s%$/u })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Расходы по месяцам: .+ 71\s000\s₽$/u })).toBeVisible();
  // «Все категории и таблица» — настоящая таблица с подписью и итогом.
  await page.getByText("Все категории и таблица").click();
  const table = page.getByRole("table", { name: /^Расходы за [а-я]+ по категориям, за вычетом возвратов$/u });
  await expect(table).toBeVisible();
  await expect(table.getByRole("rowheader", { name: "Жильё" })).toBeVisible();
  await expect(table.getByRole("row", { name: /^Всего 71\s000\s₽/u })).toBeVisible();
  await page.getByText("Показать таблицей").click();
  await expect(page.getByRole("table", { name: "Расходы по месяцам" })).toBeVisible();
});

test("строка легенды — «Операции» с категорией и периодом; «Назад» — «Отчёты» с тем же кварталом", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Отчёты").click();
  await expect(heading(page)).toBeVisible();
  await page.getByRole("group", { name: "Период и счёт" }).getByRole("button", { name: "Квартал", exact: true }).click();
  expect(await hash(page)).toBe("#/reports?period=quarter");
  await expect(page.getByRole("group", { name: "Период и счёт" }).getByRole("button", { name: /квартал$/u })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Продукты: 22\s000\s₽, 31\s%\. Показать операции$/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Операции" })).toBeFocused();
  expect(await hash(page)).toMatch(/^#\/operations\?from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}&cat=[0-9a-f-]{36}$/u);
  const feed = page.getByRole("region", { name: "Операции" });
  await expect(feed.getByRole("button", { name: "Продукты", exact: true })).toHaveAttribute("data-set", "true");
  await expect(feed.locator(".feed-row")).toHaveCount(6);
  await expect(feed.locator(".feed-sum")).toContainText(/Расходы 22\s000\s₽/u);
  await page.goBack();
  await expect(heading(page)).toBeVisible();
  expect(await hash(page)).toBe("#/reports?period=quarter");
  // Вкладки — тот же экран: «Доходы» и «Метки» заменяют запись, «Назад» — на «Обзор».
  await page.getByRole("group", { name: "Что показать" }).getByRole("button", { name: "Доходы" }).click();
  expect(await hash(page)).toBe("#/reports?view=income&period=quarter");
  await expect(page.getByRole("heading", { level: 2, name: "Больше всего пришло из источника «Зарплата»" })).toBeVisible();
  await page.getByRole("group", { name: "Что показать" }).getByRole("button", { name: "Метки" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Больше всего потрачено с меткой «дача»" })).toBeVisible();
  await page.getByRole("button", { name: /^#дача: 5\s900\s₽/u }).click();
  await expect(page.getByRole("region", { name: "Операции" }).locator(".feed-row")).toHaveCount(2);
  expect(await hash(page)).toMatch(/&tag=[0-9a-f-]{36}$/u);
  await page.goBack();
  expect(await hash(page)).toBe("#/reports?view=tags&period=quarter");
  await page.goBack();
  await expect(page.locator(".reach-card")).toBeVisible();
});

test("свой период и пустой месяц: «В … расходов нет» с дорогой к записи", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Отчёты").click();
  await page.getByRole("button", { name: "Свой период" }).click();
  const sheet = page.getByRole("dialog", { name: "Период" });
  await sheet.getByRole("button", { name: /^Прошлый месяц/u }).click();
  expect(await hash(page)).toMatch(/^#\/reports\?period=month&from=\d{4}-\d{2}-01$/u);
  await expect(page.getByRole("heading", { level: 2, name: /^В [а-я]+ расходов нет$/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Записать расход" })).toBeVisible();
  // Дни своего периода — проверка у поля: последний раньше первого — словами.
  await page.getByRole("button", { name: "Свой период" }).click();
  await sheet.getByLabel("С", { exact: true }).fill("2026-10-20");
  await sheet.getByLabel("По", { exact: true }).fill("2026-10-10");
  await sheet.getByRole("button", { name: "Показать" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Последний день раньше первого — поменяйте их местами.");
  await sheet.getByLabel("По", { exact: true }).fill("2026-10-31");
  await sheet.getByRole("button", { name: "Показать" }).click();
  expect(await hash(page)).toBe("#/reports?period=custom&from=2026-10-20&to=2026-10-31");
});

test("на 320 pt и при ×2.7 «Отчёты» не выезжают за экран, цели — не меньше 48", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Отчёты").click();
  for (const [width, height] of [[320, 640], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    for (const scale of [1, 2.7]) {
      await applyFontScale(page, scale);
      await expect(heading(page)).toBeVisible();
      await expectContained(page, `${width} ×${scale} расходы`);
      await page.getByText("Все категории и таблица").click();
      await expectContained(page, `${width} ×${scale} таблица`);
      await page.getByText("Все категории и таблица").click();
      await page.getByRole("group", { name: "Что показать" }).getByRole("button", { name: "Метки" }).click();
      await expectContained(page, `${width} ×${scale} метки`);
      await page.getByRole("group", { name: "Что показать" }).getByRole("button", { name: "Расходы" }).click();
    }
  }
  await applyFontScale(page, 1);
});
