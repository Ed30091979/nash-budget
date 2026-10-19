import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ACCOUNT_TYPES,
  accountsInOrder,
  archiveAccount,
  baseCurrencyOf,
  calculateHoldings,
  moveAccount,
  restoreAccount,
  type Account,
  type AccountType,
  type BudgetState,
  type CurrencyCode,
} from "@family-budget/domain";
import { accountIcon, type CategoryTone } from "../../category-visual";
import { BackButton } from "../../components/BackButton";
import { CurrencySelect } from "../../components/CurrencySelect";
import { Icon, type IconName } from "../../components/Icon";
import { ACCOUNT_ICON_CHOICES, IconPicker } from "../../components/IconPicker";
import { Money } from "../../components/Money";
import { ReorderControls, type ReorderDirection } from "../../components/ReorderControls";
import { TonePicker } from "../../components/TonePicker";
import { useFormDraft } from "../../navigation/draft-guard";
import { plainInputValue } from "../../plain-text";
import { currencySign } from "../rates/RateQuickSheet";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import {
  ACCOUNT_NAME_MAX_LENGTH,
  ACCOUNT_TYPE_WORDS,
  accountDraftDiffers,
  accountDraftOf,
  accountFormError,
  accountSave,
  blankAccountDraft,
  currencyLock,
  parseOpening,
  type AccountFormDraft,
  type AccountFormError,
} from "./account-model";

export const ACCOUNT_FORM_ERROR_ID = "account-form-error";

/** Где у формы поле: туда уходит фокус с отказом. */
const FIELD_IDS: Readonly<Record<AccountFormError["field"], string>> = {
  name: "account-name",
  type: "account-type-current",
  currency: "account-currency",
  opening: "account-opening",
  icon: "account-icon",
  tone: "account-tone",
  includeInTotal: "account-include",
  form: ACCOUNT_FORM_ERROR_ID,
};

export interface AccountFormViewProps {
  readonly budget: BudgetState;
  /** Счёт, открытый для правки; `null` — новый. */
  readonly account: Account | null;
  readonly draft: AccountFormDraft;
  readonly pristine: AccountFormDraft;
  readonly error: AccountFormError | null;
  readonly busy: boolean;
  readonly onPatch: (patch: Partial<AccountFormDraft>) => void;
  readonly onSubmit: () => void;
}

/**
 * Форма счёта (план волны 2, §1.5) без состояния: что набрано и какой отказ — приходит сверху.
 * Валюта заперта, пока на счёт что-то ссылается; начальный остаток предупреждает, что двигает
 * остатки в прошлом; иконка и тон — радиогруппы со словами; «Учитывать в итоге» — отметка.
 */
