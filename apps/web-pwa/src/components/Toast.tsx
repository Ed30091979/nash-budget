import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";

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

/** Сколько сообщение стоит ещё после паузы, если до неё времени почти не оставалось. */
export const TOAST_RESUME_MINIMUM_MS = 3_000;

export interface ToastProps {
  readonly toast: ToastMessage;
  /** Лист или диалог поверх: тост под затемнением, и его время не идёт. */
  readonly paused: boolean;
  readonly onClose: () => void;
  /** Куда вернуть фокус, если он был на тосте, а элемента, с которого он пришёл, уже нет. */
  readonly fallbackFocus: () => void;
}

/**
 * Тост — одна плашка за раз (DESIGN §6, §12): новое сообщение сменяет прежнее, а не встаёт на него.
 * Стоит в потоке оболочки и липнет к низу над измеренной навигацией; объявляется живой областью
 * целиком, вместе с числом и действием.
 *
 * Время у него своё и останавливается (WCAG 2.2.1): пока на тосте фокус или указатель и пока
 * поверх него лист или диалог, — после паузы он стоит ещё не меньше `TOAST_RESUME_MINIMUM_MS`.
 * Закрытый тост, на котором был фокус, отдаёт его туда, откуда тот пришёл, а не телу страницы
 * (WCAG 2.4.3; ревью 2b, MEDIUM-5).
 */
export function Toast({ toast, paused, onClose, fallbackFocus }: ToastProps) {
  const action = toast.action;
  const ref = useRef<HTMLElement>(null);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const left = useRef(toastDuration(toast));
  const returnTo = useRef<HTMLElement | null>(null);
  const latest = useRef({ onClose, fallbackFocus });
  useLayoutEffect(() => {
    latest.current = { onClose, fallbackFocus };
  });

  const stopped = paused || focused || hovered;
  useEffect(() => {
    if (stopped) return undefined;
    const started = Date.now();
    const timer = window.setTimeout(() => latest.current.onClose(), left.current);
    return () => {
      window.clearTimeout(timer);
      left.current = Math.max(TOAST_RESUME_MINIMUM_MS, left.current - (Date.now() - started));
    };
  }, [stopped]);

  // Уходя, тост с фокусом возвращает его: на элемент, с которого фокус пришёл, или на экран.
  useLayoutEffect(() => () => {
    const self = ref.current;
    if (self === null || !self.contains(document.activeElement)) return;
    const back = returnTo.current;
    if (back !== null && back.isConnected && !self.contains(back)) back.focus({ preventScroll: true });
    else latest.current.fallbackFocus();
  }, []);

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const from = event.relatedTarget;
    if (!focused && from instanceof HTMLElement && !event.currentTarget.contains(from)) returnTo.current = from;
    setFocused(true);
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  };

  return (
    <aside
      ref={ref}
      className="message-toast"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
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
