/**
 * «Записывается» на настоящих экранах (review of 2a, findings 2, 3 and 7).
 *
 * A draft sent to the store stops being "unsaved" from the same tap, and comes back the moment the
 * write is over: dirty again when it failed, clean once the reset form is drawn when it succeeded.
 * Unit tests drive the latch by hand; here the screens drive it — the operation form, the three
 * planning editors and the statement import — through success, failure and "saved, then started
 * on something else". An opened and untouched edit is not a draft at all. `fixtures.ts` fails the
 * test on any system dialog, so every question asked here is the app's own.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { sampleStatementText } from "../src/features/import/test-fixture";

async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Загрузить демонстрационный бюджет" }).click();
  await expect(page.locator(".hero-card")).toBeVisible();
}

const tab = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const leaveDialog = (page: Page) => page.getByRole("alertdialog", { name: "Уйти без сохранения?" });

/** Tap a tab and expect the app to go there without asking anything. */
async function leavesWithoutQuestion(page: Page, name: string, heading: RegExp | string): Promise<void> {
  await tab(page, name).click();
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  await expect(leaveDialog(page)).toHaveCount(0);
}

/** Tap a tab and expect the app to ask about `label`; answer «Продолжить ввод». */
async function asksAbout(page: Page, name: string, label: string): Promise<void> {
  await tab(page, name).click();
  const dialog = leaveDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(label);
  await dialog.getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(dialog).toHaveCount(0);
}

async function openMonthPlan(page: Page): Promise<void> {
  await tab(page, "Ещё").click();
  await page.getByRole("button", { name: /^План месяца/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Плановые расходы" })).toBeVisible();
}

test("операция: записанная — не спрашивает; набранная после — спрашивает; не записавшаяся — спрашивает", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Записать").click();
  const amount = page.getByLabel("Сумма, ₽");
  await amount.fill("1200");
  await page.getByRole("button", { name: /^Продукты: останется/u }).click();
  await page.getByRole("button", { name: /^Записать 1\s200\s₽ в «Продукты»$/u }).click();
  await expect(page.getByRole("status").filter({ hasText: /Записано: расход 1\s200\s₽/u })).toBeVisible();

  // Записано и сброшено, затем набрано новое: защёлка снята, новое — несохранённое.
  await amount.fill("350");
  await asksAbout(page, "Отчёты", "операция, которую вы набирали");

  // Неудача: сумма, которую домен не принимает, — черновик на месте и снова несохранённый.
  await amount.fill("0");
  await page.getByRole("button", { name: "Записать покупку", exact: true }).click();
  await expect(page.locator("#operation-form-error")).toBeVisible();
  await asksAbout(page, "Обзор", "операция, которую вы набирали");

  // Очищенный — не спрашивает.
  await page.getByRole("button", { name: "Очистить черновик" }).click();
  await leavesWithoutQuestion(page, "Отчёты", "Отчёты");
});

test("правка операции: открытая и нетронутая — не черновик; тронутая — черновик", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Операции").click();
  const row = page.locator('button[aria-label^="Изменить операцию «"]').first();
  await row.click();
  await expect(page.getByRole("heading", { level: 1, name: "Изменить операцию" })).toBeVisible();
  await leavesWithoutQuestion(page, "Обзор", /.+/u);
  await expect(page.locator(".hero-card")).toBeVisible();

  await tab(page, "Операции").click();
  await page.locator('button[aria-label^="Изменить операцию «"]').first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Изменить операцию" })).toBeVisible();
  await page.getByLabel("Сумма, ₽").fill("777");
  await asksAbout(page, "Обзор", "изменения в операции");
});

test("план месяца: крупный и регулярный платёж — удача, новое после неё, неудача; нетронутая правка — не черновик", async ({ page }) => {
  await loadDemo(page);
  await openMonthPlan(page);

  // Крупный платёж: удача.
  await page.locator("#commitment-name").fill("Страховка дачи");
  await page.locator("#commitment-dueDate").fill("2027-03-15");
  await page.locator("#commitment-amount").fill("12000");
  await page.locator("#commitment-reserved").fill("0");
  await page.getByRole("button", { name: "Добавить крупный платёж" }).click();
  await expect(page.getByRole("button", { name: "Изменить крупный платёж «Страховка дачи»" })).toBeVisible();
  await expect(page.locator("#commitment-name")).toHaveValue("");
  // Начато новое после записи — спрашивает.
  await page.locator("#commitment-name").fill("Лагерь");
  await asksAbout(page, "Обзор", "крупный платёж в плане");
  // Неудача: без суммы домен отказывает, черновик несохранённый.
  await page.getByRole("button", { name: "Добавить крупный платёж" }).click();
  await expect(page.locator(".field-error").first()).toBeVisible();
  await asksAbout(page, "Обзор", "крупный платёж в плане");
  await page.locator("#commitment-name").fill("");

  // Регулярный платёж: удача, затем новое.
  await page.locator("#schedule-name").fill("Кружок рисования");
  await page.locator("#schedule-amount").fill("3500");
  await page.locator("#schedule-dueDay").fill("10");
  await page.getByRole("button", { name: "Добавить расписание" }).click();
  await expect(page.getByRole("button", { name: "Изменить расписание «Кружок рисования»" })).toBeVisible();
  await expect(page.locator("#schedule-name")).toHaveValue("");
  await page.locator("#schedule-amount").fill("1000");
  await asksAbout(page, "Обзор", "регулярный платёж в плане");
  // Неудача: без названия.
  await page.getByRole("button", { name: "Добавить расписание" }).click();
  await expect(page.locator(".field-error").first()).toBeVisible();
  await asksAbout(page, "Обзор", "регулярный платёж в плане");
  await page.locator("#schedule-amount").fill("");

  // «Изменить» и ничего не трогать — переход без вопроса.
  await page.getByRole("button", { name: "Изменить крупный платёж «Страховка дачи»" }).click();
  await expect(page.locator("#commitment-name")).toHaveValue("Страховка дачи");
  await page.getByRole("button", { name: "Изменить расписание «Кружок рисования»" }).click();
  await expect(page.locator("#schedule-name")).toHaveValue("Кружок рисования");
  await leavesWithoutQuestion(page, "Обзор", /.+/u);
});

