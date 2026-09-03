import { calculateBudget, type BudgetState } from "@family-budget/domain";

import type { TransactionDraft } from "./model";

type BudgetMetrics = ReturnType<typeof calculateBudget>;

/**
 * Число, за которым человек и приходил записывать операцию.
 *
 * Запись сама по себе — не ответ: человек записывает трату, чтобы узнать, сколько осталось. Если
 * у категории есть лимит месяца, отвечает лимит; если лимита нет — отвечает остаток на счёте,
 * который операция и подвинула. Одно число, а не оба: их два только у расхода с планом, и второе
 * там ничего не добавляет.
 */
export type EffectTarget =
  | { readonly kind: "category"; readonly id: string; readonly name: string }
  | { readonly kind: "account"; readonly id: string; readonly name: string };

/** Счёт, с которого (или на который) двигаются деньги. У перевода и взноса — счёт-источник. */
function affectedAccountId(draft: TransactionDraft): string {
  switch (draft.kind) {
    case "income":
    case "expense":
    case "refund":
      return draft.accountId;
    case "transfer":
    case "goal_contribution":
      return draft.fromAccountId;
  }
}

/** Категория операции, если у этого вида она вообще бывает и если её выбрали. */
function draftCategoryId(draft: TransactionDraft): string | null {
  if (draft.kind === "expense") return draft.categoryId || null;
  if (draft.kind === "income") return draft.categoryId || null;
  return null;
}

/**
 * Какое число объявлять после записи.
 *
 * Возвращает `null`, когда объявлять нечего: ни выбранной категории с планом, ни известного
 * счёта. Молчание в этом случае честнее выдуманного числа.
 */
export function effectTarget(
  budget: BudgetState,
  metrics: BudgetMetrics,
  draft: TransactionDraft,
): EffectTarget | null {
  const categoryId = draftCategoryId(draft);
  if (categoryId !== null) {
    const category = budget.categories.find((item) => item.id === categoryId);
    const metric = metrics.categoryMetrics[categoryId];
    // Категория без плана месяца лимита не имеет: `availableMinor` там ноль, и «осталось» было бы
    // не остатком, а суммой всех трат со знаком минус.
    if (category && metric && metric.availableMinor > 0) {
      return { kind: "category", id: categoryId, name: category.name };
    }
  }
  const accountId = affectedAccountId(draft);
  const account = budget.accounts.find((item) => item.id === accountId);
  return account ? { kind: "account", id: account.id, name: account.name } : null;
}

/** Значение этого числа в переданном расчёте. */
export function effectValueMinor(metrics: BudgetMetrics, target: EffectTarget): number {
  return target.kind === "category"
    ? metrics.categoryMetrics[target.id]?.remainingMinor ?? 0
    : metrics.accountBalancesMinor[target.id] ?? 0;
}

/** Подпись над числом. Называет и величину, и то, чья она: без имени число ничего не значит. */
export function effectLabel(target: EffectTarget): string {
  return target.kind === "category"
    ? `Осталось в категории «${target.name}»`
    : `Остаток на счёте «${target.name}»`;
}
