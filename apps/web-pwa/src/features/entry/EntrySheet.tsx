import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { baseCurrencyOf, type BudgetState, type ExchangeRateDraft, type Transaction } from "@family-budget/domain";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import { handleDialogKeyboard } from "../data-management/dialog-accessibility";
import { useDraftGuard } from "../../navigation/draft-guard";
import { formatMoney } from "../../money";
import { editAmount, evaluateAmount, type AmountSelection, type KeypadKey } from "../operations/amount-expression";
import { Keypad, useKeypadAvailable } from "../operations/Keypad";
import { operationLabel } from "../operations/transaction-words";
import { currencySign, RateQuickSheet } from "../rates/RateQuickSheet";
import { DateChips } from "./DateChips";
import {
  draftCurrency,
  draftExponent,
  effectLine,
  foreignValue,
  foreignValueLine,
  MODE_LABELS,
  needsArrivedAmount,
  sheetTitle,
  submitCheck,
  submitLabel,
  switchMode,
  toAccountCurrency,
  type EntryDraft,
  type EntryMode,
} from "./entry-model";
import { FromToTiles, type EndpointSide } from "./FromToTiles";
import { NoteField } from "./NoteField";
import { TagChips } from "./TagChips";
import { TargetPicker, withPicked } from "./TargetPicker";

export const ENTRY_SHEET_TITLE_ID = "entry-sheet-title";
export const ENTRY_ERROR_ID = "entry-error";

/** Вид, который выбирают с «+»: возврат оформляют из правки расхода, а не здесь. */
const SWITCHABLE: readonly Exclude<EntryMode, "refund">[] = ["expense", "income", "transfer"];

export interface EntrySheetProps {
  readonly budget: BudgetState;
  readonly draft: EntryDraft;
  readonly today: string;
  /** Остатки счетов — накопленные, в валюте счёта (`calculateHoldings`). */
  readonly balances: Readonly<Record<string, number | null>>;
  /** Лист открыт «+»: вид выбирают здесь. С плитки вид уже решён касаниями. */
  readonly modeSwitch: boolean;
  /** Почему черновик не записался в прошлый раз — когда к нему вернулись. */
  readonly failure: string | null;
  /** Документ семьи задержан: запись не пойдёт, и лист говорит это, не закрываясь. */
  readonly writeRefusal: string | null;
  /** Операция, которую правят, — для «Удалить» и «Оформить возврат». */
  readonly editing: Transaction | null;
  readonly onChange: (change: (draft: EntryDraft) => EntryDraft) => void;
  /** «Оформить возврат»: черновик правки сменяется черновиком возврата. */
  readonly onRefund: (expense: Extract<Transaction, { readonly kind: "expense" }>) => void;
  /** Закрыть лист: несохранённое спросит оболочка своим вопросом. */
  readonly onClose: () => void;
  /** «Записать» / «Сохранить»: ответ — слова отказа, или `null`, если запись ушла и лист закрывается. */
  readonly onSubmit: (draft: EntryDraft) => string | null;
  readonly onDelete: (transaction: Transaction) => Promise<string | null>;
  readonly onSaveRate: (draft: ExchangeRateDraft) => Promise<string | null>;
  /** Черновик листа для реестра несохранённого: спрашивается синхронно в момент ухода. */
  readonly isDirty: () => boolean;
  readonly onDiscard: () => void;
}

/**
 * Элементы листа, в которые не должен уходить фокус и которых не должен видеть диктор, пока лист
 * открыт: всё, что рядом с ним в оболочке, — шапка, навигация, экран. Лист рисуется внутри корня
 * приложения, поэтому диалог подтверждения (портал в `body`) выключает и его самого.
 */
export function isolateSiblings(element: Pick<HTMLElement, "parentElement">): () => void {
  const parent = element.parentElement;
  if (parent === null) return () => undefined;
  const changed: { readonly node: Element; readonly inert: boolean; readonly hidden: string | null }[] = [];
  for (const node of Array.from(parent.children)) {
    if ((node as unknown) === element) continue;
    changed.push({ node, inert: node.hasAttribute("inert"), hidden: node.getAttribute("aria-hidden") });
    node.setAttribute("inert", "");
    node.setAttribute("aria-hidden", "true");
  }
  return () => {
    for (const { node, inert, hidden } of changed) {
      if (!inert) node.removeAttribute("inert");
      if (hidden === null) node.removeAttribute("aria-hidden");
      else node.setAttribute("aria-hidden", hidden);
    }
  };
}

