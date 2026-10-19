import { useMemo, useState } from "react";
import { calculateHoldings, type BudgetState } from "@family-budget/domain";
import { Hyphenated } from "../../components/Hyphenated";
import { Icon, type IconName } from "../../components/Icon";
import { firstRunStore, type FirstRunStore, type HintId } from "./memory";
import { closeHint, visibleHints } from "./hints-model";
import { useFirstRun } from "./QuestionHost";

/** Слова и глиф каждой карточки; действие называет то, что случится по касанию. */
export const HINT_WORDS: Readonly<Record<HintId, { readonly title: string; readonly text: string; readonly action: string; readonly icon: IconName }>> = {
  "opening-balance": { title: "Укажите, сколько сейчас на карте", text: "Тогда «На счетах» покажет настоящий остаток.", action: "Указать остаток", icon: "wallet" },
  backup: { title: "Сделайте копию данных", text: "Сохраните файл в «Файлы» или отправьте себе.", action: "Сделать копию", icon: "download" },
  import: { title: "Загрузите выписку банка", text: "Разберём её прямо на телефоне.", action: "Загрузить выписку", icon: "receipt-text" },
  goal: { title: "Поставьте цель", text: "Покажем, сколько откладывать в месяц.", action: "К целям", icon: "target" },
  family: { title: "Ведёте бюджет вдвоём?", text: "Семья и синхронизация — в «Ещё».", action: "Подробнее", icon: "users" },
};

export interface HintCardsProps {
  readonly budget: BudgetState;
  readonly today: string;
  readonly lastSuccessfulBackup: string | null;
  readonly inFamily: boolean;
  /** Касание действия карточки: куда вести — решает оболочка (копия, счёт, выписка, цели, семья). */
  readonly onAction: (id: HintId) => Promise<void> | void;
  readonly store?: FirstRunStore;
}

/**
 * Карточки-подсказки в конце «Обзора» (06b): не больше двух сразу, каждая закрывается крестиком
 * навсегда — на этом устройстве (`memory.ts`). Когда какая к месту — `hints-model.ts`. Карточка —
 * не сообщение: она не всплывает, не мигает и не уходит сама, а стоит в потоке под плитками.
 */
export function HintCards({ budget, today, lastSuccessfulBackup, inFamily, onAction, store = firstRunStore() }: HintCardsProps) {
  const state = useFirstRun(store);
  const [running, setRunning] = useState<HintId | null>(null);
  const totalInBaseMinor = useMemo(() => calculateHoldings(budget, today).totalInBaseMinor, [budget, today]);
  if (state === null) return null;
  const hints = visibleHints({ state, budget, today, totalInBaseMinor, lastSuccessfulBackup, inFamily });
  if (hints.length === 0) return null;

  const act = async (id: HintId) => {
    if (running !== null) return;
    setRunning(id);
    try {
      await onAction(id);
    } finally {
      setRunning(null);
    }
  };
  const close = (id: HintId, index: number) => {
    void store.update((current) => closeHint(current, id));
    // Фокус — на соседнюю карточку или на заголовок раздела, а не на <body>.
    const next = hints[index + 1] ?? hints[index - 1];
    window.setTimeout(() => document.getElementById(next === undefined ? "hint-cards-title" : `hint-${next}-title`)?.focus({ preventScroll: true }), 0);
  };

  return (
    <section className="hint-cards" aria-labelledby="hint-cards-title">
      <h2 id="hint-cards-title" className="visually-hidden" tabIndex={-1}>Подсказки</h2>
      <ul>
        {hints.map((id, index) => {
          const words = HINT_WORDS[id];
          return (
            <li key={id} className="hint card">
              <div className="hint-copy">
                <h3 id={`hint-${id}-title`} tabIndex={-1}><Icon name={words.icon} size={20} /><Hyphenated text={words.title} /></h3>
                <p><Hyphenated text={words.text} /></p>
                <button className="secondary-button hint-action" type="button" aria-busy={running === id} aria-disabled={running !== null || undefined} aria-describedby={`hint-${id}-title`} onClick={() => void act(id)}>{words.action}</button>
              </div>
              <button className="quiet-button hint-close" type="button" aria-label={`Скрыть подсказку «${words.title}»`} onClick={() => close(id, index)}>
                <Icon name="x" size={24} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
