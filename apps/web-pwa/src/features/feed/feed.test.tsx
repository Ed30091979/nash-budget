/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { PLANNING_IDS, type BudgetState, type Transaction } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { buildDemoBudgetState, DEMO_IDS } from "../../onboarding/demo";
import { FeedScreen } from "./FeedScreen";
import { FilterSheet } from "./FilterSheet";

const TODAY = "2026-10-19";
const plain = (markup: string) => markup.replace(/<[^>]*>/gu, " ").replace(/&nbsp;/gu, " ").replace(/[\u00a0\u202f]/gu, " ").replace(/&quot;/gu, "\"").replace(/\s+/gu, " ").trim();

function feed(budget: BudgetState, filters: Record<string, string> = {}): string {
  return renderToStaticMarkup(<FeedScreen budget={budget} today={TODAY} filters={filters} onFilters={vi.fn()} onEdit={vi.fn()} onAdd={vi.fn()} onImport={vi.fn()} />);
}

describe("«Операции» на демо (макет 08)", () => {
  it("крупный заголовок, поиск, чипы, итоги и дни с итогом дня без переводов", () => {
    const demo = buildDemoBudgetState(TODAY);
    const markup = feed(demo);
    const text = plain(markup);
    expect(markup).toMatch(/<h1 id="feed-title">[\s\S]*?<span class="sr-only">Операции<\/span><\/h1>/u);
    expect(markup).toContain('aria-label="Загрузить выписку банка"');
    // Поиск — подписанное поле без формы: в адрес он не уходит ни GET-запросом, ни иначе.
    expect(markup).toContain('<label class="visually-hidden" for="feed-search">Поиск по операциям</label>');
    expect(markup).toContain('placeholder="Сумма, комментарий, #метка"');
    expect(markup).not.toContain("<form");
    // Чипы: период, счета, категории, метки; «Участник» — только в семье.
    for (const chip of ["Весь период", "Все счета", "Все категории", "Метки"]) expect(markup, chip).toContain(`<bdi dir="auto">${chip}</bdi>`);
    expect(markup).not.toContain(">Участник</bdi>");
    expect(markup).toContain('aria-haspopup="dialog"');
    // Итоги — только у найденного: вся история без фильтра их не показывает.
    expect(markup).not.toContain('class="feed-sum"');
    expect(plain(feed(demo, { from: "2026-10-01", to: "2026-10-31" }))).toContain("Расходы 71 000 ₽ Доходы 70 000 ₽");
    // Дни словами, итог дня справа; 10-го — перевод, 12-го — ещё и долг: в итог дня они не входят.
    expect(text).toContain("Сегодня, 19 октября Итог дня: −600 ₽");
    expect(text).toContain("Вчера, 18 октября Итог дня: −5 900 ₽");
    expect(text).toContain("16 октября, пятница Итог дня: −2 150 ₽");
    expect(text).toContain("12 октября, понедельник Итог дня: −3 900 ₽");
    expect(text).not.toContain("10 октября, суббота Итог дня");
    // Будущая выплата — «ожидается».
    expect(text).toContain("Завтра, 20 октября ожидается");
    // Строки: название, «счёт · метка», сумма со знаком; ожидаемая — пунктиром и словом.
    expect(text).toContain("Продукты Карта · #дача −3 400 ₽");
    expect(text).toContain("Перевод Карта → Наличные 10 000 ₽");
    expect(text).toContain("Дал в долг: Саша Карта −5 000 ₽");
    expect(markup).toMatch(/<li class="feed-row pending"><button class="feed-open" type="button" aria-label="Изменить операцию «Доход 110[\u00a0 ]000[\u00a0 ]₽ от 2026-10-20»: Зарплата, Карта, ожидается">/u);
    expect(markup).toContain('class="icon-plate feed-plate tone-');
    // С историей пяти месяцев демо длиннее страницы: первые 50 и «Показать ещё».
    const all = demo.transactions.length;
    expect(all).toBeGreaterThan(50);
    expect(text).toContain(`Показано 50 из ${all}`);
    expect(text).toContain(`Показать ещё ${Math.min(50, all - 50)}`);
    expect(markup).not.toMatch(/\sstyle=/u);
  });

  it("фильтр из адреса: чип называет выбранное и чернильный; найденное — «Найдено N из M»", () => {
    const demo = buildDemoBudgetState(TODAY);
    const markup = feed(demo, { cat: PLANNING_IDS.categories.food.toLowerCase(), from: "2026-10-01", to: "2026-10-31" });
    expect(markup).toMatch(/data-set="true"><span class="chip-face"><bdi dir="auto">Продукты<\/bdi>/u);
    expect(markup).toMatch(/data-set="true"><span class="chip-face"><bdi dir="auto">Октябрь<\/bdi>/u);
    const text = plain(markup);
    expect(text).toContain("Расходы 22 000 ₽ Доходы 0 ₽");
    expect(text).toMatch(/Найдено 6 из \d+\. Показано 6 из 6/u);
    expect(text).not.toContain("Транспорт");
    // «дача» — две покупки октября и три в истории; за октябрь — две.
    expect(plain(feed(demo, { tag: DEMO_IDS.tags.dacha }))).toMatch(/Найдено 5 из/u);
    const tag = plain(feed(demo, { tag: DEMO_IDS.tags.dacha, from: "2026-10-01", to: "2026-10-31" }));
    expect(tag).toContain("#дача");
    expect(tag).toMatch(/Найдено 2 из/u);
  });

  it("по 50 строк: «Показать ещё 50», и дни страницы держат итог всего дня", () => {
    const demo = buildDemoBudgetState(TODAY);
    const many: Transaction[] = Array.from({ length: 120 }, (_, index) => ({
      id: `9b000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      occurredOn: "2026-09-16", status: "posted", kind: "expense", amountMinor: 10_000, accountId: DEMO_IDS.accounts.card, categoryId: PLANNING_IDS.categories.food,
    }));
    const budget = { ...demo, transactions: [...demo.transactions, ...many] };
    const text = plain(feed(budget, { from: "2026-09-16", to: "2026-09-16" }));
    expect(text).toContain("Показать ещё 50");
    expect(text).toContain("Найдено 120 из");
    expect(text).toContain("Показано 50 из 120");
    expect(text).toContain("16 сентября, среда Итог дня: −12 000 ₽");
  });

  it("лист фильтра — модальный диалог: заголовок, крестик, варианты с `aria-pressed` и галочкой у выбранного", () => {
    const markup = renderToStaticMarkup(
      <FilterSheet id="feed-account" title="Счёт" onClose={vi.fn()} groups={[{ key: "a", choices: [
        { key: "all", label: "Все счета", selected: false, onSelect: vi.fn() },
        { key: "card", label: "Карта", plate: { icon: "credit-card", tone: null }, selected: true, onSelect: vi.fn() },
      ] }]} />,
    );
    expect(markup).toContain('role="dialog" aria-modal="true" aria-labelledby="feed-account-title"');
    expect(markup).toContain('<h2 id="feed-account-title">Счёт</h2>');
    expect(markup).toContain('aria-label="Закрыть"');
    expect(markup).toMatch(/<button class="filter-choice" type="button" aria-pressed="true"><span class="icon-plate filter-plate plate-account">[\s\S]*?Карта[\s\S]*?filter-check/u);
    expect(markup).toMatch(/<button class="filter-choice" type="button" aria-pressed="false">/u);
  });

  it("строка поиска — память экрана: `useState`, ни адреса, ни состояния истории", () => {
    const source = readFileSync(new URL("./FeedScreen.tsx", import.meta.url), "utf8");
    expect(source).toContain('const [search, setSearch] = useState("");');
    // Смена фильтра пишет в адрес только ключи фильтров — из модели, где строки поиска нет.
    expect(source).toContain("for (const [key, value] of Object.entries({ ...routeOfFilters(filters), ...change }))");
    const calls = [...source.matchAll(/\bonFilters\(([^)]*)\)/gu)].map((match) => match[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toMatch(/search|parsed|deferred/u);
  });
});
