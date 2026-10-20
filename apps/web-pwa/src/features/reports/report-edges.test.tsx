import { renderToStaticMarkup } from "react-dom/server";
import { G003, toDomainBudgetState } from "@family-budget/test-fixtures";
import { materializeRecurring, type BudgetState } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { parseRoute, type ReportsFields, type Route } from "../../navigation/routes";
import { reportModel, reportsFieldsForMonth } from "./report-model";
import { ReportsScreen } from "./ReportsScreen";

/**
 * Края «Отчётов» (ревью 2d): период у начала календаря и счёт, чей UUID записан заглавными.
 *
 * HIGH-1. Календарь приложения — с 1900-01-01 (`MIN_LOCAL_DATE`). Месяц, квартал и год у его
 * начала и свой период, длиннее того, что до него осталось, искали «прошлый период той же длины»
 * до 1900 года, и расчёт падал — экран «Отчётов» становился белым. Теперь прошлого периода у них
 * нет, сравнение говорит это словами, а второй расчёт не делается.
 *
 * MEDIUM-1. Адрес пишет UUID строчными, а бюджет хранит его так, как он пришёл (копия и журнал
 * принимают любой регистр). Отчёт по счёту сравнивал их с учётом регистра и показывал ноль там,
 * где «Операции» по тому же счёту показывали 15 500 ₽.
 */

