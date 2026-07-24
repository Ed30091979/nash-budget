import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  calculateBudget,
  type BudgetState,
  type CategoryBudgetStatus,
  type Transaction,
  type TransactionKind,
} from "@family-budget/domain";
import { formatMoney } from "../../money";
import {
  archiveCategory,
  createTransaction,
  deleteTransaction,
  editTransaction,
  toOperationsErrorView,
  type TransactionDraft,
} from "./model";
import { createOperationsSubmissionGate } from "./form-state";

interface OperationsScreenProps {
  readonly budget: BudgetState;
  readonly onChange: (change: (current: BudgetState) => BudgetState) => Promise<unknown>;
  readonly onDirtyChange?: (dirty: boolean) => void;
}

type Confirmation =
  | { readonly type: "edit"; readonly id: string; readonly draft: TransactionDraft }
  | { readonly type: "delete"; readonly id: string; readonly label: string };

const PAGE_SIZE = 25;

const kindLabels: Record<TransactionKind, string> = {
  income: "Доход",
  expense: "Расход",
  refund: "Возврат",
  transfer: "Перевод",
  goal_contribution: "Взнос в цель",
};

const statusLabels: Record<CategoryBudgetStatus, string> = {
  no_plan: "Без плана",
  normal: "В норме",
  near_limit: "Почти лимит",
  exhausted: "Лимит исчерпан",
  over_limit: "Перелимит",
};

const statusIcons: Record<CategoryBudgetStatus, string> = {
  no_plan: "○",
  normal: "✓",
  near_limit: "!",
  exhausted: "!",
  over_limit: "!",
};

function rubles(minor: number): string {
  return formatMoney(minor);
}

