import { useMemo, useState } from "react";
import { monthOfDate, monthStartDate, shiftMonth, type BudgetState } from "@family-budget/domain";
import { accountIcon, accountTone } from "../../category-visual";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { LargeTitle } from "../../components/LargeTitle";
import { Money } from "../../components/Money";
import { formatMoney } from "../../money";
import { REPORT_VIEWS, type OperationsFilterFields, type ReportsFields, type ReportView } from "../../navigation/routes";
import { monthLabel } from "../feed/feed-model";
import { FilterSheet, type FilterChoice } from "../feed/FilterSheet";
import { PeriodForm } from "../feed/PeriodForm";
import { Donut } from "./Donut";
import { MonthBars } from "./MonthBars";
import {
  emptyTitle,
  periodAnchor,
  reportModel,
  reportsFieldsForDays,
  reportsFieldsForPeriod,
  reportsFieldsWith,
  shareText,
  viewWords,
  type ReportModel,
} from "./report-model";
import { CategoryTable, ReportLegend } from "./ReportLegend";

export interface ReportsScreenProps {
  readonly budget: BudgetState;
  readonly today: string;
  /** Вкладка, период и счёт из адреса «Отчётов». */
  readonly fields: ReportsFields;
  /** Другая вкладка, период или счёт — тот же экран: запись истории заменяется. */
  readonly onFields: (fields: ReportsFields) => void;
  /** Строка легенды или метки — в «Операции» с фильтром; «Назад» вернёт сюда с тем же периодом. */
  readonly onFeed: (filters: OperationsFilterFields) => void;
  /** Дорога к записи из пустого отчёта. */
  readonly onAdd: (kind: "expense" | "income") => void;
}

/**
 * «Отчёты» (подволна 2d, дизайн 5.0, макет 09): вкладки «Расходы / Доходы / Метки», чипы периода и
 * счёта; карточка с выводом заголовком и сравнением с прошлым периодом, кольцо с легендой-кнопками и
 * таблицей всех категорий; «По месяцам» — столбцы со сегодняшним месяцем акцентом. Метки — полосами:
 * операция с двумя метками входит в обе.
 *
 * Итоги — в базовой валюте с возвратами за вычетом, за календарный период (`report-model.ts`): итог
 * месяца — тот же, что «Расходы» на «Обзоре». Графики — `role="img"` с выводом словами и таблица
 * под ними (DESIGN §6: кольца без легенды и таблицы нет).
 */
