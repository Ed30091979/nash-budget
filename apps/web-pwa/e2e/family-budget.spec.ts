import { expect, test, type Page, type Response } from "@playwright/test";
import {
  G002_INITIAL_OPERATION_COUNT,
  makeG002BackupBuffer,
} from "./canonical-budget";

const INITIAL_FLEXIBLE_REMAINING = /27\s*000\s*₽/u;
const UPDATED_FLEXIBLE_REMAINING = /18\s*000\s*₽/u;
const PRODUCTS_OVER_LIMIT = /Продукты:\s*\+1\s*000\s*₽/u;

function expectNavigationSecurityHeaders(response: Response | null) {
  expect(response).not.toBeNull();
  expect(response?.headers()["content-security-policy"])
    .toContain("frame-ancestors 'none'");
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
}

async function expectBudgetSnapshot(
  page: Page,
  remaining: RegExp,
  operationCount: number,
) {
  await page.getByRole("button", { name: "Сегодня" }).click();
  await expect(
    page.getByText("Можно на повседневные расходы").locator("..").getByRole("strong"),
  ).toHaveText(remaining);

  await page.getByRole("button", { name: "Записать", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: `Показано ${operationCount} из ${operationCount}` }),
  ).toBeVisible();
}

async function expectAddedExpense(page: Page) {
  await expect(
    page
      .getByRole("region", { name: "Полная история" })
      .getByRole("listitem")
      .filter({ hasText: /Расход · 9\s*000\s*₽/u }),
  ).toContainText("2026-07-18");
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
  await expect(
    page.getByRole("button", { name: "Загрузить демонстрационный бюджет" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Загрузить демонстрационный бюджет" }).click();

  await page.getByRole("button", { name: "Ещё" }).click();
  await page.locator("#backup-file").setInputFiles({
    name: "family-budget-g002.json",
    mimeType: "application/json",
    buffer: makeG002BackupBuffer(),
  });
  await expect(page.getByRole("status").filter({ hasText: "Резервная копия восстановлена." }))
    .toBeVisible();
  await expectBudgetSnapshot(page, INITIAL_FLEXIBLE_REMAINING, G002_INITIAL_OPERATION_COUNT);

  await page.getByLabel("Дата").fill("2026-07-18");
  await page.getByLabel("Сумма, ₽").fill("9000");
  await page.getByLabel("Категория расходов").selectOption({ label: "Продукты" });
  await page.getByRole("button", { name: "Сохранить операцию «Расход»" }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: `Показано ${G002_INITIAL_OPERATION_COUNT + 1} из ${G002_INITIAL_OPERATION_COUNT + 1}`,
    }),
  ).toBeVisible();
  await expectAddedExpense(page);

  await page.getByRole("button", { name: "Сегодня" }).click();
  await expect(
    page.getByText("Можно на повседневные расходы").locator("..").getByRole("strong"),
  ).toHaveText(UPDATED_FLEXIBLE_REMAINING);
  await expect(page.getByRole("alert")).toContainText(PRODUCTS_OVER_LIMIT);

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
  await expect(page.getByRole("status", { name: "Состояние сети: офлайн" })).toBeVisible();
  await expectBudgetSnapshot(
    page,
    UPDATED_FLEXIBLE_REMAINING,
    G002_INITIAL_OPERATION_COUNT + 1,
  );
  await expectAddedExpense(page);

  const nestedResponse = await page.goto("/year");
  expect(nestedResponse?.fromServiceWorker()).toBe(true);
  expectNavigationSecurityHeaders(nestedResponse);
  await expect(page.getByRole("status", { name: "Состояние сети: офлайн" })).toBeVisible();
  await page.getByRole("button", { name: "Год", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Финансовый горизонт семьи" })).toBeVisible();
  await expect(
    page.getByText("Остаток повседневного лимита").locator("..").getByRole("strong"),
  ).toHaveText(UPDATED_FLEXIBLE_REMAINING);
  await page.getByRole("button", { name: "Записать", exact: true }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: `Показано ${G002_INITIAL_OPERATION_COUNT + 1} из ${G002_INITIAL_OPERATION_COUNT + 1}`,
    }),
  ).toBeVisible();
  await expectAddedExpense(page);

  await context.setOffline(false);
  await page.getByLabel("Сумма, ₽").fill("1234");

  const switchResponse = await request.post(`${baseURL}/__e2e__/switch-build`, {
    headers: { Origin: baseURL },
  });
  expect(switchResponse.ok()).toBe(true);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });

  const updateButton = page.getByRole("button", { name: "Обновить сейчас" });
  await expect(updateButton).toBeVisible();
  await expect(page.getByLabel("Сумма, ₽")).toHaveValue("1234");

  let mainFrameNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  });
  await updateButton.click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Несохранённый ввод останется в форме до сохранения или очистки.",
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Сумма, ₽")).toHaveValue("1234");
  expect(mainFrameNavigations).toBe(0);

  await page.getByRole("button", { name: "Очистить черновик" }).click();
  await expect(page.getByLabel("Сумма, ₽")).toHaveValue("");
  await expect(page.locator("#update-blocked")).toBeHidden();

  await page.getByRole("button", { name: "Год", exact: true }).click();
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

  const appliedNavigation = page.waitForEvent(
    "framenavigated",
    (frame) => frame === page.mainFrame(),
  );
  await updateButton.click();
  await appliedNavigation;
  await page.waitForLoadState("domcontentloaded");

  await expect.poll(async () => {
    return page.evaluate(async () => {
      const response = await fetch("/build-meta.json", { cache: "no-store" });
      return (await response.json() as { buildId: string }).buildId;
    });
  }).toBe("phase8-e2e-b");
  await expect(page.getByText("Можно на повседневные расходы")).toBeVisible();
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
