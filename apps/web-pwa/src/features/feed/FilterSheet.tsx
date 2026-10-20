import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { CategoryTone } from "../../category-visual";
import { Icon, type IconName } from "../../components/Icon";
import { handleDialogKeyboard } from "../data-management/dialog-accessibility";

/** Один вариант листа: подпись, необязательная подложка с глифом и то, что выбор делает. */
export interface FilterChoice {
  readonly key: string;
  readonly label: string;
  /** Тихая вторая строка: «в архиве», «4 операции». */
  readonly detail?: string;
  /** Подложка с глифом: тон категории или графит счёта (`null` у тона). */
  readonly plate?: { readonly icon: IconName; readonly tone: CategoryTone | null };
  readonly selected: boolean;
  readonly onSelect: () => void;
}

export interface FilterGroup {
  readonly key: string;
  /** Подпись группы: «Расходы», «Доходы», «Вид операции». */
  readonly title?: string;
  readonly choices: readonly FilterChoice[];
}

export interface FilterSheetProps {
  /** Основа идентификаторов заголовка. */
  readonly id: string;
  readonly title: string;
  readonly groups: readonly FilterGroup[];
  readonly onClose: () => void;
  /** Что стоит под вариантами: дни своего периода. */
  readonly children?: ReactNode;
}

/**
 * Лист выбора фильтра (дизайн 5.0, §c «Операции»: «выбор в листах»): снизу, со скруглением листа,
 * заголовок и крестик. Вариант — строка 48 во всю ширину с галочкой у выбранного (`aria-pressed`:
 * выбор говорит не только цветом); касание выбирает и закрывает лист. Модальный диалог: Tab ходит по
 * кругу внутри, Esc и крестик закрывают, фокус при открытии — на выбранном варианте, при закрытии —
 * снова на чипе, который лист открыл.
 */
export function FilterSheet({ id, title, groups, onClose, children }: FilterSheetProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const selected = dialogRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]');
    (selected ?? dialogRef.current)?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="sheet-backdrop filter-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        ref={dialogRef}
        className="sheet filter-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          if (dialogRef.current) handleDialogKeyboard(event, dialogRef.current, true, onClose);
        }}
      >
        <header className="filter-sheet-head">
          <h2 id={`${id}-title`}>{title}</h2>
          <button className="icon-button" type="button" aria-label="Закрыть" onClick={onClose}>
            <Icon name="x" size={24} />
          </button>
        </header>
        <div className="filter-sheet-body">
          {groups.map((group) => (
            <section key={group.key} className="filter-group" aria-labelledby={group.title === undefined ? undefined : `${id}-${group.key}`}>
              {group.title === undefined ? null : <h3 id={`${id}-${group.key}`}>{group.title}</h3>}
              <ul className="filter-choices">
                {group.choices.map((choice) => (
                  <li key={choice.key}>
                    <button className="filter-choice" type="button" aria-pressed={choice.selected} onClick={choice.onSelect}>
                      {choice.plate === undefined ? null : (
                        <span className={`icon-plate filter-plate ${choice.plate.tone === null ? "plate-account" : `tone-${choice.plate.tone}`}`}>
                          <Icon name={choice.plate.icon} size={20} />
                        </span>
                      )}
                      <span className="filter-choice-text">
                        <bdi dir="auto">{choice.label}</bdi>
                        {choice.detail === undefined ? null : <small>{choice.detail}</small>}
                      </span>
                      {choice.selected ? <Icon name="check" size={20} className="filter-check" /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {children}
        </div>
      </section>
    </div>
  );
}
