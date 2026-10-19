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
import { amountText, debtVerb, kindSign, transactionCurrency, transactionDetail } from "./transaction-words";
import { formatMoney } from "../../money";
import { readAppSource } from "../../app/shell-source";

const appSource = readAppSource();
const historySource = readFileSync(new URL("./HistoryScreen.tsx", import.meta.url), "utf8");
const reportsSource = readFileSync(new URL("../reports/ReportsScreen.tsx", import.meta.url), "utf8");

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
 * «Вся история» стала вкладкой «Операции», «Итоги и остатки» — частью «Отчётов» (план волны 2, §4 «2a»).
 *
 * Здесь проверяется, что при переезде ничего не потерялось: история — одна вкладка навигации,
 * поиск фильтрует ту же историю, строка открывает операцию в форме записи, итоги называют те же
 * числа, а пустая история по-прежнему ведёт к записи.
 */
describe("история — вкладка «Операции»", () => {
  it("называет каждую операцию: категорию, дату с видом, сумму со знаком направления", () => {
    const text = textOf(historyMarkup(withAllFlows()));
    expect(text).toContain("Операции");
    expect(text).toContain("Продукты 2026-07-07 · Возврат +1 500 ₽");
    expect(text).toContain("Перевод 2026-07-11 · Основной → Накопительный 5 000 ₽");
    expect(text).toContain("Взнос в цель 2026-07-10 · Основной → Резерв 10 000 ₽");
    expect(text).toContain("Точный перелимит 2026-07-13 · Расход −150 ₽");
    expect(text).toContain("Поиск по категории, счёту или сумме");
  });

  it("— вкладка навигации, и её строка открывает операцию в листе ввода по адресу правки", () => {
    // Вкладка «Операции» нижней навигации — второе место из пяти; на «Ещё» второй двери нет.
    expect(appSource).toContain('{ tab: "operations", label: "Операции", icon: "history" },');
    expect(appSource).toContain('{route.name === "operations" ? <HistoryScreen budget={budget} onEdit={openEdit} onAdd={() => openSheet({})} /> : null}');
    expect(appSource).not.toContain("Вся история</strong>");
    // Строка открывает лист поверх «Операций» адресом `#/operations?sheet=entry&edit=<id>`: в адрес
    // идёт только UUID операции, а лист находит её в бюджете в любом регистре.
    expect(appSource).toContain("const opening = sheetEditOf(transaction);");
    expect(appSource).toContain("budget.transactions.find((item) => sameRecordId(item.id, editId))");
    expect(appSource).toContain("const opening = useMemo(() => editing === null ? null : draftFromTransaction(budget, editing), [budget, editing]);");
    // Строка — одна цель нажатия с именем операции; удаление живёт в форме, а не в строке.
    const markup = historyMarkup(withAllFlows());
    expect(markup).toMatch(/<button class="row-open" type="button" aria-label="Изменить операцию «Возврат 1 500 ₽ от 2026-07-07»"/u);
    expect(markup).not.toContain("Удалить операцию");
    // Вкладке кнопка «назад» не нужна; подэкрану, который её передаёт, — нужна.
    expect(markup).toContain("К разделу «Ещё»");
    expect(plainText(renderToStaticMarkup(<HistoryScreen budget={withAllFlows()} onEdit={vi.fn()} onAdd={vi.fn()} />))).not.toContain("К разделу «Ещё»");
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

  it("«Итоги и остатки» на «Отчётах» называют те же числа, что раньше стояли под табло", () => {
    const state = withAllFlows();
    const text = textOf(plainText(renderToStaticMarkup(<TotalsFact budget={state} metrics={calculateBudget(state)} />)));
    expect(text).toContain("Итоги и остатки");
    expect(text).toContain("Доход 100 000 ₽");
    expect(text).toContain("Расходы с учётом возвратов 75 150 ₽");
    expect(text).toContain("Капитал 24 850 ₽");
    expect(text).toContain("Основной 9 850 ₽");
    expect(text).toContain("Накопительный 15 000 ₽");
    expect(reportsSource).toContain("<li><TotalsFact budget={budget} metrics={metrics} /></li>");
  });
});

describe("слова о движении по долгу", () => {
  it("называет четыре глагола по виду и направлению, а без долга — вид", () => {
    expect(debtVerb("debt_out", "owed_to_me")).toBe("Дал в долг");
    expect(debtVerb("debt_out", "i_owe")).toBe("Вернул долг");
    expect(debtVerb("debt_in", "i_owe")).toBe("Взял в долг");
    expect(debtVerb("debt_in", "owed_to_me")).toBe("Мне вернули долг");
    expect(debtVerb("debt_out", undefined)).toBe("Долг: со счёта");
    expect(kindSign("debt_out")).toBe("−");
    expect(kindSign("debt_in")).toBe("+");
  });

  it("показывает счёт и того, с кем долг, в направлении денег", () => {
    const seed = makeSeedBudget();
    const debtId = "8f100000-0000-4000-8000-0000000000d1";
    const budget = { ...seed, debts: [{ id: debtId, counterparty: "Петя", direction: "owed_to_me" as const, currency: "RUB", openingMinor: 0, active: true }] };
    const movement = { id: "8d100000-0000-4000-8000-000000000007", status: "posted" as const, occurredOn: "2026-07-09", amountMinor: 500_000, accountId: SEED_IDS.accounts.main, debtId };
    expect(transactionDetail({ ...movement, kind: "debt_out" }, budget)).toBe("Основной → Петя");
    expect(transactionDetail({ ...movement, kind: "debt_in" }, budget)).toBe("Петя → Основной");
    expect(transactionDetail({ ...movement, kind: "debt_in", debtId: "missing" }, budget)).toBe("Неизвестный долг → Основной");
  });
});

describe("строка истории по счёту в другой валюте", () => {
  const DOLLARS = "c5555555-5555-4555-8555-555555555551";
  const withDollarExpense = (): BudgetState => {
    const seed = makeSeedBudget();
    return {
      ...seed,
      accounts: [...seed.accounts, { id: DOLLARS, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true }],
      transactions: [...seed.transactions, {
        id: "c5555555-5555-4555-8555-555555555552", occurredOn: "2026-07-10", status: "posted", kind: "expense", amountMinor: 4_050,
        accountId: DOLLARS, categoryId: SEED_IDS.categories.food, baseAmountMinor: 364_500, baseCurrency: "RUB", rate: { baseMinor: 9_000, quoteMinor: 100 },
      }],
    };
  };

  it("подписана валютой своего счёта, а не рублями", () => {
    const markup = plainText(renderToStaticMarkup(<HistoryScreen budget={withDollarExpense()} onEdit={vi.fn()} onAdd={vi.fn()} onBack={vi.fn()} />));
    // The sum is set by `Money` like a rouble one: the currency sign muted in its own element.
    expect(markup).toContain('−40,50<span class="money-currency"> $</span>');
    expect(markup).toContain("Изменить операцию «Расход 40,50 $ от 2026-07-10»");
    expect(markup).not.toContain("40,50 ₽");
    // A rouble row next to it is drawn exactly as before.
    expect(markup).toContain(`Изменить операцию «Расход ${plainText(formatMoney(makeSeedBudget().transactions.find((item) => item.kind === "expense")!.amountMinor))}`);
  });

  it("называет сумму с её валютой и в словах экрана", () => {
    const state = withDollarExpense();
    const dollar = state.transactions.at(-1)!;
    expect(plainText(amountText(dollar, state))).toBe("40,50 $");
    expect(transactionCurrency(dollar, state)).toBe("USD");
    expect(plainText(amountText({ ...dollar, amountMinor: 4_000 }, state))).toBe("40 $");
    const rouble = state.transactions[0]!;
    expect(amountText(rouble, state)).toBe(formatMoney(rouble.amountMinor));
    expect(transactionCurrency(rouble, state)).toBe("RUB");
  });
});

