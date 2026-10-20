/**
 * «Записывается» на настоящих экранах (review of 2a, findings 2, 3 and 7).
 *
 * A draft sent to the store stops being "unsaved" from the same tap, and comes back the moment the
 * write is over: dirty again when it failed, clean once the reset form is drawn when it succeeded.
 * Unit tests drive the latch by hand; here the screens drive it — the entry sheet (since 2b the
 * operation form is a sheet over «Обзор», closed on «Записать»), the three planning editors and the
 * statement import — through success, failure and "saved, then started on something else". An
 * opened and untouched edit is not a draft at all. `fixtures.ts` fails the test on any system
 * dialog, so every question asked here is the app's own.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { sampleStatementText } from "../src/features/import/test-fixture";
import { amountField, entrySheet, loadDemo, recordExpense, submitButton, tile, toast } from "./sheet";

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

/** «Закрыть» листа — и ждать вопроса приложения о `label`; ответ «Продолжить ввод». */
async function closeAsksAbout(page: Page, label: string): Promise<void> {
  await entrySheet(page).getByRole("button", { name: "Закрыть", exact: true }).click();
  const dialog = leaveDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(label);
  await dialog.getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(entrySheet(page)).toBeVisible();
}

/** «Закрыть» листа — и он закрывается без вопроса. */
async function closesWithoutQuestion(page: Page): Promise<void> {
  await entrySheet(page).getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(leaveDialog(page)).toHaveCount(0);
}

async function openMonthPlan(page: Page): Promise<void> {
  await tab(page, "Ещё").click();
  await page.getByRole("button", { name: /^План месяца/u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "План месяца" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Плановые расходы" })).toBeVisible();
}

test("операция: записанная — не спрашивает; набранная после — спрашивает; не записавшаяся — спрашивает", async ({ page }) => {
  await loadDemo(page);
  await tile(page, "Продукты").click();
  await amountField(page).fill("1200");
  await submitButton(page).click();
  // Записанный черновик ушёл с тем же касанием: лист закрыт, и вкладка — без вопроса.
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(toast(page, /Записано: расход 1\s200\s₽/u)).toBeVisible();
  await leavesWithoutQuestion(page, "Отчёты", "Отчёты");
  await tab(page, "Обзор").click();

  // Записано, затем набрано новое: защёлка снята, новое — несохранённое.
  await tile(page, "Продукты").click();
  await amountField(page).fill("350");
  await closeAsksAbout(page, "операция, которую вы набирали");

  // Неудача: сумма, которую домен не принимает, — черновик на месте и снова несохранённый.
  await amountField(page).fill("0");
  await submitButton(page).click();
  await expect(page.locator("#entry-error")).toBeVisible();
  await expect(entrySheet(page)).toBeVisible();
  await closeAsksAbout(page, "операция, которую вы набирали");

  // Стёртый до того, с чем лист открыли, — не спрашивает.
  await amountField(page).fill("");
  await closesWithoutQuestion(page);
  await leavesWithoutQuestion(page, "Отчёты", "Отчёты");
});

test("правка операции: открытая и нетронутая — не черновик; тронутая — черновик", async ({ page }) => {
  await loadDemo(page);
  await tab(page, "Операции").click();
  const row = page.locator('button[aria-label^="Изменить операцию «Расход"]').first();
  await row.click();
  await expect(entrySheet(page)).toHaveAccessibleName(/^Изменить: /u);
  await closesWithoutQuestion(page);
  await leavesWithoutQuestion(page, "Обзор", /.+/u);
  await expect(page.locator(".reach-card")).toBeVisible();

  await tab(page, "Операции").click();
  await page.locator('button[aria-label^="Изменить операцию «Расход"]').first().click();
  await expect(entrySheet(page)).toHaveAccessibleName(/^Изменить: /u);
  await amountField(page).fill("777");
  await closeAsksAbout(page, "изменения в операции");
  // Системное «Назад» с тронутой правкой — тот же вопрос.
  await page.goBack();
  await expect(leaveDialog(page)).toContainText("изменения в операции");
  await leaveDialog(page).getByRole("button", { name: "Не сохранять" }).click();
  await expect(entrySheet(page)).toHaveCount(0);
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
  await expect(other.locator(".reach-card")).toBeVisible();
  await recordExpense(other, { category: "Продукты", amount: "10" });
  await expect(toast(other, /Записано: расход 10\s₽/u)).toBeVisible();
  await other.close();

  await add.click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /^Разобрано:/u })).toBeVisible();
  await asksAbout(page, "Обзор", "выписка, ещё не добавленная в бюджет");
});

test("«+» поверх «Плана месяца» и «Выписки» — не уход с экрана: его черновик не спрашивается и не теряется", async ({ page }) => {
  // Ревью 2b, MEDIUM-4: «+» над экраном с черновиком спрашивал «Уйти без сохранения?», а «Не
  // сохранять» стирал черновик экрана; «Продолжить ввод» не давал открыть лист.
  await loadDemo(page);
  await openMonthPlan(page);
  await page.locator("#commitment-name").fill("Страховка дачи");
  const plus = page.getByRole("button", { name: "Записать", exact: true });
  await plus.click();
  await expect(entrySheet(page)).toBeVisible();
  await expect(leaveDialog(page)).toHaveCount(0);
  await closesWithoutQuestion(page);
  await expect(page.locator("#commitment-name")).toHaveValue("Страховка дачи");

  // Набранное в листе: закрытие спрашивает только о листе, и «Не сохранять» стирает только его.
  await plus.click();
  await amountField(page).fill("350");
  await entrySheet(page).getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(leaveDialog(page)).toContainText("операция, которую вы набирали");
  await expect(leaveDialog(page)).not.toContainText("крупный платёж в плане");
  await leaveDialog(page).getByRole("button", { name: "Не сохранять" }).click();
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(page.locator("#commitment-name")).toHaveValue("Страховка дачи");
  // Уход с самого экрана по-прежнему спрашивает о его черновике.
  await asksAbout(page, "Обзор", "крупный платёж в плане");

  // Выписка в предпросмотре — то же.
  await page.locator("#commitment-name").fill("");
  await tab(page, "Ещё").click();
  await page.getByRole("button", { name: /Загрузить выписку банка/u }).click();
  await page.locator("#statement-file").setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from(sampleStatementText(), "utf8") });
  const parsed = page.getByRole("heading", { level: 1, name: /^Разобрано:/u });
  await expect(parsed).toBeVisible();
  await plus.click();
  await expect(entrySheet(page)).toBeVisible();
  await expect(leaveDialog(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(parsed).toBeVisible();
  await asksAbout(page, "Обзор", "выписка, ещё не добавленная в бюджет");
});
