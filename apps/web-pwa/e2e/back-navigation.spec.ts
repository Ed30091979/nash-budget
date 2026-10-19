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
import { G002_UPPER_CASE_IDS, makeG002UpperCaseIdsBackupBuffer } from "./canonical-budget";
import { expect, test } from "./fixtures";
import { amountField, entrySheet, loadDemo, submitButton, tile, toast } from "./sheet";

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
  await expect(page.locator(".reach-card")).toBeVisible();
  expect(await hash(page)).toBe("#/");

  // Вкладка на вкладку заменяет запись: «Назад» с любой вкладки — на «Обзор», а не по кругу вкладок.
  await tab(page, "Операции").click();
  await tab(page, "Отчёты").click();
  await tab(page, "Ещё").click();
  await expect(page.getByRole("button", { name: /^План месяца/u })).toBeVisible();
  await back(page);
  await expect(page.locator(".reach-card")).toBeVisible();
  expect(await hash(page)).toBe("#/");

  // Кнопка «назад» экрана тоже ведёт к родителю и не оставляет в истории дубля.
  await tab(page, "Ещё").click();
  await page.getByRole("button", { name: /Семья и синхронизация/u }).click();
  await page.getByRole("button", { name: "Назад: Ещё" }).click();
  expect(await hash(page)).toBe("#/more");
  await back(page);
  await expect(page.locator(".reach-card")).toBeVisible();
});

test("лист «+» кладётся поверх вкладки, и «Назад» возвращает на неё", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Операции").click();
  await tab(page, "Записать").click();
  await expect(entrySheet(page)).toBeVisible();
  // Под листом — тот же экран (скрытый от диктора, пока лист открыт): адрес называет его и лист.
  await expect(page.locator(".feed-screen")).toBeAttached();
  expect(await hash(page)).toBe("#/operations?sheet=entry");
  await back(page);
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Операции" })).toBeVisible();
  expect(await hash(page)).toBe("#/operations");
  // Фокус вернулся на «+», которым лист открыли.
  await expect(tab(page, "Записать")).toBeFocused();
});

