import { useId, useState, type FormEvent } from "react";
import { isWithinDateWindow, MAX_LOCAL_DATE, MIN_LOCAL_DATE, monthOfDate, monthStartDate } from "@family-budget/domain";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * «Свой период» в листе фильтра: два дня — с какого и по какой, оба включительно, — и кнопка. Поля —
 * системный выбор даты (`type="date"`), поэтому день всегда набран одним видом; проверка — здесь же:
 * день в окне календаря и последний не раньше первого, иначе слова у поля, а не тишина.
 */
export function PeriodForm({ from, to, today, submitLabel, onSubmit }: {
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly today: string;
  readonly submitLabel: string;
  readonly onSubmit: (from: string, to: string) => void;
}) {
  const id = useId();
  const [start, setStart] = useState(from ?? monthStartDate(monthOfDate(today)));
  const [end, setEnd] = useState(to ?? today);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const valid = (day: string) => DAY.test(day) && isWithinDateWindow(day);
    if (!valid(start) || !valid(end)) {
      setError("Укажите оба дня: с какого и по какой.");
      return;
    }
    if (start > end) {
      setError("Последний день раньше первого — поменяйте их местами.");
      return;
    }
    setError(null);
    onSubmit(start, end);
  };
  return (
    <form className="period-form" onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Свой период</h3>
      <div className="period-fields">
        <div className="field">
          <label htmlFor={`${id}-from`}>С</label>
          <input id={`${id}-from`} type="date" min={MIN_LOCAL_DATE} max={MAX_LOCAL_DATE} value={start} aria-describedby={error === null ? undefined : `${id}-error`} onChange={(event) => setStart(event.currentTarget.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-to`}>По</label>
          <input id={`${id}-to`} type="date" min={MIN_LOCAL_DATE} max={MAX_LOCAL_DATE} value={end} aria-describedby={error === null ? undefined : `${id}-error`} onChange={(event) => setEnd(event.currentTarget.value)} />
        </div>
      </div>
      {error === null ? null : <p className="field-error" id={`${id}-error`} role="alert">{error}</p>}
      <button className="primary-button wide" type="submit">{submitLabel}</button>
    </form>
  );
}
