import { useState } from "react";
import { Icon } from "../../components/Icon";
import { formatDay } from "../../date-words";
import { dateChoice, yesterdayOf } from "./entry-model";

/**
 * «Сегодня / Вчера / другой день» (план волны 2, §1.2). Дни — по местному календарю семьи, а не по
 * UTC (`localToday`). Другой день — нативное поле даты: оно знает календарь платформы и читается
 * экранным диктором лучше любого самодельного.
 */
export function DateChips({ value, today, onChange }: { readonly value: string; readonly today: string; readonly onChange: (date: string) => void }) {
  const choice = dateChoice(value, today);
  const [picking, setPicking] = useState(choice === "other");
  const other = choice === "other" && value !== "";
  return (
    <fieldset className="date-chips">
      <legend className="visually-hidden">Дата операции</legend>
      <div className="chip-row">
        <button className="chip" type="button" aria-pressed={choice === "today"} onClick={() => { setPicking(false); onChange(today); }}><span className="chip-face">Сегодня</span></button>
        <button className="chip" type="button" aria-pressed={choice === "yesterday"} onClick={() => { setPicking(false); onChange(yesterdayOf(today)); }}><span className="chip-face">Вчера</span></button>
        <button className="chip" type="button" aria-pressed={other} aria-expanded={picking} aria-controls="entry-date" onClick={() => setPicking(true)}>
          <span className="chip-face">{other ? formatDay(value) : <><Icon name="calendar" size={20} />Другой день</>}</span>
        </button>
      </div>
      {picking || other ? <div className="field">
        <label htmlFor="entry-date">Дата</label>
        <input id="entry-date" type="date" value={value} onChange={(event) => onChange(event.target.value)} />
      </div> : null}
    </fieldset>
  );
}
