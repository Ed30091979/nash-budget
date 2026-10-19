import { Icon } from "../../components/Icon";
import { monthNominative } from "../../date-words";
import { FIRST_ROUTE_MONTH, LAST_ROUTE_MONTH } from "../../navigation/routes";
import { neighbourMonth } from "./overview-model";

/** «Октябрь 2026» — месяц с годом: стрелки листают через границу года. */
export function monthTitle(month: string): string {
  return `${monthNominative(month)} ${month.slice(0, 4)}`;
}

/**
 * Переключатель месяца «Обзора»: стрелки 48 и месяц заголовком экрана. Заголовок — `h1` маршрута:
 * на него ставится фокус после перехода, и читающий с экрана слышит «Обзор, октябрь 2026».
 *
 * У края календаря домена (1900-01 и 2199-12, те же месяцы, что принимает адрес) стрелка за край
 * выключена и говорит почему: соседнего месяца там нет, и считать его нечем (ревью 2b, MEDIUM-7).
 */
export function MonthSwitch({ month, onMonth }: { readonly month: string; readonly onMonth: (month: string) => void }) {
  const previous = month > FIRST_ROUTE_MONTH ? neighbourMonth(month, -1) : null;
  const next = month < LAST_ROUTE_MONTH ? neighbourMonth(month, 1) : null;
  return (
    <div className="month-switch">
      <button
        className="month-arrow"
        type="button"
        disabled={previous === null}
        aria-label={previous === null ? `Предыдущий месяц: нет — раньше ${FIRST_ROUTE_MONTH.slice(0, 4)} года месяцев нет` : `Предыдущий месяц: ${monthTitle(previous).toLowerCase()}`}
        onClick={() => { if (previous !== null) onMonth(previous); }}
      >
        <Icon name="chevron-left" size={24} />
      </button>
      <h1><span className="visually-hidden">Обзор, </span>{monthTitle(month)}</h1>
      <button
        className="month-arrow"
        type="button"
        disabled={next === null}
        aria-label={next === null ? `Следующий месяц: нет — позже ${LAST_ROUTE_MONTH.slice(0, 4)} года месяцев нет` : `Следующий месяц: ${monthTitle(next).toLowerCase()}`}
        onClick={() => { if (next !== null) onMonth(next); }}
      >
        <Icon name="chevron-right" size={24} />
      </button>
    </div>
  );
}
