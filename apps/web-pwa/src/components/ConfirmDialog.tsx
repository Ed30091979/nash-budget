import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { activateDialogEnvironment, handleDialogKeyboard } from "../features/data-management/dialog-accessibility";

export interface ConfirmDialogProps {
  readonly title: string;
  readonly description: string;
  /** Безопасный ответ: на нём фокус при открытии, его же дают Esc и закрытие. */
  readonly cancelLabel: string;
  /** Ответ, который что-то теряет. */
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/**
 * Вопрос приложения своими словами — вместо системного окна (`window.confirm`).
 *
 * Системное окно блокировало страницу, выглядело чужим и в прогонах отвечало «нет» за человека.
 * Этот диалог — тот же, что «Удалить весь бюджет» на экране «Данные»: портал в `body`, корень
 * приложения выключен из обхода и дерева доступности, Tab ходит по кругу внутри, Esc — безопасный
 * ответ, фокус при открытии на безопасной кнопке и после закрытия — там, откуда его открыли.
 */
export function ConfirmDialog({ title, description, cancelLabel, confirmLabel, onCancel, onConfirm }: ConfirmDialogProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return activateDialogEnvironment(document.getElementById("root"), cancelRef.current, opener);
  }, []);

  const dialog = (
    <div className="confirmation-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="confirmation-dialog"
        role="alertdialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          if (!dialogRef.current) return;
          handleDialogKeyboard(event, dialogRef.current, true, onCancel);
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        <div className="dialog-actions">
          <button ref={cancelRef} className="primary-button" type="button" onClick={onCancel}>{cancelLabel}</button>
          <button className="danger-button" type="button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
  // Без документа (статическая отрисовка проверок) портала нет — диалог рисуется на месте.
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

/** Слова вопроса о несохранённом черновике: что потеряется — названо, кнопки — действиями. */
export function draftLeaveQuestion(labels: readonly string[]): Pick<ConfirmDialogProps, "title" | "description" | "cancelLabel" | "confirmLabel"> {
  const what = labels.length === 0 ? "введённое" : labels.join(", ");
  return {
    title: "Уйти без сохранения?",
    description: `Не записано: ${what}. Если уйти сейчас, введённое пропадёт.`,
    cancelLabel: "Продолжить ввод",
    confirmLabel: "Не сохранять",
  };
}
