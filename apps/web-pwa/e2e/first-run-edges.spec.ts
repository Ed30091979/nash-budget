/**
 * Края первого запуска (ревью R2): бюджет, заменённый копией, две вкладки, фокус после «Своей
 * категории», взмах пальцем по слайду, правка дней выплат, валюта набора, возврат из формы счёта
 * и память устройства при «Удалить данные» и в демо. Основной путь — `first-launch.spec.ts`.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { demoBudget, restoreBudget } from "./budgets";
import { tile } from "./sheet";

test.use({ locale: "ru-RU" });

const question = (page: Page, name: string) => page.getByRole("dialog", { name });
const CHIPS = "На что вы тратите?";
const ACCOUNTS = "Есть ещё места, где лежат деньги?";
const PAYDAY = "Когда приходит зарплата?";
const FIRST_RUN_DATABASE = "family-budget-first-run";

/** «Пропустить» на первом слайде — и лист чипов над «Обзором». */
async function skipToOverview(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Пропустить" }).click();
  await expect(question(page, CHIPS)).toBeVisible();
}

/** Память первого запуска с диска (своя база IndexedDB); `null` — базы или записи нет. */
async function firstRunMemory(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(async (name) => {
    if (!(await indexedDB.databases()).some((item) => item.name === name)) return null;
    return new Promise<Record<string, unknown> | null>((resolve, reject) => {
      const opening = indexedDB.open(name);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        if (!database.objectStoreNames.contains("first-run")) {
          database.close();
          resolve(null);
          return;
        }
        const reading = database.transaction("first-run", "readonly").objectStore("first-run").get("state");
        reading.onerror = () => { database.close(); reject(reading.error); };
        reading.onsuccess = () => { database.close(); resolve((reading.result as Record<string, unknown> | undefined) ?? null); };
      };
    });
  }, FIRST_RUN_DATABASE);
}

test("восстановленная копия заканчивает первый запуск: через неделю вопросы не открываются над чужим бюджетом", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-05T10:00:00"));
  await skipToOverview(page);
  for (const name of [CHIPS, ACCOUNTS, PAYDAY]) {
    await question(page, name).getByRole("button", { name: "Спросить позже" }).click();
  }
  await expect(page.locator("[role='dialog']")).toHaveCount(0);
  await restoreBudget(page, demoBudget());
  await expect.poll(() => firstRunMemory(page)).toMatchObject({ startedOn: null, questions: {}, coach: null });

  await page.clock.setFixedTime(new Date("2026-10-13T10:00:00"));
  await page.reload();
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(page.locator(".overview-screen")).toBeVisible();
  await expect(tile(page, "Доллары")).toHaveCount(0);
  await expect(page.locator("[role='dialog']")).toHaveCount(0);
  await expect(page.locator(".coach-bubble")).toHaveCount(0);
});

test("две вкладки: пример в одной и «Пропустить» в другой — вопросов нет ни в одной", async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto("/");
  await second.goto("/");
  for (let step = 0; step < 2; step += 1) await first.getByRole("button", { name: "Дальше", exact: true }).click();
  await first.getByRole("button", { name: "Посмотреть на примере" }).click();
  await expect(first.locator(".reach-line")).toBeVisible();

  await second.getByRole("button", { name: "Пропустить" }).click();
  await expect(second.getByText("Бюджет уже создан в другой вкладке", { exact: false })).toBeVisible();
  await expect(second.locator(".overview-screen")).toBeVisible();
  await expect(second.locator("[role='dialog']")).toHaveCount(0);
  await expect(second.locator(".coach-bubble")).toHaveCount(0);

  await first.reload();
  await expect(first.locator(".overview-screen")).toBeVisible();
  await expect(first.locator("[role='dialog']")).toHaveCount(0);
});

test("«Удалить данные» стирает память первого запуска, а пример её обнуляет", async ({ page }) => {
  await skipToOverview(page);
  for (const name of [CHIPS, ACCOUNTS, PAYDAY]) {
    await question(page, name).getByRole("button", { name: "Спросить позже" }).click();
  }
  await expect.poll(() => firstRunMemory(page)).toMatchObject({ questions: { categories: { status: "later" }, payday: { status: "later" } } });
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.getByRole("button", { name: /^Удалить данные с этого устройства/u }).click();
  await page.getByRole("alertdialog", { name: "Удалить весь семейный бюджет с устройства?" }).getByRole("button", { name: "Удалить все данные" }).click();
  await expect(page.getByRole("button", { name: "Пропустить" })).toBeVisible();
  expect(await firstRunMemory(page)).toBeNull();

  // Память с прошлого набора — на месте (её не стёрли бы, например, в другой вкладке): пример её
  // обнуляет, и над демо нет ни вопросов, ни подсказки на первую трату.
  await page.evaluate(async (name) => {
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = () => { if (!opening.result.objectStoreNames.contains("first-run")) opening.result.createObjectStore("first-run"); };
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const writing = database.transaction("first-run", "readwrite");
        writing.objectStore("first-run").put({ startedOn: "2026-01-01", questions: { categories: { status: "pending", on: "2026-01-01", postponed: 0 } }, coach: "pending", closedHints: [] }, "state");
        writing.oncomplete = () => { database.close(); resolve(); };
        writing.onerror = () => { database.close(); reject(writing.error); };
      };
    });
  }, FIRST_RUN_DATABASE);
  await page.goto("/");
  for (let step = 0; step < 2; step += 1) await page.getByRole("button", { name: "Дальше", exact: true }).click();
  await page.getByRole("button", { name: "Посмотреть на примере" }).click();
  await expect(page.locator(".reach-line")).toBeVisible();
  await expect(page.locator("[role='dialog']")).toHaveCount(0);
  await expect(page.locator(".coach-bubble")).toHaveCount(0);
  await expect.poll(() => firstRunMemory(page)).toMatchObject({ startedOn: null, questions: {} });
});
