import { useEffect, useMemo, useRef, useState } from "react";
import type { BudgetState } from "@family-budget/domain";
import { Hyphenated } from "../../components/Hyphenated";
import { Icon } from "../../components/Icon";
import { useFormDraft } from "../../navigation/draft-guard";
import { writeFailureText, type BudgetWriter } from "../../write/useBudgetWrite";
import { BudgetCurrencyLine } from "./BudgetCurrencyLine";
import { QuestionSheet } from "./QuestionSheet";
import { applyCategoryChoice, categoryChips, type CategoryChip } from "./questions-model";

export interface CategoriesQuestionProps {
  readonly budget: BudgetState;
  readonly write: BudgetWriter;
  /** «Готово» записан: вопрос отвечен. */
  readonly onAnswered: () => void;
  /** Крестик: набор остаётся как есть. */
  readonly onLater: () => void;
  /** «Своя категория» — существующий лист категории поверх этого. */
  readonly onCustom: () => void;
  /** Лист спрятан, пока поверх него открыт лист «Своя категория». */
  readonly hidden?: boolean;
  /**
   * Куда вернуть фокус, когда лист «Своя категория» закрылся: ключ имени заведённой или выбранной
   * категории — её чип; `null` — сам чип «Своя категория».
   */
  readonly returnFocusTo?: string | null;
}

/**
 * «На что вы тратите?» (03): частые категории набора уже отмечены, ниже — три оставшиеся стартовые
 * и три подсказки домена, плюс «Своя категория». «Готово» убирает неотмеченные в архив и заводит
 * отмеченные; крестик оставляет набор как есть. Выбор хранится как отличие от того, что отмечено
 * сейчас: категория, заведённая в листе «Своя категория», встаёт сюда сразу отмеченной.
 */
export function CategoriesQuestion({ budget, write, onAnswered, onLater, onCustom, hidden = false, returnFocusTo = null }: CategoriesQuestionProps) {
  const chips = useMemo(() => categoryChips(budget), [budget]);
  const chipButtons = useRef(new Map<string, HTMLButtonElement>());
  const ownButton = useRef<HTMLButtonElement>(null);
  const wasHidden = useRef(hidden);
  // Лист «Своя категория» закрылся (Esc, «Отмена», сохранение): фокус — снова в этом листе, на
  // заведённую категорию или на «Свою категорию». Иначе он оставался на <body>: Tab ходил по экрану
  // под модальным листом, а Esc листа больше не срабатывал (ревью R2, M-2).
  useEffect(() => {
    if (wasHidden.current && !hidden) {
      const target = (returnFocusTo === null ? undefined : chipButtons.current.get(returnFocusTo)) ?? ownButton.current;
      target?.focus({ preventScroll: false });
    }
    wasHidden.current = hidden;
  }, [hidden, returnFocusTo]);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set());
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = useMemo(() => new Set([
    ...chips.frequent.filter((chip) => !unchecked.has(chip.key)).map((chip) => chip.key),
    ...chips.more.filter((chip) => added.has(chip.key)).map((chip) => chip.key),
  ]), [chips, unchecked, added]);
  const saving = useFormDraft({
    label: "выбор категорий для «Обзора»",
    dirty: unchecked.size > 0 || added.size > 0,
    discard: () => { setUnchecked(new Set()); setAdded(new Set()); },
  });

  const toggle = (chip: CategoryChip, frequent: boolean) => {
    if (busy) return;
    setError(null);
    const update = (set: ReadonlySet<string>) => {
      const next = new Set(set);
      if (next.has(chip.key)) next.delete(chip.key);
      else next.add(chip.key);
      return next;
    };
    if (frequent) setUnchecked(update);
    else setAdded(update);
  };

  const done = () => {
    if (busy) return;
    const picked = chosen;
    const ticket = saving.begin();
    setBusy(true);
    setError(null);
    // Чипы считаются заново по состоянию записи: бюджет мог измениться на другом устройстве.
    write.run((state) => applyCategoryChoice(state, categoryChips(state), picked)).then(() => {
      saving.succeed(ticket);
      setBusy(false);
      onAnswered();
    }, (cause: unknown) => {
      saving.fail(ticket);
      setBusy(false);
      setError(writeFailureText(cause));
    });
  };

  const chip = (item: CategoryChip, frequent: boolean) => {
    const on = chosen.has(item.key);
    return (
      <li key={item.key}>
        <button
          ref={(element) => { if (element === null) chipButtons.current.delete(item.key); else chipButtons.current.set(item.key, element); }}
          className="chip q-chip"
          type="button"
          aria-pressed={on}
          aria-disabled={busy || undefined}
          onClick={() => toggle(item, frequent)}
        >
          <span className={on ? `chip-face tone-${item.tone}` : "chip-face"}>
            <Icon name={on ? "check" : "plus"} size={20} />
            <bdi dir="auto"><Hyphenated text={item.name} /></bdi>
          </span>
        </button>
      </li>
    );
  };

  return (
    <QuestionSheet
      id="q-categories"
      title="На что вы тратите?"
      subtitle="Отмеченное будет на «Обзоре». Поменять можно в любой момент."
      onLater={onLater}
      busy={busy}
      error={error}
      hidden={hidden}
      tall
      footer={<button className="primary-button wide" type="button" aria-disabled={busy || undefined} aria-busy={busy} onClick={done}>Готово</button>}
    >
      <BudgetCurrencyLine budget={budget} write={write} busy={busy} />
      {chips.frequent.length === 0 ? null : <>
        <p className="q-group" id="q-categories-frequent">Частые — уже отмечены</p>
        <ul className="q-chips" aria-labelledby="q-categories-frequent">{chips.frequent.map((item) => chip(item, true))}</ul>
      </>}
      <p className="q-group" id="q-categories-more">Добавить</p>
      <ul className="q-chips" aria-labelledby="q-categories-more">
        {chips.more.map((item) => chip(item, false))}
        <li>
          <button ref={ownButton} className="chip q-chip q-chip-own" type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) onCustom(); }}>
            <span className="chip-face"><Icon name="pencil" size={20} />Своя категория</span>
          </button>
        </li>
      </ul>
    </QuestionSheet>
  );
}
