import { type BudgetState, type Transaction } from "@family-budget/domain";
import { useMemo, useReducer, useState } from "react";
import { formatMoney } from "../../money";
import {
  buildOperationSearchIndex,
  createDashboardModel,
  searchOperationPage,
  type DashboardHorizon,
  type DashboardMonth,
} from "./model";

export interface DashboardScreenProps {
  readonly budget: BudgetState;
  readonly startMonth?: string;
}

function monthLabel(month: string): string {
  const [year, value] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("ru-RU", { month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year!, value! - 1, 1)));
}

function MonthChart({ months }: { readonly months: readonly DashboardMonth[] }) {
  const maximum = Math.max(1, ...months.flatMap((month) => [
    month.plannedIncomeMinor,
    month.scheduledExpenseMinor + month.flexiblePlanMinor + month.annualReserveMinor + month.goalPlanMinor,
  ]));
  const width = Math.max(480, months.length * 36);
  const height = 180;
  return (
    <figure className="dashboard-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="dashboard-chart-title dashboard-chart-description">
        <title id="dashboard-chart-title">План дохода и расходов по месяцам</title>
        <desc id="dashboard-chart-description">Две подписанные колонки на месяц: доход и все запланированные расходы. Точные значения приведены в таблице ниже.</desc>
        {months.map((month, index) => {
          const committed = month.scheduledExpenseMinor + month.flexiblePlanMinor + month.annualReserveMinor + month.goalPlanMinor;
          const incomeHeight = Math.round((month.plannedIncomeMinor / maximum) * 140);
          const expenseHeight = Math.round((committed / maximum) * 140);
          const x = 12 + index * 36;
          return (
            <g key={month.month} aria-label={`${monthLabel(month.month)}: доход ${formatMoney(month.plannedIncomeMinor)}, план расходов ${formatMoney(committed)}`}>
              <rect x={x} y={150 - incomeHeight} width="10" height={incomeHeight} className="dashboard-chart__income" />
              <rect x={x + 12} y={150 - expenseHeight} width="10" height={expenseHeight} className="dashboard-chart__expense" />
              <text x={x + 11} y="168" textAnchor="middle">{String(index + 1)}</text>
            </g>
          );
        })}
      </svg>
      <figcaption>Доход и весь план расходов. Номер под парой колонок соответствует строке в таблице.</figcaption>
    </figure>
  );
}

