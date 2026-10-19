import { useRef, useState } from "react";
import { householdPaydays, type BudgetState } from "@family-budget/domain";
import { paydayWords } from "../more/MoreScreen";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { PaydayQuestion } from "./PaydayQuestion";

export interface PaydaysCardProps {
  readonly budget: BudgetState;
  readonly write: BudgetWriter;
  /** Что записано — словами оболочки (тост). */
  readonly onMessage: (message: string) => void;
}

/**
 * «Дни выплат» в «Плане месяца» (ревью R2, M-4): то, что семья ответила на «Когда приходит
 * зарплата?», — и «Изменить дни выплат». Названные дни главнее истории доходов (`reach.ts`), поэтому
 * ошибочное касание или новая работа не должны искажать «хватает до…», ось «Года» и план навсегда:
 * лист того же вопроса открывается с нынешним ответом, «Нет постоянной» снимает поле, и даты снова
 * выводятся из доходов. Сюда ведут строка «План месяца» в «Ещё» и карточка «Можно тратить» на «Обзоре».
 */
export function PaydaysCard({ budget, write, onMessage }: PaydaysCardProps) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const days = householdPaydays(budget);
  const close = () => {
    setOpen(false);
    // Лист закрылся — фокус туда, откуда его открыли.
    window.setTimeout(() => opener.current?.focus({ preventScroll: true }), 0);
  };
  return (
    <section className="section-card paydays-card" aria-labelledby="paydays-title">
      <h2 id="paydays-title">Дни выплат</h2>
      <p className="paydays-now">
        {days.length === 0 ? "Не названы: даты выплат берутся из доходов." : <strong>{paydayWords(days)}</strong>}
      </p>
      <p className="field-hint">По ним считаются «хватает до…» на «Обзоре» и выплаты на оси «Года».</p>
      <button ref={opener} className="secondary-button" type="button" onClick={() => setOpen(true)}>Изменить дни выплат</button>
      {open ? (
        <PaydayQuestion
          write={write}
          initial={days}
          onLater={close}
          onAnswered={(answer) => {
            onMessage(answer === null ? "Дни выплат сняты: даты берутся из доходов." : `Дни выплат: ${paydayWords(answer)}.`);
            close();
          }}
        />
      ) : null}
    </section>
  );
}
