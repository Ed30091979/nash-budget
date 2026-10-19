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
  Debt,
  ExchangeRate,
  Goal,
  Household,
  Member,
  MemberId,
  RecurringRule,
  RecurringTemplate,
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
 * текст. Экспортирована ради проверки вложенных значений — курса, снимка и шаблона правила.
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

/** Курс копируется целиком, вместе с вложенной парой чисел, а не ссылкой на объект состояния. */
function exchangeRateFields(rate: ExchangeRate): Record<string, unknown> {
  return {
    currency: rate.currency,
    baseCurrency: rate.baseCurrency,
    date: rate.date,
    rate: { baseMinor: rate.rate.baseMinor, quoteMinor: rate.rate.quoteMinor },
  };
}

/** Дни выплат (D-039) необязательны: хозяйство без них уходит в журнал без поля, как прежде. */
function householdFields(household: Household): Record<string, unknown> {
  return household.paydays === undefined
    ? { baseCurrency: household.baseCurrency }
    : { baseCurrency: household.baseCurrency, paydays: [...household.paydays] };
}

/** Срок долга необязателен, и отсутствующий остаётся отсутствующим. */
function debtFields(debt: Debt): Record<string, unknown> {
  return defined({
    counterparty: debt.counterparty,
    direction: debt.direction,
    currency: debt.currency,
    openingMinor: debt.openingMinor,
    dueDate: debt.dueDate,
    active: debt.active,
  });
}

/** Шаблон правила: поля операции своего вида, без идентификатора и даты; метки — копией списка. */
function templateFields(template: RecurringTemplate): Record<string, unknown> {
  const base = {
    kind: template.kind,
    amountMinor: template.amountMinor,
    note: template.note,
    tagIds: template.tagIds === undefined ? undefined : [...template.tagIds],
  };
  switch (template.kind) {
    case "expense":
      return defined({ ...base, accountId: template.accountId, categoryId: template.categoryId });
    case "income":
      return defined({ ...base, accountId: template.accountId, categoryId: template.categoryId });
    case "transfer":
      return defined({
        ...base,
        fromAccountId: template.fromAccountId,
        toAccountId: template.toAccountId,
        toAmountMinor: template.toAmountMinor,
      });
  }
}

/**
 * Правило регулярной операции с вложенным шаблоном. Водяной знак — обычное поле: его сдвиг после
 * материализации уходит в журнал обновлением правила, и второе устройство не пишет закрытые дни.
 */
function recurringRuleFields(rule: RecurringRule): Record<string, unknown> {
  return defined({
    name: rule.name,
    template: templateFields(rule.template),
    frequency: rule.frequency,
    interval: rule.interval,
    startDate: rule.startDate,
    endDate: rule.endDate,
    materializedThrough: rule.materializedThrough,
    active: rule.active,
  });
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
  // Сумма в базовой валюте у операции по счёту в другой валюте — три поля вместе или ни одного;
  // отсутствующие остаются отсутствующими, курс копируется, а не передаётся ссылкой.
  const snapshot = (item: Extract<Transaction, { readonly kind: "income" | "expense" | "refund" }>) => ({
    baseAmountMinor: item.baseAmountMinor,
    baseCurrency: item.baseCurrency,
    rate: item.rate === undefined ? undefined : { baseMinor: item.rate.baseMinor, quoteMinor: item.rate.quoteMinor },
  });
  switch (transaction.kind) {
    case "income":
      // Категория дохода — вторая необязательная метка операции, и переносится как первая:
      // отсутствующая остаётся отсутствующей, а не превращается в пустое поле.
      return defined({
        ...base,
        ...snapshot(transaction),
        accountId: transaction.accountId,
        categoryId: transaction.categoryId,
      });
    case "expense":
      return defined({
        ...base,
        ...snapshot(transaction),
        accountId: transaction.accountId,
        categoryId: transaction.categoryId,
      });
    case "refund":
      return defined({
        ...base,
        ...snapshot(transaction),
        accountId: transaction.accountId,
        categoryId: transaction.categoryId,
        originalTransactionId: transaction.originalTransactionId,
      });
    case "transfer":
      return defined({
        ...base,
        fromAccountId: transaction.fromAccountId,
        toAccountId: transaction.toAccountId,
        toAmountMinor: transaction.toAmountMinor,
      });
    case "goal_contribution":
      return defined({
        ...base,
        fromAccountId: transaction.fromAccountId,
        toAccountId: transaction.toAccountId,
        goalId: transaction.goalId,
      });
    case "debt_out":
    case "debt_in":
      // Сумма в валюте долга есть, только когда валюта счёта другая; отсутствующая отсутствует.
      return defined({
        ...base,
        accountId: transaction.accountId,
        debtId: transaction.debtId,
        debtAmountMinor: transaction.debtAmountMinor,
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
  if (state.household !== undefined) add("household", state.household.id, householdFields(state.household));
  for (const rate of state.exchangeRates ?? []) add("exchangeRate", rate.id, exchangeRateFields(rate));
  for (const debt of state.debts ?? []) add("debt", debt.id, debtFields(debt));
  for (const rule of state.recurringRules ?? []) add("recurringRule", rule.id, recurringRuleFields(rule));
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
    // Хозяйство не удаляется — кодек отвергает такую операцию; база остаётся той, что в журнале.
    if (row.entity === "household") continue;
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
