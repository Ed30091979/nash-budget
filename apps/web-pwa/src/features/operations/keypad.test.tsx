/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { makePlanningSeed, PLANNING_IDS, SEED_IDS } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { addressesTouchTarget, designTargetGap, designTouchTargetMinimum } from "../../design-contract";
import { EntrySheet } from "../entry/EntrySheet";
import { draftFromTransaction, newEntryDraft } from "../entry/entry-model";
import { KEYPAD_HIDDEN_MEDIA } from "./Keypad";

const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
const source = readFileSync(new URL("../entry/EntrySheet.tsx", import.meta.url), "utf8");
const entryModel = readFileSync(new URL("../entry/entry-model.ts", import.meta.url), "utf8");
const keypadSource = readFileSync(new URL("./Keypad.tsx", import.meta.url), "utf8");

function rule(selector: string): string {
  const match = styles.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\{([^}]*)\\}`, "u"));
  expect(match, `правило ${selector} не найдено`).not.toBeNull();
  return match?.[1] ?? "";
}

function sheet(draft = newEntryDraft(makePlanningSeed(), { kind: "expense", accountId: SEED_IDS.accounts.main, categoryId: PLANNING_IDS.categories.food }, "2026-07-13")) {
  const budget = makePlanningSeed();
  const editing = draft.editId === null ? null : budget.transactions.find((item) => item.id === draft.editId) ?? null;
  return renderToStaticMarkup(
    <EntrySheet
      budget={budget}
      draft={draft}
      today="2026-07-13"
      balances={{}}
      modeSwitch={false}
      failure={null}
      writeRefusal={null}
      editing={editing}
      onChange={vi.fn()}
      onRefund={vi.fn()}
      onClose={vi.fn()}
      onSubmit={vi.fn(() => null)}
      onDelete={vi.fn(async () => null)}
      onSaveRate={vi.fn(async () => null)}
      onCategoryChange={vi.fn(async () => undefined)}
      isDirty={() => false}
      onDiscard={vi.fn()}
      fallbackFocus={vi.fn()}
    />,
  );
}

/**
 * Клавиатура суммы (§6): часть листа ввода, а не панель системы поверх него.
 *
 * Дефект, который она чинила на прежнем экране записи: системная клавиатура закрывала табло
 * конвертов ровно тогда, когда на него смотрели. С 2b она стоит в подвале листа ввода, над кнопкой
 * записи, и сумма над ней не уезжает из виду (e2e `entry.spec.ts` меряет это в браузере); здесь —
 * анатомия, доступность и одно условие на клавиши и `inputmode`.
 */
describe("клавиатура суммы", () => {
  const markup = sheet();

  it("стоит в подвале листа над кнопкой записи, и каждая клавиша названа", () => {
    const foot = markup.slice(markup.indexOf('class="sheet-foot with-keypad"'));
    expect(foot).toContain('<div class="keypad" role="group" aria-label="Клавиатура суммы">');
    // Кнопка записи — своей строкой под клавишами, во всю ширину.
    expect(foot.indexOf('class="keypad"')).toBeLessThan(foot.indexOf('class="primary-button wide entry-submit"'));
    for (const digit of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      expect(foot).toMatch(new RegExp(`<button type="button"[^>]*>${digit}</button>`, "u"));
    }
    for (const name of ["Стереть", "Плюс", "Минус", "Разделить", "Запятая"]) {
      expect(foot).toContain(`aria-label="${name}"`);
    }
    // Стирание — глиф из спрайта, не текстовый символ; «=» нет — равно́ здесь кнопка записи.
    expect(foot).toMatch(/aria-label="Стереть"[^>]*><svg/u);
    expect(foot).not.toMatch(/>=<\/button>/u);
    // Итог нажатий произносится: значение поля, которое не в фокусе, само не объявляется.
    expect(foot).toContain('<span class="sr-only" role="status">');
  });

  it("не отбирает у поля ни физической клавиатуры, ни буфера, ни диктора", () => {
    // Поле — настоящее поле с именем; `inputmode="none"` просит платформу не поднимать
    // системную клавиатуру, и только. `readonly` сломал бы всё три сразу.
    expect(markup).toContain('<label for="entry-amount">Сумма, ₽</label>');
    expect(markup).toMatch(/<input id="entry-amount" inputMode="none" autoComplete="off" maxLength="24"/u);
    expect(markup).not.toMatch(/readonly/iu);
    expect(source).not.toMatch(/readOnly/u);
    // Нажатие клавиши не уводит фокус из поля: цифра встаёт в каретку, а не только в конец.
    expect(keypadSource).toContain("onMouseDown={(event) => event.preventDefault()}");
    expect(source).toContain("amountRef.current?.setSelectionRange(caret, caret);");
    // С физической клавиатуры поле принимает то же, что и клавиши: `onChange` остался обычным.
    expect(source).toContain("onChange={(event) => patch((current) => ({ ...current, amount: event.target.value }))}");
  });

  it("клавиши и `inputmode` подчиняются одному условию: без клавиш поле зовёт системную клавиатуру", () => {
    expect(source).toContain('inputMode={keypad ? "none" : "decimal"}');
    expect(source).toContain("{keypad && picker === null ? <Keypad onKey={pressKey} disabled={busy} /> : null}");
    // Крупный шрифт узнаётся в кеглях, как в §5 таблицы стилей; короткий экран — телефон в альбоме.
    expect(KEYPAD_HIDDEN_MEDIA).toBe("(max-width: 18em), (max-height: 34em)");
    expect(styles).toContain("@media (max-width: 18em)");
    expect(keypadSource).toContain("window.matchMedia(KEYPAD_HIDDEN_MEDIA)");
  });

  it("клавиша — цель нажатия по §9: не ниже норматива, с зазором из документа, скруглена как то, что нажимают", () => {
    const minimum = designTouchTargetMinimum();
    const gap = designTargetGap();
    expect(rule(".keypad")).toContain(`gap: ${gap}px`);
    expect(rule(".keypad")).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
    const key = rule(".keypad button");
    const declared = Number(/min-height: (\d+)px/u.exec(key)?.[1]);
    expect(declared).toBeGreaterThanOrEqual(minimum);
    expect(key).toContain("border-radius: var(--radius-control)");
    expect(addressesTouchTarget(".keypad button")).toBe(true);
    // Контраст считан по §3: цифры — чернила на белом (18.36:1), знаки — `--ink-muted` (7.16:1),
    // граница клавиши — `--line` (3.65:1, нетекстовый порог 3:1).
    expect(key).toContain("color: var(--ink)");
    expect(key).toContain("background: var(--surface)");
    expect(key).toContain("border: 1px solid var(--line)");
    expect(rule(".keypad button.key-op")).toContain("color: var(--ink-muted)");
  });

  it("правка: «Оформить возврат» и «Удалить» — в теле листа, а не в подвале: подвал с клавиатурой не растёт", () => {
    const budget = makePlanningSeed();
    const expense = budget.transactions.find((item) => item.kind === "expense")!;
    const opening = draftFromTransaction(budget, expense);
    if (opening.kind !== "draft") throw new Error("expense must open as a draft");
    const edit = sheet(opening.draft);
    const foot = edit.slice(edit.indexOf('class="sheet-foot'));
    expect(foot).not.toContain("Удалить");
    expect(foot).not.toContain("Оформить возврат");
    const body = edit.slice(edit.indexOf('class="sheet-body"'), edit.indexOf('class="sheet-foot'));
    expect(body).toContain("Удалить");
    expect(body).toContain("Оформить возврат");
    // Подвал — ошибка, клавиши, кнопка записи и произносимый итог; больше ничего.
    expect(rule(".sheet-foot")).toContain("display: grid");
  });

  it("сумма — выражение, и её итог назван до записи", () => {
    // Строка «останется» и кнопка считают от разобранного выражения; при записи оно сворачивается.
    expect(source).toContain("const amount = evaluateAmount(draft.amount, exponent);");
    expect(entryModel).toContain("amount: settleAmount(draft.amount, draftExponent(state, draft)),");
    expect(source).toMatch(/<output htmlFor="entry-amount" className="amount-total">= <Money value=\{amount\.minor\} currency=\{currency\} \/><\/output>/u);
    const compound = sheet({ ...newEntryDraft(makePlanningSeed(), { kind: "expense", accountId: SEED_IDS.accounts.main, categoryId: PLANNING_IDS.categories.food }, "2026-07-13"), amount: "1200+350" });
    expect(compound).toContain('class="amount-total"');
    expect(compound.replace(/<[^>]+>/gu, "").replace(/[\u00a0\u202f]/gu, " ")).toContain("Записать 1 550 ₽");
  });
});
