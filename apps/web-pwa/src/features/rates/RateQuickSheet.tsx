import { useId, useState, type KeyboardEvent } from "react";
import type { CurrencyCode, ExchangeRateDraft } from "@family-budget/domain";
import { formatDay } from "../../date-words";
import { moneyParts } from "../../money";
import { parseRateInput, ratePer } from "./rate-input";

export interface RateQuickSheetProps {
  readonly currency: CurrencyCode;
  readonly baseCurrency: CurrencyCode;
  /** День операции: курс задаётся с него. */
  readonly date: string;
  /** Записать курс; ответ — слова отказа или `null`, если записано. */
  readonly onSave: (draft: ExchangeRateDraft) => Promise<string | null>;
  readonly onCancel: () => void;
}

/** Знак валюты так, как его набирает `Money`: «₽», «$», «KZT». */
export function currencySign(currency: CurrencyCode): string {
  return moneyParts(0, currency).currency.trim();
}

/**
 * «Задать курс» прямо из листа ввода (план волны 2, §1.2, §1.6): курса на день операции нет, и лист
 * говорит это до записи. Курс задаётся с этого дня и действует, пока не задан новый; записанное
 * раньше он не переоценивает. Экран курсов целиком — подволна 2c.
 *
 * Это группа, а не форма: она стоит внутри формы листа, а вложенная форма в HTML недопустима — в
 * Chromium её отправка не доходит до обработчика React, браузер отправляет её сам, и курс не
 * записывается (ревью 2b, HIGH-1). Поэтому кнопка — `type="button"`, а Enter в поле курса
 * перехватывается здесь: иначе он отправил бы форму листа и записал операцию вместо курса.
 */
export function RateQuickSheet({ currency, baseCurrency, date, onSave, onCancel }: RateQuickSheetProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const per = ratePer(currency);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    const parsed = parseRateInput(text, currency, baseCurrency, per);
    if (parsed.kind === "error") {
      setError(parsed.message);
      return;
    }
    setBusy(true);
    const refusal = await onSave({ currency, date, rate: parsed.rate });
    setBusy(false);
    setError(refusal);
  };
  /** Enter in the rate field saves the rate and must not reach the sheet's form around it. */
  const onFieldKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void save();
  };
  return (
    <div className="rate-quick" role="group" aria-labelledby={titleId}>
      <h3 id={titleId}>Курс {currency} с {formatDay(date)}</h3>
      <div className="field">
        <label htmlFor={`${id}-rate`}>Сколько {currencySign(baseCurrency)} за {per} {currency}</label>
        <input id={`${id}-rate`} inputMode="decimal" autoComplete="off" maxLength={20} placeholder="92,50" value={text} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => { setText(event.target.value); setError(null); }} onKeyDown={onFieldKey} />
      </div>
      <p className="field-hint">Курс действует с этого дня, пока не задан новый. Уже записанные операции он не переоценивает.</p>
      {error ? <p className="field-error" id={`${id}-error`} role="alert">{error}</p> : null}
      <div className="rate-quick-actions">
        <button className="primary-button" type="button" disabled={busy} aria-busy={busy} onClick={() => void save()}>Сохранить курс</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>Отмена</button>
      </div>
    </div>
  );
}
