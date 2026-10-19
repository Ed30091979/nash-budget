import { type KeyboardEvent, useEffect, useRef } from "react";
import {
  baseCurrencyOf,
  type BudgetState,
  type CategoryGroup,
  type CategoryType,
} from "@family-budget/domain";
import { handleDialogKeyboard } from "../data-management/dialog-accessibility";
import { currencySign } from "../rates/RateQuickSheet";
import {
  categoryNameOutcome,
  categorySuggestions,
  groupChoicesFor,
} from "./category-picker";

export interface CategorySheetDraft {
  readonly name: string;
  readonly type: CategoryType;
  readonly group: CategoryGroup;
  /** Пусто — без месячного лимита. Только у расходной категории лимит вообще бывает. */
  readonly limit: string;
}

export const CATEGORY_SHEET_TITLE_ID = "category-sheet-title";
export const CATEGORY_SHEET_ERROR_ID = "category-sheet-error";

/** Больше подсказок сразу — это снова стена, ради ухода от которой рядом стоит поиск. */
const VISIBLE_SUGGESTIONS = 8;

export interface CategorySheetProps {
  readonly budget: BudgetState;
  readonly draft: CategorySheetDraft;
  /** Что станет после сохранения: над формой операции — одно, над плитками «Обзора» — другое. */
  readonly description: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onPatch: (patch: Partial<CategorySheetDraft>) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  /** Выбрать уже существующую активную категорию вместо создания тёзки. */
  readonly onSelectExisting: (id: string) => void;
  /** Вернуть из архива ту, что уже носила это имя. */
  readonly onRestore: (id: string) => void;
}

/**
 * Лист «Своя категория» поверх формы операции.
 *
 * Форма под ним остаётся смонтированной, поэтому сумма, дата и счёт никуда не деваются: лист
 * ничего у неё не забирает и ничего в неё не пишет, кроме выбранной в конце категории.
 *
 * Совпадение имени здесь не отказ, а развилка. Тёзка в архиве предлагается к возврату, активная
 * тёзка — к выбору, похожая активная — просто называется вслух, и сохранение после неё проходит:
 * человек, который набрал «Продукты для дачи», имел в виду именно это.
 */
export function CategorySheet({
  budget,
  draft,
  description,
  busy,
  error,
  onPatch,
  onSave,
  onCancel,
  onSelectExisting,
  onRestore,
}: CategorySheetProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const outcome = categoryNameOutcome(budget, draft.name, draft.type);
  const suggestions = categorySuggestions(budget, draft.type, draft.name).slice(0, VISIBLE_SUGGESTIONS);
  const groups = groupChoicesFor(draft.type);
  const blocked = outcome.kind === "duplicate";

  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="sheet-card"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={CATEGORY_SHEET_TITLE_ID}
        aria-describedby="category-sheet-description"
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          if (!dialogRef.current) return;
          handleDialogKeyboard(event, dialogRef.current, !busy, onCancel);
        }}
      >
        <h3 id={CATEGORY_SHEET_TITLE_ID}>Своя категория</h3>
        <p id="category-sheet-description">{description}</p>

        <div className="field">
          <label htmlFor="category-sheet-name">Название</label>
          <input
            id="category-sheet-name"
            ref={nameRef}
            maxLength={80}
            autoComplete="off"
            disabled={busy}
            value={draft.name}
            aria-invalid={blocked ? true : undefined}
            aria-describedby={outcome.kind === "free" ? undefined : "category-sheet-name-hint"}
            onChange={(event) => onPatch({ name: event.target.value })}
          />
          {outcome.kind === "free" ? null : (
            <p className="sheet-hint" id="category-sheet-name-hint" role="status">
              {outcome.message}
            </p>
          )}
          {outcome.kind === "restore" ? (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => onRestore(outcome.category.id)}
            >
              Вернуть «{outcome.category.name}» из архива
            </button>
          ) : null}
          {outcome.kind === "duplicate" ? (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => onSelectExisting(outcome.category.id)}
            >
              Выбрать «{outcome.category.name}»
            </button>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="category-sheet-group">Группа</label>
          <select
            id="category-sheet-group"
            disabled={busy || groups.length < 2}
            value={draft.group}
            onChange={(event) => onPatch({ group: event.target.value as CategoryGroup })}
          >
            {groups.map((group) => (
              <option value={group.key} key={group.key}>{group.title}</option>
            ))}
          </select>
        </div>

        {draft.type === "expense" ? (
          <div className="field">
            <label htmlFor="category-sheet-limit">Месячный лимит, {currencySign(baseCurrencyOf(budget))} — не обязательно</label>
            <input
              id="category-sheet-limit"
              inputMode="decimal"
              maxLength={24}
              placeholder="Оставьте пустым, если лимита нет"
              disabled={busy}
              value={draft.limit}
              onChange={(event) => onPatch({ limit: event.target.value })}
            />
            <small>Без суммы категория заводится без плана — лимит можно назначить позже.</small>
          </div>
        ) : null}

        {suggestions.length ? (
          <div className="sheet-suggestions">
            <p id="category-sheet-suggestions-label">Готовые названия</p>
            <ul aria-labelledby="category-sheet-suggestions-label">
              {suggestions.map((template) => (
                <li key={template.name}>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={() => onPatch({ name: template.name, group: template.group })}
                  >
                    {template.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? (
          <p className="field-error" id={CATEGORY_SHEET_ERROR_ID} role="alert" tabIndex={-1}>{error}</p>
        ) : null}

        <div className="dialog-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>
            Отмена
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || blocked || draft.name.trim().length === 0}
            aria-busy={busy}
            onClick={onSave}
          >
            Сохранить категорию
          </button>
        </div>
      </section>
    </div>
  );
}
