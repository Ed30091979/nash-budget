import { useEffect, useMemo, useRef, useState } from "react";
import {
  ACCOUNT_TYPES,
  archiveAccount,
  baseCurrencyOf,
  restoreAccount,
  type Account,
  type AccountType,
  type BudgetState,
  type CurrencyCode,
} from "@family-budget/domain";
import { accountIcon, type CategoryTone } from "../../category-visual";
import { CurrencyPicker } from "../../components/CurrencyPicker";
import { FormSheet } from "../../components/FormSheet";
import { useFocusAfterRender } from "../../components/focus-after-render";
import { Icon, type IconName } from "../../components/Icon";
import { ACCOUNT_ICON_CHOICES, IconPicker } from "../../components/IconPicker";
import { Money } from "../../components/Money";
import { OptionCards } from "../../components/OptionCards";
import { TileSquare } from "../../components/tiles/Tile";
import { TonePicker } from "../../components/TonePicker";
import { softHyphenate } from "../../hyphenation";
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
  accountOffset,
  accountSave,
  blankAccountDraft,
  currencyLock,
  accountEstimate,
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

/** Вид счёта карточкой 2×2 (макет 12): глиф — тот же, что у плитки счёта этого вида. */
const ACCOUNT_TYPE_ICONS: Readonly<Record<AccountType, IconName>> = {
  current: "credit-card",
  cash: "banknote",
  savings: "piggy-bank",
  reserve: "shield",
};

export interface AccountFormViewProps {
  readonly budget: BudgetState;
  readonly today: string;
  /** Счёт, открытый для правки; `null` — новый. */
  readonly account: Account | null;
  readonly draft: AccountFormDraft;
  readonly pristine: AccountFormDraft;
  readonly error: AccountFormError | null;
  readonly busy: boolean;
  readonly onPatch: (patch: Partial<AccountFormDraft>) => void;
}

/**
 * Разделы листа счёта (дизайн 5.0, макет 12) без состояния: что набрано и какой отказ — приходит
 * сверху. Образец — квадрат счёта, имя и остаток с пересчётом; дальше название, вид карточками 2×2,
 * валюта чипами (`CurrencyPicker`), «Сколько сейчас на счёте» с пересчётом в базовую валюту, цвет,
 * значок и переключатель «Считать во «Всего на счетах»». Правила 2c на месте: валюта заперта, пока на
 * счёт ссылаются, и говорит почему (D-032); правка остатка называет сдвиг прошлых дней суммой.
 */
