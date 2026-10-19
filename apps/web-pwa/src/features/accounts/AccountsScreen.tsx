import { useMemo, useState } from "react";
import { moveAccount, restoreAccount, type BudgetState } from "@family-budget/domain";
import { TitleBar, TitleBarAction } from "../../components/TitleBar";
import { useFocusAfterRender } from "../../components/focus-after-render";
import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import { ReorderControls, type ReorderDirection } from "../../components/ReorderControls";
import { formatMoney } from "../../money";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { accountFormError, accountsList, type AccountRow } from "./account-model";

export interface AccountsScreenProps {
  readonly budget: BudgetState;
  readonly today: string;
  readonly write: BudgetWriter;
  readonly onBack: () => void;
  readonly onOpen: (accountId: string) => void;
  readonly onCreate: () => void;
}

/** Доступное имя строки: имя, остаток в валюте счёта, вид и что сделает касание. */
export function accountRowLabel(row: AccountRow): string {
  const balance = row.balanceMinor === null ? "остаток не представим" : formatMoney(row.balanceMinor, row.account.currency);
  // Строчная — только первая буква вида счёта: код валюты пишется и читается прописными («USD»).
  const meta = row.meta.charAt(0).toLocaleLowerCase("ru-RU") + row.meta.slice(1);
  return `${row.account.name}: ${balance}, ${meta}. Изменить`;
}

/**
 * «Счета» (план волны 2, §1.5): список с остатками в валюте каждого счёта — на сегодня, как плитки
 * «Обзора», — порядок кнопками «Выше / Ниже» и архив ниже. Строка открывает счёт для правки;
 * «Вернуть» возвращает архивный в списки выбора. Удаления нет: архивный счёт остаётся в каждом
 * остатке и итоге, в которых был.
 */
export function AccountsScreen({ budget, today, write, onBack, onOpen, onCreate }: AccountsScreenProps) {
  const list = useMemo(() => accountsList(budget, today), [budget, today]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  const move = (row: AccountRow, direction: ReorderDirection) => {
    const place = direction === "up" ? row.position - 1 : row.position + 1;
    return run((state) => moveAccount(state, row.account.id, direction), `«${row.account.name}» — теперь ${place}-й из ${list.active.length}.`);
  };

  return (
    <div className="manage-screen">
      <TitleBar back={{ label: "Ещё", onClick: onBack }} title="Счета" action={<TitleBarAction icon="plus" label="Новый счёт" onClick={onCreate} />} />
      <p className="manage-lead">Остаток каждого счёта — на сегодня, в его валюте. «Всего на счетах» на «Обзоре» складывает их в базовой валюте по последнему курсу.</p>
      <p className="manage-status" role="status">{status}</p>
      {error === null ? null : <p className="field-error" role="alert">{error}</p>}

      <section className="manage-group" aria-labelledby="accounts-active-title">
        <h2 id="accounts-active-title" className="list-kicker">Активные</h2>
        {list.active.length === 0 ? <p className="field-hint">Активных счетов нет. Без счёта операцию записать некуда — заведите счёт или верните его из архива.</p> : (
          <ul className="list-card manage-list">
            {list.active.map((row) => (
              <li key={row.account.id} className="manage-row">
                <AccountRowButton row={row} onOpen={() => onOpen(row.account.id)} />
                <ReorderControls id={`account-${row.account.id}`} name={row.account.name} position={row.position} count={list.active.length} busy={busy} onMove={(direction) => move(row, direction)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {list.archived.length === 0 ? null : (
        <section className="manage-group" aria-labelledby="accounts-archived-title">
          <h2 id="accounts-archived-title" className="list-kicker">В архиве</h2>
          <p className="field-hint">Архивный счёт не предлагается для новых операций, а его остаток и история остаются в итогах и отчётах.</p>
          <ul className="list-card manage-list">
            {list.archived.map((row) => (
              <li key={row.account.id} className="manage-row">
                <AccountRowButton row={row} onOpen={() => onOpen(row.account.id)} />
                <button className="secondary-button" type="button" aria-disabled={busy || undefined} aria-label={`Вернуть «${row.account.name}» из архива`} onClick={() => void run((state) => restoreAccount(state, row.account.id), `«${row.account.name}» снова среди активных.`, accountRowId(row.account.id))}>
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

const accountRowId = (accountId: string) => `account-row-${accountId}`;

function AccountRowButton({ row, onOpen }: { readonly row: AccountRow; readonly onOpen: () => void }) {
  return (
    <button id={accountRowId(row.account.id)} className="row-open" type="button" aria-label={accountRowLabel(row)} onClick={onOpen}>
      <span className={row.tone === null ? "icon-plate account-plate" : `icon-plate tone-${row.tone}`} aria-hidden="true"><Icon name={row.icon} size={24} /></span>
      <span className="manage-copy" aria-hidden="true">
        <strong><bdi dir="auto">{row.account.name}</bdi></strong>
        <small>{row.meta}</small>
      </span>
      <b aria-hidden="true">{row.balanceMinor === null ? "—" : <Money value={row.balanceMinor} currency={row.account.currency} />}</b>
    </button>
  );
}
