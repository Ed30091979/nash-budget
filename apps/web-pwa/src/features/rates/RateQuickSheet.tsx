import { useId, useState, type KeyboardEvent } from "react";
import { isWithinDateWindow, type CurrencyCode, type ExchangeRateDraft } from "@family-budget/domain";
import { CurrencySelect } from "../../components/CurrencySelect";
import { formatDay } from "../../date-words";
import { moneyParts } from "../../money";
import { useFormDraft } from "../../navigation/draft-guard";
import { parseRateInput, ratePer } from "./rate-input";

export interface RateQuickSheetProps {
  readonly currency: CurrencyCode;
  readonly baseCurrency: CurrencyCode;
  /** День операции: курс задаётся с него. */
  readonly date: string;
  /** Записать курс; ответ — слова отказа или `null`, если записано. */
  readonly onSave: (draft: ExchangeRateDraft) => Promise<string | null>;
  readonly onCancel: () => void;
  /**
   * Экран «Курсы валют» (2c): валюту выбирают из списка — `currency` в нём первой, — день — полем
   * даты, а набранный курс — черновик экрана: уход с ним спрашивает диалог приложения. Без этого —
   * лист ввода: валюта и день — операции, черновик — листа.
   */
  readonly screen?: { readonly preferred: readonly CurrencyCode[]; readonly draftLabel: string };
}

/** Знак валюты так, как его набирает `Money`: «₽», «$», «KZT». */
export function currencySign(currency: CurrencyCode): string {
  return moneyParts(0, currency).currency.trim();
}

/**
 * «Задать курс» прямо из листа ввода (план волны 2, §1.2, §1.6): курса на день операции нет, и лист
 * говорит это до записи. Курс задаётся с этого дня и действует, пока не задан новый; записанное
 * раньше он не переоценивает. На экране «Курсы валют» та же группа добавляет курс любой валюты с
 * любого дня — разбор и запись одни и те же.
 *
 * Это группа, а не форма: она стоит внутри формы листа, а вложенная форма в HTML недопустима — в
 * Chromium её отправка не доходит до обработчика React, браузер отправляет её сам, и курс не
 * записывается (ревью 2b, HIGH-1). Поэтому кнопка — `type="button"`, а Enter в поле курса
 * перехватывается здесь: иначе он отправил бы форму листа и записал операцию вместо курса.
 */
export function RateQuickSheet({ currency, baseCurrency, date, onSave, onCancel, screen }: RateQuickSheetProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const [selected, setSelected] = useState<CurrencyCode>(currency);
  const [day, setDay] = useState(date);
  const per = ratePer(selected);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // В листе ввода черновик курса — часть листа, и реестр его не знает; на экране курсов набранное
  // число — черновик экрана.
  const saving = useFormDraft({ label: screen?.draftLabel ?? "курс", dirty: screen !== undefined && text.trim() !== "", discard: () => setText("") });
  const save = async () => {
    if (busy) return;
    if (screen !== undefined && !isWithinDateWindow(day)) {
      setError("Выберите существующую календарную дату.");
      return;
    }
    const parsed = parseRateInput(text, selected, baseCurrency, per);
    if (parsed.kind === "error") {
      setError(parsed.message);
      return;
    }
    const ticket = saving.begin();
    setBusy(true);
    const refusal = await onSave({ currency: selected, date: day, rate: parsed.rate });
    setBusy(false);
    if (refusal === null) saving.succeed(ticket);
    else saving.fail(ticket);
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
      <h3 id={titleId}>{screen === undefined ? <>Курс {currency} с {formatDay(date)}</> : "Новый курс"}</h3>
      {screen === undefined ? null : <>
        <div className="field">
          <label htmlFor={`${id}-currency`}>Валюта</label>
          <CurrencySelect id={`${id}-currency`} value={selected} exclude={[baseCurrency]} preferred={screen.preferred} disabled={busy} onChange={(code) => { setSelected(code); setError(null); }} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-date`}>С какого дня</label>
          <input id={`${id}-date`} type="date" value={day} disabled={busy} onChange={(event) => { setDay(event.target.value); setError(null); }} />
        </div>
      </>}
      <div className="field">
        <label htmlFor={`${id}-rate`}>Сколько {currencySign(baseCurrency)} за {per} {selected}</label>
        <input id={`${id}-rate`} inputMode="decimal" autoComplete="off" maxLength={20} placeholder={per === 100 ? "18,40" : "92,50"} value={text} disabled={busy} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => { setText(event.target.value); setError(null); }} onKeyDown={onFieldKey} />
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
