/**
 * «Обзор» (план волны 2, §1.1) в настоящем браузере: плитки и что из их касаний выходит.
 *
 * Автомат касаний проверен целиком в `pick-model.test.ts`; здесь — что настоящие плитки доводят
 * его до настоящего листа: четыре последовательности касаний, перетаскивание мышью (только там,
 * где указатель точный), путь одной клавиатурой, месяц в адресе и раскладка, которая не выезжает
 * за экран ни на 320 pt, ни при ×2.7.
 */
import type { Locator, Page } from "@playwright/test";
import type { BudgetState } from "@family-budget/domain";
import { expect, test } from "./fixtures";
import { designTouchTargetMinimum } from "../src/design-contract";
import { demoBudget, restoreBudget } from "./budgets";
import { applyFontScale } from "./font-scale";
import { amountField, entrySheet, goToOverview, loadDemo, measureSheetTargets, tile, toast } from "./sheet";

const TOUCH_TARGET_MINIMUM = designTouchTargetMinimum();
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const hash = (page: Page) => page.evaluate(() => location.hash);
const hint = (page: Page) => page.locator(".pick-hint[role='status']");

/** Лист открылся с этими «откуда → куда» — и закрывается без вопроса: набранного нет. */
async function expectSheet(page: Page, name: RegExp): Promise<void> {
  await expect(entrySheet(page)).toBeVisible();
  await expect(entrySheet(page)).toHaveAccessibleName(name);
  await page.keyboard.press("Escape");
  await expect(entrySheet(page)).toHaveCount(0);
}

test("четыре последовательности касаний — четыре листа, и адрес называет только вид и плитки", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(hint(page)).toHaveText(/^Коснитесь категории/u);

  // 1. Категория — расход с основного счёта.
  await tile(page, "Продукты").click();
  expect(await hash(page)).toMatch(new RegExp(`^#/\\?sheet=entry&op=expense&src=${UUID}&dst=${UUID}$`, "u"));
  await expectSheet(page, /^Расход: Карта → Продукты$/u);

  // 2. Счёт, затем категория — расход с этого счёта.
  await tile(page, "Резерв платежей").click();
  await expect(tile(page, "Резерв платежей")).toHaveAttribute("aria-pressed", "true");
  await expect(hint(page)).toHaveText(/^Выбран счёт «Резерв платежей»/u);
  await tile(page, "Продукты").click();
  await expectSheet(page, /^Расход: Резерв платежей → Продукты$/u);
  await expect(tile(page, "Резерв платежей")).toHaveAttribute("aria-pressed", "false");

  // 3. Источник дохода, затем счёт — доход на этот счёт.
  await tile(page, "Зарплата").click();
  await expect(tile(page, "Зарплата")).toHaveAttribute("aria-pressed", "true");
  await expect(hint(page)).toHaveText(/^Выбран доход «Зарплата»/u);
  await tile(page, "Карта").click();
  expect(await hash(page)).toMatch(new RegExp(`^#/\\?sheet=entry&op=income&src=${UUID}&dst=${UUID}$`, "u"));
  await expectSheet(page, /^Доход: Зарплата → Карта$/u);

  // 4. Счёт, затем другой счёт — перевод.
  await tile(page, "Карта").click();
  await tile(page, "Резерв платежей").click();
  expect(await hash(page)).toMatch(new RegExp(`^#/\\?sheet=entry&op=transfer&src=${UUID}&dst=${UUID}$`, "u"));
  await expectSheet(page, /^Перевод: Карта → Резерв платежей$/u);

  // Тот же счёт ещё раз — снять выбор; Esc — тоже.
  await tile(page, "Карта").click();
  await tile(page, "Карта").click();
  await expect(tile(page, "Карта")).toHaveAttribute("aria-pressed", "false");
  await expect(hint(page)).toHaveText(/^Коснитесь категории/u);
  await tile(page, "Карта").click();
  await page.keyboard.press("Escape");
  await expect(tile(page, "Карта")).toHaveAttribute("aria-pressed", "false");
  expect(await hash(page)).toBe("#/");
});

