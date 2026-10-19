/**
 * Лист ввода суммы (план волны 2, §1.2) в настоящем браузере.
 *
 * Прежний экран «Записать» с табло конвертов (`keypad.spec.ts`) ушёл в 2b; его проверки живут
 * здесь, на листе поверх «Обзора»: число касаний от плитки до записанной покупки — измеренное, а не
 * объявленное; арифметика; физическая клавиатура, каретка и буфер рядом с клавишами; сумма, которая
 * не уходит из виду при наборе; клавиатура, которая уступает системной при крупном шрифте и в
 * альбоме; правка, удаление и «Отменить» из тоста.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { demoBudget, restoreBudget, withPendingExpense } from "./budgets";
import { applyFontScale } from "./font-scale";
import {
  amountField,
  entrySheet,
  goToOverview,
  keypadKey,
  leaveDialog,
  loadDemo,
  submitButton,
  tile,
  toast,
  typeOnKeypad,
} from "./sheet";

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

/** Закрыть лист с набранным: вопрос приложения и «Не сохранять». */
async function discardSheet(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  const dialog = leaveDialog(page);
  if (await dialog.count()) await dialog.getByRole("button", { name: "Не сохранять" }).click();
  await expect(entrySheet(page)).toHaveCount(0);
}

test("наименьшее число касаний от плитки до записанной покупки — шесть, и ни одного по системной клавиатуре", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  let taps = 0;
  const tap = async (target: Locator) => {
    await target.click();
    taps += 1;
  };
  // 1 — плитка категории (счёт — основной, вид — расход, дата — сегодня); 2–5 — цифры; 6 — запись.
  await tap(tile(page, "Продукты"));
  await expect(entrySheet(page)).toBeVisible();
  await expect(amountField(page)).toBeFocused();
  await expect(amountField(page)).toHaveAttribute("inputmode", "none");
  for (const digit of ["1", "2", "0", "0"]) await tap(keypadKey(page, digit));
  await expect(submitButton(page)).toHaveText(/^Записать 1\s200\s₽$/u);
  await tap(submitButton(page));
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(toast(page, /Записано: расход 1\s200\s₽/u)).toBeVisible();
  expect(taps, "касаний от плитки до записанной покупки").toBe(6);
  test.info().annotations.push({ type: "taps tile → recorded purchase", description: String(taps) });
  // Фокус вернулся на плитку, которая открыла лист.
  await expect(tile(page, "Продукты")).toBeFocused();

  // «Отменить» в тосте снимает покупку тем же путём записи и говорит об этом.
  const before = await tile(page, "Продукты").getAttribute("aria-label");
  await toast(page, /Записано/u).getByRole("button", { name: "Отменить" }).click();
  await expect(toast(page, /Отменено: расход 1\s200\s₽/u)).toBeVisible();
  await expect(tile(page, "Продукты")).not.toHaveAttribute("aria-label", before ?? "");
});

test("арифметика: два чека складываются, итог назван до записи, а записывается число", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await tile(page, "Продукты").click();
  const amount = amountField(page);

  await typeOnKeypad(page, ["1", "2", "0", "0", "Плюс", "3", "5", "0"]);
  await expect(amount).toHaveValue("1200+350");
  await expect(page.locator(".amount-total")).toHaveText(/=\s*1\s*550\s*₽/u);
  // Читающему с экрана итог нажатий произносится отдельно: поле не обязано быть в фокусе.
  await expect(page.locator(".sheet-foot [role='status']")).toHaveText(/1200\+350, итого 1\s550\s₽/u);
  await expect(page.locator(".entry-effect")).toContainText("В категории «Продукты»");
  await submitButton(page).click();
  await expect(toast(page, /Записано: расход 1\s550\s₽/u)).toBeVisible();

  // Счёт пополам — и знак после знака заменяет его, а не встаёт вторым.
  await tile(page, "Продукты").click();
  await typeOnKeypad(page, ["3", "0", "0", "0", "Плюс", "Разделить", "2"]);
  await expect(amount).toHaveValue("3000÷2");
  await expect(page.locator(".amount-total")).toHaveText(/=\s*1\s*500\s*₽/u);
  await discardSheet(page);
});

