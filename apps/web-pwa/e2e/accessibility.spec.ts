import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { designTouchTargetMinimum } from "../src/design-contract";
import { applyFontScale, FONT_SCALES } from "./font-scale";
import { amountField, entrySheet, leaveDialog, measureSheetTargets, startDemo, tile } from "./sheet";

interface ViewportContract {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

/** Порог из §9 `DESIGN.md`: проверка меряет то, что требует норматив, а не переписанное сюда число. */
const TOUCH_TARGET_MINIMUM = designTouchTargetMinimum();

const VIEWPORTS: readonly ViewportContract[] = [
  { name: "phone-320", width: 320, height: 568 },
  { name: "phone-landscape", width: 667, height: 375 },
  { name: "tablet-at-200-percent-equivalent", width: 512, height: 680 },
  { name: "ipad-portrait", width: 768, height: 1024 },
  { name: "tablet-landscape-compact", width: 844, height: 390 },
  { name: "ipad-landscape", width: 1024, height: 768 },
];

async function loadDemo(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /^Записать трату/u })).toBeVisible();
  await startDemo(page);
  await expect(page.locator(".reach-card")).toBeVisible();
}

/** Лист ввода поверх «Обзора»: цели не меньше норматива, каждая доматывается и ничем не накрыта. */
async function expectSheetContract(page: Page, label: string) {
  const geometry = await measureSheetTargets(page, TOUCH_TARGET_MINIMUM);
  expect(geometry.targets, `${label}: цели листа найдены`).toBeGreaterThan(5);
  expect(geometry.scrollWidth, `${label} must not introduce page-level horizontal overflow`).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.undersized, `${label}: every sheet target at least ${TOUCH_TARGET_MINIMUM} CSS px`).toEqual([]);
  expect(geometry.unreachable, `${label}: every sheet target reachable inside the sheet and uncovered`).toEqual([]);
}

/** С «Обзора» открыть лист плиткой «Продукты» и набрать сумму — самый высокий вариант листа. */
async function openSheetWithDraft(page: Page) {
  await expect(page.locator(".overview-screen")).toBeVisible();
  await tile(page, "Продукты").click();
  await expect(entrySheet(page)).toBeVisible();
  await amountField(page).fill("1234");
}

async function discardSheet(page: Page) {
  await page.keyboard.press("Escape");
  await leaveDialog(page).getByRole("button", { name: "Не сохранять" }).click();
  await expect(entrySheet(page)).toHaveCount(0);
}

async function expectFocusedRouteHeading(page: Page, navigationName: string) {
  await page.getByRole("button", { name: navigationName, exact: true }).click();
  await expect.poll(() => page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.textContent?.trim(),
  }))).toMatchObject({
    tag: "H1",
  });
}

/** План на год — подэкран «Ещё»: вкладки «Год» в навигации из пяти мест нет. */
async function openYearPlan(page: Page) {
  await expectFocusedRouteHeading(page, "Ещё");
  await page.getByRole("button", { name: /^План на год/u }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
}

async function expectGeometryContract(page: Page, viewport: ViewportContract) {
  const geometry = await page.evaluate((minimum) => {
    const interactiveSelector = [
      "button:not(:disabled)",
      "select:not(:disabled)",
      "input:not(:disabled):not([type='file']):not([type='radio']):not([type='checkbox'])",
      "label:has(input[type='radio']:not(:disabled))",
      "label:has(input[type='checkbox']:not(:disabled))",
      ".file-button:not(:has(input:disabled))",
    ].join(",");
    const undersized = [...document.querySelectorAll<HTMLElement>(interactiveSelector)]
      .filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: (
            element.getAttribute("aria-label") ??
            element.textContent ??
            element.id
          ).trim().slice(0, 80),
          width: rect.width,
          height: rect.height,
        };
      })
      .filter(({ width, height }) => width < minimum - 0.1 || height < minimum - 0.1);

    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      undersized,
    };
  }, TOUCH_TARGET_MINIMUM);

  expect(
    geometry.scrollWidth,
    `${viewport.name} must not introduce page-level horizontal overflow`,
  ).toBeLessThanOrEqual(geometry.clientWidth);
  expect(
    geometry.undersized,
    `${viewport.name} must keep every visible interactive target at least ${TOUCH_TARGET_MINIMUM} CSS px`,
  ).toEqual([]);
}