export function AccountFormView({ budget, today, account, draft, pristine, error, busy, onPatch }: AccountFormViewProps) {
  const lock = currencyLock(budget, account);
  const base = baseCurrencyOf(budget);
  const own = useMemo(() => [...new Set(budget.accounts.map((item) => item.currency))], [budget.accounts]);
  // У записанного счёта поле — остаток сегодня: предел суммы проверяется у начального остатка при записи.
  const limit = account === null ? undefined : null;
  const opening = parseOpening(draft, limit);
  const saved = parseOpening(pristine, limit);
  const shift = account !== null && opening.kind === "amount" && saved.kind === "amount" ? opening.minor - saved.minor : 0;
  const fieldError = (field: AccountFormError["field"]) => (error?.field === field ? error.message : null);
  const described = (field: AccountFormError["field"], ...hints: (string | undefined)[]) => {
    const ids = [...hints, fieldError(field) === null ? undefined : `${FIELD_IDS[field]}-error`].filter(Boolean).join(" ");
    return ids === "" ? undefined : ids;
  };
  const fallbackIcon: IconName = accountIcon({ type: draft.type, currency: draft.currency }, base);
  const fallbackTone: CategoryTone = "neutral";
  const sign = currencySign(draft.currency);
  const foreign = draft.currency !== base;
  const estimate = opening.kind === "amount" ? accountEstimate(budget, draft.currency, opening.minor, today) : null;
  const name = draft.name.trim() === "" ? (account === null ? "Новый счёт" : account.name) : draft.name;
  return (
    <>
      {/* Образец — эхо полей для глаза: имя, остаток и пересчёт названы полями ниже. */}
      <div className="card dir-preview" aria-hidden="true">
        <TileSquare icon={draft.icon ?? fallbackIcon} tone={draft.tone ?? "account"} />
        <span className="dir-preview-copy">
          <span className="dir-preview-name"><bdi dir="auto">{softHyphenate(name)}</bdi></span>
          <span className="dir-preview-note">
            {opening.kind === "amount" ? <Money value={opening.minor} currency={draft.currency} /> : "—"}
            {estimate === null ? null : <> ≈ <Money value={estimate.inBaseMinor} currency={base} /></>}
          </span>
        </span>
      </div>

      <div className="field dir-field">
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

      <OptionCards
        legend="Вид"
        options={ACCOUNT_TYPES.map((type: AccountType) => ({ value: type, label: ACCOUNT_TYPE_WORDS[type], icon: ACCOUNT_TYPE_ICONS[type], id: `account-type-${type}` }))}
        value={draft.type}
        disabled={busy}
        describedBy={described("type")}
        onChange={(type) => onPatch({ type })}
      />
      <FieldError id={FIELD_IDS.type} message={fieldError("type")} />

      <div className="dir-field">
        <p className="dir-label" id="account-currency-label">Валюта</p>
        <CurrencyPicker
          id="account-currency"
          labelledBy="account-currency-label"
          value={draft.currency}
          preferred={[base, ...own]}
          disabled={busy}
          locked={lock !== null}
          describedBy={described("currency", lock === null ? (foreign ? "account-currency-foreign" : undefined) : "account-currency-lock")}
          onChange={(currency: CurrencyCode) => onPatch({ currency })}
        />
        {lock === null ? null : <p className="field-hint" id="account-currency-lock">{lock}</p>}
        {lock === null && foreign ? (
          <p className="field-hint" id="account-currency-foreign">Счёт в {draft.currency}: операции по нему запишутся и в {base} по курсу дня, а цели и платежи плана на нём не ведутся.</p>
        ) : null}
        <FieldError id="account-currency" message={fieldError("currency")} />
      </div>

      <div className="field dir-field">
        <label htmlFor="account-opening">Сколько сейчас на счёте<span className="sr-only">, {sign}</span></label>
        <span className="dir-money-field">
          <input
            id="account-opening"
            inputMode="decimal"
            autoComplete="off"
            maxLength={24}
            placeholder="0"
            value={draft.opening}
            disabled={busy}
            aria-invalid={fieldError("opening") === null ? undefined : true}
            aria-describedby={described("opening", foreign ? "account-opening-estimate" : undefined, account === null ? undefined : "account-opening-hint")}
            onChange={(event) => onPatch({ opening: event.target.value })}
          />
          <span className="dir-money-sign" aria-hidden="true">{sign}</span>
        </span>
        {foreign ? (
          <p className="field-hint" id="account-opening-estimate">
            {estimate?.words ?? `Курса ${draft.currency} на сегодня нет: «Всего на счетах» учтёт счёт, когда курс будет задан в «Курсах валют».`}
          </p>
        ) : null}
        <label className="check-row" htmlFor="account-negative">
          <input id="account-negative" type="checkbox" checked={draft.negative} disabled={busy} onChange={(event) => onPatch({ negative: event.target.checked })} />
          <span>Остаток ниже нуля — долг по карте</span>
        </label>
        {account === null ? null : (
          <p className="field-hint" id="account-opening-hint">Остаток считается от начального: правка сдвинет и остатки всех прошлых дней.</p>
        )}
        {shift !== 0 ? (
          <p className="entry-notice manage-notice" role="status">
            <span><Icon name="triangle-alert" size={20} /></span>
            <span>Остатки «<bdi dir="auto">{account?.name}</bdi>» за все прошлые дни сдвинутся на <Money value={shift} currency={draft.currency} sign={shift > 0 ? "+" : undefined} />.</span>
          </p>
        ) : null}
        <FieldError id="account-opening" message={fieldError("opening")} />
      </div>

      <div id="account-tone" className="dir-field">
        <TonePicker legend="Цвет" value={draft.tone} fallback={fallbackTone} disabled={busy} onChange={(tone) => onPatch({ tone })} />
      </div>
      <div id="account-icon" className="dir-field">
        <IconPicker legend="Значок" icons={ACCOUNT_ICON_CHOICES} value={draft.icon} fallback={fallbackIcon} tone={draft.tone ?? fallbackTone} disabled={busy} onChange={(icon) => onPatch({ icon })} />
      </div>

      <label className="check-row dir-toggle" htmlFor="account-include">
        <span>Считать во «Всего на счетах»</span>
        <input id="account-include" type="checkbox" role="switch" checked={draft.includeInTotal} disabled={busy} onChange={(event) => onPatch({ includeInTotal: event.target.checked })} />
      </label>
    </>
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
  /** Вид нового счёта из адреса (`?type=savings` — вопрос первого запуска); у правки не читается. */
  readonly initialType?: AccountType;
  readonly write: BudgetWriter;
  /**
   * Крестик и Esc: к родителю — списку счетов, а из вопроса первого запуска — на «Обзор». Набранное
   * спрашивает реестр черновиков, как при любом уходе с экрана.
   */
  readonly onBack: () => void;
  /** Записано: назад, со словами о сделанном. */
  readonly onDone: (message: string) => void;
}

const ACCOUNT_ARCHIVE_ID = "account-archive";
const ACCOUNT_RESTORE_ID = "account-restore";

/**
 * Лист «Новый счёт» и правка счёта (дизайн 5.0, макет 12) — маршрут `#/more/accounts/<id>` поверх
 * списка счетов. Черновик — в реестре (слой экрана): уход с набранным — крестиком, Esc или системным
 * «Назад» — спрашивает диалог приложения; отправленный — «записывается» до первого `await`, отказ
 * записи оставляет его на месте с отказом у поля. Архив — отдельная запись сразу, черновик он не
 * трогает; порядок счетов меняется в списке, режимом «Изменить порядок».
 */
export function AccountScreen({ budget, today, accountId, initialType, write, onBack, onDone }: AccountScreenProps) {
  const account = accountId === null ? null : budget.accounts.find((item) => item.id.toLowerCase() === accountId.toLowerCase()) ?? null;
  // Снимок при открытии — не пересчитывается от бюджета: правка с другого устройства не делает
  // форму «грязной» и не стирает набранное. Движения к сегодняшнему дню — того же снимка: по ним
  // поле показывает остаток и проверяется до записи, а сама запись пересчитывает их (ревью R3, LOW-2).
  const [offset] = useState(() => (account === null ? 0 : accountOffset(budget, account, today)));
  const [pristine] = useState<AccountFormDraft>(() => (account === null
    ? { ...blankAccountDraft(budget), ...(initialType === undefined ? {} : { type: initialType }) }
    : accountDraftOf(account, offset)));
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
  // После архива и возврата — на кнопку, вставшую на место нажатой (ревью 2c, MEDIUM-3).
  const focusAfterRender = useFocusAfterRender();
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
    const plan = accountSave(draft, account === null ? null : { account, pristine, offsetMinor: offset, today });
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
  const sideWrite = async (change: (state: BudgetState) => BudgetState, done: string, then?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await write.run(change);
      setNotice(done);
      if (then !== undefined) focusAfterRender(then);
    } catch (cause) {
      fail(accountFormError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormSheet
      id="account-sheet"
      titleLevel={1}
      title={account === null ? "Новый счёт" : "Счёт"}
      onClose={onBack}
      busy={busy}
      onSubmit={submit}
      describedBy={error?.field === "form" ? ACCOUNT_FORM_ERROR_ID : undefined}
      footer={<>
        {error?.field === "form" ? <p className="field-error" id={ACCOUNT_FORM_ERROR_ID} role="alert" tabIndex={-1}>{error.message}</p> : null}
        <button className="primary-button wide dir-save" type="submit" disabled={busy} aria-busy={busy}>Сохранить</button>
      </>}
    >
      <AccountFormView
        budget={budget}
        today={today}
        account={account}
        draft={draft}
        pristine={pristine}
        error={error}
        busy={busy}
        onPatch={(patch) => {
          setDraft((current) => ({ ...current, ...patch }));
          if (error !== null && error.field !== "form") setError(null);
        }}
      />
      {account === null ? null : (
        <section className="dir-archive" aria-label="Архив">
          {account.active ? <>
            <button id={ACCOUNT_ARCHIVE_ID} className="quiet-button dir-danger" type="button" aria-disabled={busy || undefined} onClick={() => void sideWrite((state) => archiveAccount(state, account.id), `«${account.name}» в архиве. Остаток и история на месте.`, ACCOUNT_RESTORE_ID)}>
              <span className="icon-label"><Icon name="archive" size={24} />Убрать в архив</span>
            </button>
            <p className="field-hint">Счёт уйдёт с «Обзора» и из выбора, а остаток и история останутся в итогах. Удаления нет: прошлые месяцы ссылаются на счёт.</p>
          </> : <>
            <button id={ACCOUNT_RESTORE_ID} className="secondary-button" type="button" aria-disabled={busy || undefined} onClick={() => void sideWrite((state) => restoreAccount(state, account.id), `«${account.name}» снова среди активных.`, ACCOUNT_ARCHIVE_ID)}>
              Вернуть из архива
            </button>
            <p className="field-hint">Счёт в архиве: для новых операций он не предлагается. Остаток и история — в итогах и отчётах.</p>
          </>}
        </section>
      )}
      <p className="sheet-status" role="status">{notice}</p>
    </FormSheet>
  );
}
