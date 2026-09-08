/// <reference types="node" />
import { readFileSync } from "node:fs";
import {
  calculateAnnualPlan,
  calculateBudget,
  makePlanningSeed,
  type BudgetState,
} from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TodayScreen } from "./App";
import { MEMBER_FILTER_ALL } from "./features/family";
import { periodClock } from "./reach";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const controllerSource = readFileSync(new URL("./features/family/controller.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
const design = readFileSync(new URL("../../../DESIGN.md", import.meta.url), "utf8");

/**
 * Семейная новость — единственный заслуженный момент на входе (§6).
 *
 * Каждое из шести требований проверяется тем, что читает человек или что держит код, а не
 * наличием строки в документе: чистая арифметика «что пришло с прошлого раза» проверена в
 * `features/family/news.test.ts`, здесь — как она стоит на экране и как приложение её гасит.
 */
function renderToday(state: BudgetState, today: string, familyNews: readonly string[]): string {
  const active = state.budgets.find((budget) => budget.id === state.activeBudgetId)!;
  const metrics = calculateBudget(state);
  const plan = calculateAnnualPlan(state, active.startDate.slice(0, 7), 24);
  const planned = new Set(active.lines.filter((line) => line.active !== false).map((line) => line.categoryId));
  const flexibleRows = state.categories
    .filter((category) => category.active && category.type === "expense" && planned.has(category.id))
    .map((category) => ({ category, metric: metrics.categoryMetrics[category.id] }));
  const flexibleSpentMinor = flexibleRows.reduce((total, row) => total + (row.metric?.actualMinor ?? 0), 0);
  return renderToStaticMarkup(
    <TodayScreen
      budget={state}
      plan={plan}
      flexibleRows={flexibleRows}
      safeToSpendMinor={plan.currentMonth.flexiblePlanMinor - flexibleSpentMinor}
      flexibleSpentMinor={flexibleSpentMinor}
      clock={periodClock(active, [], today)}
      recentTransactions={state.transactions.filter((item) => item.status === "posted").slice(0, 5)}
      categoryById={new Map(state.categories.map((category) => [category.id, category]))}
      memberById={new Map()}
      memberOptions={[]}
      memberFilter={MEMBER_FILTER_ALL}
      onMemberFilterChange={() => undefined}
      hasRecords
      monthToOpen={null}
      onAdd={() => undefined}
      onYear={() => undefined}
      onPlanning={() => undefined}
      familyNews={familyNews}
    />,
  );
}

function heroOf(markup: string): string {
  const start = markup.indexOf('<section class="hero-card');
  return markup.slice(start, markup.indexOf("</section>", start));
}

describe("семейная новость на «Сегодня»", () => {
  const seed = makePlanningSeed();
  const NEWS = ["Борис: 2 покупки на 4 500 ₽"];

  it("срабатывает только при количестве больше нуля", () => {
    const silent = renderToday(seed, "2026-07-09", []);
    expect(silent).not.toContain("family-news");
    expect(silent).not.toContain("Новое с прошлого раза");
    const spoken = renderToday(seed, "2026-07-09", NEWS);
    expect(spoken).toContain('class="family-news" role="status"');
    expect(spoken).toContain("Борис: 2 покупки на 4 500 ₽");
    expect(spoken).toContain("Новое с прошлого раза");
  });

  it("не задерживает появление герой-числа и не двигает его: герой тот же и стоит выше", () => {
    const silent = renderToday(seed, "2026-07-09", []);
    const spoken = renderToday(seed, "2026-07-09", NEWS);
    // Разметка героя байт в байт одна и та же с новостью и без неё.
    expect(heroOf(spoken)).toBe(heroOf(silent));
    // И герой стоит раньше новости: новость под ним, а не над ним.
    expect(spoken.indexOf('<section class="hero-card')).toBeLessThan(spoken.indexOf('class="family-news"'));
    // Новость выводится из состояния синхронизации, а герой — нет: оболочка не ждёт её и
    // не входит в ветку загрузки.
    expect(appSource).not.toMatch(/loadState === "loading"[\s\S]{0,300}familyNews/u);
  });

  it("не повторяет «Последние записи»: итог по видам и суммам, а не строки операций", () => {
    const spoken = renderToday(seed, "2026-07-09", NEWS);
    const news = spoken.slice(spoken.indexOf('class="family-news"'), spoken.indexOf("Новое с прошлого раза"));
    expect(news).not.toContain("transaction-row");
    expect(news).not.toContain("transaction-list");
    // И список последних записей по-прежнему стоит на экране отдельно.
    expect(spoken).toContain("Последние записи");
  });

  it("стоит в потоке и ничего не накрывает: у плашки нет положения над содержимым", () => {
    const rule = styles.match(/\n\.family-news \{([^}]*)\}/u)?.[1] ?? "";
    expect(rule.length).toBeGreaterThan(0);
    expect(rule).not.toMatch(/position:/u);
    expect(rule).not.toMatch(/z-index/u);
    // Поверхность — прямая (§5) и без цвета (§3): сообщить, а не поздравить.
    expect(rule).not.toMatch(/border-radius/u);
    expect(rule).toContain("background: var(--surface-sunken)");
    expect(rule).not.toMatch(/amber|red|orange|mint|lilac|peach|sage|coral/u);
  });

  it("в одиночном режиме не срабатывает никогда: своё — участник из сессии, без сессии — null", () => {
    // Первая проверка — сессия, а не карта авторов: без адреса сервера `useFamily` сессию не
    // читает, и `ownDeviceId` остаётся `null` раньше любого сравнения.
    expect(appSource).toContain("const ownDeviceId = family.session?.deviceId ?? null;");
    expect(appSource).toContain("const ownMemberId = family.session?.memberId ?? null;");
    expect(appSource).toMatch(/if \(budget === null \|\| seenTransactionIds === null \|\| ownDeviceId === null\) return \[\];/u);
    expect(appSource).toContain("familyNewsSince(seenTransactionIds, budget, family.transactionAuthors, own)");
    // Карта авторов читается там же, где журнал читается ради целостности, и пустеет вместе с ним.
    expect(controllerSource).toContain("setTransactionAuthors(authorsOfTransactions(snapshot.entries));");
    expect(controllerSource.match(/setTransactionAuthors\(new Map\(\)\)/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("исчезает после того, как человек её увидел, и не возвращается за тем же", () => {
    // «Прошлый раз» — операции бюджета на момент открытия…
    expect(appSource).toContain("setSeenTransactionIds(transactionIds(prepared));");
    // …и на момент, когда новость стояла на экране: человек ушёл с «Сегодня» или свернул приложение.
    expect(appSource).toContain('const newsOnScreen = screen === "today" && familyNews.length > 0;');
    expect(appSource).toContain("if (newsOnScreen) markNewsSeen();");
    expect(appSource).toMatch(/visibilityState !== "hidden"[\s\S]{0,200}setSeenTransactionIds\(transactionIds\(current\)\)[\s\S]{0,200}addEventListener\("visibilitychange"/u);
    // Нового хранилища нет: память сессии, а на следующем открытии — бюджет с диска.
    expect(appSource).not.toMatch(/seen-transactions|family-news-seen|writeSyncState\(\[\{ key: "news/u);
  });

  it("тон: сообщить, а не поздравить, — ни восклицаний, ни похвалы", () => {
    const spoken = renderToday(seed, "2026-07-09", NEWS);
    const news = spoken.slice(spoken.indexOf('class="family-news"'), spoken.indexOf("</div></div>", spoken.indexOf('class="family-news"')));
    expect(news).not.toMatch(/!/u);
    expect(news).not.toMatch(/молодц|отличн|поздравл|ура|супер|здорово/iu);
    expect(design).toMatch(/Семейная новость/u);
  });
});

describe("моменты на входе имеют потолок", () => {
  it("плашка внизу одна: сообщение приложения прячет плашку обновления, а не встаёт на неё", () => {
    expect(appSource.match(/<UpdatePrompt /gu)).toHaveLength(1);
    expect(appSource).toContain("suppressed={messageShown}");
    expect(appSource).toContain("messageShown={message !== null}");
    // Семейная новость — вторая и последняя: в потоке и только на «Сегодня».
    expect(appSource.match(/familyNews=\{familyNewsText\}/gu)).toHaveLength(1);
    expect(design).toMatch(/число моментов[^\n]*потолок|потолок[^\n]*момент/iu);
  });
});
