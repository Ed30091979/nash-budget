/**
 * Первый запуск дизайна v5 (DIRECTION §e) в настоящем браузере: три слайда, молчаливый набор,
 * вопросы листами поверх «Обзора», подсказка на первую трату, карточки-подсказки, пример и пустые
 * состояния. Память «что уже спрошено» — IndexedDB этого устройства: перезагрузка её не теряет, и
 * отвеченный или отложенный вопрос не возвращается (отложенный — раз, через неделю).
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { designTouchTargetMinimum } from "../src/design-contract";
import { applyFontScale } from "./font-scale";
import { nameSplits, softHyphenedNames } from "./line-breaks";
import { amountField, entrySheet, startDemo, submitButton, tile, toast } from "./sheet";

const TOUCH_TARGET_MINIMUM = designTouchTargetMinimum();

// Язык устройства — русский, как у аудитории: набор в рублях, и результат не зависит от машины
// прогона (ревью R2, L-2). Казахский и смена валюты — `first-run-edges.spec.ts`.
test.use({ locale: "ru-RU" });

const slideHeading = (page: Page) => page.getByRole("heading", { level: 1 });
const question = (page: Page, name: string) => page.getByRole("dialog", { name });
const CHIPS = "На что вы тратите?";
const ACCOUNTS = "Есть ещё места, где лежат деньги?";
const PAYDAY = "Когда приходит зарплата?";
const coach = (page: Page) => page.locator(".coach-bubble");

/** Слайды → «Начать» на третьем. */
async function startPreset(page: Page): Promise<void> {
  await page.goto("/");
  await expect(slideHeading(page)).toHaveAccessibleName(/^Записать трату/u);
  await page.getByRole("button", { name: "Дальше", exact: true }).click();
  await page.getByRole("button", { name: "Дальше", exact: true }).click();
  await page.getByRole("button", { name: "Начать", exact: true }).click();
  await expect(question(page, CHIPS)).toBeVisible();
}

/** Нажимать Tab, пока фокус не встанет на элемент с этим доступным именем. */
async function tabTo(page: Page, name: RegExp, limit = 60): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press("Tab");
    // Имя — как его слышат: подпись или текст «для слуха» (`Hyphenated`), а не все копии подряд.
    const focused = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const spoken = active?.querySelector(".sr-only")?.textContent;
      return (active?.getAttribute("aria-label") ?? spoken ?? active?.textContent ?? "").trim();
    });
    if (name.test(focused)) return;
  }
  throw new Error(`Tab не дошёл до ${name}`);
}

async function firstRunDatabases(page: Page): Promise<readonly string[]> {
  return page.evaluate(async () => (await indexedDB.databases()).map((item) => item.name ?? ""));
}

