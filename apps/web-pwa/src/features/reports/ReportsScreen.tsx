import type { BudgetState } from "@family-budget/domain";
import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import { SectionTitle } from "../../components/SectionTitle";
import { categoryVisual } from "../../category-visual";
import { monthGenitive } from "../../date-words";
import { TotalsFact } from "../operations";
import type { BudgetMetrics } from "../today/TodayScreen";

const percent = new Intl.NumberFormat("ru-RU", { style: "percent", maximumFractionDigits: 0 });

export interface CategorySpendRow {
  readonly category: BudgetState["categories"][number];
  readonly spentMinor: number;
  /** Доля от всех расходов месяца плана, 0…1. */
  readonly share: number;
}

/**
 * Расходы месяца плана по категориям: потрачено с учётом возвратов, по убыванию. Только то, что
 * посчитал `calculateBudget`, — ни прогноза, ни придуманных чисел; категории без расходов не
 * показываются, архивные — показываются, если в этом месяце по ним тратили.
 */
export function categorySpend(budget: BudgetState, metrics: BudgetMetrics): readonly CategorySpendRow[] {
  const rows = budget.categories
    .filter((category) => category.type === "expense")
    .map((category) => ({ category, spentMinor: Math.max(0, metrics.categoryMetrics[category.id]?.actualMinor ?? 0) }))
    .filter((row) => row.spentMinor > 0);
  const total = rows.reduce((sum, row) => sum + row.spentMinor, 0);
  return rows
    .map((row) => ({ ...row, share: total > 0 ? row.spentMinor / total : 0 }))
    .sort((left, right) => right.spentMinor - left.spentMinor || left.category.name.localeCompare(right.category.name, "ru-RU"));
}

/**
 * «Отчёты» подволны 2a — честная временная страница (план волны 2, §4 «2a»).
 *
 * Кольцо, столбцы по месяцам и метки приходят в 2d. Пока здесь только то, что приложение уже
 * считает: расходы месяца плана по категориям с долей и итоги — доход, расходы, капитал и остатки
 * по счетам. Ни одного числа, которого нет в бюджете.
 */
export function ReportsScreen({ budget, metrics }: { readonly budget: BudgetState; readonly metrics: BudgetMetrics }) {
  const active = budget.budgets.find((item) => item.id === budget.activeBudgetId);
  const monthOf = active ? monthGenitive(active.startDate) : "";
  const rows = categorySpend(budget, metrics);
  return <>
    <header className="screen-heading"><div><span className="card-kicker">Итоги из записанного</span><h1>Отчёты</h1><p>Расходы месяца плана по категориям, доход, капитал и остатки по счетам.</p></div></header>
    <section className="section-card" aria-labelledby="reports-categories-title">
      <SectionTitle id="reports-categories-title" title="Расходы по категориям" note={monthOf ? `Месяц плана — ${monthOf}, с учётом возвратов` : "Месяц плана, с учётом возвратов"} />
      {rows.length ? <ul className="transaction-list report-categories">{rows.map(({ category, spentMinor, share }) => {
        const visual = categoryVisual(category);
        return <li className="transaction-row" key={category.id}>
          <span className={`transaction-icon tone-${visual.tone}`}><Icon name={visual.icon} size={24} /></span>
          <span className="transaction-copy">
            <strong>{category.name}</strong>
            <small>{percent.format(share)} расходов месяца{category.active ? "" : " · в архиве"}</small>
          </span>
          <b><Money value={spentMinor} /></b>
        </li>;
      })}</ul> : <div className="empty-state">
        <span className="empty-state-mark"><Icon name="inbox" size={32} /></span>
        <h3>Расходов в этом месяце ещё нет</h3>
        <p>Сюда попадает каждая покупка месяца плана: категория, сумма и её доля от всех расходов месяца.</p>
      </div>}
    </section>
    <ul className="list-card">
      <li><TotalsFact budget={budget} metrics={metrics} /></li>
    </ul>
  </>;
}
