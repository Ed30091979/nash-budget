/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  makeSeedBudget,
  SEED_IDS,
  type BudgetState,
  type Category,
} from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { OperationsScreen } from "./OperationsScreen";
import { createOperationsSubmissionGate } from "./form-state";
import { archiveCategory, createTransaction } from "./model";
import { periodClock } from "../../reach";

/** Часы образца: 13 июля внутри июльского периода, выплат в истории нет — насечка на конце месяца. */
const JULY_CLOCK = periodClock({ startDate: "2026-07-01", endDate: "2026-07-31" }, [], "2026-07-13");

const extraIds = {
  categories: {
    noPlan: "33333333-3333-4333-8333-333333333334",
    normal: "33333333-3333-4333-8333-333333333335",
    over: "33333333-3333-4333-8333-333333333336",
  },
  lines: {
    noPlan: "44444444-4444-4444-8444-444444444454",
    normal: "44444444-4444-4444-8444-444444444455",
    over: "44444444-4444-4444-8444-444444444456",
  },
  refund: "55555555-5555-4555-8555-555555555556",
  transfer: "55555555-5555-4555-8555-555555555557",
  nearLimit: "55555555-5555-4555-8555-555555555558",
  over: "55555555-5555-4555-8555-555555555559",
} as const;

function withAllSignalsAndFlows(): BudgetState {
  const seed = makeSeedBudget();
  const categories: readonly Category[] = [
    ...seed.categories,
    { id: extraIds.categories.noPlan, name: "Нулевой план", type: "expense", group: "Проверка", active: true, sortOrder: 40 },
    { id: extraIds.categories.normal, name: "Свободный лимит", type: "expense", group: "Проверка", active: true, sortOrder: 50 },
    { id: extraIds.categories.over, name: "Точный перелимит", type: "expense", group: "Проверка", active: true, sortOrder: 60 },
  ];
  let state: BudgetState = {
    ...seed,
    categories,
    budgets: [{
      ...seed.budgets[0]!,
      lines: [
        ...seed.budgets[0]!.lines,
        { id: extraIds.lines.noPlan, categoryId: extraIds.categories.noPlan, plannedMinor: 0 },
        { id: extraIds.lines.normal, categoryId: extraIds.categories.normal, plannedMinor: 1_000_000 },
        { id: extraIds.lines.over, categoryId: extraIds.categories.over, plannedMinor: 10_000 },
      ],
    }],
  };
  state = createTransaction(state, {
    kind: "refund", status: "posted", occurredOn: "2026-07-07", amount: "1500",
    accountId: SEED_IDS.accounts.main, originalTransactionId: SEED_IDS.transactions.food,
  }, () => extraIds.refund);
  state = createTransaction(state, {
    kind: "transfer", status: "posted", occurredOn: "2026-07-11", amount: "5000",
    fromAccountId: SEED_IDS.accounts.main, toAccountId: SEED_IDS.accounts.savings,
  }, () => extraIds.transfer);
  state = createTransaction(state, {
    kind: "expense", status: "posted", occurredOn: "2026-07-12", amount: "3000",
    accountId: SEED_IDS.accounts.main, categoryId: SEED_IDS.categories.transport,
  }, () => extraIds.nearLimit);
  return createTransaction(state, {
    kind: "expense", status: "posted", occurredOn: "2026-07-13", amount: "150",
    accountId: SEED_IDS.accounts.main, categoryId: extraIds.categories.over,
  }, () => extraIds.over);
}

function plainText(markup: string): string {
  return markup.replaceAll("&nbsp;", " ").replaceAll("&#xA0;", " ").replaceAll("\u00a0", " ");
}

/**
 * Видимый текст экрана. Строку операции и сумму рядом с ней проверяет то, что читает человек:
 * знак валюты набран отдельным элементом (§7), плитка категории — третьим, и утверждение о
 * «</strong><span>» ломалось бы от любой правки вёрстки, ничего не сказав о смысле.
 */
function textOf(markup: string): string {
  return plainText(markup).replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
}

