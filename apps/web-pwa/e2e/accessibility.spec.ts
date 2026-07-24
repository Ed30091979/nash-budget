import { expect, test, type Page } from "@playwright/test";

interface ViewportContract {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

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
  await expect(
    page.getByRole("button", { name: "Загрузить демонстрационный бюджет" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Загрузить демонстрационный бюджет" }).click();
  await expect(page.getByText("Можно на повседневные расходы")).toBeVisible();
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

async function expectGeometryContract(page: Page, viewport: ViewportContract) {
  const geometry = await page.evaluate(() => {
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
      .filter(({ width, height }) => width < 43.9 || height < 43.9);

    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      undersized,
    };
  });

  expect(
    geometry.scrollWidth,
    `${viewport.name} must not introduce page-level horizontal overflow`,
  ).toBeLessThanOrEqual(geometry.clientWidth);
  expect(
    geometry.undersized,
    `${viewport.name} must keep every visible interactive target at least 44 CSS px`,
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

    return {
      navigation: {
        bottom: navigationRect.bottom,
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
      viewportHeight: innerHeight,
    };
  });

  expect(geometry.navigation.position).toBe("sticky");
  expect(geometry.navigation.top).toBe(0);
  expect(geometry.navigation.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.navigation.height).toBeLessThanOrEqual(100);
  expect(geometry.overlappingControls).toEqual([]);
}

test("keyboard navigation exposes the skip link and route focus without stealing form focus", async ({
  page,
}) => {
  await loadDemo(page);
  await page.reload();
  await expect(page.getByText("Можно на повседневные расходы")).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(page.locator("#main-content")).toHaveJSProperty("tagName", "MAIN");

  await expectFocusedRouteHeading(page, "Год");
  await expectFocusedRouteHeading(page, "Записать");

  const amount = page.getByLabel("Сумма, ₽");
  await amount.fill("1234");
  await expect(amount).toBeFocused();
  await expect(amount).toHaveValue("1234");
  await expect(page.getByRole("button", { name: "Очистить черновик" })).toBeVisible();

  await expect(
    page.getByRole("status", { name: /Продукты: .*использовано/u }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Состояние сети: в сети" }),
  ).toHaveText("в сети");
});

test("phone, 200% zoom equivalent, and iPad layouts preserve targets and containment", async ({
  page,
}) => {
  await loadDemo(page);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expectFocusedRouteHeading(page, "Год");
    await expectGeometryContract(page, viewport);
    await page.getByRole("button", { name: "Настроить план" }).click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
    await expectGeometryContract(page, viewport);

    for (const route of ["Записать", "Ещё", "Сегодня"]) {
      await expectFocusedRouteHeading(page, route);
      await expectGeometryContract(page, viewport);
    }

    if (viewport.name === "phone-landscape") {
      await expectCompactPhoneLandscapeNavigation(page);
    }
    if (viewport.name === "tablet-landscape-compact") {
      await expectCompactTabletLandscapeNavigation(page);
    }
  }
});
