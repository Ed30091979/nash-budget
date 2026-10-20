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

/** Меток нет — пустое состояние (дизайн v5, 14): «Создать метку» открывает лист «Новая метка», фокус — в поле. */
async function startTag(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 2, name: "Меток пока нет" })).toBeVisible();
  await page.getByRole("button", { name: "Создать метку", exact: true }).click();
  await expect(tagSheet(page, "Новая метка")).toBeVisible();
  await expect(page.locator("#tag-new-name")).toBeFocused();
}

/** Лист метки (R3): «Новая метка» по «+» и «Метка» по касанию строки. */
function tagSheet(page: Page, title: "Новая метка" | "Метка") {
  return page.getByRole("dialog", { name: title });
}

/** Новая метка листом: «+» в строке заголовка, имя, «Сохранить» или Enter. */
async function addTag(page: Page, name: string, submit: "button" | "enter" = "button"): Promise<void> {
  await page.getByRole("button", { name: "Новая метка", exact: true }).click();
  const sheet = tagSheet(page, "Новая метка");
  await expect(page.locator("#tag-new-name")).toBeFocused();
  await sheet.getByLabel("Название").fill(name);
  if (submit === "enter") await page.keyboard.press("Enter");
  else await sheet.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(sheet).toHaveCount(0);
}

/** Лист счёта или категории — модальный диалог маршрута поверх своего списка. */
function formSheet(page: Page) {
  return page.locator("section.dir-sheet[role='dialog']");
}