test("несохранённый черновик «Назад» не теряет: адрес на месте, вопрос — диалогом приложения", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Записать").click();
  const amount = amountField(page);
  await amount.fill("1234");

  await back(page);
  const dialog = page.getByRole("alertdialog", { name: "Уйти без сохранения?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Не записано: операция, которую вы набирали.");
  expect(await hash(page)).toBe("#/?sheet=entry");
  // Фокус в диалоге — на безопасном ответе.
  await expect(dialog.getByRole("button", { name: "Продолжить ввод" })).toBeFocused();

  // «Продолжить ввод»: всё как было.
  await dialog.getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(amount).toHaveValue("1234");
  expect(await hash(page)).toBe("#/?sheet=entry");

  // «Закрыть» листа с черновиком спрашивает то же самое; Esc — безопасный ответ.
  await entrySheet(page).getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(amount).toHaveValue("1234");

  // «Не сохранять»: туда, куда шли, и без системного окна на всём пути.
  await back(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Не сохранять" }).click();
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(page.locator(".reach-card")).toBeVisible();
  expect(await hash(page)).toBe("#/");
});

test("адрес, набранный руками поверх черновика, не расходится с экраном: «Не сохранять» → «Обзор» и в адресе, и после перезагрузки", async ({ page }) => {
  await loadDemo(page);
  await tile(page, "Продукты").click();
  const amount = amountField(page);
  await amount.fill("1234");
  const sheetAddress = await hash(page);
  expect(sheetAddress).toMatch(/^#\/\?sheet=entry&op=expense&src=[0-9a-f-]{36}&dst=[0-9a-f-]{36}$/u);

  // Набранный адрес — переход по якорю внутри открытой страницы, как из адресной строки.
  await page.goto("/#/reports");
  const dialog = page.getByRole("alertdialog", { name: "Уйти без сохранения?" });
  await expect(dialog).toBeVisible();
  expect(await hash(page)).toBe(sheetAddress);
  await dialog.getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(amount).toHaveValue("1234");

  await entrySheet(page).getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Не сохранять" }).click();
  await expect(page.locator(".reach-card")).toBeVisible();
  await expect.poll(() => hash(page)).toBe("#/");

  // Перезагрузка открывает то, что было на экране, а не лист.
  await page.reload();
  await expect(page.locator(".reach-card")).toBeVisible();
  await expect(amount).toHaveCount(0);
  expect(await hash(page)).toBe("#/");
});

test("адрес, набранный поверх черновика, → «Назад» → «Не сохранять» закрывает лист", async ({ page }) => {
  // Ревью 2a, круг 2, LOW 2: копия «+» лежала под экраном, и «Не сохранять» оставлял на «+». Теперь
  // «+» — лист поверх «Обзора», правило то же.
  await loadDemo(page);
  await tab(page, "Записать").click();
  await amountField(page).fill("1234");
  // Новая запись истории над «+» — так её кладёт адресная строка; `page.goto` с одной решёткой
  // Chromium ставит на место текущей, и этот путь проверяет тест ниже.
  await page.evaluate(() => { window.location.hash = "#/reports"; });
  const dialog = page.getByRole("alertdialog", { name: "Уйти без сохранения?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Продолжить ввод" }).click();
  expect(await hash(page)).toBe("#/?sheet=entry");
  await back(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Не сохранять" }).click();
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(page.locator(".reach-card")).toBeVisible();
  await expect.poll(() => hash(page)).toBe("#/");
});

test("адрес, поставленный на место текущей записи, не сбивает счёт шагов: приложение не уходит за свою историю", async ({ page }) => {
  // Ревью 2a, круг 2, LOW 3: после `location.replace` возврат по истории перелетал на about:blank.
  await loadDemo(page);
  await tab(page, "Операции").click();
  await expect(page.getByRole("region", { name: "Операции" })).toBeVisible();
  await page.evaluate(() => { window.location.replace("#/reports"); });
  await expect(page.getByRole("heading", { level: 1, name: "Отчёты" })).toBeVisible();
  await tab(page, "Ещё").click();
  await page.getByRole("button", { name: /^План на год/u }).click();
  await expect(page.getByRole("heading", { name: /Плана хватает/u })).toBeVisible();
  await tab(page, "Обзор").click();
  await expect(page.locator(".reach-card")).toBeVisible();
  expect(page.url()).not.toContain("about:blank");
  expect(await hash(page)).toBe("#/");
  // «Назад» с корня — прочь из приложения, а не на чужую запись внутри него.
  await tab(page, "Отчёты").click();
  await back(page);
  await expect(page.locator(".reach-card")).toBeVisible();
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
  await expect(page.locator(".reach-card")).toBeVisible();

  await page.goto("/#/bogus/route");
  await expect(page.locator(".message-toast")).toContainText("Запись не найдена");
  await expect(page.locator(".reach-card")).toBeVisible();
  expect(await hash(page)).toBe("#/");

  // Перезагрузка оставляет на том же месте: адрес — это маршрут.
  await tab(page, "Отчёты").click();
  await expect(page.getByRole("heading", { name: "Отчёты" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Отчёты" })).toBeVisible();
  await back(page);
  await expect(page.locator(".reach-card")).toBeVisible();
});

test("операция с идентификатором в верхнем регистре открывается по адресу и правится", async ({ page }) => {
  // Ревью 2a, п. 4: адрес пишет UUID строчными, а копия и журнал принимают любой регистр. С 2b
  // правка — лист поверх «Операций»: адрес его называет, а перезагрузка лист закрывает.
  await loadDemo(page);
  await tab(page, "Ещё").click();
  await page.locator("#backup-file").setInputFiles({
    name: "family-budget-upper-case-ids.json",
    mimeType: "application/json",
    buffer: makeG002UpperCaseIdsBackupBuffer(),
  });
  await expect(page.getByRole("status").filter({ hasText: "Резервная копия восстановлена." })).toBeVisible();

  await tab(page, "Операции").click();
  const row = page.locator('button[aria-label^="Изменить операцию «Расход"]').first();
  await row.click();
  await expect(entrySheet(page)).toHaveAccessibleName(/^Изменить: /u);
  await expect(page.locator(".message-toast")).toHaveCount(0);
  const address = await hash(page);
  expect(address).toMatch(/^#\/operations\?sheet=entry&edit=[0-9a-f-]{36}$/u);
  expect(G002_UPPER_CASE_IDS.map((id) => id.toLowerCase())).toContain(address.slice("#/operations?sheet=entry&edit=".length));
  await expect(amountField(page)).not.toHaveValue("");

  // Правится: сумма меняется и сохраняется той же операции, найденной без учёта регистра.
  await amountField(page).fill("4321");
  await submitButton(page).click();
  await expect(toast(page, /Изменено: расход 4\s321\s₽/u)).toBeVisible();
  await expect(page.locator('button[aria-label^="Изменить операцию «Расход 4\u00a0321"]')).toHaveCount(1);

  // Перезагрузка с открытым листом закрывает его: черновика в адресе нет и не было.
  await page.locator('button[aria-label^="Изменить операцию «Расход"]').first().click();
  await expect(entrySheet(page)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Операции" })).toBeVisible();
  await expect(entrySheet(page)).toHaveCount(0);
  expect(await hash(page)).toBe("#/operations");
});

/** Кнопка «назад» строки заголовка: её прямоугольник — цель нажатия, не меньше 48 в обе стороны. */
async function expectTitleBarBack(page: Page, name: string): Promise<void> {
  const back = page.locator(".title-bar").getByRole("button", { name, exact: true });
  await expect(back).toBeVisible();
  const box = await back.boundingBox();
  expect(box?.width ?? 0, `${name}: ширина цели`).toBeGreaterThanOrEqual(48);
  expect(box?.height ?? 0, `${name}: высота цели`).toBeGreaterThanOrEqual(48);
}

test("строка заголовка: «‹ Ещё» на каждом подэкране ведёт к родителю, и фокус — на заголовке, куда пришли", async ({ page }) => {
  // Дизайн 5.0, §d: шапки «Наш бюджет» нет, а кнопку-рамку «← К разделу «Ещё»» сменила строка
  // заголовка. Поведение то же: подэкран кладёт запись, «назад» — к родителю без дубля в истории,
  // после перехода фокус на `h1` экрана (DESIGN §9).
  test.setTimeout(120_000);
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Наш бюджет", { exact: true })).toHaveCount(0);
  const subscreens: readonly (readonly [RegExp, string, string])[] = [
    [/^Счета/u, "Счета", "#/more/accounts"],
    [/^Категории и доходы/u, "Категории и доходы", "#/more/categories?type=expense"],
    [/^Метки/u, "Метки", "#/more/tags"],
    [/^Курсы валют/u, "Курсы валют", "#/more/rates"],
    [/^План месяца/u, "План месяца", "#/more/plan-month"],
    [/^План на год/u, "План на год", "#/more/plan-year"],
    [/^Семья и синхронизация/u, "Семья", "#/more/family"],
    [/Загрузить выписку банка/u, "Выписка банка", "#/more/import"],
  ];
  for (const [row, title, address] of subscreens) {
    await tab(page, "Ещё").click();
    await expect(page.getByRole("heading", { level: 1, name: "Ещё" })).toBeVisible();
    await page.getByRole("button", { name: row }).click();
    expect(await hash(page), title).toBe(address);
    const heading = page.getByRole("heading", { level: 1, name: title });
    await expect(heading).toBeVisible();
    await expect(heading, `${title}: фокус на заголовке после перехода`).toBeFocused();
    await expect(page.getByRole("heading", { level: 1 }), `${title}: заголовок экрана один`).toHaveCount(1);
    await expectTitleBarBack(page, "Назад: Ещё");
    await page.getByRole("button", { name: "Назад: Ещё", exact: true }).click();
    expect(await hash(page), `${title} → «Ещё»`).toBe("#/more");
    await expect(page.getByRole("heading", { level: 1, name: "Ещё" })).toBeFocused();
  }
  // Вглубь — к своему родителю: форма счёта → «‹ Счета», категория → «‹ Расходы».
  await page.getByRole("button", { name: /^Счета/u }).click();
  await page.getByRole("button", { name: /^Резерв платежей: .*Изменить$/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Резерв платежей" })).toBeFocused();
  await expectTitleBarBack(page, "Назад: Счета");
  await page.getByRole("button", { name: "Назад: Счета", exact: true }).click();
  expect(await hash(page)).toBe("#/more/accounts");
  await expect(page.getByRole("heading", { level: 1, name: "Счета" })).toBeFocused();
  // Вкладки — крупным заголовком, без «назад».
  for (const [name, title] of [["Операции", "Операции"], ["Отчёты", "Отчёты"], ["Ещё", "Ещё"]] as const) {
    await tab(page, name).click();
    await expect(page.locator(".large-title").getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.locator(".title-bar")).toHaveCount(0);
  }
});
