import { useMemo, useState, type ReactNode } from "react";
import {
  addExchangeRate,
  deleteExchangeRate,
  setBaseCurrency,
  type BudgetState,
  type CurrencyCode,
  type ExchangeRate,
  type ExchangeRateCreation,
  type ExchangeRateDraft,
} from "@family-budget/domain";
import { BackButton } from "../../components/BackButton";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { CurrencySelect, currencyLabel, currencyName } from "../../components/CurrencySelect";
import { useFocusAfterRender } from "../../components/focus-after-render";
import { Icon } from "../../components/Icon";
import { formatDayYear, formatDayYearLine } from "../../date-words";
import { useFormDraft } from "../../navigation/draft-guard";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { currencySign, RateQuickSheet } from "./RateQuickSheet";
import { baseCurrencyState, currencyRates, familyCurrencies, rateSavedText, rateWords, ratesErrorText, type CurrencyRates } from "./rates-model";

export interface RatesScreenProps {
  readonly budget: BudgetState;
  readonly today: string;
  readonly write: BudgetWriter;
  readonly onBack: () => void;
}

/** `id` заголовка карточки валюты и кнопок «Добавить курс»: по ним фокус находит, куда вернуться. */
const cardTitleId = (currency: CurrencyCode) => `rates-${currency}`;
const addButtonId = (where: "top" | CurrencyCode) => `rates-add-${where}`;

/** Где открыта группа «Новый курс»: над списком — для любой валюты, или в карточке своей валюты. */
type Adding = { readonly where: "top" | CurrencyCode; readonly currency: CurrencyCode } | null;

/**
 * «Курсы валют» (план волны 2, §1.6): базовая валюта и почему её не сменить; по каждой валюте
 * семьи — курс на сегодня, его дата и история с удалением; «Добавить курс» — та же группа, что
 * «Задать курс» в листе ввода (`RateQuickSheet`), с выбором валюты и дня. Курс задаётся вручную и
 * записанное не переоценивает — экран говорит это словами.
 */
