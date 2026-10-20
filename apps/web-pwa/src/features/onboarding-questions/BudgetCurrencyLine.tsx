import { useRef, useState } from "react";
import { baseCurrencyLock, baseCurrencyOf, setBaseCurrency, type BudgetState, type CurrencyCode } from "@family-budget/domain";
import { CurrencyPicker, currencyName } from "../../components/CurrencyPicker";
import { useFormDraft } from "../../navigation/draft-guard";
import { currencySign } from "../rates/RateQuickSheet";
import { NON_BASE_CURRENCIES, ratesErrorText } from "../rates/rates-model";
import type { BudgetWriter } from "../../write/useBudgetWrite";

export interface BudgetCurrencyLineProps {
  readonly budget: BudgetState;
  readonly write: BudgetWriter;
  /** Лист вопроса записывает свой ответ: менять валюту в эту минуту нельзя. */
  readonly busy?: boolean;
}

/**
 * «Валюта бюджета: ₽ · Поменять» на первом листе вопросов (ревью R2, L-3). Валюта набора берётся по
 * явному признаку языка устройства, а без него — рубль; здесь её видно сразу и можно поменять, пока
 * бюджет пуст (`baseCurrencyLock`): только валюты с двумя знаками после запятой, как на экране
 * «Курсы валют». Когда в бюджете уже что-то есть, строки нет — база задана, и меняет её тот экран.
 */
export function BudgetCurrencyLine({ budget, write, busy = false }: BudgetCurrencyLineProps) {
  const current = baseCurrencyOf(budget);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<CurrencyCode>(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const selectId = "q-currency-select";
  const draft = useFormDraft({
    label: "валюта бюджета",
    dirty: editing && choice !== current,
    discard: () => { setChoice(current); setEditing(false); },
  });
  if (baseCurrencyLock(budget) !== null && !editing) return null;

  const backToLine = () => {
    setEditing(false);
    setError(null);
    window.setTimeout(() => changeRef.current?.focus({ preventScroll: true }), 0);
  };
  const save = () => {
    if (saving || busy) return;
    if (choice === current) {
      backToLine();
      return;
    }
    const ticket = draft.begin();
    setSaving(true);
    setError(null);
    write.run((state) => setBaseCurrency(state, choice)).then(() => {
      draft.succeed(ticket);
      setSaving(false);
      backToLine();
    }, (cause: unknown) => {
      draft.fail(ticket);
      setSaving(false);
      setError(ratesErrorText(cause));
    });
  };

  if (!editing) {
    return (
      <p className="q-currency">
        <span>Валюта бюджета: <strong><span aria-hidden="true">{currencySign(current)}</span><span className="sr-only">{currencyName(current)}</span></strong></span>
        <span aria-hidden="true"> · </span>
        <button
          ref={changeRef}
          className="text-button q-currency-change"
          type="button"
          aria-label="Поменять валюту бюджета"
          aria-disabled={busy || undefined}
          onClick={() => { if (busy) return; setChoice(current); setEditing(true); window.setTimeout(() => document.getElementById(`${selectId}-${current}`)?.focus(), 0); }}
        >
          Поменять
        </button>
      </p>
    );
  }
  return (
    <div className="q-currency-form">
      <div className="field">
        {/* Чипы частых и «Другая» с поиском (дизайн 5.0, R3): системного списка нет. */}
        <span className="dir-label" id="q-currency-label">Валюта бюджета</span>
        <CurrencyPicker id={selectId} labelledBy="q-currency-label" value={choice} disabled={saving} exclude={NON_BASE_CURRENCIES} describedBy="q-currency-digits" onChange={setChoice} />
        <p className="field-hint" id="q-currency-digits">Только валюты с двумя знаками после запятой: лимиты и итоги считаются в сотых долях.</p>
      </div>
      {error === null ? null : <p className="field-error" role="alert">{error}</p>}
      <div className="q-currency-actions">
        <button className="primary-button" type="button" aria-disabled={saving || undefined} aria-busy={saving} onClick={save}>Сохранить валюту</button>
        <button className="secondary-button" type="button" aria-disabled={saving || undefined} onClick={() => { if (saving) return; setChoice(current); backToLine(); }}>Отмена</button>
      </div>
    </div>
  );
}