test("первый запуск целиком: слайды → «Начать» → набор на «Обзоре» → чипы → места для денег → дни выплат → подсказка → первая запись её снимает", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  // Слайды — последовательность: фокус на заголовке каждого, «Шаг N из 3» словами.
  await expect(slideHeading(page)).toBeFocused();
  await expect(page.getByRole("img", { name: "Шаг 1 из 3" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Пропустить" })).toBeVisible();
  await page.getByRole("button", { name: "Дальше", exact: true }).click();
  await expect(slideHeading(page)).toHaveAccessibleName(/^Видно, хватит ли до/u);
  await expect(slideHeading(page)).toBeFocused();
  await page.getByRole("button", { name: "Дальше", exact: true }).click();
  await expect(slideHeading(page)).toHaveAccessibleName("Начните без регистрации");
  await expect(page.getByText("Бесплатно. Без подписок и рекламы. Данные только на", { exact: false }).first()).toBeAttached();
  await expect(page.getByRole("button", { name: "Пропустить" })).toHaveCount(0);
  for (const gone of ["Для себя", "Для пары", "Для семьи", "Название плана"]) await expect(page.getByText(gone)).toHaveCount(0);
  await page.getByRole("button", { name: "Начать", exact: true }).click();

  // Лист чипов поверх «Обзора»: частые отмечены, «Прочего» нет.
  const chips = question(page, CHIPS);
  await expect(chips).toBeVisible();
  await expect(chips.getByRole("heading", { name: CHIPS })).toBeFocused();
  await expect(chips.locator("button[aria-pressed='true']")).toHaveCount(11);
  await chips.getByRole("button", { name: "Одежда и обувь" }).click();
  await chips.getByRole("button", { name: "Питомцы" }).click();
  await expect(chips.getByRole("button", { name: "Одежда и обувь" })).toHaveAttribute("aria-pressed", "false");
  await expect(chips.getByRole("button", { name: "Питомцы" })).toHaveAttribute("aria-pressed", "true");
  // «Своя категория» — существующий лист категории; заведённая встаёт в чипы отмеченной.
  await chips.getByRole("button", { name: "Своя категория" }).click();
  const own = page.getByRole("dialog", { name: "Своя категория" });
  await expect(own).toBeVisible();
  await expect(chips).toBeHidden();
  await own.getByLabel("Название").fill("Рыбалка");
  await own.getByRole("button", { name: "Сохранить категорию" }).click();
  await expect(own).toHaveCount(0);
  await expect(chips.getByRole("button", { name: "Рыбалка" })).toHaveAttribute("aria-pressed", "true");
  await expect(chips.getByRole("button", { name: "Питомцы" })).toHaveAttribute("aria-pressed", "true");
  await chips.getByRole("button", { name: "Готово", exact: true }).click();

  // «Есть ещё места…»: «Да, добавить» — форма счёта с видом «Накопления»; в адресе только вид.
  const accounts = question(page, ACCOUNTS);
  await expect(accounts).toBeVisible();
  await expect(accounts.getByText("Уже есть:")).toBeVisible();
  await accounts.getByRole("button", { name: "Да, добавить" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Новый счёт" })).toBeVisible();
  expect(await page.evaluate(() => window.location.hash)).toBe("#/more/accounts/new?type=savings");
  await expect(page.getByRole("radio", { name: "Накопления" })).toBeChecked();
  // Под листом — «Обзор», куда крестик и «Сохранить» вернут, а не список счетов (ревью R3, LOW-4).
  const under = page.locator(".dir-under");
  await expect(under).toHaveAttribute("inert", "");
  await expect(under.locator(".overview-screen")).toHaveCount(1);
  await expect(under.locator(".accounts-screen")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await page.getByLabel("Название").fill("Вклад");
  await page.getByLabel(/^Сколько сейчас на счёте/u).fill("50000");
  await page.getByRole("dialog", { name: "Новый счёт" }).getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(toast(page, "Счёт «Вклад» заведён.")).toBeVisible();

  // Снова «Обзор» — и следующий вопрос: дни выплат, «Другие числа» — до четырёх.
  const payday = question(page, PAYDAY);
  await expect(payday).toBeVisible();
  await payday.getByRole("radio", { name: "Другие числа" }).click();
  await payday.getByRole("button", { name: "10-го", exact: true }).click();
  await payday.getByRole("button", { name: "25-го", exact: true }).click();
  await expect(payday.getByRole("status")).toHaveText("Отмечено: 10-го, 25-го.");
  await payday.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(payday).toHaveCount(0);

  // Набор на «Обзоре» — с выбором чипов; подсказка на первую трату — кольцо на «Продуктах».
  await expect(tile(page, "Питомцы")).toBeVisible();
  await expect(tile(page, "Рыбалка")).toBeVisible();
  await expect(tile(page, "Одежда и обувь")).toHaveCount(0);
  for (const name of ["Карта", "Наличные", "Вклад", "Зарплата"]) await expect(tile(page, name)).toBeVisible();
  await expect(tile(page, "Карта")).toContainText("0 ₽");
  await expect(tile(page, "Вклад")).toContainText("50 000 ₽");
  await expect(coach(page)).toBeVisible();
  await expect(page.locator(".coach-text")).toHaveText("Коснитесь категории, чтобы записать расход");
  // Кольцо обводит квадрат «Продуктов», а не всю колонку с именем и суммой (макет 05).
  const ring = await page.locator(".coach-ring").boundingBox();
  const food = await tile(page, "Продукты").locator(".tile-square").boundingBox();
  const column = await tile(page, "Продукты").boundingBox();
  expect(ring && food && ring.x <= food.x && ring.y <= food.y && ring.x + ring.width >= food.x + food.width && ring.y + ring.height >= food.y + food.height).toBe(true);
  expect(ring && column && ring.y + ring.height < column.y + column.height).toBe(true);
  // Подсказка не модальна: Tab ходит по экрану, лист вопросов не открыт.
  await expect(page.locator("[aria-modal='true']")).toHaveCount(0);

  // Дни выплат легли в хозяйство: «Ещё» → «План месяца» называет их.
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await expect(page.getByRole("button", { name: /^План месяца/u })).toContainText("выплаты 10-го и 25-го");
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(coach(page)).toBeVisible();

  // Первая запись снимает подсказку навсегда.
  await tile(page, "Продукты").click();
  await expect(entrySheet(page)).toBeVisible();
  await expect(coach(page)).toHaveCount(0);
  await amountField(page).fill("500");
  await submitButton(page).click();
  await expect(toast(page, /Записано: расход 500/u)).toBeVisible();
  await expect(coach(page)).toHaveCount(0);

  // Перезагрузка: ни вопросов, ни подсказки — память на устройстве, в своей базе IndexedDB.
  await page.reload();
  await expect(page.locator(".overview-screen")).toBeVisible();
  await expect(page.locator("[role='dialog']")).toHaveCount(0);
  await expect(coach(page)).toHaveCount(0);
  expect(await firstRunDatabases(page)).toContain("family-budget-first-run");
  expect(await page.evaluate(() => window.localStorage.length + window.sessionStorage.length)).toBe(0);
});

test("отложить можно всё: «Пропустить», Esc и крестик; отложенный не возвращается до недели, «Понятно» снимает подсказку навсегда", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-05T10:00:00"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  // «Пропустить» на первом слайде — туда же, куда «Начать».
  await page.getByRole("button", { name: "Пропустить" }).click();
  await expect(question(page, CHIPS)).toBeVisible();
  // Esc — то же, что крестик: набор остаётся как есть.
  await page.keyboard.press("Escape");
  await expect(question(page, ACCOUNTS)).toBeVisible();
  await question(page, ACCOUNTS).getByRole("button", { name: "Спросить позже" }).click();
  await expect(question(page, PAYDAY)).toBeVisible();
  await question(page, PAYDAY).getByRole("button", { name: "Спросить позже" }).click();
  await expect(page.locator("[role='dialog']")).toHaveCount(0);
  for (const name of ["Продукты", "Одежда и обувь", "Подарки и праздники", "Прочее"]) await expect(tile(page, name)).toBeVisible();
  await expect(tile(page, "Дети")).toHaveCount(0);
  await expect(coach(page)).toBeVisible();

  // Перезагрузка в тот же день: отложенное не спрашивается, подсказка ждёт своего «Понятно».
  await page.reload();
  await expect(page.locator(".overview-screen")).toBeVisible();
  await expect(coach(page)).toBeVisible();
  await expect(page.locator("[role='dialog']")).toHaveCount(0);
  await coach(page).getByRole("button", { name: "Понятно" }).click();
  await expect(coach(page)).toHaveCount(0);
  await expect(tile(page, "Продукты")).toBeFocused();
  await page.reload();
  await expect(page.locator(".overview-screen")).toBeVisible();
  await expect(coach(page)).toHaveCount(0);

  // Через неделю отложенный возвращается — один раз, по порядку; отложенный дважды — больше нет.
  await page.clock.setFixedTime(new Date("2026-10-13T10:00:00"));
  await page.reload();
  await expect(question(page, CHIPS)).toBeVisible();
  await question(page, CHIPS).getByRole("button", { name: "Спросить позже" }).click();
  await expect(question(page, ACCOUNTS)).toBeVisible();
  await question(page, ACCOUNTS).getByRole("button", { name: "Нет, это всё" }).click();
  await expect(question(page, PAYDAY)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[role='dialog']")).toHaveCount(0);
  await page.clock.setFixedTime(new Date("2026-10-28T10:00:00"));
  await page.reload();
  await expect(page.locator(".overview-screen")).toBeVisible();
  await expect(page.locator("[role='dialog']")).toHaveCount(0);
});

test("пример: «Посмотреть на примере» — без вопросов и подсказки на первую трату; данные макетов; закрытая карточка не возвращается", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await startDemo(page);
  await expect(page.locator(".overview-screen")).toBeVisible();
  await expect(page.locator("[role='dialog']")).toHaveCount(0);
  await expect(coach(page)).toHaveCount(0);
  for (const name of ["Карта", "Наличные", "Резерв платежей"]) await expect(tile(page, name)).toBeVisible();
  await expect(tile(page, "Доллары")).toHaveAccessibleName(/^Доллары: остаток 1\s200\s\$/u);

  // Карточки-подсказки в конце «Обзора»: копия и выписка, не больше двух.
  const hints = page.locator(".hint-cards .hint");
  await expect(hints).toHaveCount(2);
  await expect(hints.first()).toContainText("Сделайте копию данных");
  await page.getByRole("button", { name: "Скрыть подсказку «Сделайте копию данных»" }).click();
  await expect(page.getByText("Сделайте копию данных")).toHaveCount(0);
  await expect(hints.first()).toContainText("Загрузите выписку банка");
  await page.reload();
  await expect(page.locator(".overview-screen")).toBeVisible();
  await expect(page.locator(".hint-cards .hint").first()).toContainText("Загрузите выписку банка");
  await expect(page.getByText("Сделайте копию данных")).toHaveCount(0);
  // Действие карточки ведёт туда, где это делают.
  await page.getByRole("button", { name: "Загрузить выписку" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  expect(await page.evaluate(() => window.location.hash)).toBe("#/more/import");

  // «Ещё» → «Планы» (макет v5 10): «План месяца», «Регулярные», «Цели», «Долги», «План на год»;
  // заглушки называют то, что есть.
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  const ledger = page.locator("section", { has: page.getByRole("heading", { name: "Планы" }) });
  await expect(ledger.locator(".list-row strong")).toHaveText(["План месяца", "Регулярные", "Цели", "Долги", "План на год"]);
  await ledger.getByRole("button", { name: /^Цели/u }).click();
  expect(await page.evaluate(() => window.location.hash)).toBe("#/more/goals");
  await expect(page.getByRole("heading", { level: 2, name: "В плане 1 цель" })).toBeVisible();
  await expect(page.locator(".placeholder-list")).toHaveText("Отпуск");
  await page.getByRole("button", { name: "Назад: Ещё", exact: true }).click();
  await ledger.getByRole("button", { name: /^Долги/u }).click();
  await expect(page.locator(".placeholder-list")).toHaveText("Саша");
});

test("только клавиатурой: слайды стрелками и Esc, чипы пробелом, радиогруппа стрелками, «Понятно» — Enter", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(slideHeading(page)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(slideHeading(page)).toHaveAccessibleName(/^Видно, хватит ли до/u);
  await expect(slideHeading(page)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(slideHeading(page)).toHaveAccessibleName(/^Записать трату/u);
  // Esc на слайде — «Пропустить».
  await page.keyboard.press("Escape");

  const chips = question(page, CHIPS);
  await expect(chips.getByRole("heading", { name: CHIPS })).toBeFocused();
  await tabTo(page, /^Спросить позже$/u);
  await tabTo(page, /Продукты/u);
  await page.keyboard.press("Space");
  await expect(chips.getByRole("button", { name: "Продукты" })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Space");
  await expect(chips.getByRole("button", { name: "Продукты" })).toHaveAttribute("aria-pressed", "true");
  await tabTo(page, /^Готово$/u);
  await page.keyboard.press("Enter");

  await expect(question(page, ACCOUNTS)).toBeVisible();
  await tabTo(page, /^Нет, это всё$/u);
  await page.keyboard.press("Enter");

  const payday = question(page, PAYDAY);
  await expect(payday).toBeVisible();
  await tabTo(page, /^5-го и 20-го$/u);
  await page.keyboard.press("ArrowRight");
  await expect(payday.getByRole("radio", { name: "10-го и 25-го" })).toHaveAttribute("aria-checked", "true");
  await expect(payday.getByRole("radio", { name: "10-го и 25-го" })).toBeFocused();
  // В группу — одним Tab: следующий Tab уходит из неё на «Готово».
  await page.keyboard.press("Tab");
  await expect(payday.getByRole("button", { name: "Готово" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(payday).toHaveCount(0);
  // Последний лист закрыт — фокус на заголовке экрана, а не на <body>.
  await expect(page.locator("#main-content h1")).toBeFocused();

  await tabTo(page, /^Понятно$/u, 120);
  await page.keyboard.press("Enter");
  await expect(coach(page)).toHaveCount(0);
  await expect(tile(page, "Продукты")).toBeFocused();
});

/** Нет горизонтальной прокрутки ни у страницы, ни у открытого листа; цели не меньше 48. */
async function expectFits(page: Page, scope: Locator, label: string): Promise<void> {
  const geometry = await scope.evaluate((root, minimum) => {
    const targets = [...root.querySelectorAll<HTMLElement>("button")].filter((element) => element.checkVisibility() && element.getBoundingClientRect().width > 0);
    const undersized = targets
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height < minimum - 0.1 || rect.width < minimum - 0.1)
      .map(({ element, rect }) => `${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)} ${Math.round(rect.width)}×${Math.round(rect.height)}`);
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scope: root.scrollWidth - root.clientWidth,
      undersized,
    };
  }, TOUCH_TARGET_MINIMUM);
  expect(geometry.page, `${label}: горизонтальная прокрутка страницы`).toBeLessThanOrEqual(0);
  expect(geometry.scope, `${label}: горизонтальная прокрутка внутри`).toBeLessThanOrEqual(0);
  expect(geometry.undersized, `${label}: цели меньше ${TOUCH_TARGET_MINIMUM}`).toEqual([]);
}

/** Слова переносятся только с дефисом — ни одного разрыва посередине. */
async function expectWholeWords(page: Page, label: string): Promise<void> {
  const selectors = [
    ".intro h1", ".intro-text", ".intro-actions button", ".intro-skip",
    ".q-head h2", ".q-sub", ".q-chips .chip-face", ".q-options button", ".q-actions button", ".q-mini",
    ".coach-text", ".hint h3", ".hint p", ".empty-state h2", ".empty-text", ".empty-quick .chip-face",
  ].join(", ");
  expect(await nameSplits(page, selectors), `${label}: слово разорвано без дефиса`).toEqual([]);
}

for (const [width, scale] of [[320, 1], [320, 2.7], [390, 2.7]] as const) {
  test(`${width} pt ×${scale}: слайды, вопросы, подсказка и пустые состояния — без горизонтальной прокрутки, без разрывов слов, цели не меньше 48`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: width === 320 ? 640 : 844 });
    await page.goto("/");
    await applyFontScale(page, scale);
    const label = (screen: string) => `${screen}, ${width} ×${scale}`;
    const main = page.locator("main.intro");

    await expect(slideHeading(page)).toBeVisible();
    await expectFits(page, main, label("слайд 1"));
    await expectWholeWords(page, label("слайд 1"));
    await page.getByRole("button", { name: "Дальше", exact: true }).click();
    await page.getByRole("button", { name: "Дальше", exact: true }).click();
    await expect(page.getByRole("img", { name: "Шаг 3 из 3" })).toBeVisible();
    await expectFits(page, main, label("слайд 3"));
    await expectWholeWords(page, label("слайд 3"));
    await page.getByRole("button", { name: "Начать", exact: true }).click();

    for (const [name, answer] of [[CHIPS, "Готово"], [ACCOUNTS, "Нет, это всё"], [PAYDAY, null]] as const) {
      const sheet = question(page, name);
      await expect(sheet).toBeVisible();
      if (name === PAYDAY) await sheet.getByRole("radio", { name: "Другие числа" }).click();
      await expectFits(page, sheet, label(name));
      await expectWholeWords(page, label(name));
      if (answer === null) await page.keyboard.press("Escape");
      else await sheet.getByRole("button", { name: answer, exact: true }).click();
    }
    expect(await softHyphenedNames(page), label("доступные имена")).toEqual([]);

    await expect(coach(page)).toBeVisible();
    await coach(page).scrollIntoViewIfNeeded();
    await expectFits(page, coach(page), label("подсказка"));
    await expectWholeWords(page, label("подсказка"));
    await expectFits(page, page.locator(".hint-cards"), label("карточки"));
    await expectWholeWords(page, label("карточки"));

    await page.getByRole("button", { name: "Ещё", exact: true }).click();
    await page.getByRole("button", { name: /^Метки/u }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Меток пока нет" })).toBeVisible();
    await expectFits(page, page.locator(".empty-state"), label("метки"));
    await expectWholeWords(page, label("метки"));
    // Быстрая метка — одним касанием.
    await page.getByRole("button", { name: "Создать метку «дача»" }).click();
    await expect(page.locator(".manage-status")).toHaveText("Метка «дача» добавлена.");
    await expect(page.getByRole("button", { name: "дача: ни одной операции. Изменить" })).toBeFocused();
    await page.getByRole("button", { name: "Назад: Ещё", exact: true }).click();
    await page.getByRole("button", { name: /^Регулярные/u }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Регулярных пока нет" })).toBeVisible();
    await expectFits(page, page.locator(".empty-state"), label("регулярные"));
    await expectWholeWords(page, label("регулярные"));
    await applyFontScale(page, 1);
  });
}