export function ReportsScreen({ budget, today, fields, onFields, onFeed, onAdd }: ReportsScreenProps) {
  // Адрес сравнивается по значению, а не по ссылке: тот же период — тот же расчёт.
  const fieldsKey = JSON.stringify(fields);
  const model = useMemo(() => reportModel(budget, JSON.parse(fieldsKey) as ReportsFields, today), [budget, fieldsKey, today]);
  const [sheet, setSheet] = useState<"custom" | "account" | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const words = viewWords(model.view);
  const { period } = model;
  const account = fields.acc === undefined ? undefined : budget.accounts.find((item) => item.id.toLowerCase() === fields.acc);
  const choose = (next: ReportsFields) => {
    setSheet(null);
    onFields(next);
  };

  return <div className="reports-screen">
    <LargeTitle title="Отчёты" />
    <div className="mode-switch report-views" role="group" aria-label="Что показать">
      {REPORT_VIEWS.map((view) => (
        <button key={view} className="chip" type="button" aria-pressed={model.view === view} onClick={() => onFields(reportsFieldsWith(fields, { view }))}>
          <span className="chip-face">{viewWords(view).title}</span>
        </button>
      ))}
    </div>
    <div className="filter-chips report-periods" role="group" aria-label="Период и счёт">
      <button className="chip" type="button" aria-pressed={period.kind === "month"} onClick={() => onFields(reportsFieldsForPeriod(fields, "month", today))}>
        <span className="chip-face">{period.kind === "month" ? period.label : monthLabel(monthOfDate(periodAnchor(fields, today)), today)}</span>
      </button>
      <button className="chip" type="button" aria-pressed={period.kind === "quarter"} onClick={() => onFields(reportsFieldsForPeriod(fields, "quarter", today))}>
        <span className="chip-face">{period.kind === "quarter" ? period.label : "Квартал"}</span>
      </button>
      <button className="chip" type="button" aria-pressed={period.kind === "year"} onClick={() => onFields(reportsFieldsForPeriod(fields, "year", today))}>
        <span className="chip-face">{period.kind === "year" ? period.label : "Год"}</span>
      </button>
      <button className="chip" type="button" aria-haspopup="dialog" aria-expanded={sheet === "custom"} aria-pressed={period.kind === "custom"} onClick={() => setSheet("custom")}>
        <span className="chip-face"><Icon name="calendar" size={20} />{period.kind === "custom" ? period.label : "Свой период"}</span>
      </button>
      {/* Счёт — последним в том же ряду: «Отчёты» по одному счёту, как в «Операциях». */}
      <button className="chip filter-chip" type="button" aria-haspopup="dialog" aria-expanded={sheet === "account"} data-set={fields.acc === undefined ? undefined : "true"} onClick={() => setSheet("account")}>
        <span className="chip-face"><bdi dir="auto">{account?.name ?? "Все счета"}</bdi><Icon name="chevron-down" size={20} /></span>
      </button>
    </div>

    {model.empty ? (
      <EmptyState
        glyph="chart-pie"
        title={emptyTitle(period, model.view, today)}
        text={model.view === "income" ? "Запишите доход — появится кольцо." : model.view === "tags" ? "Отметьте трату меткой при записи." : "Запишите трату — появится кольцо."}
        action={model.view === "income" ? { label: "Записать доход", onClick: () => onAdd("income") } : { label: "Записать расход", onClick: () => onAdd("expense") }}
      />
    ) : model.view === "tags" ? (
      <TagsCard model={model} onFeed={onFeed} />
    ) : (
      <section className="card report-card" aria-labelledby="report-headline">
        <h2 id="report-headline">{model.headline}</h2>
        <Comparison model={model} />
        <div className={model.segments.length > 4 ? "report-chart legend-below" : "report-chart"}>
          <Donut
            segments={model.segments}
            totalMinor={model.totalMinor}
            currency={model.baseCurrency}
            label={`${words.title} ${period.forWords}, ${formatMoney(model.totalMinor, model.baseCurrency)}: ${model.segments.map((segment) => `${segment.name} ${shareText(segment.share)}`).join(", ")}`}
          />
          <ReportLegend
            segments={model.segments}
            currency={model.baseCurrency}
            onOpen={(segment) => { if (segment.feed !== null) onFeed(segment.feed); }}
            onRest={() => setTableOpen(true)}
          />
        </div>
        <details className="report-details report-all" open={tableOpen} onToggle={(event) => setTableOpen(event.currentTarget.open)}>
          <summary>Все категории и таблица</summary>
          <CategoryTable
            rows={model.table}
            totalMinor={model.totalMinor}
            currency={model.baseCurrency}
            caption={`${words.title} ${period.forWords} по ${model.view === "income" ? "источникам" : "категориям"}${model.view === "expense" ? ", за вычетом возвратов" : ""}`}
            nameHeader={model.view === "income" ? "Источник" : "Категория"}
          />
        </details>
      </section>
    )}

    {model.view !== "tags" && model.bars.some((bar) => bar.amountMinor !== 0) ? (
      <section className="card report-months" aria-labelledby="report-months-title">
        <h2 id="report-months-title">По месяцам</h2>
        <p className="report-caption">{monthsCaption(model, today)}</p>
        <MonthBars bars={model.bars} currency={model.baseCurrency} label={`${words.title} по месяцам`} today={today} />
      </section>
    ) : null}

    {sheet === "custom" ? (
      <FilterSheet id="report-period" title="Период" groups={[{ key: "quick", choices: quickPeriods(fields, today, choose) }]} onClose={() => setSheet(null)}>
        <PeriodForm
          from={period.kind === "custom" ? period.from : undefined}
          to={period.kind === "custom" ? period.to : undefined}
          today={today}
          submitLabel="Показать"
          onSubmit={(from, to) => choose(reportsFieldsForDays(fields, from, to))}
        />
      </FilterSheet>
    ) : null}
    {sheet === "account" ? (
      <FilterSheet
        id="report-account"
        title="Счёт"
        groups={[{
          key: "accounts",
          choices: [
            { key: "all", label: "Все счета", selected: fields.acc === undefined, onSelect: () => choose(reportsFieldsWith(fields, { acc: null })) },
            ...[...budget.accounts].filter((item) => item.active || item.id.toLowerCase() === fields.acc)
              .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
              .map((item): FilterChoice => ({
                key: item.id,
                label: item.name,
                ...(item.active ? {} : { detail: "в архиве" }),
                plate: { icon: accountIcon(item), tone: accountTone(item) },
                selected: item.id.toLowerCase() === fields.acc,
                onSelect: () => choose(reportsFieldsWith(fields, { acc: item.id.toLowerCase() })),
              })),
          ],
        }]}
        onClose={() => setSheet(null)}
      />
    ) : null}
  </div>;
}