/**
 * Перетащить плитку мышью: нажать, сдвинуть за порог перетаскивания и вести шагами до цели —
 * как рука, а не прыжком: Chromium начинает перетаскивание только после движения с зажатой кнопкой.
 */
async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  await to.scrollIntoViewIfNeeded();
  await from.scrollIntoViewIfNeeded();
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("Плитка без размеров.");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("перетаскивание мышью — те же переходы, что и касания", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 1024, height: 1400 });
  // Указатель в прогоне точный (Desktop Chrome): плитки, которые можно взять, перетаскиваются.
  expect(await page.evaluate(() => matchMedia("(pointer: fine)").matches)).toBe(true);
  await expect(tile(page, "Резерв платежей")).toHaveAttribute("draggable", "true");

  await drag(page, tile(page, "Резерв платежей"), tile(page, "Продукты"));
  await expectSheet(page, /^Расход: Резерв платежей → Продукты$/u);
  await drag(page, tile(page, "Зарплата"), tile(page, "Карта"));
  await expectSheet(page, /^Доход: Зарплата → Карта$/u);
  await drag(page, tile(page, "Карта"), tile(page, "Резерв платежей"));
  await expectSheet(page, /^Перевод: Карта → Резерв платежей$/u);
  // Категорию не берут: она — только цель.
  await expect(tile(page, "Продукты")).not.toHaveAttribute("draggable", "true");
});

/** Табом до элемента, чьё доступное имя начинается с `prefix`; не дальше сотни шагов. */
async function tabTo(page: Page, prefix: string, backwards = false): Promise<void> {
  for (let step = 0; step < 100; step += 1) {
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
    const name = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
    if (name.startsWith(prefix)) return;
  }
  throw new Error(`«${prefix}» не достижим табом.`);
}

test("одной клавиатурой: плитка, сумма, запись — и выбор счёта пробелом", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#main-content").focus();

  await tabTo(page, "Продукты: ");
  await page.keyboard.press("Enter");
  await expect(entrySheet(page)).toBeVisible();
  await expect(amountField(page)).toBeFocused();
  await page.keyboard.type("1200");
  await page.keyboard.press("Enter");
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(toast(page, /Записано: расход 1\s200\s₽/u)).toBeVisible();
  await expect(tile(page, "Продукты")).toBeFocused();

  await tabTo(page, "Резерв платежей: ", true);
  await page.keyboard.press("Space");
  await expect(tile(page, "Резерв платежей")).toHaveAttribute("aria-pressed", "true");
  await tabTo(page, "Продукты: ");
  await page.keyboard.press("Enter");
  await expectSheet(page, /^Расход: Резерв платежей → Продукты$/u);
});

