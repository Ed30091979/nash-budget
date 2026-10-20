/**
 * Фаза S7 в браузере: настоящее приложение, настоящий сервер семьи, настоящий отказ сети.
 *
 * Всё, что здесь проверяется, проверяется на стыке. Сервер — это `apps/sync-server`, поднятый
 * отдельным процессом на петле (`e2e/sync-server.mjs`); приложение — production-сборка со своей
 * политикой безопасности и своим service worker; код входа берётся оттуда же, откуда его взял бы
 * человек. Ни одной подмены между ними нет, потому что подменённый стык — это ровно то, что обе
 * половины уже проверяют у себя.
 *
 * Канонические величины G-002, которые сверяются буквально:
 * «Можно тратить» `27 000 ₽`, июльский резерв `19 809 ₽` и свободно `44 191 ₽`,
 * дно горизонта `13 191 ₽` в сентябре 2026.
 */
import type { APIRequestContext, BrowserContext, Locator, Page, Route } from "@playwright/test";
import { installE2EClock } from "./clock";
import { expect, test, watchDialogs } from "./fixtures";

import {
  G002_INITIAL_OPERATION_COUNT,
  makeG002BackupBuffer,
} from "./canonical-budget";
import { helloShot } from "./hello-shot";
import { entrySheet, recordExpense as recordOnSheet, reachAmount, showWholeHistory, startDemo } from "./sheet";

const FLEXIBLE_REMAINING = /27\s*000\s*₽/u;
const FLEXIBLE_AFTER_TRANSPORT = /23\s*000\s*₽/u;
const FLEXIBLE_AFTER_PRODUCTS = /25\s*500\s*₽/u;
const JULY_RESERVE = /19\s*809\s*₽/u;
const JULY_FREE = /44\s*191\s*₽/u;
const TIGHTEST_MONTH_FREE = /13\s*191\s*₽/u;
/** Тревоги главного потока, которые обязаны молчать при недоступном сервере. */
const SYNC_TROUBLE = /сервер|синхрониз|не удалось|ошибк/iu;

/* ───────────────────────────── Управление прогоном ───────────────────────────── */

async function loginCodeFor(
  request: APIRequestContext,
  baseURL: string,
  email: string,
): Promise<string | null> {
  const response = await request.post(
    `${baseURL}/__e2e__/sync/login-code?email=${encodeURIComponent(email)}`,
    { headers: { Origin: baseURL } },
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { code: string | null }).code;
}

async function setSyncServer(
  request: APIRequestContext,
  baseURL: string,
  action: "stop" | "start",
): Promise<boolean> {
  const response = await request.post(`${baseURL}/__e2e__/sync/${action}`, {
    headers: { Origin: baseURL },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { running: boolean }).running;
}

/* ───────────────────────────── Экраны и величины ───────────────────────────── */

/** Итог «Можно тратить»: остаток лимитов месяца плана — идёт этот месяц сейчас или уже закрыт. */
function flexibleRemaining(page: Page): Locator {
  return reachAmount(page);
}

async function restoreCanonicalBudget(page: Page): Promise<void> {
  await page.goto("/");
  await startDemo(page);
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.locator("#backup-file").setInputFiles({
    name: "family-budget-g002.json",
    mimeType: "application/json",
    buffer: makeG002BackupBuffer(),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "Резервная копия восстановлена." }),
  ).toBeVisible();
}

/** Июль G-002 в таблице «Месяцы по числам»: резерв и свободный остаток в одной строке. */
async function expectJulyRow(page: Page): Promise<void> {
  await openYearPlan(page);
  // Заголовок плана на год — вывод; дно горизонта стоит в лестнице месяцев и выделено весом.
  await expect(page.getByRole("heading", { name: /Плана хватает во все 12 месяцев/u })).toBeVisible();
  await expect(page.locator(".ladder-row.tight .ladder-value").first()).toHaveText(TIGHTEST_MONTH_FREE);
  const numbers = page.getByRole("group", { name: "Месяцы по числам" }).or(
    page.locator("details").filter({ hasText: "Месяцы по числам" }),
  );
  await numbers.first().locator("summary").click();
  const july = page.getByRole("row").filter({ hasText: "июл 2026" });
  await expect(july).toHaveCount(1);
  await expect(july).toContainText(JULY_RESERVE);
  await expect(july).toContainText(JULY_FREE);
}

