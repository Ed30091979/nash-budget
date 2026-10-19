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
import { TitleBar, TitleBarAction } from "../../components/TitleBar";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { CurrencyPicker, currencyLabel, currencyName, currencyShortName, currencySymbol } from "../../components/CurrencyPicker";
import { EmptyState } from "../../components/EmptyState";
import { useFocusAfterRender } from "../../components/focus-after-render";
import { Icon } from "../../components/Icon";
import { formatDay, formatDayYear, formatDayYearLine } from "../../date-words";
import { useFormDraft } from "../../navigation/draft-guard";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { currencySign, RateQuickSheet } from "./RateQuickSheet";
import { formatRateValue } from "./rate-input";
import { baseCurrencyState, currencyRates, familyCurrencies, NON_BASE_CURRENCIES, rateSavedText, ratesErrorText, type CurrencyRates } from "./rates-model";

export interface RatesScreenProps {
  readonly budget: BudgetState;
  readonly today: string;
  readonly write: BudgetWriter;
  readonly onBack: () => void;
  /** Пустое состояние «Счетов в другой валюте нет» ведёт к новому счёту. */
  readonly onNewAccount: () => void;
}

/** `id` заголовка карточки валюты и кнопок «Добавить курс»: по ним фокус находит, куда вернуться. */
const cardTitleId = (currency: CurrencyCode) => `rates-${currency}`;
const addButtonId = (where: "top" | CurrencyCode) => `rates-add-${where}`;

/** Где открыта группа «Новый курс»: над карточками — для любой валюты, или в карточке своей валюты. */
type Adding = { readonly where: "top" | CurrencyCode; readonly currency: CurrencyCode } | null;

/** «с 15 октября» — день курса; год — только у курса другого года, и он может уйти на новую строку. */
export function rateDayWords(date: string, today: string): string {
  return `с ${date.slice(0, 4) === today.slice(0, 4) ? formatDay(date) : formatDayYearLine(date)}`;
}

/**
 * «Курсы валют» (дизайн 5.0, макет 16): «‹ Ещё · Курсы валют · +», карточка основной валюты одной
 * строкой, по карточке на каждую валюту семьи — счета в ней, курс сегодня крупно («1 $ = 92,50 ₽»)
 * и история по датам с удалением, — и одна строка о том, что курс ручной и записанное не
 * пересчитывается. «+» — группа «Новый курс» над карточками (`RateQuickSheet`, та же, что «Задать
 * курс» в листе ввода); поправка курса того же дня заменяет его (`addExchangeRate`).
 */
