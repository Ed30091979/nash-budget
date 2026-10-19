/**
 * §6 Клавиатура суммы: пока набирается сумма, табло конвертов остаётся видимым.
 *
 * Дефект, который она чинит: системная клавиатура закрывала табло ровно в тот момент, ради
 * которого табло существует, — человек набирал сумму и не видел, что она делает с его конвертами.
 * Здесь это измерено, а не отмечено галочкой: на четырёх ширинах телефона при обычном шрифте
 * после набора с клавиш хотя бы один конверт с предпросмотром можно видеть целиком — свободным
 * от шапки, полосы записи с клавиатурой и навигации.
 *
 * Вторая половина — то, чего проще всего лишиться, спрятав системную клавиатуру: физическая
 * клавиатура, каретка, вставка из буфера и имена для читающего с экрана. Всё проверяется
 * исполнением в браузере, а не по документации.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

import { applyFontScale } from "./font-scale";

interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

const PHONE_VIEWPORTS: readonly Viewport[] = [
  { name: "phone-320", width: 320, height: 568 },
  { name: "phone-375", width: 375, height: 667 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "phone-430", width: 430, height: 932 },
];

async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Загрузить демонстрационный бюджет" }).click();
  await expect(page.locator(".hero-card")).toBeVisible();
}

async function goToRoute(page: Page, navigationName: string): Promise<void> {
  const tab = page.getByRole("button", { name: navigationName, exact: true });
  if ((await tab.getAttribute("aria-current")) === "page") return;
  await tab.click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
}

const key = (page: Page, name: string) => page.getByRole("group", { name: "Клавиатура суммы" }).getByRole("button", { name, exact: true });

async function typeOnKeypad(page: Page, keys: readonly string[]): Promise<void> {
  for (const name of keys) await key(page, name).click();
}

interface BoardVisibility {
  /** Конверты, которые можно домотать так, чтобы конверт целиком был свободен от оправы. */
  readonly whole: number;
  /** Конверты целиком на экране без прокрутки — сразу после набора. */
  readonly atRest: number;
  readonly envelopes: number;
  readonly barHeight: number;
  readonly keypadHeight: number;
  readonly previewed: number;
}

async function measureBoard(page: Page): Promise<BoardVisibility> {
  return page.evaluate(() => {
    const rectOf = (element: Element) => element.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>(".app-header");
    const bar = document.querySelector<HTMLElement>(".record-action");
    const nav = document.querySelector<HTMLElement>(".bottom-nav");
    const keypad = document.querySelector<HTMLElement>(".keypad");
    if (!header || !bar || !nav) throw new Error("Оправа экрана записи не найдена.");
    const envelopes = [...document.querySelectorAll<HTMLElement>(".envelope")];
    const scrollTo = (top: number) => window.scrollTo({ top, behavior: "instant" });
    // Свободная полоса экрана: под шапкой, над полосой записи и навигацией — теми, что на экране.
    const band = () => {
      let top = 0;
      let bottom = innerHeight;
      const headerRect = rectOf(header);
      if (getComputedStyle(header).position !== "static" && headerRect.bottom > 0) top = Math.max(top, headerRect.bottom);
      for (const chrome of [bar, nav]) {
        const rect = rectOf(chrome);
        if (rect.top < innerHeight && rect.bottom > 0) bottom = Math.min(bottom, rect.top);
      }
      return { top, bottom };
    };
    const whole = (element: HTMLElement) => {
      const rect = rectOf(element);
      const { top, bottom } = band();
      return rect.top >= top - 0.5 && rect.bottom <= bottom + 0.5;
    };
    scrollTo(0);
    const atRest = envelopes.filter(whole).length;
    let reachable = 0;
    for (const envelope of envelopes) {
      envelope.scrollIntoView({ block: "center", behavior: "instant" });
      let visible = whole(envelope);
      if (!visible) {
        window.scrollBy({ top: rectOf(envelope).top - band().top - 4, behavior: "instant" });
        visible = whole(envelope);
      }
      if (visible) reachable += 1;
    }
    scrollTo(0);
    return {
      whole: reachable,
      atRest,
      envelopes: envelopes.length,
      barHeight: Math.round(rectOf(bar).height),
      keypadHeight: keypad ? Math.round(rectOf(keypad).height) : 0,
      previewed: envelopes.filter((envelope) => (envelope.getAttribute("aria-label") ?? "").includes("останется")).length,
    };
  });
}