export function RatesScreen({ budget, today, write, onBack }: RatesScreenProps) {
  const base = baseCurrencyState(budget);
  const cards = useMemo(() => currencyRates(budget, today), [budget, today]);
  const preferred = useMemo(() => familyCurrencies(budget), [budget]);
  const [adding, setAdding] = useState<Adding>(null);
  const [removing, setRemoving] = useState<ExchangeRate | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  // После записи и удаления курса — на заголовок карточки его валюты, после «Отмена» — на кнопку,
  // что открыла группу (ревью 2c, MEDIUM-3): группа закрывается, и фокус иначе падал на <body>.
  const focusAfterRender = useFocusAfterRender();

  const saveRate = async (draft: ExchangeRateDraft): Promise<string | null> => {
    const outcome: { saved?: ExchangeRateCreation } = {};
    try {
      // Отказ домена — до записи и словами поля; запись повторяет его на настоящем состоянии, и
      // слова о записи — по тому, что записалось: новый день или поправка курса этого дня.
      addExchangeRate(budget, draft);
      await write.run((state) => {
        outcome.saved = addExchangeRate(state, draft);
        return outcome.saved.state;
      });
    } catch (cause) {
      return ratesErrorText(cause);
    }
    setAdding(null);
    setStatus(outcome.saved === undefined ? `Курс ${draft.currency} записан.` : rateSavedText(outcome.saved));
    focusAfterRender(cardTitleId(draft.currency));
    return null;
  };
  const cancel = () => {
    if (adding !== null) focusAfterRender(addButtonId(adding.where));
    setAdding(null);
  };
  const remove = async (rate: ExchangeRate) => {
    setRemoving(null);
    setError(null);
    try {
      await write.run((state) => deleteExchangeRate(state, rate.id));
      setStatus(`Курс ${rate.currency} от ${formatDayYear(rate.date)} удалён.`);
      focusAfterRender(cardTitleId(rate.currency));
    } catch (cause) {
      setError(ratesErrorText(cause));
    }
  };

  const firstForeign = preferred[0] ?? (base.currency === "USD" ? "EUR" : "USD");
  const panel = (where: "top" | CurrencyCode, currency: CurrencyCode) => (
    <RateQuickSheet
      key={`${where}-${currency}`}
      currency={currency}
      baseCurrency={base.currency}
      date={today}
      screen={{ preferred, draftLabel: "курс, который не записан" }}
      onSave={saveRate}
      onCancel={cancel}
    />
  );

  return (
    <div className="manage-screen rates-screen">
      <div className="planning-toolbar"><BackButton label="К разделу «Ещё»" onClick={onBack} /></div>
      <header className="manage-head">
        <h1>Курсы валют</h1>
        <p>Курс задаётся вручную и действует с его даты, пока не задан новый. Он не переоценивает записанное: у каждой операции — свой курс на день записи.</p>
      </header>

      <BaseCurrencySection budget={budget} lockText={base.lockText} write={write} onDone={setStatus} focusAfterRender={focusAfterRender} />

      <p className="manage-status" role="status">{status}</p>
      {error === null ? null : <p className="field-error" role="alert">{error}</p>}

      {adding?.where === "top" ? panel("top", adding.currency) : (
        <button id={addButtonId("top")} className="primary-button manage-add" type="button" onClick={() => setAdding({ where: "top", currency: firstForeign })}>
          <span className="icon-label"><Icon name="plus" size={20} />Добавить курс</span>
        </button>
      )}

      {cards.length === 0 ? (
        <p className="field-hint">Счетов в другой валюте и курсов пока нет. Курс понадобится, когда появится счёт в долларах, евро или другой валюте: операции по нему записываются и в {currencySign(base.currency)}.</p>
      ) : cards.map((card) => (
        <CurrencyCard
          key={card.currency}
          card={card}
          adding={adding?.where === card.currency}
          panel={panel(card.currency, card.currency)}
          onAdd={() => setAdding({ where: card.currency, currency: card.currency })}
          onRemove={setRemoving}
        />
      ))}

      {removing === null ? null : (
        <ConfirmDialog
          title={`Удалить курс ${removing.currency} от ${formatDayYear(removing.date)}?`}
          description="Записанные операции сохранят свой курс. Новые операции и «Всего на счетах» возьмут курс, заданный раньше, — или попросят задать новый."
          cancelLabel="Оставить"
          confirmLabel="Удалить курс"
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove(removing)}
        />
      )}
    </div>
  );
}

function CurrencyCard({ card, adding, panel, onAdd, onRemove }: {
  readonly card: CurrencyRates;
  readonly adding: boolean;
  readonly panel: ReactNode;
  readonly onAdd: () => void;
  readonly onRemove: (rate: ExchangeRate) => void;
}) {
  const titleId = cardTitleId(card.currency);
  return (
    <section className="section-card rate-card" aria-labelledby={titleId}>
      <h2 id={titleId}><span className="rate-code">{card.currency}</span> {currencyName(card.currency)}</h2>
      {card.current === undefined ? (
        <p className="rate-now missing"><Icon name="triangle-alert" size={20} /><span>Курса на сегодня нет: операция по счёту в {card.currency} попросит его при записи, а «Всего на счетах» его не учтёт.</span></p>
      ) : (
        <p className="rate-now"><strong>{rateWords(card.current)}</strong><span> с {formatDayYearLine(card.current.date)}</span></p>
      )}
      {card.accountNames.length === 0 ? null : (
        <p className="field-hint">Счета: {card.accountNames.map((name, index) => <span key={`${name}-${index}`}>{index > 0 ? ", " : ""}«<bdi dir="auto">{name}</bdi>»</span>)}</p>
      )}
      {card.history.length === 0 ? null : <>
        <h3 className="list-kicker">История</h3>
        <ul className="rate-history">
          {card.history.map((rate) => (
            <li key={rate.id}>
              <span className="rate-history-day">{formatDayYearLine(rate.date)}</span>
              <span className="rate-history-value">{rateWords(rate)}</span>
              <button className="quiet-button" type="button" aria-label={`Удалить курс ${rate.currency} от ${formatDayYear(rate.date)}`} onClick={() => onRemove(rate)}>Удалить</button>
            </li>
          ))}
        </ul>
      </>}
      {adding ? panel : (
        <button id={addButtonId(card.currency)} className="secondary-button" type="button" onClick={onAdd}>
          <span className="icon-label"><Icon name="plus" size={20} />Добавить курс {card.currency}</span>
        </button>
      )}
    </section>
  );
}

