import { Icon } from "../../components/Icon";
import { monthNominative } from "../../date-words";
import { neighbourMonth } from "./overview-model";

/** «Октябрь 2026» — месяц с годом: стрелки листают через границу года. */
export function monthTitle(month: string): string {
  return `${monthNominative(month)} ${month.slice(0, 4)}`;
}

/**
 * Переключатель месяца «Обзора»: стрелки 48 и месяц заголовком экрана. Заголовок — `h1` маршрута:
 * на него ставится фокус после перехода, и читающий с экрана слышит «Обзор, октябрь 2026».
 */
export function MonthSwitch({ month, onMonth }: { readonly month: string; readonly onMonth: (month: string) => void }) {
  const previous = neighbourMonth(month, -1);
  const next = neighbourMonth(month, 1);
  return (
    <div className="month-switch">
      <button className="month-arrow" type="button" aria-label={`Предыдущий месяц: ${monthTitle(previous).toLowerCase()}`} onClick={() => onMonth(previous)}>
        <Icon name="chevron-left" size={24} />
      </button>
      <h1><span className="visually-hidden">Обзор, </span>{monthTitle(month)}</h1>
      <button className="month-arrow" type="button" aria-label={`Следующий месяц: ${monthTitle(next).toLowerCase()}`} onClick={() => onMonth(next)}>
        <Icon name="chevron-right" size={24} />
      </button>
    </div>
  );
}
