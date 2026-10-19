import type { ReactNode } from "react";

export interface ToastAction {
  readonly label: string;
  readonly run: () => void;
}

/** Сообщение приложения: текст, иногда число, которое от записи поехало, и одно действие. */
export interface ToastMessage {
  /** Новое сообщение — новый ключ: та же фраза дважды подряд объявляется заново. */
  readonly key: number;
  readonly text: string;
  /** Под текстом: остаток, который сдвинула запись, — одометром (`SaveReceipt`). */
  readonly detail?: ReactNode;
  /** «Отменить», «Вернуться к черновику», «Подробнее в «Семье»». */
  readonly action?: ToastAction;
}

/** Сколько стоит сообщение: с действием — дольше, чтобы до кнопки успели дотянуться. */
export function toastDuration(toast: Pick<ToastMessage, "action">): number {
  return toast.action === undefined ? 6_000 : 10_000;
}

/**
 * Тост — одна плашка за раз (DESIGN §6, §12): новое сообщение сменяет прежнее, а не встаёт на него.
 * Стоит в потоке оболочки и липнет к низу над измеренной навигацией; объявляется живой областью
 * целиком, вместе с числом и действием.
 */
export function Toast({ toast, onClose }: { readonly toast: ToastMessage; readonly onClose: () => void }) {
  const action = toast.action;
  return (
    <aside className="message-toast" role="status" aria-live="polite" aria-atomic="true">
      <p>{toast.text}</p>
      {toast.detail ?? null}
      <div className="toast-actions">
        {action !== undefined ? <>
          <button className="primary-button" type="button" onClick={() => { onClose(); action.run(); }}>{action.label}</button>
          <button className="quiet-button" type="button" onClick={onClose}>Закрыть</button>
        </> : <button className="primary-button" type="button" onClick={onClose}>Закрыть</button>}
      </div>
    </aside>
  );
}