/** Что произносит клавиатура суммы после нажатия: набранное, а у выражения — и его итог. */
function spokenAmount(text: string, minor: number | null, currency: string): string {
  if (text === "") return "Сумма пуста";
  return minor !== null && /[+−÷×]/u.test(text) ? `${text}, итого ${formatMoney(minor, currency)}` : text;
}

/**
 * Лист ввода суммы (план волны 2, §1.2) — поверх экрана, с которого его открыли.
 *
 * Сверху «Закрыть» и вид, под ними плитки «откуда → куда», сумма героем, строка «останется» и, у
 * счёта в другой валюте, его оценка; дата, комментарий, метки; клавиатура суммы и кнопка записи
 * отдельной строкой во всю ширину. Лист ловит фокус: Tab ходит внутри, Esc — «Закрыть» (с вопросом,
 * если есть что терять), а после закрытия фокус возвращается на плитку, которая его открыла.
 */
export function EntrySheet(props: EntrySheetProps) {
  const { budget, draft, today, balances, modeSwitch, failure, writeRefusal, editing, onChange, onRefund, onClose, onSubmit, onDelete, onSaveRate } = props;
  const backdropRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const keypad = useKeypadAvailable();
  const [picker, setPicker] = useState<EndpointSide | null>(null);
  const [rating, setRating] = useState(false);
  const [manualBase, setManualBase] = useState(draft.baseAmount !== "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [spoken, setSpoken] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useDraftGuard({
    label: draft.editId === null ? "операция, которую вы набирали" : "изменения в операции",
    isDirty: props.isDirty,
    discard: props.onDiscard,
  });

  // Открытие: фокус — в поле суммы, всё вокруг листа выключено; закрытие — фокус на плитку.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = backdropRef.current;
    const restore = backdrop === null ? () => undefined : isolateSiblings(backdrop);
    amountRef.current?.focus({ preventScroll: true });
    return () => {
      restore();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    const caret = caretRef.current;
    if (caret === null) return;
    caretRef.current = null;
    amountRef.current?.setSelectionRange(caret, caret);
  });

  const currency = draftCurrency(budget, draft);
  const exponent = draftExponent(budget, draft);
  const amount = evaluateAmount(draft.amount, exponent);
  const minor = amount.kind === "value" ? amount.minor : null;
  const effect = effectLine(budget, draft, today);
  const value = foreignValue(budget, draft);
  const valueLine = foreignValueLine(value);
  const baseCurrency = baseCurrencyOf(budget);
  const arrivedCurrency = toAccountCurrency(budget, draft);

  const patch = (change: (current: EntryDraft) => EntryDraft) => {
    setError(null);
    onChange(change);
  };

  const pressKey = (key: KeypadKey) => {
    const input = amountRef.current;
    const focused = input !== null && document.activeElement === input && input.selectionStart !== null && input.selectionEnd !== null;
    const selection: AmountSelection | null = focused ? { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 } : null;
    const next = editAmount(draft.amount, key, selection, exponent);
    if (next.text !== draft.amount) {
      caretRef.current = focused ? next.caret : null;
      patch((current) => ({ ...current, amount: next.text }));
    }
    const evaluated = evaluateAmount(next.text, exponent);
    setSpoken(spokenAmount(next.text, evaluated.kind === "value" ? evaluated.minor : null, currency));
  };

  const focusError = () => window.setTimeout(() => document.getElementById(ENTRY_ERROR_ID)?.focus(), 0);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const check = submitCheck(budget, draft, writeRefusal);
    if (check.kind !== "write") {
      setError(check.message);
      focusError();
      return;
    }
    const refusal = onSubmit(draft);
    if (refusal !== null) {
      setError(refusal);
      focusError();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const sheet = sheetRef.current;
    // События диалога подтверждения всплывают по дереву React и сюда: его клавиши — его.
    if (sheet === null || !(event.target instanceof Node) || !sheet.contains(event.target)) return;
    handleDialogKeyboard(event, sheet, !busy, () => {
      if (picker !== null) setPicker(null);
      else if (rating) setRating(false);
      else onClose();
    });
  };

  const remove = async () => {
    if (editing === null) return;
    setConfirmDelete(false);
    setBusy(true);
    const refusal = await onDelete(editing);
    setBusy(false);
    if (refusal !== null) {
      setError(refusal);
      focusError();
    }
  };

  const saveRate = async (rate: ExchangeRateDraft) => {
    const refusal = await onSaveRate(rate);
    if (refusal === null) {
      setRating(false);
      setError(null);
    }
    return refusal;
  };

  const sign = currencySign(currency);
  const title = sheetTitle(budget, draft);
  return (
    <div ref={backdropRef} className="sheet-backdrop entry-backdrop" role="presentation">
      <section
        ref={sheetRef}
        className="sheet entry-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={ENTRY_SHEET_TITLE_ID}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <form className="sheet-form" onSubmit={submit} noValidate aria-busy={busy}>
          <div className="sheet-head">
            <button className="sheet-close" type="button" aria-label="Закрыть" onClick={onClose}><Icon name="x" size={24} /></button>
            <h2 id={ENTRY_SHEET_TITLE_ID} className="visually-hidden">{title}</h2>
            {modeSwitch && draft.editId === null && draft.mode !== "refund" ? (
              <div className="chip-row mode-switch" role="group" aria-label="Вид операции">
                {SWITCHABLE.map((mode) => (
                  <button key={mode} className="chip" type="button" aria-pressed={draft.mode === mode} onClick={() => patch((current) => switchMode(budget, current, mode))}>
                    <span className="chip-face">{MODE_LABELS[mode]}</span>
                  </button>
                ))}
              </div>
            ) : <p className="eyebrow sheet-kind" aria-hidden="true">{draft.editId === null ? MODE_LABELS[draft.mode] : `${MODE_LABELS[draft.mode]} · правка`}</p>}
          </div>

          <div className="sheet-body">
            {failure !== null ? <div className="write-refusal" role="alert"><Icon name="circle-alert" size={24} /><p><b>Не записано:</b> {failure}</p></div> : null}
            {picker !== null ? (
              <TargetPicker
                budget={budget}
                draft={draft}
                side={picker}
                balances={balances}
                onPick={(id) => { patch((current) => withPicked(current, picker, id)); setPicker(null); }}
                onBack={() => setPicker(null)}
              />
            ) : <>
              <FromToTiles budget={budget} draft={draft} balances={balances} onPick={setPicker} />
              <div className="field entry-amount-field">
                <label htmlFor="entry-amount">Сумма, {sign}</label>
                {/* Поле настоящее: `inputmode="none"` просит не поднимать системную клавиатуру, и
                    только. Физическая клавиатура, вставка и диктор работают как в любом поле. */}
                <input
                  ref={amountRef}
                  id="entry-amount"
                  inputMode={keypad ? "none" : "decimal"}
                  autoComplete="off"
                  maxLength={24}
                  placeholder="0"
                  value={draft.amount}
                  aria-describedby={effect !== null ? "entry-effect" : undefined}
                  onChange={(event) => patch((current) => ({ ...current, amount: event.target.value }))}
                />
                {amount.kind === "value" && amount.compound ? <output htmlFor="entry-amount" className="amount-total">= <Money value={amount.minor} currency={currency} /></output> : null}
              </div>
              {effect !== null ? <p className="entry-effect" id="entry-effect">{effect}</p> : null}

              {value.kind === "missing" ? (
                <div className="entry-notice">
                  <p><Icon name="triangle-alert" size={20} />Курса {value.currency} на день операции нет: оценить её в {baseCurrency} нечем.</p>
                  <div className="chip-row">
                    <button className="secondary-button" type="button" aria-expanded={rating} onClick={() => setRating(true)}>Задать курс</button>
                    <button className="secondary-button" type="button" aria-expanded={manualBase} onClick={() => setManualBase(true)}>Сумма в {baseCurrency} вручную</button>
                  </div>
                </div>
              ) : null}
              {valueLine !== null ? (
                <div className="entry-foreign">
                  <p>{valueLine}</p>
                  {value.kind === "rate" && !manualBase ? <button className="text-button" type="button" onClick={() => setManualBase(true)}>Сумма в {baseCurrency} вручную</button> : null}
                </div>
              ) : null}
              {rating && value.kind === "missing" ? (
                <RateQuickSheet currency={value.currency} baseCurrency={baseCurrency} date={draft.occurredOn} onSave={saveRate} onCancel={() => setRating(false)} />
              ) : null}
              {manualBase && value.kind !== "base" ? (
                <div className="field">
                  <label htmlFor="entry-base-amount">Сумма в {baseCurrency}, {currencySign(baseCurrency)}</label>
                  <input id="entry-base-amount" inputMode="decimal" autoComplete="off" maxLength={24} value={draft.baseAmount} onChange={(event) => patch((current) => ({ ...current, baseAmount: event.target.value }))} />
                  <small>Сколько списали на самом деле — так и запишется, без курса.</small>
                </div>
              ) : null}
              {needsArrivedAmount(budget, draft) && arrivedCurrency !== null ? (
                <div className="field">
                  <label htmlFor="entry-to-amount">Зачислено, {currencySign(arrivedCurrency)}</label>
                  <input id="entry-to-amount" inputMode="decimal" autoComplete="off" maxLength={24} value={draft.toAmount} onChange={(event) => patch((current) => ({ ...current, toAmount: event.target.value }))} />
                </div>
              ) : null}

              <DateChips value={draft.occurredOn} today={today} onChange={(date) => patch((current) => ({ ...current, occurredOn: date }))} />
              <NoteField value={draft.note} onChange={(note) => patch((current) => ({ ...current, note }))} />
              <TagChips budget={budget} draft={draft} onChange={patch} />

              {editing !== null && draft.editId === editing.id ? (
                <div className="entry-edit-actions">
                  {editing.kind === "expense" && draft.mode === "expense" ? <button className="secondary-button" type="button" disabled={busy} onClick={() => onRefund(editing)}>Оформить возврат</button> : null}
                  <button className="secondary-button danger-button" type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>Удалить</button>
                </div>
              ) : null}
            </>}
          </div>

          <div className={`sheet-foot${keypad ? " with-keypad" : ""}`}>
            {error !== null ? <p className="field-error" id={ENTRY_ERROR_ID} role="alert" tabIndex={-1}>{error}</p> : null}
            {keypad && picker === null ? <Keypad onKey={pressKey} disabled={busy} /> : null}
            <button className="primary-button wide entry-submit" type="submit" disabled={busy} aria-busy={busy}>{submitLabel(budget, draft)}</button>
            <span className="sr-only" role="status">{spoken}</span>
          </div>
        </form>
      </section>
      {confirmDelete && editing !== null ? (
        <ConfirmDialog
          title="Удалить операцию?"
          description={`${operationLabel(editing, budget)}. Все суммы и лимиты будут пересчитаны.`}
          cancelLabel="Не удалять"
          confirmLabel="Удалить"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      ) : null}
    </div>
  );
}

