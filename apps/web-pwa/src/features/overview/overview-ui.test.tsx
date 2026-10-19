import { calculateAnnualPlan, calculateBudget, makePlanningSeed, PLANNING_IDS, type BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BaseCurrencyProvider } from "../../components/Money";
import { softHyphenate } from "../../hyphenation";
import { formatMoney } from "../../money";
import { buildDemoBudgetState } from "../../onboarding/demo";
import { categorySpend } from "../reports/ReportsScreen";
import { periodClock } from "../../reach";
import { MonthSwitch } from "./MonthSwitch";
import { OverviewScreen, PickHintText, type OverviewScreenProps } from "./OverviewScreen";
import { pickHintParts, PICK_IDLE } from "./pick-model";

const SALARY = "a2000000-0000-4000-8000-0000000000c1";

function state(): BudgetState {
  const seed = makePlanningSeed();
  return {
    ...seed,
    categories: [...seed.categories, { id: SALARY, name: "Подработка и самозанятость", type: "income", group: "income", active: true, sortOrder: 100 }],
  };
}

function propsFor(budget: BudgetState, overrides: Partial<OverviewScreenProps> = {}): OverviewScreenProps {
  const plan = calculateAnnualPlan(budget, "2026-07", 24);
  return {
    budget,
    today: "2026-07-13",
    month: "2026-07",
    onMonth: vi.fn(),
    clock: periodClock({ startDate: "2026-07-01", endDate: "2026-07-31" }, [], "2026-07-13"),
    flexiblePlanMinor: plan.currentMonth.flexiblePlanMinor,
    familyNews: [],
    monthToOpen: null,
    openingMonth: false,
    onOpenMonth: vi.fn(),
    onOpenSheet: vi.fn(),
    onAddCategory: vi.fn(),
    onPlan: vi.fn(),
    onEdit: vi.fn(),
    ...overrides,
  };
}

function render(overrides: Partial<OverviewScreenProps> = {}, budget = state()): string {
  return renderToStaticMarkup(<OverviewScreen {...propsFor(budget, overrides)} />);
}

const plain = (markup: string) => markup.replace(/<[^>]+>/gu, "").replace(/[\u00a0\u202f]/gu, " ");

