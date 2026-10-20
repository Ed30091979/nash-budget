/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { PLANNING_IDS, type BudgetState, type Transaction } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { softHyphenate } from "../../hyphenation";
import { buildDemoBudgetState, DEMO_IDS } from "../../onboarding/demo";
import { FeedScreen } from "./FeedScreen";
import { FilterSheet } from "./FilterSheet";

const TODAY = "2026-10-19";
/** Текст для слуха: видимые копии `Hyphenated` (`aria-hidden`) убраны, остаётся его `sr-only`. */
const HYPHENATED_COPIES = /<span class="hyphenated" aria-hidden="true"><span class="hy-plain">[^<]*<\/span><span class="hy-soft">[^<]*<\/span><\/span>/gu;
const plain = (markup: string) => markup.replace(HYPHENATED_COPIES, "").replace(/<[^>]*>/gu, " ").replace(/&nbsp;/gu, " ").replace(/[\u00a0\u202f]/gu, " ").replace(/&quot;/gu, "\"").replace(/\s+/gu, " ").trim();

function feed(budget: BudgetState, filters: Record<string, string> = {}, today = TODAY, extra: { readonly back?: { readonly label: string; readonly onClick: () => void } } = {}): string {
  return renderToStaticMarkup(<FeedScreen budget={budget} today={today} filters={filters} onFilters={vi.fn()} onEdit={vi.fn()} onAdd={vi.fn()} onImport={vi.fn()} {...extra} />);
}