/**
 * Лист, который операцию не правит: долг и взнос в цель — подволна 2e. Он говорит это словами и не
 * открывает форму, которая записала бы что-то другое; удалить такую операцию можно.
 */
export function RefusedEntrySheet({ budget, transaction, message, onClose, onDelete }: {
  readonly budget: BudgetState;
  readonly transaction: Transaction;
  readonly message: string;
  readonly onClose: () => void;
  readonly onDelete: (transaction: Transaction) => Promise<string | null>;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = backdropRef.current;
    const restore = backdrop === null ? () => undefined : isolateSiblings(backdrop);
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      restore();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div ref={backdropRef} className="sheet-backdrop entry-backdrop" role="presentation">
      <section
        ref={sheetRef}
        className="sheet entry-sheet refused"
        role="dialog"
        aria-modal="true"
        aria-labelledby={ENTRY_SHEET_TITLE_ID}
        tabIndex={-1}
        onKeyDown={(event) => {
          const sheet = sheetRef.current;
          if (sheet === null || !(event.target instanceof Node) || !sheet.contains(event.target)) return;
          handleDialogKeyboard(event, sheet, true, onClose);
        }}
      >
        <div className="sheet-head">
          <button ref={closeRef} className="sheet-close" type="button" aria-label="Закрыть" onClick={onClose}><Icon name="x" size={24} /></button>
          <h2 id={ENTRY_SHEET_TITLE_ID}>Изменить операцию</h2>
        </div>
        <div className="sheet-body">
          <p><b>{operationLabel(transaction, budget)}</b></p>
          <p className="entry-notice"><Icon name="circle-dashed" size={20} />{message} Удалить её можно.</p>
          {error !== null ? <p className="field-error" role="alert">{error}</p> : null}
          <button className="secondary-button danger-button" type="button" onClick={() => setConfirmDelete(true)}>Удалить</button>
        </div>
      </section>
      {confirmDelete ? (
        <ConfirmDialog
          title="Удалить операцию?"
          description={`${operationLabel(transaction, budget)}. Все суммы будут пересчитаны.`}
          cancelLabel="Не удалять"
          confirmLabel="Удалить"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); void onDelete(transaction).then(setError); }}
        />
      ) : null}
    </div>
  );
}
