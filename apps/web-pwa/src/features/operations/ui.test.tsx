/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  makeSeedBudget,
  SEED_IDS,
  type BudgetState,
  type Category,
  type Transaction,
} from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { OperationsScreen } from "./OperationsScreen";
import { createOperationsSubmissionGate } from "./form-state";
import { archiveCategory, createTransaction } from "./model";

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

describe("operations UI", () => {
  it("renders all operation flows, exact summaries and accessible limit signals", () => {
    const html = plainText(renderToStaticMarkup(<OperationsScreen budget={withAllSignalsAndFlows()} onChange={vi.fn(async () => undefined)} />));

    for (const label of ["Доход", "Расход", "Возврат", "Перевод", "Взнос в цель"]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain("Счёт оплаты");
    expect(html).toContain("Доход</span><strong>100 000 ₽");
    expect(html).toContain("Расходы с учётом возвратов</span><strong>78 150 ₽");
    expect(html).toContain("Капитал</span><strong>21 850 ₽");
    expect(html).toContain("Основной</dt><dd>6 850 ₽");
    expect(html).toContain("Накопительный</dt><dd>15 000 ₽");
    expect(html).toContain("Возврат · 1 500 ₽");
    expect(html).toContain("Перевод · 5 000 ₽");
    expect(html).toContain("Взнос в цель · 10 000 ₽");

    expect(html).toContain("В норме");
    expect(html).toContain("Почти лимит");
    expect(html).toContain("Лимит исчерпан");
    expect(html).toContain("Перелимит");
    expect(html).toContain("Без плана");
    expect(html).toContain("80%");
    expect(html).toContain("100%");
    expect(html).toContain("150%");
    expect(html).toContain("нет плана");
    expect(html).toMatch(/role="status" aria-label="Точный перелимит: Перелимит,[^"]*150%"/);
    expect(html).toMatch(/<i aria-hidden="true">!<\/i>/);
    expect(html).toContain("Архивировать использованную категорию «Продукты»");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("keeps archived categories contextual in history without offering them for new expenses", () => {
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
    const archived = archiveCategory(withoutActiveLine, SEED_IDS.categories.food);
    const html = plainText(renderToStaticMarkup(<OperationsScreen budget={archived} onChange={vi.fn(async () => undefined)} />));
    expect(html).toContain("Продукты · возврат расхода");
    expect(html).toContain("Расход · 31 500 ₽</strong><span>2026-07-05 · Продукты · Основной");
    expect(html).not.toContain("Архивировать использованную категорию «Продукты»");
  });

  it("omits an archived planning line from limit signals while retaining category history", () => {
    const source = withAllSignalsAndFlows();
    const inactiveLine = {
      ...source,
      budgets: source.budgets.map((budget) => ({
        ...budget,
        lines: budget.lines.map((line) => line.categoryId === SEED_IDS.categories.food
          ? { ...line, active: false }
          : line),
      })),
    };
    const html = plainText(renderToStaticMarkup(
      <OperationsScreen budget={inactiveLine} onChange={vi.fn(async () => undefined)} />,
    ));
    expect(html).not.toContain('role="status" aria-label="Продукты:');
    expect(html).toContain("Расход · 31 500 ₽</strong><span>2026-07-05 · Продукты · Основной");
    expect(html).toContain("Архивировать использованную категорию «Продукты»");
  });

  it("paginates the complete history instead of permanently slicing it", () => {
    const seed = makeSeedBudget();
    const extra: Transaction[] = Array.from({ length: 26 }, (_, index) => ({
      id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      occurredOn: "2026-07-15",
      status: "posted",
      kind: "income",
      amountMinor: 100,
      accountId: SEED_IDS.accounts.main,
    }));
    const html = plainText(renderToStaticMarkup(<OperationsScreen budget={{ ...seed, transactions: [...seed.transactions, ...extra] }} onChange={vi.fn(async () => undefined)} />));
    expect(html).toContain("Показано 25 из 31");
    expect(html).toContain("Показать ещё (6)");
    expect(html).toContain("aria-label=\"Показать ещё операции, осталось 6\"");
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
