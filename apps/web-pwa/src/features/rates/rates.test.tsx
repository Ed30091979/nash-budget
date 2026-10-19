import {
  addExchangeRate,
  BaseCurrencyValidationError,
  findRate,
  makePlanningSeed,
  RateValidationError,
  setBaseCurrency,
  type BudgetState,
  type ExchangeRate,
} from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BudgetWriteRefusal } from "../../write-refusal";
import { RateQuickSheet } from "./RateQuickSheet";
import { RatesScreen } from "./RatesScreen";
import { formatDayYear, formatDayYearLine } from "../../date-words";
import { baseCurrencyState, currencyRates, familyCurrencies, rateSavedText, rateWords, ratesErrorText, ratesNote } from "./rates-model";

const TODAY = "2026-10-19";
const DOLLARS = "e2c00000-0000-4000-8000-0000000000a1";
const TENGE = "e2c00000-0000-4000-8000-0000000000a2";
const OLD_EUROS = "e2c00000-0000-4000-8000-0000000000a3";

const rate = (id: string, currency: string, date: string, baseMinor: number, quoteMinor: number, baseCurrency = "RUB"): ExchangeRate =>
  ({ id: `e2c00000-0000-4000-8000-0000000001${id}`, currency, baseCurrency, date, rate: { baseMinor, quoteMinor } });

function state(): BudgetState {
  const seed = makePlanningSeed();
  return {
    ...seed,
    accounts: [
      ...seed.accounts,
      { id: TENGE, name: "Тенге", type: "cash", currency: "KZT", openingBalanceMinor: 1_000_000, active: true, sortOrder: 30 },
      { id: DOLLARS, name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 50_000, active: true, sortOrder: 20 },
      { id: OLD_EUROS, name: "Евро в архиве", type: "cash", currency: "EUR", openingBalanceMinor: 0, active: false, sortOrder: 40 },
    ],
    exchangeRates: [
      rate("01", "USD", "2026-10-01", 9_000, 100),
      rate("02", "USD", "2026-10-15", 9_250, 100),
      rate("03", "USD", "2026-10-15", 9_300, 100),
      rate("04", "USD", "2026-11-01", 9_500, 100),
      rate("05", "KZT", "2026-10-10", 1_840, 10_000),
      rate("06", "GBP", "2026-09-01", 11_800, 100),
    ],
  };
}

describe("курсы: модель", () => {
  it("валюты семьи — валюты счетов по порядку списка, затем валюты одних курсов; базы нет", () => {
    expect(familyCurrencies(state())).toEqual(["USD", "KZT", "EUR", "GBP"]);
    expect(familyCurrencies(makePlanningSeed())).toEqual([]);
  });

  it("курс сегодня — тот, что выбирает `findRate`: последний не позже дня, при равной дате — больший идентификатор", () => {
    const budget = state();
    const [usd, kzt, eur, gbp] = currencyRates(budget, TODAY);
    expect(usd?.current).toBe(findRate(budget.exchangeRates ?? [], "USD", "RUB", TODAY));
    expect(usd?.current?.id).toBe(rate("03", "USD", "", 0, 0).id);
    // История — от нового к старому, будущий курс тоже в ней; первый из равных — тот, что выбран.
    expect(usd?.history.map((item) => item.id.slice(-2))).toEqual(["04", "03", "02", "01"]);
    expect(kzt).toMatchObject({ per: 100, accountNames: ["Тенге"] });
    expect(eur).toMatchObject({ current: undefined, history: [], accountNames: ["Евро в архиве"] });
    expect(gbp?.accountNames).toEqual([]);
  });

  it("курс словами — как его набирают: «1 USD = 93,00 ₽», для слабых валют — за сотню", () => {
    const [usd, kzt] = currencyRates(state(), TODAY);
    expect(rateWords(usd!.current!)).toBe("1 USD = 93,00\u00a0₽");
    expect(rateWords(kzt!.current!)).toBe("100 KZT = 18,40\u00a0₽");
    expect(ratesNote(state(), TODAY)).toBe("база RUB · 1 USD = 93,00 · 100 KZT = 18,40 · EUR — нет курса · 1 GBP = 118,00");
    expect(ratesNote(makePlanningSeed(), TODAY)).toBe("база RUB · курсов нет");
  });

  it("после записи: новый день — «записан», тот же день — «исправлен: был…, стал…», то же значение — «не изменился»", () => {
    const fresh = addExchangeRate(state(), { currency: "USD", date: "2026-10-19", rate: { baseMinor: 9_400, quoteMinor: 100 } }, () => rate("90", "", "", 0, 0).id);
    expect(rateSavedText(fresh)).toBe("Курс USD с 19\u00a0октября записан.");
    // 15 октября — два курса с двух устройств; поправка исправляет тот, что был текущим, 93,00.
    const corrected = addExchangeRate(state(), { currency: "USD", date: "2026-10-15", rate: { baseMinor: 9_350, quoteMinor: 100 } });
    expect(rateSavedText(corrected)).toBe("Курс USD на 15\u00a0октября исправлен: был 93,00, стал 93,50.");
    const kzt = addExchangeRate(state(), { currency: "KZT", date: "2026-10-10", rate: { baseMinor: 1_840, quoteMinor: 10_000 } });
    expect(rateSavedText(kzt)).toBe("Курс KZT на 10\u00a0октября не изменился: 18,40.");
  });

  it("дата строкой экрана: день с месяцем неразрывны, год может уйти на новую строку — число не рвётся", () => {
    expect(formatDayYear("2026-10-14")).toBe("14\u00a0октября\u00a02026");
    expect(formatDayYearLine("2026-10-14")).toBe("14\u00a0октября 2026");
    const markup = renderToStaticMarkup(<RatesScreen budget={state()} today={TODAY} write={{ run: vi.fn() } as never} onBack={() => undefined} />);
    expect(markup).toContain('<span class="rate-history-day">15\u00a0октября 2026</span>');
  });

  it("базовая валюта: пока бюджет пуст — меняется, иначе — словами того, что её держит", () => {
    const seed = makePlanningSeed();
    expect(baseCurrencyState(seed)).toEqual({ currency: "RUB", lockText: "Базовую валюту не сменить: уже записаны операции. Она задаётся один раз, пока бюджет пуст." });
    const empty: BudgetState = { ...seed, transactions: [], budgets: seed.budgets.map((budget) => ({ ...budget, lines: [], plannedIncomeMinor: 0 })), annualCommitments: [], scheduledExpenses: [], goals: [] };
    expect(baseCurrencyState(empty)).toEqual({ currency: "RUB", lockText: null });
    expect(baseCurrencyState(setBaseCurrency(empty, "KZT"))).toEqual({ currency: "KZT", lockText: null });
    expect(baseCurrencyState({ ...empty, accounts: [...empty.accounts, { id: DOLLARS, name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 0, active: true }] }).lockText)
      .toBe("Базовую валюту не сменить: есть счета в другой валюте.");
  });

  it("отказы — словами домена; задержка — словами задержки; прочее — общими словами записи", () => {
    expect(ratesErrorText(new RateValidationError("base_currency", "currency", "Курс задаётся для валюты, которая не базовая."))).toBe("Курс задаётся для валюты, которая не базовая.");
    expect(ratesErrorText(new BaseCurrencyValidationError("has_rates", "x"))).toBe("x");
    expect(ratesErrorText(new BudgetWriteRefusal("held"))).toBe(new BudgetWriteRefusal("held").userMessage);
    expect(ratesErrorText(new TypeError("boom"))).toBe("Изменение не сохранилось. Повторите его.");
  });
});