/**
 * «71 000 ₽ за октябрь — на 8 400 ₽ меньше, чем в сентябре». Прошлый период, который начался бы
 * раньше календаря приложения, не считается, и это сказано словами (ревью 2d, HIGH-1).
 */
function Comparison({ model }: { readonly model: ReportModel }) {
  const { period, comparison } = model;
  const words = viewWords(model.view);
  return (
    <p className="report-compare">
      <Money value={model.totalMinor} currency={model.baseCurrency} /> {period.forWords}
      {comparison.kind === "less" || comparison.kind === "more" ? <>
        {" — на "}<Money value={comparison.differenceMinor} currency={model.baseCurrency} />{comparison.kind === "less" ? " меньше" : " больше"}, чем {comparison.inWords}
      </> : comparison.kind === "same" ? <>{" — столько же, сколько "}{comparison.inWords}</>
        : comparison.kind === "nothing-before" ? <>; {comparison.inWords} {words.genitive} не было</>
          : <>; {CALENDAR_START_WORDS}</>}
    </p>
  );
}

/** Сравнить не с чем: прошлый период начался бы раньше 1900 года, а записей там не бывает. */
export const CALENDAR_START_WORDS = "сравнить не с чем — записи ведутся с 1900 года";

/** Метки полосами: операция с двумя метками входит в обе, поэтому доли в сумме бывают больше 100 %. */
function TagsCard({ model, onFeed }: { readonly model: ReportModel; readonly onFeed: (filters: OperationsFilterFields) => void }) {
  const currency = model.baseCurrency;
  return (
    <section className="card report-card" aria-labelledby="report-headline">
      <h2 id="report-headline">{model.headline}</h2>
      <p className="report-compare">
        Расходы {model.period.forWords} — <Money value={model.breakdown.expense.totalMinor} currency={currency} />. Операция с двумя метками входит в обе, поэтому доли могут дать больше 100&nbsp;%.
      </p>
      <ul className="report-legend tag-bars">
        {model.tags.map((row) => (
          <li key={row.tagId}>
            <button
              className="legend-row tag-bar-row"
              type="button"
              aria-label={`#${row.name}${row.archived ? " (в архиве)" : ""}: ${formatMoney(row.expenseMinor, currency)}, ${shareText(row.share)} расходов${row.incomeMinor > 0 ? `, доходы ${formatMoney(row.incomeMinor, currency)}` : ""}. Показать операции`}
              onClick={() => onFeed(row.feed)}
            >
              <span className="legend-text">
                <b>#<bdi dir="auto">{row.name}</bdi>{row.archived ? <span className="tag-archived"> · в архиве</span> : null}</b>
                <span>
                  <Money value={row.expenseMinor} currency={currency} /> · {shareText(row.share)}
                  {row.incomeMinor > 0 ? <> · доходы <Money value={row.incomeMinor} currency={currency} /></> : null}
                </span>
                <svg className="tag-bar" width="100%" height="6" aria-hidden="true" focusable="false">
                  <rect className="tag-bar-track" x="0" y="0" width="100%" height="6" />
                  <rect className="tag-bar-fill" x="0" y="0" width={`${row.bar}%`} height="6" />
                </svg>
              </span>
              <Icon name="chevron-right" size={20} className="legend-chevron" />
            </button>
          </li>
        ))}
      </ul>
      <details className="report-details">
        <summary>Все метки таблицей</summary>
        <table className="report-table">
          <caption>Траты с метками {model.period.forWords}, за вычетом возвратов</caption>
          <thead><tr><th scope="col">Метка</th><th scope="col">Расходы</th><th scope="col">Доля</th><th scope="col">Доходы</th></tr></thead>
          <tbody>
            {model.tags.map((row) => (
              <tr key={row.tagId}>
                <th scope="row">#<bdi dir="auto">{row.name}</bdi>{row.archived ? " (в архиве)" : ""}</th>
                <td><Money value={row.expenseMinor} currency={currency} /></td>
                <td>{shareText(row.share)}</td>
                <td><Money value={row.incomeMinor} currency={currency} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

/** Подпись «По месяцам»: «Расходы за полгода, октябрь — пока неполный». */
function monthsCaption(model: ReportModel, today: string): string {
  const what = viewWords(model.view).title;
  const span = model.period.kind === "year" ? `${what} по месяцам ${model.period.from.slice(0, 4)} года`
    : model.period.kind === "custom" ? `${what} по месяцам периода`
      : `${what} за полгода`;
  const current = model.bars.find((bar) => bar.current);
  return current === undefined ? span : `${span}, ${monthLabel(current.month, today).toLowerCase()} — пока неполный`;
}

/** Быстрые периоды листа «Свой период»: прошлый месяц, квартал и год — от сегодняшнего дня. */
function quickPeriods(fields: ReportsFields, today: string, choose: (fields: ReportsFields) => void): readonly FilterChoice[] {
  const previousMonth = shiftMonth(monthOfDate(today), -1);
  const quarterStart = shiftMonth(monthOfDate(today), -((Number(today.slice(5, 7)) - 1) % 3) - 3);
  const previousYear = String(Number(today.slice(0, 4)) - 1);
  const base: { view?: ReportView; acc?: string } = { ...(fields.view === undefined ? {} : { view: fields.view }), ...(fields.acc === undefined ? {} : { acc: fields.acc }) };
  const isPeriod = (kind: "month" | "quarter" | "year", from: string) => fields.period === kind && fields.from === from;
  return [
    { key: "month", label: `Прошлый месяц · ${monthLabel(previousMonth, today)}`, selected: isPeriod("month", monthStartDate(previousMonth)), onSelect: () => choose({ ...base, period: "month", from: monthStartDate(previousMonth) }) },
    { key: "quarter", label: "Прошлый квартал", selected: isPeriod("quarter", monthStartDate(quarterStart)), onSelect: () => choose({ ...base, period: "quarter", from: monthStartDate(quarterStart) }) },
    { key: "year", label: `Прошлый год · ${previousYear}`, selected: isPeriod("year", `${previousYear}-01-01`), onSelect: () => choose({ ...base, period: "year", from: `${previousYear}-01-01` }) },
  ];
}
