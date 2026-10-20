/// <reference types="node" />
import { readFileSync } from "node:fs";
import type { BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { designTouchTargetMinimum } from "../../design-contract";
import { buildOnboardingBudgetState } from "../../onboarding/model";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { AccountsQuestion } from "./AccountsQuestion";
import { CategoriesQuestion } from "./CategoriesQuestion";
import { createFirstRunStore, EMPTY_FIRST_RUN, type FirstRunMemory } from "./memory";
import { PaydayQuestion } from "./PaydayQuestion";
import { QuestionHost } from "./QuestionHost";
import { QuestionSheet } from "./QuestionSheet";
import { beginFirstRun, markAnswered } from "./questions-model";

const TODAY = "2026-10-19";
const write: BudgetWriter = { run: async (change) => change({} as BudgetState) };

function preset(): BudgetState {
  let next = 0;
  return buildOnboardingBudgetState({ today: TODAY, makeId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` });
}

describe("лист-вопрос: модальный диалог, вопрос, строка и «Спросить позже»", () => {
  it("aria-modal, имя — вопрос, описание — строка; крестик назван словами", () => {
    const markup = renderToStaticMarkup(<QuestionSheet id="q-x" title="Вопрос?" subtitle="Строка." onLater={() => undefined} footer={<button type="button">Готово</button>} />);
    expect(markup).toMatch(/<section class="sheet q-sheet" role="dialog" aria-modal="true" aria-labelledby="q-x-title" aria-describedby="q-x-sub"/u);
    expect(markup).toContain('<h2 id="q-x-title" tabindex="-1">');
    expect(markup).toContain('<button class="q-later" type="button" aria-label="Спросить позже">');
    expect(markup).toContain('<p class="q-sub" id="q-x-sub">');
    const source = readFileSync(new URL("./QuestionSheet.tsx", import.meta.url), "utf8");
    // Tab по кругу и Esc — «позже», как у остальных листов приложения.
    expect(source).toContain("handleDialogKeyboard(event, dialogRef.current, !busy, onLater)");
    expect(source).toContain("headingRef.current?.focus({ preventScroll: true })");
  });

  it("затемнение листа — от самого верха экрана: ритм маршрута не даёт ему отступа", () => {
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    expect(styles).toContain(".route-screen > .sheet-backdrop { margin-top: 0; }");
  });

  it("цели листа — не меньше норматива §9", () => {
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    const minimum = designTouchTargetMinimum();
    for (const selector of [".q-head .q-later", ".q-options button", ".q-day-grid button"]) {
      const declared = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\{[^}]*min-height: (\\d+)px`, "u").exec(styles);
      expect(declared, selector).not.toBeNull();
      expect(Number(declared?.[1]), selector).toBeGreaterThanOrEqual(minimum);
    }
  });
});

describe("три вопроса (03, 03b, 04)", () => {
  it("«На что вы тратите?»: частые отмечены (aria-pressed), «Добавить» — нет, «Своя категория» и «Готово»", () => {
    const markup = renderToStaticMarkup(<CategoriesQuestion budget={preset()} write={write} onAnswered={() => undefined} onLater={() => undefined} onCustom={() => undefined} />);
    expect(markup).toContain(">Частые — уже отмечены</p>");
    expect(markup).toContain(">Добавить</p>");
    expect(markup.match(/aria-pressed="true"/gu)).toHaveLength(11);
    expect(markup.match(/aria-pressed="false"/gu)).toHaveLength(6);
    expect(markup).toContain("Своя категория</span></button>");
    expect(markup).toContain(">Готово</button>");
    expect(markup).not.toContain(">Прочее<");
  });

  it("«Есть ещё места, где лежат деньги?»: что уже есть, «Нет, это всё» и «Да, добавить»", () => {
    const markup = renderToStaticMarkup(<AccountsQuestion budget={preset()} onNo={() => undefined} onYes={() => undefined} onLater={() => undefined} />);
    expect(markup).toContain(">Уже есть:</span>");
    expect(markup).toMatch(/<bdi dir="auto">Карта<\/bdi>[\s\S]*<bdi dir="auto">Наличные<\/bdi>/u);
    expect(markup).toMatch(/>Нет, это всё<\/button><button class="primary-button" type="button">Да, добавить<\/button>/u);
  });

  it("«Когда приходит зарплата?»: радиогруппа из шести, в обходе одна (roving tabindex)", () => {
    const markup = renderToStaticMarkup(<PaydayQuestion write={write} onAnswered={() => undefined} onLater={() => undefined} />);
    expect(markup).toContain('role="radiogroup" aria-label="Дни выплат"');
    expect(markup.match(/role="radio"/gu)).toHaveLength(6);
    expect(markup.match(/tabindex="0"/gu)).toHaveLength(1);
    expect(markup.match(/aria-checked="false"/gu)).toHaveLength(6);
    expect(markup).toContain('<span class="sr-only">Нет постоянной</span>');
  });

  it("хозяин вопросов: первый по порядку, по одному; ждёт, пока «Обзор» занят; без набора — молчит", async () => {
    const memory: FirstRunMemory = { load: async () => EMPTY_FIRST_RUN, save: async () => undefined, clear: async () => undefined };
    const store = createFirstRunStore(memory);
    const render = (blocked = false) => renderToStaticMarkup(
      <QuestionHost budget={preset()} today={TODAY} write={write} blocked={blocked} onAddAccount={() => undefined} store={store} />,
    );
    expect(render()).toBe("");
    await store.replace(beginFirstRun(TODAY));
    expect(render()).toContain('aria-labelledby="q-categories-title"');
    expect(render().match(/role="dialog"/gu)).toHaveLength(1);
    expect(render(true)).toBe("");
    await store.update((state) => markAnswered(state, "categories", TODAY));
    expect(render()).toContain('aria-labelledby="q-accounts-title"');
    await store.update((state) => markAnswered(state, "accounts", TODAY));
    expect(render()).toContain('aria-labelledby="q-payday-title"');
    await store.update((state) => markAnswered(state, "payday", TODAY));
    expect(render()).toBe("");
  });

  it("листы пишут только через писатель оболочки и держат набранное в реестре черновиков", () => {
    for (const file of ["./CategoriesQuestion.tsx", "./PaydayQuestion.tsx"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).toContain("useFormDraft(");
      expect(source, file).toContain("write.run(");
      expect(source, file).toContain("writeFailureText(cause)");
      expect(source, file).not.toMatch(/repository|indexedDB|localStorage/u);
    }
  });
});
