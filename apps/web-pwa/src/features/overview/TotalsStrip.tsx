import { Money } from "../../components/Money";

export interface TotalsStripProps {
  /** «На счетах» — всё, что лежит на счетах, в базовой валюте (`calculateHoldings`). */
  readonly totalMinor: number;
  /** «Расходы» — весь расход показанного месяца, тот же, что в «Отчётах» (ревью 2b, MEDIUM-8). */
  readonly spentMinor: number;
  /** «Можно тратить» — остаток повседневных лимитов месяца плана; `null` — лимитов нет. */
  readonly canSpendMinor: number | null;
  readonly onAccounts: () => void;
  readonly onReports: () => void;
  readonly onPlan: () => void;
}

/**
 * Три итога шапки «Обзора» (DESIGN 5.0 §6, макеты v5 §d): «На счетах · Расходы · Можно тратить».
 * Каждый — кнопка к экрану, где число раскладывается: к счетам, к отчётам, к плану месяца. При
 * прокрутке итоги остаются на месте вместе с месяцем (`.overview-head`), а при крупном шрифте
 * становятся строками «подпись — сумма».
 *
 * «Можно тратить» — та же величина, что у прежнего героя «Сегодня»: лимиты повседневных категорий
 * месяца плана минус потраченное по ним. Без лимитов числа нет — и итог так и говорит, а не «0 ₽».
 */
export function TotalsStrip({ totalMinor, spentMinor, canSpendMinor, onAccounts, onReports, onPlan }: TotalsStripProps) {
  return (
    <div className="totals-strip" role="group" aria-label="Итоги">
      <button className="total" type="button" onClick={onAccounts}>
        <span className="total-label">На счетах</span>
        <span className="total-value overview-total"><Money value={totalMinor} breakDigits /></span>
      </button>
      <button className="total" type="button" onClick={onReports}>
        <span className="total-label">Расходы</span>
        <span className="total-value"><Money value={spentMinor} breakDigits /></span>
      </button>
      <button className="total total-can-spend" type="button" onClick={onPlan}>
        <span className="total-label">Можно тратить</span>
        <span className="total-value">{canSpendMinor === null ? <span className="total-none">лимитов нет</span> : <Money value={canSpendMinor} breakDigits />}</span>
      </button>
    </div>
  );
}
