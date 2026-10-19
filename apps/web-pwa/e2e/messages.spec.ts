/**
 * §12: ни одно сообщение не накрывает цель нажатия — измерено, а не отмечено галочкой.
 *
 * Маршруты: с первого шага онбординга до «Выписки», включая «Историю» внутри «Ещё». На
 * «Записать» полоса записи держит клавиатуру суммы — самый высокий из липких блоков.
 *
 * Пункт стоял пройденным годами, а проверки под ним не было; дефект при этом был: на маршруте
 * онбординга нет навигации, `--nav-space` держал проектные 56, и плашка «готово работать без
 * интернета» вставала над серединой экрана — поверх полей первого шага. Признак срабатывает один
 * раз за установку, поэтому дефект видел только новичок и только в первые секунды знакомства.
 *
 * Здесь плашка настоящая: её поднимает настоящий сервис-воркер настоящей сборки в свежем
 * контексте браузера — ровно так, как у новичка. Подделывать состояние не пришлось, и это
 * важно: подделка проверяла бы разметку, а не то, что сервис-воркер действительно доносит
 * событие до плашки на том маршруте, где человек в эту секунду стоит. Плашка одна на все
 * маршруты (рама `AppFrame`), поэтому тот же экземпляр проходит с онбординга в приложение, и
 * тем же экземпляром меряются все экраны.
 *
 * Меряется пересечение прямоугольников: каждая цель нажатия обязана быть доматываемой так, чтобы
 * не меньше 48 pt её высоты (или вся она, если ниже) были свободны от шапки, навигации, полосы
 * записи и любой плашки — в каком-нибудь из положений прокрутки. Порог — из §9 `DESIGN.md`.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

import { designTouchTargetMinimum } from "../src/design-contract";
import { makeG002BackupBuffer } from "./canonical-budget";
import { applyFontScale, FONT_SCALES } from "./font-scale";
import { helloShot } from "./hello-shot";

const OFFLINE_READY = "Приложение готово работать без интернета.";
const TOUCH_TARGET_MINIMUM = designTouchTargetMinimum();

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
const WIDE_VIEWPORTS: readonly Viewport[] = [
  { name: "ipad-portrait", width: 768, height: 1024 },
  { name: "ipad-landscape", width: 1024, height: 768 },
];
/** Внутри приложения — крайние ширины телефона и планшет: остальные экраны меряет `accessibility.spec.ts`. */
const APP_VIEWPORTS: readonly Viewport[] = [PHONE_VIEWPORTS[0]!, PHONE_VIEWPORTS[2]!, WIDE_VIEWPORTS[0]!, WIDE_VIEWPORTS[1]!];

/** Всё, что нажимают или заполняют, — на любом маршруте, плашки включительно. Ссылка обхода вне экрана до фокуса. */
const TARGET_SELECTOR = [
  "button:not(:disabled)",
  "select:not(:disabled)",
  "input:not(:disabled):not([type='file']):not([type='radio']):not([type='checkbox'])",
  "label:has(input[type='radio']:not(:disabled))",
  "label:has(input[type='checkbox']:not(:disabled))",
  "summary",
  ".file-button:not(:has(input:disabled))",
].join(",");

/** Всё, что может стоять над содержимым: шапка, навигация, полоса записи и обе плашки. */
const BLOCKER_SELECTOR = ".app-header, .bottom-nav, .record-action, .update-toast, .message-toast";

interface MessageClearance {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly toasts: number;
  /** Цели, которые ни в одном положении прокрутки не свободны от шапки, навигации, полосы и плашек. */
  readonly unreachable: readonly string[];
  /** Цели прилипшей полосы записи под плашкой — прилипшую полосу не домотать, ей положено быть чистой всегда. */
  readonly pinnedUnderToast: readonly string[];
}

