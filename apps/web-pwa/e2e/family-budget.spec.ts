import type { Page, Response } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  G002_INITIAL_OPERATION_COUNT,
  makeG002BackupBuffer,
} from "./canonical-budget";
import { amountField, entrySheet, leaveDialog, reachAmount, recordExpense, startDemo, tile } from "./sheet";

const INITIAL_FLEXIBLE_REMAINING = /27\s*000\s*₽/u;
const UPDATED_FLEXIBLE_REMAINING = /18\s*000\s*₽/u;
const PRODUCTS_OVER_LIMIT = /^Продукты: потрачено 31\s000\s₽ из 30\s000\s₽, перелимит 1\s000\s₽\. Записать расход$/u;
const TIGHTEST_MONTH_FREE = /13\s*191\s*₽/u;

function expectNavigationSecurityHeaders(response: Response | null) {
  expect(response).not.toBeNull();
  expect(response?.headers()["content-security-policy"])
    .toContain("frame-ancestors 'none'");
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
}

/** История операций — вкладка «Операции» нижней навигации. */
async function openHistory(page: Page) {
  const history = page.getByRole("region", { name: "Операции" });
  if (await history.count()) return;
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  await expect(history).toBeVisible();
}

/** План на год — подэкран «Ещё»: отдельной вкладки «Год» в навигации из пяти мест нет. */
async function openYearPlan(page: Page) {
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.getByRole("button", { name: /^План на год/u }).click();
}

async function expectBudgetSnapshot(
  page: Page,
  remaining: RegExp,
  operationCount: number,
) {
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  // Строка «Можно на повседневные» называет остаток месяца плана независимо от того, идёт этот
  // месяц сейчас или уже закрыт.
  await expect(reachAmount(page)).toHaveText(remaining);

  await openHistory(page);
  await expect(
    page.getByRole("status").filter({ hasText: `Показано ${operationCount} из ${operationCount}` }),
  ).toBeVisible();
}

async function expectAddedExpense(page: Page) {
  // Строка истории называет категорию, дату с видом операции и сумму со знаком направления.
  // Проверяется то, что видно в строке, а не порядок тегов внутри неё.
  const row = page
    .getByRole("region", { name: "Операции" })
    .getByRole("listitem")
    .filter({ hasText: /9\s*000\s*₽/u });
  await expect(row).toContainText("2026-07-18");
  await expect(row).toContainText("Продукты");
}