export function RatesScreen({ budget, today, write, onBack, onNewAccount }: RatesScreenProps) {
  const base = baseCurrencyState(budget);
  const cards = useMemo(() => currencyRates(budget, today), [budget, today]);
  const preferred = useMemo(() => familyCurrencies(budget), [budget]);
  const [adding, setAdding] = useState<Adding>(null);
  // Набранное в открытой группе число: другая «Добавить курс» сначала спрашивает (ревью 2c, LOW-8) —
  // иначе группа сменялась, и число пропадало без слова.
  const [panelDirty, setPanelDirty] = useState(false);
  const [switching, setSwitching] = useState<Adding>(null);
  const openGroup = (next: Adding) => {
    if (adding !== null && panelDirty) {
      setSwitching(next);
      return;
    }
    setAdding(next);
  };
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
      screen={{ preferred, draftLabel: "курс, который не записан", onDirtyChange: setPanelDirty, autoFocus: true }}
      onSave={saveRate}
      onCancel={cancel}
    />
  );

  return (
    <div className="manage-screen dir-screen rates-screen">
      <TitleBar
        back={{ label: "Ещё", onClick: onBack }}
        title="Курсы валют"
        action={<TitleBarAction id={addButtonId("top")} icon="plus" label="Добавить курс" onClick={() => openGroup({ where: "top", currency: firstForeign })} />}
      />

      <BaseCurrencySection budget={budget} lockText={base.lockText} write={write} onDone={setStatus} focusAfterRender={focusAfterRender} />

      <p className="manage-status" role="status">{status}</p>
      {error === null ? null : <p className="field-error" role="alert">{error}</p>}

      {adding?.where === "top" ? <section className="card dir-rate-new" aria-label="Новый курс">{panel("top", adding.currency)}</section> : null}

      {cards.length === 0 ? (
        <EmptyState glyph="scale" title="Счетов в другой валюте нет" text="Курс понадобится для счёта в $ или €." action={{ id: "rates-new-account", label: "Новый счёт", onClick: onNewAccount }} />
      ) : <>
        {cards.map((card) => (
          <CurrencyCard
            key={card.currency}
            card={card}
            today={today}
            adding={adding?.where === card.currency}
            panel={panel(card.currency, card.currency)}
            onAdd={() => openGroup({ where: card.currency, currency: card.currency })}
            onRemove={setRemoving}
          />
        ))}
        <p className="dir-note">Курс вводите сами. Уже записанное не пересчитывается.</p>
      </>}

      {switching === null ? null : (
        <ConfirmDialog
          title="Не записывать набранный курс?"
          description={`Курс, который вы набирали, не записан. Открыть «Добавить курс${switching.where === "top" ? "" : ` ${switching.currency}`}» — значит его не записывать.`}
          cancelLabel="Продолжить ввод"
          confirmLabel="Не записывать"
          onCancel={() => setSwitching(null)}
          onConfirm={() => {
            const next = switching;
            setSwitching(null);
            setPanelDirty(false);
            setAdding(next);
          }}
        />
      )}

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

/** Знак валюты в крупном курсе: «$», «₸»; без своего знака — код. */
function symbolOf(currency: CurrencyCode): string {
  return currencySymbol(currency) ?? currency;
}

function CurrencyCard({ card, today, adding, panel, onAdd, onRemove }: {
  readonly card: CurrencyRates;
  readonly today: string;
  readonly adding: boolean;
  readonly panel: ReactNode;
  readonly onAdd: () => void;
  readonly onRemove: (rate: ExchangeRate) => void;
}) {
  const titleId = cardTitleId(card.currency);
  const value = (rate: ExchangeRate) => formatRateValue(rate.rate, rate.currency, rate.baseCurrency, card.per);
  return (
    <section className="card dir-rate" aria-labelledby={titleId}>
      <div className="dir-rate-head">
        <h2 id={titleId}>{currencyName(card.currency)}</h2>
        {card.accountNames.length === 0 ? null : (
          <span>{" · "}{card.accountNames.length === 1 ? "счёт" : "счета"} {card.accountNames.map((name, index) => <span key={`${name}-${index}`}>{index > 0 ? ", " : ""}«<bdi dir="auto">{name}</bdi>»</span>)}</span>
        )}
      </div>
      {card.current === undefined ? (
        <p className="rate-now missing"><Icon name="triangle-alert" size={20} /><span>Курса на сегодня нет: операция по счёту в {card.currency} попросит его при записи, а «Всего на счетах» его не учтёт.</span></p>
      ) : (
        <p className="dir-rate-now">{card.per} {symbolOf(card.currency)} = {value(card.current)}<span className="money-currency">{"\u00a0"}{currencySign(card.current.baseCurrency)}</span></p>
      )}
      {card.history.length === 0 ? null : (
        <ul className="rate-history" aria-label={`История курса ${card.currency}`}>
          {card.history.map((rate) => (
            <li key={rate.id}>
              <span className="rate-history-day">{rateDayWords(rate.date, today)}</span>
              <span className="rate-history-value">{value(rate)}{"\u00a0"}{currencySign(rate.baseCurrency)}{card.per === 1 ? "" : ` за\u00a0${card.per}`}</span>
              <button className="quiet-button rate-delete" type="button" aria-label={`Удалить курс ${rate.currency} от ${formatDayYear(rate.date)}`} onClick={() => onRemove(rate)}>
                <Icon name="trash-2" size={24} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? panel : (
        <button id={addButtonId(card.currency)} className="quiet-button dir-rate-add" type="button" onClick={onAdd}>
          <span className="icon-label"><Icon name="plus" size={24} />Добавить курс {card.currency}</span>
        </button>
      )}
    </section>
  );
}

/** Почему базу не сменить — короче, для строки карточки: «уже записаны операции». */
export function baseLockWords(lockText: string): string {
  const reason = lockText.replace(/^Базовую валюту не сменить:\s*/u, "").split(/\.\s/u)[0] ?? "";
  return reason.replace(/\.$/u, "");
}

/**
 * Основная валюта — одной строкой (макет 16): знак на подложке, «Основная валюта — рубль», «В ней
 * все итоги и лимиты». Меняется, только пока бюджет пуст (домен: `setBaseCurrency`,
 * `baseCurrencyLock`): тогда в карточке «Сменить», иначе строка говорит, что её держит.
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
      // Форма закрылась: фокус — на заголовок карточки, где названа новая база.
      focusAfterRender("base-currency-title");
    } catch (cause) {
      saving.fail(ticket);
      setError(ratesErrorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return <>
    <section className="card dir-base" aria-labelledby="base-currency-title">
      <span className="icon-plate dir-plate dir-plate-sunken" aria-hidden="true">{currencySymbol(current) ?? current}</span>
      <span className="dir-copy">
        <h2 id="base-currency-title">Основная валюта — {currencyShortName(current).toLocaleLowerCase("ru-RU")}</h2>
        <small id="base-currency-lock">В ней все итоги и лимиты{lockText === null ? "" : ` · сменить нельзя: ${baseLockWords(lockText)}`}</small>
      </span>
      {lockText !== null || editing ? null : (
        <button id="base-currency-change" className="quiet-button" type="button" aria-label="Сменить основную валюту" onClick={() => { setEditing(true); focusAfterRender(`base-currency-select-${current}`); }}>Сменить</button>
      )}
    </section>
    {lockText === null && editing ? (
      <section className="card dir-base-form" aria-label="Новая основная валюта">
        <div className="field">
          <span className="dir-label" id="base-currency-label">Новая основная валюта</span>
          <CurrencyPicker id="base-currency-select" labelledBy="base-currency-label" value={choice} disabled={busy} exclude={NON_BASE_CURRENCIES} describedBy="base-currency-digits" onChange={setChoice} />
          <p className="field-hint" id="base-currency-digits">Только валюты с двумя знаками после запятой, как рубль, доллар или евро: лимиты и итоги считаются в сотых долях. Её можно сменить, пока в бюджете нет ни операций, ни планов.</p>
        </div>
        {error === null ? null : <p className="field-error" role="alert">{error}</p>}
        <div className="rate-quick-actions">
          <button className="primary-button" type="button" aria-disabled={busy || choice === current || undefined} aria-busy={busy} onClick={() => { if (choice !== current) void save(); }}>Сохранить</button>
          <button className="secondary-button" type="button" aria-disabled={busy || undefined} onClick={() => { if (busy) return; setChoice(current); setEditing(false); setError(null); focusAfterRender("base-currency-change"); }}>Отмена</button>
        </div>
      </section>
    ) : null}
  </>;
}
