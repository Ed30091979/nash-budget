/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { makeSeedBudget } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { addressesTouchTarget, designTargetGap, designTouchTargetMinimum } from "../../design-contract";
import { KEYPAD_HIDDEN_MEDIA } from "./Keypad";
import { OperationsScreen } from "./OperationsScreen";

const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
const source = readFileSync(new URL("./OperationsScreen.tsx", import.meta.url), "utf8");
const keypadSource = readFileSync(new URL("./Keypad.tsx", import.meta.url), "utf8");

function rule(selector: string): string {
  const match = styles.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\{([^}]*)\\}`, "u"));
  expect(match, `правило ${selector} не найдено`).not.toBeNull();
  return match?.[1] ?? "";
}

/**
 * Клавиатура суммы (§6): часть экрана, а не панель системы поверх него.
 *
 * Дефект, который она чинит: системная клавиатура закрывала табло конвертов ровно в тот момент,
 * ради которого табло существует. Что табло остаётся видимым при наборе — меряет e2e
 * (`keypad.spec.ts`); здесь — анатомия, доступность и одно условие на клавиши и `inputmode`.
 */
describe("клавиатура суммы", () => {
  const markup = renderToStaticMarkup(<OperationsScreen budget={makeSeedBudget()} onChange={vi.fn(async () => undefined)} />);

  it("стоит в липкой полосе записи под кнопкой, и каждая клавиша названа", () => {
    const bar = markup.slice(markup.indexOf('class="record-action with-keypad"'));
    expect(bar).toContain('<div class="keypad" role="group" aria-label="Клавиатура суммы">');
    expect(bar.indexOf('class="keypad"')).toBeGreaterThan(bar.indexOf("Записать покупку"));
    for (const digit of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      expect(bar).toMatch(new RegExp(`<button type="button"[^>]*>${digit}</button>`, "u"));
    }
    for (const name of ["Стереть", "Плюс", "Минус", "Разделить", "Запятая"]) {
      expect(bar).toContain(`aria-label="${name}"`);
    }
    // Стирание — глиф из спрайта, не текстовый символ; «=» нет — равно́ здесь кнопка записи.
    expect(bar).toMatch(/aria-label="Стереть"[^>]*><svg/u);
    expect(bar).not.toMatch(/>=<\/button>/u);
    // Итог нажатий произносится: значение поля, которое не в фокусе, само не объявляется.
    expect(bar).toContain('<span class="sr-only" role="status">');
  });

  it("не отбирает у поля ни физической клавиатуры, ни буфера, ни диктора", () => {
    // Поле — настоящее поле с именем; `inputmode="none"` просит платформу не поднимать
    // системную клавиатуру, и только. `readonly` сломал бы всё три сразу.
    expect(markup).toContain('<label for="operation-amount">Сумма, ₽</label>');
    expect(markup).toMatch(/<input id="operation-amount" inputMode="none" maxLength="24"/u);
    expect(markup).not.toMatch(/readonly/iu);
    expect(source).not.toMatch(/readOnly/u);
    // Нажатие клавиши не уводит фокус из поля: цифра встаёт в каретку, а не только в конец.
    expect(keypadSource).toContain("onMouseDown={(event) => event.preventDefault()}");
    expect(source).toContain("amountRef.current?.setSelectionRange(caret, caret);");
    // С физической клавиатуры поле принимает то же, что и клавиши: `onChange` остался обычным.
    expect(source).toContain('onChange={(event) => patch("amount", event.target.value)}');
  });

  it("клавиши и `inputmode` подчиняются одному условию: без клавиш поле зовёт системную клавиатуру", () => {
    expect(source).toContain('inputMode={keypadAvailable ? "none" : "decimal"}');
    expect(source).toContain('{keypadAvailable ? <>\n          <Keypad onKey={pressKey} disabled={busy} />');
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

  it("«Очистить черновик» стоит у заголовка, а не в полосе: полоса с клавиатурой не растёт от первой цифры", () => {
    expect(source).toMatch(/<div className="record-head">\s*<h1 id="operation-form-title">\{title\}<\/h1>\s*\{!editingId && dirty \? <button className="text-button" type="button" aria-label="Очистить черновик"/u);
    const bar = source.slice(source.indexOf('<div className={`record-action'), source.indexOf("</div>", source.indexOf("<Keypad ")));
    expect(bar).not.toContain("Очистить черновик");
    // Правка: «Отмена» и «Удалить» рядом, а не столбцом — под клавиатурой на 320 pt.
    expect(rule(".record-action.with-keypad > .record-edit-actions")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  });

  it("сумма — выражение, и её итог назван до записи", () => {
    // Предпросмотр и кнопка считают от разобранного выражения; перед записью оно сворачивается.
    expect(source).toContain("const amount = evaluateAmount(draft.amount);");
    expect(source).toContain('const amountMinor = amount.kind === "value" ? amount.minor : 0;');
    expect(source).toContain("const pending = { ...draft, amount: settleAmount(draft.amount) };");
    expect(source).toMatch(/<output htmlFor="operation-amount" className="amount-total">= <Money value=\{amount\.minor\} \/><\/output>/u);
  });
});