test("клавиатура внутри экрана: набор суммы не закрывает табло конвертов", async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page);
  const amount = page.getByRole("textbox", { name: "Сумма, ₽" });

  for (const viewport of PHONE_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await goToRoute(page, "Записать");
    // Поле — настоящее поле: не `readonly`, с именем, и просит не поднимать системную клавиатуру.
    await expect(amount).toHaveAttribute("inputmode", "none");
    await expect(amount).not.toHaveAttribute("readonly");
    await expect(page.getByRole("group", { name: "Клавиатура суммы" })).toBeVisible();

    await typeOnKeypad(page, ["1", "2", "0", "0"]);
    await expect(amount).toHaveValue("1200");
    const board = await measureBoard(page);
    expect(board.previewed, `${viewport.name}: сумма с клавиш дошла до конвертов`).toBe(board.envelopes);
    expect(board.whole, `${viewport.name}: хотя бы один конверт с предпросмотром виден целиком при набранной сумме (полоса ${board.barHeight} pt, клавиатура ${board.keypadHeight} pt)`).toBeGreaterThanOrEqual(1);
    // Полоса с клавиатурой не выросла от набора: «Очистить черновик» стоит у заголовка.
    await expect(page.getByRole("button", { name: "Очистить черновик" })).toBeVisible();
    expect(await page.locator(".record-action").getByRole("button", { name: "Очистить черновик" }).count()).toBe(0);
    test.info().annotations.push({ type: `board ${viewport.name}`, description: JSON.stringify(board) });

    await page.getByRole("button", { name: "Очистить черновик" }).click();
    await expect(amount).toHaveValue("");
  }
});

test("семь касаний от вкладки до записанной покупки — и ни одного по системной клавиатуре", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // 1 — вкладка; 2–5 — цифры; 6 — конверт; 7 — кнопка записи.
  await page.getByRole("button", { name: "Записать", exact: true }).click();
  await typeOnKeypad(page, ["1", "2", "0", "0"]);
  await page.getByRole("button", { name: /^Продукты: останется/u }).click();
  await page.getByRole("button", { name: /^Записать 1\s200\s₽ в «Продукты»$/u }).click();
  await expect(page.getByRole("status").filter({ hasText: /Записано: расход 1\s200\s₽/u })).toBeVisible();
});

test("арифметика: два чека складываются, итог назван до записи, а записывается число", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await goToRoute(page, "Записать");
  const amount = page.getByRole("textbox", { name: "Сумма, ₽" });

  await typeOnKeypad(page, ["1", "2", "0", "0", "Плюс", "3", "5", "0"]);
  await expect(amount).toHaveValue("1200+350");
  await expect(page.locator(".amount-total")).toHaveText(/=\s*1\s*550\s*₽/u);
  // Читающему с экрана итог нажатий произносится отдельно: поле не в фокусе.
  await expect(page.locator(".record-action [role='status']")).toHaveText(/1200\+350, итого 1\s550\s₽/u);
  await page.getByRole("button", { name: /^Продукты: останется/u }).click();
  await page.getByRole("button", { name: /^Записать 1\s550\s₽ в «Продукты»$/u }).click();
  await expect(page.getByRole("status").filter({ hasText: /Записано: расход 1\s550\s₽/u })).toBeVisible();

  // Счёт пополам — и знак после знака заменяет его, а не встаёт вторым.
  await typeOnKeypad(page, ["3", "0", "0", "0", "Плюс", "Разделить", "2"]);
  await expect(amount).toHaveValue("3000÷2");
  await expect(page.locator(".amount-total")).toHaveText(/=\s*1\s*500\s*₽/u);
  await page.getByRole("button", { name: "Очистить черновик" }).click();
});