describe("operations UI", () => {
  it("держит все пять видов операций достижимыми и делает одно дело: ни истории, ни итогов под табло", () => {
    const html = plainText(renderToStaticMarkup(<OperationsScreen budget={withAllSignalsAndFlows()} clock={JULY_CLOCK} onChange={vi.fn(async () => undefined)} />));
    const text = textOf(html);

    // Покупка — через табло; доход, возврат, перевод и взнос — той же формой через строку
    // «Доход или перевод» и выбор вида. Ни один вид не потерян.
    for (const label of ["Доход", "Расход", "Возврат", "Перевод", "Взнос в цель"]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(text).toContain("Доход или перевод");
    expect(html).toContain("Счёт оплаты");
    // Экран отвечает на «можем ли мы себе это позволить» до траты — и только на него. «Итоги и
    // остатки» и «Вся история» с поиском уехали на «Ещё» (`HistoryScreen`, `TotalsFact`): второй
    // главный экран внутри формы к этому вопросу отношения не имел.
    expect(text).not.toContain("Итоги и остатки");
    expect(text).not.toContain("Вся история");
    expect(text).not.toContain("Капитал");
    expect(html).not.toContain("transaction-list");
    expect(html).not.toContain("operation-history-search");

    // Конверт — кнопка выбора, и её имя говорит, что в нём сейчас: линейка в нём — та же, что на
    // «Сегодня», с теми же словами состояния. Перелимит назван суммой, а не только цветом.
    expect(html).toMatch(/<button class="envelope" type="button" aria-pressed="false" aria-label="Продукты: в конверте [^"]*"/u);
    expect(html).toMatch(/aria-label="Точный перелимит: перелимит 50 ₽[^"]*"/u);
    expect(html).toContain('<span class="envelope-after out"><small>перелимит</small>');
    expect(html).toMatch(/<span class="limit-bar out" data-spent="0"/u);
    expect(html).toMatch(/<span class="limit-bar (?:reaches|short)" data-spent="\d+"/u);
    expect(text).toContain("сверх лимита");
    expect(text).toMatch(/до конца месяца|дотянет/u);
    // §6: плитка конверта — тон категории и векторный глиф; текстовых символов в роли иконки нет.
    expect(html).toMatch(/<span class="category-tile tone-[a-z]+"><svg[^>]*aria-hidden="true"[^>]*>/);
    expect(html).not.toMatch(/envelope-foot[^>]*>[!○✓]/u);
    // Записывает не касание конверта, а отдельная кнопка, которая называет действие словами.
    expect(html).toMatch(/<button class="primary-button wide" type="submit"[^>]*>Записать покупку<\/button>/u);
    expect(html).toContain("Архивировать использованную категорию «Продукты»");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("показывает под суммой, что останется в каждом конверте, — до записи, а не после", () => {
    // Табло отвечает на «а мы можем себе это позволить?» до траты, и сразу по всем конвертам.
    // Проверка рисует экран с уже введённой суммой: то же самое человек видит, набрав её.
    const state = withAllSignalsAndFlows();
    const source = readFileSync(new URL("./OperationsScreen.tsx", import.meta.url), "utf8");
    // Предпросмотр считается от разобранной суммы черновика и только для новой покупки в месяце
    // плана; при редактировании сумма уже в остатках, и вычитать её второй раз нельзя.
    expect(source).toContain('const previewApplies = draft.kind === "expense" && editingId === null && amountMinor > 0 && dateInPeriod;');
    expect(source).toContain("const afterRemaining = applies ? metric.remainingMinor - amountMinor : metric.remainingMinor;");
    // Укус покупки — отрезок между «было» и «станет», второй атрибут той же шкалы.
    expect(source).toContain("data-bite={bite ?? undefined}");
    const html = plainText(renderToStaticMarkup(<OperationsScreen budget={state} clock={JULY_CLOCK} onChange={vi.fn(async () => undefined)} />));
    expect(html).toContain('<small>в конверте</small>');
    expect(html).not.toContain("останется");
  });

  it("не предлагает архивную категорию для новой покупки и выключенную строку плана — конвертом", () => {
    const source = withAllSignalsAndFlows();
    const withoutActiveLine = {
      ...source,
      budgets: source.budgets.map((budget) => ({
        ...budget,
        lines: budget.lines.map((line) => line.categoryId === SEED_IDS.categories.food
          ? { ...line, active: false }
          : line),
      })),
    };
    // Выключенная строка плана — не конверт: категория уходит в «Вне конвертов».
    const inactive = plainText(renderToStaticMarkup(<OperationsScreen budget={withoutActiveLine} onChange={vi.fn(async () => undefined)} />));
    expect(inactive).not.toMatch(/class="envelope" [^>]*aria-label="Продукты:/u);
    expect(inactive).toContain(">Продукты</button>");
    expect(inactive).toContain("Архивировать использованную категорию «Продукты»");
    // Архивная категория из новых покупок исчезает вовсе — и из списка на архивирование тоже.
    const archived = plainText(renderToStaticMarkup(<OperationsScreen budget={archiveCategory(withoutActiveLine, SEED_IDS.categories.food)} onChange={vi.fn(async () => undefined)} />));
    expect(archived).not.toContain("Архивировать использованную категорию «Продукты»");
  });

  it("locks before await so a same-tick double submit calls onChange once", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const onChange = vi.fn(async () => pending);
    const gate = createOperationsSubmissionGate();

    const first = gate.run(onChange);
    const second = await gate.run(onChange);
    expect(gate.locked).toBe(true);
    expect(second).toEqual({ status: "ignored" });
    expect(onChange).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    expect(gate.locked).toBe(false);
  });

  it("retains the draft on failed saves and exposes only the public generic error", () => {
    const source = readFileSync(new URL("./OperationsScreen.tsx", import.meta.url), "utf8");
    const catchBlock = source.match(/catch \(cause\) \{([\s\S]*?)\n      \} finally/)?.[1] ?? "";
    expect(catchBlock).toContain("toOperationsErrorView(cause)");
    expect(catchBlock).toContain("setError(view.message)");
    expect(catchBlock).not.toMatch(/setDraft|reset\(/);
    expect(source).toContain("maxLength={24}");
    expect(source).toContain("aria-busy={busy}");
    expect(source).toContain("Подтвердить изменение операции?");
    expect(source).toContain("Подтвердить удаление");
    expect(source).not.toMatch(/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|innerHTML/);
  });
});