async function measureMessageClearance(page: Page): Promise<MessageClearance> {
  return page.evaluate(({ targetSelector, blockerSelector, minimum }) => {
    const rectOf = (element: Element) => element.getBoundingClientRect();
    const intersects = (a: DOMRect, b: DOMRect) =>
      a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5 && a.right > b.left + 0.5 && a.left < b.right - 0.5;
    const nameOf = (element: Element) =>
      (element.getAttribute("aria-label") ?? element.textContent ?? element.id ?? "").trim().replace(/\s+/gu, " ").slice(0, 60);
    const isVisible = (element: HTMLElement) => {
      const rect = rectOf(element);
      return element.checkVisibility() && rect.width > 0 && rect.height > 0;
    };
    const targets = [...document.querySelectorAll<HTMLElement>(targetSelector)]
      .filter((element) => !element.classList.contains("skip-link") && isVisible(element));
    const blockers = () => [...document.querySelectorAll<HTMLElement>(blockerSelector)].filter(isVisible);
    const scrollTo = (top: number) => window.scrollTo({ top, behavior: "instant" });
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);

    // Свободная высота цели: её прямоугольник в окне минус всё, что стоит над ней.
    const clearHeight = (target: HTMLElement) => {
      const rect = rectOf(target);
      let top = Math.max(rect.top, 0);
      let bottom = Math.min(rect.bottom, innerHeight);
      for (const blocker of blockers()) {
        if (blocker.contains(target)) continue;
        const blockerRect = rectOf(blocker);
        if (!intersects(rect, blockerRect)) continue;
        if (blockerRect.bottom <= (rect.top + rect.bottom) / 2) top = Math.max(top, blockerRect.bottom);
        else bottom = Math.min(bottom, blockerRect.top);
      }
      return bottom - top;
    };
    // Нижняя оправа: сколько снизу занимают прилипшие к низу плашки, полоса и навигация.
    const bottomChrome = () => Math.max(0, ...blockers()
      .map(rectOf)
      .filter((rect) => rect.bottom > innerHeight / 2 && rect.bottom <= innerHeight + 1)
      .map((rect) => innerHeight - rect.top));
    const headerBottom = () => {
      const header = document.querySelector<HTMLElement>(".app-header");
      if (!header || getComputedStyle(header).position === "static") return 0;
      return rectOf(header).bottom;
    };

    // Полоса записи прилипла, если её низ стоит ровно на своём краю: `innerHeight − bottom`.
    const pinnedAtBottom = (holder: HTMLElement) => {
      const style = getComputedStyle(holder);
      if (style.position !== "sticky") return false;
      const offset = Number.parseFloat(style.bottom);
      return Number.isFinite(offset) && Math.abs(innerHeight - offset - rectOf(holder).bottom) < 1;
    };
    const pinnedUnderToast: string[] = [];
    for (const fraction of [0, 1 / 3, 2 / 3, 1]) {
      scrollTo(Math.round(maxScroll * fraction));
      const toasts = [...document.querySelectorAll<HTMLElement>(".update-toast, .message-toast")].filter(isVisible).map(rectOf);
      for (const target of targets) {
        const holder = target.closest<HTMLElement>(".record-action");
        if (!holder || !pinnedAtBottom(holder)) continue;
        if (toasts.some((toast) => intersects(rectOf(target), toast))) {
          pinnedUnderToast.push(`${nameOf(target)} @${Math.round(scrollY)}`);
        }
      }
    }

    const unreachable: string[] = [];
    for (const target of targets) {
      const required = Math.min(rectOf(target).height, minimum) - 0.5;
      let best = -Infinity;
      // Четыре положения прокрутки: цель по центру, под шапкой, над нижней оправой, край потока.
      target.scrollIntoView({ block: "center", behavior: "instant" });
      best = Math.max(best, clearHeight(target));
      if (best < required) {
        window.scrollBy({ top: rectOf(target).top - headerBottom() - 4, behavior: "instant" });
        best = Math.max(best, clearHeight(target));
      }
      if (best < required) {
        window.scrollBy({ top: rectOf(target).bottom - (innerHeight - bottomChrome() - 4), behavior: "instant" });
        best = Math.max(best, clearHeight(target));
      }
      if (best < required) {
        scrollTo(maxScroll);
        best = Math.max(best, clearHeight(target));
      }
      if (best < required) {
        unreachable.push(`${nameOf(target)} (${Math.round(best)} of ${Math.round(rectOf(target).height)} pt clear)`);
      }
    }
    scrollTo(0);

    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      toasts: document.querySelectorAll(".update-toast, .message-toast").length,
      unreachable,
      pinnedUnderToast,
    };
  }, { targetSelector: TARGET_SELECTOR, blockerSelector: BLOCKER_SELECTOR, minimum: TOUCH_TARGET_MINIMUM });
}

