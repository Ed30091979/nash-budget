/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { calculateAnnualPlan, makeSeedBudget, type BudgetState } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";

import { MEMBER_FILTER_ALL, MEMBER_FILTER_NONE, memberFilterOptions, membersById } from "./features/family/model";
import { HistoryScreen, operationsCount } from "./features/operations";
import { OverviewScreen } from "./features/overview/OverviewScreen";
import { readAppSource } from "./app/shell-source";
import { periodClock } from "./reach";

const appSource = readAppSource();
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/** Бюджет, в котором ещё ничего не записано: ровно то, с чем человек выходит из онбординга. */
function budgetWithoutOperations(): BudgetState {
  const seed = makeSeedBudget();
  return { ...seed, transactions: [] };
}

function budgetWithoutLimits(): BudgetState {
  const seed = budgetWithoutOperations();
  return { ...seed, budgets: seed.budgets.map((budget) => ({ ...budget, lines: [] })) };
}

/**
 * Три правила пустого состояния (§6 исследования, пункт 29, NN/g).
 *
 * Проверяется не текст, а то, что состояние отвечает на все три вопроса: в каком оно состоянии,
 * что сюда попадает и куда отсюда идти. Прежние состояния отвечали только на первый — «Здесь
 * появятся операции» — и человек, только что создавший бюджет, оставался с ним один на один.
 */
function assertThreeRules(markup: string, section: string) {
  const start = markup.indexOf('<div class="empty-state">');
  expect(start, `${section}: пустого состояния нет вовсе`).toBeGreaterThan(-1);
  const block = markup.slice(start, markup.indexOf("</div>", start) + 6);
  expect(block, `${section}: не назвал состояние заголовком`).toMatch(/<h3>[^<]{6,}<\/h3>/u);
  expect(block, `${section}: не объяснил, что сюда попадает`).toMatch(/<p[^>]*>[^<]{40,}<\/p>/u);
  expect(block, `${section}: не дал дороги к задаче`).toMatch(/<button[^>]*class="primary-button"/u);
  const actions = block.match(/<button/gu) ?? [];
  expect(actions.length, `${section}: основное действие обязано быть одно`).toBe(1);
}

