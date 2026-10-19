import { useId, useState, type FormEvent } from "react";
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
 */
export function RateQuickSheet({ currency, baseCurrency, date, onSave, onCancel }: RateQuickSheetProps) {
  const id = useId();
  // A plain name, not a template literal in the props: the release scan reads the built `form`
  // props up to the first brace and must find `onSubmit` there.
  const titleId = `${id}-title`;
  const per = ratePer(currency);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
  return (
    <form className="rate-quick" onSubmit={(event) => void submit(event)} aria-labelledby={titleId} noValidate>
      <h3 id={titleId}>Курс {currency} с {formatDay(date)}</h3>
      <div className="field">
        <label htmlFor={`${id}-rate`}>Сколько {currencySign(baseCurrency)} за {per} {currency}</label>
        <input id={`${id}-rate`} inputMode="decimal" autoComplete="off" maxLength={20} placeholder="92,50" value={text} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => { setText(event.target.value); setError(null); }} />
      </div>
      <p className="field-hint">Курс действует с этого дня, пока не задан новый. Уже записанные операции он не переоценивает.</p>
      {error ? <p className="field-error" id={`${id}-error`} role="alert">{error}</p> : null}
      <div className="rate-quick-actions">
        <button className="primary-button" type="submit" disabled={busy} aria-busy={busy}>Сохранить курс</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}
