import { type BudgetState } from "@family-budget/domain";
import { Fragment, useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import {
  createDashboardModel,
  ladderModel,
  MONTH_SHORT,
  monthName,
  monthShape,
  shapeAnnouncement,
  type DashboardHorizon,
  type DashboardMonth,
  type ShapeRow,
} from "./model";

export interface DashboardScreenProps {
  readonly budget: BudgetState;
  readonly startMonth?: string;
  /** Единственное действие экрана: горизонт читают, а меняют его в плане. */
  readonly onPlanning?: () => void;
  /** Числа месяца, на которые приходят деньги, — выведены из доходов на «Сегодня» и переданы сюда. */
  readonly paydays?: readonly number[];
}

/** «июл 2026» — колонка «Месяц» в таблице точных значений. */
function monthCell(month: string): string {
  return `${MONTH_SHORT[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;
}

/** Опорные числа оси месяца. Выплата, стоящая рядом с опорой, вытесняет её: два числа впритык не читаются. */
const AXIS_TICKS: readonly number[] = [1, 5, 10, 15, 20, 25, 31];

/**
 * Строй месяца: ось 1…31, на ней выплаты и регулярные платежи.
 *
 * Положение каждого числа едет атрибутом `data-day`, а не инлайновым стилем: CSP запрещает
 * `style`, и тридцать одно положение объявлено в таблице стилей. Подписи — обычный поток в
 * колонке сетки, а не абсолютные слои: длинное название переносится и растит строку, вместо
 * того чтобы вылезти за карточку (§1: ничего не обрезается).
 */
function MonthShape({ rows, paydays }: { readonly rows: readonly ShapeRow[]; readonly paydays: readonly number[] }) {
  if (rows.length === 0 && paydays.length === 0) return null;
  const ticks = AXIS_TICKS.filter((tick) => !paydays.some((day) => day !== tick && Math.abs(day - tick) <= 2));
  const axis = [...new Set([...ticks, ...paydays])].sort((left, right) => left - right);
  return (
    <figure className="month-shape">
      <figcaption>
        <h2>Строй месяца</h2>
        <p>Так устроен каждый месяц: выплаты и платежи на своих числах.</p>
      </figcaption>
      <div className="shape-plot" role="img" aria-label={shapeAnnouncement(rows, paydays)}>
        <div className="shape-axis">
          {axis.map((day) => <span key={day} className={`shape-tick${paydays.includes(day) ? " pay" : ""}`} data-day={day}>{day}</span>)}
          {paydays.map((day) => <span key={`pay-${day}`} className="shape-pay" data-day={day}>выплата</span>)}
          {paydays.map((day) => <i key={`rule-${day}`} className="shape-rule" data-day={day} />)}
        </div>
        {rows.map((row) => (
          <div key={row.key} className="shape-row" data-day={row.day} data-side={row.side}>
            {paydays.map((day) => <i key={day} className="shape-rule" data-day={day} />)}
            <span className="shape-label">
              <span className="shape-day">{row.day}-го · </span>
              {row.name} <b><Money value={row.amountMinor} /></b>{row.note ? ` · ${row.note}` : ""}
            </span>
          </div>
        ))}
      </div>
    </figure>
  );
}

/**
 * Лестница месяцев: строка на месяц, длина полосы — деньги, насечка — конверты.
 *
 * Магнитуда передана длиной, а не углом и не площадью: упорядоченные бары читаются точнее всего
 * остального, и это добыто измерением. Одна насечка на всю лестницу даёт одну вертикаль сквозь
 * год — видно, какой месяц до неё не дотягивает. Цвет не единственный носитель: самый тесный
 * месяц назван в выводе, а нехватка — ещё и положением полосы перед насечкой.
 */
function MonthLadder({ months, floorMinor }: { readonly months: readonly DashboardMonth[]; readonly floorMinor: number }) {
  const ladder = ladderModel(months, floorMinor);
  return (
    <div className="ladder-block">
      <h2>{months.length > 12 ? "Двадцать четыре месяца" : "Двенадцать месяцев"}</h2>
      <p>Полоса — что остаётся от дохода после платежей и резервов. Насечка — конверты, <Money value={ladder.envelopesMinor} /> в месяц: дотянула — конверты полны, дальше — запас.</p>
      <ul className="ladder" data-mark={ladder.markPercent} aria-label="Свободно после всех планов по месяцам">
        <li className="ladder-legend" aria-hidden="true"><span /><span className="ladder-legend-mid"><span className="ladder-at">конверты</span><span className="ladder-rest">запас</span></span><span /></li>
        {ladder.rows.map((row) => (
          <Fragment key={row.month}>
            {row.yearBreak ? <li className="ladder-year" aria-hidden="true"><span>{row.month.slice(0, 4)}</span><i /></li> : null}
            <li className={`ladder-row ${row.state}`}>
              <span className="ladder-month">{row.label}</span>
              <span className={`limit-bar${row.state === "short" ? " short" : row.state === "out" ? " out" : ""}`} data-spent={row.fill} aria-hidden="true" />
              <span className="ladder-value"><Money value={row.spendableMinor} /></span>
            </li>
          </Fragment>
        ))}
      </ul>
    </div>
  );
}

function HorizonTable({ months }: { readonly months: readonly DashboardMonth[] }) {
  return (
    <div className="dashboard-table-scroll" tabIndex={0} aria-label="Прокручиваемая таблица месяцев горизонта">
      <table>
        <caption className="visually-hidden">Точные значения лестницы: доход, план, резерв и свободный остаток по каждому месяцу горизонта</caption>
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
 * «Год»: вывод, строй месяца, лестница месяцев.
 *
 * Заголовок экрана — вывод («Плана хватает во все 12 месяцев»), а не подпись осей: это жанр, и
 * любой график в приложении обязан начинаться с него. Крупного числа отдельной карточкой здесь
 * больше нет: самое тесное место горизонта стоит в лестнице, названо в выводе и выделено
 * весом, — второй раз тем же числом экран не занят.
 */
export function DashboardScreen({ budget, startMonth, onPlanning, paydays = [] }: DashboardScreenProps) {
  const [horizon, setHorizon] = useState<DashboardHorizon>(12);
  const active = budget.budgets.find((item) => item.id === budget.activeBudgetId);
  const resolvedStart = startMonth ?? active?.startDate.slice(0, 7) ?? "";
  const model = useMemo(() => createDashboardModel(budget, resolvedStart, horizon), [budget, resolvedStart, horizon]);
  const shape = useMemo(() => monthShape(budget), [budget]);
  const first = model.months[0]?.month ?? resolvedStart;
  const last = model.months[model.months.length - 1]?.month ?? resolvedStart;

  return (
    <section className="dashboard-screen" aria-labelledby="dashboard-title">
      <header>
        <p className="eyebrow">Горизонт · {monthName(first)} — {monthName(last)}</p>
        <div role="group" aria-label="Горизонт планирования">
          <button type="button" aria-pressed={horizon === 12} onClick={() => setHorizon(12)}>12 месяцев</button>
          <button type="button" aria-pressed={horizon === 24} onClick={() => setHorizon(24)}>24 месяца</button>
        </div>
      </header>

      <section className={`section-card horizon-card${model.tightest.shortfall ? " danger" : ""}`}>
        <h2 id="dashboard-title">{model.verdict.title}</h2>
        <p className="horizon-detail">{model.verdict.detail}</p>
        <MonthShape rows={shape} paydays={paydays} />
        <MonthLadder months={model.months} floorMinor={model.tightest.freeMinor} />
        {onPlanning ? <button className="primary-button wide" type="button" onClick={onPlanning}>Настроить план</button> : null}
      </section>

      {/* Точные значения — аналитика уровнем ниже (§4, пункт 22): на своём месте и свёрнуты. */}
      <details className="section-card collapsible-card">
        <summary><span>Месяцы по числам</span><Icon name="chevron-right" size={24} className="row-chevron" /></summary>
        <HorizonTable months={model.months} />
      </details>
    </section>
  );
}
