import {
  addExchangeRate,
  deleteTag,
  RateValidationError,
  TagValidationError,
  type BudgetState,
  type ExchangeRateDraft,
  type Transaction,
} from "@family-budget/domain";
import type { ToastMessage } from "../components/Toast";
import { EntryReceipt } from "../features/entry/EntryReceipt";
import { effectCurrencyOf, effectLabelOf, effectTargetOf, effectValueOf, writeEntry, type EntryDraft } from "../features/entry/entry-model";
import {
  deleteTransaction,
  OperationsValidationError,
  recreateTransaction,
  restoreTransaction,
} from "../features/operations/model";
import { createOperationsSubmissionGate } from "../features/operations/form-state";
import { kindLabels, transactionCurrency } from "../features/operations/transaction-words";
import { formatMoney } from "../money";
import { parseRoute, withoutSheet, type Route } from "../navigation/routes";
import { writeFailureText, type BudgetChange, type BudgetWriter } from "../write/useBudgetWrite";
import type { EntryDraftStore } from "./entry-draft-store";

/**
 * Запись из листа ввода — то, что делает оболочка, когда лист уже закрыт (план волны 2, §2.4).
 *
 * «Записать» проверяет черновик по нынешнему бюджету синхронно: отказ домена — в листе, и лист
 * остаётся. Прошедший — уходит в запись: черновик с этого касания «записывается» (билет защёлки —
 * внутри шлюза, до первого `await`), лист закрывается сразу, а запись доводит координатор. Итог —
 * тост: «Записано» с числом, которое сдвинулось, и «Отменить»; неудача — «Не записано: … [Вернуться
 * к черновику]», и черновик ждёт в своём хранилище.
 */
export interface EntryController {
  /** Слова отказа — лист показывает их и остаётся; `null` — запись ушла, лист закрыт. */
  submit(draft: EntryDraft): string | null;
  remove(transaction: Transaction): Promise<string | null>;
  saveRate(draft: ExchangeRateDraft): Promise<string | null>;
  /** Правка бюджета из листа, кроме самой операции: «Своя категория» над выбором категории. */
  change(change: BudgetChange): Promise<BudgetState>;
  /** Открыть не записанный черновик там, откуда его записывали. */
  returnToDraft(): void;
  /** Удаляет ли лист эту операцию сам прямо сейчас: её пропажа тогда — не «удалили на другом устройстве». */
  isRemoving(id: string): boolean;
}

export interface EntryControllerOptions {
  readonly store: EntryDraftStore;
  readonly write: BudgetWriter;
  readonly current: () => BudgetState | null;
  /** Маршрут сейчас — лист открыт поверх него. */
  readonly route: () => Route;
  /** Переход без вопроса: лист закрывается после «Записать» — черновик уже не «несохранённый». */
  readonly redirect: (route: Route) => void;
  /** Переход с проверками оболочки (задержка семьи): «Вернуться к черновику». */
  readonly navigate: (route: Route) => void;
  readonly showToast: (toast: Omit<ToastMessage, "key">) => void;
  /** Сегодня по календарю семьи: остаток счёта в тосте — на тот же день, что и в листе. */
  readonly today: () => string;
  readonly makeId?: () => string;
}

/**
 * Касание «Записать» или «Удалить», пока прежняя запись ещё летит: шлюз второй записи не пускает, и
 * лист говорит почему, а не молчит (ревью 2b, LOW-5).
 */
export const PREVIOUS_WRITE_PENDING = "Предыдущая запись ещё сохраняется. Нажмите снова через секунду.";

/** Отказ словами поля или общей фразой — текст произвольной ошибки на экран не попадает. */
export function entryErrorText(error: unknown): string {
  if (error instanceof OperationsValidationError || error instanceof RateValidationError || error instanceof TagValidationError) return error.message;
  return writeFailureText(error);
}

/** «Записано: расход 1 250 ₽» — вид и сумма в валюте счёта операции. */
export function operationWords(verb: string, transaction: Transaction, state: BudgetState): string {
  return `${verb}: ${kindLabels[transaction.kind].toLowerCase()} ${formatMoney(transaction.amountMinor, transactionCurrency(transaction, state))}`;
}

/**
 * Число, которое сдвинула запись, до и после — то же, что лист назвал под суммой (`effectTargetOf`):
 * лимит категории в бюджете месяца операции или накопленный остаток счёта.
 */
function receiptDetail(before: BudgetState, after: BudgetState, draft: EntryDraft, today: string) {
  try {
    const target = effectTargetOf(before, draft, today);
    if (target === null) return undefined;
    const beforeMinor = effectValueOf(before, target);
    const afterMinor = effectValueOf(after, target);
    if (beforeMinor === null || afterMinor === null) return undefined;
    return <EntryReceipt value={{ label: effectLabelOf(target), beforeMinor, afterMinor, currency: effectCurrencyOf(after, target) }} />;
  } catch {
    return undefined;
  }
}