test("физическая клавиатура, каретка и буфер работают вместе с клавишами", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await goToRoute(page, "Записать");
  const amount = page.getByRole("textbox", { name: "Сумма, ₽" });

  // Физическая клавиатура набирает как обычно — цифры и знаки, включая дефис и косую черту.
  await amount.click();
  await expect(amount).toBeFocused();
  await page.keyboard.type("1500-300");
  await expect(amount).toHaveValue("1500-300");
  await expect(page.locator(".amount-total")).toHaveText(/=\s*1\s*200\s*₽/u);
  // Клавиша не уводит фокус из поля и правит по каретке: цифра встаёт туда, где каретка.
  await page.evaluate(() => {
    const input = document.getElementById("operation-amount") as HTMLInputElement;
    input.setSelectionRange(1, 1);
  });
  await key(page, "9").click();
  await expect(amount).toHaveValue("19500-300");
  await expect(amount).toBeFocused();
  expect(await amount.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(2);
  // Стирание — тоже по каретке: уходит «9», а не последний символ, и каретка остаётся на месте.
  await key(page, "Стереть").click();
  await expect(amount).toHaveValue("1500-300");
  expect(await amount.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(1);
  // Каретка в конец касанием правого края поля: клавиша End на macOS каретку не двигает.
  const box = await amount.boundingBox();
  if (!box) throw new Error("Поле суммы без размеров.");
  await amount.click({ position: { x: box.width - 12, y: box.height / 2 } });
  await page.keyboard.type("/2");
  await expect(amount).toHaveValue("1500-300/2");
  await expect(page.locator(".amount-total")).toHaveText(/=\s*600\s*₽/u);

  // Вставка из буфера: «1 234,56» из банковской СМС — с пробелом и запятой.
  await page.evaluate(() => navigator.clipboard.writeText("1 234,56"));
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("ControlOrMeta+V");
  await expect(amount).toHaveValue("1 234,56");
  await page.getByRole("button", { name: /^Продукты: останется/u }).click();
  await expect(page.getByRole("button", { name: /^Записать 1\s234,56\s₽ в «Продукты»$/u })).toBeVisible();
  await page.getByRole("button", { name: "Очистить черновик" }).click();
  await expect(amount).toHaveValue("");
});

test("при крупном шрифте и на коротком экране клавиатуры нет, и поле зовёт системную", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  const amount = page.getByRole("textbox", { name: "Сумма, ₽" });
  const keypad = page.getByRole("group", { name: "Клавиатура суммы" });

  // ×2.7: четыре ряда клавиш, кнопка записи и навигация выше любого телефона — клавиатуры нет,
  // и системная хотя бы уходит по «Готово»; условие одно на клавиши и `inputmode`.
  await applyFontScale(page, 2.7);
  for (const viewport of [PHONE_VIEWPORTS[0]!, PHONE_VIEWPORTS[2]!]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await goToRoute(page, "Записать");
    await expect(keypad, `${viewport.name} ×2.7`).toHaveCount(0);
    await expect(amount).toHaveAttribute("inputmode", "decimal");
    await amount.fill("1234");
    await expect(amount).toHaveValue("1234");
    await expect(page.getByRole("button", { name: /^Продукты: останется/u })).toHaveCount(1);
    await page.getByRole("button", { name: "Очистить черновик" }).click();
  }
  // Обратно к обычному кеглю — клавиши возвращаются без перезагрузки.
  await applyFontScale(page, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(keypad).toBeVisible();
  await expect(amount).toHaveAttribute("inputmode", "none");
  // Телефон в альбоме: экран короче клавиатуры с кнопкой и навигацией.
  await page.setViewportSize({ width: 667, height: 375 });
  await expect(keypad).toHaveCount(0);
  await expect(amount).toHaveAttribute("inputmode", "decimal");
});
