import type { BudgetState, DebtDirection, Transaction, TransactionKind } from "@family-budget/domain";
import type { IconName } from "../../components/Icon";
import { formatMoney } from "../../money";
import { plural } from "../../plural";

/**
 * Слова об операции, общие для «Записать» и «Вся история».
 *
 * История уехала с экрана записи на «Ещё», и обе стороны называют операцию одинаково: вид,
 * знак направления, вторую строку без повтора категории. Один словарь, а не две копии.
 */
export const kindLabels: Record<TransactionKind, string> = {
  income: "Доход",
  expense: "Расход",
  refund: "Возврат",
  transfer: "Перевод",
  goal_contribution: "Взнос в цель",
  // Вид говорит, куда ушли деньги; что это значит — дал или вернул, — говорит направление долга
  // (`debtVerb`). Подпись вида нужна там, где долга под рукой нет: в списке видов фильтра.
  debt_out: "Долг: со счёта",
  debt_in: "Долг: на счёт",
};

// §6: вид операции рисует тот же глиф, что и на «Сегодня» — один смысл, один глиф.
// Он достаётся только строке без категории: у категорийной строки плитку занимает категория.
export const kindIcons: Record<TransactionKind, IconName> = {
  income: "arrow-down-left",
  expense: "arrow-up-right",
  refund: "rotate-ccw",
  transfer: "arrow-left-right",
  goal_contribution: "target",
  debt_out: "arrow-up-right",
  debt_in: "arrow-down-left",
};

/**
 * Четыре глагола долга из пары «вид + направление» (D-033): деньги ушли со счёта — «Дал в долг» по
 * долгу, который должны семье, и «Вернул долг» по долгу семьи; пришли — «Взял в долг» и «Мне вернули
 * долг». Без долга, которого в бюджете нет, — подпись вида.
 */
export function debtVerb(kind: "debt_out" | "debt_in", direction: DebtDirection | undefined): string {
  if (direction === undefined) return kindLabels[kind];
  if (kind === "debt_out") return direction === "owed_to_me" ? "Дал в долг" : "Вернул долг";
  return direction === "i_owe" ? "Взял в долг" : "Мне вернули долг";
}

/** «1 операция», «2 операции», «5 операций». */
export function operationsCount(count: number): string {
  return plural(count, ["операция", "операции", "операций"]);
}

export function rubles(minor: number): string {
  return formatMoney(minor);
}

/** Направление операции в строке: сумма хранится положительной, знак принадлежит строке. */
export function kindSign(kind: TransactionKind): "+" | "−" | undefined {
  if (kind === "income" || kind === "refund" || kind === "debt_in") return "+";
  return kind === "expense" || kind === "debt_out" ? "−" : undefined;
}

/** Категория операции, если она у неё есть. Доход тоже бывает с категорией. */
export function transactionCategory(transaction: Transaction, budget: BudgetState): BudgetState["categories"][number] | undefined {
  const id = transaction.kind === "expense" || transaction.kind === "refund" || transaction.kind === "income"
    ? transaction.categoryId
    : undefined;
  return id === undefined ? undefined : budget.categories.find((item) => item.id === id);
}

/**
 * Вторая строка операции — без названия категории: оно уже стоит первой строкой, а повтор в
 * плотной строке читается как шум.
 */
export function transactionDetail(transaction: Transaction, budget: BudgetState): string {
  const account = (id: string) => budget.accounts.find((item) => item.id === id)?.name ?? "Неизвестный счёт";
  const goal = (id: string) => budget.goals.find((item) => item.id === id)?.name ?? "Неизвестная цель";
  const counterparty = (id: string) => (budget.debts ?? []).find((item) => item.id === id)?.counterparty ?? "Неизвестный долг";
  switch (transaction.kind) {
    case "income":
    case "expense": return account(transaction.accountId);
    case "refund": return `возврат расхода · ${account(transaction.accountId)}`;
    case "transfer": return `${account(transaction.fromAccountId)} → ${account(transaction.toAccountId)}`;
    case "goal_contribution": return `${account(transaction.fromAccountId)} → ${goal(transaction.goalId)}`;
    case "debt_out": return `${account(transaction.accountId)} → ${counterparty(transaction.debtId)}`;
    case "debt_in": return `${counterparty(transaction.debtId)} → ${account(transaction.accountId)}`;
  }
}
