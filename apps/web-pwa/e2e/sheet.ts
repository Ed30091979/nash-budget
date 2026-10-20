import { expect, type Locator, type Page } from "@playwright/test";

/**
 * «Обзор» и лист ввода в прогоне — одни слова на все проверки.
 *
 * Плитка находится по доступному имени — тому, что слышит читающий с экрана: «Продукты: потрачено
 * …», «Карта: остаток …». Лист — модальный диалог с полем суммы; запись — кнопкой, которая
 * называет действие и сумму.
 */

/**
 * Первый запуск (дизайн v5): два «Дальше» по слайдам и «Посмотреть на примере» на третьем — демо.
 * Слайды стоят, пока на устройстве нет бюджета; страница уже открыта.
 */
export async function startDemo(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Дальше", exact: true }).click();
  await expect(page.getByRole("img", { name: "Шаг 2 из 3" })).toBeVisible();
  await page.getByRole("button", { name: "Дальше", exact: true }).click();
  await expect(page.getByRole("img", { name: "Шаг 3 из 3" })).toBeVisible();
  await page.getByRole("button", { name: "Посмотреть на примере", exact: true }).click();
}

/** Демо загружено и «Обзор» стоит: карточка «Хватает до …» под итогами на месте. */
export async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  await startDemo(page);
  await expect(page.locator(".reach-card")).toBeVisible();
}