test("месяц — в адресе: стрелка листает плитки, фокус остаётся на стрелке, «Назад» — к текущему", async ({ page }) => {
  await loadDemo(page);
  const heading = page.getByRole("heading", { level: 1 });
  const current = (await heading.innerText()).trim();
  const previous = page.getByRole("button", { name: /^Предыдущий месяц: /u });
  await previous.click();
  await expect(heading).not.toHaveText(current);
  expect(await hash(page)).toMatch(/^#\/\?month=\d{4}-(?:0[1-9]|1[0-2])$/u);
  await expect(page.getByRole("button", { name: /^Предыдущий месяц: /u })).toBeFocused();
  // Месяц на месяц — не стопка записей истории: «Назад» сразу к текущему месяцу.
  await page.getByRole("button", { name: /^Предыдущий месяц: /u }).click();
  await page.goBack();
  await expect(heading).toHaveText(current);
  expect(await hash(page)).toBe("#/");
});

test("месяц за краем календаря в адресе — «Запись не найдена» и текущий месяц; у края стрелка выключена", async ({ page }) => {
  // Ревью 2b, MEDIUM-7: `#/?month=0000-01` ронял приложение в пустую страницу, и перезагрузка тоже.
  await loadDemo(page);
  const heading = page.getByRole("heading", { level: 1 });
  const current = (await heading.innerText()).trim();
  for (const month of ["0000-01", "9999-12", "1899-12", "2200-01"]) {
    await page.goto(`/#/?month=${month}`);
    await expect(page.locator(".message-toast"), month).toContainText("Запись не найдена");
    await expect(heading).toHaveText(current);
    expect(await hash(page)).toBe("#/");
  }
  await page.goto("/#/?month=0000-01");
  await page.reload();
  await expect(heading).toHaveText(current);

  await page.goto("/#/?month=1900-01");
  await expect(heading).toHaveText(/Январь 1900/u);
  await expect(page.getByRole("button", { name: /^Предыдущий месяц: нет/u })).toBeDisabled();
  await page.goto("/#/?month=2199-12");
  await expect(heading).toHaveText(/Декабрь 2199/u);
  await expect(page.getByRole("button", { name: /^Следующий месяц: нет/u })).toBeDisabled();
  await page.getByRole("button", { name: /^Предыдущий месяц: ноябрь 2199$/u }).click();
  await expect(heading).toHaveText(/Ноябрь 2199/u);
});

/**
 * Где строки имени плитки ломают слово: для каждого переноса строки внутри имени — символ перед
 * ним. Перенос честный, если перед ним пробел, дефис или мягкий перенос (он и рисуется дефисом);
 * иначе слово разорвано посередине без знака переноса. Строки находятся по прямоугольникам
 * каждого символа (`Range.getClientRects`), а не по ширине: так видно то, что видит глаз.
 */
async function wordSplits(page: Page, selector = ".overview-screen .tile-name"): Promise<readonly string[]> {
  return page.evaluate((names) => {
    const splits: string[] = [];
    for (const name of document.querySelectorAll<HTMLElement>(names)) {
      const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT);
      const chars: { readonly char: string; readonly top: number | null }[] = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        for (let index = 0; index < text.length; index += 1) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          // The glyph's own box is the last one: at a taken soft hyphen the next character's
          // range also covers the drawn hyphen at the end of the line above.
          const rect = [...range.getClientRects()].filter((item) => item.width > 0).at(-1);
          chars.push({ char: text[index] ?? "", top: rect === undefined ? null : rect.top });
        }
      }
      let lastTop: number | null = null;
      for (let index = 0; index < chars.length; index += 1) {
        const { top } = chars[index]!;
        if (top === null) continue;
        if (lastTop !== null && top > lastTop + 1) {
          const before = chars[index - 1]?.char ?? "";
          if (!/[\s\u00ad-]/u.test(before)) {
            const text = chars.map((item) => item.char).join("").replace(/\u00ad/gu, "");
            splits.push(`${text}: «${chars.slice(0, index).map((item) => item.char).join("").replace(/\u00ad/gu, "")}|…»`);
          }
        }
        lastTop = top;
      }
    }
    return splits;
  }, selector);
}

/** Длинные имена, какие семьи и правда заводят: с одной гласной, с приставками, латиницей (ревью 2b, раунд 3). */
const LONG_NAMES = [
  "Благотворительность", "Электроэнергия", "Стройматериалы", "Канцтовары", "Сверхъестественный",
  "Развлечения", "Подписки", "Коммунальные платежи", "Домашние животные", "Путешествия",
  "Strengths", "Netflix", "Здравоохранение", "Взносы", "Абонементы", "Бытовая химия",
  "Детский сад", "Автомобиль", "Сантехника", "Всплеск", "Тинькофф", "Мобильная связь",
];

/** Демо, где первые расходные категории названы `LONG_NAMES`. */
function withLongNames(state: BudgetState): BudgetState {
  const expense = state.categories.filter((item) => item.type === "expense" && item.active);
  const renamed = new Map(expense.slice(0, LONG_NAMES.length).map((item, index) => [item.id, LONG_NAMES[index]!]));
  return { ...state, categories: state.categories.map((item) => (renamed.has(item.id) ? { ...item, name: renamed.get(item.id)! } : item)) };
}

/** Ширины и кегли, на которых проверяется перенос: телефоны от 320 до 430 pt, ×1, ×2 и ×2.7. */
const LINE_BREAK_LAYOUTS = [[320, 1], [390, 1], [430, 1], [320, 2], [390, 2], [430, 2], [320, 2.7], [390, 2.7], [430, 2.7]] as const;