export function AccountFormView({ budget, account, draft, pristine, error, busy, onPatch, onSubmit }: AccountFormViewProps) {
  const id = useId();
  const lock = currencyLock(budget, account);
  const base = baseCurrencyOf(budget);
  const own = useMemo(() => [...new Set(budget.accounts.map((item) => item.currency))], [budget.accounts]);
  const opening = parseOpening(draft);
  const saved = parseOpening(pristine);
  const shift = account !== null && opening.kind === "amount" && saved.kind === "amount" ? opening.minor - saved.minor : 0;
  const fieldError = (field: AccountFormError["field"]) => (error?.field === field ? error.message : null);
  const described = (field: AccountFormError["field"], hint?: string) => {
    const ids = [hint, fieldError(field) === null ? undefined : `${FIELD_IDS[field]}-error`].filter(Boolean).join(" ");
    return ids === "" ? undefined : ids;
  };
  const fallbackIcon: IconName = accountIcon({ type: draft.type, currency: draft.currency });
  const fallbackTone: CategoryTone = "neutral";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form className="manage-form" onSubmit={submit} noValidate aria-describedby={error?.field === "form" ? ACCOUNT_FORM_ERROR_ID : undefined}>
      <div className="field">
        <label htmlFor="account-name">Название</label>
        <input
          id="account-name"
          dir="auto"
          autoComplete="off"
          maxLength={ACCOUNT_NAME_MAX_LENGTH}
          placeholder="Например, Карта Сбера"
          value={draft.name}
          disabled={busy}
          aria-invalid={fieldError("name") === null ? undefined : true}
          aria-describedby={described("name")}
          onChange={(event) => onPatch({ name: plainInputValue(event.currentTarget) })}
        />
        <FieldError id="account-name" message={fieldError("name")} />
      </div>

      <fieldset className="option-grid" disabled={busy}>
        <legend>Вид счёта</legend>
        {ACCOUNT_TYPES.map((type: AccountType) => (
          <label key={type}>
            <input id={`account-type-${type}`} type="radio" name={`${id}-type`} value={type} checked={draft.type === type} onChange={() => onPatch({ type })} />
            <span>{ACCOUNT_TYPE_WORDS[type]}</span>
          </label>
        ))}
      </fieldset>

      <div className="field">
        <label htmlFor="account-currency">Валюта</label>
        <CurrencySelect
          id="account-currency"
          value={draft.currency}
          preferred={[base, ...own]}
          disabled={busy || lock !== null}
          describedBy={described("currency", lock === null ? undefined : "account-currency-lock")}
          onChange={(currency: CurrencyCode) => onPatch({ currency })}
        />
        {lock === null ? null : <p className="field-hint" id="account-currency-lock">{lock}</p>}
        {lock === null && draft.currency !== base ? (
          <p className="field-hint" id="account-currency-foreign">Счёт в {draft.currency}: каждая операция по нему запишется и в {base} — по курсу дня или суммой, которую вы назовёте. Цели и платежи плана на нём не ведутся.</p>
        ) : null}
        <FieldError id="account-currency" message={fieldError("currency")} />
      </div>

      <div className="field">
        <label htmlFor="account-opening">Начальный остаток, {currencySign(draft.currency)}</label>
        <input
          id="account-opening"
          inputMode="decimal"
          autoComplete="off"
          maxLength={24}
          placeholder="0"
          value={draft.opening}
          disabled={busy}
          aria-invalid={fieldError("opening") === null ? undefined : true}
          aria-describedby={described("opening", "account-opening-hint")}
          onChange={(event) => onPatch({ opening: event.target.value })}
        />
        <label className="check-row" htmlFor="account-negative">
          <input id="account-negative" type="checkbox" checked={draft.negative} disabled={busy} onChange={(event) => onPatch({ negative: event.target.checked })} />
          <span>Остаток ниже нуля — долг по карте</span>
        </label>
        <p className="field-hint" id="account-opening-hint">
          {account === null
            ? "Сколько на счёте сейчас: с этой суммы начнётся его остаток."
            : "Начальный остаток меняет остатки в прошлом: остаток счёта на каждый прошлый день сдвинется на ту же сумму."}
        </p>
        {shift !== 0 ? (
          <p className="entry-notice manage-notice" role="status">
            <span><Icon name="triangle-alert" size={20} /></span>
            <span>Остатки «<bdi dir="auto">{account?.name}</bdi>» за все прошлые дни сдвинутся на <Money value={shift} currency={draft.currency} sign={shift > 0 ? "+" : undefined} />.</span>
          </p>
        ) : null}
        <FieldError id="account-opening" message={fieldError("opening")} />
      </div>

      <div id="account-tone">
        <TonePicker legend="Цвет на «Обзоре»" value={draft.tone} fallback={fallbackTone} disabled={busy} onChange={(tone) => onPatch({ tone })} />
      </div>
      <div id="account-icon">
        <IconPicker legend="Иконка" icons={ACCOUNT_ICON_CHOICES} value={draft.icon} fallback={fallbackIcon} tone={draft.tone ?? fallbackTone} disabled={busy} onChange={(icon) => onPatch({ icon })} />
      </div>

      <label className="check-row" htmlFor="account-include">
        <input id="account-include" type="checkbox" checked={draft.includeInTotal} disabled={busy} onChange={(event) => onPatch({ includeInTotal: event.target.checked })} />
        <span>Учитывать в итоге «Всего на счетах»</span>
      </label>

      {error?.field === "form" ? <p className="field-error" id={ACCOUNT_FORM_ERROR_ID} role="alert" tabIndex={-1}>{error.message}</p> : null}
      <button className="primary-button wide" type="submit" disabled={busy} aria-busy={busy}>{account === null ? "Завести счёт" : "Сохранить"}</button>
    </form>
  );
}

function FieldError({ id, message }: { readonly id: string; readonly message: string | null }) {
  if (message === null) return null;
  return <p className="field-error" id={`${id}-error`} role="alert">{message}</p>;
}

export interface AccountScreenProps {
  readonly budget: BudgetState;
  readonly today: string;
  /** Счёт из адреса; `null` — «Новый счёт». */
  readonly accountId: string | null;
  readonly write: BudgetWriter;
  readonly onBack: () => void;
  /** Записано: назад к списку, со словами о сделанном. */
  readonly onDone: (message: string) => void;
}

/**
 * «Новый счёт» и правка счёта. Черновик — в реестре (слой экрана): уход с набранным спрашивает
 * диалог приложения; отправленный — «записывается» до первого `await`, отказ записи оставляет его
 * на месте с отказом у поля. Порядок и архив — отдельные записи сразу, черновик они не трогают.
 */
