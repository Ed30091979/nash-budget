import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Hyphenated } from "../../components/Hyphenated";
import { Icon } from "../../components/Icon";
import { handleDialogKeyboard } from "../data-management/dialog-accessibility";

export interface QuestionSheetProps {
  /** Основа идентификаторов заголовка и пояснения. */
  readonly id: string;
  /** Вопрос заголовком (22/28, §c «Вопросы поверх „Обзора“»). */
  readonly title: string;
  /** Одна строка пояснения под вопросом. */
  readonly subtitle: string;
  /** Крестик «Спросить позже» и Esc: набор остаётся как есть, вопрос вернётся по правилу повтора. */
  readonly onLater: () => void;
  /** Подпись крестика; у правки уже данного ответа — «Закрыть без изменений». */
  readonly closeLabel?: string;
  /** Запись идёт: крестик и Esc молчат, кнопки не нажимаются дважды. */
  readonly busy?: boolean;
  /** Отказ записи словами (`writeFailureText`): задержка семьи, конфликт вкладок, сбой. */
  readonly error?: string | null;
  /** Лист спрятан, пока поверх него открыт другой («Своя категория»): выбор в нём не пропадает. */
  readonly hidden?: boolean;
  /** Длинный лист (чипы): тело прокручивается, а «Готово» закреплено внизу. */
  readonly tall?: boolean;
  readonly children?: ReactNode;
  /** Кнопки ответа. */
  readonly footer: ReactNode;
}

/**
 * Лист-вопрос поверх «Обзора» (дизайн v5, 03 / 03b / 04): по одному за раз, и каждый можно
 * пропустить крестиком. Модальный диалог (`aria-modal`, контракт `modal-presence.ts`): Tab ходит по
 * кругу внутри листа, Esc — то же, что крестик, тост под листом стоит на паузе. Фокус при открытии
 * — на вопросе: читающий с экрана слышит его и пояснение, а не подпись крестика.
 */
export function QuestionSheet({ id, title, subtitle, onLater, closeLabel = "Спросить позже", busy = false, error = null, hidden = false, tall = false, children, footer }: QuestionSheetProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  const later = () => {
    if (!busy) onLater();
  };
  return (
    <div className="sheet-backdrop q-backdrop" role="presentation" hidden={hidden}>
      <section
        ref={dialogRef}
        className={tall ? "sheet q-sheet q-tall" : "sheet q-sheet"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-sub`}
        aria-busy={busy}
        tabIndex={-1}
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          if (dialogRef.current) handleDialogKeyboard(event, dialogRef.current, !busy, onLater);
        }}
      >
        <span className="q-grab" aria-hidden="true" />
        <header className="q-head">
          <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1}><Hyphenated text={title} /></h2>
          <button className="q-later" type="button" aria-label={closeLabel} aria-disabled={busy || undefined} onClick={later}>
            <Icon name="x" size={24} />
          </button>
        </header>
        <p className="q-sub" id={`${id}-sub`}><Hyphenated text={subtitle} /></p>
        {children === undefined ? null : <div className="q-body">{children}</div>}
        {error === null ? null : <p className="field-error q-error" role="alert">{error}</p>}
        <div className="q-foot">{footer}</div>
      </section>
    </div>
  );
}