const plain = (markup: string) => markup.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").replace(/\u00a0/gu, " ").trim();

describe("курсы: разметка", () => {
  const render = (budget = state()) => renderToStaticMarkup(<RatesScreen budget={budget} today={TODAY} write={{ run: vi.fn() }} onBack={vi.fn()} />);

  it("говорит, что курс ручной и записанное не переоценивает; база — с причиной, по которой её не сменить", () => {
    const text = plain(render());
    expect(text).toContain("Курс задаётся вручную и действует с его даты, пока не задан новый. Он не переоценивает записанное");
    expect(text).toContain("₽ Российский рубль — RUB");
    expect(text).toContain("Базовую валюту не сменить: уже записаны операции.");
    expect(render()).not.toContain("Сменить базовую валюту");
  });

  it("по каждой валюте — курс сегодня с датой, счета в ней и история с «Удалить»; без курса — предупреждение", () => {
    const markup = render();
    const text = plain(markup);
    expect(text).toContain("USD Доллар США 1 USD = 93,00 ₽ с 15 октября 2026");
    expect(text).toContain("Счета: « Доллары »");
    // Дата — одна величина: пробелы в ней неразрывные.
    expect(markup).toContain('aria-label="Удалить курс USD от 15\u00a0октября\u00a02026"');
    expect(markup).toContain('aria-label="Удалить курс USD от 1\u00a0ноября\u00a02026"');
    expect(text).toContain("100 KZT = 18,40 ₽");
    expect(text).toContain("Курса на сегодня нет: операция по счёту в EUR попросит его при записи");
    expect(markup.match(/Добавить курс (?:USD|KZT|EUR|GBP)</gu)).toHaveLength(4);
  });

  it("пустой бюджет может сменить базу; без валют — подсказка, зачем курсы", () => {
    const seed = makePlanningSeed();
    const empty: BudgetState = { ...seed, transactions: [], budgets: seed.budgets.map((budget) => ({ ...budget, lines: [], plannedIncomeMinor: 0 })), annualCommitments: [], scheduledExpenses: [], goals: [] };
    const markup = render(empty);
    expect(markup).toContain(">Сменить базовую валюту</button>");
    expect(plain(markup)).toContain("Счетов в другой валюте и курсов пока нет.");
  });

  it("группа «Новый курс» на экране: валюта на выбор без базы, день, «Сколько ₽ за 100 KZT»", () => {
    const markup = renderToStaticMarkup(
      <RateQuickSheet currency="KZT" baseCurrency="RUB" date={TODAY} screen={{ preferred: ["USD", "KZT"], draftLabel: "курс" }} onSave={vi.fn(async () => null)} onCancel={vi.fn()} />,
    );
    expect(markup).toContain(">Новый курс</h3>");
    expect(markup).toMatch(/<select id="[^"]+-currency">/u);
    expect(markup).not.toContain('value="RUB"');
    expect(markup).toMatch(/<input id="[^"]+-date" type="date" value="2026-10-19"/u);
    expect(plain(markup)).toContain("Сколько ₽ за 100 KZT");
    expect(markup).toContain('placeholder="18,40"');
    // В листе ввода — прежняя группа: валюта и день операции, без выбора.
    const sheet = renderToStaticMarkup(<RateQuickSheet currency="USD" baseCurrency="RUB" date={TODAY} onSave={vi.fn(async () => null)} onCancel={vi.fn()} />);
    expect(plain(sheet)).toContain("Курс USD с 19 октября");
    expect(sheet).not.toContain("<select");
    expect(sheet).not.toContain('type="date"');
  });
});