async function expectOperationCount(page: Page, count: number): Promise<void> {
  await openHistory(page);
  await expect(
    page.getByRole("status").filter({ hasText: `Показано ${count} из ${count}` }),
  ).toBeVisible();
}

/** История операций — вкладка «Операции» нижней навигации, за весь период: G-002 — июль 2026. */
async function openHistory(page: Page): Promise<void> {
  const history = page.getByRole("region", { name: "Операции" });
  if (!(await history.count())) {
    await page.getByRole("button", { name: "Операции", exact: true }).click();
    await expect(history).toBeVisible();
  }
  await showWholeHistory(page);
}

/** План на год — подэкран «Ещё»: отдельной вкладки «Год» в навигации из пяти мест нет. */
async function openYearPlan(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.getByRole("button", { name: /^План на год/u }).click();
}

/**
 * Покупка с плитки «Обзора»: категория — лист, дата — «Другой день», сумма — и кнопка записи.
 * Записано — когда тост это сказал, а не когда кнопку нажали: следующий шаг теста не должен застать
 * запись в полёте.
 */
async function recordExpense(
  page: Page,
  options: { readonly date: string; readonly amount: string; readonly category: string },
): Promise<void> {
  await recordOnSheet(page, options);
}

/** Тревоги главного потока — без тех, что бюджет ставит сам (перерасход категории). */
async function mainFlowTroubles(page: Page): Promise<string[]> {
  const texts = await page.getByRole("alert").allInnerTexts();
  return texts.filter((text) => SYNC_TROUBLE.test(text));
}

/* ───────────────────────────── Семья на настоящем сервере ───────────────────────────── */

async function openFamilyScreen(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.getByRole("button", { name: /Семья и синхронизация/u }).click();
}

/**
 * Ждёт, пока на экране появится `expected`, — а если раньше него появится тревога семьи, падает с
 * её текстом: «вход не удался» из `role=alert` вместо безымянного таймаута ожидания.
 */
async function expectOrAlert(page: Page, expected: Locator, step: string): Promise<void> {
  const alert = page.locator(".family-error[role=alert]");
  await expect(expected.or(alert).first()).toBeVisible({ timeout: 20_000 });
  if (await alert.count()) throw new Error(`${step}: ${(await alert.first().innerText()).trim()}`);
}

async function signIn(page: Page, baseURL: string, email: string): Promise<void> {
  await openFamilyScreen(page);
  await expect(page.getByRole("heading", { name: "Вход по адресу почты" })).toBeVisible();
  await page.getByLabel("Адрес почты").fill(email);
  await page.getByRole("button", { name: "Выслать код" }).click();
  await expectOrAlert(page, page.getByLabel("Код из письма"), "Код не выслан");

  // Код приходит из вывода сервера — того самого, который в проде уходил бы письмом.
  await expect
    .poll(async () => loginCodeFor(page.request, baseURL, email), { timeout: 15_000 })
    .not.toBeNull();
  const code = await loginCodeFor(page.request, baseURL, email);
  expect(code).toMatch(/^\d{6}$/u);
  await page.getByLabel("Код из письма").fill(code!);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  // Вошли — значит, экран предлагает создать семью или вступить в неё.
  await expectOrAlert(page, page.getByRole("heading", { name: /^(Создать семью|Вступить по коду)$/u }).first(), "Вход не удался");
}

// Сервер семьи — общий для всех тестов файла. Тест, упавший с выключенным сервером, не должен
// уронить следующие: после каждого он поднимается снова (no-op, если уже работает).
test.afterEach(async ({ request, baseURL }) => {
  if (!baseURL) return;
  expect(await setSyncServer(request, baseURL, "start")).toBe(true);
});