/** Чип фильтра: доступное имя — что он фильтрует, видимая подпись — что выбрано. */
const chip = (name: string, label: string, set = false) =>
  new RegExp(`aria-label="${name}"${set ? "" : "(?! data-set)"}${set ? ' data-set="true"' : ""}><span class="chip-face"><bdi dir="auto">${label}</bdi>`, "u");

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
    // Чипы: период, счета, категории, метки; «Участник» — только в семье. Доступное имя чипа говорит,
    // что он фильтрует: «Период: октябрь», а не просто «Октябрь» (LOW-11).
    expect(markup).toMatch(chip("Период: октябрь", "Октябрь"));
    expect(markup).toMatch(chip("Счёт: все счета", "Все счета"));
    expect(markup).toMatch(chip("Категория: все категории", "Все категории"));
    expect(markup).toMatch(chip("Метка: все метки", "Метки"));
    expect(markup).not.toContain(">Участник</bdi>");
    expect(markup).toContain('aria-haspopup="dialog"');
    // По умолчанию — текущий месяц: строка итогов и итоги дней говорят о нём (LOW-11). Ожидаемая
    // выплата 20-го в итоги не входит.
    expect(text).toContain("Расходы 71 000 ₽ Доходы 70 000 ₽");
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
    // Октябрь — 14 строк, все на одной странице; сентябрь в ленту по умолчанию не входит.
    expect(text).toContain("Показано 14 из 14");
    expect(text).not.toContain("сентября");
    expect(markup).not.toMatch(/\sstyle=/u);
  });

  it("«Весь период» — вся история пяти месяцев: страница 50 строк и «Показать ещё»; чип чернильный", () => {
    const demo = buildDemoBudgetState(TODAY);
    const markup = feed(demo, { period: "all" });
    const text = plain(markup);
    expect(markup).toMatch(chip("Период: весь период", "Весь период", true));
    const all = demo.transactions.length;
    expect(all).toBeGreaterThan(50);
    expect(text).toMatch(new RegExp(`Найдено ${all} из ${all}\\. Показано 50 из ${all}`, "u"));
    expect(text).toContain(`Показать ещё ${Math.min(50, all - 50)}`);
    expect(text).toContain("сентября");
    // Итоги всей истории — тоже строкой: расходы пяти месяцев истории и октября.
    expect(markup).toContain('class="feed-sum"');
  });

  it("название, подпись и день — с местами переноса для глаз, доступные имена — без мягких переносов (LOW-5)", () => {
    const markup = feed(buildDemoBudgetState(TODAY), { period: "all" });
    expect(markup).toContain(`<strong class="feed-title"><bdi dir="auto"><span class="hyphenated" aria-hidden="true"><span class="hy-plain">Продукты</span><span class="hy-soft">${softHyphenate("Продукты")}</span></span><span class="sr-only">Продукты</span></bdi></strong>`);
    expect(markup).toMatch(/<h2 id="feed-day-[\d-]+"><span class="hyphenated" aria-hidden="true">/u);
    expect(markup).toMatch(/<small class="feed-meta"><span><span class="hyphenated" aria-hidden="true">/u);
    const labels = [...markup.matchAll(/aria-label="([^"]*)"/gu)].map((match) => match[1]!);
    expect(labels.length).toBeGreaterThan(50);
    expect(labels.filter((label) => label.includes("\u00ad"))).toEqual([]);
  });

  it("месяц без записей, когда в других они есть: «Март: записей нет» и «Показать весь период»", () => {
    const demo = buildDemoBudgetState(TODAY);
    const text = plain(feed(demo, {}, "2027-03-10"));
    expect(text).toContain("Март: записей нет");
    expect(text).toContain("Записи других месяцев — за весь период.");
    expect(feed(demo, {}, "2027-03-10")).toMatch(/<button[^>]*class="primary-button[^"]*"[^>]*>Показать весь период<\/button>/u);
    // Пустой бюджет — по-прежнему «Записей пока нет».
    expect(plain(feed({ ...demo, transactions: [] }))).toContain("Записей пока нет");
  });

  it("лента из «Отчётов» — строкой заголовка «‹ Отчёты» с тем же `h1`; вкладка — крупным заголовком", () => {
    const demo = buildDemoBudgetState(TODAY);
    const markup = feed(demo, { cat: PLANNING_IDS.categories.food.toLowerCase() }, TODAY, { back: { label: "Отчёты", onClick: vi.fn() } });
    expect(markup).toMatch(/<header class="title-bar"><button class="title-bar-back" type="button">[\s\S]*?<span><span class="visually-hidden">Назад: <\/span>Отчёты<\/span><\/button><h1 id="feed-title">/u);
    expect(markup).toContain('aria-label="Загрузить выписку банка"');
    expect(markup).not.toContain('class="large-title"');
    expect(feed(demo)).toContain('<header class="large-title"><h1 id="feed-title">');
  });

  it("фильтр по участнику, вышедшему из семьи: его имя на чипе, чип виден, «Все участники» снимает (LOW-7)", () => {
    const demo = buildDemoBudgetState(TODAY);
    const ann = "6a000000-0000-4000-8000-0000000000a1";
    const family: BudgetState = {
      ...demo,
      members: [{ id: ann, name: "Аня", active: false } as NonNullable<BudgetState["members"]>[number]],
      transactions: demo.transactions.map((item, index) => (index === 0 ? { ...item, memberId: ann } : item)),
    };
    const markup = feed(family, { member: ann, period: "all" });
    // Активных участников нет, а фильтр задан — чип есть и называет участника по имени.
    expect(markup).toMatch(chip("Участник: Аня", "Аня", true));
    expect(plain(markup)).toMatch(/Найдено 1 из \d+/u);
    // Без фильтра и без активных участников чипа нет.
    expect(feed(family, { period: "all" })).not.toContain("Участник:");
  });

  it("фильтр из адреса: чип называет выбранное и чернильный; найденное — «Найдено N из M»", () => {
    const demo = buildDemoBudgetState(TODAY);
    const markup = feed(demo, { cat: PLANNING_IDS.categories.food.toLowerCase(), from: "2026-10-01", to: "2026-10-31" });
    expect(markup).toMatch(chip("Категория: Продукты", "Продукты", true));
    expect(markup).toMatch(chip("Период: октябрь", "Октябрь", true));
    const text = plain(markup);
    expect(text).toContain("Расходы 22 000 ₽ Доходы 0 ₽");
    expect(text).toMatch(/Найдено 6 из \d+\. Показано 6 из 6/u);
    expect(text).not.toContain("Транспорт");
    // «дача» — две покупки октября и три в истории: за весь период — пять, за октябрь по умолчанию — две.
    expect(plain(feed(demo, { tag: DEMO_IDS.tags.dacha, period: "all" }))).toMatch(/Найдено 5 из/u);
    expect(plain(feed(demo, { tag: DEMO_IDS.tags.dacha }))).toMatch(/Найдено 2 из/u);
    expect(feed(demo, { tag: DEMO_IDS.tags.dacha })).toMatch(chip("Метка: #дача", "#дача", true));
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
    expect(source).toContain("apply(patchFilters(routed, change))");
    const calls = [...source.matchAll(/\bonFilters\(([^)]*)\)/gu)].map((match) => match[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toMatch(/search|parsed|deferred/u);
  });
});