test("повседневный лимит: сумма возврата из архива не держит защёлку — после записи новое черновиком и спрашивает", async ({ page }) => {
  await loadDemo(page);
  await openMonthPlan(page);

  // Ревью 2a, п. 2: «В архив» на лимите, сумма для возврата, затем «Добавить».
  const archive = page.locator('button[aria-label^="Архивировать повседневный лимит «"]').first();
  const archivedName = ((await archive.getAttribute("aria-label")) ?? "").replace(/^Архивировать повседневный лимит «(.*)»$/u, "$1");
  await archive.click();
  const restore = page.getByLabel(`Лимит «${archivedName}» при возврате, ₽`);
  await expect(restore).toBeVisible();
  await restore.fill("777");
  await page.locator("#flexible-name").fill("Хобби");
  await page.locator("#flexible-amount").fill("4000");
  await page.getByRole("button", { name: "Добавить повседневный лимит" }).click();
  await expect(page.getByRole("button", { name: "Изменить повседневный лимит «Хобби»" })).toBeVisible();
  await expect(page.locator("#flexible-name")).toHaveValue("");
  // Новое название после записи — несохранённое: вопрос, а не молча потерянные черновики.
  await page.locator("#flexible-name").fill("Подарки");
  await asksAbout(page, "Отчёты", "повседневный лимит в плане");
  // Даже с чистой формой сумма возврата — черновик сама по себе.
  await page.locator("#flexible-name").fill("");
  await asksAbout(page, "Отчёты", "повседневный лимит в плане");
  // Неудача: лимит без названия.
  await expect(restore).toHaveValue("777");
  await page.locator("#flexible-amount").fill("500");
  await page.getByRole("button", { name: "Добавить повседневный лимит" }).click();
  await expect(page.locator("#flexible-name-error, #flexible-amount-error, #flexible-form").first()).toBeVisible();
  await asksAbout(page, "Отчёты", "повседневный лимит в плане");

  // Нетронутая правка лимита — не черновик, когда больше ничего не набрано.
  await page.locator("#flexible-amount").fill("");
  await page.getByRole("button", { name: `Вернуть повседневный лимит «${archivedName}»` }).click();
  await expect(page.getByRole("button", { name: `Изменить повседневный лимит «${archivedName}»` })).toBeVisible();
  await page.getByRole("button", { name: "Изменить повседневный лимит «Хобби»" }).click();
  await expect(page.locator("#flexible-name")).toHaveValue("Хобби");
  await leavesWithoutQuestion(page, "Отчёты", "Отчёты");
});

test("выписка: добавленная — не спрашивает; следующая в предпросмотре — спрашивает; конфликт с другой вкладкой — спрашивает", async ({ page }) => {
  await loadDemo(page);
  // Две выписки за разные месяцы: вторая — не повтор первой, и ей есть что добавить.
  const statement = (month: string) => ({
    name: `statement-${month}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(sampleStatementText().replaceAll(".08.2026", `.${month}.2026`), "utf8"),
  });
  const openImport = async (month: string) => {
    await tab(page, "Ещё").click();
    await page.getByRole("button", { name: /Загрузить выписку банка/u }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Выписка банка" })).toBeVisible();
    await page.locator("#statement-file").setInputFiles(statement(month));
    await expect(page.getByRole("heading", { level: 1, name: /^Разобрано:/u })).toBeVisible();
  };
  const add = page.getByRole("button", { name: /^Добавить .* в бюджет$/u });

  await openImport("08");
  await add.click();
  await expect(page.getByRole("heading", { level: 1, name: /^Добавлено:/u })).toBeVisible();
  await leavesWithoutQuestion(page, "Отчёты", "Отчёты");

  // Следующая выписка в предпросмотре — черновик.
  await openImport("09");
  await expect(add).toBeEnabled();
  await asksAbout(page, "Обзор", "выписка, ещё не добавленная в бюджет");

  // Неудача: бюджет изменён в другой вкладке, и запись этой отказывает — предпросмотр на месте и
  // снова несохранённый.
  const other = await page.context().newPage();
  await other.goto("/");
  await expect(other.locator(".hero-card")).toBeVisible();
  await other.getByRole("button", { name: "Записать", exact: true }).click();
  await other.getByLabel("Сумма, ₽").fill("10");
  await other.getByRole("button", { name: /^Продукты: останется/u }).click();
  await other.getByRole("button", { name: /^Записать 10\s₽ в «Продукты»$/u }).click();
  await expect(other.getByRole("status").filter({ hasText: /Записано: расход 10\s₽/u })).toBeVisible();
  await other.close();

  await add.click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /^Разобрано:/u })).toBeVisible();
  await asksAbout(page, "Обзор", "выписка, ещё не добавленная в бюджет");
});