test("физическая клавиатура, каретка и буфер работают вместе с клавишами", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await tile(page, "Продукты").click();
  const amount = amountField(page);

  // Физическая клавиатура набирает как обычно — цифры и знаки, включая дефис и косую черту.
  await expect(amount).toBeFocused();
  await page.keyboard.type("1500-300");
  await expect(amount).toHaveValue("1500-300");
  await expect(page.locator(".amount-total")).toHaveText(/=\s*1\s*200\s*₽/u);
  // Клавиша не уводит фокус из поля и правит по каретке: цифра встаёт туда, где каретка.
  await page.evaluate(() => {
    const input = document.getElementById("entry-amount") as HTMLInputElement;
    input.setSelectionRange(1, 1);
  });
  await keypadKey(page, "9").click();
  await expect(amount).toHaveValue("19500-300");
  await expect(amount).toBeFocused();
  expect(await amount.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(2);
  // Стирание — тоже по каретке: уходит «9», а не последний символ, и каретка остаётся на месте.
  await keypadKey(page, "Стереть").click();
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
  await expect(submitButton(page)).toHaveText(/^Записать 1\s234,56\s₽$/u);
  await discardSheet(page);
});

test("сумма и кнопка записи не уходят из виду, пока сумму набирают с клавиш", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  for (const viewport of PHONE_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await tile(page, "Продукты").click();
    await expect(page.getByRole("group", { name: "Клавиатура суммы" })).toBeVisible();
    await typeOnKeypad(page, ["1", "2", "0", "0"]);
    await expect(amountField(page)).toHaveValue("1200");
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect() ?? null;
      const amount = rect("#entry-amount");
      const keypad = rect(".keypad");
      const submit = rect(".entry-submit");
      const body = rect(".sheet-body");
      if (!amount || !keypad || !submit || !body) throw new Error("Лист без поля, клавиатуры или кнопки.");
      return {
        amountWhole: amount.top >= body.top - 0.5 && amount.bottom <= body.bottom + 0.5 && amount.bottom <= keypad.top + 0.5,
        submitWhole: submit.top >= 0 && submit.bottom <= innerHeight + 0.5,
        keypadWhole: keypad.top >= 0 && keypad.bottom <= innerHeight + 0.5,
        heights: { amount: Math.round(amount.height), keypad: Math.round(keypad.height), body: Math.round(body.height) },
      };
    });
    expect(geometry.amountWhole, `${viewport.name}: сумма целиком над клавишами (${JSON.stringify(geometry.heights)})`).toBe(true);
    expect(geometry.keypadWhole, `${viewport.name}: клавиши целиком на экране`).toBe(true);
    expect(geometry.submitWhole, `${viewport.name}: кнопка записи целиком на экране`).toBe(true);
    test.info().annotations.push({ type: `sheet ${viewport.name}`, description: JSON.stringify(geometry.heights) });
    await discardSheet(page);
  }
});