test("G-002 survives restore, offline nested navigation, and an explicit A to B update", async ({
  context,
  page,
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required.");
  const externalRequests = new Set<string>();
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (url.origin !== new URL(baseURL).origin) externalRequests.add(url.origin);
  });

  const initialResponse = await page.goto("/");
  expect(initialResponse?.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: /^Записать трату/u })).toBeVisible();
  await startDemo(page);

  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.locator("#backup-file").setInputFiles({
    name: "family-budget-g002.json",
    mimeType: "application/json",
    buffer: makeG002BackupBuffer(),
  });
  await expect(page.getByRole("status").filter({ hasText: "Резервная копия восстановлена." }))
    .toBeVisible();
  await expectBudgetSnapshot(page, INITIAL_FLEXIBLE_REMAINING, G002_INITIAL_OPERATION_COUNT);

  // Покупка: плитка категории открывает лист, дата — «Другой день», сумма — и кнопка, которая
  // называет действие и сумму словами.
  await recordExpense(page, { category: "Продукты", amount: "9000", date: "2026-07-18" });
  await expect(page.locator(".message-toast")).toContainText(/Записано: расход 9\s000\s₽/u);
  await openHistory(page);
  await expect(
    page.getByRole("status").filter({
      hasText: `Показано ${G002_INITIAL_OPERATION_COUNT + 1} из ${G002_INITIAL_OPERATION_COUNT + 1}`,
    }),
  ).toBeVisible();
  await expectAddedExpense(page);

  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(reachAmount(page)).toHaveText(UPDATED_FLEXIBLE_REMAINING);
  // Перелимит июля — на плитке «Продуктов» в июле: глиф на плитке, слово и сумма — в её имени.
  await page.goto("/#/?month=2026-07");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Июль 2026$/u);
  await expect(tile(page, "Продукты")).toHaveAttribute("aria-label", PRODUCTS_OVER_LIMIT);
  await page.getByRole("button", { name: "Обзор", exact: true }).click();

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);

  await context.setOffline(true);
  const offlineRootResponse = await page.reload();
  expect(offlineRootResponse?.fromServiceWorker()).toBe(true);
  expectNavigationSecurityHeaders(offlineRootResponse);
  // Офлайн доказывается тем, что страница пришла из сервис-воркера и бюджет на месте, — а не
  // пилюлей «офлайн»: приложение к сети не обращается и своё состояние сети не объявляет.
  await expectBudgetSnapshot(
    page,
    UPDATED_FLEXIBLE_REMAINING,
    G002_INITIAL_OPERATION_COUNT + 1,
  );
  await expectAddedExpense(page);

  const nestedResponse = await page.goto("/year");
  expect(nestedResponse?.fromServiceWorker()).toBe(true);
  expectNavigationSecurityHeaders(nestedResponse);
  await openYearPlan(page);
  // «Год» отвечает за горизонт: заголовок — вывод, лестница месяцев — где дно. У восстановленного
  // G-002 дно — пять месяцев на одной сумме, и все пять выделены в лестнице.
  await expect(page.getByRole("heading", { name: /Плана хватает во все 12 месяцев/u })).toBeVisible();
  await expect(page.locator(".ladder-row.tight")).toHaveCount(5);
  await expect(page.locator(".ladder-row.tight .ladder-value").first()).toHaveText(TIGHTEST_MONTH_FREE);
  await openHistory(page);
  await expect(
    page.getByRole("status").filter({
      hasText: `Показано ${G002_INITIAL_OPERATION_COUNT + 1} из ${G002_INITIAL_OPERATION_COUNT + 1}`,
    }),
  ).toBeVisible();
  await expectAddedExpense(page);

  await context.setOffline(false);
  // Лист ввода с черновиком: новая версия не прерывает набор — её плашка ждёт под затемнением.
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await tile(page, "Продукты").click();
  await amountField(page).fill("1234");

  const switchResponse = await request.post(`${baseURL}/__e2e__/switch-build`, {
    headers: { Origin: baseURL },
  });
  expect(switchResponse.ok()).toBe(true);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });

  const updateButton = page.getByRole("button", { name: "Обновить сейчас" });
  await expect(updateButton).toBeAttached();
  await expect(amountField(page)).toHaveValue("1234");

  // Считаются перезагрузки документа, а не смены адреса: переходы внутри приложения меняют
  // решётку адреса (тоже `framenavigated`), но страницу не перезагружают и черновик не теряют.
  let mainFrameNavigations = 0;
  page.on("load", () => {
    mainFrameNavigations += 1;
  });
  // Пока лист открыт, плашка под затемнением: нажать её нельзя, и черновик никуда не делся.
  const covering = await updateButton.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit !== null && !button.contains(hit);
  });
  expect(covering, "плашка обновления не стоит поверх листа ввода").toBe(true);
  await expect(amountField(page)).toHaveValue("1234");
  expect(mainFrameNavigations).toBe(0);

  // «Не сохранять» закрывает лист — и плашка снова на виду.
  await page.keyboard.press("Escape");
  await leaveDialog(page).getByRole("button", { name: "Не сохранять" }).click();
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(updateButton).toBeVisible();
  await expect(page.locator("#update-blocked")).toBeHidden();

  await openYearPlan(page);
  await page.getByRole("button", { name: "Настроить план" }).click();
  await expect(page.getByRole("heading", { name: "Плановые расходы" })).toBeVisible();
  await page.getByRole("button", {
    name: "Изменить крупный платёж «Страхование автомобиля»",
  }).click();
  const planningName = page.locator("#commitment-name");
  await planningName.fill("Страхование — несохранённый черновик");
  await expect(planningName).toHaveValue("Страхование — несохранённый черновик");
  await expect(page.locator("#update-blocked")).toBeHidden();

  await updateButton.click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Несохранённый ввод останется в форме до сохранения или очистки.",
    }),
  ).toBeVisible();
  await expect(planningName).toHaveValue("Страхование — несохранённый черновик");
  expect(mainFrameNavigations).toBe(0);

  await page.getByRole("button", {
    name: "Отменить редактирование крупного платежа",
  }).click();
  await expect(planningName).toHaveValue("");
  await expect(page.locator("#update-blocked")).toBeHidden();

  const appliedNavigation = page.waitForEvent("load");
  await updateButton.click();
  await appliedNavigation;
  await page.waitForLoadState("domcontentloaded");

  await expect.poll(async () => {
    return page.evaluate(async () => {
      const response = await fetch("/build-meta.json", { cache: "no-store" });
      return (await response.json() as { buildId: string }).buildId;
    });
  }).toBe("phase8-e2e-b");
  // Обновление перезапускает приложение на том же адресе: план месяца, с которого его применили.
  await expect(page.getByRole("heading", { name: "Плановые расходы" })).toBeVisible();
  expect(mainFrameNavigations).toBe(1);

  await expectBudgetSnapshot(
    page,
    UPDATED_FLEXIBLE_REMAINING,
    G002_INITIAL_OPERATION_COUNT + 1,
  );
  await expectAddedExpense(page);
  expect([...externalRequests]).toEqual([]);
});

test("production manifest and navigation responses carry the release contract", async ({
  page,
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required.");
  const manifestResponse = await request.get(`${baseURL}/manifest.webmanifest`);
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json() as {
    display: string;
    start_url: string;
    scope: string;
    icons: { src: string; sizes: string; purpose?: string }[];
  };
  expect(manifest).toMatchObject({
    display: "standalone",
    start_url: "/",
    scope: "/",
  });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: "/icon-192.png", sizes: "192x192", purpose: "any" }),
    expect.objectContaining({ src: "/icon-512.png", sizes: "512x512", purpose: "any maskable" }),
  ]));
  for (const icon of manifest.icons) {
    const iconResponse = await request.get(`${baseURL}${icon.src}`);
    expect(iconResponse.ok()).toBe(true);
  }

  const navigation = await page.goto("/");
  expect(navigation?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(navigation?.headers()["x-frame-options"]).toBe("DENY");
});