async function expectCompactPhoneLandscapeNavigation(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const geometry = await page.evaluate(() => {
    const navigation = document.querySelector<HTMLElement>(".bottom-nav");
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!navigation || !shell) throw new Error("Application navigation is missing.");

    const navigationRect = navigation.getBoundingClientRect();
    const navigationStyle = getComputedStyle(navigation);
    const shellStyle = getComputedStyle(shell);
    const visibleControls = [
      ...document.querySelectorAll<HTMLElement>(
        ".route-screen button:not(:disabled), .route-screen input:not(:disabled), .route-screen select:not(:disabled), .route-screen .file-button",
      ),
    ].filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < innerHeight;
    });

    return {
      navigation: {
        bottom: navigationRect.bottom,
        cssBottom: navigationStyle.bottom,
        height: navigationRect.height,
        position: navigationStyle.position,
        top: navigationRect.top,
      },
      overlappingControls: visibleControls
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > navigationRect.top && rect.top < navigationRect.bottom;
        })
        .map((element) => (
          element.getAttribute("aria-label") ??
          element.textContent ??
          element.id
        ).trim().slice(0, 80)),
      shellPaddingBottom: Number.parseFloat(shellStyle.paddingBottom),
      viewportHeight: innerHeight,
    };
  });

  expect(geometry.navigation).toMatchObject({
    cssBottom: "0px",
    position: "fixed",
  });
  expect(geometry.navigation.bottom).toBe(geometry.viewportHeight);
  expect(geometry.navigation.top).toBeGreaterThan(0);
  expect(geometry.navigation.height).toBeLessThanOrEqual(100);
  expect(geometry.shellPaddingBottom).toBeGreaterThanOrEqual(geometry.navigation.height);
  expect(geometry.overlappingControls).toEqual([]);
}

async function expectCompactTabletLandscapeNavigation(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const geometry = await page.evaluate(() => {
    const navigation = document.querySelector<HTMLElement>(".bottom-nav");
    if (!navigation) throw new Error("Application navigation is missing.");

    const navigationRect = navigation.getBoundingClientRect();
    const navigationStyle = getComputedStyle(navigation);
    const visibleControls = [
      ...document.querySelectorAll<HTMLElement>(
        ".route-screen button:not(:disabled), .route-screen input:not(:disabled), .route-screen select:not(:disabled), .route-screen .file-button",
      ),
    ].filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < innerHeight;
    });

    const nameOf = (element: HTMLElement) => (
      element.getAttribute("aria-label") ??
      element.textContent ??
      element.id
    ).trim().slice(0, 80);
    const underNavigation = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const nav = navigation.getBoundingClientRect();
      return rect.bottom > nav.top && rect.top < nav.bottom;
    };
    // Липкая панель наверху: под ней проезжает поток, и цель под ней в конце прокрутки — не
    // спрятанная, если её можно вывести из-под панели. Спрятанная навсегда — та, что и по центру
    // окна остаётся под панелью: её не домотать.
    const overlapping = visibleControls.filter(underNavigation);
    const hiddenForGood = overlapping.filter((element) => {
      element.scrollIntoView({ block: "center", behavior: "instant" });
      return underNavigation(element);
    }).map(nameOf);
    window.scrollTo(0, document.documentElement.scrollHeight);

    return {
      navigation: {
        bottom: navigationRect.bottom,
        height: navigationRect.height,
        position: navigationStyle.position,
        top: navigationRect.top,
      },
      hiddenForGood,
      viewportHeight: innerHeight,
    };
  });

  expect(geometry.navigation.position).toBe("sticky");
  expect(geometry.navigation.top).toBe(0);
  expect(geometry.navigation.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.navigation.height).toBeLessThanOrEqual(100);
  expect(geometry.hiddenForGood).toEqual([]);
}

