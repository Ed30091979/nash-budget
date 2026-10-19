import { Money } from "../../components/Money";
import { MoneyOdometer } from "../../components/MoneyOdometer";
import { formatMoney } from "../../money";

export interface EntryReceiptValue {
  /** «Осталось в категории «Продукты»», «Остаток на счёте «Карта»». */
  readonly label: string;
  readonly beforeMinor: number;
  readonly afterMinor: number;
  readonly currency: string;
}

/**
 * Число, которое сдвинула запись, — в тосте «Записано» (§5 исследования, пункты 27–28): одометр от
 * прежнего значения к новому, рядом — разница. Катушка `aria-hidden`; итог и разницу произносит
 * строка рядом, одна на весь тост.
 */
export function EntryReceipt({ value }: { readonly value: EntryReceiptValue }) {
  const change = value.afterMinor - value.beforeMinor;
  const spoken = `${value.label}: ${formatMoney(value.afterMinor, value.currency)}${change === 0 ? "" : `, ${change < 0 ? "меньше" : "больше"} на ${formatMoney(Math.abs(change), value.currency)}`}`;
  return (
    <div className="toast-receipt">
      <small aria-hidden="true">{value.label}</small>
      <span className="toast-receipt-value">
        <MoneyOdometer from={value.beforeMinor} to={value.afterMinor} currency={value.currency} />
        {change === 0 ? null : <span className="save-receipt-change" aria-hidden="true"><Money value={Math.abs(change)} currency={value.currency} sign={change < 0 ? "−" : "+"} /></span>}
        <span className="sr-only">{spoken}</span>
      </span>
    </div>
  );
}
