import type { CurrencyCode } from "@family-budget/domain";
import { Hyphenated } from "../../components/Hyphenated";
import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import { formatMoney } from "../../money";
import { chartToneClass } from "./Donut";
import { percentText, type ReportSegment, type ReportTableRow } from "./report-model";

/**
 * Легенда кольца (макет 09): строка-кнопка 48 на сектор — образец цвета, имя, «сумма · доля» и
 * шеврон. Касание ведёт в «Операции» с фильтром этой категории и периода; «Остальное» и доход без
 * категории раскрывают таблицу всех категорий: фильтра «без категории» у ленты нет (ревью 2d,
 * LOW-1). Доступное имя называет всё, что видно, и куда ведёт; доли в сумме — ровно 100 %.
 */
export function ReportLegend({ segments, currency, allLabel, onOpen, onRest }: {
  readonly segments: readonly ReportSegment[];
  readonly currency: CurrencyCode;
  /** Куда ведёт строка без ленты: «Показать все категории» или «Показать все источники». */
  readonly allLabel: string;
  readonly onOpen: (segment: ReportSegment) => void;
  readonly onRest: () => void;
}) {
  return (
    <ul className="report-legend">
      {segments.map((segment) => (
        <li key={segment.key}>
          <button
            className="legend-row"
            type="button"
            aria-label={`${segment.name}: ${formatMoney(segment.amountMinor, currency)}, ${percentText(segment.percent, segment.amountMinor)}. ${segment.feed === null ? allLabel : "Показать операции"}`}
            onClick={() => (segment.feed === null ? onRest() : onOpen(segment))}
          >
            <span className={`legend-swatch ${chartToneClass(segment)}`} aria-hidden="true" />
            <span className="legend-text">
              <b><bdi dir="auto"><Hyphenated text={segment.name} /></bdi></b>
              <span><Money value={segment.amountMinor} currency={currency} /> · {percentText(segment.percent, segment.amountMinor)}</span>
            </span>
            <Icon name="chevron-right" size={20} className="legend-chevron" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Таблица всех категорий периода: имя, сумма за вычетом возвратов, доля — то, что кольцо показывает долями. */
export function CategoryTable({ rows, totalMinor, currency, caption, nameHeader }: {
  readonly rows: readonly ReportTableRow[];
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  readonly caption: string;
  readonly nameHeader: string;
}) {
  return (
    <table className="report-table">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">{nameHeader}</th><th scope="col">Сумма</th><th scope="col">Доля</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row"><bdi dir="auto">{row.name}</bdi>{row.archived ? " (в архиве)" : ""}</th>
            <td><Money value={row.amountMinor} currency={currency} /></td>
            <td>{percentText(row.percent, row.amountMinor)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr><th scope="row">Всего</th><td><Money value={totalMinor} currency={currency} /></td><td /></tr></tfoot>
    </table>
  );
}