test("при крупном шрифте и на коротком экране клавиатуры нет, и поле зовёт системную", async ({ page }) => {
  test.setTimeout(120_000);
  await loadDemo(page);
  const keypad = page.getByRole("group", { name: "Клавиатура суммы" });

  // ×2.7: четыре ряда клавиш и кнопка записи выше любого телефона — клавиатуры нет, и системная
  // хотя бы уходит по «Готово»; условие одно на клавиши и `inputmode`.
  await applyFontScale(page, 2.7);
  for (const viewport of [PHONE_VIEWPORTS[0]!, PHONE_VIEWPORTS[2]!]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await tile(page, "Продукты").click();
    await expect(keypad, `${viewport.name} ×2.7`).toHaveCount(0);
    await expect(amountField(page)).toHaveAttribute("inputmode", "decimal");
    await amountField(page).fill("1234");
    await expect(amountField(page)).toHaveValue("1234");
    await expect(submitButton(page)).toHaveText(/^Записать 1\s234\s₽$/u);
    await discardSheet(page);
  }
  // Обратно к обычному кеглю — клавиши возвращаются без перезагрузки, с открытым листом.
  await tile(page, "Продукты").click();
  await applyFontScale(page, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(keypad).toBeVisible();
  await expect(amountField(page)).toHaveAttribute("inputmode", "none");
  // Телефон в альбоме: экран короче клавиатуры с кнопкой.
  await page.setViewportSize({ width: 667, height: 375 });
  await expect(keypad).toHaveCount(0);
  await expect(amountField(page)).toHaveAttribute("inputmode", "decimal");
  await discardSheet(page);
});

test("правка из «Операций»: «Сохранить», а «Удалить» спрашивает и даёт «Отменить»", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  const row = page.locator('button[aria-label^="Изменить операцию «Расход"]').first();
  await row.click();
  const sheet = entrySheet(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAccessibleName(/^Изменить: расход: /u);
  await expect(amountField(page)).not.toHaveValue("");
  await amountField(page).fill("777");
  await expect(submitButton(page)).toHaveText("Сохранить");
  await submitButton(page).click();
  await expect(sheet).toHaveCount(0);
  await expect(toast(page, /Изменено: расход 777\s₽/u)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Изменить операцию «Расход 777\s₽/u }).first()).toBeVisible();

  // Удалить — вопросом приложения; «Отменить» в тосте возвращает операцию.
  await page.getByRole("button", { name: /^Изменить операцию «Расход 777\s₽/u }).first().click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Удалить", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Удалить операцию?" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Не удалять" })).toBeFocused();
  await confirm.getByRole("button", { name: "Удалить" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(toast(page, /Удалено: расход 777\s₽/u)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Изменить операцию «Расход 777\s₽/u })).toHaveCount(0);
  await toast(page, /Удалено/u).getByRole("button", { name: "Отменить" }).click();
  await expect(toast(page, /Отменено: расход 777\s₽/u)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Изменить операцию «Расход 777\s₽/u }).first()).toBeVisible();
});

/** Первая строка расхода в «Операциях» и её доступное имя целиком — по нему её находят снова. */
async function firstExpenseRow(page: Page): Promise<{ readonly row: Locator; readonly label: string }> {
  await page.getByRole("button", { name: "Операции", exact: true }).click();
  const row = page.locator('button[aria-label^="Изменить операцию «Расход"]').first();
  const label = (await row.getAttribute("aria-label")) ?? "";
  expect(label).not.toBe("");
  return { row: page.getByRole("button", { name: label, exact: true }), label };
}

test("нетронутая правка, закрытая и открытая снова, показывает операцию такой, какая она сейчас", async ({ page }) => {
  // Ревью 2b, HIGH-2, сценарий 1: лист хранил прошлый черновик по адресу и после «Отменить»
  // показывал старую сумму — правка одного комментария записала бы её поверх.
  await loadDemo(page);
  const { row, label } = await firstExpenseRow(page);
  await row.click();
  const original = await amountField(page).inputValue();
  await amountField(page).fill("48123");
  await submitButton(page).click();
  await expect(toast(page, /Изменено: расход 48\s123\s₽/u)).toBeVisible();

  // Открыть изменённую и закрыть нетронутой; «Отменить» в тосте возвращает прежнюю сумму.
  const edited = page.getByRole("button", { name: /^Изменить операцию «Расход 48\s123\s₽/u }).first();
  await edited.click();
  await expect(amountField(page)).toHaveValue("48123");
  await page.keyboard.press("Escape");
  await expect(entrySheet(page)).toHaveCount(0);
  await toast(page, /Изменено/u).getByRole("button", { name: "Отменить" }).click();
  await expect(toast(page, /^Отменено: расход 48\s123\s₽/u)).toBeVisible();

  // Тот же адрес — лист с нынешней суммой; правка комментария её не трогает.
  await row.click();
  await expect(amountField(page)).toHaveValue(original);
  await entrySheet(page).getByRole("textbox", { name: "Комментарий" }).fill("сверено");
  await submitButton(page).click();
  await expect(entrySheet(page)).toHaveCount(0);
  // Сумма в строке — прежняя: записан комментарий, а не 48 123 ₽ из старого черновика.
  await expect(page.locator(`button[aria-label^="${label.slice(0, label.indexOf("₽") + 1)}"]`).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Изменить операцию «Расход 48\s123\s₽/u })).toHaveCount(0);
});