/** Имена на плитках — «Обзора», выбора стороны в листе и плиток «откуда → куда» наверху листа. */
const TILE_NAMES = ".tile-name, .endpoint-name";

/**
 * Где рвутся имена всех плиток при этой ширине и кегле: на «Обзоре», в листе с «+» — на плитках
 * «откуда → куда» и в открытом выборе каждой стороны, — и в листе с плитки `opener`.
 */
async function tileNameSplits(page: Page, opener: string): Promise<readonly string[]> {
  const splits = [...await wordSplits(page, TILE_NAMES)];
  const sheet = entrySheet(page);
  await page.getByRole("button", { name: "Записать", exact: true }).click();
  await expect(sheet).toBeVisible();
  splits.push(...(await wordSplits(page, TILE_NAMES)).map((split) => `лист: ${split}`));
  for (const side of ["to", "from"] as const) {
    await sheet.locator(`[data-side="${side}"]`).click();
    await expect(page.locator(".target-picker .tile-name").first()).toBeVisible();
    splits.push(...(await wordSplits(page, TILE_NAMES)).map((split) => `выбор ${side}: ${split}`));
    await page.keyboard.press("Escape");
    await expect(page.locator(".target-picker")).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await tile(page, opener).click();
  await expect(sheet).toBeVisible();
  splits.push(...(await wordSplits(page, TILE_NAMES)).map((split) => `лист с «${opener}»: ${split}`));
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  return splits;
}

/** Доступные имена с мягким переносом — по дереву доступности самого Chromium, а не по разметке. */
async function softHyphenedNames(page: Page): Promise<readonly string[]> {
  const session = await page.context().newCDPSession(page);
  const tree = (await session.send("Accessibility.getFullAXTree")) as { readonly nodes: readonly { readonly name?: { readonly value?: unknown } }[] };
  await session.detach();
  return tree.nodes.map((node) => String(node.name?.value ?? "")).filter((name) => name.includes("\u00ad"));
}

/** Ни одно имя плитки нигде не рвётся без дефиса — и ни одно доступное имя не несёт мягкого переноса. */
async function expectHyphenatedTileNames(page: Page, opener: string): Promise<void> {
  for (const [width, scale] of LINE_BREAK_LAYOUTS) {
    await applyFontScale(page, scale);
    await page.setViewportSize({ width, height: 844 });
    expect(await tileNameSplits(page, opener), `${width} pt ×${scale}`).toEqual([]);
  }
  await applyFontScale(page, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await softHyphenedNames(page), "«Обзор»").toEqual([]);
  await tile(page, opener).click();
  await expect(entrySheet(page)).toBeVisible();
  expect(await softHyphenedNames(page), `лист с «${opener}»: «откуда → куда»`).toEqual([]);
  for (const side of ["to", "from"] as const) {
    await entrySheet(page).locator(`[data-side="${side}"]`).click();
    await expect(page.locator(".target-picker .tile-name").first()).toBeVisible();
    expect(await softHyphenedNames(page), `выбор ${side} в листе`).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.locator(".target-picker")).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await expect(entrySheet(page)).toHaveCount(0);
}

test("имена плиток не рвутся посреди слова — на «Обзоре», в выборе листа и на «откуда → куда»: перенос — только с дефисом", async ({ page }) => {
  // Ревью 2b, LOW-9: «Продук|ты», «Трансп|орт», «Здоров|ье», «Подработ|ка» — пять колонок по 65 и
  // `overflow-wrap: anywhere` рвали слова без знака переноса. Раунд 3, NEW-2: выбор категории в
  // листе («В категорию… Изменить») мягких переносов не получил — «Транспор|т», «рассрочк|и»,
  // «Развлече|ния», при ×2.7 «Продукт|ы».
  test.setTimeout(240_000);
  await loadDemo(page);
  await expectHyphenatedTileNames(page, "Развлечения и хобби");
  // До 400 pt — не больше четырёх колонок расходов: на пяти по 65 имени остаётся 49 pt.
  const columns = await page.locator(".tile-grid-grid").evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
  expect(columns).toBe(4);
});

test("длинные имена тоже переносятся только с дефисом — и слово с одной гласной", async ({ page }) => {
  // Ревью 2b, раунд 3, NEW-5а: у «Strengths» правила не находили ни одного места, и на 320, 430 и
  // при ×2 слово рвалось без знака переноса — «Strengt|hs».
  test.setTimeout(240_000);
  await loadDemo(page);
  await restoreBudget(page, withLongNames(demoBudget()));
  await goToOverview(page);
  await expect(tile(page, "Strengths")).toBeVisible();
  await expectHyphenatedTileNames(page, "Благотворительность");
});

test("на 320 pt и при ×2.7 ничего не выезжает за экран — ни «Обзор», ни лист поверх него", async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page);
  for (const [width, height, scale] of [[320, 568, 1], [390, 844, 1], [320, 568, 2.7], [390, 844, 2.7]] as const) {
    const label = `${width}×${height} ×${scale}`;
    await applyFontScale(page, scale);
    await page.setViewportSize({ width, height });
    const overview = await page.evaluate((minimum) => {
      const tiles = [...document.querySelectorAll<HTMLElement>(".overview-screen .tile, .overview-screen .add-tile, .month-switch > button, .reach-line > button")];
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        undersized: tiles.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width < minimum - 0.1 || rect.height < minimum - 0.1).length,
        tiles: tiles.length,
      };
    }, TOUCH_TARGET_MINIMUM);
    expect(overview.scrollWidth, `${label}: «Обзор» без горизонтальной прокрутки`).toBeLessThanOrEqual(overview.clientWidth);
    expect(overview.tiles, `${label}: плитки на месте`).toBeGreaterThan(10);
    expect(overview.undersized, `${label}: плитки не меньше ${TOUCH_TARGET_MINIMUM}`).toBe(0);

    await tile(page, "Продукты").click();
    await expect(entrySheet(page)).toBeVisible();
    const sheet = await measureSheetTargets(page, TOUCH_TARGET_MINIMUM);
    expect(sheet.scrollWidth, `${label}: лист без горизонтальной прокрутки`).toBeLessThanOrEqual(sheet.clientWidth);
    expect(sheet.targets, `${label}: цели листа найдены`).toBeGreaterThan(5);
    expect(sheet.undersized, `${label}: цели листа не меньше ${TOUCH_TARGET_MINIMUM}`).toEqual([]);
    expect(sheet.unreachable, `${label}: каждую цель листа можно домотать и ничто её не накрывает`).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(entrySheet(page)).toHaveCount(0);
  }
  await applyFontScale(page, 1);
});

