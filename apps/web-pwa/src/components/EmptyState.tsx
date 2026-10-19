import { useId, type ReactNode } from "react";
import { Hyphenated } from "./Hyphenated";
import { Icon, type IconName } from "./Icon";

export interface EmptyStateAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly id?: string;
  readonly busy?: boolean;
}

export interface EmptyStateQuickItem {
  readonly key: string;
  readonly label: string;
  /** Полное доступное имя, если подписи мало: «Создать метку «дача»». */
  readonly name?: string;
  readonly onClick: () => void;
}

export interface EmptyStateProps {
  /** Иллюстрация v5 (`components/illustrations/*`) — декоративная, смысл несут слова. */
  readonly illustration?: ReactNode;
  /** Глиф на тоновой подложке вместо иллюстрации — там, где своей картинки нет. */
  readonly glyph?: IconName;
  /** Название состояния: «Меток пока нет». */
  readonly title: string;
  /** Одна строка — что здесь будет и зачем. */
  readonly text: string;
  /** Одна основная кнопка; без неё — состояние без действия (заглушка до 2e). */
  readonly action?: EmptyStateAction;
  /** Быстрые шаблоны одним касанием: подпись группы и чипы. */
  readonly quick?: { readonly label: string; readonly items: readonly EmptyStateQuickItem[]; readonly busy?: boolean };
  /** Строка о состоянии раздела, тише основной: «Раздел появится в следующем обновлении». */
  readonly note?: string;
  readonly children?: ReactNode;
}

/**
 * Пустое состояние одной анатомии (DIRECTION §c): иллюстрация или глиф, название состояния, одна
 * строка, одна основная кнопка и, где есть, быстрые шаблоны. Заголовок — `h2`: `h1` остаётся
 * названием экрана, на которое ставится фокус при переходе.
 */
export function EmptyState({ illustration, glyph, title, text, action, quick, note, children }: EmptyStateProps) {
  const id = useId();
  return (
    <section className="empty-state" aria-labelledby={`${id}-title`}>
      <div className="empty-art" aria-hidden="true">
        {illustration ?? (glyph === undefined ? null : <span className="icon-plate empty-glyph"><Icon name={glyph} size={32} /></span>)}
      </div>
      <h2 id={`${id}-title`}><Hyphenated text={title} /></h2>
      <p className="empty-text"><Hyphenated text={text} /></p>
      {children}
      {action === undefined ? null : (
        <button id={action.id} className="primary-button wide empty-action" type="button" aria-busy={action.busy || undefined} aria-disabled={action.busy || undefined} onClick={action.onClick}>{action.label}</button>
      )}
      {quick === undefined || quick.items.length === 0 ? null : (
        <div className="empty-quick">
          <p id={`${id}-quick`}>{quick.label}</p>
          <ul className="chip-row" aria-labelledby={`${id}-quick`}>
            {quick.items.map((item) => (
              <li key={item.key}>
                <button className="chip" type="button" aria-label={item.name} aria-disabled={quick.busy || undefined} onClick={item.onClick}>
                  <span className="chip-face"><Icon name="plus" size={20} /><bdi dir="auto">{item.label}</bdi></span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {note === undefined ? null : <p className="empty-note">{note}</p>}
    </section>
  );
}