describe("«Обзор»: разметка", () => {
  it("месяц заголовком экрана, итоги и строка «Можно на повседневные» G-002", () => {
    const markup = render();
    expect(markup).toMatch(/<h1><span class="visually-hidden">Обзор, <\/span>Июль 2026<\/h1>/u);
    expect(markup).toContain('aria-label="Предыдущий месяц: июнь 2026"');
    expect(markup).toContain('aria-label="Следующий месяц: август 2026"');
    const text = plain(markup);
    expect(text).toContain("Всего на счетах");
    // «Потрачено» — весь расход месяца; доля по лимитам — своей подписью (MEDIUM-8).
    expect(text).toContain("Потрачено71 000 ₽по лимитам 26 000 ₽ из 53 000 ₽");
    expect(text).toContain("Можно на повседневные27 000 ₽");
    expect(markup).toMatch(/class="card reach-line [a-z]+"/u);
    // Одно число в строке — то, что ищут проверки и e2e (`.reach-line strong`).
    const reachLine = /<section class="card reach-line[^"]*"[\s\S]*?<\/section>/u.exec(markup)?.[0] ?? "";
    expect([...reachLine.matchAll(/<strong>/gu)]).toHaveLength(1);
  });

  it("плитка категории: полное имя, суммы и слово состояния — в доступном имени; глиф — на плитке", () => {
    const markup = render();
    expect(markup).toContain('aria-label="Продукты: потрачено 22 000 ₽ из 30 000 ₽. Записать расход"'.replace(/ (?=\d{3} ₽|₽)/gu, "\u00a0"));
    // «Жильё» оплачено по расписанию: лимита нет — нет и полосы, и состояния.
    expect(markup).toMatch(/aria-label="Жильё: потрачено 45[\u00a0 ]000[\u00a0 ]₽\. Записать расход"/u);
    const over: BudgetState = {
      ...state(),
      transactions: [...state().transactions, { id: "a2000000-0000-4000-8000-0000000000e1", kind: "expense", status: "posted", occurredOn: "2026-07-12", amountMinor: 900_000, accountId: state().accounts[0]!.id, categoryId: PLANNING_IDS.categories.food }],
    };
    const overMarkup = render({}, over);
    expect(overMarkup).toMatch(/aria-label="Продукты: потрачено 31[\u00a0 ]000[\u00a0 ]₽ из 30[\u00a0 ]000[\u00a0 ]₽, перелимит 1[\u00a0 ]000[\u00a0 ]₽\. Записать расход"/u);
    expect(overMarkup).toContain('class="tile-state over"');
    expect(overMarkup).toContain('#glyph-circle-alert');
    expect(overMarkup).toContain('class="tile-bar over" data-fill="100"');
    // Плитки категорий не выбираются: у них нет `aria-pressed`.
    expect(/<button class="tile tile-expense[^>]*aria-pressed/u.test(markup)).toBe(false);
  });

  it("счета — выбираемые плитки с `aria-pressed`, доходы — ряд, «+» — с именем того, что добавится", () => {
    const markup = render();
    expect(markup).toMatch(/<button class="tile tile-account" type="button" aria-label="Основной: остаток [^"]+" aria-pressed="false"/u);
    expect(markup).toContain('class="tile-grid tile-grid-accounts"');
    expect(markup).toContain('class="tile-grid tile-grid-row" aria-label="Источники дохода"');
    // Длинное имя целиком — в доступном имени, на плитке — до двух строк.
    expect(markup).toMatch(/aria-label="Подработка и самозанятость: 0[\u00a0 ]₽ за июль\. Затем выберите счёт"/u);
    expect(markup).toMatch(/aria-label="Без категории: 180[\u00a0 ]000[\u00a0 ]₽ за июль\. Затем выберите счёт"/u);
    expect(markup).toContain('aria-label="Добавить источник дохода"');
    expect(markup).toContain('aria-label="Добавить категорию расходов"');
    expect(markup).toMatch(/<p class="pick-hint" role="status">Коснитесь категории/u);
    // Сетка — та, что из §5; кикеры рядов — заголовки секций.
    expect(markup).toContain('class="tile-grid tile-grid-grid" aria-label="Категории расходов"');
    for (const kicker of ["Доходы", "Счета", "Расходы"]) expect(markup).toContain(`class="row-kicker">${kicker}</h2>`);
  });

  it("итоги и плитки — в базовой валюте семьи, которую ставит оболочка, а не в рублях по умолчанию", () => {
    const markup = renderToStaticMarkup(<BaseCurrencyProvider currency="USD"><OverviewScreen {...propsFor(state())} /></BaseCurrencyProvider>);
    expect(markup).toMatch(/aria-label="Продукты: потрачено 22[\u00a0 ]000[\u00a0 ]\$ из 30[\u00a0 ]000[\u00a0 ]\$\. Записать расход"/u);
    expect(markup).toMatch(/aria-label="Подработка и самозанятость: 0[\u00a0 ]\$ за июль/u);
    // Доходы и расходы — в базовой валюте; счёт называет свою валюту сам: рублёвый счёт — в рублях.
    const incomes = markup.slice(markup.indexOf('class="tile-grid tile-grid-row"'), markup.indexOf('class="tile-grid tile-grid-accounts"'));
    const accounts = markup.slice(markup.indexOf('class="tile-grid tile-grid-accounts"'), markup.indexOf('class="tile-grid tile-grid-grid"'));
    const expenses = markup.slice(markup.indexOf('class="tile-grid tile-grid-grid"'));
    expect(plain(incomes)).not.toContain("₽");
    expect(plain(expenses)).not.toContain("₽");
    expect(plain(accounts)).toContain("₽");
  });

  it("закрытый месяц плана — словами, с выходом «Открыть октябрь»; инлайновых стилей нет", () => {
    const markup = render({ today: "2026-10-19", month: "2026-10", clock: periodClock({ startDate: "2026-07-01", endDate: "2026-07-31" }, [], "2026-10-19"), monthToOpen: "2026-10" });
    const text = plain(markup);
    expect(text).toContain("Июль закрыт: осталось от повседневных лимитов июля");
    expect(text).toContain("27 000 ₽");
    expect(text).toContain("Открыть октябрь");
    expect(text).toContain("Потрачено0 ₽");
    expect(markup).not.toMatch(/\sstyle=/u);
  });
});

describe("«Обзор»: месяц на краю календаря", () => {
  it("у первого и последнего месяца окна домена стрелка за край выключена, а не бросает", () => {
    // Ревью 2b, MEDIUM-7: стрелка у 0000-01 и 9999-12 бросала исключение и роняла приложение.
    const first = renderToStaticMarkup(<MonthSwitch month="1900-01" onMonth={vi.fn()} />);
    expect(first).toMatch(/<button class="month-arrow" type="button" disabled="" aria-label="Предыдущий месяц: нет — раньше 1900 года месяцев нет">/u);
    expect(first).toMatch(/<button class="month-arrow" type="button" aria-label="Следующий месяц: февраль 1900">/u);
    const last = renderToStaticMarkup(<MonthSwitch month="2199-12" onMonth={vi.fn()} />);
    expect(last).toMatch(/<button class="month-arrow" type="button" disabled="" aria-label="Следующий месяц: нет — позже 2199 года месяцев нет">/u);
    expect(() => render({ month: "1900-01" })).not.toThrow();
    expect(() => render({ month: "2199-12" })).not.toThrow();
  });
});

describe("«Обзор»: «Потрачено» — весь расход месяца", () => {
  it("демо, октябрь 2026: 71 000 ₽ — столько же, сколько в «Отчётах»; по лимитам — 26 000 из 53 000 под своей подписью", () => {
    // Ревью 2b, MEDIUM-8: шапка говорила «Потрачено 26 000 ₽ из 53 000 ₽», а расход октября —
    // 71 000 ₽ (Жильё 45 000 + Продукты 22 000 + Транспорт 4 000). Слово «Потрачено» читают как весь
    // расход; доля лимитов — другое число и названа словами «по лимитам».
    const today = "2026-10-19";
    const demo = buildDemoBudgetState(today);
    const active = demo.budgets.find((item) => item.id === demo.activeBudgetId)!;
    const plan = calculateAnnualPlan(demo, active.startDate.slice(0, 7), 24);
    const markup = renderToStaticMarkup(<OverviewScreen {...propsFor(demo, {
      today,
      month: "2026-10",
      clock: periodClock(active, [], today),
      flexiblePlanMinor: plan.currentMonth.flexiblePlanMinor,
    })} />);
    const totals = plain(/<dl class="overview-totals">[\s\S]*?<\/dl>/u.exec(markup)?.[0] ?? "");
    const reports = categorySpend(demo, calculateBudget(demo)).reduce((sum, row) => sum + row.spentMinor, 0);
    expect(reports).toBe(7_100_000);
    expect(calculateBudget(demo).expensesMinor).toBe(reports);
    expect(totals).toContain(`Потрачено${plain(formatMoney(reports))}`);
    expect(totals).toContain("по лимитам 26 000 ₽ из 53 000 ₽");
    expect(plain(markup)).toContain("Можно на повседневные27 000 ₽");
  });
});

describe("«Обзор»: имена, набранные семьёй, — изолированно от соседнего текста", () => {
  it("имя на плитке, в подсказке и в «В итог не вошли» — в `<bdi dir=\"auto\">`", () => {
    // Ревью 2b, LOW-4: имя справа налево или с цифрами в конце перемешивалось с рамкой фразы.
    const base = state();
    const RTL_ACCOUNT = "a2000000-0000-4000-8000-0000000000d7";
    const named: BudgetState = {
      ...base,
      accounts: [...base.accounts, { id: RTL_ACCOUNT, name: "حساب 2", type: "cash", currency: "USD", openingBalanceMinor: 1_000, active: true }],
      categories: base.categories.map((category) => (category.id === PLANNING_IDS.categories.food ? { ...category, name: "مطبخ" } : category)),
    };
    const markup = render({}, named);
    expect(markup).toContain('<span class="tile-name" aria-hidden="true"><bdi dir="auto">مطبخ</bdi></span>');
    expect(markup).toContain('<span class="tile-name" aria-hidden="true"><bdi dir="auto">حساب 2</bdi></span>');
    expect(markup).toContain(`<span class="tile-name"><bdi dir="auto">${softHyphenate("Подработка и самозанятость")}</bdi></span>`);
    expect(markup).toContain('«<bdi dir="auto">حساب 2</bdi>» — нет курса USD');
    const selected = { ...PICK_IDLE, selected: { kind: "account" as const, id: RTL_ACCOUNT } };
    const hint = renderToStaticMarkup(<PickHintText parts={pickHintParts(selected, { account: () => "حساب 2", income: () => "" })} />);
    expect(hint).toBe('Выбран счёт «<bdi dir="auto">حساب 2</bdi>». Теперь категория — расход с него, другой счёт — перевод, этот же счёт — снять выбор.');
  });
});

describe("«Обзор»: источник дохода в архиве", () => {
  it("с доходом этого месяца — плитка-итог «в архиве», которую не нажать: лист с «Без категории» она не откроет", () => {
    // Ревью 2b, LOW-7: плитка архивного источника открывала лист дохода «Без категории».
    const GIFTS = "a2000000-0000-4000-8000-0000000000c2";
    const base = state();
    const budget: BudgetState = {
      ...base,
      categories: [...base.categories, { id: GIFTS, name: "Подарки", type: "income", group: "income", active: false, sortOrder: 110 }],
      transactions: [...base.transactions, { id: "a2000000-0000-4000-8000-0000000000e9", kind: "income", status: "posted", occurredOn: "2026-07-05", amountMinor: 500_000, accountId: base.accounts[0]!.id, categoryId: GIFTS }],
    };
    const markup = render({}, budget);
    const tile = /<div class="tile tile-income tile-static"[^>]*>[\s\S]*?<\/div>/u.exec(markup)?.[0] ?? "";
    expect(tile).toMatch(/^<div class="tile tile-income tile-static" role="group" aria-label="Подарки, в архиве: 5[\u00a0 ]000[\u00a0 ]₽ за июль">/u);
    expect(plain(tile)).toContain("в архиве");
    expect(markup).not.toMatch(/<button[^>]*aria-label="Подарки/u);
    expect(markup).not.toContain('data-tile="income:a2000000-0000-4000-8000-0000000000c2"');
  });
});