test("keyboard navigation exposes the skip link and route focus without stealing form focus", async ({
  page,
}) => {
  await loadDemo(page);
  await page.reload();
  await expect(page.locator(".reach-card")).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(page.locator("#main-content")).toHaveJSProperty("tagName", "MAIN");

  await expectFocusedRouteHeading(page, "Операции");

  // «+» открывает лист поверх вкладки и сам ставит фокус в поле суммы — не на заголовок экрана.
  await page.getByRole("button", { name: "Записать", exact: true }).click();
  const amount = amountField(page);
  await expect(amount).toBeFocused();
  await amount.fill("1234");
  await expect(amount).toBeFocused();
  await expect(amount).toHaveValue("1234");

  // Категория выбирается в листе: плитка «куда» называет сторону и выбранное; выбор — плитками,
  // после него фокус возвращается на плитку стороны, а строка под суммой говорит, что останется.
  // Демо всегда открывает текущий месяц, поэтому сумма доходит до лимита категории.
  await entrySheet(page).getByRole("button", { name: "В категорию: категория не выбрана. Изменить" }).click();
  await expect(entrySheet(page).getByRole("button", { name: "Продукты", exact: true })).toBeVisible();
  await entrySheet(page).getByRole("button", { name: "Продукты", exact: true }).click();
  await expect(entrySheet(page).getByRole("button", { name: "В категорию: Продукты. Изменить" })).toBeFocused();
  await expect(page.locator(".entry-effect")).toContainText(/^В категории «Продукты» (?:останется|будет перелимит)/u);

  // Esc с набранным — вопрос приложения; «Не сохранять» закрывает лист, и фокус — на «+».
  await page.keyboard.press("Escape");
  await leaveDialog(page).getByRole("button", { name: "Не сохранять" }).click();
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Записать", exact: true })).toBeFocused();
  // Состояния сети в дереве доступности больше нет — и требовать его незачем: без
  // синхронизации приложение к сети не обращается, и слово «в сети» было бы сведением ни о чём.
  // О сети говорит только индикатор синхронизации, а он появляется после входа в семью.
  await expect(page.getByRole("status", { name: /Состояние сети/u })).toHaveCount(0);
});

test("phone, 200% zoom equivalent, and iPad layouts preserve targets and containment", async ({
  page,
}) => {
  await loadDemo(page);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openYearPlan(page);
    await expectGeometryContract(page, viewport);
    await page.getByRole("button", { name: "Настроить план" }).click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
    await expectGeometryContract(page, viewport);

    // Четыре вкладки — каждая со своим экраном и своими целями; «+» — лист поверх «Обзора».
    for (const route of ["Операции", "Отчёты", "Ещё", "Обзор"]) {
      await expectFocusedRouteHeading(page, route);
      await expectGeometryContract(page, viewport);
    }
    await openSheetWithDraft(page);
    await expectSheetContract(page, `${viewport.name} лист ввода`);
    await discardSheet(page);

    if (viewport.name === "phone-landscape") {
      await expectCompactPhoneLandscapeNavigation(page);
    }
    if (viewport.name === "tablet-landscape-compact") {
      await expectCompactTabletLandscapeNavigation(page);
    }
  }
});

/* -----------------------------------------------------------------------------------------------
 * Системное увеличение шрифта.
 *
 * Панель навигации растёт вместе со шрифтом: при ×2.7 подписи вкладок переносятся, и на 320 pt
 * панель занимает 188 pt вместо проектных 56, на 390 — 150. Всё, что считалось от токена, —
 * отступ оболочки, липкая полоса, тост — вставало на 56 и уходило под панель: кнопка записи была
 * недоступна ровно в режиме, который включают ради читаемости. На широком экране навигация липла
 * под воображаемую шапку в 56 pt, а настоящая при ×2.7 — 79. Лист ввода стоит поверх всего этого,
 * и его цели меряются внутри него: доматываются и ничем не накрыты.
 *
 * Здесь перекрытие меряется пересечением прямоугольников, а не выводится из чисел: на четырёх
 * ширинах телефона и двух широких, при обычном шрифте и при ×2.7, на всех семи экранах, в
 * четырёх положениях прокрутки. Тест обязан упасть, если полоса, тост или что угодно липкое
 * снова встанет на число, а не на панель.
 * --------------------------------------------------------------------------------------------- */

const PHONE_VIEWPORTS: readonly ViewportContract[] = [
  { name: "phone-320", width: 320, height: 568 },
  { name: "phone-375", width: 375, height: 667 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "phone-430", width: 430, height: 932 },
];
const WIDE_VIEWPORTS: readonly ViewportContract[] = [
  { name: "ipad-portrait", width: 768, height: 1024 },
  { name: "ipad-landscape", width: 1024, height: 768 },
];

/** Цели нажатия на экране маршрута и в плашках; сама навигация и ссылка обхода сюда не входят. */
const ROUTE_TARGET_SELECTOR = [
  ".route-screen button:not(:disabled)",
  ".route-screen select:not(:disabled)",
  ".route-screen input:not(:disabled):not([type='file']):not([type='radio']):not([type='checkbox'])",
  ".route-screen label:has(input[type='radio']:not(:disabled))",
  ".route-screen label:has(input[type='checkbox']:not(:disabled))",
  ".route-screen summary",
  ".route-screen .file-button:not(:has(input:disabled))",
  ".message-toast button",
  ".update-toast button",
].join(",");

