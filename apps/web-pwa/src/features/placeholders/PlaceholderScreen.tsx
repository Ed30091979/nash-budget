import type { ReactNode } from "react";
import type { BudgetState } from "@family-budget/domain";
import { BackButton } from "../../components/BackButton";
import { EmptyState } from "../../components/EmptyState";
import type { IconName } from "../../components/Icon";
import { GoalsIllustration } from "../../components/illustrations/GoalsIllustration";
import { plural } from "../../plural";

/** Разделы «Учёта», чей экран — подволна 2e: пока на их месте пустое состояние. */
export type PlaceholderKind = "debts" | "goals" | "recurring";

/** Строка о разделе: правда о том, что здесь пока можно и чего нельзя. */
export const PLACEHOLDER_NOTE = "Раздел появится в следующем обновлении приложения.";

interface PlaceholderWords {
  readonly title: string;
  readonly empty: { readonly title: string; readonly text: string };
  /** Заголовок, когда в бюджете что-то уже есть (из копии, из примера, с другого устройства). */
  readonly some: (count: number) => string;
  readonly someText: string;
  readonly glyph?: IconName;
  readonly illustration?: () => ReactNode;
}

export const PLACEHOLDER_WORDS: Readonly<Record<PlaceholderKind, PlaceholderWords>> = {
  debts: {
    title: "Долги",
    empty: { title: "Долгов нет", text: "Здесь будет, кому вы дали в долг и у кого взяли." },
    some: (count) => `В бюджете ${plural(count, ["долг", "долга", "долгов"])}`,
    someText: "Они уже учтены в остатках счетов; свой экран у долгов появится скоро.",
    glyph: "arrow-left-right",
  },
  goals: {
    title: "Цели",
    empty: { title: "Целей пока нет", text: "Отпуск, ремонт или подушка на чёрный день. Покажем, сколько откладывать в месяц." },
    some: (count) => `В плане ${plural(count, ["цель", "цели", "целей"])}`,
    someText: "Взносы по ним уже в плане месяца; свой экран у целей появится скоро.",
    illustration: () => <GoalsIllustration />,
  },
  recurring: {
    title: "Регулярные",
    empty: { title: "Регулярных пока нет", text: "Аренда, связь, зарплата — то, что повторяется каждый месяц." },
    some: (count) => `В бюджете ${plural(count, ["регулярная операция", "регулярные операции", "регулярных операций"])}`,
    someText: "Свой экран у регулярных операций появится скоро.",
    glyph: "calendar-clock",
  },
};

/** Что из раздела уже есть в бюджете — по имени, как его назвала семья. */
export function placeholderItems(budget: BudgetState, kind: PlaceholderKind): readonly { readonly id: string; readonly name: string }[] {
  switch (kind) {
    case "debts":
      return (budget.debts ?? []).map((debt) => ({ id: debt.id, name: debt.counterparty }));
    case "goals":
      return budget.goals.map((goal) => ({ id: goal.id, name: goal.name }));
    case "recurring":
      return (budget.recurringRules ?? []).map((rule) => ({
        id: rule.id,
        name: rule.name ?? budget.categories.find((category) => "categoryId" in rule.template && category.id === rule.template.categoryId)?.name ?? "Без названия",
      }));
  }
}

export interface PlaceholderScreenProps {
  readonly budget: BudgetState;
  readonly kind: PlaceholderKind;
  readonly onBack: () => void;
}

/**
 * «Долги», «Цели», «Регулярные» — заглушки до подволны 2e (DIRECTION §c, 15): то же пустое
 * состояние, что у меток. Кнопки действия у них нет, пока действия нет: кнопка, которая ничего не
 * делает, хуже честной строки о том, что раздел ещё в работе. Что уже есть в бюджете — из копии,
 * из примера, с другого устройства, — названо, а не спрятано за «пока нет».
 */
export function PlaceholderScreen({ budget, kind, onBack }: PlaceholderScreenProps) {
  const words = PLACEHOLDER_WORDS[kind];
  const items = placeholderItems(budget, kind);
  const empty = items.length === 0;
  return (
    <div className="manage-screen placeholder-screen">
      <div className="planning-toolbar"><BackButton label="К разделу «Ещё»" onClick={onBack} /></div>
      <header className="manage-head">
        <h1>{words.title}</h1>
      </header>
      <EmptyState
        {...(words.illustration === undefined ? {} : { illustration: words.illustration() })}
        {...(words.glyph === undefined ? {} : { glyph: words.glyph })}
        title={empty ? words.empty.title : words.some(items.length)}
        text={empty ? words.empty.text : words.someText}
        note={PLACEHOLDER_NOTE}
      >
        {empty ? null : (
          <ul className="placeholder-list">
            {items.map((item) => <li key={item.id}><bdi dir="auto">{item.name}</bdi></li>)}
          </ul>
        )}
      </EmptyState>
    </div>
  );
}