export function AccountScreen({ budget, today, accountId, write, onBack, onDone }: AccountScreenProps) {
  const account = accountId === null ? null : budget.accounts.find((item) => item.id.toLowerCase() === accountId.toLowerCase()) ?? null;
  // Снимок при открытии — не пересчитывается от бюджета: правка с другого устройства не делает
  // форму «грязной» и не стирает набранное.
  const [pristine] = useState<AccountFormDraft>(() => (account === null ? blankAccountDraft(budget) : accountDraftOf(account)));
  const [draft, setDraft] = useState<AccountFormDraft>(pristine);
  const [error, setError] = useState<AccountFormError | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const dirty = accountDraftDiffers(draft, pristine);
  const saving = useFormDraft({
    label: account === null ? "новый счёт" : `правка счёта «${account.name}»`,
    dirty,
    discard: () => setDraft(pristine),
  });
  const focusError = useRef<string | null>(null);
  useEffect(() => {
    if (focusError.current === null) return;
    document.getElementById(focusError.current)?.focus();
    focusError.current = null;
  });

  if (accountId !== null && account === null) return null;

  const fail = (next: AccountFormError) => {
    setError(next);
    focusError.current = FIELD_IDS[next.field];
  };
  const submit = () => {
    if (busy) return;
    const plan = accountSave(draft, account === null ? null : { account, pristine });
    if (plan.kind === "error") {
      fail(plan.error);
      return;
    }
    const ticket = saving.begin();
    setBusy(true);
    setError(null);
    const name = draft.name.trim();
    write.run(plan.change).then(() => {
      saving.succeed(ticket);
      setBusy(false);
      onDone(account === null ? `Счёт «${name}» заведён.` : `Счёт «${name}» сохранён.`);
    }, (cause: unknown) => {
      saving.fail(ticket);
      setBusy(false);
      fail(accountFormError(cause));
    });
  };

  const active = accountsInOrder(budget.accounts.filter((item) => item.active));
  const position = account === null ? 0 : active.findIndex((item) => item.id === account.id) + 1;
  const sideWrite = async (change: (state: BudgetState) => BudgetState, done: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await write.run(change);
      setNotice(done);
    } catch (cause) {
      fail(accountFormError(cause));
    } finally {
      setBusy(false);
    }
  };
  const move = (direction: ReorderDirection) => account === null ? undefined : sideWrite(
    (state) => moveAccount(state, account.id, direction),
    `Теперь «${account.name}» — ${direction === "up" ? position - 1 : position + 1}-й из ${active.length}.`,
  );
  const balance = account === null ? null : calculateHoldings(budget, today).accountBalancesMinor[account.id] ?? null;

  return (
    <div className="manage-screen account-screen">
      <div className="planning-toolbar"><BackButton label="К счетам" onClick={onBack} /></div>
      <header className="manage-head">
        <h1>{account === null ? "Новый счёт" : <bdi dir="auto">{account.name}</bdi>}</h1>
        {account === null ? <p>Счёт — место, где лежат деньги: карта, наличные, накопления. Его остаток виден на «Обзоре» плиткой.</p> : (
          <p>
            {ACCOUNT_TYPE_WORDS[account.type]} · {account.currency}
            {balance === null ? null : <> · остаток <Money value={balance} currency={account.currency} /></>}
            {account.active ? null : " · в архиве"}
          </p>
        )}
      </header>
      <p className="manage-status" role="status">{notice}</p>
      <AccountFormView
        budget={budget}
        account={account}
        draft={draft}
        pristine={pristine}
        error={error}
        busy={busy}
        onPatch={(patch) => {
          setDraft((current) => ({ ...current, ...patch }));
          if (error !== null && error.field !== "form") setError(null);
        }}
        onSubmit={submit}
      />

      {account === null ? null : <>
        {account.active ? (
          <section className="manage-group" aria-labelledby="account-order-title">
            <h2 id="account-order-title" className="list-kicker">Место в списке</h2>
            <p className="field-hint">{position}-й из {active.length} — в этом порядке счета стоят на «Обзоре» и в выборе счёта.</p>
            <ReorderControls id={`account-${account.id}`} name={account.name} position={position} count={active.length} busy={busy} onMove={move} />
          </section>
        ) : null}
        <section className="manage-group" aria-labelledby="account-archive-title">
          <h2 id="account-archive-title" className="list-kicker">Архив</h2>
          {account.active ? <>
            <p className="field-hint">Счёт в архиве не предлагается для новых операций и уходит с «Обзора». Его остаток, операции и история остаются в итогах и отчётах; вернуть его можно в любой момент. Удаления нет: прошлые месяцы ссылаются на счёт.</p>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void sideWrite((state) => archiveAccount(state, account.id), `«${account.name}» в архиве. Остаток и история на месте.`)}>
              <span className="icon-label"><Icon name="archive" size={20} />Убрать в архив</span>
            </button>
          </> : <>
            <p className="field-hint">Счёт в архиве: для новых операций он не предлагается. Его остаток и история — в итогах и отчётах.</p>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void sideWrite((state) => restoreAccount(state, account.id), `«${account.name}» снова среди активных.`)}>
              Вернуть из архива
            </button>
          </>}
        </section>
      </>}
    </div>
  );
}