/** Число «Можно тратить» — третий итог шапки, одно на экран (`overview-ui.test.tsx` держит это). */
export function reachAmount(page: Page): Locator {
  return page.locator(".total-can-spend .total-value");
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Плитка категории расхода, счёта или источника дохода — по имени до двоеточия. */
export function tile(page: Page, name: string): Locator {
  return page.locator(".overview-screen").getByRole("button", { name: new RegExp(`^${escapeRegExp(name)}: `, "u") });
}

/** Открытый лист ввода. */
export function entrySheet(page: Page): Locator {
  return page.locator("section.entry-sheet[role='dialog']");
}

export function amountField(page: Page): Locator {
  return page.locator("#entry-amount");
}

export function keypadKey(page: Page, name: string): Locator {
  return page.getByRole("group", { name: "Клавиатура суммы" }).getByRole("button", { name, exact: true });
}

export async function typeOnKeypad(page: Page, keys: readonly string[]): Promise<void> {
  for (const key of keys) await keypadKey(page, key).click();
}

/** Кнопка записи листа: «Записать 1 250 ₽» или «Сохранить». */
export function submitButton(page: Page): Locator {
  return page.locator(".entry-submit");
}

/** Тост приложения; `text` — то, что он обязан сказать. */
export function toast(page: Page, text: RegExp | string): Locator {
  return page.locator(".message-toast").filter({ hasText: text });
}

export function leaveDialog(page: Page): Locator {
  return page.getByRole("alertdialog", { name: "Уйти без сохранения?" });
}

/** Перейти на «Обзор», если стоим не на нём, и дождаться плиток. */
export async function goToOverview(page: Page): Promise<void> {
  const tab = page.getByRole("button", { name: "Обзор", exact: true });
  if ((await tab.getAttribute("aria-current")) !== "page") await tab.click();
  await expect(page.locator(".overview-screen")).toBeVisible();
}

/**
 * Расход с плитки: категория → лист; дата — «Другой день», сумма — в поле, запись — кнопкой.
 * Записано — когда тост это сказал, а не когда кнопку нажали.
 */
export async function recordExpense(page: Page, options: { readonly category: string; readonly amount: string; readonly date?: string }): Promise<void> {
  await goToOverview(page);
  await tile(page, options.category).click();
  await expect(entrySheet(page)).toBeVisible();
  if (options.date !== undefined) {
    await entrySheet(page).getByRole("button", { name: "Другой день" }).click();
    await page.locator("#entry-date").fill(options.date);
  }
  await amountField(page).fill(options.amount);
  await submitButton(page).click();
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(toast(page, /Записано: расход/u)).toBeVisible();
}

export interface SheetTargets {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  /** Цели листа, которые не домотать до 48 pt свободной высоты или которые чем-то накрыты. */
  readonly unreachable: readonly string[];
  /** Цели листа меньше норматива. */
  readonly undersized: readonly string[];
  readonly targets: number;
}

/**
 * Каждая цель листа: домотать её внутри листа так, чтобы видимая часть была не меньше
 * min(высота, 48) и в её центре стояла она сама — не плашка, не затемнение, не липкое поле суммы.
 * Видимая часть — пересечение с окном и со всеми предками, которые обрезают содержимое. Положений
 * прокрутки три — цель по центру, у нижнего края и у верхнего: на коротком экране сумма липнет к
 * краю тела листа, и цель достаточно увидеть хотя бы в одном из них, как это сделал бы палец.
 */
export async function measureSheetTargets(page: Page, minimum: number, sheetSelector = "section.entry-sheet[role='dialog']"): Promise<SheetTargets> {
  return page.evaluate(({ min, sheetSelector: selectorOfSheet }) => {
    const sheet = document.querySelector<HTMLElement>(selectorOfSheet);
    if (!sheet) throw new Error(`Лист не открыт: ${selectorOfSheet}.`);
    const selector = [
      "button:not(:disabled)",
      "input:not(:disabled):not([type='file']):not([type='radio']):not([type='checkbox'])",
      "select:not(:disabled)",
    ].join(",");
    const nameOf = (element: Element) =>
      (element.getAttribute("aria-label") ?? element.textContent ?? element.id ?? "").trim().replace(/\s+/gu, " ").slice(0, 60);
    const isVisible = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return element.checkVisibility() && rect.width > 0 && rect.height > 0;
    };
    const visibleSpan = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      let top = Math.max(rect.top, 0);
      let bottom = Math.min(rect.bottom, innerHeight);
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowY === "visible" && style.overflowX === "visible") continue;
        const clip = parent.getBoundingClientRect();
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
      return { top, bottom, height: bottom - top, left: rect.left, right: rect.right };
    };
    const targets = [...sheet.querySelectorAll<HTMLElement>(selector)].filter(isVisible);
    const unreachable: string[] = [];
    const undersized: string[] = [];
    const attempt = (target: HTMLElement, block: ScrollLogicalPosition) => {
      target.scrollIntoView({ block, inline: "nearest", behavior: "instant" });
      const span = visibleSpan(target);
      const required = Math.min(target.getBoundingClientRect().height, min) - 0.5;
      const x = Math.min(Math.max((span.left + span.right) / 2, 0), innerWidth - 1);
      const y = (span.top + span.bottom) / 2;
      const hit = span.height > 0 ? document.elementFromPoint(x, y) : null;
      const covered = hit === null || !(hit === target || target.contains(hit));
      return { ok: span.height >= required && !covered, clear: span.height, by: covered ? String(hit?.className || hit?.tagName || "nothing") : "" };
    };
    for (const target of targets) {
      const rect = target.getBoundingClientRect();
      if (rect.height < min - 0.1 || rect.width < min - 0.1) undersized.push(`${nameOf(target)} (${Math.round(rect.width)}×${Math.round(rect.height)})`);
      const tries = (["center", "end", "start"] as const).map((block) => attempt(target, block));
      if (!tries.some((one) => one.ok)) {
        const best = tries.reduce((left, right) => (right.clear > left.clear ? right : left));
        unreachable.push(`${nameOf(target)} (${Math.round(best.clear)} pt clear${best.by ? `, covered by ${best.by}` : ""})`);
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      unreachable,
      undersized,
      targets: targets.length,
    };
  }, { min: minimum, sheetSelector });
}

/**
 * «Операции» за весь период. Лента по умолчанию — текущий месяц (ревью 2d, LOW-11), а у канонических
 * бюджетов (G-002 — июль 2026) и у записей других месяцев операции не в нём: прогон берёт всю
 * историю тем же путём, что человек, — чипом периода и «Весь период» в его листе.
 */
export async function showWholeHistory(page: Page): Promise<void> {
  const feed = page.getByRole("region", { name: "Операции" });
  await expect(feed).toBeVisible();
  const chip = feed.getByRole("button", { name: /^Период: /u });
  if ((await chip.getAttribute("aria-label")) === "Период: весь период") return;
  await chip.click();
  await page.getByRole("dialog", { name: "Период" }).getByRole("button", { name: "Весь период", exact: true }).click();
  await expect(feed.getByRole("button", { name: "Период: весь период" })).toHaveAttribute("data-set", "true");
}
