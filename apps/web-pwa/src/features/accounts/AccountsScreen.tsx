import { useMemo, useState } from "react";
import { moveAccount, restoreAccount, type BudgetState, type CurrencyCode } from "@family-budget/domain";
import { TitleBar, TitleBarAction } from "../../components/TitleBar";
import { useFocusAfterRender } from "../../components/focus-after-render";
import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import { ReorderList, stepsBetween, type ReorderDirection } from "../../components/ReorderControls";
import { softHyphenate } from "../../hyphenation";
import { formatMoney } from "../../money";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { accountFormError, accountsList, accountsTotal, totalRateWords, type AccountRow } from "./account-model";

export interface AccountsScreenProps {
  readonly budget: BudgetState;
  readonly today: string;
  readonly write: BudgetWriter;
  readonly onBack: () => void;
  readonly onOpen: (accountId: string) => void;
  readonly onCreate: () => void;
  /**
   * Экран под листом счёта (`#/more/accounts/<id>`): та же картинка под затемнением, выключенная
   * вместе со всем вокруг листа, — без строки состояния: говорит лист.
   */
  readonly background?: boolean;
}

/**
 * Доступное имя строки: имя, остаток в валюте счёта (и в базовой валюте бюджета `base` — у чужой
 * валюты), вид и что сделает касание.
 */
export function accountRowLabel(row: AccountRow, base: CurrencyCode): string {
  const balance = row.balanceMinor === null ? "остаток не представим" : formatMoney(row.balanceMinor, row.account.currency);
  const inBase = row.baseMinor === null ? "" : ` (≈ ${formatMoney(row.baseMinor, base)})`;
  // Строчная — только первая буква вида счёта: код валюты пишется и читается прописными («USD»).
  const meta = row.meta.charAt(0).toLocaleLowerCase("ru-RU") + row.meta.slice(1);
  return `${row.account.name}: ${balance}${inBase}, ${meta}. Изменить`;
}

/** Подложка глифа строки: тон счёта, если семья его выбрала (D-036), иначе графит, как плитка «Обзора». */
export function AccountPlate({ row }: { readonly row: AccountRow }) {
  return (
    <span className={row.tone === null ? "icon-plate dir-plate account-plate" : `icon-plate dir-plate tone-${row.tone}`} aria-hidden="true">
      <Icon name={row.icon} size={24} />
    </span>
  );
}

const accountRowId = (accountId: string) => `account-row-${accountId}`;

/**
 * «Счета» (дизайн 5.0, макет 11): «‹ Ещё · Счета · +», «Всего на счетах» в базовой валюте и курс, по
 * которому оценены чужие валюты, белая карточка строк — подложка, имя, «вид · валюта», остаток в
 * валюте счёта и «≈ N ₽» у чужой, — ниже «Изменить порядок» и архив с «Вернуть». Строка открывает
 * лист счёта. Порядок меняется отдельным режимом (`ReorderList`): стрелки у каждой строки и ручка
 * для мыши, а не «Выше / Ниже» у строк списка. Удаления нет: архивный счёт остаётся в каждом
 * остатке и итоге, в которых был.
 */