/** Карточка валюты на «Курсах валют» — по её названию. */
function rateCard(page: Page, name: string) {
  return page.locator("section.dir-rate", { has: page.getByRole("heading", { name, exact: true }) });
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
  // Лист с разделами поверх списка (макет 12): заголовок листа — `h1` маршрута.
  await expect(formSheet(page)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Новый счёт" })).toBeVisible();
  await page.getByLabel("Название").fill("Доллары");
  await page.getByRole("radio", { name: "Наличные" }).check();
  // Валюта — чипом, а не системным списком.
  await expect(formSheet(page).locator("select")).toHaveCount(0);
  await page.getByRole("radio", { name: "Доллар — USD" }).click();
  await expect(page.getByRole("radio", { name: "Доллар — USD" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/^Счёт в USD: операции по нему запишутся и в RUB/u)).toBeVisible();
  await page.getByLabel("Сколько сейчас на счёте, $").fill("500");
  // Курса ещё нет — пересчёта в рубли нет, и лист говорит это словами.
  await expect(page.locator("#account-opening-estimate")).toHaveText(/^Курса USD на сегодня нет/u);
  await page.getByRole("radio", { name: "Доллар", exact: true }).check();
  await formSheet(page).getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(toast(page, "Счёт «Доллары» заведён.")).toBeVisible();
  await expect(formSheet(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Счета" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Доллары: 500\s\$, наличные · USD\. Изменить$/u })).toBeVisible();
  // Счёт без курса назван под итогом, а не выброшен молча.
  await expect(page.locator(".dir-total")).toContainText("«Доллары» — нет курса USD");
  // В адресе — UUID и список, а не имя.
  expect(await page.evaluate(() => window.location.hash)).toBe("#/more/accounts");

  // Курса ещё нет: экран курсов говорит это и задаёт его.
  await openMore(page, "Курсы валют");
  const usd = rateCard(page, "Доллар США");
  await expect(usd.getByText(/^Курса на сегодня нет/u)).toBeVisible();
  await usd.getByRole("button", { name: "Добавить курс USD" }).click();
  await usd.getByRole("textbox", { name: "Сколько ₽ за 1 USD" }).fill("92,50");
  await usd.getByRole("button", { name: "Сохранить курс" }).click();
  await expect(page.locator(".manage-status")).toContainText("Курс USD с ");
  await expect(usd.locator(".dir-rate-now")).toHaveText(/^1 \$ = 92,50\s₽$/u);
  await expect(page.getByText("Курс вводите сами. Уже записанное не пересчитывается.", { exact: true })).toBeVisible();
  // Теперь «Всего на счетах» оценивает доллары по курсу и называет его; строка — с пересчётом.
  await openMore(page, "Счета");
  await expect(page.locator(".dir-total")).toContainText(/доллар — по курсу 92,50\s₽ от /u);
  await expect(page.getByRole("button", { name: /^Доллары: 500\s\$ \(≈ 46\s250\s₽\), наличные · USD\. Изменить$/u })).toBeVisible();

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
  await expect(page.getByRole("heading", { level: 1, name: "Категория" })).toBeVisible();
  // Группа — карточками 2×2, а не системным списком (макет 13).
  await expect(formSheet(page).locator("select")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Личное и досуг" })).toBeChecked();
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
  // Тон и глиф — у квадрата плитки (5.0): квадрат окрашен тоном, глиф стоит прямо на нём.
  await expect(cafe.locator(".tile-square")).toHaveClass(/tone-lilac/u);
  await expect(cafe.locator(".tile-square > svg use")).toHaveAttribute("href", "#glyph-wine");

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
  await expect(formSheet(page).locator(".sheet-status")).toContainText("«Кафе» в архиве.");
  await expect(page.getByRole("button", { name: "Вернуть из архива" })).toBeVisible();
  // Лист — модальный: навигация под ним выключена; выходят крестиком.
  await formSheet(page).getByRole("button", { name: "Закрыть" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Категории и доходы" })).toBeVisible();
  await goToOverview(page);
  await expect(tile(page, "Кафе")).toHaveCount(0);
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  await expect(page.locator(".history-row .transaction-copy strong", { hasText: /^Кафе$/u })).toHaveCount(1);
});

test("метки: заведена, переименована, в архиве и удалена; используемую удалить нельзя — отказ словами домена", async ({ page }) => {
  await loadDemo(page);
  // Демо без своих меток: справочник заводится с нуля.
  await restoreBudget(page, demoBudget());
  await openMore(page, "Метки");
  await startTag(page);
  const first = tagSheet(page, "Новая метка");
  await first.getByLabel("Название").fill("Ремонт");
  await first.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(first).toHaveCount(0);
  await expect(page.locator(".manage-status")).toHaveText("Метка «Ремонт» добавлена.");
  // Лист закрылся — фокус на строке новой метки.
  await expect(page.getByRole("button", { name: "Ремонт: ни одной операции. Изменить" })).toBeFocused();
  await addTag(page, "Отпуск", "enter");
  await expect(page.locator(".manage-status")).toHaveText("Метка «Отпуск» добавлена.");

  // «Ремонт» — на операции.
  await goToOverview(page);
  await tile(page, "Продукты").click();
  await amountField(page).fill("300");
  await entrySheet(page).getByRole("button", { name: "Ремонт", exact: true }).click();
  await submitButton(page).click();
  await expect(toast(page, /Записано: расход/u)).toBeVisible();

  await openMore(page, "Метки");
  const repair = page.getByRole("button", { name: "Ремонт: 1 операция. Изменить" });
  await expect(repair).toBeVisible();
  await repair.click();
  const sheet = tagSheet(page, "Метка");
  await sheet.getByRole("button", { name: "Удалить метку «Ремонт»" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Метка стоит на операциях. Её можно убрать в архив: на операциях она останется.");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(sheet).toBeVisible();
  // Пустой лист закрывается сразу — фокус на строку, с которой его открыли.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(repair).toBeFocused();

  // «Отпуск»: переименование листом, архив, удаление неиспользуемой — с вопросом.
  await page.getByRole("button", { name: /^Отпуск: / }).click();
  const rename = sheet.getByLabel("Название");
  await expect(rename).toBeFocused();
  await rename.fill("Отпуск 2026");
  await rename.press("Enter");
  await expect(sheet).toHaveCount(0);
  await expect(page.locator(".manage-status")).toHaveText("Метка «Отпуск» теперь «Отпуск 2026».");
  await page.getByRole("button", { name: /^Отпуск 2026: / }).click();
  await sheet.getByRole("button", { name: "Убрать метку «Отпуск 2026» в архив" }).click();
  await expect(sheet.locator(".sheet-status")).toHaveText("Метка «Отпуск 2026» в архиве; на операциях она осталась.");
  await page.keyboard.press("Escape");
  const archived = page.locator("section", { has: page.getByRole("heading", { name: "В архиве" }) });
  await expect(archived.getByRole("button", { name: /^Отпуск 2026: / })).toBeVisible();
  await archived.getByRole("button", { name: /^Отпуск 2026: / }).click();
  await sheet.getByRole("button", { name: "Удалить метку «Отпуск 2026»" }).click();
  const question = page.getByRole("alertdialog", { name: "Удалить метку «Отпуск 2026»?" });
  await question.getByRole("button", { name: "Удалить метку" }).click();
  await expect(page.locator(".manage-status")).toHaveText("Метка «Отпуск 2026» удалена.");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Отпуск 2026: / })).toHaveCount(0);
});

test("лист метки: набранное не пропадает молча — крестик и Esc спрашивают, «Не сохранять» закрывает, архивная тёзка — к возврату", async ({ page }) => {
  await loadDemo(page);
  await restoreBudget(page, demoBudget());
  await openMore(page, "Метки");
  await page.getByRole("button", { name: "Создать метку «дача»" }).click();
  await expect(page.getByRole("button", { name: "дача: ни одной операции. Изменить" })).toBeFocused();
  // Всё вокруг листа выключено: Tab ходит по кругу внутри, навигации под ним не достать.
  await page.getByRole("button", { name: "Новая метка", exact: true }).click();
  const sheet = tagSheet(page, "Новая метка");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("[role='dialog']") !== null), `шаг ${step}`).toBe(true);
  }
  await sheet.getByLabel("Название").fill("Подарки");
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", { name: "Не сохранять метку?" });
  await expect(discard).toContainText("Набранное имя новой метки не сохранится.");
  await discard.getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(sheet.getByLabel("Название")).toHaveValue("Подарки");
  await sheet.getByRole("button", { name: "Закрыть" }).click();
  await discard.getByRole("button", { name: "Не сохранять" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Новая метка", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: /^Подарки: / })).toHaveCount(0);

  // Архивная тёзка предлагается к возврату, а не ко второй метке.
  await page.getByRole("button", { name: "дача: ни одной операции. Изменить" }).click();
  await tagSheet(page, "Метка").getByRole("button", { name: "Убрать метку «дача» в архив" }).click();
  await expect(page.getByRole("button", { name: "Вернуть метку «дача» из архива" })).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Новая метка", exact: true }).click();
  await sheet.getByLabel("Название").fill("Дача");
  await expect(sheet.locator("#tag-new-hint")).toContainText("Метка «дача» уже была — сейчас в архиве.");
  await sheet.getByRole("button", { name: "Вернуть метку «дача» из архива" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator(".manage-status")).toHaveText("Метка «дача» снова в выборе.");
  await expect(page.getByRole("heading", { name: "В архиве" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "дача: ни одной операции. Изменить" })).toBeFocused();
});

test("лист счёта только с клавиатуры: поля, радиогруппы и чипы валюты стрелками, переключатель пробелом, запись — Enter", async ({ page }) => {
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
  // Валюта: Tab входит в группу чипов один раз — на выбранный; дальше — «Другая».
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Рубль — RUB" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Другая", exact: true })).toBeFocused();
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
  await expect(page.getByRole("switch", { name: "Считать во «Всего на счетах»" })).toBeChecked();
  await page.keyboard.press("Space");
  await expect(page.locator("#account-include")).not.toBeChecked();
  await page.keyboard.press("Tab");
  await expect(formSheet(page).getByRole("button", { name: "Сохранить", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(toast(page, "Счёт «Кошелёк» заведён.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Счета" })).toBeFocused();
  await expect(page.getByRole("button", { name: /^Кошелёк: 1\s250,50\s₽, наличные · вне итога\. Изменить$/u })).toBeVisible();
});

test("валюта чипами и поиском: стрелки по чипам, «Другая» — поиск по названию и коду, Enter выбирает, Esc сворачивает, а не закрывает лист", async ({ page }) => {
  await loadDemo(page);
  await openMore(page, "Счета");
  await page.getByRole("button", { name: "Новый счёт" }).click();
  const sheet = formSheet(page);
  const chips = sheet.getByRole("radiogroup", { name: "Валюта" });
  await expect(chips.getByRole("radio")).toHaveCount(5);
  // Стрелка выбирает соседний чип и переводит на него фокус; End — последний.
  await chips.getByRole("radio", { name: "Рубль — RUB" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(chips.getByRole("radio", { name: "Доллар — USD" })).toBeFocused();
  await expect(chips.getByRole("radio", { name: "Доллар — USD" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#account-opening + .dir-money-sign")).toHaveText("$");
  await page.keyboard.press("End");
  await expect(chips.getByRole("radio", { name: "Тенге — KZT" })).toBeFocused();
  await expect(chips.getByRole("radio", { name: "Тенге — KZT" })).toHaveAttribute("aria-checked", "true");

  // «Другая» раскрывает поиск по всему списку; системного списка нет.
  const other = sheet.getByRole("button", { name: "Другая", exact: true });
  await other.click();
  await expect(other).toHaveAttribute("aria-expanded", "true");
  const search = sheet.getByRole("combobox", { name: "Найти валюту" });
  await expect(search).toBeFocused();
  const list = sheet.getByRole("listbox", { name: "Валюты" });
  await search.fill("лари");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option", { name: /Грузинский лари GEL/u })).toHaveAttribute("aria-selected", "true");
  await search.fill("ба");
  // Стрелки ходят по найденному — активный вариант назван через `aria-activedescendant`.
  const found = await list.getByRole("option").count();
  expect(found).toBeGreaterThan(1);
  await page.keyboard.press("ArrowDown");
  const active = await search.getAttribute("aria-activedescendant");
  expect(active).toMatch(/^account-currency-opt-[A-Z]{3}$/u);
  await expect(page.locator(`#${active}`)).toHaveAttribute("aria-selected", "true");
  await search.fill("thb");
  await expect(sheet.locator(".cur-found")).toHaveText("Найдено: 1 валюта");
  // Enter выбирает и не отправляет лист: выбранная встаёт шестым чипом, фокус — на неё.
  await page.keyboard.press("Enter");
  await expect(formSheet(page)).toBeVisible();
  await expect(list).toHaveCount(0);
  await expect(chips.getByRole("radio")).toHaveCount(6);
  await expect(chips.getByRole("radio", { name: "Бат — THB" })).toBeFocused();
  await expect(chips.getByRole("radio", { name: "Бат — THB" })).toHaveAttribute("aria-checked", "true");
  // Esc в поиске сворачивает его и возвращает фокус на «Другая», а лист остаётся.
  await other.click();
  await search.fill("зззз");
  await expect(sheet.locator(".cur-found")).toHaveText("Ничего не нашлось. Попробуйте код: USD, KZT.");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(other).toBeFocused();
  await expect(formSheet(page)).toBeVisible();
  // Касание варианта — тоже выбор.
  await other.click();
  await search.fill("евро");
  await list.getByRole("option", { name: /Евро EUR/u }).click();
  await expect(chips.getByRole("radio", { name: "Евро — EUR" })).toHaveAttribute("aria-checked", "true");
});

test("лист счёта: набранное при уходе спрашивает диалогом приложения — крестик, Esc и системное «Назад»; навигация под листом выключена", async ({ page }) => {
  await loadDemo(page);
  await openMore(page, "Счета");
  await page.getByRole("button", { name: /^Карта: /u }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Счёт" })).toBeFocused();
  // Лист модальный: нижняя навигация и список под ним выключены для пальца, клавиатуры и диктора.
  await expect(page.getByRole("navigation")).toHaveCount(0);
  expect(await page.locator(".bottom-nav").getAttribute("inert")).toBe("");
  expect(await page.locator(".dir-under").getAttribute("inert")).toBe("");
  await page.getByLabel("Название").fill("Зарплатная");
  await formSheet(page).getByRole("button", { name: "Закрыть" }).click();
  await expect(leaveDialog(page)).toContainText("правка счёта «Карта»");
  await leaveDialog(page).getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(page.getByLabel("Название")).toHaveValue("Зарплатная");
  // Esc — тот же вопрос.
  await page.getByLabel("Название").focus();
  await page.keyboard.press("Escape");
  await expect(leaveDialog(page)).toBeVisible();
  await leaveDialog(page).getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(page.getByLabel("Название")).toHaveValue("Зарплатная");
  // Системное «Назад» — тот же вопрос.
  await page.goBack();
  await expect(leaveDialog(page)).toBeVisible();
  await leaveDialog(page).getByRole("button", { name: "Не сохранять" }).click();
  await expect(formSheet(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Счета" })).toBeFocused();
  await expect(page.getByRole("button", { name: /^Карта: /u })).toBeVisible();
  // Нетронутый лист закрывается без вопроса — и навигация снова доступна.
  await page.getByRole("button", { name: /^Карта: /u }).click();
  await page.keyboard.press("Escape");
  await expect(formSheet(page)).toHaveCount(0);
  await expect(leaveDialog(page)).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(1);
  expect(await page.locator(".bottom-nav").getAttribute("inert")).toBeNull();
});

test("«Сколько сейчас на счёте»: правка остатка сегодня называет сдвиг прошлых дней и пишет начальный остаток на ту же разницу", async ({ page }) => {
  await loadDemo(page);
  await openMore(page, "Счета");
  const row = page.getByRole("button", { name: /^Карта: /u });
  const before = Number(((await row.getAttribute("aria-label")) ?? "").replace(/^Карта: ([\d\s]+)\u00a0₽.*$/u, "$1").replace(/\s/gu, ""));
  expect(before).toBeGreaterThan(0);
  await row.click();
  const field = page.getByLabel("Сколько сейчас на счёте, ₽");
  await expect(field).toHaveValue(String(before));
  await field.fill(String(before + 1000));
  await expect(formSheet(page).getByRole("status").filter({ hasText: "сдвинутся" })).toHaveText(/^Остатки «Карта» за все прошлые дни сдвинутся на \+1\s000\s₽\.$/u);
  await formSheet(page).getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(toast(page, "Счёт «Карта» сохранён.")).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`^Карта: ${(before + 1000).toLocaleString("ru-RU").replace(/\s/gu, "\\s")}\\s₽`, "u") })).toBeVisible();
});

test("остаток ниже нуля — в поле минусом, отметка «долг» снята: набранное заново число записывается плюсом (ревью R3, M-1)", async ({ page }) => {
  await loadDemo(page);
  await openMore(page, "Счета");
  await page.getByRole("button", { name: "Новый счёт" }).click();
  const sheet = formSheet(page);
  await sheet.getByLabel("Название").fill("Кредитка");
  await sheet.getByLabel(/^Сколько сейчас на счёте/u).fill("1500");
  await sheet.getByLabel("Остаток ниже нуля — долг по карте").check();
  await sheet.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(toast(page, "Счёт «Кредитка» заведён.")).toBeVisible();
  const row = page.getByRole("button", { name: /^Кредитка: /u });
  await expect(row).toHaveAttribute("aria-label", /^Кредитка: [\u2212-]1\s500\s₽, /u);
  await row.click();
  const field = sheet.getByLabel(/^Сколько сейчас на счёте/u);
  await expect(field).toHaveValue("\u22121500");
  await expect(sheet.getByLabel("Остаток ниже нуля — долг по карте")).not.toBeChecked();
  // Остаток карты набран заново поверх поля: знак ушёл вместе с прежним текстом.
  await field.fill("50000");
  await expect(sheet.getByRole("status").filter({ hasText: "сдвинутся" })).toHaveText(/сдвинутся на \+51\s500\s₽\.$/u);
  await sheet.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(toast(page, "Счёт «Кредитка» сохранён.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Кредитка: 50\s000\s₽, /u })).toBeVisible();
});

test("режим «Изменить порядок»: стрелки у каждого счёта с фокусом на той же кнопке, край говорит «нет», мышью — перетаскивание за ручку", async ({ page }) => {
  await loadDemo(page);
  await openMore(page, "Счета");
  const names = () => page.locator(".dir-card[aria-label='Активные счета'] .dir-row").evaluateAll((rows) => rows.map((row) => (row.getAttribute("aria-label") ?? "").split(":")[0]));
  const start = await names();
  expect(start.length).toBeGreaterThanOrEqual(3);
  // В списке «Выше / Ниже» у строк нет.
  await expect(page.getByRole("button", { name: /— выше$/u })).toHaveCount(0);
  const mode = page.getByRole("button", { name: "Изменить порядок" });
  await mode.click();
  await expect(page.getByRole("button", { name: "Готово" })).toBeFocused();
  const order = page.getByRole("list", { name: "Порядок счетов" });
  await expect(order.getByRole("group", { name: "Место в списке: 1 из " + start.length })).toBeVisible();
  // Край: «выше» у первого говорит «нет» и остаётся в фокусе.
  const firstUp = page.getByRole("button", { name: `${start[0]} — выше` });
  await expect(firstUp).toHaveAttribute("aria-disabled", "true");
  // Стрелка «ниже»: счёт меняется местами с соседом, фокус — на той же кнопке того же счёта.
  const down = page.getByRole("button", { name: `${start[0]} — ниже` });
  await down.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".manage-status")).toHaveText(`«${start[0]}» — теперь 2-й из ${start.length}.`);
  await expect(down).toBeFocused();
  await expect(order.locator("li").nth(1)).toContainText(start[0]!);
  // Мышью — за ручку: последний счёт перетащен наверх одной записью.
  const lastRow = order.locator("li").last();
  const lastName = await lastRow.locator(".dir-copy .sr-only").innerText();
  const grip = lastRow.locator(".reorder-grip");
  await expect(grip).toBeVisible();
  const from = (await grip.boundingBox())!;
  const top = (await order.locator("li").first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, top.y + 4, { steps: 8 });
  await expect(order.locator("li").first()).toHaveAttribute("data-drop", "before");
  await page.mouse.up();
  await expect(page.locator(".manage-status")).toHaveText(`«${lastName}» — теперь 1-й из ${start.length}.`);
  await expect(order.locator("li").first()).toContainText(lastName);
  // Esc во время перетаскивания возвращает всё как было — без записи.
  const second = order.locator("li").nth(1);
  const secondName = await second.locator(".dir-copy .sr-only").innerText();
  const secondGrip = (await second.locator(".reorder-grip").boundingBox())!;
  await page.mouse.move(secondGrip.x + 10, secondGrip.y + 10);
  await page.mouse.down();
  await page.mouse.move(secondGrip.x + 10, secondGrip.y + 200, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(order.locator("li").nth(1)).toContainText(secondName);
  await expect(order.locator("[data-drop]")).toHaveCount(0);
  // «Готово» — к списку в новом порядке; «Обзор» стоит в том же порядке.
  await page.getByRole("button", { name: "Готово" }).click();
  const after = await names();
  expect(after[0]).toBe(lastName);
  expect(after).toHaveLength(start.length);
  await goToOverview(page);
  const tiles = await page.locator("[data-tile^='account:']").evaluateAll((items) => items.map((item) => (item.getAttribute("aria-label") ?? "").split(":")[0]));
  expect(tiles).toEqual(after);
});

test("категории: режим «Изменить порядок» по группам; «+ Своя» — последней плиткой открывает «Своя категория»", async ({ page }) => {
  await loadDemo(page);
  await openMore(page, "Категории и доходы");
  await expect(page.getByRole("button", { name: "Новая категория" })).toHaveCount(1);
  await page.getByRole("button", { name: "Своя категория" }).click();
  const own = page.getByRole("dialog", { name: "Своя категория" });
  await expect(own).toBeVisible();
  await own.getByRole("button", { name: "Отмена" }).click();
  await expect(page.getByRole("button", { name: "Своя категория" })).toBeFocused();
  await page.getByRole("button", { name: "Изменить порядок" }).click();
  const everyday = page.getByRole("list", { name: "Порядок: Каждый день" });
  await expect(everyday).toBeVisible();
  const first = await everyday.locator("li").first().locator(".dir-copy .sr-only").innerText();
  const down = page.getByRole("button", { name: `${first} — ниже` });
  await down.click();
  await expect(page.locator(".manage-status")).toContainText(`«${first}» — теперь 2-я из `);
  await expect(down).toBeFocused();
  await page.getByRole("button", { name: "Готово" }).click();
  const tiles = page.getByRole("list", { name: "Каждый день" }).locator(".tile");
  await expect(tiles.nth(1)).toHaveAccessibleName(new RegExp(`^${first}:`, "u"));
});

test("на 320 pt и при ×2.7 справочники не выезжают за экран, а их цели — не меньше 48", async ({ page }) => {
  test.setTimeout(240_000);
  await loadDemo(page);
  // Счёт в долларах с двумя курсами (история курса — две строки) и одна метка — чтобы на экранах
  // было что мерить (ревью 2c, MEDIUM-2: прежде здесь заводилась одна метка).
  await restoreBudget(page, withDollarExpenseAtOldRate(demoBudget()));
  await openMore(page, "Метки");
  await startTag(page);
  await tagSheet(page, "Новая метка").getByLabel("Название").fill("Подработка для отпуска и дачи");
  await tagSheet(page, "Новая метка").getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Подработка для отпуска и дачи: / })).toHaveCount(1);
  await openMore(page, "Счета");
  const mainId = await (async () => {
    await page.getByRole("button", { name: /^Карта: /u }).click();
    const hash = await page.evaluate(() => window.location.hash);
    expect(hash).toMatch(/^#\/more\/accounts\/[0-9a-f-]{36}$/u);
    await page.keyboard.press("Escape");
    return hash;
  })();
  await page.getByRole("button", { name: /^Доллары: /u }).click();
  const dollarsId = await page.evaluate(() => window.location.hash);
  expect(dollarsId).toMatch(/^#\/more\/accounts\/[0-9a-f-]{36}$/u);
  await page.keyboard.press("Escape");
  await openMore(page, "Категории и доходы");
  await page.getByRole("button", { name: /^Продукты: /u }).click();
  const categoryHash = await page.evaluate(() => window.location.hash);
  expect(categoryHash).toMatch(/^#\/more\/categories\/[0-9a-f-]{36}\?type=expense$/u);
  await page.keyboard.press("Escape");

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
        const targets = [...(root?.querySelectorAll<HTMLElement>("button, select, input:not([type='radio']):not([type='checkbox']):not([type='file']), label.picker-option, label.dir-option, label.check-row, [role='option']") ?? [])]
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
  expect(await nameSplits(page, ".rate-history-day, .rate-history-value, .dir-rate-now, .dir-rate-head"), `${label}: слова и числа курса целы`).toEqual([]);
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
  // Образец набран с мягкими переносами — и скрыт от читающих с экрана; для слуха — имя без них.
  const preview = await page.locator(".dir-preview-name").evaluate((name) => name.textContent ?? "");
  expect(preview).toContain("\u00ad");
  expect(preview.replace(/\u00ad/gu, "")).toBe("Благотворительность");
  await expect(page.locator(".dir-preview-name")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".dir-preview .sr-only")).toHaveText("Благотворительность: ");
  for (const [width, scale] of LINE_BREAK_LAYOUTS) {
    await applyFontScale(page, scale);
    await page.setViewportSize({ width, height: 844 });
    expect(await nameSplits(page, ".dir-preview-name, .dir-option-word"), `образец и группы ${width} pt ×${scale}`).toEqual([]);
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
  const usd = rateCard(page, "Доллар США");
  for (const value of ["90,00", "91,00", "92,00", "93,00", "94,00", "95,00"]) {
    await usd.getByRole("button", { name: "Добавить курс USD" }).click();
    await usd.getByRole("textbox", { name: "Сколько ₽ за 1 USD" }).fill(value);
    await usd.getByRole("button", { name: "Сохранить курс" }).click();
    await expect(usd.locator(".dir-rate-now"), value).toHaveText(new RegExp(`^1 \\$ = ${value}\\s₽$`, "u"));
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
  await expect(page.getByRole("heading", { level: 1, name: "Категория" })).toBeVisible();
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

  // Доходы: системное «Назад», «‹ Доходы» и «Сохранить» — к списку доходов.
  await openCategories();
  await page.getByRole("button", { name: "Доходы", exact: true }).click();
  await shows("Доходы");
  const source = page.locator(".categories-screen .tile").first();
  await source.click();
  await expect(page.getByRole("heading", { level: 1, name: "Источник дохода" })).toBeVisible();
  await page.goBack();
  await expect(list).toBeVisible();
  await shows("Доходы");
  expect(await address()).toBe("#/more/categories?type=income");
  // Крестик листа — к своему списку, без дубля в истории.
  await source.click();
  await formSheet(page).getByRole("button", { name: "Закрыть" }).click();
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
  await expect(page.getByRole("heading", { level: 1, name: "Источник дохода" })).toBeVisible();
  await page.goBack();
  await expect(list).toBeVisible();
  await shows("Доходы");
  // Старая ссылка без вида списка: адрес сам называет вид, и «назад» — к доходам.
  await page.goto("about:blank");
  await page.goto(`/${sourceAddress.replace(/\?type=income$/u, "")}`);
  await expect.poll(address).toBe(sourceAddress);
  await page.keyboard.press("Escape");
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

  // Метка: строка — лист с полем имени в фокусе; «Закрыть» и «Сохранить» — обратно на строку; «Убрать в
  // архив» — на «Вернуть», «Вернуть» — на «Убрать в архив».
  await openMore(page, "Метки");
  await startTag(page);
  await tagSheet(page, "Новая метка").getByLabel("Название").fill("Ремонт");
  await page.keyboard.press("Enter");
  await expect.poll(() => focused(page)).toBe("button: Ремонт: ни одной операции. Изменить");
  await page.keyboard.press("Enter");
  await expect.poll(() => focused(page)).toBe("input: Название");
  await pressWithKeyboard(page, "Закрыть", tagSheet(page, "Метка"));
  await expect.poll(() => focused(page)).toBe("button: Ремонт: ни одной операции. Изменить");
  await page.keyboard.press("Enter");
  await expect.poll(() => focused(page)).toBe("input: Название");
  await page.keyboard.press("End");
  await page.keyboard.type(" кухни");
  await page.keyboard.press("Enter");
  await expect(page.locator(".manage-status")).toHaveText("Метка «Ремонт» теперь «Ремонт кухни».");
  await expect.poll(() => focused(page)).toBe("button: Ремонт кухни: ни одной операции. Изменить");
  await page.keyboard.press("Enter");
  await pressWithKeyboard(page, "Убрать метку «Ремонт кухни» в архив");
  await expect(page.locator(".sheet-status")).toContainText("в архиве");
  await expect.poll(() => focused(page)).toBe("button: Вернуть метку «Ремонт кухни» из архива");
  await page.keyboard.press("Enter");
  await expect(page.locator(".sheet-status")).toContainText("снова в выборе");
  await expect.poll(() => focused(page)).toBe("button: Убрать метку «Ремонт кухни» в архив");
  await page.keyboard.press("Escape");

  // Счёт: «Убрать в архив» — на «Вернуть из архива» и обратно.
  await openMore(page, "Счета");
  await page.getByRole("button", { name: /^Доллары: /u }).click();
  await pressWithKeyboard(page, "Убрать в архив");
  await expect(page.locator(".sheet-status")).toContainText("в архиве");
  await expect.poll(() => focused(page)).toBe("button: Вернуть из архива");
  await page.keyboard.press("Enter");
  await expect(page.locator(".sheet-status")).toContainText("снова среди активных");
  await expect.poll(() => focused(page)).toBe("button: Убрать в архив");
  // «Вернуть» в списке: строка уходит из архива в активные — фокус на неё.
  await page.keyboard.press("Enter");
  await expect(page.locator(".sheet-status")).toContainText("в архиве");
  await page.getByRole("button", { name: "Закрыть" }).click();
  await pressWithKeyboard(page, "Вернуть «Доллары» из архива");
  await expect(page.locator(".manage-status")).toContainText("снова среди активных");
  await expect.poll(() => focused(page)).toMatch(/^button: Доллары: /u);

  // Категория: вопрос приложения, «Убрать в архив» в нём — на «Вернуть из архива» и обратно.
  await openMore(page, "Категории и доходы");
  await page.getByRole("button", { name: /^Кафе и доставка: /u }).click();
  await pressWithKeyboard(page, "Убрать в архив");
  await pressWithKeyboard(page, "Убрать в архив", page.getByRole("alertdialog"));
  await expect(page.locator(".sheet-status")).toContainText("в архиве");
  await expect.poll(() => focused(page)).toBe("button: Вернуть из архива");
  await page.keyboard.press("Enter");
  await expect(page.locator(".sheet-status")).toContainText("снова на «Обзоре»");
  await expect.poll(() => focused(page)).toBe("button: Убрать в архив");
  await page.keyboard.press("Enter");
  await pressWithKeyboard(page, "Убрать в архив", page.getByRole("alertdialog"));
  await expect(page.locator(".sheet-status")).toContainText("в архиве");
  await page.getByRole("button", { name: "Закрыть" }).click();
  await pressWithKeyboard(page, "Вернуть «Кафе и доставка» из архива");
  await expect(page.locator(".manage-status")).toContainText("снова на «Обзоре»");
  await expect.poll(() => focused(page)).toMatch(/^button: Кафе и доставка: /u);

  // Курс: после записи и после удаления — на заголовок карточки валюты.
  await openMore(page, "Курсы валют");
  const usd = rateCard(page, "Доллар США");
  // «Отмена» — обратно на кнопку, что открыла группу; «+» строки заголовка — так же.
  await pressWithKeyboard(page, "Добавить курс USD", usd);
  await pressWithKeyboard(page, "Отмена", usd);
  await expect.poll(() => focused(page)).toBe("button: Добавить курс USD");
  await page.keyboard.press("Enter");
  await usd.getByRole("textbox", { name: "Сколько ₽ за 1 USD" }).fill("92,50");
  await page.keyboard.press("Enter");
  await expect(page.locator(".manage-status")).toContainText("записан");
  await expect.poll(() => focused(page)).toBe("h2: Доллар США");
  await pressWithKeyboard(page, /^Удалить курс USD от /u, usd);
  await pressWithKeyboard(page, "Удалить курс", page.getByRole("alertdialog"));
  await expect(page.locator(".manage-status")).toContainText("удалён");
  await expect.poll(() => focused(page)).toBe("h2: Доллар США");
  await pressWithKeyboard(page, "Добавить курс", page.locator(".title-bar"));
  await expect.poll(() => focused(page)).toMatch(/^button: /u);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("radio");
  await pressWithKeyboard(page, "Отмена", page.locator(".dir-rate-new"));
  await expect.poll(() => focused(page)).toBe("button: Добавить курс");
});

test("отказ записи оставляет черновик формы несохранённым: уход спрашивает (счёт и категория)", async ({ page }) => {
  // Ревью 2c, LOW-3: без `saving.fail(ticket)` отказ домена в записи оставлял форму «записывается»,
  // и уход с набранным больше не спрашивал. Отказ здесь — внутри записи, а не до неё: имя занято.
  await loadDemo(page);
  const asksAbout = async (label: string) => {
    // Под листом навигация выключена: уход — крестиком листа.
    await formSheet(page).getByRole("button", { name: "Закрыть" }).click();
    const dialog = leaveDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(label);
    await dialog.getByRole("button", { name: "Продолжить ввод" }).click();
    await expect(dialog).toHaveCount(0);
  };

  await openMore(page, "Счета");
  await page.getByRole("button", { name: "Новый счёт" }).click();
  await page.getByLabel("Название").fill("Карта");
  await formSheet(page).getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Активный счёт с таким названием уже есть.")).toBeVisible();
  // Отказ — у поля, и фокус на нём.
  await expect(page.getByLabel("Название")).toBeFocused();
  await asksAbout("новый счёт");
  await expect(page.getByLabel("Название")).toHaveValue("Карта");

  await formSheet(page).getByRole("button", { name: "Закрыть" }).click();
  await leaveDialog(page).getByRole("button", { name: "Не сохранять" }).click();
  await openMore(page, "Категории и доходы");
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
  const usd = rateCard(page, "Доллар США");
  await usd.getByRole("button", { name: "Добавить курс USD" }).click();
  const question = page.getByRole("alertdialog", { name: "Не записывать набранный курс?" });
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(question).toHaveCount(0);
  await expect(top.getByRole("textbox", { name: /^Сколько ₽ за / })).toHaveValue("91,00");
  await usd.getByRole("button", { name: "Добавить курс USD" }).click();
  await question.getByRole("button", { name: "Не записывать" }).click();
  await expect(usd.locator(".rate-quick")).toBeVisible();
  await expect(page.locator(".dir-rate-new")).toHaveCount(0);
  await expect(usd.getByRole("textbox", { name: "Сколько ₽ за 1 USD" })).toHaveValue("");
  // Пустая группа не спрашивает: другая открывается сразу.
  await page.locator("#rates-add-top").click();
  await expect(question).toHaveCount(0);
  await expect(usd.locator(".rate-quick")).toHaveCount(0);
});
