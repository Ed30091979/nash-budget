/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  calculateBudget,
  makeSeedBudget,
  SEED_IDS,
  type BudgetState,
  type Category,
  type Transaction,
} from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { HistoryScreen, TotalsFact } from "./HistoryScreen";
import { archiveCategory, createTransaction } from "./model";

const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const historySource = readFileSync(new URL("./HistoryScreen.tsx", import.meta.url), "utf8");
const operationsSource = readFileSync(new URL("./OperationsScreen.tsx", import.meta.url), "utf8");

const extraIds = {
  categories: { over: "33333333-3333-4333-8333-333333333336" },
  lines: { over: "44444444-4444-4444-8444-444444444456" },
  refund: "55555555-5555-4555-8555-555555555556",
  transfer: "55555555-5555-4555-8555-555555555557",
  over: "55555555-5555-4555-8555-555555555559",
} as const;

/** Тот же бюджет, что у проверок экрана записи: возврат, перевод, взнос и перелимит в истории. */
function withAllFlows(): BudgetState {
  const seed = makeSeedBudget();
  const categories: readonly Category[] = [
    ...seed.categories,
    { id: extraIds.categories.over, name: "Точный перелимит", type: "expense", group: "Проверка", active: true, sortOrder: 60 },
  ];
  let state: BudgetState = {
    ...seed,
    categories,
    budgets: [{
      ...seed.budgets[0]!,
      lines: [...seed.budgets[0]!.lines, { id: extraIds.lines.over, categoryId: extraIds.categories.over, plannedMinor: 10_000 }],
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
  return createTransaction(state, {
    kind: "expense", status: "posted", occurredOn: "2026-07-13", amount: "150",
    accountId: SEED_IDS.accounts.main, categoryId: extraIds.categories.over,
  }, () => extraIds.over);
}

function plainText(markup: string): string {
  return markup.replaceAll("&nbsp;", " ").replaceAll("&#xA0;", " ").replaceAll(" ", " ");
}

function textOf(markup: string): string {
  return plainText(markup).replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
}

function historyMarkup(budget: BudgetState): string {
  return plainText(renderToStaticMarkup(<HistoryScreen budget={budget} onEdit={vi.fn()} onAdd={vi.fn()} onBack={vi.fn()} />));
}

/**
 * «Вся история» и «Итоги и остатки» переехали с экрана записи на «Ещё» (§8).
 *
 * Здесь проверяется, что при переезде ничего не потерялось: история достижима с «Ещё» одной
 * строкой, поиск фильтрует ту же историю, строка открывает операцию в форме записи, итоги
 * называют те же числа, а пустая история по-прежнему ведёт к записи.
 */
describe("история на «Ещё»", () => {
  it("называет каждую операцию: категорию, дату с видом, сумму со знаком направления", () => {
    const text = textOf(historyMarkup(withAllFlows()));
    expect(text).toContain("Вся история");
    expect(text).toContain("Продукты 2026-07-07 · Возврат +1 500 ₽");
    expect(text).toContain("Перевод 2026-07-11 · Основной → Накопительный 5 000 ₽");
    expect(text).toContain("Взнос в цель 2026-07-10 · Основной → Резерв 10 000 ₽");
    expect(text).toContain("Точный перелимит 2026-07-13 · Расход −150 ₽");
    expect(text).toContain("Поиск по категории, счёту или сумме");
  });

  it("достижима с «Ещё» одной строкой, и её строка открывает операцию в форме «Записать»", () => {
    // Дверь на «Ещё»: группа «Записи», строка с числом операций, маршрут `history` внутри «Ещё».
    expect(appSource).toContain('<h2 id="more-records-title" className="list-kicker">Записи</h2>');
    expect(appSource).toMatch(/onClick=\{props\.onHistory\}[^]*?<strong>Вся история<\/strong>/u);
    expect(appSource).toContain('onHistory={() => navigate("history")}');
    expect(appSource).toContain('active={screen === "more" || screen === "family" || screen === "import" || screen === "history"}');
    // Строка истории просит экран записи открыть операцию; тот выполняет просьбу и гасит её,
    // чтобы повторный приход на экран не открыл ту же операцию снова.
    expect(appSource).toContain('onEdit={(transaction) => { setEditRequest({ id: transaction.id, nonce: Date.now() }); navigate("operations"); }}');
    expect(appSource).toContain("editRequest={editRequest} onEditRequestHandled={() => setEditRequest(null)}");
    expect(operationsSource).toMatch(/if \(transaction\) beginEdit\(transaction\);\s*onEditRequestHandled\?\.\(\);/u);
    // Строка — одна цель нажатия с именем операции; удаление живёт в форме, а не в строке.
    const markup = historyMarkup(withAllFlows());
    expect(markup).toMatch(/<button class="row-open" type="button" aria-label="Изменить операцию «Возврат 1 500 ₽ от 2026-07-07»"/u);
    expect(markup).not.toContain("Удалить операцию");
    // Назад — кнопкой экрана: вкладка «Ещё» на этом маршруте уже подсвечена.
    expect(markup).toContain("К разделу «Ещё»");
  });

  it("держит архивную категорию в истории и после архивирования", () => {
    const source = withAllFlows();
    const withoutActiveLine = {
      ...source,
      budgets: source.budgets.map((budget) => ({
        ...budget,
        lines: budget.lines.map((line) => line.categoryId === SEED_IDS.categories.food ? { ...line, active: false } : line),
      })),
    };
    const text = textOf(historyMarkup(archiveCategory(withoutActiveLine, SEED_IDS.categories.food)));
    expect(text).toContain("Продукты 2026-07-07 · Возврат");
    expect(text).toContain("Продукты 2026-07-05 · Расход −31 500 ₽");
  });

  it("листает полную историю, а не режет её насовсем", () => {
    const seed = makeSeedBudget();
    const extra: Transaction[] = Array.from({ length: 26 }, (_, index) => ({
      id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      occurredOn: "2026-07-15",
      status: "posted",
      kind: "income",
      amountMinor: 100,
      accountId: SEED_IDS.accounts.main,
    }));
    const html = historyMarkup({ ...seed, transactions: [...seed.transactions, ...extra] });
    expect(html).toContain("Показано 25 из 31");
    expect(html).toContain("Показать ещё (6)");
    expect(html).toContain("aria-label=\"Показать ещё операции, осталось 6\"");
  });

  it("фильтрует ту же историю, а не показывает вторым списком те же операции", () => {
    const state = withAllFlows();
    const html = historyMarkup(state);
    // Один список операций на экране, и поиск стоит над ним, а не над своей копией.
    expect(html.match(/class="transaction-list"/gu)).toHaveLength(1);
    expect(textOf(html)).toContain(`Показано ${state.transactions.length} из ${state.transactions.length}`);
    // Смена запроса и вида возвращает список к первой странице: иначе фильтр показывал бы
    // «Показать ещё» там, где найденное уже помещается целиком.
    expect(historySource.match(/setVisibleCount\(PAGE_SIZE\)/gu)?.length).toBeGreaterThanOrEqual(3);
    expect(historySource).toContain("maxLength={80}");
    expect(historySource).not.toMatch(/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|innerHTML/u);
  });

  it("держит разметку ограниченной на истории в пятьдесят тысяч операций", () => {
    const seed = makeSeedBudget();
    const many: Transaction[] = Array.from({ length: 50_000 }, (_, index) => ({
      id: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      occurredOn: `2026-07-${String((index % 28) + 1).padStart(2, "0")}`,
      status: "posted",
      kind: "income",
      amountMinor: index + 1,
      accountId: SEED_IDS.accounts.main,
    }));
    const html = historyMarkup({ ...seed, transactions: [...seed.transactions, ...many] });
    expect(html.match(/class="transaction-row history-row/gu)).toHaveLength(25);
    expect(textOf(html)).toContain("Показано 25 из 50005");
  });

  it("«Итоги и остатки» на «Ещё» называют те же числа, что раньше стояли под табло", () => {
    const state = withAllFlows();
    const text = textOf(plainText(renderToStaticMarkup(<TotalsFact budget={state} metrics={calculateBudget(state)} />)));
    expect(text).toContain("Итоги и остатки");
    expect(text).toContain("Доход 100 000 ₽");
    expect(text).toContain("Расходы с учётом возвратов 75 150 ₽");
    expect(text).toContain("Капитал 24 850 ₽");
    expect(text).toContain("Основной 9 850 ₽");
    expect(text).toContain("Накопительный 15 000 ₽");
    expect(appSource).toContain("<TotalsFact budget={props.budget} metrics={props.metrics} />");
  });
});