function DashboardTable({ months }: { readonly months: readonly DashboardMonth[] }) {
  return (
    <div className="dashboard-table-scroll" tabIndex={0} aria-label="Прокручиваемая числовая таблица плана и факта">
      <table>
        <caption>Точные значения графика по месяцам</caption>
        <thead><tr>
          <th scope="col">№</th><th scope="col">Месяц</th><th scope="col">Доход, план</th>
          <th scope="col">Регулярные</th><th scope="col">Повседневные, план</th>
          <th scope="col">Повседневные, факт</th><th scope="col">Остаток лимита</th>
          <th scope="col">Резерв</th><th scope="col">Платежи в срок</th><th scope="col">Свободно</th>
        </tr></thead>
        <tbody>{months.map((month, index) => <tr key={month.month}>
          <th scope="row">{index + 1}</th><td>{monthLabel(month.month)}</td>
          <td>{formatMoney(month.plannedIncomeMinor)}</td><td>{formatMoney(month.scheduledExpenseMinor)}</td>
          <td>{formatMoney(month.flexiblePlanMinor)}</td><td>{formatMoney(month.flexibleFactMinor)}</td>
          <td>{formatMoney(month.flexibleRemainingMinor)}</td><td>{formatMoney(month.annualReserveMinor)}</td>
          <td>{formatMoney(month.annualDueMinor)}</td><td>{formatMoney(month.spendableAfterPlanMinor)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

const KIND_LABELS: Readonly<Record<Transaction["kind"], string>> = {
  income: "Доход",
  expense: "Расход",
  refund: "Возврат",
  transfer: "Перевод",
  goal_contribution: "Взнос в цель",
};

export interface OperationSearchViewState {
  readonly query: string;
  readonly kind: Transaction["kind"] | "all";
  readonly page: number;
}

type OperationSearchViewAction =
  | { readonly type: "query"; readonly value: string }
  | { readonly type: "kind"; readonly value: Transaction["kind"] | "all" }
  | { readonly type: "page"; readonly value: number }
  | { readonly type: "reset" };

const INITIAL_OPERATION_SEARCH: OperationSearchViewState = { query: "", kind: "all", page: 0 };

export function reduceOperationSearchView(
  state: OperationSearchViewState,
  action: OperationSearchViewAction,
): OperationSearchViewState {
  if (action.type === "query") return { ...state, query: action.value, page: 0 };
  if (action.type === "kind") return { ...state, kind: action.value, page: 0 };
  if (action.type === "page") return { ...state, page: Math.max(0, action.value) };
  return INITIAL_OPERATION_SEARCH;
}

export function OperationsSearch({ budget }: { readonly budget: BudgetState }) {
  const [view, dispatch] = useReducer(reduceOperationSearchView, INITIAL_OPERATION_SEARCH);
  const index = useMemo(() => buildOperationSearchIndex(budget), [budget]);
  const result = useMemo(
    () => searchOperationPage(index, { query: view.query, kind: view.kind }, view.page),
    [index, view.kind, view.page, view.query],
  );
  const visibleStart = result.total === 0 ? 0 : result.page * result.pageSize + 1;
  const visibleEnd = result.page * result.pageSize + result.results.length;

  return (
    <section aria-labelledby="operations-search-title">
      <h2 id="operations-search-title">Поиск операций</h2>
      <div className="dashboard-search-controls">
        <label htmlFor="dashboard-operation-search">Категория, счёт или контекст возврата</label>
        <input
          id="dashboard-operation-search"
          type="search"
          value={view.query}
          maxLength={80}
          onChange={(event) => dispatch({ type: "query", value: event.currentTarget.value })}
        />
        <label htmlFor="dashboard-operation-kind">Вид операции</label>
        <select
          id="dashboard-operation-kind"
          value={view.kind}
          onChange={(event) => dispatch({ type: "kind", value: event.currentTarget.value as Transaction["kind"] | "all" })}
        >
          <option value="all">Все виды</option>
          {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="button" onClick={() => dispatch({ type: "reset" })}>Сбросить</button>
      </div>
      <p role="status">
        Найдено операций: <strong>{result.total}</strong> из {budget.transactions.length}.{" "}
        Показано {visibleStart}–{visibleEnd} из {result.total}. Общие итоги дашборда не меняются.
      </p>
      <ol className="dashboard-operation-results">
        {result.results.map(({ transaction, context }) => <li key={transaction.id}>
          <strong>{KIND_LABELS[transaction.kind]} · {formatMoney(transaction.amountMinor)}</strong>
          <span>{transaction.occurredOn} · {context}</span>
        </li>)}
      </ol>
      {result.pageCount > 1 && <nav aria-label="Страницы найденных операций">
        <button
          type="button"
          disabled={result.page === 0}
          onClick={() => dispatch({ type: "page", value: result.page - 1 })}
        >
          Предыдущие
        </button>
        <span>Страница {result.page + 1} из {result.pageCount}</span>
        <button
          type="button"
          disabled={result.page + 1 >= result.pageCount}
          onClick={() => dispatch({ type: "page", value: result.page + 1 })}
        >
          Следующие
        </button>
      </nav>}
    </section>
  );
}

export function DashboardScreen({ budget, startMonth }: DashboardScreenProps) {
  const [horizon, setHorizon] = useState<DashboardHorizon>(12);
  const active = budget.budgets.find((item) => item.id === budget.activeBudgetId);
  const resolvedStart = startMonth ?? active?.startDate.slice(0, 7) ?? "";
  const model = useMemo(() => createDashboardModel(budget, resolvedStart, horizon), [budget, resolvedStart, horizon]);
  const current = model.months[0]!;

  return (
    <section className="dashboard-screen" aria-labelledby="dashboard-title">
      <header>
        <p className="eyebrow">План и факт</p>
        <h1 id="dashboard-title">Финансовый горизонт семьи</h1>
        <div role="group" aria-label="Горизонт планирования">
          <button type="button" aria-pressed={horizon === 12} onClick={() => setHorizon(12)}>12 месяцев</button>
          <button type="button" aria-pressed={horizon === 24} onClick={() => setHorizon(24)}>24 месяца</button>
        </div>
      </header>

      <div className="dashboard-totals" aria-label="Общие фактические итоги, не зависят от поиска">
        <article><span>Доход, факт</span><strong>{formatMoney(model.totals.incomeMinor)}</strong></article>
        <article><span>Расходы, факт</span><strong>{formatMoney(model.totals.expensesMinor)}</strong></article>
        <article><span>Капитал</span><strong>{formatMoney(model.totals.capitalMinor)}</strong></article>
        <article><span>Повседневные, план</span><strong>{formatMoney(current.flexiblePlanMinor)}</strong></article>
        <article><span>Повседневные, факт</span><strong>{formatMoney(current.flexibleFactMinor)}</strong></article>
        <article><span>Остаток повседневного лимита</span><strong>{formatMoney(current.flexibleRemainingMinor)}</strong></article>
      </div>

      <p id="dashboard-text-summary">{model.summary}</p>
      <ol className="dashboard-month-cards" aria-label={`${model.months.length} карточек месяцев`}>
        {model.months.map((month) => <li key={month.month} className="dashboard-month-card">
          <article>
            <h2>{monthLabel(month.month)}</h2>
            <dl>
              <div><dt>По расписанию</dt><dd>{formatMoney(month.scheduledExpenseMinor)}</dd></div>
              <div><dt>Сезонная часть</dt><dd>{formatMoney(month.seasonalExpenseMinor)}</dd></div>
              <div><dt>Повседневные: план / факт</dt><dd>{formatMoney(month.flexiblePlanMinor)} / {formatMoney(month.flexibleFactMinor)}</dd></div>
              <div><dt>Резерв</dt><dd>{formatMoney(month.annualReserveMinor)}</dd></div>
              <div><dt>Платежи в срок</dt><dd>{formatMoney(month.annualDueMinor)}</dd></div>
              <div><dt>Свободно после плана</dt><dd>{formatMoney(month.spendableAfterPlanMinor)}</dd></div>
            </dl>
          </article>
        </li>)}
      </ol>
      <MonthChart months={model.months} />
      <DashboardTable months={model.months} />

      <section aria-labelledby="upcoming-payments-title">
        <h2 id="upcoming-payments-title">Ближайшие активные платежи</h2>
        <p>Для каждого расписания показан один ближайший платёж в выбранном горизонте.</p>
        <ol>{model.upcomingPayments.map((payment) => <li key={`${payment.kind}-${payment.id}-${payment.dueDate}`}>
          <strong>{payment.name} · {formatMoney(payment.amountMinor)}</strong>
          <span>{payment.dueDate} · {payment.kind === "annual" ? "ежегодно" : payment.kind === "one_time" ? "разово" : "по расписанию"}</span>
        </li>)}</ol>
      </section>
    </section>
  );
}
