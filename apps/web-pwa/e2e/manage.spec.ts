/**
 * Справочники «Учёта» в настоящем браузере (план волны 2, §1.5–§1.8, подволна 2c): счёт в долларах,
 * курс, категория и её лимит, метки. Всё — касаниями экранов «Ещё», без адресов, набранных руками,
 * кроме проверки геометрии; черновик формы спрашивается диалогом приложения, а не системным окном
 * (`fixtures.ts` валит прогон на любом системном окне).
 */
import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import type { BudgetState } from "@family-budget/domain";
import { demoBudget, restoreBudget, withDollarAccount, withDollarExpenseAtOldRate } from "./budgets";
import { applyFontScale } from "./font-scale";
import { LINE_BREAK_LAYOUTS, nameSplits, softHyphenedNames } from "./line-breaks";
import { amountField, entrySheet, goToOverview, leaveDialog, loadDemo, recordExpense, submitButton, tile, toast } from "./sheet";

const TOUCH_TARGET_MINIMUM = 48;

async function openMore(page: Page, row: string): Promise<void> {
  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^${row}`, "u") }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** «554 000 ₽» — в копейки, по цифрам. */
async function totalMinor(page: Page): Promise<number> {
  const text = await page.locator(".overview-total").innerText();
  expect(text).toContain("₽");
  return Number(text.replace(/[^\d]/gu, "")) * 100;
}

test("счёт в долларах заведён в «Ещё», курс задан на экране курсов, расход в $: плитка — в $, итог — в ₽", async ({ page }) => {
  await loadDemo(page);
  // Демо без своего счёта в долларах и без курсов USD: счёт и курс здесь заводятся с нуля.
  await restoreBudget(page, demoBudget());
  await goToOverview(page);
  const before = await totalMinor(page);

  await openMore(page, "Счета");
  await page.getByRole("button", { name: "Новый счёт" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Новый счёт" })).toBeVisible();
  await page.getByLabel("Название").fill("Доллары");
  await page.getByRole("radio", { name: "Наличные" }).check();
  await page.getByLabel("Валюта").selectOption("USD");
  await expect(page.getByText(/^Счёт в USD: каждая операция по нему запишется и в RUB/u)).toBeVisible();
  await page.getByLabel("Начальный остаток, $").fill("500");
  await page.getByRole("radio", { name: "Доллар" }).check();
  await page.getByRole("button", { name: "Завести счёт" }).click();
  await expect(toast(page, "Счёт «Доллары» заведён.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Счета" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Доллары: 500\s\$, наличные · USD\. Изменить$/u })).toBeVisible();
  // В адресе — UUID и список, а не имя.
  expect(await page.evaluate(() => window.location.hash)).toBe("#/more/accounts");

  // Курса ещё нет: экран курсов говорит это и задаёт его.
  await openMore(page, "Курсы валют");
  const usd = page.locator("section.rate-card", { has: page.getByRole("heading", { name: /^USD/u }) });
  await expect(usd.getByText(/^Курса на сегодня нет/u)).toBeVisible();
  await usd.getByRole("button", { name: "Добавить курс USD" }).click();
  await usd.getByRole("textbox", { name: "Сколько ₽ за 1 USD" }).fill("92,50");
  await usd.getByRole("button", { name: "Сохранить курс" }).click();
  await expect(page.locator(".manage-status")).toContainText("Курс USD с ");
  await expect(usd.locator(".rate-now strong")).toHaveText(/^1 USD = 92,50\s₽$/u);
  await expect(page.getByText("Он не переоценивает записанное", { exact: false })).toBeVisible();

  // Расход в долларах: плитка счёта — в $, итог — в ₽ по курсу.
  await goToOverview(page);
  await expect(tile(page, "Доллары")).toHaveAccessibleName(/^Доллары: остаток 500\s\$/u);
  expect(await totalMinor(page)).toBe(before + 46_250_00);
  await tile(page, "Доллары").click();
  await tile(page, "Продукты").click();
  await expect(entrySheet(page)).toBeVisible();
  await amountField(page).fill("10");
  await expect(entrySheet(page).locator(".entry-foreign")).toContainText(/≈ 925\s₽ по курсу 92,50/u);
  await submitButton(page).click();
  await expect(toast(page, /Записано: расход 10\s\$/u)).toBeVisible();
  await expect(tile(page, "Доллары")).toHaveAccessibleName(/^Доллары: остаток 490\s\$/u);
  await expect(page.locator(".overview-total")).not.toContainText("$");
  expect(await totalMinor(page)).toBe(before + 45_325_00);
});

test("категория: имя, иконка, цвет и лимит — одной записью; архив прячет её с «Обзора», операция остаётся в «Операциях»", async ({ page }) => {
  await loadDemo(page);
  await recordExpense(page, { category: "Кафе и доставка", amount: "700" });

  await goToOverview(page);
  await page.getByRole("button", { name: "Изменить категории расходов" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Категории и доходы" })).toBeVisible();
  await page.getByRole("button", { name: "Кафе и доставка: без лимита. Изменить" }).click();
  await page.getByLabel("Название").fill("Кафе");
  await page.getByRole("radio", { name: "Сирень" }).check();
  await page.getByRole("radio", { name: "Бокал" }).check();
  await page.getByLabel(/^Лимит на /u).fill("5000");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(toast(page, "Категория «Кафе» сохранена.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Кафе: лимит 5\s000\s₽ на [а-я]+\. Изменить$/u })).toBeVisible();

  await goToOverview(page);
  const cafe = tile(page, "Кафе");
  await expect(cafe).toHaveAccessibleName(/^Кафе: потрачено 700\s₽ из 5\s000\s₽/u);
  await expect(cafe).toHaveClass(/tone-lilac/u);
  await expect(cafe.locator("use")).toHaveAttribute("href", "#glyph-wine");

  // Архив: вопрос приложения, затем плитки на «Обзоре» нет, а операция — на месте.
  await page.getByRole("button", { name: "Изменить категории расходов" }).click();
  await page.getByRole("button", { name: /^Кафе: лимит/u }).click();
  await page.getByRole("button", { name: "Убрать в архив" }).click();
  const question = page.getByRole("alertdialog", { name: "Убрать «Кафе» в архив?" });
  await expect(question).toContainText("Записанные операции останутся в «Операциях» и отчётах.");
  // Ревью 2c, HIGH-2: вопрос говорит ровно то, что сделает архив, — лимит месяца плана снимется
  // и при возврате не вернётся.
  await expect(question).toContainText(/Лимит на [а-я]+ снимется и при возврате не вернётся — его можно будет задать заново\./u);
  await question.getByRole("button", { name: "Убрать в архив" }).click();
  await expect(page.locator(".manage-status")).toContainText("«Кафе» в архиве.");
  await expect(page.getByRole("button", { name: "Вернуть из архива" })).toBeVisible();
  await goToOverview(page);
  await expect(tile(page, "Кафе")).toHaveCount(0);
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  await expect(page.locator(".history-row .transaction-copy strong", { hasText: /^Кафе$/u })).toHaveCount(1);
});

test("метки: заведена, переименована, в архиве и удалена; используемую удалить нельзя — отказ словами домена", async ({ page }) => {
  await loadDemo(page);
  await openMore(page, "Метки");
  const field = page.getByLabel("Новая метка");
  await field.fill("Ремонт");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.locator(".manage-status")).toHaveText("Метка «Ремонт» добавлена.");
  await field.fill("Отпуск");
  await field.press("Enter");
  await expect(page.locator(".manage-status")).toHaveText("Метка «Отпуск» добавлена.");

  // «Ремонт» — на операции.
  await goToOverview(page);
  await tile(page, "Продукты").click();
  await amountField(page).fill("300");
  await entrySheet(page).getByRole("button", { name: "Ремонт", exact: true }).click();
  await submitButton(page).click();
  await expect(toast(page, /Записано: расход/u)).toBeVisible();

  await openMore(page, "Метки");
  const repair = page.locator(".tag-row", { hasText: "Ремонт" });
  await expect(repair).toContainText("1 операция");
  await page.getByRole("button", { name: "Удалить метку «Ремонт»" }).click();
  await expect(repair.getByRole("alert")).toHaveText("Метка стоит на операциях. Её можно убрать в архив: на операциях она останется.");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(repair).toBeVisible();

  // «Отпуск»: переименование на месте, архив, удаление неиспользуемой — с вопросом.
  await page.getByRole("button", { name: "Переименовать метку «Отпуск»" }).click();
  const rename = page.getByLabel("Новое имя метки «Отпуск»");
  await rename.fill("Отпуск 2026");
  await rename.press("Enter");
  await expect(page.locator(".manage-status")).toHaveText("Метка «Отпуск» теперь «Отпуск 2026».");
  await page.getByRole("button", { name: "Убрать метку «Отпуск 2026» в архив" }).click();
  const archived = page.locator("section", { has: page.getByRole("heading", { name: "В архиве" }) });
  await expect(archived.locator(".tag-row", { hasText: "Отпуск 2026" })).toBeVisible();
  await page.getByRole("button", { name: "Удалить метку «Отпуск 2026»" }).click();
  const question = page.getByRole("alertdialog", { name: "Удалить метку «Отпуск 2026»?" });
  await question.getByRole("button", { name: "Удалить метку" }).click();
  await expect(page.locator(".manage-status")).toHaveText("Метка «Отпуск 2026» удалена.");
  await expect(page.locator(".tag-row", { hasText: "Отпуск 2026" })).toHaveCount(0);
});

test("форма счёта только с клавиатуры: поля, радиогруппы стрелками, отметка пробелом, запись — Enter", async ({ page }) => {
  await loadDemo(page);
  await openMore(page, "Счета");
  await page.getByRole("button", { name: "Новый счёт" }).click();
  const heading = page.getByRole("heading", { level: 1, name: "Новый счёт" });
  await expect(heading).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.locator("#account-name")).toBeFocused();
  await page.keyboard.type("Кошелёк");
  await page.keyboard.press("Tab");
  await expect(page.locator("#account-type-current")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#account-type-cash")).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(page.locator("#account-currency")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#account-opening")).toBeFocused();
  await page.keyboard.type("1250,50");
  await page.keyboard.press("Tab");
  await expect(page.locator("#account-negative")).toBeFocused();
  await page.keyboard.press("Tab");
  // Цвет: Tab входит в группу один раз — на «Авто», стрелка выбирает «Мята».
  await expect(page.getByRole("radio", { name: "Авто" }).first()).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Мята" })).toBeChecked();
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Карта", exact: true })).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(page.locator("#account-include")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.locator("#account-include")).not.toBeChecked();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Завести счёт" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(toast(page, "Счёт «Кошелёк» заведён.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Счета" })).toBeFocused();
  await expect(page.getByRole("button", { name: /^Кошелёк: 1\s250,50\s₽, наличные · вне итога\. Изменить$/u })).toBeVisible();
});

test("набранная форма при уходе спрашивает диалогом приложения: «Продолжить ввод» оставляет, «Не сохранять» уводит", async ({ page }) => {
  await loadDemo(page);
  await openMore(page, "Счета");
  await page.getByRole("button", { name: /^Карта: /u }).click();
  await page.getByLabel("Название").fill("Зарплатная");
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(leaveDialog(page)).toContainText("правка счёта «Карта»");
  await leaveDialog(page).getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(page.getByLabel("Название")).toHaveValue("Зарплатная");
  // Системное «Назад» — тот же вопрос.
  await page.goBack();
  await expect(leaveDialog(page)).toBeVisible();
  await leaveDialog(page).getByRole("button", { name: "Не сохранять" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Счета" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Карта: /u })).toBeVisible();
});

test("на 320 pt и при ×2.7 справочники не выезжают за экран, а их цели — не меньше 48", async ({ page }) => {
  test.setTimeout(240_000);
  await loadDemo(page);
  // Счёт в долларах с двумя курсами (история курса — две строки) и одна метка — чтобы на экранах
  // было что мерить (ревью 2c, MEDIUM-2: прежде здесь заводилась одна метка).
  await restoreBudget(page, withDollarExpenseAtOldRate(demoBudget()));
  await openMore(page, "Метки");
  await page.getByLabel("Новая метка").fill("Подработка для отпуска и дачи");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.locator(".tag-row")).toHaveCount(1);
  await openMore(page, "Счета");
  const mainId = await (async () => {
    await page.getByRole("button", { name: /^Карта: /u }).click();
    const hash = await page.evaluate(() => window.location.hash);
    expect(hash).toMatch(/^#\/more\/accounts\/[0-9a-f-]{36}$/u);
    return hash;
  })();
  await openMore(page, "Счета");
  await page.getByRole("button", { name: /^Доллары: /u }).click();
  const dollarsId = await page.evaluate(() => window.location.hash);
  expect(dollarsId).toMatch(/^#\/more\/accounts\/[0-9a-f-]{36}$/u);
  await openMore(page, "Категории и доходы");
  await page.getByRole("button", { name: /^Продукты: /u }).click();
  const categoryHash = await page.evaluate(() => window.location.hash);
  expect(categoryHash).toMatch(/^#\/more\/categories\/[0-9a-f-]{36}\?type=expense$/u);

  const screens: readonly (readonly [string, string])[] = [
    ["#/more", "more"], ["#/more/accounts", "accounts"], ["#/more/accounts/new", "account-new"], [mainId, "account"], [dollarsId, "account"], ["#/more/rates", "rates"],
    ["#/more/categories?type=expense", "categories"], ["#/more/categories?type=income", "categories"], [categoryHash, "category"], ["#/more/tags", "tags"],
  ];
  for (const [width, height, scale] of [[320, 568, 1], [320, 568, 2.7], [390, 844, 2.7]] as const) {
    await applyFontScale(page, scale);
    await page.setViewportSize({ width, height });
    for (const [hash, screen] of screens) {
      await page.evaluate((target) => { window.location.hash = target; }, hash);
      await expect(page.locator(".route-screen")).toHaveAttribute("data-screen", screen);
      expect(await page.evaluate(() => window.location.hash)).toBe(hash);
      const label = `${hash} ${width}×${height} ×${scale}`;
      const measured = await page.evaluate((minimum) => {
        const root = document.querySelector(".route-screen");
        const targets = [...(root?.querySelectorAll<HTMLElement>("button, select, input:not([type='radio']):not([type='checkbox']):not([type='file']), label.picker-option, .option-grid label, label.check-row") ?? [])]
          .filter((element) => element.checkVisibility());
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          undersized: targets
            .map((element) => ({ name: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40), rect: element.getBoundingClientRect() }))
            .filter(({ rect }) => rect.width < minimum - 0.5 || rect.height < minimum - 0.5)
            .map(({ name, rect }) => `${name} ${Math.round(rect.width)}×${Math.round(rect.height)}`),
          targets: targets.length,
        };
      }, TOUCH_TARGET_MINIMUM);
      expect(measured.scrollWidth, `${label}: без горизонтальной прокрутки`).toBeLessThanOrEqual(measured.clientWidth);
      expect(measured.targets, `${label}: цели найдены`).toBeGreaterThan(1);
      expect(measured.undersized, `${label}: цели не меньше ${TOUCH_TARGET_MINIMUM}`).toEqual([]);
      if (screen === "rates") await expectReadableRateHistory(page, label, scale > 1);
    }
  }
  await applyFontScale(page, 1);
});

/**
 * История курса читается строками, а не столбцом букв (ревью 2c, MEDIUM-2: на 320 pt при ×2.7
 * день и курс стояли по букве в строке рядом с «Удалить»): слова целы, у дня и курса — не меньше
 * четырёх кеглей ширины, а при крупном шрифте «Удалить» — под курсом, а не рядом.
 */
async function expectReadableRateHistory(page: Page, label: string, large: boolean): Promise<void> {
  await expect(page.locator(".rate-history > li"), label).toHaveCount(2);
  expect(await nameSplits(page, ".rate-history-day, .rate-history-value, .rate-now > span"), `${label}: слова и числа курса целы`).toEqual([]);
  const rows = await page.locator(".rate-history > li").evaluateAll((items) => items.map((item) => {
    const box = (selector: string) => item.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const em = (selector: string) => parseFloat(getComputedStyle(item.querySelector<HTMLElement>(selector)!).fontSize);
    return {
      day: box(".rate-history-day").width / em(".rate-history-day"),
      value: box(".rate-history-value").width / em(".rate-history-value"),
      buttonTop: box(".quiet-button").top,
      valueBottom: box(".rate-history-value").bottom,
    };
  }));
  for (const row of rows) {
    expect(row.day, `${label}: день — строкой`).toBeGreaterThanOrEqual(4);
    expect(row.value, `${label}: курс — строкой`).toBeGreaterThanOrEqual(4);
    if (large) expect(row.buttonTop, `${label}: «Удалить» — под курсом`).toBeGreaterThanOrEqual(row.valueBottom - 1);
  }
}

/** Демо, где три расходные категории и источник дохода названы длинно — как их и заводят семьи. */
function withLongCategoryNames(state: BudgetState): BudgetState {
  const names = ["Благотворительность", "Сверхъестественный", "Strengths"];
  const expense = state.categories.filter((item) => item.type === "expense" && item.active).slice(0, names.length);
  const income = state.categories.find((item) => item.type === "income" && item.active);
  const renamed = new Map<string, string>([...expense.map((item, index) => [item.id, names[index]!] as const), ...(income ? [[income.id, "Дивиденды по иностранным акциям"] as const] : [])]);
  return { ...state, categories: state.categories.map((item) => (renamed.has(item.id) ? { ...item, name: renamed.get(item.id)! } : item)) };
}

test("имена на плитках справочника и на плитке-образце не рвутся посреди слова, а доступные имена — без мягких переносов", async ({ page }) => {
  // Контракт переносов 2b (раунд 3): видимое имя плитки — с мягкими переносами и скрыто от
  // читающих с экрана, доступное имя — чистое. Здесь — сетка «Категорий и доходов» и образец над
  // формой категории.
  test.setTimeout(240_000);
  await loadDemo(page);
  await restoreBudget(page, withLongCategoryNames(demoBudget()));
  await openMore(page, "Категории и доходы");
  await expect(page.getByRole("button", { name: /^Strengths: /u })).toBeVisible();
  for (const [width, scale] of LINE_BREAK_LAYOUTS) {
    await applyFontScale(page, scale);
    await page.setViewportSize({ width, height: 844 });
    expect(await nameSplits(page, ".categories-screen .tile-name"), `расходы ${width} pt ×${scale}`).toEqual([]);
  }
  await applyFontScale(page, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await softHyphenedNames(page), "расходы").toEqual([]);

  await page.getByRole("button", { name: "Доходы", exact: true }).click();
  await expect(page.getByRole("button", { name: "Дивиденды по иностранным акциям. Изменить" })).toBeVisible();
  for (const [width, scale] of LINE_BREAK_LAYOUTS) {
    await applyFontScale(page, scale);
    await page.setViewportSize({ width, height: 844 });
    expect(await nameSplits(page, ".categories-screen .tile-name"), `доходы ${width} pt ×${scale}`).toEqual([]);
  }
  await applyFontScale(page, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await softHyphenedNames(page), "доходы").toEqual([]);

  await page.getByRole("button", { name: "Расходы", exact: true }).click();
  await page.getByRole("button", { name: /^Благотворительность: /u }).click();
  // Образец набран с мягкими переносами — и скрыт от читающих с экрана; имя без них — то же.
  const preview = await page.locator(".manage-preview .tile-name").evaluate((name) => name.textContent ?? "");
  expect(preview).toContain("\u00ad");
  expect(preview.replace(/\u00ad/gu, "")).toBe("Благотворительность");
  await expect(page.locator(".manage-preview")).toHaveAttribute("aria-hidden", "true");
  for (const [width, scale] of LINE_BREAK_LAYOUTS) {
    await applyFontScale(page, scale);
    await page.setViewportSize({ width, height: 844 });
    expect(await nameSplits(page, ".manage-preview .tile-name"), `образец ${width} pt ×${scale}`).toEqual([]);
  }
  await applyFontScale(page, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await softHyphenedNames(page), "форма категории").toEqual([]);
});

test("поправка курса в тот же день становится текущей — и в истории она одна", async ({ page }) => {
  // Ревью 2c, HIGH-1: шесть поправок курса USD на сегодня «записывались», а текущим оставался то
  // прежний, то новый — между записями одного дня выбирал больший идентификатор.
  await loadDemo(page);
  await restoreBudget(page, withDollarAccount(demoBudget()));
  await openMore(page, "Курсы валют");
  const usd = page.locator("section.rate-card", { has: page.getByRole("heading", { name: /^USD/u }) });
  for (const value of ["90,00", "91,00", "92,00", "93,00", "94,00", "95,00"]) {
    await usd.getByRole("button", { name: "Добавить курс USD" }).click();
    await usd.getByRole("textbox", { name: "Сколько ₽ за 1 USD" }).fill(value);
    await usd.getByRole("button", { name: "Сохранить курс" }).click();
    await expect(usd.locator(".rate-now strong"), value).toHaveText(new RegExp(`^1 USD = ${value}\\s₽$`, "u"));
    await expect(usd.locator(".rate-history > li"), value).toHaveCount(1);
  }
  await expect(page.locator(".manage-status")).toHaveText(/^Курс USD на \d+\s[а-я]+ исправлен: был 94,00, стал 95,00\.$/u);
});

test("категория и источник дохода: «Назад», системное «Назад» и «Сохранить» ведут к своему списку — и по ссылке тоже", async ({ page }) => {
  // Ревью 2c, MEDIUM-1: родитель категории в истории был всегда списком расходов — источник дохода
  // по «Назад» открывал расходы, а «Сохранить» копил записи над формой.
  await loadDemo(page);
  const list = page.getByRole("heading", { level: 1, name: "Категории и доходы" });
  const more = page.getByRole("heading", { level: 1, name: /^Ещё/u });
  const shows = (kind: "Расходы" | "Доходы") => expect(page.getByRole("button", { name: kind, exact: true })).toHaveAttribute("aria-pressed", "true");
  const address = () => page.evaluate(() => window.location.hash);
  const openCategories = async () => {
    await page.getByRole("button", { name: /^Категории и доходы/u }).click();
    await expect(list).toBeVisible();
  };

  // Расходы: системное «Назад» с категории — список расходов, ещё раз — «Ещё».
  await openMore(page, "Категории и доходы");
  await page.getByRole("button", { name: /^Продукты: /u }).click();
  await expect(page.getByRole("button", { name: "К категориям" })).toBeVisible();
  await page.goBack();
  await expect(list).toBeVisible();
  await shows("Расходы");
  // «Сохранить» — к списку расходов, и над ним в истории нет формы: «Назад» ведёт в «Ещё».
  await page.getByRole("button", { name: /^Продукты: /u }).click();
  await page.getByLabel("Название").fill("Продукты и хозтовары");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(list).toBeVisible();
  await shows("Расходы");
  await page.goBack();
  await expect(more).toBeAttached();

  // Доходы: системное «Назад», «К источникам дохода» и «Сохранить» — к списку доходов.
  await openCategories();
  await page.getByRole("button", { name: "Доходы", exact: true }).click();
  await shows("Доходы");
  const source = page.locator(".categories-screen .tile").first();
  await source.click();
  await expect(page.getByRole("button", { name: "К источникам дохода" })).toBeVisible();
  await page.goBack();
  await expect(list).toBeVisible();
  await shows("Доходы");
  expect(await address()).toBe("#/more/categories?type=income");
  await source.click();
  await page.getByRole("button", { name: "К источникам дохода" }).click();
  await shows("Доходы");
  await page.goBack();
  await expect(more).toBeAttached();
  await openCategories();
  await page.getByRole("button", { name: "Доходы", exact: true }).click();
  await source.click();
  const sourceAddress = await address();
  expect(sourceAddress).toMatch(/^#\/more\/categories\/[0-9a-f-]{36}\?type=income$/u);
  const name = page.getByLabel("Название");
  await name.fill(`${await name.inputValue()} 2`);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(list).toBeVisible();
  await shows("Доходы");
  await page.goBack();
  await expect(more).toBeAttached();

  // По ссылке — новая загрузка страницы, а не переход по якорю: под источником дохода в истории —
  // список доходов.
  await page.goto("about:blank");
  await page.goto(`/${sourceAddress}`);
  await expect(page.getByRole("button", { name: "К источникам дохода" })).toBeVisible();
  await page.goBack();
  await expect(list).toBeVisible();
  await shows("Доходы");
  // Старая ссылка без вида списка: адрес сам называет вид, и «назад» — к доходам.
  await page.goto("about:blank");
  await page.goto(`/${sourceAddress.replace(/\?type=income$/u, "")}`);
  await expect.poll(address).toBe(sourceAddress);
  await page.getByRole("button", { name: "К источникам дохода" }).click();
  await expect(list).toBeVisible();
  await shows("Доходы");
});

/** Где фокус: «BODY» — потерян; иначе доступное имя (`aria-label`, подпись поля или текст). */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (element === null || element === document.body) return "BODY";
    const label = element.getAttribute("aria-label") ?? (element as HTMLInputElement).labels?.[0]?.textContent ?? element.textContent ?? "";
    return `${element.tagName.toLowerCase()}: ${label.replace(/\s+/gu, " ").trim()}`;
  });
}

/** Нажать кнопку с клавиатуры — как человек без мыши: фокус на неё и Enter. */
async function pressWithKeyboard(page: Page, name: string | RegExp, scope: Page | ReturnType<Page["locator"]> = page): Promise<void> {
  await scope.getByRole("button", { name, exact: typeof name === "string" }).focus();
  await page.keyboard.press("Enter");
}

test("фокус после действий на месте — на том, что их продолжает, а не на <body>", async ({ page }) => {
  // Ревью 2c, MEDIUM-3: после «Изменить», «Отмена», «В архив», «Убрать в архив», записи и удаления
  // курса нажатая кнопка исчезала, и фокус падал на <body>.
  await loadDemo(page);
  await restoreBudget(page, withDollarAccount(demoBudget()));

  // Метка: «Изменить» — в поле имени; «Отмена» и «Сохранить» — обратно на «Изменить»; «В архив» —
  // на «Вернуть», «Вернуть» — на «В архив».
  await openMore(page, "Метки");
  await page.getByLabel("Новая метка").fill("Ремонт");
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await expect(page.locator(".tag-row")).toHaveCount(1);
  await pressWithKeyboard(page, "Переименовать метку «Ремонт»");
  await expect.poll(() => focused(page)).toBe("input: Новое имя метки «Ремонт»");
  await pressWithKeyboard(page, "Отмена");
  await expect.poll(() => focused(page)).toBe("button: Переименовать метку «Ремонт»");
  await page.keyboard.press("Enter");
  await expect.poll(() => focused(page)).toBe("input: Новое имя метки «Ремонт»");
  await page.keyboard.press("End");
  await page.keyboard.type(" кухни");
  await page.keyboard.press("Enter");
  await expect(page.locator(".manage-status")).toHaveText("Метка «Ремонт» теперь «Ремонт кухни».");
  await expect.poll(() => focused(page)).toBe("button: Переименовать метку «Ремонт кухни»");
  await pressWithKeyboard(page, "Убрать метку «Ремонт кухни» в архив");
  await expect(page.locator(".manage-status")).toContainText("в архиве");
  await expect.poll(() => focused(page)).toBe("button: Вернуть метку «Ремонт кухни» из архива");
  await page.keyboard.press("Enter");
  await expect(page.locator(".manage-status")).toContainText("снова в выборе");
  await expect.poll(() => focused(page)).toBe("button: Убрать метку «Ремонт кухни» в архив");

  // Счёт: «Убрать в архив» — на «Вернуть из архива» и обратно.
  await openMore(page, "Счета");
  await page.getByRole("button", { name: /^Доллары: /u }).click();
  await pressWithKeyboard(page, "Убрать в архив");
  await expect(page.locator(".manage-status")).toContainText("в архиве");
  await expect.poll(() => focused(page)).toBe("button: Вернуть из архива");
  await page.keyboard.press("Enter");
  await expect(page.locator(".manage-status")).toContainText("снова среди активных");
  await expect.poll(() => focused(page)).toBe("button: Убрать в архив");
  // «Вернуть» в списке: строка уходит из архива в активные — фокус на неё.
  await page.keyboard.press("Enter");
  await expect(page.locator(".manage-status")).toContainText("в архиве");
  await page.getByRole("button", { name: "К счетам" }).click();
  await pressWithKeyboard(page, "Вернуть «Доллары» из архива");
  await expect(page.locator(".manage-status")).toContainText("снова среди активных");
  await expect.poll(() => focused(page)).toMatch(/^button: Доллары: /u);

  // Категория: вопрос приложения, «Убрать в архив» в нём — на «Вернуть из архива» и обратно.
  await openMore(page, "Категории и доходы");
  await page.getByRole("button", { name: /^Кафе и доставка: /u }).click();
  await pressWithKeyboard(page, "Убрать в архив");
  await pressWithKeyboard(page, "Убрать в архив", page.getByRole("alertdialog"));
  await expect(page.locator(".manage-status")).toContainText("в архиве");
  await expect.poll(() => focused(page)).toBe("button: Вернуть из архива");
  await page.keyboard.press("Enter");
  await expect(page.locator(".manage-status")).toContainText("снова на «Обзоре»");
  await expect.poll(() => focused(page)).toBe("button: Убрать в архив");
  await page.keyboard.press("Enter");
  await pressWithKeyboard(page, "Убрать в архив", page.getByRole("alertdialog"));
  await expect(page.locator(".manage-status")).toContainText("в архиве");
  await page.getByRole("button", { name: "К категориям" }).click();
  await pressWithKeyboard(page, "Вернуть «Кафе и доставка» из архива");
  await expect(page.locator(".manage-status")).toContainText("снова на «Обзоре»");
  await expect.poll(() => focused(page)).toMatch(/^button: Кафе и доставка: /u);

  // Курс: после записи и после удаления — на заголовок карточки валюты.
  await openMore(page, "Курсы валют");
  const usd = page.locator("section.rate-card", { has: page.getByRole("heading", { name: /^USD/u }) });
  // «Отмена» — обратно на кнопку, что открыла группу.
  await pressWithKeyboard(page, "Добавить курс USD", usd);
  await pressWithKeyboard(page, "Отмена", usd);
  await expect.poll(() => focused(page)).toBe("button: Добавить курс USD");
  await page.keyboard.press("Enter");
  await usd.getByRole("textbox", { name: "Сколько ₽ за 1 USD" }).fill("92,50");
  await page.keyboard.press("Enter");
  await expect(page.locator(".manage-status")).toContainText("записан");
  await expect.poll(() => focused(page)).toBe("h2: USD Доллар США");
  await pressWithKeyboard(page, /^Удалить курс USD от /u, usd);
  await pressWithKeyboard(page, "Удалить курс", page.getByRole("alertdialog"));
  await expect(page.locator(".manage-status")).toContainText("удалён");
  await expect.poll(() => focused(page)).toBe("h2: USD Доллар США");
});

test("отказ записи оставляет черновик формы несохранённым: уход спрашивает (счёт и категория)", async ({ page }) => {
  // Ревью 2c, LOW-3: без `saving.fail(ticket)` отказ домена в записи оставлял форму «записывается»,
  // и уход с набранным больше не спрашивал. Отказ здесь — внутри записи, а не до неё: имя занято.
  await loadDemo(page);
  const asksAbout = async (label: string) => {
    await page.getByRole("button", { name: "Обзор", exact: true }).click();
    const dialog = leaveDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(label);
    await dialog.getByRole("button", { name: "Продолжить ввод" }).click();
    await expect(dialog).toHaveCount(0);
  };

  await openMore(page, "Счета");
  await page.getByRole("button", { name: "Новый счёт" }).click();
  await page.getByLabel("Название").fill("Карта");
  await page.getByRole("button", { name: "Завести счёт" }).click();
  await expect(page.getByText("Активный счёт с таким названием уже есть.")).toBeVisible();
  await asksAbout("новый счёт");
  await expect(page.getByLabel("Название")).toHaveValue("Карта");

  await page.getByRole("button", { name: "Ещё", exact: true }).click();
  await leaveDialog(page).getByRole("button", { name: "Не сохранять" }).click();
  await page.getByRole("button", { name: /^Категории и доходы/u }).click();
  await page.getByRole("button", { name: /^Продукты: /u }).click();
  await page.getByLabel("Название").fill("Транспорт");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Активная категория с таким названием уже существует.")).toBeVisible();
  await asksAbout("правка категории «Продукты»");
  await expect(page.getByLabel("Название")).toHaveValue("Транспорт");
});

test("набранный курс не пропадает молча: другая «Добавить курс» сначала спрашивает", async ({ page }) => {
  // Ревью 2c, LOW-8: из группы «Новый курс» сверху касание «Добавить курс USD» в карточке
  // открывало другую группу, и набранное число пропадало без слова.
  await loadDemo(page);
  await restoreBudget(page, withDollarAccount(demoBudget()));
  await openMore(page, "Курсы валют");
  await page.locator("#rates-add-top").click();
  const top = page.locator(".rate-quick").first();
  await top.getByRole("textbox", { name: /^Сколько ₽ за / }).fill("91,00");
  const usd = page.locator("section.rate-card", { has: page.getByRole("heading", { name: /^USD/u }) });
  await usd.getByRole("button", { name: "Добавить курс USD" }).click();
  const question = page.getByRole("alertdialog", { name: "Не записывать набранный курс?" });
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(question).toHaveCount(0);
  await expect(top.getByRole("textbox", { name: /^Сколько ₽ за / })).toHaveValue("91,00");
  await usd.getByRole("button", { name: "Добавить курс USD" }).click();
  await question.getByRole("button", { name: "Не записывать" }).click();
  await expect(usd.locator(".rate-quick")).toBeVisible();
  await expect(page.locator("#rates-add-top")).toBeVisible();
  await expect(usd.getByRole("textbox", { name: "Сколько ₽ за 1 USD" })).toHaveValue("");
  // Пустая группа не спрашивает: другая открывается сразу.
  await page.locator("#rates-add-top").click();
  await expect(question).toHaveCount(0);
  await expect(usd.locator(".rate-quick")).toHaveCount(0);
});