interface NavigationClearance {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly viewportHeight: number;
  readonly shellPaddingBottom: number;
  readonly navigation: { readonly position: string; readonly top: number; readonly bottom: number; readonly height: number };
  /** Цели в прилипшей полосе записи или плашке — их не домотать — под панелью в каком-либо положении прокрутки. */
  readonly stuckUnderNavigation: readonly string[];
  /** Вкладки под шапкой — верхняя раскладка, где навигация липнет под шапку. */
  readonly tabsUnderHeader: readonly string[];
  /** Цели под панелью на краю потока, дальше которого не домотать. */
  readonly restingUnderNavigation: readonly string[];
  /** Цели, которые нельзя домотать так, чтобы 48 pt их высоты были свободны от шапки, панели и полосы. */
  readonly unreachable: readonly string[];
}

async function measureNavigationClearance(page: Page): Promise<NavigationClearance> {
  return page.evaluate(({ selector, minimum }) => {
    const nav = document.querySelector<HTMLElement>(".bottom-nav");
    const header = document.querySelector<HTMLElement>(".app-header");
    const shell = document.querySelector<HTMLElement>(".app-shell");
    if (!nav || !header || !shell) throw new Error("Application chrome is missing.");
    const bar = document.querySelector<HTMLElement>(".import-action");
    const rectOf = (element: Element) => element.getBoundingClientRect();
    const intersects = (a: DOMRect, b: DOMRect) =>
      a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5 && a.right > b.left + 0.5 && a.left < b.right - 0.5;
    const nameOf = (element: Element) =>
      (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/gu, " ").slice(0, 60);
    // `checkVisibility` отсеивает содержимое закрытых `<details>`: в Chromium у него есть
    // прямоугольники, но нет отрисовки, и без этой проверки оно «стояло бы под панелью».
    const isVisible = (element: HTMLElement) => {
      const rect = rectOf(element);
      return element.checkVisibility() && rect.width > 0 && rect.height > 0;
    };
    const targets = () => [...document.querySelectorAll<HTMLElement>(selector)].filter(isVisible);
    const scrollTo = (top: number) => window.scrollTo({ top, behavior: "instant" });
    // Полоса или плашка прилипла, если её низ стоит ровно на своём краю: `innerHeight − bottom`.
    // Полоса в потоке проезжает под панелью, как всё остальное, — и домотать её можно.
    const pinnedAtBottom = (holder: HTMLElement) => {
      const style = getComputedStyle(holder);
      if (style.position !== "sticky") return false;
      const offset = Number.parseFloat(style.bottom);
      return Number.isFinite(offset) && Math.abs(innerHeight - offset - rectOf(holder).bottom) < 1;
    };
    const navigationFixed = getComputedStyle(nav).position === "fixed";
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);

    const stuckUnderNavigation: string[] = [];
    const tabsUnderHeader: string[] = [];
    for (const fraction of [0, 1 / 3, 2 / 3, 1]) {
      scrollTo(Math.round(maxScroll * fraction));
      const navRect = rectOf(nav);
      const headerRect = rectOf(header);
      for (const target of targets()) {
        const holder = target.closest<HTMLElement>(".import-action, .message-toast, .update-toast");
        if (holder && pinnedAtBottom(holder) && intersects(rectOf(target), navRect)) {
          stuckUnderNavigation.push(`${nameOf(target)} @${Math.round(scrollY)}`);
        }
      }
      for (const tab of nav.querySelectorAll<HTMLElement>(".nav-button")) {
        if (intersects(rectOf(tab), headerRect)) tabsUnderHeader.push(`${nameOf(tab)} @${Math.round(scrollY)}`);
      }
    }

    // Край потока: у фиксированной панели — низ страницы, у липкой наверху — её верх. Там всё
    // содержимое обязано стоять вне панели: дальше уже не домотать.
    scrollTo(navigationFixed ? maxScroll : 0);
    const restingNavRect = rectOf(nav);
    const restingUnderNavigation = targets()
      .filter((target) => intersects(rectOf(target), restingNavRect))
      .map(nameOf);

    // Достижимость: каждую цель можно домотать так, чтобы хотя бы 48 pt её высоты — или вся она,
    // если ниже, — были свободны от шапки, панели и прилипшей полосы записи.
    const chrome = [header, nav, bar].filter((element): element is HTMLElement => element !== null);
    const clearHeight = (target: HTMLElement) => {
      const rect = rectOf(target);
      let top = Math.max(rect.top, 0);
      let bottom = Math.min(rect.bottom, innerHeight);
      for (const blocker of chrome) {
        if (blocker.contains(target)) continue;
        const blockerRect = rectOf(blocker);
        if (!intersects(rect, blockerRect)) continue;
        if (blockerRect.bottom <= (rect.top + rect.bottom) / 2) top = Math.max(top, blockerRect.bottom);
        else bottom = Math.min(bottom, blockerRect.top);
      }
      return bottom - top;
    };
    const unreachable: string[] = [];
    for (const target of targets()) {
      const required = Math.min(rectOf(target).height, minimum) - 0.5;
      target.scrollIntoView({ block: "center", behavior: "instant" });
      let best = clearHeight(target);
      if (best < required) {
        // Второй заход: цель к низу шапки — тогда прилипшая полоса и панель дальше всего.
        const headerBottom = getComputedStyle(header).position === "static" ? 0 : rectOf(header).bottom;
        window.scrollBy({ top: rectOf(target).top - headerBottom - 4, behavior: "instant" });
        best = Math.max(best, clearHeight(target));
      }
      if (best < required) {
        unreachable.push(`${nameOf(target)} (${Math.round(best)} of ${Math.round(rectOf(target).height)} pt clear)`);
      }
    }
    scrollTo(0);

    const navRect = rectOf(nav);
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      viewportHeight: innerHeight,
      shellPaddingBottom: Number.parseFloat(getComputedStyle(shell).paddingBottom),
      navigation: { position: getComputedStyle(nav).position, top: navRect.top, bottom: navRect.bottom, height: navRect.height },
      stuckUnderNavigation,
      tabsUnderHeader,
      restingUnderNavigation,
      unreachable,
    };
  }, { selector: ROUTE_TARGET_SELECTOR, minimum: TOUCH_TARGET_MINIMUM });
}

