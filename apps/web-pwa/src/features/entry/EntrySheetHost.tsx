import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { calculateHoldings, type BudgetState } from "@family-budget/domain";
import type { EntryController } from "../../app/entry-controller";
import type { EntryDraftStore } from "../../app/entry-draft-store";
import { routeKey, sameRecordId, type Route } from "../../navigation/routes";
import { EntrySheet, RefusedEntrySheet } from "./EntrySheet";
import { draftFromTransaction, refundDraftFor, type EntryDraft } from "./entry-model";
import { draftOfSheet, editVanished, sheetChoosesMode } from "./sheet-address";

export interface EntrySheetHostProps {
  /** Маршрут с открытым листом (`sheet=entry`). */
  readonly route: Route;
  readonly budget: BudgetState;
  readonly today: string;
  readonly store: EntryDraftStore;
  readonly controller: EntryController;
  /** Документ семьи задержан, пока лист открыт: «Записать» ответит этими словами. */
  readonly writeRefusal: string | null;
  readonly onClose: () => void;
  /**
   * Операцию, открытую в листе, удалили на другом устройстве: оболочка уводит с листа, снимает
   * `edit=` с адреса и говорит это словами; `typed` — набранное, если в правке что-то тронули.
   */
  readonly onVanished: (typed: EntryDraft | null) => void;
  /** Фокус, когда плитки или строки, открывшей лист, уже нет. */
  readonly fallbackFocus: () => void;
}

/**
 * Лист ввода поверх экрана: адрес говорит, с чем его открыли, черновик берётся из хранилища.
 *
 * Открытие узнаётся по ключу адреса: тот же адрес («Вперёд», «Вернуться к черновику») — тот же
 * набранный черновик, другой — новый, из плиток или из операции; нетронутый строится заново при
 * каждом открытии. Пока запись уходит, листа нет: он закрылся в момент нажатия, и адрес догоняет
 * это возвратом по истории.
 */
export function EntrySheetHost({ route, budget, today, store, controller, writeRefusal, onClose, onVanished, fallbackFocus }: EntrySheetHostProps) {
  const key = routeKey(route);
  const stored = useSyncExternalStore(store.subscribe, store.current, store.current);
  const editId = route.edit;
  const editing = useMemo(
    () => editId === undefined ? null : budget.transactions.find((item) => sameRecordId(item.id, editId)) ?? null,
    [budget, editId],
  );
  const opening = useMemo(() => editing === null ? null : draftFromTransaction(budget, editing), [budget, editing]);
  const balances = useMemo(() => {
    try {
      return calculateHoldings(budget, today).accountBalancesMinor;
    } catch {
      return {};
    }
  }, [budget, today]);

  // Черновик открытия — до первой отрисовки листа: открытие решается адресом, а не правкой бюджета,
  // и пришедшая чужая запись не сбрасывает набранное.
  const draftInit = (): EntryDraft => opening?.kind === "draft" ? opening.draft : draftOfSheet(budget, route, today);
  const init = useRef(draftInit);
  init.current = draftInit;
  const openable = editId === undefined || opening?.kind === "draft";
  // Закрытие листа — и нетронутый черновик забыт: следующее открытие построит его от нынешней
  // операции, а не покажет то, что было при прошлом (ревью 2b, HIGH-2).
  useLayoutEffect(() => {
    if (!openable) return undefined;
    store.openEntry(key, () => init.current());
    return () => store.close(key);
  }, [store, key, openable]);

  // Операция была в листе и пропала не из-за него — её удалили на другом устройстве (LOW-6).
  const seen = useRef<string | null>(null);
  const vanished = useRef(onVanished);
  vanished.current = onVanished;
  useEffect(() => {
    if (editId === undefined) {
      seen.current = null;
      return;
    }
    if (editing !== null) {
      seen.current = editId;
      return;
    }
    if (!editVanished(seen.current, editId, false, controller.isRemoving(editId))) return;
    seen.current = null;
    const current = store.current();
    vanished.current(current !== null && current.key === key && current.status === "editing" && store.isDirty() ? current.draft : null);
  }, [editId, editing, key, store, controller]);

  // Операции из адреса нет: оболочка уводит с листа и говорит «Запись не найдена».
  if (editId !== undefined && editing === null) return null;
  if (opening?.kind === "refused") {
    return <RefusedEntrySheet budget={budget} transaction={opening.transaction} message={opening.message} onClose={onClose} onDelete={controller.remove} fallbackFocus={fallbackFocus} />;
  }
  if (stored === null || stored.key !== key || stored.status === "saving") return null;
  return (
    <EntrySheet
      budget={budget}
      draft={stored.draft}
      today={today}
      balances={balances}
      modeSwitch={sheetChoosesMode(route)}
      failure={stored.failure}
      writeRefusal={writeRefusal}
      editing={editing}
      onChange={store.update}
      onRefund={(expense) => store.replace(refundDraftFor(expense, budget, today))}
      onClose={onClose}
      onSubmit={controller.submit}
      onDelete={controller.remove}
      onSaveRate={controller.saveRate}
      onCategoryChange={controller.change}
      isDirty={store.isDirty}
      onDiscard={store.clear}
      fallbackFocus={fallbackFocus}
    />
  );
}
