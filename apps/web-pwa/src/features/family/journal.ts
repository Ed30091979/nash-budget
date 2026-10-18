/**
 * Изменение бюджета, переведённое в операции журнала.
 *
 * Приложение писало и пишет бюджет целиком: экран отдаёт функцию «состояние → состояние», и
 * координатор сохраняет результат сравнением ревизии. Журналу нужны операции. Этот файл —
 * единственное место, где одно превращается в другое, и он устроен как сравнение двух состояний,
 * а не как новый способ записи: ни один экран не переписан, ни одна форма не знает про журнал, и
 * обещание раздела 9 — «без входа приложение работает ровно как сейчас» — держится тем, что на
 * локальном пути этот файл просто не вызывается.
 *
 * Сравнение идёт по идентификатору сущности, а не по месту в массиве: журнал сходится по
 * `targetId`, и запись, переставленная в списке, обязана давать пустой набор операций — иначе
 * каждое открытие экрана рассылало бы семье десятки «обновлений», ничего не меняющих.
 *
 * Порядок операций внутри набора ничего не решает: слияние в `sync-protocol` от порядка не
 * зависит. Порядок здесь выбран так, чтобы читателю журнала было видно, что произошло.
 */
import type {
  Account,
  AnnualCommitment,
  Budget,
  BudgetLine,
  BudgetState,
  Category,
  Goal,
  Member,
  MemberId,
  ScheduledExpense,
  Tag,
  Transaction,
} from "@family-budget/domain";
import type { EntityKind, OperationDraft } from "@family-budget/sync-protocol";

/**
 * Разделитель составного ключа.
 *
 * Идентификатор не может нести управляющих символов — кодек отвергает их в `readId`, — поэтому
 * U+0000 не встретится ни в одной половине ключа и («budget», «1») никогда не совпадёт с
 * («budget1», «»). Пробел такого обещания не даёт.
 */
const KEY_SEPARATOR = "\u0000";

interface EntityRow {
  readonly entity: EntityKind;
  readonly targetId: string;
  readonly fields: Record<string, unknown>;
}

/** Поля без `undefined`: отсутствующее поле обязано отсутствовать, а не приходить пустым. */
function defined(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Значение с ключами по алфавиту на любой глубине; списки сохраняют свой порядок.
 *
 * Сортировки одного верхнего уровня хватало, пока вложенным значением был только список месяцев.
 * Поля волны 1 вкладывают объекты, и у объекта, собранного в другом порядке ключей, текст был бы
 * другим — правка, ничего не меняющая, рассылала бы семье «обновление».
 */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  // Объект без прототипа: имя поля — данные, и ни одно из них не может стать сеттером.
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) sorted[key] = sortedKeys(record[key]);
  return sorted;
}

/**
 * Каноническая запись полей: ключи по алфавиту на любой глубине, поэтому равные поля дают равный
 * текст. Экспортирована ради проверки вложенных значений, которых у полей этой волны пока нет.
 */
export function canonical(fields: Record<string, unknown>): string {
  return JSON.stringify(sortedKeys(fields));
}

function memberFields(member: Member): Record<string, unknown> {
  return { name: member.name, role: member.role, active: member.active };
}

function tagFields(tag: Tag): Record<string, unknown> {
  return { name: tag.name, active: tag.active };
}

/**
 * Поля оформления у счёта, категории и цели необязательны, как и метка участника: отсутствующее
 * остаётся отсутствующим, поэтому счёт без них даёт ровно те поля, что давал всегда.
 */
function accountFields(account: Account): Record<string, unknown> {
  return defined({
    name: account.name,
    type: account.type,
    currency: account.currency,
    openingBalanceMinor: account.openingBalanceMinor,
    active: account.active,
    sortOrder: account.sortOrder,
    icon: account.icon,
    color: account.color,
    includeInTotal: account.includeInTotal,
  });
}

function categoryFields(category: Category): Record<string, unknown> {
  return defined({
    name: category.name,
    type: category.type,
    group: category.group,
    active: category.active,
    sortOrder: category.sortOrder,
    icon: category.icon,
    color: category.color,
  });
}

function budgetFields(budget: Budget): Record<string, unknown> {
  return {
    startDate: budget.startDate,
    endDate: budget.endDate,
    status: budget.status,
    plannedIncomeMinor: budget.plannedIncomeMinor,
    warningThreshold: budget.warningThreshold,
  };
}

function budgetLineFields(budgetId: string, line: BudgetLine): Record<string, unknown> {
  return defined({
    budgetId,
    categoryId: line.categoryId,
    plannedMinor: line.plannedMinor,
    active: line.active,
    rolloverMinor: line.rolloverMinor,
    adjustmentMinor: line.adjustmentMinor,
  });
}

function goalFields(goal: Goal): Record<string, unknown> {
  return defined({
    name: goal.name,
    linkedAccountId: goal.linkedAccountId,
    targetMinor: goal.targetMinor,
    openingContributedMinor: goal.openingContributedMinor,
    plannedContributionMinor: goal.plannedContributionMinor,
    status: goal.status,
    deadline: goal.deadline,
    icon: goal.icon,
  });
}

function annualCommitmentFields(commitment: AnnualCommitment): Record<string, unknown> {
  return {
    name: commitment.name,
    categoryId: commitment.categoryId,
    accountId: commitment.accountId,
    dueDate: commitment.dueDate,
    amountMinor: commitment.amountMinor,
    reservedMinor: commitment.reservedMinor,
    recurrence: commitment.recurrence,
    active: commitment.active,
  };
}