/** Индикатор шапки раздела «Ещё»: единственное место, где состояние синхронизации видно в потоке. */
function syncIndicator(page: Page): Locator {
  return page.locator('[aria-label^="Состояние синхронизации:"]').first();
}

async function expectSyncIndicator(page: Page, expected: RegExp): Promise<void> {
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await expect(syncIndicator(page)).toHaveAttribute("aria-label", expected, { timeout: 30_000 });
}

test("канонический бюджет переживает круг через настоящий сервер семьи", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required.");
  const syncOrigin = await page.request
    .get(`${baseURL}/__e2e__/health`)
    .then(async (response) => ((await response.json()) as { syncServerUrl: string }).syncServerUrl);
  expect(syncOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

  await restoreCanonicalBudget(page);
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(flexibleRemaining(page)).toHaveText(FLEXIBLE_REMAINING);
  await expectJulyRow(page);
  await expectOperationCount(page, G002_INITIAL_OPERATION_COUNT);

  await signIn(page, baseURL, "anna@example.org");
  await expect(page.getByRole("heading", { name: "Создать семью" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Создать семью", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Участники" })).toBeVisible({ timeout: 20_000 });

  // Весь бюджет уходит в журнал первой же записью и очередь расходится: «синхронизировано»
  // ставится не по факту входа, а по пустой очереди и отвеченному кругу.
  await expectSyncIndicator(page, /синхронизировано$/u);

  // Ни одна копейка от этого не сдвинулась: журнал — это транспорт, а не пересчёт.
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(flexibleRemaining(page)).toHaveText(FLEXIBLE_REMAINING);
  await expectJulyRow(page);
  await expectOperationCount(page, G002_INITIAL_OPERATION_COUNT);

  // Операция живой проверки: 4 000 ₽ по «Транспорту» от 9 июля 2026. Потрачено на гибкие
  // категории становится 30 000 ₽ из 53 000 ₽ — остаётся 23 000 ₽.
  await recordExpense(page, { date: "2026-07-09", amount: "4000", category: "Транспорт" });
  await expectOperationCount(page, G002_INITIAL_OPERATION_COUNT + 1);
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(flexibleRemaining(page)).toHaveText(FLEXIBLE_AFTER_TRANSPORT);
  await expectSyncIndicator(page, /синхронизировано$/u);

  // Устройство перезапускается: сессия, ключ, курсор и очередь лежат в IndexedDB и переживают
  // это. Ни повторного входа, ни повторного применения журнала: операций по-прежнему пять.
  await page.reload();
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(flexibleRemaining(page)).toHaveText(FLEXIBLE_AFTER_TRANSPORT);
  await expectOperationCount(page, G002_INITIAL_OPERATION_COUNT + 1);
  await expectJulyRow(page);
  await expectSyncIndicator(page, /синхронизировано$/u);
  expect(await mainFlowTroubles(page)).toEqual([]);
});