function moneyInput(minor: number): string {
  const absolute = Math.abs(minor);
  const rublePart = Math.floor(absolute / 100);
  const kopeckPart = String(absolute % 100).padStart(2, "0");
  const formatted = kopeckPart === "00" ? String(rublePart) : `${rublePart}.${kopeckPart}`;
  return minor < 0 ? `-${formatted}` : formatted;
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function firstActiveAccount(budget: BudgetState): string {
  return budget.accounts.find((item) => item.active)?.id ?? "";
}

function firstExpenseCategory(budget: BudgetState): string {
  return budget.categories.find((item) => item.active && item.type === "expense")?.id ?? "";
}

function firstOriginalExpense(budget: BudgetState): string {
  return budget.transactions.find((item) => item.kind === "expense" && item.status === "posted")?.id ?? "";
}

function firstActiveGoal(budget: BudgetState): string {
  return budget.goals.find((item) => item.status === "active")?.id ?? "";
}

function defaultDraft(kind: TransactionKind, budget: BudgetState): TransactionDraft {
  const occurredOn = localToday();
  const accountId = firstActiveAccount(budget);
  const common = { status: "posted" as const, occurredOn, amount: "" };
  switch (kind) {
    case "income":
      return { ...common, kind, accountId };
    case "expense":
      return { ...common, kind, accountId, categoryId: firstExpenseCategory(budget) };
    case "refund":
      return { ...common, kind, accountId, originalTransactionId: firstOriginalExpense(budget) };
    case "transfer": {
      const destination = budget.accounts.find((item) => item.active && item.id !== accountId)?.id ?? "";
      return { ...common, kind, fromAccountId: accountId, toAccountId: destination };
    }
    case "goal_contribution":
      {
        const goalId = firstActiveGoal(budget);
        const toAccountId = budget.goals.find((item) => item.id === goalId)?.linkedAccountId ?? "";
        const fromAccountId = budget.accounts.find((item) => item.active && item.id !== toAccountId)?.id ?? accountId;
        return { ...common, kind, fromAccountId, toAccountId, goalId };
      }
  }
}

function draftFromTransaction(transaction: Transaction): TransactionDraft {
  const common = {
    status: transaction.status,
    occurredOn: transaction.occurredOn,
    amount: moneyInput(transaction.amountMinor),
  };
  switch (transaction.kind) {
    case "income":
      return { ...common, kind: transaction.kind, accountId: transaction.accountId };
    case "expense":
      return { ...common, kind: transaction.kind, accountId: transaction.accountId, categoryId: transaction.categoryId };
    case "refund":
      return { ...common, kind: transaction.kind, accountId: transaction.accountId, originalTransactionId: transaction.originalTransactionId };
    case "transfer":
      return { ...common, kind: transaction.kind, fromAccountId: transaction.fromAccountId, toAccountId: transaction.toAccountId };
    case "goal_contribution":
      return { ...common, kind: transaction.kind, fromAccountId: transaction.fromAccountId, toAccountId: transaction.toAccountId, goalId: transaction.goalId };
  }
}

function percentage(execution: number | null): string {
  if (execution === null) return "нет плана";
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(execution * 100)}%`;
}

function transactionContext(transaction: Transaction, budget: BudgetState): string {
  const account = (id: string) => budget.accounts.find((item) => item.id === id)?.name ?? "Неизвестный счёт";
  const category = (id: string) => budget.categories.find((item) => item.id === id)?.name ?? "Неизвестная категория";
  const goal = (id: string) => budget.goals.find((item) => item.id === id)?.name ?? "Неизвестная цель";
  switch (transaction.kind) {
    case "income": return account(transaction.accountId);
    case "expense": return `${category(transaction.categoryId)} · ${account(transaction.accountId)}`;
    case "refund": return `${category(transaction.categoryId)} · возврат расхода · ${account(transaction.accountId)}`;
    case "transfer": return `${account(transaction.fromAccountId)} → ${account(transaction.toAccountId)}`;
    case "goal_contribution": return `${account(transaction.fromAccountId)} → ${goal(transaction.goalId)}`;
  }
}

function patchDraft(draft: TransactionDraft, key: string, value: string): TransactionDraft {
  return { ...draft, [key]: value } as TransactionDraft;
}

function FieldError({ message }: { readonly message: string | null }) {
  return message ? <p className="field-error" id="operation-form-error" role="alert" tabIndex={-1}>{message}</p> : null;
}

function AccountSelect({ id, label, value, budget, onValue }: { id: string; label: string; value: string; budget: BudgetState; onValue: (value: string) => void }) {
  return <div className="field"><label htmlFor={id}>{label}</label><select id={id} value={value} onChange={(event) => onValue(event.target.value)}><option value="">Выберите счёт</option>{budget.accounts.filter((item) => item.active || item.id === value).map((item) => <option value={item.id} key={item.id}>{item.name}{item.active ? "" : " (в архиве)"}</option>)}</select></div>;
}

function TransactionFields({ budget, draft, patch }: { budget: BudgetState; draft: TransactionDraft; patch: (key: string, value: string) => void }) {
  const activeExpenses = budget.transactions.filter((item) => item.kind === "expense" && item.status === "posted");
  if (draft.kind === "income") return <AccountSelect id="operation-accountId" label="Счёт зачисления" value={draft.accountId} budget={budget} onValue={(value) => patch("accountId", value)} />;
  if (draft.kind === "expense") return <>
    <AccountSelect id="operation-accountId" label="Счёт оплаты" value={draft.accountId} budget={budget} onValue={(value) => patch("accountId", value)} />
    <div className="field"><label htmlFor="operation-categoryId">Категория расходов</label><select id="operation-categoryId" value={draft.categoryId} onChange={(event) => patch("categoryId", event.target.value)}><option value="">Выберите категорию</option>{budget.categories.filter((item) => item.type === "expense" && (item.active || item.id === draft.categoryId)).map((item) => <option value={item.id} key={item.id}>{item.name}{item.active ? "" : " (в архиве)"}</option>)}</select></div>
  </>;
  if (draft.kind === "refund") {
    const original = budget.transactions.find((item): item is Extract<Transaction, { kind: "expense" }> => item.id === draft.originalTransactionId && item.kind === "expense");
    const derivedCategory = original ? budget.categories.find((item) => item.id === original.categoryId)?.name : undefined;
    return <>
      <AccountSelect id="operation-accountId" label="Счёт возврата" value={draft.accountId} budget={budget} onValue={(value) => patch("accountId", value)} />
      <div className="field"><label htmlFor="operation-originalTransactionId">Исходный расход</label><select id="operation-originalTransactionId" value={draft.originalTransactionId} onChange={(event) => patch("originalTransactionId", event.target.value)}><option value="">Выберите расход</option>{activeExpenses.map((item) => <option value={item.id} key={item.id}>{item.occurredOn} · {rubles(item.amountMinor)} · {transactionContext(item, budget)}</option>)}</select><small>Категория определяется исходным расходом: {derivedCategory ?? "выберите расход"}.</small></div>
    </>;
  }
  if (draft.kind === "transfer") return <>
    <AccountSelect id="operation-fromAccountId" label="Со счёта" value={draft.fromAccountId} budget={budget} onValue={(value) => patch("fromAccountId", value)} />
    <AccountSelect id="operation-toAccountId" label="На счёт" value={draft.toAccountId} budget={budget} onValue={(value) => patch("toAccountId", value)} />
  </>;
  const selectedGoal = budget.goals.find((item) => item.id === draft.goalId);
  const goalAccount = selectedGoal ? budget.accounts.find((item) => item.id === selectedGoal.linkedAccountId)?.name : undefined;
  return <>
    <AccountSelect id="operation-fromAccountId" label="Со счёта" value={draft.fromAccountId} budget={budget} onValue={(value) => patch("fromAccountId", value)} />
    <div className="field"><label htmlFor="operation-goalId">Цель</label><select id="operation-goalId" value={draft.goalId} onChange={(event) => { const goalId = event.target.value; patch("goalId", goalId); patch("toAccountId", budget.goals.find((item) => item.id === goalId)?.linkedAccountId ?? ""); }}><option value="">Выберите цель</option>{budget.goals.filter((item) => item.status === "active" || item.id === draft.goalId).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><small>Счёт цели: {goalAccount ?? "выберите цель"}.</small></div>
  </>;
}

export function OperationsScreen({ budget, onChange, onDirtyChange }: OperationsScreenProps) {
  const [draft, setDraft] = useState<TransactionDraft>(() => defaultDraft("expense", budget));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const gate = useRef(createOperationsSubmissionGate());
  const pristineDraft = useMemo(() => defaultDraft(draft.kind, budget), [budget, draft.kind]);
  const dirty = editingId !== null || JSON.stringify(draft) !== JSON.stringify(pristineDraft);
  const metrics = useMemo(() => calculateBudget(budget), [budget]);
  const history = useMemo(() => [...budget.transactions].sort((left, right) => right.occurredOn.localeCompare(left.occurredOn) || right.id.localeCompare(left.id)), [budget.transactions]);
  const activeBudget = budget.budgets.find((item) => item.id === budget.activeBudgetId);
  const categoryIds = new Set(
    activeBudget?.lines
      .filter((item) => item.active !== false)
      .map((item) => item.categoryId) ?? [],
  );
  const categorySignals = budget.categories.filter((item) => item.active && item.type === "expense" && categoryIds.has(item.id));
  const usedActiveCategories = budget.categories.filter((category) => category.active && category.type === "expense" && budget.transactions.some((transaction) => (transaction.kind === "expense" || transaction.kind === "refund") && transaction.categoryId === category.id));

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => {
    onDirtyChange?.(false);
  }, [onDirtyChange]);

  const clearTransient = () => {
    setError(null);
    setConfirmation(null);
  };
  const patch = (key: string, value: string) => {
    setDraft((current) => patchDraft(current, key, value));
    clearTransient();
  };
  const chooseKind = (kind: TransactionKind) => {
    setDraft(defaultDraft(kind, budget));
    setEditingId(null);
    clearTransient();
  };
  const runChange = async (change: (current: BudgetState) => BudgetState, success: () => void) => {
    await gate.current.run(async () => {
      setBusy(true);
      setError(null);
      try {
        await onChange(change);
        success();
      } catch (cause) {
        const view = toOperationsErrorView(cause);
        setError(view.message);
        window.setTimeout(() => document.getElementById("operation-form-error")?.focus(), 0);
      } finally {
        setBusy(false);
      }
    });
  };
  const reset = (kind: TransactionKind = draft.kind) => {
    setDraft(defaultDraft(kind, budget));
    setEditingId(null);
    setConfirmation(null);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (editingId) {
      setConfirmation({ type: "edit", id: editingId, draft });
      return;
    }
    void runChange((state) => createTransaction(state, draft), () => reset(draft.kind));
  };
  const confirm = () => {
    if (!confirmation || busy) return;
    if (confirmation.type === "edit") {
      const pending = confirmation;
      void runChange((state) => editTransaction(state, pending.id, pending.draft), () => reset(pending.draft.kind));
    } else {
      const pending = confirmation;
      void runChange((state) => deleteTransaction(state, pending.id), () => { setConfirmation(null); if (editingId === pending.id) reset(); });
    }
  };
  const beginEdit = (transaction: Transaction) => {
    setDraft(draftFromTransaction(transaction));
    setEditingId(transaction.id);
    clearTransient();
    window.setTimeout(() => document.getElementById("operation-kind")?.focus(), 0);
  };
  const requestDelete = (transaction: Transaction) => {
    setConfirmation({ type: "delete", id: transaction.id, label: `${kindLabels[transaction.kind]} ${rubles(transaction.amountMinor)} от ${transaction.occurredOn}` });
    setError(null);
  };

  return <div className="operations-screen">
    <header className="screen-heading"><div><span className="card-kicker">Фактические деньги</span><h1>Операции</h1><p>Доходы, покупки, возвраты, переводы и накопления хранятся одной полной историей.</p></div></header>

    <div className="quick-grid" aria-label="Итоги бюджета">
      <article className="quick-card"><span>Доход</span><strong>{rubles(metrics.incomeMinor)}</strong></article>
      <article className="quick-card"><span>Расходы с учётом возвратов</span><strong>{rubles(metrics.expensesMinor)}</strong></article>
      <article className="quick-card"><span>Капитал</span><strong>{rubles(metrics.capitalMinor)}</strong></article>
    </div>
    <section className="section-card" aria-labelledby="account-balances-title"><h2 id="account-balances-title">Остатки на счетах</h2><dl className="summary-list">{budget.accounts.map((account) => <div key={account.id}><dt>{account.name}{account.active ? "" : " (в архиве)"}</dt><dd>{rubles(metrics.accountBalancesMinor[account.id] ?? 0)}</dd></div>)}</dl></section>

    <section className="section-card" aria-labelledby="operation-form-title">
      <h2 id="operation-form-title">{editingId ? "Редактировать операцию" : "Записать операцию"}</h2>
      <form onSubmit={submit} noValidate aria-busy={busy}>
        <fieldset disabled={busy}>
          <legend>Данные операции</legend>
          <div className="field"><label htmlFor="operation-kind">Тип</label><select id="operation-kind" value={draft.kind} disabled={Boolean(editingId)} onChange={(event) => chooseKind(event.target.value as TransactionKind)}>{Object.entries(kindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
          <div className="field"><label htmlFor="operation-occurredOn">Дата</label><input id="operation-occurredOn" type="date" value={draft.occurredOn} onChange={(event) => patch("occurredOn", event.target.value)} /></div>
          <div className="field"><label htmlFor="operation-amount">Сумма, ₽</label><input id="operation-amount" inputMode="decimal" maxLength={24} value={draft.amount} onChange={(event) => patch("amount", event.target.value)} /></div>
          <TransactionFields budget={budget} draft={draft} patch={patch} />
          <FieldError message={error} />
          <button className="primary-button" type="submit" disabled={busy} aria-busy={busy} aria-label={editingId ? "Проверить изменения операции" : `Сохранить операцию «${kindLabels[draft.kind]}»`}>{editingId ? "Проверить изменения" : "Сохранить"}</button>
          {editingId ? <button className="secondary-button" type="button" aria-label="Отменить редактирование операции" onClick={() => reset()}>Отмена</button> : null}
          {!editingId && dirty ? <button className="secondary-button" type="button" onClick={() => reset()}>Очистить черновик</button> : null}
        </fieldset>
      </form>
      {confirmation ? <div className="limit-alert" role="alertdialog" aria-labelledby="operation-confirmation-title">
        <b id="operation-confirmation-title">{confirmation.type === "edit" ? "Подтвердить изменение операции?" : "Удалить операцию?"}</b>
        <span>{confirmation.type === "edit" ? "После сохранения все суммы и лимиты будут пересчитаны." : `${confirmation.label}. Все суммы и лимиты будут пересчитаны.`}</span>
        <button className="primary-button" type="button" disabled={busy} aria-busy={busy} onClick={confirm}>{confirmation.type === "edit" ? "Подтвердить изменения" : "Подтвердить удаление"}</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirmation(null)}>Не менять</button>
      </div> : null}
    </section>

    <section className="section-card" aria-labelledby="limit-signals-title"><h2 id="limit-signals-title">Сигналы лимитов</h2><div className="plan-list">{categorySignals.map((category) => {
      const metric = metrics.categoryMetrics[category.id];
      if (!metric) return null;
      return <article className="plan-row" role="status" aria-label={`${category.name}: ${statusLabels[metric.status]}, использовано ${rubles(metric.actualMinor)} из ${rubles(metric.availableMinor)}, ${percentage(metric.execution)}`} key={category.id}><span className={`status-chip ${metric.status}`}><i aria-hidden="true">{statusIcons[metric.status]}</i> {statusLabels[metric.status]}</span><div><strong>{category.name}{category.active ? "" : " (в архиве)"}</strong><small>Использовано {rubles(metric.actualMinor)} из {rubles(metric.availableMinor)} · {percentage(metric.execution)}</small></div><p><b>{metric.status === "over_limit" ? `+${rubles(metric.overMinor)}` : rubles(metric.remainingMinor)}</b><span>{metric.status === "over_limit" ? "сверх лимита" : "осталось"}</span></p></article>;
    })}</div></section>

    {usedActiveCategories.length ? <section className="section-card" aria-labelledby="used-categories-title"><h2 id="used-categories-title">Использованные категории</h2><p>Архив скрывает категорию из новых операций, но сохраняет её в истории и расчётах.</p><ul className="planning-edit-list">{usedActiveCategories.map((category) => <li key={category.id}><strong>{category.name}</strong><button className="text-button" type="button" disabled={busy} aria-label={`Архивировать использованную категорию «${category.name}»`} onClick={() => void runChange((state) => archiveCategory(state, category.id), () => undefined)}>В архив</button></li>)}</ul></section> : null}

    <section className="section-card" aria-labelledby="operations-history-title"><h2 id="operations-history-title">Полная история</h2>{history.length ? <ul className="planning-edit-list">{history.slice(0, visibleCount).map((transaction) => <li key={transaction.id}><div><strong>{kindLabels[transaction.kind]} · {rubles(transaction.amountMinor)}</strong><span>{transaction.occurredOn} · {transactionContext(transaction, budget)}</span></div><button className="secondary-button" type="button" disabled={busy} aria-label={`Изменить операцию «${kindLabels[transaction.kind]} ${rubles(transaction.amountMinor)} от ${transaction.occurredOn}»`} onClick={() => beginEdit(transaction)}>Изменить</button><button className="text-button" type="button" disabled={busy} aria-label={`Удалить операцию «${kindLabels[transaction.kind]} ${rubles(transaction.amountMinor)} от ${transaction.occurredOn}»`} onClick={() => requestDelete(transaction)}>Удалить</button></li>)}</ul> : <p>Операций пока нет.</p>}{visibleCount < history.length ? <button className="secondary-button" type="button" disabled={busy} aria-label={`Показать ещё операции, осталось ${history.length - visibleCount}`} onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>Показать ещё ({history.length - visibleCount})</button> : null}<p role="status">Показано {Math.min(visibleCount, history.length)} из {history.length}</p></section>
  </div>;
}