test("месяц плана закрыт — «Открыть …» залитой кнопкой в одну строку, на телефоне и на широком экране", async ({ page }) => {
  await loadDemo(page);
  // Демо строит план на текущий месяц; через два месяца он закрыт, и строка предлагает открыть новый.
  const later = new Date();
  later.setMonth(later.getMonth() + 2, 10);
  await page.clock.install({ time: later });
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport);
    await page.reload();
    await goToOverview(page);
    const open = page.locator(".reach-line.closed").getByRole("button", { name: /^Открыть / });
    await expect(open).toBeVisible();
    const box = await open.boundingBox();
    const label = await open.locator(".icon-label").boundingBox();
    if (box === null || label === null) throw new Error("«Открыть …» has no layout box.");
    // Подпись не сжата в узкую колонку по букве на строку: кнопка — одна строка высотой с цель касания.
    expect(box.height, `${viewport.width}px: высота кнопки`).toBeLessThan(TOUCH_TARGET_MINIMUM * 1.5);
    expect(label.width, `${viewport.width}px: ширина подписи`).toBeGreaterThan(120);
    // Кнопка — основное действие карточки, а не прозрачная строка-ссылка.
    const fill = await open.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(fill, `${viewport.width}px: заливка`).not.toBe("rgba(0, 0, 0, 0)");
  }
});