async function expectNavigationClearance(page: Page, label: string, layout: "phone" | "wide") {
  const geometry = await measureNavigationClearance(page);

  expect(geometry.scrollWidth, `${label}: horizontal overflow`).toBeLessThanOrEqual(geometry.clientWidth);
  if (layout === "phone") {
    expect(geometry.navigation.position, `${label}: phone navigation is fixed`).toBe("fixed");
    expect(geometry.navigation.bottom, `${label}: phone navigation sits on the viewport bottom`).toBe(geometry.viewportHeight);
    expect(
      geometry.shellPaddingBottom,
      `${label}: the shell must reserve the real navigation height (${geometry.navigation.height})`,
    ).toBeGreaterThanOrEqual(geometry.navigation.height);
  } else {
    expect(geometry.navigation.position, `${label}: wide navigation is sticky`).toBe("sticky");
  }
  expect(geometry.tabsUnderHeader, `${label}: navigation tabs must not sit under the header`).toEqual([]);
  expect(geometry.stuckUnderNavigation, `${label}: sticky controls must never sit under the navigation`).toEqual([]);
  expect(geometry.restingUnderNavigation, `${label}: at the edge of the flow nothing may sit under the navigation`).toEqual([]);
  expect(geometry.unreachable, `${label}: every target must be reachable clear of header, navigation and record bar`).toEqual([]);
}

for (const scale of FONT_SCALES) {
  test(`font scale ×${scale} keeps every target clear of the navigation on phone and wide layouts`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await loadDemo(page);
    await page.reload();
    await applyFontScale(page, scale);
    await expect(page.locator(".reach-card")).toBeVisible();

    for (const viewport of [...PHONE_VIEWPORTS, ...WIDE_VIEWPORTS]) {
      const layout = viewport.width >= 760 ? "wide" : "phone";
      const label = (screen: string) => `${viewport.name} ×${scale} ${screen}`;
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      await openYearPlan(page);
      await expectNavigationClearance(page, label("План на год"), layout);
      await page.getByRole("button", { name: "Настроить план" }).click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
      await expectNavigationClearance(page, label("Планирование"), layout);
      await expectFocusedRouteHeading(page, "Ещё");
      await expectNavigationClearance(page, label("Ещё"), layout);
      await expectFocusedRouteHeading(page, "Операции");
      await expectNavigationClearance(page, label("Операции"), layout);
      await expectFocusedRouteHeading(page, "Отчёты");
      await expectNavigationClearance(page, label("Отчёты"), layout);

      await expectFocusedRouteHeading(page, "Обзор");
      await expectNavigationClearance(page, label("Обзор"), layout);

      // Лист ввода с черновиком — поверх навигации и экрана: его цели меряются внутри него.
      await openSheetWithDraft(page);
      await expectSheetContract(page, label("Лист ввода"));
      await discardSheet(page);
    }
  });
}