test("«Оформить возврат», закрытый без набранного, не подменяет правку при следующем открытии", async ({ page }) => {
  // Ревью 2b, HIGH-2, сценарий 2: «Изменить операцию» открывал лист возврата и записывал возврат.
  await loadDemo(page);
  const { row } = await firstExpenseRow(page);
  await row.click();
  await entrySheet(page).getByRole("button", { name: "Оформить возврат" }).click();
  await expect(entrySheet(page)).toHaveAccessibleName(/^Возврат: /u);
  await entrySheet(page).getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(leaveDialog(page)).toHaveCount(0);

  await row.click();
  await expect(entrySheet(page)).toHaveAccessibleName(/^Изменить: расход: /u);
  await expect(submitButton(page)).toHaveText("Сохранить");
});

test("правка расхода «в ожидании» оставляет его в ожидании: комментарий не двигает «Потрачено»", async ({ page }) => {
  // Ревью 2b, MEDIUM-1: запись правки делала операцию проведённой.
  await loadDemo(page);
  await restoreBudget(page, withPendingExpense(demoBudget()));
  await goToOverview(page);
  const before = await tile(page, "Продукты").getAttribute("aria-label");

  await page.getByRole("button", { name: "Операции", exact: true }).click();
  await page.getByRole("button", { name: /^Изменить операцию «Расход 5\s432\s₽/u }).click();
  await expect(amountField(page)).toHaveValue("5432");
  await entrySheet(page).getByRole("textbox", { name: "Комментарий" }).fill("ждём списания");
  await submitButton(page).click();
  await expect(toast(page, /Изменено: расход 5\s432\s₽/u)).toBeVisible();

  await goToOverview(page);
  await expect(tile(page, "Продукты")).toHaveAttribute("aria-label", before ?? "");
});

test("тост «Записано» называет то же число, что лист обещал под суммой", async ({ page }) => {
  // Ревью 2b, MEDIUM-3: остаток в тосте считался по окну бюджета месяца, а в листе и на плитке —
  // накопленным. У демо есть доходы прошлых месяцев, и числа расходились.
  await loadDemo(page);
  await tile(page, "Зарплата").click();
  await tile(page, "Основной").click();
  await amountField(page).fill("100");
  const promised = (await entrySheet(page).locator("#entry-effect").innerText()).trim();
  const balance = /^На счёте «Основной» станет (.+)$/u.exec(promised)?.[1];
  expect(balance, promised).toBeDefined();
  await submitButton(page).click();
  const receipt = toast(page, /Записано: доход 100\s₽/u).locator(".toast-receipt .sr-only");
  await expect(receipt).toHaveText(`Остаток на счёте «Основной»: ${balance}, больше на 100\u00a0₽`);
});

