/**
 * Края первого запуска (ревью R2): бюджет, заменённый копией, две вкладки, фокус после «Своей
 * категории», взмах пальцем по слайду, правка дней выплат, валюта набора, возврат из формы счёта
 * и память устройства при «Удалить данные» и в демо. Основной путь — `first-launch.spec.ts`.
 */
import { devices, type Page } from "@playwright/test";
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

/** Фокус внутри листа этого вопроса. */
async function focusInside(page: Page, title: string): Promise<boolean> {
  return page.evaluate((name) => {
    const dialog = document.activeElement?.closest("[role='dialog']");
    return dialog?.querySelector("h2")?.querySelector(".sr-only")?.textContent === name;
  }, title);
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

test("после «Своей категории» фокус снова в листе вопроса: Esc, сохранение, Tab по кругу и Esc листа", async ({ page }) => {
  await skipToOverview(page);
  const chips = question(page, CHIPS);
  const own = chips.getByRole("button", { name: "Своя категория" });
  const sheet = page.getByRole("dialog", { name: "Своя категория" });

  await own.focus();
  await page.keyboard.press("Enter");
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(own).toBeFocused();
  for (let step = 0; step < 4; step += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInside(page, CHIPS), `Tab ${step + 1} — внутри листа`).toBe(true);
  }

  await own.focus();
  await page.keyboard.press("Enter");
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Название").fill("Рыбалка");
  await sheet.getByRole("button", { name: "Сохранить категорию" }).focus();
  await page.keyboard.press("Enter");
  await expect(sheet).toHaveCount(0);
  const created = chips.getByRole("button", { name: "Рыбалка" });
  await expect(created).toHaveAttribute("aria-pressed", "true");
  await expect(created).toBeFocused();

  // Esc листа снова работает: «Спросить позже» — и следующий вопрос.
  await page.keyboard.press("Escape");
  await expect(chips).toHaveCount(0);
  await expect(question(page, ACCOUNTS)).toBeVisible();
});

test.describe("сенсорный экран", () => {
  const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 5"];
  test.use(pixel);

  test("взмах пальцем листает слайды в обе стороны", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("img", { name: "Шаг 1 из 3" })).toBeVisible();
    const box = await page.locator(".intro-slide").boundingBox();
    if (box === null) throw new Error("Слайда нет на экране.");
    const client = await page.context().newCDPSession(page);
    const y = Math.round(box.y + box.height * 0.3);
    const swipe = async (from: number, to: number) => {
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y }] });
      for (let step = 1; step <= 8; step += 1) {
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(from + ((to - from) * step) / 8), y }] });
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    const right = Math.round(box.x + box.width - 30);
    const left = Math.round(box.x + 30);
    await swipe(right, left);
    await expect(page.getByRole("img", { name: "Шаг 2 из 3" })).toBeVisible();
    await swipe(right, left);
    await expect(page.getByRole("img", { name: "Шаг 3 из 3" })).toBeVisible();
    await swipe(left, right);
    await expect(page.getByRole("img", { name: "Шаг 2 из 3" })).toBeVisible();
  });
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
