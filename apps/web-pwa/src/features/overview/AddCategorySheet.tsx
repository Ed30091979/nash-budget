import { useEffect, useRef, useState } from "react";
import type { BudgetState, CategoryType } from "@family-budget/domain";
import { CategorySheet, CATEGORY_SHEET_ERROR_ID, type CategorySheetDraft } from "../categories/CategorySheet";
import { createOperationsSubmissionGate } from "../operations/form-state";
import { createOperationCategory, restoreCategory, toOperationsErrorView } from "../operations/model";

export interface AddCategorySheetProps {
  readonly budget: BudgetState;
  readonly type: CategoryType;
  /** Единственный путь записи оболочки. */
  readonly onChange: (change: (state: BudgetState) => BudgetState) => Promise<unknown>;
  /** Категория заведена или возвращена из архива: её идентификатор и имя. */
  readonly onDone: (categoryId: string, name: string) => void;
  /** Что станет после сохранения; по умолчанию — слова «Обзора». */
  readonly description?: string;
  /** Тёзка уже есть: записать в неё, а не заводить вторую. */
  readonly onChoose: (categoryId: string) => void;
  readonly onClose: () => void;
}

export const ADD_CATEGORY_DESCRIPTION = {
  expense: "Новая категория встанет плиткой в «Расходы». Лимит можно назначить сейчас или позже в плане месяца.",
  income: "Новый источник встанет плиткой в «Доходы».",
} as const;

/** Над листом ввода: набранное в листе остаётся, а новая категория сразу выбрана в нём. */
export const ENTRY_CATEGORY_DESCRIPTION = "Сумма, дата и счёт в листе останутся на месте. После сохранения категория сразу будет выбрана.";

/**
 * «+» в ряду «Обзора»: лист «Своя категория» над плитками. После сохранения фокус возвращается на
 * «+», с которого лист открыли, — новая плитка встаёт рядом с ним.
 */
export function AddCategorySheet({ budget, type, onChange, onDone, onChoose, onClose, description = ADD_CATEGORY_DESCRIPTION[type] }: AddCategorySheetProps) {
  const [draft, setDraft] = useState<CategorySheetDraft>({ name: "", type, group: type === "income" ? "income" : "everyday", limit: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(createOperationsSubmissionGate());

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  const run = (change: (state: BudgetState) => BudgetState, done: () => void) => {
    void gate.current.run(async () => {
      setBusy(true);
      setError(null);
      try {
        await onChange(change);
        done();
      } catch (cause) {
        setError(toOperationsErrorView(cause).message);
        window.setTimeout(() => document.getElementById(CATEGORY_SHEET_ERROR_ID)?.focus(), 0);
      } finally {
        setBusy(false);
      }
    });
  };

  const save = () => {
    if (busy) return;
    const pending = draft;
    let createdId = "";
    run((state) => {
      const created = createOperationCategory(state, pending);
      createdId = created.categoryId;
      return created.state;
    }, () => onDone(createdId, pending.name.trim()));
  };
  const restore = (id: string) => {
    if (busy) return;
    const name = budget.categories.find((category) => category.id === id)?.name ?? draft.name.trim();
    run((state) => restoreCategory(state, id), () => onDone(id, name));
  };

  return (
    <CategorySheet
      budget={budget}
      draft={draft}
      description={description}
      busy={busy}
      error={error}
      onPatch={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      onSave={save}
      onCancel={onClose}
      onSelectExisting={onChoose}
      onRestore={restore}
    />
  );
}
