import { calculateAnnualPlan, makePlanningSeed, PLANNING_IDS, type BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BaseCurrencyProvider } from "../../components/Money";
import { periodClock } from "../../reach";
import { OverviewScreen, type OverviewScreenProps } from "./OverviewScreen";

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
    expect(text).toContain("Потрачено26 000 ₽ из 53 000 ₽");
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
