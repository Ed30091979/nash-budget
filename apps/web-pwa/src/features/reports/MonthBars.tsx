import type { CurrencyCode } from "@family-budget/domain";
import { Money } from "../../components/Money";
import { formatMoney } from "../../money";
import { compactAmount, monthFull, monthShort, type ReportBar } from "./report-model";

/** Высота поля столбцов, px. */
const BAR_AREA = 100;

/**
 * «По месяцам» (макет 09): столбец на месяц в календарном порядке, над ним — сумма коротко («76 тыс.»),
 * под ним — месяц. Сегодняшний месяц — акцентом и жирной подписью: цвет не единственный носитель.
 * Для слуха ряд — одна картинка с суммами словами, а точные значения — в таблице под ним.
 * Высота — атрибутом SVG, цвет — классом: инлайновых стилей нет (CSP `style-src 'self'`).
 */
export function MonthBars({ bars, currency, label, today }: {
  readonly bars: readonly ReportBar[];
  readonly currency: CurrencyCode;
  /** «Расходы по месяцам»: начало подписи картинки и подпись таблицы. */
  readonly label: string;
  readonly today: string;
}) {
  const summary = `${label}: ${bars.map((bar) => `${monthFull(bar.month, today)} ${formatMoney(bar.amountMinor, currency)}`).join(", ")}`;
  return <>
    <div className="month-bars" role="img" aria-label={summary}>
      {bars.map((bar) => {
        const height = Math.round(bar.height * BAR_AREA);
        return (
          <div key={bar.month} className={bar.current ? "month-bar current" : "month-bar"} aria-hidden="true">
            <span className="month-bar-value">{compactAmount(bar.amountMinor, currency)}</span>
            <svg className="month-bar-svg" width="100%" height={BAR_AREA} focusable="false">
              <rect className="month-bar-rect" x="0" y={BAR_AREA - height} width="100%" height={height} />
            </svg>
            <span className="month-bar-label">{monthShort(bar.month)}</span>
          </div>
        );
      })}
    </div>
    <details className="report-details">
      <summary>Показать таблицей</summary>
      <table className="report-table">
        <caption>{label}</caption>
        <thead><tr><th scope="col">Месяц</th><th scope="col">Сумма</th></tr></thead>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.month}>
              <th scope="row">{monthFull(bar.month, today)}{bar.current ? " (идёт)" : ""}</th>
              <td><Money value={bar.amountMinor} currency={currency} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  </>;
}