const TODAY = "2026-10-19";
const plain = (markup: string) => markup.replace(/<[^>]*>/gu, " ").replace(/&nbsp;/gu, " ").replace(/[\u00a0\u202f]/gu, " ").replace(/&quot;/gu, "\"").replace(/&#x27;/gu, "'").replace(/\s+/gu, " ").trim();

function ledger(): BudgetState {
  return materializeRecurring(toDomainBudgetState(G003), G003.materializeThrough).state;
}

/** G-003 и одна покупка в самом начале календаря: отчёту у края есть что показать. */
function ledgerFrom1900(): BudgetState {
  const state = ledger();
  const card = G003.state.accounts[0]!.id;
  const food = G003.state.categories[0]!.id;
  return {
    ...state,
    transactions: [
      ...state.transactions,
      { id: "85555555-5555-4555-8555-555555551900", occurredOn: "1900-01-15", status: "posted", kind: "expense", amountMinor: 120_000, accountId: card, categoryId: food },
    ],
  };
}

function reportsFieldsOf(hash: string): ReportsFields {
  const parsed = parseRoute(hash);
  expect(parsed.notFound, hash).toBe(false);
  const route = parsed.route as Extract<Route, { readonly name: "reports" }>;
  expect(route.name).toBe("reports");
  const { name: _name, ...fields } = route;
  return fields;
}

/** Пять адресов ревью: каждый — то, куда человек попадает касанием или ссылкой. */
const EDGE_ADDRESSES: readonly (readonly [string, () => ReportsFields])[] = [
  ["#/reports?period=month&from=1900-01-01", () => reportsFieldsOf("#/reports?period=month&from=1900-01-01")],
  // «Обзор» января 1900 года → «Расходы» → «Отчёты» того же месяца.
  ["#/?month=1900-01 → «Расходы»", () => {
    const overview = parseRoute("#/?month=1900-01");
    expect(overview.notFound).toBe(false);
    const route = overview.route as Extract<Route, { readonly name: "overview" }>;
    return reportsFieldsForMonth(route.month!, TODAY);
  }],
  ["#/reports?period=quarter&from=1900-02-01", () => reportsFieldsOf("#/reports?period=quarter&from=1900-02-01")],
  ["#/reports?period=year&from=1900-06-01", () => reportsFieldsOf("#/reports?period=year&from=1900-06-01")],
  // «Свой период»: с 01.01.1960 по сегодня — прошлый период той же длины начался бы в 1893 году.
  ["«Свой период» 1960-01-01 … сегодня", () => reportsFieldsOf(`#/reports?period=custom&from=1960-01-01&to=${TODAY}`)],
];

describe("HIGH-1: «Отчёты» у начала календаря не падают", () => {
  for (const [address, fieldsOf] of EDGE_ADDRESSES) {
    it(`${address}: модель без прошлого периода, сравнение словами`, () => {
      const fields = fieldsOf();
      for (const view of ["expense", "income", "tags"] as const) {
        const model = reportModel(ledgerFrom1900(), { ...fields, view }, TODAY);
        expect(model.period.previous, `${address} ${view}`).toBeNull();
        expect(model.comparison, `${address} ${view}`).toEqual({ kind: "calendar-start" });
        // Столбцы «По месяцам» — только месяцы календаря.
        expect(model.period.months.every((month) => month >= "1900-01"), `${address} ${view}`).toBe(true);
      }
    });

    it(`${address}: экран рисуется и говорит, почему сравнить не с чем`, () => {
      const fields = fieldsOf();
      for (const view of [undefined, "income", "tags"] as const) {
        const markup = renderToStaticMarkup(
          <ReportsScreen budget={ledgerFrom1900()} today={TODAY} fields={view === undefined ? fields : { ...fields, view }} onFields={vi.fn()} onFeed={vi.fn()} onAdd={vi.fn()} />,
        );
        expect(markup).toContain("<h1>Отчёты</h1>");
        if (view === undefined) expect(plain(markup)).toContain("сравнить не с чем — записи ведутся с 1900 года");
      }
    });
  }

  it("месяц 1900 года: «1 200 ₽ за январь 1900; сравнить не с чем …», столбец — один январь", () => {
    const model = reportModel(ledgerFrom1900(), reportsFieldsOf("#/reports?period=month&from=1900-01-01"), TODAY);
    expect(model.totalMinor).toBe(120_000);
    expect(model.period.months).toEqual(["1900-01"]);
    expect(model.bars.map((bar) => [bar.month, bar.amountMinor])).toEqual([["1900-01", 120_000]]);
    const markup = renderToStaticMarkup(<ReportsScreen budget={ledgerFrom1900()} today={TODAY} fields={{ period: "month", from: "1900-01-01" }} onFields={vi.fn()} onFeed={vi.fn()} onAdd={vi.fn()} />);
    expect(plain(markup)).toContain("1 200 ₽ за январь 1900; сравнить не с чем — записи ведутся с 1900 года");
  });

  it("февраль 1900 года сравнивается с январём: прошлый период в календаре есть", () => {
    const model = reportModel(ledgerFrom1900(), { period: "month", from: "1900-02-01" }, TODAY);
    expect(model.period.previous).toMatchObject({ from: "1900-01-01", to: "1900-01-31" });
    expect(model.previousMinor).toBe(120_000);
    expect(model.period.months).toEqual(["1900-01", "1900-02"]);
  });

  it("свой период с первого дня календаря: прошлого нет; с 1900-01-02 на один день — есть", () => {
    expect(reportModel(ledgerFrom1900(), { period: "custom", from: "1900-01-01", to: "1900-01-31" }, TODAY).period.previous).toBeNull();
    expect(reportModel(ledgerFrom1900(), { period: "custom", from: "1900-01-02", to: "1900-01-02" }, TODAY).period.previous).toMatchObject({ from: "1900-01-01", to: "1900-01-01" });
  });
});

/**
 * G-003, где UUID карты записан заглавными — и у счёта, и у каждой операции, что на него ссылается.
 * У канонического UUID карты нет ни одной буквы, поэтому он заменён тем, в котором буквы есть:
 * иначе заглавные и строчные совпали бы и проверять было бы нечего.
 */
const CARD_UPPER = "8ABCDEF2-2222-4222-8222-2222222222CA";
function ledgerWithUpperCaseCard(): { readonly state: BudgetState; readonly card: string } {
  const canonical = G003.state.accounts[0]!.id;
  const state = JSON.parse(JSON.stringify(ledger()).replaceAll(canonical, CARD_UPPER)) as BudgetState;
  expect(state.accounts[0]).toMatchObject({ id: CARD_UPPER, name: "Карта" });
  expect(state.transactions.filter((item) => "accountId" in item && item.accountId === CARD_UPPER).length).toBeGreaterThan(0);
  return { state, card: CARD_UPPER.toLowerCase() };
}

describe("MEDIUM-1: отчёт по счёту — без учёта регистра UUID", () => {
  it("«Карта» с заглавным UUID: август — 15 500 ₽ «Продуктов», как в «Операциях»", () => {
    const { state, card } = ledgerWithUpperCaseCard();
    const fields = reportsFieldsOf(`#/reports?period=month&from=2026-08-01&acc=${card.toUpperCase()}`);
    // Адрес пишет UUID строчными.
    expect(fields.acc).toBe(card);
    const model = reportModel(state, fields, TODAY);
    expect(model.totalMinor).toBe(1_550_000);
    expect(model.table.map((row) => [row.name, row.amountMinor])).toEqual([["Продукты", 1_550_000]]);
    expect(reportModel(state, { ...fields, view: "income" }, TODAY).totalMinor).toBe(12_000_000);
    expect(reportModel(state, { ...fields, view: "tags" }, TODAY).tags.map((row) => [row.name, row.expenseMinor])).toEqual([["Дом", 1_550_000], ["Старое", 0]]);
    expect(model.bars.find((bar) => bar.month === "2026-08")?.amountMinor).toBe(1_550_000);
    // Тот же отчёт, что у канонической карты по её адресу.
    expect(model.totalMinor).toBe(reportModel(ledger(), { ...fields, acc: G003.state.accounts[0]!.id }, TODAY).totalMinor);
  });

  it("экран называет счёт и показывает его числа, а не «расходов нет»", () => {
    const { state, card } = ledgerWithUpperCaseCard();
    const markup = plain(renderToStaticMarkup(
      <ReportsScreen budget={state} today={TODAY} fields={{ period: "month", from: "2026-08-01", acc: card }} onFields={vi.fn()} onFeed={vi.fn()} onAdd={vi.fn()} />,
    ));
    expect(markup).toContain("Карта");
    expect(markup).toContain("Больше всего ушло на категорию «Продукты»");
    expect(markup).not.toContain("расходов нет");
  });
});
