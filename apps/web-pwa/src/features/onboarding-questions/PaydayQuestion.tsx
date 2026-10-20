import { useRef, useState, type KeyboardEvent } from "react";
import { setHouseholdPaydays } from "@family-budget/domain";
import { Hyphenated } from "../../components/Hyphenated";
import { Icon } from "../../components/Icon";
import { useFormDraft } from "../../navigation/draft-guard";
import { writeFailureText, type BudgetWriter } from "../../write/useBudgetWrite";
import { QuestionSheet } from "./QuestionSheet";
import { MAX_CUSTOM_PAYDAYS, PAYDAY_OPTIONS, paydayAnswer, paydayOptionFor, toggleCustomPayday, type PaydayOption } from "./questions-model";

export interface PaydayQuestionProps {
  readonly write: BudgetWriter;
  /** Ответ записан: названные дни или `null` — «Нет постоянной», поле снято. */
  readonly onAnswered: (days: readonly number[] | null) => void;
  /** Крестик и Esc: вопрос — «Спросить позже», правка — закрыть без изменений. */
  readonly onLater: () => void;
  /**
   * Правка уже названных дней («План месяца», ревью R2, M-4): лист открывается с нынешним ответом,
   * а крестик закрывает его без изменений. Без этого — вопрос первого запуска.
   */
  readonly initial?: readonly number[];
}

const DAYS = Array.from({ length: 31 }, (_unused, index) => index + 1);
export const PAYDAY_PICK_HINT = "Выберите вариант — или крестик, чтобы ответить позже.";
export const PAYDAY_EDIT_HINT = "Выберите вариант — или крестик, чтобы закрыть без изменений.";

/** «5-го» — число месяца так, как его говорят. */
function dayWord(day: number): string {
  return `${day}-го`;
}

/**
 * «Когда приходит зарплата?» (04): четыре частые пары, «Другие числа» и «Нет постоянной». Ответ
 * нужен «хватает до…»: дни ложатся в `household.paydays` (D-039); «Нет постоянной» поле снимает, и
 * линейка выводит даты из доходов, как прежде. Варианты — радиогруппа: стрелки ходят и выбирают, в
 * группу попадают одним Tab. «Другие числа» открывают выбор до четырёх чисел месяца.
 */
export function PaydayQuestion({ write, onAnswered, onLater, initial }: PaydayQuestionProps) {
  const editing = initial !== undefined;
  const [start] = useState(() => paydayOptionFor(initial ?? []));
  const [option, setOption] = useState<PaydayOption | null>(start.option);
  const [custom, setCustom] = useState<readonly number[]>(start.custom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const saving = useFormDraft({
    label: "дни выплат",
    dirty: option !== start.option || custom.join(",") !== start.custom.join(","),
    discard: () => { setOption(start.option); setCustom(start.custom); },
  });

  const pick = (next: PaydayOption) => {
    if (busy) return;
    setOption(next);
    setError(null);
  };
  const onRadioKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + PAYDAY_OPTIONS.length) % PAYDAY_OPTIONS.length;
    pick(PAYDAY_OPTIONS[next]!.id);
    radios.current[next]?.focus();
  };
  const focusable = option === null ? PAYDAY_OPTIONS[0]!.id : option;

  const done = () => {
    if (busy) return;
    const answer = paydayAnswer(option, custom);
    if (answer === undefined) {
      setError(option === "custom" ? "Отметьте хотя бы одно число." : editing ? PAYDAY_EDIT_HINT : PAYDAY_PICK_HINT);
      radios.current[Math.max(0, PAYDAY_OPTIONS.findIndex((item) => item.id === focusable))]?.focus();
      return;
    }
    const ticket = saving.begin();
    setBusy(true);
    setError(null);
    write.run((state) => setHouseholdPaydays(state, answer)).then(() => {
      saving.succeed(ticket);
      setBusy(false);
      onAnswered(answer);
    }, (cause: unknown) => {
      saving.fail(ticket);
      setBusy(false);
      setError(writeFailureText(cause));
    });
  };

  return (
    <QuestionSheet
      id="q-payday"
      title="Когда приходит зарплата?"
      subtitle="Чтобы показать, хватит ли денег до выплаты."
      onLater={onLater}
      {...(editing ? { closeLabel: "Закрыть без изменений" } : {})}
      busy={busy}
      error={error}
      footer={<button className="primary-button wide" type="button" aria-disabled={busy || undefined} aria-busy={busy} onClick={done}>Готово</button>}
    >
      <div className="q-options" role="radiogroup" aria-label="Дни выплат">
        {PAYDAY_OPTIONS.map((item, index) => {
          const on = option === item.id;
          return (
            <button
              key={item.id}
              ref={(element) => { radios.current[index] = element; }}
              className={on ? "q-option checked" : "q-option"}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={item.id === focusable ? 0 : -1}
              onClick={() => pick(item.id)}
              onKeyDown={(event) => onRadioKey(event, index)}
            >
              {on ? <Icon name="check" size={20} /> : null}
              <span><Hyphenated text={item.label} /></span>
            </button>
          );
        })}
      </div>
      {option === "custom" ? (
        <div className="q-days">
          <p className="q-group" id="q-payday-days">Числа месяца — до {MAX_CUSTOM_PAYDAYS}</p>
          <ul className="q-day-grid" aria-labelledby="q-payday-days">
            {DAYS.map((day) => {
              const on = custom.includes(day);
              const full = !on && custom.length >= MAX_CUSTOM_PAYDAYS;
              return (
                <li key={day}>
                  <button
                    className="q-day"
                    type="button"
                    aria-pressed={on}
                    aria-label={dayWord(day)}
                    aria-disabled={full || busy || undefined}
                    onClick={() => { if (!full && !busy) { setCustom((current) => toggleCustomPayday(current, day)); setError(null); } }}
                  >
                    {day}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="q-days-status" role="status">
            {custom.length === 0 ? "Числа не отмечены." : `Отмечено: ${custom.map(dayWord).join(", ")}.`}
            {custom.length >= MAX_CUSTOM_PAYDAYS ? ` Больше ${MAX_CUSTOM_PAYDAYS} не отметить.` : ""}
          </p>
        </div>
      ) : null}
    </QuestionSheet>
  );
}