/**
 * Базовая валюта — та, в которой считается весь бюджет. Меняется, только пока бюджет пуст (домен:
 * `setBaseCurrency`, `baseCurrencyLock`): ни операций, ни планов, ни долгов, ни счетов в другой
 * валюте, ни курсов. Иначе — слова домена о том, что её держит.
 */
function BaseCurrencySection({ budget, lockText, write, onDone, focusAfterRender }: {
  readonly budget: BudgetState;
  readonly lockText: string | null;
  readonly write: BudgetWriter;
  readonly onDone: (message: string) => void;
  readonly focusAfterRender: (id: string) => void;
}) {
  const current = baseCurrencyState(budget).currency;
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<CurrencyCode>(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useFormDraft({ label: "новая базовая валюта", dirty: editing && choice !== current, discard: () => { setChoice(current); setEditing(false); } });
  const save = async () => {
    if (busy) return;
    const ticket = saving.begin();
    setBusy(true);
    setError(null);
    try {
      await write.run((state) => setBaseCurrency(state, choice));
      saving.succeed(ticket);
      setEditing(false);
      onDone(`Базовая валюта — ${currencyLabel(choice)}.`);
      // Форма закрылась: фокус — на заголовок раздела, под которым названа новая база.
      focusAfterRender("base-currency-title");
    } catch (cause) {
      saving.fail(ticket);
      setError(ratesErrorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="section-card base-currency" aria-labelledby="base-currency-title">
      <h2 id="base-currency-title">Базовая валюта</h2>
      <p className="rate-now"><strong>{currencySign(current)} {currencyLabel(current)}</strong></p>
      <p className="field-hint">В ней считаются бюджет, лимиты и итоги; операция по счёту в другой валюте записывается и в ней — по курсу дня.</p>
      {lockText !== null ? <p className="field-hint" id="base-currency-lock">{lockText}</p> : editing ? (
        <div className="base-currency-form">
          <div className="field">
            <label htmlFor="base-currency-select">Новая базовая валюта</label>
            <CurrencySelect id="base-currency-select" value={choice} disabled={busy} onChange={setChoice} />
          </div>
          {error === null ? null : <p className="field-error" role="alert">{error}</p>}
          <div className="rate-quick-actions">
            <button className="primary-button" type="button" aria-disabled={busy || choice === current || undefined} aria-busy={busy} onClick={() => { if (choice !== current) void save(); }}>Сохранить</button>
            <button className="secondary-button" type="button" aria-disabled={busy || undefined} onClick={() => { if (busy) return; setChoice(current); setEditing(false); setError(null); focusAfterRender("base-currency-change"); }}>Отмена</button>
          </div>
        </div>
      ) : (
        <>
          <p className="field-hint">Её можно сменить, пока в бюджете нет ни операций, ни планов: потом она задана раз и навсегда.</p>
          <button id="base-currency-change" className="secondary-button" type="button" onClick={() => { setEditing(true); focusAfterRender("base-currency-select"); }}>Сменить базовую валюту</button>
        </>
      )}
    </section>
  );
}