test("при недоступном сервере приложение остаётся полностью рабочим", async ({
  page,
  baseURL,
  request,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required.");

  await restoreCanonicalBudget(page);
  await signIn(page, baseURL, "boris@example.org");
  await expect(page.getByRole("heading", { name: "Создать семью" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Создать семью", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Участники" })).toBeVisible({ timeout: 20_000 });
  await expectSyncIndicator(page, /синхронизировано$/u);

  // Сервер выключен целиком, а не «отвечает ошибкой»: браузер получает отказ соединения.
  expect(await setSyncServer(request, baseURL, "stop")).toBe(false);
  await page.reload();

  // Чтение: все три экрана главного потока показывают канонические величины.
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(flexibleRemaining(page)).toHaveText(FLEXIBLE_REMAINING);
  await expectJulyRow(page);
  await expectOperationCount(page, G002_INITIAL_OPERATION_COUNT);

  // Запись: операция ложится сразу и сразу видна. По «Продуктам» становится 22 000 + 1 500,
  // потрачено на гибкие категории 27 500 ₽ из 53 000 ₽ — остаётся 25 500 ₽.
  await recordExpense(page, { date: "2026-07-10", amount: "1500", category: "Продукты" });
  await expectOperationCount(page, G002_INITIAL_OPERATION_COUNT + 1);
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(flexibleRemaining(page)).toHaveText(FLEXIBLE_AFTER_PRODUCTS);

  // Переключение экранов: горизонт по-прежнему считается и рисуется; лист «+» открывается и
  // закрывается без набранного.
  await expectJulyRow(page);
  await page.getByRole("button", { name: "Записать", exact: true }).click();
  await expect(entrySheet(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(entrySheet(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(flexibleRemaining(page)).toHaveText(FLEXIBLE_AFTER_PRODUCTS);

  // Ни одной тревоги про сервер в главном потоке — и честный, не зелёный, индикатор.
  expect(await mainFlowTroubles(page)).toEqual([]);
  await expectSyncIndicator(page, /ожидает сети — сервер недоступен$/u);

  // Перезапуск приложения при лежащем сервере: всё то же самое и ничего не потеряно.
  await page.reload();
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(flexibleRemaining(page)).toHaveText(FLEXIBLE_AFTER_PRODUCTS);
  await expectOperationCount(page, G002_INITIAL_OPERATION_COUNT + 1);
  expect(await mainFlowTroubles(page)).toEqual([]);

  // Сеть вернулась — очередь уходит сама, без единого действия человека.
  expect(await setSyncServer(request, baseURL, "start")).toBe(true);
  await page.reload();
  await expectSyncIndicator(page, /синхронизировано$/u);
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(flexibleRemaining(page)).toHaveText(FLEXIBLE_AFTER_PRODUCTS);
  await expectOperationCount(page, G002_INITIAL_OPERATION_COUNT + 1);
});

/**
 * Двухклиентский сценарий приёмки: приглашение, вступление, запись офлайн с двух устройств и
 * схождение до копейки.
 *
 * Прежде он был помечен `test.fail()`: политика сборки не разрешала `'wasm-unsafe-eval'`, а
 * приглашение разворачивается через Argon2id (`hash-wasm`, WebAssembly). Политика исправлена,
 * пометка снята, и тест обязан проходить. Оба браузерных контекста созданы тестом сам, поэтому
 * системные окна в них ловятся явно (`watchDialogs`), как и в странице по умолчанию.
 */
test("два клиента одной семьи сходятся до копейки", async ({ browser, baseURL, nativeDialogs, today }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required.");

  const annaContext = await browser.newContext();
  const borisContext = await browser.newContext();
  watchDialogs(annaContext, nativeDialogs);
  watchDialogs(borisContext, nativeDialogs);
  // Свои контексты — свои часы, но день тот же, что у всего прогона (`e2e/clock.ts`).
  await installE2EClock(annaContext, today);
  await installE2EClock(borisContext, today);
  try {
    let anna = await annaContext.newPage();
    let boris = await borisContext.newPage();

    await restoreCanonicalBudget(anna);
    await signIn(anna, baseURL, "anna-two@example.org");
    await expect(anna.getByRole("heading", { name: "Создать семью" })).toBeVisible({
      timeout: 20_000,
    });
    await anna.getByRole("button", { name: "Создать семью", exact: true }).click();
    await expect(anna.getByRole("heading", { name: "Участники" })).toBeVisible({ timeout: 20_000 });
    await expectSyncIndicator(anna, /синхронизировано$/u);

    // Владелец выпускает код приглашения.
    await openFamilyScreen(anna);
    await anna.getByRole("button", { name: /Выпустить код/u }).click();
    const invite = anna.locator(".invite-code code");
    await expect(invite).toBeVisible({ timeout: 10_000 });
    const code = (await invite.innerText()).replace(/-/gu, "");
    expect(code).toHaveLength(12);

    // Второе устройство вступает по коду и получает журнал семьи целиком.
    await boris.goto("/");
    await startDemo(boris);
    await signIn(boris, baseURL, "boris-two@example.org");
    await expect(boris.getByRole("heading", { name: "Вступить по коду" })).toBeVisible({
      timeout: 20_000,
    });
    await boris.getByLabel("Код приглашения").fill(code);
    await boris.getByRole("button", { name: "Вступить", exact: true }).click();
    await boris.getByRole("button", { name: /Вступить/u }).last().click();
    await expect(boris.getByRole("heading", { name: "Участники" })).toBeVisible({ timeout: 30_000 });
    // Журнал семьи пришёл и лёг в документ: до того на месте бюджета стоит экран «Бюджет семьи ещё
    // не пришёл», а записи недоступны (демонстрационный бюджет Бориса — не бюджет семьи, хоть и
    // показывает те же числа). Шапка со знаком «синхронизировано» есть только у документа семьи.
    await expect(syncIndicator(boris)).toHaveAttribute("aria-label", /синхронизировано$/u, { timeout: 45_000 });
    await boris.getByRole("button", { name: "Обзор", exact: true }).click();
    await expect(flexibleRemaining(boris)).toHaveText(FLEXIBLE_REMAINING);

    // Оба уходят офлайн и оба пишут в одну и ту же категорию.
    await annaContext.setOffline(true);
    await borisContext.setOffline(true);
    await recordExpense(anna, { date: "2026-07-09", amount: "4000", category: "Продукты" });
    await recordExpense(boris, { date: "2026-07-10", amount: "1500", category: "Продукты" });

    // Оба закрывают приложение ещё офлайн и открывают его, когда сеть вернулась: обе записи
    // встречаются в журнале, и обе стороны показывают одно число. Не перезагрузка поверх живой
    // страницы: страница, застигнутая возвращением сети, своим кругом опроса успевала забрать
    // чужую запись до перезагрузки, и новость пропадала по правилу §6 — «прошлый раз» после
    // открытия есть бюджет, прочитанный с диска, а запись в нём уже лежала. Человек её при этом не
    // видел, а тест падал при сошедшихся числах.
    await anna.close();
    await boris.close();
    await annaContext.setOffline(false);
    await borisContext.setOffline(false);
    anna = await annaContext.newPage();
    boris = await borisContext.newPage();
    await anna.goto("/");
    await boris.goto("/");
    await anna.getByRole("button", { name: "Обзор", exact: true }).click();
    await boris.getByRole("button", { name: "Обзор", exact: true }).click();

    // §6 «Семейная новость» — единственный заслуженный момент на входе: первое открытие после
    // того, как второй участник что-то записал. У Анны — покупка Бориса, у Бориса — покупка
    // Анны, и каждый видит только чужое; своя запись новостью не является.
    await expect(anna.locator(".family-news")).toContainText(/1\s*500\s*₽/u, { timeout: 45_000 });
    await expect(anna.locator(".family-news")).not.toContainText(/4\s*000\s*₽/u);
    await expect(anna.locator(".family-news")).toContainText(/Boris two: 1 покупка/u);
    await expect(boris.locator(".family-news")).toContainText(/4\s*000\s*₽/u, { timeout: 45_000 });
    await expect(boris.locator(".family-news")).not.toContainText(/1\s*500\s*₽/u);
    await helloShot(anna, "family-news");
    // Увидена — человек ушёл с «Обзора» — и за тем же не возвращается: ни на этот экран, ни
    // после перезапуска, когда «прошлый раз» читается с диска.
    await openYearPlan(anna);
    await anna.getByRole("button", { name: "Обзор", exact: true }).click();
    await expect(anna.locator(".family-news")).toHaveCount(0);
    await anna.reload();
    await expect(flexibleRemaining(anna)).toHaveText(/21\s*500\s*₽/u);
    await expect(anna.locator(".family-news")).toHaveCount(0);

    await expectSyncIndicator(anna, /синхронизировано$/u);
    await expectSyncIndicator(boris, /синхронизировано$/u);
    await anna.reload();
    await boris.reload();

    // 53 000 − (22 000 «Продукты» + 4 000 «Транспорт» + 4 000 и 1 500 от двух устройств)
    // = 21 500 ₽ у обоих, до копейки.
    for (const client of [anna, boris]) {
      await client.getByRole("button", { name: "Обзор", exact: true }).click();
      await expect(flexibleRemaining(client)).toHaveText(/21\s*500\s*₽/u);
      await expectOperationCount(client, G002_INITIAL_OPERATION_COUNT + 2);
      await expectJulyRow(client);
    }
  } finally {
    await annaContext.close();
    await borisContext.close();
  }
});

/* ───────────────────────────── Приём, который не дошёл до экрана ───────────────────────────── */

/** Создать семью на первом устройстве и вступить в неё вторым — тот же путь, что выше. */
async function formFamily(
  anna: Page,
  boris: Page,
  baseURL: string,
  emails: { readonly anna: string; readonly boris: string },
): Promise<void> {
  await restoreCanonicalBudget(anna);
  await signIn(anna, baseURL, emails.anna);
  await expect(anna.getByRole("heading", { name: "Создать семью" })).toBeVisible({ timeout: 20_000 });
  await anna.getByRole("button", { name: "Создать семью", exact: true }).click();
  await expect(anna.getByRole("heading", { name: "Участники" })).toBeVisible({ timeout: 20_000 });
  await expectSyncIndicator(anna, /синхронизировано$/u);

  await openFamilyScreen(anna);
  await anna.getByRole("button", { name: /Выпустить код/u }).click();
  const invite = anna.locator(".invite-code code");
  await expect(invite).toBeVisible({ timeout: 10_000 });
  const code = (await invite.innerText()).replace(/-/gu, "");
  expect(code).toHaveLength(12);

  await boris.goto("/");
  await startDemo(boris);
  await signIn(boris, baseURL, emails.boris);
  await expect(boris.getByRole("heading", { name: "Вступить по коду" })).toBeVisible({ timeout: 20_000 });
  await boris.getByLabel("Код приглашения").fill(code);
  await boris.getByRole("button", { name: "Вступить", exact: true }).click();
  await boris.getByRole("button", { name: /Вступить/u }).last().click();
  await expect(boris.getByRole("heading", { name: "Участники" })).toBeVisible({ timeout: 30_000 });
  await expect(syncIndicator(boris)).toHaveAttribute("aria-label", /синхронизировано$/u, { timeout: 45_000 });
  await boris.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(flexibleRemaining(boris)).toHaveText(FLEXIBLE_REMAINING);
}

/** Что было с первой выборкой после открытия: какие `seq` она принесла и сколько выборок нового круга оборвано, пока она ждала. */
interface InterruptedDelivery {
  readonly delivered: readonly number[];
  readonly dropped: number;
}

/**
 * Первая выборка конвертов после открытия приложения придержана, пока круг, который её начал, не
 * снят.
 *
 * Снимает его то, что снимает его в жизни: на старте приходит список устройств семьи, и цикл опроса
 * начинается заново. Список устройств придерживается, пока первая выборка не ушла, и отпускается
 * сразу после неё, — так круг с приёмом в руках оказывается снятым всегда, а не тогда, когда сеть
 * так легла. Выборка нового круга, пока первая придержана, обрывается — обычный сбой сети: иначе
 * новый круг сам принёс бы тот же конверт и показал его, и прогон ничего бы не проверил. Первая
 * выборка уходит на сервер, когда новый круг уже начался (или через две секунды, если его нет), и
 * отдаёт приложению ответ сервера как есть — её конверт ложится в документ кругом, которого больше
 * нет.
 */
function holdFirstDeliveryUntilRestart(context: BrowserContext, syncOrigin: string): Promise<InterruptedDelivery> {
  const origin = syncOrigin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const envelopes = new RegExp(`^${origin}/v1/families/[^/]+/envelopes\\?`, "u");
  const devices = new RegExp(`^${origin}/v1/families/[^/]+/devices$`, "u");
  let first: Route | null = null;
  let firstReleased = false;
  let devicesReleased = false;
  let dropped = 0;
  const heldDevices: Route[] = [];
  let finish!: (delivery: InterruptedDelivery) => void;
  let fail!: (reason: unknown) => void;
  const done = new Promise<InterruptedDelivery>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const releaseFirst = () => {
    const route = first;
    if (route === null || firstReleased) return;
    firstReleased = true;
    void (async () => {
      const response = await route.fetch();
      const body = (await response.json()) as { readonly envelopes: readonly { readonly seq: number }[] };
      await route.fulfill({ response });
      finish({ delivered: body.envelopes.map((envelope) => envelope.seq), dropped });
    })().catch(fail);
  };
  void context.route(devices, async (route) => {
    if (devicesReleased) await route.continue();
    else heldDevices.push(route);
  });
  void context.route(envelopes, async (route) => {
    if (route.request().method() !== "GET" || firstReleased) {
      await route.continue();
      return;
    }
    if (first === null) {
      first = route;
      devicesReleased = true;
      for (const held of heldDevices.splice(0)) await held.continue();
      setTimeout(releaseFirst, 2_000);
      return;
    }
    dropped += 1;
    await route.abort("connectionreset");
    releaseFirst();
  });
  return done;
}

/**
 * Конверт, применённый кругом, который успели снять, всё равно доходит до экрана.
 *
 * Прежде экран узнавал о чужой операции только от того круга, который её применил, и только если
 * этот круг доживал до конца. На старте цикл опроса начинается заново, как только приходит список
 * устройств, — и круг, уже применивший конверт, уходил молча. Документ и курсор на диске были
 * правильными, следующий круг ничего нового не находил, и экран до перезапуска показывал бюджет
 * без чужой покупки — со «синхронизировано» в шапке и без семейной новости (прогон проверки 2b).
 */
test("приём, применённый снятым кругом, доходит до экрана", async ({ browser, baseURL, nativeDialogs, today }) => {
  if (!baseURL) throw new Error("Playwright baseURL is required.");
  const annaContext = await browser.newContext();
  const borisContext = await browser.newContext();
  watchDialogs(annaContext, nativeDialogs);
  watchDialogs(borisContext, nativeDialogs);
  // Свои контексты — свои часы, но день тот же, что у всего прогона (`e2e/clock.ts`).
  await installE2EClock(annaContext, today);
  await installE2EClock(borisContext, today);
  try {
    const anna = await annaContext.newPage();
    const firstBoris = await borisContext.newPage();
    const syncOrigin = await anna.request
      .get(`${baseURL}/__e2e__/health`)
      .then(async (response) => ((await response.json()) as { syncServerUrl: string }).syncServerUrl);
    await formFamily(anna, firstBoris, baseURL, { anna: "anna-three@example.org", boris: "boris-three@example.org" });

    // Борис закрыл приложение. Анна записывает, и запись принята сервером — у неё есть свой `seq`.
    await firstBoris.close();
    const accepted = anna.waitForResponse(
      (response) => response.request().method() === "POST" && /\/v1\/families\/[^/]+\/envelopes$/u.test(response.url()) && response.ok(),
    );
    await recordExpense(anna, { date: "2026-07-09", amount: "4000", category: "Продукты" });
    const purchase = ((await (await accepted).json()) as { readonly accepted: readonly { readonly seq: number }[] }).accepted;
    expect(purchase).toHaveLength(1);

    // Борис открывает приложение — и первый круг, который принесёт покупку Анны, снимается.
    const interrupted = holdFirstDeliveryUntilRestart(borisContext, syncOrigin);
    const boris = await borisContext.newPage();
    await boris.goto("/");
    const delivery = await interrupted;
    // Покупку Анны принесла именно придержанная выборка, и, пока она ждала, цикл опроса начался
    // заново — круг, сложивший покупку в документ, был снят.
    expect(delivery.delivered).toContain(purchase[0]!.seq);
    expect(delivery.dropped).toBeGreaterThan(0);

    // На экране — то, что лежит в документе: покупка Анны, новость о ней и остаток после неё.
    await boris.getByRole("button", { name: "Обзор", exact: true }).click();
    await expect(boris.locator(".family-news")).toContainText(/4\s*000\s*₽/u);
    await expect(flexibleRemaining(boris)).toHaveText(/23\s*000\s*₽/u);
    await expectOperationCount(boris, G002_INITIAL_OPERATION_COUNT + 1);
  } finally {
    await annaContext.close();
    await borisContext.close();
  }
});