function scheduledExpenseFields(expense: ScheduledExpense): Record<string, unknown> {
  return defined({
    name: expense.name,
    categoryId: expense.categoryId,
    accountId: expense.accountId,
    amountMinor: expense.amountMinor,
    dueDay: expense.dueDay,
    mode: expense.mode,
    // Кодек принимает список месяцев только у `selected_months`; у ежемесячного расхода поля нет.
    months: expense.mode === "selected_months" ? [...(expense.months ?? [])] : undefined,
    active: expense.active,
  });
}

/**
 * Поля операции по её виду, вместе с меткой участника, заметкой, метками и правилом.
 *
 * Метка на самой операции и метка в заголовке отвечают на разные вопросы: заголовок говорит, кто
 * операцию *записал*, а эта — чей это расход. Здесь переносится вторая, ровно как её держит
 * бюджет: отсутствующая остаётся отсутствующей. Заметка, метки и правило регулярной операции —
 * такие же справочные поля и переносятся так же; список меток копируется, а не передаётся ссылкой
 * на массив состояния.
 */
function transactionFields(transaction: Transaction): Record<string, unknown> {
  const base = {
    kind: transaction.kind,
    occurredOn: transaction.occurredOn,
    status: transaction.status,
    amountMinor: transaction.amountMinor,
    memberId: transaction.memberId,
    note: transaction.note,
    tagIds: transaction.tagIds === undefined ? undefined : [...transaction.tagIds],
    recurringRuleId: transaction.recurringRuleId,
  };
  switch (transaction.kind) {
    case "income":
      // Категория дохода — вторая необязательная метка операции, и переносится как первая:
      // отсутствующая остаётся отсутствующей, а не превращается в пустое поле.
      return defined({
        ...base,
        accountId: transaction.accountId,
        categoryId: transaction.categoryId,
      });
    case "expense":
      return defined({
        ...base,
        accountId: transaction.accountId,
        categoryId: transaction.categoryId,
      });
    case "refund":
      return defined({
        ...base,
        accountId: transaction.accountId,
        categoryId: transaction.categoryId,
        originalTransactionId: transaction.originalTransactionId,
      });
    case "transfer":
      return defined({
        ...base,
        fromAccountId: transaction.fromAccountId,
        toAccountId: transaction.toAccountId,
      });
    case "goal_contribution":
      return defined({
        ...base,
        fromAccountId: transaction.fromAccountId,
        toAccountId: transaction.toAccountId,
        goalId: transaction.goalId,
      });
  }
}

/** Все сущности состояния, по одному ряду на запись. */
export function budgetEntityRows(state: BudgetState): ReadonlyMap<string, EntityRow> {
  const rows = new Map<string, EntityRow>();
  const add = (entity: EntityKind, targetId: string, fields: Record<string, unknown>): void => {
    rows.set(`${entity}${KEY_SEPARATOR}${targetId}`, { entity, targetId, fields });
  };

  for (const member of state.members ?? []) add("member", member.id, memberFields(member));
  for (const tag of state.tags ?? []) add("tag", tag.id, tagFields(tag));
  for (const account of state.accounts) add("account", account.id, accountFields(account));
  for (const category of state.categories) add("category", category.id, categoryFields(category));
  for (const budget of state.budgets) {
    add("budget", budget.id, budgetFields(budget));
    for (const line of budget.lines) add("budgetLine", line.id, budgetLineFields(budget.id, line));
  }
  for (const goal of state.goals) add("goal", goal.id, goalFields(goal));
  for (const commitment of state.annualCommitments) {
    add("annualCommitment", commitment.id, annualCommitmentFields(commitment));
  }
  for (const expense of state.scheduledExpenses) {
    add("scheduledExpense", expense.id, scheduledExpenseFields(expense));
  }
  for (const transaction of state.transactions) {
    add("transaction", transaction.id, transactionFields(transaction));
  }
  return rows;
}

/**
 * Операции, переводящие журнал из `previous` в `next`.
 *
 * `previous === null` — это посев: журнал пуст, и всё состояние уходит в него созданиями. Так
 * семья, созданная на устройстве с уже набранным бюджетом, приносит этот бюджет с собой; без
 * посева второе устройство получило бы одну операцию и ни одной категории, к которой её отнести.
 *
 * `memberId` — участник этого устройства. Он попадает в заголовок каждой операции, и именно
 * оттуда на чужом экране берётся имя автора: без него автор навсегда остаётся «Без участника».
 */
export function budgetJournalDrafts(
  previous: BudgetState | null,
  next: BudgetState,
  memberId?: MemberId,
): readonly OperationDraft[] {
  const before = previous === null ? new Map<string, EntityRow>() : budgetEntityRows(previous);
  const after = budgetEntityRows(next);
  const drafts: OperationDraft[] = [];
  const author = memberId === undefined ? {} : { memberId };

  for (const [key, row] of after) {
    const old = before.get(key);
    if (old !== undefined && canonical(old.fields) === canonical(row.fields)) continue;
    drafts.push({
      ...author,
      entity: row.entity,
      action: old === undefined ? "create" : "update",
      targetId: row.targetId,
      fields: row.fields,
    } as OperationDraft);
  }

  for (const [key, row] of before) {
    if (after.has(key)) continue;
    drafts.push({
      ...author,
      entity: row.entity,
      action: "delete",
      targetId: row.targetId,
    } as OperationDraft);
  }

  // Указатель активного бюджета — отдельная операция, а не поле состояния: журнал выбирает его
  // среди активаций, чьи бюджеты в нём есть.
  if (previous === null || previous.activeBudgetId !== next.activeBudgetId) {
    drafts.push({
      ...author,
      entity: "budget",
      action: "activate",
      targetId: next.activeBudgetId,
    } as OperationDraft);
  }

  return drafts;
}