describe("пустые состояния", () => {
  it("история без операций называет состояние, объясняет и ведёт к записи", () => {
    const markup = renderToStaticMarkup(
      <HistoryScreen budget={budgetWithoutOperations()} onEdit={vi.fn()} onAdd={vi.fn()} onBack={vi.fn()} />,
    );

    assertThreeRules(markup.slice(markup.indexOf(">Операции</h1>")), "операции");
    expect(markup).toContain("Записей пока нет");
    expect(markup).toContain("Записать первую операцию");
  });

  it("отличает «ничего не записано» от «фильтр ничего не нашёл» — иначе одно из двух ложь", () => {
    const budget = makeSeedBudget();
    const markup = renderToStaticMarkup(
      <HistoryScreen budget={budget} onEdit={vi.fn()} onAdd={vi.fn()} onBack={vi.fn()} />,
    );

    // В бюджете операции есть, поэтому «Записей пока нет» тут звучать не должно ни при каких
    // фильтрах: это разные состояния системы, и разными словами они и названы.
    expect(markup).not.toContain("Записей пока нет");
    expect(markup).toContain(">Операции</h1>");
  });

  it("на «Обзоре» месяц без лимитов объясняет, что такое лимит, и ведёт в план", () => {
    // Прежде это говорило табло конвертов «Записать»; с 2b строка «Можно на повседневные» —
    // и без лимитов она не врёт «0 ₽ · исчерпаны», а называет состояние и ведёт в план.
    const budget = budgetWithoutLimits();
    const plan = calculateAnnualPlan(budget, "2026-07", 24);
    const markup = renderToStaticMarkup(
      <OverviewScreen
        budget={budget}
        today="2026-07-13"
        month="2026-07"
        onMonth={vi.fn()}
        clock={periodClock({ startDate: "2026-07-01", endDate: "2026-07-31" }, [], "2026-07-13")}
        flexiblePlanMinor={plan.currentMonth.flexiblePlanMinor}
        familyNews={[]}
        monthToOpen={null}
        openingMonth={false}
        onOpenMonth={vi.fn()}
        onOpenSheet={vi.fn()}
        onAddCategory={vi.fn()}
        onPlan={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    assertThreeRules(markup.slice(markup.indexOf('class="card reach-line empty"')), "лимиты");
    expect(markup).toContain("Лимитов на этот месяц нет");
    expect(markup).toContain("Задать лимиты в плане");
    expect(markup).not.toContain("Можно на повседневные");
  });

  it("демо остаётся вторым выходом там, где ему место, — на первом экране онбординга", () => {
    // §6 исследования: Loggly предлагает два выхода — подключить источник или посмотреть демо.
    // Внутри готового бюджета второй выход невозможен: демо не перезаписывает чужие данные.
    const onboarding = readFileSync(new URL("./onboarding/Onboarding.tsx", import.meta.url), "utf8");

    expect(onboarding).toContain("Загрузить демонстрационный бюджет");
    expect(onboarding).toContain("Хотите сначала посмотреть?");
  });

  it("на «Обзоре», в «Операциях» и на «Годе» пустые списки тоже говорят и ведут, а не молчат пустой карточкой", () => {
    // Списки «Сегодня» (последние записи, повседневные лимиты) ушли вместе с ним; их пустые
    // состояния живут там, куда переехали сами списки.
    for (const [file, action] of [
      ["./features/operations/HistoryScreen.tsx", "Записать первую операцию"],
      ["./features/overview/ReachLine.tsx", "Задать лимиты в плане"],
    ] as const) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, `${file} по-прежнему рисует пустой список без слов`).toContain("empty-state");
      expect(source, `${file} не даёт дороги к задаче`).toContain(action);
    }
    // Список платежей «Года» без единого платежа тоже объясняет, чем он наполняется.
    expect(appSource).toContain("Платежей в плане нет");
    expect(appSource).toContain("Добавить платёж в план");
  });

  it("не выдаёт список, опустевший от фильтра участника, за пустой бюджет", () => {
    // Настоящий дефект, найденный при проверке: «Последние записи» фильтровались по участнику, и у
    // участника без операций строка утверждала «Здесь появятся операции» — при полном бюджете
    // рядом. С 2b фильтр «Кто записал» — в «Операциях», и правило то же: разные состояния системы
    // называются по-разному.
    const masha = "c6666666-6666-4666-8666-666666666601";
    const seed = makeSeedBudget();
    const budget: BudgetState = { ...seed, members: [{ id: masha, name: "Маша", role: "member", active: true }] };
    const members = (filter: string) => ({ options: memberFilterOptions(budget), filter, onFilter: vi.fn(), byId: membersById(budget) });
    const hidden = renderToStaticMarkup(<HistoryScreen budget={budget} members={members(masha)} onEdit={vi.fn()} onAdd={vi.fn()} />);
    assertThreeRules(hidden.slice(hidden.indexOf(">Операции</h1>")), "фильтр участника");
    expect(hidden).toContain("У выбранного участника записей нет");
    expect(hidden).toContain("Показать записи всех");
    expect(hidden).not.toContain("Записей пока нет");
    expect(hidden).toContain('<label for="history-member-filter">Кто записал</label>');
    // Записи без участника — свои: фильтр «Без участника» их показывает, и автор назван в строке.
    const unattributed = renderToStaticMarkup(<HistoryScreen budget={budget} members={members(MEMBER_FILTER_NONE)} onEdit={vi.fn()} onAdd={vi.fn()} />);
    expect(unattributed).not.toContain("У выбранного участника записей нет");
    expect(unattributed).toContain("· Без участника");
    // Пустой бюджет с фильтром — по-прежнему «Записей пока нет»: фильтру прятать нечего.
    const empty = renderToStaticMarkup(<HistoryScreen budget={{ ...budget, transactions: [] }} members={members(masha)} onEdit={vi.fn()} onAdd={vi.fn()} />);
    expect(empty).toContain("Записей пока нет");
    // Без участников выбирать не из кого: ни фильтра, ни автора в строке.
    const alone = renderToStaticMarkup(<HistoryScreen budget={seed} members={{ ...members(MEMBER_FILTER_ALL), options: memberFilterOptions(seed) }} onEdit={vi.fn()} onAdd={vi.fn()} />);
    expect(alone).not.toContain("Кто записал");
    expect(alone).not.toContain("Без участника");
  });

  it("склоняет счётное слово: число в русской строке тянет существительное за собой", () => {
    expect([1, 2, 4, 5, 11, 14, 21, 22, 25, 101, 112].map(operationsCount)).toEqual([
      "1 операция", "2 операции", "4 операции", "5 операций",
      "11 операций", "14 операций",
      "21 операция", "22 операции", "25 операций",
      "101 операция", "112 операций",
    ]);
  });

  it("держит объяснение читаемой строкой и одно действие под ним", () => {
    expect(styles).toMatch(/\.empty-state p \{[^}]*max-width: 38ch/u);
    expect(styles).toMatch(/\.empty-state \.primary-button \{[^}]*margin-top: 16px/u);
  });
});

