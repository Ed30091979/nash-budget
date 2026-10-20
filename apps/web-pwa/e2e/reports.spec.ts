import { expect, test } from "./fixtures";
import { applyFontScale } from "./font-scale";
import { LINE_BREAK_LAYOUTS, nameSplits, softHyphenedNames } from "./line-breaks";
import { restoreBudget } from "./budgets";
import { G003_CATEGORIES, G003_EXPENSES_MINOR, G003_INCOME_MINOR, G003_LEDGER, G003_MONTH_FROM, G003_TAGS } from "./canonical-ledger";
import { loadDemo } from "./sheet";
import { formatMoney } from "../src/money";
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
  // История демо: прошлый месяц — 79 400 ₽, «По месяцам» — 76 · 82 · 74 · 89 · 79 · 71 тыс.
  await expect(page.locator(".report-compare")).toContainText(/^71\s000\s₽ за [а-я]+ — на 8\s400\s₽ меньше, чем в [а-я]+$/u);
  await expect(page.locator(".month-bar-value")).toHaveText([/^76\sтыс\.$/u, /^82\sтыс\.$/u, /^74\sтыс\.$/u, /^89\sтыс\.$/u, /^79\sтыс\.$/u, /^71\sтыс\.$/u]);
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

test("строка легенды — «Операции» с категорией и периодом; «Назад» — «Отчёты» с тем же периодом", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Отчёты").click();
  await expect(heading(page)).toBeVisible();
  // Год: опора — сегодня, адрес её не пишет; строка легенды — поверх «Отчётов» за год.
  await page.getByRole("group", { name: "Период и счёт" }).getByRole("button", { name: "Год", exact: true }).click();
  expect(await hash(page)).toBe("#/reports?period=year");
  await page.getByRole("button", { name: /^Жильё: .+\. Показать операции$/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Операции" })).toBeFocused();
  expect(await hash(page)).toMatch(/^#\/operations\?from=\d{4}-01-01&to=\d{4}-12-31&cat=[0-9a-f-]{36}$/u);
  // Лента поверх «Отчётов» — со строкой «‹ Отчёты»: она возвращает к той же их записи истории,
  // а не кладёт новую (LOW-6); фокус — на заголовке «Отчётов».
  const length = await page.evaluate(() => window.history.length);
  await page.getByRole("button", { name: "Назад: Отчёты" }).click();
  await expect(heading(page)).toBeFocused();
  expect(await hash(page)).toBe("#/reports?period=year");
  expect(await page.evaluate(() => window.history.length)).toBe(length);
  // Снова в ленту — и системное «Назад» ведёт туда же.
  await page.getByRole("button", { name: /^Жильё: .+\. Показать операции$/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Операции" })).toBeFocused();
  await page.goBack();
  expect(await hash(page)).toBe("#/reports?period=year");
  // Месяц — без ключей, как у вкладки; его легенда — числа октября макета.
  await page.getByRole("group", { name: "Период и счёт" }).getByRole("button", { name: /^[А-Я][а-я]+$/u }).first().click();
  expect(await hash(page)).toBe("#/reports");
  await page.getByRole("button", { name: /^Продукты: 22\s000\s₽, 31\s%\. Показать операции$/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Операции" })).toBeFocused();
  expect(await hash(page)).toMatch(/^#\/operations\?from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}&cat=[0-9a-f-]{36}$/u);
  const feed = page.getByRole("region", { name: "Операции" });
  await expect(feed.getByRole("button", { name: "Категория: Продукты", exact: true })).toHaveAttribute("data-set", "true");
  await expect(feed.locator(".feed-row")).toHaveCount(6);
  await expect(feed.locator(".feed-sum")).toContainText(/Расходы 22\s000\s₽/u);
  await page.goBack();
  await expect(heading(page)).toBeVisible();
  expect(await hash(page)).toBe("#/reports");
  // Квартал и вкладки — тот же экран: «Доходы» и «Метки» заменяют запись, «Назад» — на «Обзор».
  await page.getByRole("group", { name: "Период и счёт" }).getByRole("button", { name: "Квартал", exact: true }).click();
  expect(await hash(page)).toBe("#/reports?period=quarter");
  await expect(page.getByRole("group", { name: "Период и счёт" }).getByRole("button", { name: /квартал$/u })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "Что показать" }).getByRole("button", { name: "Доходы" }).click();
  expect(await hash(page)).toBe("#/reports?view=income&period=quarter");
  await expect(page.getByRole("heading", { level: 2, name: "Больше всего пришло из источника «Зарплата»" })).toBeVisible();
  await page.getByRole("group", { name: "Что показать" }).getByRole("button", { name: "Метки" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /^Больше всего потрачено с меткой «.+»$/u })).toBeVisible();
  await page.getByRole("button", { name: /^#дача: / }).click();
  await expect(page.getByRole("region", { name: "Операции" }).getByRole("button", { name: "Метка: #дача", exact: true })).toHaveAttribute("data-set", "true");
  expect(await hash(page)).toMatch(/&tag=[0-9a-f-]{36}$/u);
  await page.goBack();
  expect(await hash(page)).toBe("#/reports?view=tags&period=quarter");
  await page.goBack();
  await expect(page.locator(".reach-card")).toBeVisible();
});

test("прошлый месяц из листа периода, свой период и пустой период: «За … расходов нет» с дорогой к записи", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Отчёты").click();
  // Чип своего периода называет выбранные дни, когда они выбраны: находим его по листу, который он открывает.
  const customChip = page.getByRole("group", { name: "Период и счёт" }).locator('button[aria-haspopup="dialog"]').first();
  await customChip.click();
  const sheet = page.getByRole("dialog", { name: "Период" });
  await sheet.getByRole("button", { name: /^Прошлый месяц/u }).click();
  expect(await hash(page)).toMatch(/^#\/reports\?period=month&from=\d{4}-\d{2}-01$/u);
  // Прошлый месяц демо — 79 400 ₽ истории, сравнение — с позапрошлым (88 900 ₽).
  await expect(page.locator(".report-compare")).toContainText(/^79\s400\s₽ за [а-я]+(?: \d{4})? — на 9\s500\s₽ меньше, чем в [а-я]+/u);
  // Период до истории демо — пустой: словами и с дорогой к записи.
  await customChip.click();
  await sheet.getByLabel("С", { exact: true }).fill("2020-01-10");
  await sheet.getByLabel("По", { exact: true }).fill("2020-01-20");
  await sheet.getByRole("button", { name: "Показать" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /^За 10.20\sянваря\s2020 расходов нет$/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Записать расход" })).toBeVisible();
  // Дни своего периода — проверка у поля: последний раньше первого — словами.
  await customChip.click();
  await sheet.getByLabel("С", { exact: true }).fill("2026-10-20");
  await sheet.getByLabel("По", { exact: true }).fill("2026-10-10");
  await sheet.getByRole("button", { name: "Показать" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Последний день раньше первого — поменяйте их местами.");
  await sheet.getByLabel("По", { exact: true }).fill("2026-10-31");
  await sheet.getByRole("button", { name: "Показать" }).click();
  expect(await hash(page)).toBe("#/reports?period=custom&from=2026-10-20&to=2026-10-31");
});

test("прошлый месяц на «Обзоре»: траты истории без лимитов и без «Открыть …»; «Расходы» ведут в «Отчёты» того месяца", async ({ page }) => {
  await loadDemo(page);
  const expenses = page.locator(".totals-strip").getByRole("button", { name: /^Расходы/u });
  await expect(expenses).toContainText(/71\s000\s₽/u);
  await page.getByRole("button", { name: /^Предыдущий месяц: /u }).click();
  expect(await hash(page)).toMatch(/^#\/\?month=\d{4}-\d{2}$/u);
  // Прошлый месяц демо — 79 400 ₽ истории; плана у него нет, открывать нечего.
  await expect(expenses).toContainText(/79\s400\s₽/u);
  await expect(page.getByRole("button", { name: /^Открыть /u })).toHaveCount(0);
  await expenses.click();
  await expect(heading(page)).toBeFocused();
  expect(await hash(page)).toMatch(/^#\/reports\?period=month&from=\d{4}-\d{2}-01$/u);
  await expect(page.locator(".report-compare")).toContainText(/^79\s400\s₽ за /u);
  // «Отчёты» — вкладка: «Назад» с неё — на «Обзор» сегодняшнего месяца (DESIGN §9).
  await page.goBack();
  await expect(expenses).toContainText(/71\s000\s₽/u);
  // История по месяцам: 79 400, 88 900 и 74 300 ₽.
  await page.getByRole("button", { name: /^Предыдущий месяц: /u }).click();
  await expect(expenses).toContainText(/79\s400\s₽/u);
  await page.getByRole("button", { name: /^Предыдущий месяц: /u }).click();
  await expect(expenses).toContainText(/88\s900\s₽/u);
  await page.getByRole("button", { name: /^Предыдущий месяц: /u }).click();
  await expect(expenses).toContainText(/74\s300\s₽/u);
});

test("«Отчёты» у начала календаря: пять адресов ревью открывают экран, а не белую страницу (HIGH-1)", async ({ page }) => {
  await loadDemo(page);
  // «Обзор» января 1900 года → «Расходы» — «Отчёты» того же месяца.
  await page.goto("/#/?month=1900-01");
  await page.locator(".totals-strip").getByRole("button", { name: /^Расходы/u }).click();
  await expect(heading(page)).toBeFocused();
  expect(await hash(page)).toBe("#/reports?period=month&from=1900-01-01");
  await expect(page.getByRole("heading", { level: 2, name: "В январе 1900 расходов нет" })).toBeVisible();
  const today = await page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  });
  for (const address of [
    "#/reports?period=month&from=1900-01-01",
    "#/reports?period=quarter&from=1900-02-01",
    "#/reports?period=year&from=1900-06-01",
    `#/reports?period=custom&from=1960-01-01&to=${today}`,
  ]) {
    await page.goto(`/${address}`);
    await expect(heading(page), address).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Экран не открылся" }), address).toHaveCount(0);
    expect(await hash(page), address).toBe(address);
  }
  // Свой период с 1960 года по сегодня — вся история демо, и сравнивать её не с чем: слова, а не падение.
  await expect(page.locator(".report-compare")).toContainText(/сравнить не с чем — записи ведутся с 1900 года$/u);
  await expect(page.getByRole("heading", { level: 2, name: "Больше всего ушло на категорию «Жильё»" })).toBeVisible();
});

test("G-003 из копии: C1, C2 и T1–T3 контракта — в «Отчётах» за август 2026", async ({ page }) => {
  await loadDemo(page);
  await restoreBudget(page, G003_LEDGER);
  // Сумма словами приложения (`formatMoney`): неразрывные пробелы — любым пробелом.
  const money = (minor: number) => new RegExp(formatMoney(minor, "RUB").replace(/[\s\u00a0\u202f]/gu, "\\s"), "u");
  await page.goto(`/#/reports?period=month&from=${G003_MONTH_FROM}`);
  await expect(heading(page)).toBeVisible();
  // Расходы августа — за вычетом возврата; C1 и C2 — строки легенды с суммой.
  await expect(page.locator(".report-compare")).toContainText(money(G003_EXPENSES_MINOR));
  for (const category of G003_CATEGORIES) {
    await expect(page.getByRole("button", { name: new RegExp(`^${category.name}: `, "u") }), category.name).toHaveAccessibleName(new RegExp(`^${category.name}: ${money(category.actualMinor).source}, \\d+\\s%\\. Показать операции$`, "u"));
  }
  // Доходы — «Зарплата».
  await page.getByRole("group", { name: "Что показать" }).getByRole("button", { name: "Доходы" }).click();
  await expect(page.locator(".report-compare")).toContainText(money(G003_INCOME_MINOR));
  // Метки: T1 «Отпуск», T2 «Дом» — расходами; T3 «Старое» в архиве — только доходом.
  await page.getByRole("group", { name: "Что показать" }).getByRole("button", { name: "Метки" }).click();
  for (const tag of G003_TAGS) {
    const row = page.getByRole("button", { name: new RegExp(`^#${tag.name}${tag.archived ? " \\(в архиве\\)" : ""}: `, "u") });
    await expect(row, tag.name).toHaveAccessibleName(new RegExp(`^#${tag.name}${tag.archived ? " \\(в архиве\\)" : ""}: ${money(tag.actualMinor).source}, `, "u"));
    if (tag.incomeMinor > 0) await expect(row, tag.name).toHaveAccessibleName(new RegExp(`доходы ${money(tag.incomeMinor).source}\\. Показать операции$`, "u"));
  }
  // Легенда C1 — «Операции» с той же суммой за август.
  await page.getByRole("group", { name: "Что показать" }).getByRole("button", { name: "Расходы" }).click();
  await page.getByRole("button", { name: new RegExp(`^${G003_CATEGORIES[0]!.name}: `, "u") }).click();
  await expect(page.getByRole("region", { name: "Операции" }).locator(".feed-sum")).toContainText(money(G003_CATEGORIES[0]!.actualMinor));
});

test("имена легенды и меток не рвутся посреди слова, а доступные имена — без мягких переносов (LOW-5)", async ({ page }) => {
  test.setTimeout(240_000);
  await loadDemo(page);
  // Год — все категории истории демо: «Развлечения», «Подарки», «Транспорт» — в легенде.
  await page.goto("/#/reports?period=year");
  await expect(heading(page)).toBeVisible();
  for (const view of ["Расходы", "Метки"] as const) {
    await page.getByRole("group", { name: "Что показать" }).getByRole("button", { name: view }).click();
    for (const [width, scale] of LINE_BREAK_LAYOUTS) {
      await applyFontScale(page, scale);
      await page.setViewportSize({ width, height: 844 });
      expect(await nameSplits(page, ".legend-text b"), `${view} ${width} pt ×${scale}`).toEqual([]);
    }
    await applyFontScale(page, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await softHyphenedNames(page), view).toEqual([]);
  }
});

test("«Свой период» на 320 pt при ×2.7: дни в полях видны целиком, с годом", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Отчёты").click();
  await page.setViewportSize({ width: 320, height: 640 });
  await applyFontScale(page, 2.7);
  await page.getByRole("group", { name: "Период и счёт" }).locator('button[aria-haspopup="dialog"]').first().click();
  const sheet = page.getByRole("dialog", { name: "Период" });
  for (const label of ["С", "По"]) {
    const field = sheet.getByLabel(label, { exact: true });
    await field.scrollIntoViewIfNeeded();
    // Поле дня шире своего текста и значка выбора даты: «20.10.2026» не обрезан справа ни цифрой года.
    const fits = await field.evaluate((input: HTMLInputElement) => {
      const style = getComputedStyle(input);
      const context = document.createElement("canvas").getContext("2d")!;
      // Сокращение `font` вычисленный стиль отдаёт не всегда — шрифт собирается по частям.
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      // Самый широкий вид дня: «88/88/8888» (разделитель зависит от языка браузера).
      const text = context.measureText("88/88/8888").width;
      const box = input.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
      return { text: Math.ceil(text), icon: Math.ceil(parseFloat(style.fontSize) * 1.25), box: Math.floor(box) };
    });
    expect(fits.box, `${label}: ${JSON.stringify(fits)}`).toBeGreaterThanOrEqual(fits.text + fits.icon);
  }
  await applyFontScale(page, 1);
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
