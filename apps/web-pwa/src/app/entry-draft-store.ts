import { createDraftSaving, type DraftSaving } from "../navigation/draft-guard";
import type { EntryDraft } from "../features/entry/entry-model";
import { draftDiffers } from "../features/entry/entry-model";

/**
 * Черновик листа ввода — вне листа (план волны 2, §2.2).
 *
 * Лист закрывается в ту же секунду, когда нажата «Записать»: запись доводит координатор, итог —
 * тост. Поэтому черновик живёт здесь, а не в состоянии листа: он переживает закрытие листа, переход
 * на другую вкладку и неудачную запись — «Не записано: … [Вернуться к черновику]» открывает лист с
 * ним же. В адрес он не попадает никогда: адрес несёт только вид и непрозрачные идентификаторы
 * плиток (`routes.ts`), а сумма, дата, комментарий и метки — здесь, в памяти этой вкладки.
 *
 * «Грязный» — отличается от снимка, сделанного при открытии (§2.4). Записываемый — не грязный с
 * самого нажатия: билет защёлки берётся синхронно, до первого `await` (`createDraftSaving`).
 */

export type EntryStatus = "editing" | "saving" | "failed";

export interface StoredEntry {
  /** Ключ адреса листа, которым его открыли: по нему черновик узнаёт своё открытие. */
  readonly key: string;
  readonly draft: EntryDraft;
  /** Снимок при открытии: «грязно» — значит, отличается от него. */
  readonly pristine: EntryDraft;
  readonly status: EntryStatus;
  /** Почему не записалось — для тоста «Не записано» и для листа, когда к черновику вернулись. */
  readonly failure: string | null;
}

/** Билет записи: какой черновик ушёл и чья защёлка его держит — для `succeed`/`fail`. */
export interface EntryTicket {
  readonly owner: StoredEntry | null;
  readonly saving: DraftSaving;
  readonly number: number;
}

export interface EntryDraftStore {
  current(): StoredEntry | null;
  /**
   * Лист открыт адресом `key`. Черновик того же открытия возвращается как был (лист открыли снова
   * «Вперёд» или «Вернуться к черновику»); другое открытие — новый черновик из `init`.
   */
  openEntry(key: string, init: () => EntryDraft): StoredEntry;
  update(change: (draft: EntryDraft) => EntryDraft): void;
  /** Заменить черновик целиком и снять снимок заново: смена вида на «Оформить возврат». */
  replace(draft: EntryDraft): void;
  /** Есть ли несохранённое в листе: грязный черновик, который не записывается прямо сейчас. */
  isDirty(): boolean;
  /** Начать запись: черновик с этой секунды не «несохранённый». */
  beginSaving(): EntryTicket;
  succeed(ticket: EntryTicket): void;
  fail(ticket: EntryTicket, message: string): void;
  /** Не записанный черновик — его можно вернуть в лист. */
  failed(): StoredEntry | null;
  /** Забыть не записанный черновик: человек начал новую операцию вместо него. */
  discardFailed(): void;
  /** Забыть черновик листа («Не сохранять», удалённая операция). Не записанный — ждёт дальше. */
  clear(): void;
  subscribe(listener: () => void): () => void;
}

export function createEntryDraftStore(): EntryDraftStore {
  /** Черновик листа. */
  let entry: StoredEntry | null = null;
  /** Не записанный черновик, чья запись упала, пока в листе уже был другой. */
  let waiting: StoredEntry | null = null;
  let saving: DraftSaving = createDraftSaving();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const set = (next: StoredEntry | null) => {
    entry = next;
    notify();
  };

  return {
    current: () => entry,
    openEntry(key, init) {
      if (entry !== null && entry.key === key && entry.status !== "saving") {
        // То же открытие: черновик возвращается к правке, не записанный — со своей причиной.
        if (entry.status === "failed") set({ ...entry, status: "editing" });
        return entry;
      }
      saving = createDraftSaving();
      if (waiting !== null && waiting.key === key) {
        const back: StoredEntry = { ...waiting, status: "editing" };
        waiting = null;
        set(back);
        return back;
      }
      const draft = init();
      const opened: StoredEntry = { key, draft, pristine: draft, status: "editing", failure: null };
      set(opened);
      return opened;
    },
    update(change) {
      if (entry === null || entry.status === "saving") return;
      set({ ...entry, draft: change(entry.draft), failure: null });
    },
    replace(draft) {
      if (entry === null) return;
      set({ ...entry, draft, pristine: draft, status: "editing", failure: null });
    },
    isDirty: () => entry !== null && entry.status !== "saving" && !saving.saving && draftDiffers(entry.draft, entry.pristine),
    beginSaving() {
      const ticketSaving = saving;
      const number = ticketSaving.begin();
      const owner: StoredEntry | null = entry === null ? null : { ...entry, status: "saving" };
      if (owner !== null) set(owner);
      return { owner, saving: ticketSaving, number };
    },
    succeed(ticket) {
      ticket.saving.succeed(ticket.number);
      ticket.saving.settle(false);
      // Записан тот черновик, что уходил: если человек уже начал новый, его не трогаем.
      if (entry !== null && entry === ticket.owner) set(null);
    },
    fail(ticket, message) {
      ticket.saving.fail(ticket.number);
      if (ticket.owner === null) return;
      const failed: StoredEntry = { ...ticket.owner, status: "failed", failure: message };
      if (entry === ticket.owner) {
        set(failed);
        return;
      }
      // В листе уже другой черновик: этот ждёт рядом, и «Вернуться к черновику» его найдёт.
      waiting = failed;
      notify();
    },
    failed: () => (entry !== null && entry.status === "failed" ? entry : waiting),
    discardFailed() {
      if (entry !== null && entry.status === "failed") entry = null;
      waiting = null;
      notify();
    },
    clear() {
      saving = createDraftSaving();
      set(null);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
