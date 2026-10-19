import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BudgetState } from "@family-budget/domain";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { AddCategorySheet } from "../overview/AddCategorySheet";
import { AccountsQuestion } from "./AccountsQuestion";
import { CategoriesQuestion } from "./CategoriesQuestion";
import { firstRunStore, type FirstRunState, type FirstRunStore, type QuestionId } from "./memory";
import { PaydayQuestion } from "./PaydayQuestion";
import { markAnswered, markAsked, markLater, nextQuestion } from "./questions-model";

/** Состояние первого запуска этого устройства — с перерисовкой, когда оно меняется; `null` — ещё читается. */
export function useFirstRun(store: FirstRunStore = firstRunStore()): FirstRunState | null {
  // Хранилище живёт только в браузере; разметка проверок читает тот же снимок.
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => store.load(), [store]);
  return state;
}

export interface QuestionHostProps {
  readonly budget: BudgetState;
  readonly today: string;
  readonly write: BudgetWriter;
  /**
   * Сейчас не спрашивать: поверх «Обзора» уже лист (ввод, «Своя категория»), показан не текущий
   * месяц или документ семьи задержан и устройство только читает. Вопрос подождёт.
   */
  readonly blocked: boolean;
  /** «Да, добавить»: форма счёта с видом «Накопления» (`#/more/accounts/new?type=savings`). */
  readonly onAddAccount: () => void;
  readonly store?: FirstRunStore;
}

/** Заголовок экрана под листом: туда уходит фокус, когда вопросов больше нет (как при смене экрана). */
function focusScreenHeading(): void {
  const heading = document.getElementById("main-content")?.querySelector<HTMLElement>("h1");
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

/**
 * Вопросы первого запуска поверх «Обзора» (DIRECTION §e, пп. 3–5): один за раз, по порядку —
 * категории, места для денег, дни выплат. Какой задать — решает `nextQuestion`; что спрошено,
 * отвечено и отложено — помнит память этого устройства (`memory.ts`, IndexedDB). Лист, показанный
 * впервые, отмечается «спрошен»: закрытый перезагрузкой, он вернётся, а отвеченный и отложенный —
 * нет (отложенный — по правилу повтора, `LATER_RETURN_DAYS`).
 */
export function QuestionHost({ budget, today, write, blocked, onAddAccount, store = firstRunStore() }: QuestionHostProps) {
  const state = useFirstRun(store);
  const [custom, setCustom] = useState(false);
  const question = state === null || blocked ? null : nextQuestion(state, today);
  const shown = useRef<QuestionId | null>(null);

  useEffect(() => {
    if (question !== null) void store.update((current) => markAsked(current, question, today));
    // Вопросов не осталось — фокус на заголовок экрана, а не на <body>, откуда ушёл последний лист.
    if (question === null && shown.current !== null) focusScreenHeading();
    shown.current = question;
  }, [question, store, today]);

  if (question === null) return null;
  const answer = (id: QuestionId) => void store.update((current) => markAnswered(current, id, today));
  const later = (id: QuestionId) => void store.update((current) => markLater(current, id, today));

  switch (question) {
    case "categories":
      return <>
        <CategoriesQuestion
          budget={budget}
          write={write}
          hidden={custom}
          onAnswered={() => answer("categories")}
          onLater={() => later("categories")}
          onCustom={() => setCustom(true)}
        />
        {custom ? (
          <AddCategorySheet
            budget={budget}
            type="expense"
            description="Новая категория встанет на «Обзоре» и в этом списке — уже отмеченной."
            onChange={(change) => write.run(change)}
            onDone={() => setCustom(false)}
            onChoose={() => setCustom(false)}
            onClose={() => setCustom(false)}
          />
        ) : null}
      </>;
    case "accounts":
      return (
        <AccountsQuestion
          budget={budget}
          onNo={() => answer("accounts")}
          onYes={() => { answer("accounts"); onAddAccount(); }}
          onLater={() => later("accounts")}
        />
      );
    case "payday":
      return <PaydayQuestion write={write} onAnswered={() => answer("payday")} onLater={() => later("payday")} />;
  }
}
