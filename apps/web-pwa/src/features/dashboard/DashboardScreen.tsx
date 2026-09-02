import { type BudgetState } from "@family-budget/domain";
import { useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import { formatMoney, moneyScale } from "../../money";
import {
  createDashboardModel,
  monthNameIn,
  type DashboardHorizon,
  type DashboardMonth,
  type DashboardTightestMonth,
} from "./model";

export interface DashboardScreenProps {
  readonly budget: BudgetState;
  readonly startMonth?: string;
  /** Единственное действие экрана: горизонт читают, а меняют его в плане. */
  readonly onPlanning?: () => void;
}

/** Три буквы для подписи под колонкой; год в подпись не помещается и живёт в таблице. */
const MONTH_TICKS: readonly string[] = [
  "янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек",
];

function monthTick(month: string): string {
  return MONTH_TICKS[Number(month.slice(5, 7)) - 1] ?? month;
}

/** «июл 2026» — колонка «Месяц» в таблице точных значений. */
function monthCell(month: string): string {
  return `${monthTick(month)} ${month.slice(0, 4)}`;
}

/**
 * График горизонта: один ряд колонок «свободно после плана».
 *
 * Почему один ряд, а не пара «доход и расходы». §4 исследования, пункт 22: один график на экран, а
 * аналитика — уровнем ниже. Прежняя пара рисовала рядом с планом плановый доход, одинаковый во все
 * месяцы: ровный ряд одинаковых колонок не сообщал ничего, зато вдвое сокращал ширину, отведённую
 * месяцу. Остаётся величина, ради которой на горизонт и смотрят.
 *
 * Почему без `viewBox`. С ним единица системы координат — не пиксель: график шириной 480 единиц,
 * ужатый до 326 pt экрана, набирал подписи девятью пикселями, а рисовал их шестью. Здесь координата
 * по горизонтали — процент от собственной ширины, по вертикали — пиксель, поэтому подпись имеет
 * ровно тот кегль, который назначен ей в таблице стилей, а график занимает ширину экрана без
 * горизонтальной прокрутки.
 */
const PLOT_TOP = 8;
const PLOT_HEIGHT = 132;
const TICK_BASELINE = 164;
const CHART_HEIGHT = 176;

function HorizonChart({
  months,
  summary,
  floorMinor,
}: {
  readonly months: readonly DashboardMonth[];
  readonly summary: string;
  /** Дно горизонта: его метят все месяцы, которые на нём стоят, а не первый из них. */
  readonly floorMinor: number;
}) {
  const values = months.map((month) => month.spendableAfterPlanMinor);
  const maximum = Math.max(0, ...values);
  const minimum = Math.min(0, ...values);
  const span = maximum - minimum || 1;
  const zero = PLOT_TOP + (maximum / span) * PLOT_HEIGHT;
  const slot = 100 / months.length;
  const barWidth = slot * 0.56;
  // Двадцать четыре подписи в ряд не помещаются ни на одном телефоне: подписывается каждый второй
  // месяц, а не уменьшается кегль — ступеней ниже одиннадцати у нашей шкалы нет (§4).
  const tickStep = months.length > 12 ? 2 : 1;

  return (
    <figure className="horizon-chart">
      <h2 id="horizon-chart-title">{summary}</h2>
      <svg
        width="100%"
        height={CHART_HEIGHT}
        role="img"
        aria-labelledby="horizon-chart-title"
        aria-describedby="horizon-chart-description"
      >
        <rect className={`horizon-chart__base${minimum < 0 ? " axis" : ""}`} x="0" y={zero} width="100%" height="1" />
        {months.map((month, index) => {
          const value = month.spendableAfterPlanMinor;
          const height = Math.max(2, (Math.abs(value) / span) * PLOT_HEIGHT);
          const tone = value < 0 ? "short" : value === floorMinor ? "tightest" : "normal";
          return (
            <rect
              key={month.month}
              className={`horizon-chart__bar ${tone}`}
              x={`${(slot * index + (slot - barWidth) / 2).toFixed(3)}%`}
              width={`${barWidth.toFixed(3)}%`}
              y={value < 0 ? zero : zero - height}
              height={height}
            />
          );
        })}
        {months.map((month, index) => {
          if (index % tickStep !== 0) return null;
          const classes = [
            month.spendableAfterPlanMinor === floorMinor ? "tightest" : "",
            // Каждая вторая подпись — «запасная»: на узком экране их прячет контейнерный запрос,
            // а не уменьшенный кегль (§4: ступеней ниже одиннадцати у шкалы нет).
            (index / tickStep) % 2 === 1 ? "secondary" : "",
          ].filter(Boolean).join(" ");
          return (
            <text
              key={month.month}
              className={classes || undefined}
              x={`${(slot * index + slot / 2).toFixed(3)}%`}
              y={TICK_BASELINE}
              textAnchor="middle"
            >
              {monthTick(month.month)}
            </text>
          );
        })}
      </svg>
      <figcaption id="horizon-chart-description">
        Столбец на месяц — сколько остаётся после всех планов. Точные значения — в «Месяцах по числам» ниже.
      </figcaption>
    </figure>
  );
}

function HorizonTable({ months }: { readonly months: readonly DashboardMonth[] }) {
  return (
    <div className="dashboard-table-scroll" tabIndex={0} aria-label="Прокручиваемая таблица месяцев горизонта">
      <table>
        <caption className="visually-hidden">Точные значения графика: доход, план, резерв и свободный остаток по каждому месяцу горизонта</caption>
        <thead><tr>
          <th scope="col">Месяц</th><th scope="col">Доход</th><th scope="col">По плану</th>
          <th scope="col">В резерв</th><th scope="col">Из резерва</th><th scope="col">Свободно</th>
        </tr></thead>
        <tbody>{months.map((month) => <tr key={month.month}>
          <th scope="row">{monthCell(month.month)}</th>
          <td><Money value={month.plannedIncomeMinor} /></td>
          <td><Money value={month.plannedIncomeMinor - month.spendableAfterPlanMinor} /></td>
          <td><Money value={month.annualReserveMinor} /></td>
          <td><Money value={month.annualDueMinor} /></td>
          <td><Money value={month.spendableAfterPlanMinor} /></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

/**
 * Подпись героя: где это дно и одно ли оно.
 *
 * Считать вслух — единственный честный способ: «самый тесный месяц — сентябрь» рядом с пятью
 * одинаковыми колонками на графике читалось бы как ошибка расчёта.
 */
function tightestWords(tightest: DashboardTightestMonth): string {
  const where = monthNameIn(tightest.month);
  const others = tightest.count > 1 ? ` и ещё в ${tightest.count - 1} месяцах горизонта` : "";
  return tightest.shortfall
    ? `Плана больше, чем дохода, в ${where}${others}.`
    : `Столько остаётся после всех планов в ${where}${others}.`;
}

export function DashboardScreen({ budget, startMonth, onPlanning }: DashboardScreenProps) {
  const [horizon, setHorizon] = useState<DashboardHorizon>(12);
  const active = budget.budgets.find((item) => item.id === budget.activeBudgetId);
  const resolvedStart = startMonth ?? active?.startDate.slice(0, 7) ?? "";
  const model = useMemo(() => createDashboardModel(budget, resolvedStart, horizon), [budget, resolvedStart, horizon]);
  const tightest = model.tightest;
  const tightestMoney = formatMoney(tightest.freeMinor);

  return (
    <section className="dashboard-screen" aria-labelledby="dashboard-title">
      <header>
        <h1 id="dashboard-title">Финансовый горизонт семьи</h1>
        <div role="group" aria-label="Горизонт планирования">
          <button type="button" aria-pressed={horizon === 12} onClick={() => setHorizon(12)}>12 месяцев</button>
          <button type="button" aria-pressed={horizon === 24} onClick={() => setHorizon(24)}>24 месяца</button>
        </div>
      </header>

      {/* §1: на экране ровно одно крупное число, и это ответ на вопрос «как мы пройдём горизонт». */}
      <section className={`hero-card${tightest.shortfall ? " danger" : ""}`}>
        <span>Меньше всего свободно</span>
        <strong data-money-scale={moneyScale(tightestMoney)}><Money value={tightest.freeMinor} /></strong>
        <p>{tightestWords(tightest)}</p>
        {onPlanning ? <button className="hero-button" type="button" onClick={onPlanning}>Настроить план</button> : null}
      </section>

      <HorizonChart months={model.months} summary={model.summary} floorMinor={tightest.freeMinor} />

      {/* Точные значения — аналитика уровнем ниже (§4, пункт 22): на своём месте и свёрнуты. */}
      <details className="section-card collapsible-card">
        <summary><span>Месяцы по числам</span><Icon name="chevron-right" size={24} className="row-chevron" /></summary>
        <HorizonTable months={model.months} />
      </details>
    </section>
  );
}
