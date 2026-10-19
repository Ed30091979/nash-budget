import { useSyncExternalStore } from "react";

/**
 * Открыт ли сейчас вопрос приложения — модальный диалог (ревью 2b, раунд 3, NEW-4).
 *
 * Источник один, и это не список: модальный диалог приложения сам говорит о себе `aria-modal="true"`
 * — лист ввода, лист «Своя категория», `ConfirmDialog`, вопрос экрана «Данные», вопросы «Семьи».
 * Тост спрашивает документ, а не перечень состояний оболочки: прежний перечень знал лист, вопрос об
 * уходе и вопрос о замене черновика — и не знал «Удалить весь семейный бюджет с устройства?», под
 * которым «Отменить» уходил за десять секунд. Новый диалог встаёт в этот счёт сам, без правки тоста;
 * `modal-presence.test.ts` держит, что каждый `role="dialog"` и `role="alertdialog"` в приложении
 * объявлен модальным.
 */
export const MODAL_DIALOG_SELECTOR = '[aria-modal="true"]';

interface ModalQueryRoot {
  querySelector(selector: string): unknown;
}

/** Есть ли в документе модальный диалог. */
export function modalDialogOpen(root: ModalQueryRoot): boolean {
  return root.querySelector(MODAL_DIALOG_SELECTOR) !== null;
}

function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => undefined;
  // Диалоги приходят порталом в `body` или рисуются внутри корня приложения — оба под `body`.
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal"] });
  return () => observer.disconnect();
}

const snapshot = () => (typeof document === "undefined" ? false : modalDialogOpen(document));

/** Открыт ли модальный диалог — и перерисовка, когда он открылся или закрылся. */
export function useModalDialogOpen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