/**
 * Метки, которые создала запись (`«+ метка»`), снимаются вместе с ней при «Отменить» — если их уже
 * не носит ничто другое (ревью 2b, LOW-1). Метку, которую успели поставить на другую операцию или
 * в правило, домен удалить не даст, и она остаётся.
 */
function withoutUnusedTags(state: BudgetState, ids: readonly string[]): BudgetState {
  let next = state;
  for (const id of ids) {
    try {
      next = deleteTag(next, id);
    } catch (error) {
      if (!(error instanceof TagValidationError)) throw error;
    }
  }
  return next;
}

export function createEntryController(options: EntryControllerOptions): EntryController {
  const gate = createOperationsSubmissionGate();
  const removing = new Set<string>();
  const makeId = options.makeId ?? (() => crypto.randomUUID());

  const undo = (label: string, change: (state: BudgetState) => BudgetState) => {
    void options.write.run(change, { ownsFailure: true })
      .then(() => options.showToast({ text: `Отменено: ${label}` }))
      .catch((error: unknown) => options.showToast({ text: `Не отменено: ${entryErrorText(error)}` }));
  };

  const returnToDraft = () => {
    const failed = options.store.failed();
    if (failed !== null) options.navigate(parseRoute(failed.key).route);
  };

  return {
    submit(draft) {
      if (gate.locked) return PREVIOUS_WRITE_PENDING;
      const before = options.current();
      if (before === null) return null;
      try {
        writeEntry(before, draft, makeId);
      } catch (error) {
        return entryErrorText(error);
      }
      const opened = options.route();
      void gate.run(async () => {
        const ticket = options.store.beginSaving();
        options.redirect(withoutSheet(opened));
        let transactionId = "";
        try {
          const after = await options.write.run((state) => {
            const result = writeEntry(state, draft, makeId);
            transactionId = result.transactionId;
            return result.state;
          }, { ownsFailure: true });
          options.store.succeed(ticket);
          const written = after.transactions.find((item) => item.id === transactionId);
          if (written === undefined) return;
          const previous = draft.editId === null ? undefined : before.transactions.find((item) => item.id === draft.editId);
          const known = new Set((before.tags ?? []).map((tag) => tag.id));
          const createdTags = (after.tags ?? []).filter((tag) => !known.has(tag.id)).map((tag) => tag.id);
          const label = operationWords(draft.editId === null ? "Записано" : "Изменено", written, after);
          options.showToast({
            text: label,
            detail: receiptDetail(before, after, draft, options.today()),
            action: {
              label: "Отменить",
              run: () => undo(label.slice(label.indexOf(":") + 2), previous === undefined
                ? (state) => withoutUnusedTags(deleteTransaction(state, transactionId), createdTags)
                : (state) => withoutUnusedTags(restoreTransaction(state, previous), createdTags)),
            },
          });
        } catch (error) {
          const text = entryErrorText(error);
          options.store.fail(ticket, text);
          options.showToast({ text: `Не записано: ${text}`, action: { label: "Вернуться к черновику", run: returnToDraft } });
        }
      });
      return null;
    },

    async remove(transaction) {
      const before = options.current();
      if (gate.locked) return PREVIOUS_WRITE_PENDING;
      if (before === null) return null;
      try {
        deleteTransaction(before, transaction.id);
      } catch (error) {
        return entryErrorText(error);
      }
      const opened = options.route();
      let refusal: string | null = null;
      removing.add(transaction.id);
      await gate.run(async () => {
        try {
          await options.write.run((state) => deleteTransaction(state, transaction.id), { ownsFailure: true });
        } catch (error) {
          refusal = entryErrorText(error);
          return;
        }
        options.store.clear();
        options.redirect(withoutSheet(opened));
        const label = operationWords("Удалено", transaction, before);
        options.showToast({
          text: label,
          action: { label: "Отменить", run: () => undo(label.slice(label.indexOf(":") + 2), (state) => recreateTransaction(state, transaction, makeId).state) },
        });
      }).finally(() => removing.delete(transaction.id));
      return refusal;
    },

    async saveRate(draft) {
      const before = options.current();
      if (before === null) return null;
      try {
        addExchangeRate(before, draft, makeId);
      } catch (error) {
        return entryErrorText(error);
      }
      try {
        await options.write.run((state) => addExchangeRate(state, draft, makeId).state, { ownsFailure: true });
        return null;
      } catch (error) {
        return entryErrorText(error);
      }
    },

    change: (change) => options.write.run(change),

    returnToDraft,

    isRemoving: (id) => removing.has(id),
  };
}