async function expectMessageClearance(page: Page, label: string): Promise<void> {
  const geometry = await measureMessageClearance(page);
  expect(geometry.toasts, `${label}: плашка обязана стоять на экране, иначе мерить нечего`).toBeGreaterThan(0);
  expect(geometry.scrollWidth, `${label}: горизонтальная прокрутка`).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.unreachable, `${label}: каждая цель обязана быть доматываемой мимо шапки, навигации, полосы и плашки`).toEqual([]);
  expect(geometry.pinnedUnderToast, `${label}: плашка не смеет стоять на прилипшей полосе записи`).toEqual([]);
}

/** Переход вкладкой навигации; уже активная вкладка — не переход, и фокус на заголовок она не переводит. */
async function goToRoute(page: Page, navigationName: string): Promise<void> {
  const tab = page.getByRole("button", { name: navigationName, exact: true });
  if ((await tab.getAttribute("aria-current")) === "page") return;
  await tab.click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
}

test("плашка сервис-воркера не накрывает ни одной цели — с первого шага онбординга до «Ещё»", async ({ page }) => {
  test.setTimeout(480_000);
  await page.goto("/");
  const toast = page.locator(".update-toast");
  // Настоящая плашка настоящего сервис-воркера: первая установка в свежем контексте.
  await expect(toast).toContainText(OFFLINE_READY, { timeout: 60_000 });

  /* ── Онбординг, шаг 1: поля, которые плашка накрывала. ── */
  for (const scale of FONT_SCALES) {
    await applyFontScale(page, scale);
    for (const viewport of [...PHONE_VIEWPORTS, ...WIDE_VIEWPORTS]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expectMessageClearance(page, `онбординг, шаг 1, ${viewport.name} ×${scale}`);
    }
  }
  await applyFontScale(page, 1);
  await page.setViewportSize({ width: 390, height: 664 });
  await helloShot(page, "onboarding-toast-after-664");
  await page.setViewportSize({ width: 390, height: 844 });
  await helloShot(page, "onboarding-toast-after");

  /* ── Онбординг, шаг 4: самая высокая карточка. ── */
  await page.getByRole("button", { name: "Далее" }).click();
  await expect(page.getByText("Шаг 2 из 4")).toBeVisible();
  await page.getByRole("button", { name: "Далее" }).click();
  await expect(page.getByText("Шаг 3 из 4")).toBeVisible();
  await page.getByLabel("Доход в месяц, ₽").fill("180000");
  await page.getByLabel("Сумма платежа, ₽").fill("53000");
  await page.getByRole("button", { name: "Далее" }).click();
  await expect(page.getByText("Шаг 4 из 4")).toBeVisible();
  for (const [index, limit] of ["30000", "10000", "8000"].entries()) {
    await page.locator(`#category-${index}-limit`).fill(limit);
  }
  for (const scale of FONT_SCALES) {
    await applyFontScale(page, scale);
    for (const viewport of [...PHONE_VIEWPORTS, ...WIDE_VIEWPORTS]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expectMessageClearance(page, `онбординг, шаг 4, ${viewport.name} ×${scale}`);
    }
  }

  /* ── В приложение — с той же плашкой. ── */
  await applyFontScale(page, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".step-progress-step.done").first().click();
  await expect(page.getByText("Шаг 1 из 4")).toBeVisible();
  await page.getByRole("button", { name: "Загрузить демонстрационный бюджет" }).click();
  await expect(page.locator(".hero-card")).toBeVisible();
  // Плашка пережила смену маршрута: сообщение, которое никто не закрывал, не пропало само.
  await expect(toast).toContainText(OFFLINE_READY);

  for (const scale of FONT_SCALES) {
    await applyFontScale(page, scale);
    for (const viewport of APP_VIEWPORTS) {
      const label = (screen: string) => `${screen}, ${viewport.name} ×${scale}`;
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      await goToRoute(page, "Сегодня");
      await expectMessageClearance(page, label("Сегодня"));
      await goToRoute(page, "Год");
      await expectMessageClearance(page, label("Год"));
      await page.getByRole("button", { name: "Настроить план" }).click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
      await expectMessageClearance(page, label("Планирование"));
      // «Записать» с черновиком: полоса записи с двумя кнопками — самый высокий её вариант.
      await goToRoute(page, "Записать");
      await page.getByLabel("Сумма, ₽").fill("1234");
      await expect(page.getByRole("button", { name: "Очистить черновик" })).toBeVisible();
      await expectMessageClearance(page, label("Записать"));
      await page.getByRole("button", { name: "Очистить черновик" }).click();
      await expect(page.getByRole("button", { name: "Очистить черновик" })).toHaveCount(0);
      await goToRoute(page, "Ещё");
      await expectMessageClearance(page, label("Ещё"));
      // «Вся история» — маршрут внутри «Ещё» с поиском над списком: своя раскладка, свои цели.
      await page.getByRole("button", { name: /^Вся история/u }).click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
      await expectMessageClearance(page, label("История"));
      await page.getByRole("button", { name: /К разделу «Ещё»/u }).click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
      await page.getByRole("button", { name: /Семья и синхронизация/u }).click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
      await expectMessageClearance(page, label("Семья"));
      // На экране семьи вкладка «Ещё» уже подсвечена: назад ведёт кнопка экрана, а не вкладка.
      await page.getByRole("button", { name: /К разделу «Ещё»/u }).click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
      await page.getByRole("button", { name: /Загрузить выписку банка/u }).click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
      await expectMessageClearance(page, label("Выписка"));
    }
  }

  /* ── Сообщение приложения: одна плашка на экране, и тоже ничего не накрывает. ── */
  await applyFontScale(page, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  // С экрана выписки вкладка «Ещё» уже подсвечена: сначала домой, потом на список «Ещё».
  await goToRoute(page, "Сегодня");
  await goToRoute(page, "Ещё");
  await page.locator("#backup-file").setInputFiles({
    name: "family-budget-g002.json",
    mimeType: "application/json",
    buffer: makeG002BackupBuffer(),
  });
  await expect(page.getByRole("status").filter({ hasText: "Резервная копия восстановлена." })).toBeVisible();
  await goToRoute(page, "Сегодня");
  // Июль G-002 закрыт: открытие месяца — единственный путь получить сообщение приложения.
  await page.getByRole("button", { name: /^Открыть /u }).click();
  const message = page.locator(".message-toast");
  await expect(message).toContainText(/открыт/u);
  // Потолок: пока стоит сообщение, плашки обновления на экране нет — они не встают друг на друга.
  await expect(toast).toHaveCount(0);
  await expectMessageClearance(page, "Сегодня с сообщением приложения");
  await page.getByRole("button", { name: "Закрыть" }).click();
  await expect(message).toHaveCount(0);
  // И спрятанная плашка вернулась — с тем же состоянием.
  await expect(toast).toContainText(OFFLINE_READY);
});