/** Табом до кнопки или поля, чьё доступное имя — `name`; не дальше шестидесяти шагов. */
async function tabToName(page: Page, name: string): Promise<void> {
  for (let step = 0; step < 60; step += 1) {
    await page.keyboard.press("Tab");
    const current = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return "";
      const label = active.id ? document.querySelector(`label[for="${active.id}"]`)?.textContent : null;
      return (active.getAttribute("aria-label") ?? label ?? active.textContent ?? "").trim();
    });
    if (current === name) return;
  }
  throw new Error(`«${name}» не достижим табом.`);
}

test("«Оформить возврат» над тронутой правкой спрашивает, а после — фокус в сумме возврата, и Esc закрывает", async ({ page }) => {
  // Ревью 2b, MEDIUM-6: набранное в правке пропадало молча, а фокус падал на тело страницы, откуда
  // Esc лист уже не закрывал. Весь путь — одной клавиатурой.
  await loadDemo(page);
  const { row } = await firstExpenseRow(page);
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(amountField(page)).toBeFocused();
  await tabToName(page, "Комментарий");
  await page.keyboard.type("сверено");
  await tabToName(page, "Оформить возврат");
  await page.keyboard.press("Enter");
  const question = page.getByRole("alertdialog", { name: "Оформить возврат без сохранения?" });
  await expect(question).toBeVisible();
  await expect(question.getByRole("button", { name: "Продолжить правку" })).toBeFocused();
  // «Продолжить правку» — набранное на месте, фокус на «Оформить возврат».
  await page.keyboard.press("Enter");
  await expect(question).toHaveCount(0);
  await expect(entrySheet(page).getByRole("textbox", { name: "Комментарий" })).toHaveValue("сверено");
  await expect(entrySheet(page).getByRole("button", { name: "Оформить возврат" })).toBeFocused();
  // Ещё раз — и «Оформить возврат»: лист возврата, фокус в его сумме.
  await page.keyboard.press("Enter");
  await expect(question).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(question.getByRole("button", { name: "Оформить возврат" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(entrySheet(page)).toHaveAccessibleName(/^Возврат: /u);
  await expect(amountField(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(entrySheet(page)).toHaveCount(0);
  await expect(leaveDialog(page)).toHaveCount(0);
  await expect(row).toBeFocused();
});

test("лист держит фокус: Tab ходит внутри, Esc с набранным спрашивает, без набранного — закрывает", async ({ page }) => {
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await tile(page, "Продукты").click();
  const sheet = entrySheet(page);
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press("Tab");
    expect(await sheet.evaluate((element) => element.contains(document.activeElement)), `Tab №${step + 1} остался в листе`).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  // Набранное — Esc спрашивает; «Продолжить ввод» оставляет всё как было.
  await amountField(page).fill("450");
  await page.keyboard.press("Escape");
  await expect(leaveDialog(page)).toBeVisible();
  await leaveDialog(page).getByRole("button", { name: "Продолжить ввод" }).click();
  await expect(amountField(page)).toHaveValue("450");
  // Стёртое — снова не черновик: Esc закрывает без вопроса, фокус — на плитке.
  await amountField(page).fill("");
  await amountField(page).focus();
  await page.keyboard.press("Escape");
  await expect(leaveDialog(page)).toHaveCount(0);
  await expect(sheet).toHaveCount(0);
  await expect(tile(page, "Продукты")).toBeFocused();
});

test("лист 5.0: сегмент вида с «+», карточки сторон, плашка «Почти лимит», знаки клавиш — глифами, «Записать» — акцентом", async ({ page }) => {
  // Макет 07: «Карта → Продукты», 2 400 ₽ — 24 400 из 30 000, порог 80 %: «почти лимит», останется 5 600.
  await loadDemo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Записать", exact: true }).click();
  const sheet = entrySheet(page);
  const modes = sheet.getByRole("group", { name: "Вид операции" });
  await expect(modes.getByRole("button")).toHaveText(["Расход", "Доход", "Перевод"]);
  await expect(modes.getByRole("button", { name: "Расход" })).toHaveAttribute("aria-pressed", "true");
  await modes.getByRole("button", { name: "Доход" }).click();
  await expect(modes.getByRole("button", { name: "Доход" })).toHaveAttribute("aria-pressed", "true");
  await discardSheet(page);

  await tile(page, "Продукты").click();
  await expect(sheet.locator('[data-side="from"] .endpoint-plate.account')).toBeVisible();
  await expect(sheet.locator('[data-side="to"] .endpoint-plate')).toHaveClass(/tone-/u);
  await typeOnKeypad(page, ["2", "4", "0", "0"]);
  const state = sheet.locator("#entry-state");
  await expect(state).toHaveClass(/\bnear\b/u);
  await expect(state).toHaveText(/^Почти лимит: В категории «Продукты» останется 5\s600\s₽ из 30\s000\s₽$/u);
  await expect(state.locator("use")).toHaveAttribute("href", "#glyph-triangle-alert");
  await expect(amountField(page)).toHaveAttribute("aria-describedby", "entry-state");
  // Знаки — глифы спрайта; клавиши — на утопленной плоскости, 52 в высоту.
  for (const [name, glyph] of [["Плюс", "plus"], ["Минус", "minus"], ["Разделить", "divide"], ["Стереть", "delete"]] as const) {
    await expect(keypadKey(page, name).locator("use")).toHaveAttribute("href", `#glyph-${glyph}`);
    await expect(keypadKey(page, name)).toHaveText("");
  }
  const key = await keypadKey(page, "5").evaluate((element) => ({ height: element.getBoundingClientRect().height, background: getComputedStyle(element).backgroundColor }));
  expect(key).toEqual({ height: 52, background: "rgb(238, 233, 225)" });
  // Основная кнопка — акцент с белым, а не чернильная плита.
  expect(await submitButton(page).evaluate((element) => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color])).toEqual(["rgb(196, 66, 26)", "rgb(255, 255, 255)"]);
  await expect(submitButton(page)).toHaveText(/^Записать 2\s400\s₽$/u);
  await discardSheet(page);
});

test("320×640: дата, комментарий и метки свёрнуты в строку, клавиши 48, всё на экране и без прокрутки вбок", async ({ page }) => {
  // Макет 07, 320×640: ниже 700 pt высоты подписи сторон спрятаны, а дата, комментарий и метки —
  // одной строкой «Сегодня · Комментарий, метки»; клавиатура и «Записать» — целиком на экране.
  await loadDemo(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await tile(page, "Продукты").click();
  const sheet = entrySheet(page);
  await typeOnKeypad(page, ["2", "4", "0", "0"]);
  const more = sheet.getByRole("button", { name: "Комментарий, метки" });
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(sheet.getByRole("textbox", { name: "Комментарий" })).toBeHidden();
  await expect(sheet.locator(".endpoint-word").first()).toBeHidden();
  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect() ?? null;
    const keypad = rect(".keypad");
    const submit = rect(".entry-submit");
    const amount = rect("#entry-amount");
    const key = rect(".keypad button");
    return {
      whole: Boolean(keypad && submit && amount && keypad.top >= 0 && submit.bottom <= innerHeight + 0.5 && amount.top >= 0 && amount.bottom <= keypad.top),
      key: Math.round(key?.height ?? 0),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      sheetOverflow: [...document.querySelectorAll<HTMLElement>(".entry-sheet *")].some((element) => element.getBoundingClientRect().right > innerWidth + 0.5),
    };
  });
  expect(geometry).toEqual({ whole: true, key: 48, overflow: false, sheetOverflow: false });
  // Открыть строку — дата, комментарий и метки на месте, и набирать в них можно.
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const note = sheet.getByRole("textbox", { name: "Комментарий" });
  await note.fill("дача");
  await expect(note).toHaveValue("дача");
  await expect(sheet.getByRole("button", { name: "Вчера", exact: true })).toBeVisible();
  await discardSheet(page);
});