export function AccountsScreen({ budget, today, write, onBack, onOpen, onCreate, background = false }: AccountsScreenProps) {
  const list = useMemo(() => accountsList(budget, today), [budget, today]);
  const total = useMemo(() => accountsTotal(budget, today), [budget, today]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const reordering = ordering && list.active.length > 1;

  // Возвращённый счёт уходит из архива в активные: фокус — на его строку (ревью 2c, MEDIUM-3).
  const focusAfterRender = useFocusAfterRender();
  const run = async (change: (state: BudgetState) => BudgetState, done: string, then?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await write.run(change);
      setStatus(done);
      if (then !== undefined) focusAfterRender(then);
    } catch (cause) {
      setError(accountFormError(cause).message);
    } finally {
      setBusy(false);
    }
  };
  const placeWords = (name: string, place: number) => `«${name}» — теперь ${place}-й из ${list.active.length}.`;
  const move = (id: string, direction: ReorderDirection) => {
    const row = list.active.find((item) => item.account.id === id);
    if (row === undefined) return undefined;
    return run((state) => moveAccount(state, id, direction), placeWords(row.account.name, direction === "up" ? row.position - 1 : row.position + 1));
  };
  // Перетаскивание — те же шаги соседей, одной записью.
  const moveTo = (id: string, to: number) => {
    const row = list.active.find((item) => item.account.id === id);
    if (row === undefined) return undefined;
    const steps = stepsBetween(row.position - 1, to);
    return run((state) => steps.reduce((next, step) => moveAccount(next, id, step), state), placeWords(row.account.name, to + 1));
  };
  const toggleOrder = () => {
    if (busy) return;
    setOrdering(!reordering);
    setError(null);
    setStatus(reordering ? "" : "Стрелки меняют место счёта на «Обзоре» и в выборе.");
  };

  return (
    <div className="manage-screen dir-screen accounts-screen">
      <TitleBar back={{ label: "Ещё", onClick: onBack }} title="Счета" action={<TitleBarAction icon="plus" label="Новый счёт" onClick={onCreate} />} />
      <section className="dir-total" aria-label="Всего на счетах">
        <p className="dir-total-label">Всего на счетах</p>
        <p className="dir-total-sum"><Money value={total.totalInBaseMinor} currency={total.base} breakDigits /></p>
        {total.rates.length === 0 ? null : <p className="dir-total-note">{total.rates.map(totalRateWords).join("; ")}</p>}
        {total.unvalued.length === 0 ? null : (
          <p className="dir-total-note dir-warn">
            <Icon name="triangle-alert" size={20} />
            <span>В итог не вошли: {total.unvalued.map((item, index) => <span key={`${item.name}-${index}`}>{index > 0 ? "; " : ""}«<bdi dir="auto">{item.name}</bdi>» — нет курса {item.currency}</span>)}.</span>
          </p>
        )}
      </section>
      {background ? null : <p className="manage-status" role="status">{status}</p>}
      {background || error === null ? null : <p className="field-error" role="alert">{error}</p>}

      {list.active.length === 0 ? <p className="field-hint dir-hint">Активных счетов нет: без счёта операцию записать некуда. Заведите счёт «+» или верните его из архива.</p> : reordering ? (
        <ReorderList
          idPrefix="account"
          label="Порядок счетов"
          items={list.active.map((row) => ({ id: row.account.id, name: row.account.name, plate: <AccountPlate row={row} />, caption: row.meta }))}
          busy={busy}
          onMove={move}
          onMoveTo={moveTo}
        />
      ) : (
        <ul className="card dir-card" aria-label="Активные счета">
          {list.active.map((row) => <li key={row.account.id}><AccountRowButton row={row} base={total.base} onOpen={() => onOpen(row.account.id)} /></li>)}
        </ul>
      )}
      {list.active.length > 1 ? (
        <button className="quiet-button dir-mode" type="button" aria-disabled={busy || undefined} onClick={toggleOrder}>
          <span className="icon-label"><Icon name={reordering ? "check" : "arrow-up-down"} size={24} />{reordering ? "Готово" : "Изменить порядок"}</span>
        </button>
      ) : null}

      {list.archived.length === 0 || reordering ? null : (
        <section className="dir-group" aria-labelledby="accounts-archived-title">
          <h2 id="accounts-archived-title" className="dir-kicker">В архиве</h2>
          <ul className="card dir-card">
            {list.archived.map((row) => (
              <li key={row.account.id} className="dir-archived">
                <button id={accountRowId(row.account.id)} className="dir-row" type="button" aria-label={accountRowLabel(row, total.base)} onClick={() => onOpen(row.account.id)}>
                  <AccountPlate row={row} />
                  <span className="dir-copy" aria-hidden="true"><strong><bdi dir="auto">{softHyphenate(row.account.name)}</bdi></strong><small>{row.meta}</small></span>
                </button>
                <button className="quiet-button dir-restore" type="button" aria-disabled={busy || undefined} aria-label={`Вернуть «${row.account.name}» из архива`} onClick={() => void run((state) => restoreAccount(state, row.account.id), `«${row.account.name}» снова среди активных.`, accountRowId(row.account.id))}>
                  Вернуть
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AccountRowButton({ row, base, onOpen }: { readonly row: AccountRow; readonly base: CurrencyCode; readonly onOpen: () => void }) {
  return (
    <button id={accountRowId(row.account.id)} className="dir-row" type="button" aria-label={accountRowLabel(row, base)} onClick={onOpen}>
      <AccountPlate row={row} />
      <span className="dir-copy" aria-hidden="true">
        <strong><bdi dir="auto">{softHyphenate(row.account.name)}</bdi></strong>
        <small>{row.meta}</small>
      </span>
      <span className="dir-amount" aria-hidden="true">
        <b>{row.balanceMinor === null ? "—" : <Money value={row.balanceMinor} currency={row.account.currency} />}</b>
        {row.baseMinor === null ? null : <small>≈ <Money value={row.baseMinor} currency={base} /></small>}
      </span>
    </button>
  );
}