describe("индикаторы загрузки", () => {
  it("не показывает индикатор раньше порога NN/g и не заводит ни одного скелетона", () => {
    // §6 исследования, пункт 30: меньше секунды — индикатор не нужен вообще; пульсирующие
    // скелетоны «отвлекают, раздражают и создают проблемы доступности». Приложение офлайн-первое.
    expect(appSource).toMatch(/SLOW_LOAD_THRESHOLD_MS = 1000/u);
    expect(appSource).toMatch(/\{slowLoad \? <p>Открываем семейный план…<\/p> : null\}/u);
    expect(styles).not.toMatch(/skeleton|shimmer|spinner/iu);
    expect(styles).not.toMatch(/animation-iteration-count: infinite|animation:[^;]*infinite/u);
  });

  it("держит слово о занятости для читающих с экрана, даже когда молчит для глаза", () => {
    expect(appSource).toMatch(/className="loading-state" aria-busy="true"/u);
  });
});

describe("сообщение, которое накрывало кнопки", () => {
  it("занимает своё место в разметке, а не висит над содержимым", () => {
    // Дефект: «Приложение готово работать без интернета» стояло `position: fixed` и накрывало
    // кнопку сохранения вместе с полем даты, стоило форме прокрутиться. Плашка без собственной
    // высоты не даёт домотать содержимое из-под себя — сколько ни крути, оно остаётся закрытым.
    const rule = styles.match(/\.update-toast, \.message-toast \{([^}]*)\}/u)?.[1] ?? "";

    expect(rule).not.toContain("position: fixed");
    expect(rule).not.toContain("position: sticky");
    expect(rule).toMatch(/margin: 24px auto 0/u);
    // Липнет плашка только внутри оболочки приложения: там есть измеренная навигация, на
    // которой стоять, и прокрутка, которой её доматывают. Садится она над навигацией — над
    // измеренной, а не над числом: 84 было 56 + 28 и при крупном шрифте сажало плашку под панель.
    const shell = styles.match(/\.app-shell > \.update-toast, \.app-shell > \.message-toast \{([^}]*)\}/u)?.[1] ?? "";
    expect(shell).toContain("position: sticky");
    expect(shell).toMatch(/bottom: calc\(var\(--nav-space\) \+ 28px\)/u);
    // Две липкие полосы с одним краем вставали друг на друга: плашка накрывала кнопки полосы
    // действия выписки. Там, где низ занят полосой, плашка стоит в потоке.
    const yields = styles.match(/\.app-shell:has\(\.import-action\) > \.update-toast, \.app-shell:has\(\.import-action\) > \.message-toast \{([^}]*)\}/u)?.[1] ?? "";
    expect(yields).toContain("position: static");
  });

  it("на онбординге стоит в потоке под карточкой, а не над её полями", () => {
    // Дефект: на маршруте онбординга навигации нет, `--nav-space` держал проектные 56, и
    // прилипшая плашка «готово работать без интернета» вставала на y=464 при 390×664 — поверх
    // полей «Название плана» и «Как назвать основной счёт», у новичка, на первом шаге. Здесь
    // плашка не липнет нигде, кроме оболочки, а колонку на весь экран держит сам маршрут,
    // чтобы карточка и плашка центрировались вместе, друг под другом.
    expect(styles).not.toMatch(/\.onboarding-shell \{[^}]*(?:min-height: 100dvh|position)/u);
    const route = styles.match(/\.onboarding-route \{([^}]*)\}/u)?.[1] ?? "";
    expect(route).toContain("min-height: 100dvh");
    expect(route).toContain("align-content: center");
    // Плашка одна на все маршруты: рама монтирует её один раз, и признак «готово к офлайну»
    // переживает переход с онбординга в приложение, а не пропадает недочитанным.
    expect(appSource.match(/<UpdatePrompt /gu)).toHaveLength(1);
    expect(appSource).toContain('<AppFrame className="onboarding-route"');
  });

  it("не оставляет ни одного `position: fixed` над содержимым, кроме навигации, обхода и затемнений", () => {
    // Затемнению диалога и листа накрывать экран положено — в этом его работа, и под ним ничего
    // не нажимают. Всё остальное, что висело над содержимым, обязано занимать своё место.
    const fixed = [...styles.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{[^}]*position: fixed[^}]*\}/gu)]
      .map((rule) => (rule[1] ?? "").trim());

    expect(fixed.sort()).toEqual([".bottom-nav", ".confirmation-backdrop", ".sheet-backdrop", ".skip-link"]);
  });
});
