import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  calculateBudget,
  type BudgetState,
  type CategoryBudgetStatus,
  type CategoryType,
  type Transaction,
  type TransactionKind,
} from "@family-budget/domain";
import { Icon, type IconName } from "../../components/Icon";
import { Money } from "../../components/Money";
import { MoneyOdometer } from "../../components/MoneyOdometer";
import { categoryVisual } from "../../category-visual";
import { searchOperations } from "../dashboard";
import { formatMoney, parseMoney } from "../../money";
import { effectLabel, effectTarget, effectValueMinor, type EffectTarget } from "./save-receipt";
import {
  archiveCategory,
  createOperationCategory,
  createTransaction,
  deleteTransaction,
  editTransaction,
  restoreCategory,
  toOperationsErrorView,
  type TransactionDraft,
} from "./model";
import { createOperationsSubmissionGate } from "./form-state";
import { categoryPickerView, CUSTOM_CATEGORY_VALUE } from "./category-picker";
import { CategorySheet, CATEGORY_SHEET_ERROR_ID, type CategorySheetDraft } from "./CategorySheet";

interface OperationsScreenProps {
  readonly budget: BudgetState;
  readonly onChange: (change: (current: BudgetState) => BudgetState) => Promise<unknown>;
  readonly onDirtyChange?: (dirty: boolean) => void;
  /**
   * Прямой путь из пустого состояния «Категории месяца»: лимиты задают в плане.
   *
   * Необязателен: экран, вставленный без навигации, посылать человека некуда, и мёртвая кнопка
   * была бы хуже её отсутствия. Приложение его передаёт всегда.
   */
  readonly onPlanning?: () => void;
}

/**
 * Отклик на запись (§5 исследования, пункты 27–28).
 *
 * Самое частое действие приложения проходило молча: форма очищалась, и всё. Человек не узнавал ни
 * того, записалось ли, ни того, что от этого изменилось. Квитанция отвечает на оба вопроса сразу:
 * называет записанное и показывает число, которое от записи поехало, — одометром, чтобы движение
 * объяснило, что оно изменилось, и на сколько.
 */
interface SaveReceipt {
  readonly verb: "Записано" | "Изменено" | "Удалено";
  readonly kind: TransactionKind;
  readonly amountMinor: number;
  /** Чьё число объявляем; `null` — объявлять нечего, и тогда квитанция называет только запись. */
  readonly target: EffectTarget | null;
  /** Значение до изменения: одометр едет от него, а подпись называет разницу. */
  readonly beforeMinor: number;
}

type Confirmation =
  | { readonly type: "edit"; readonly id: string; readonly draft: TransactionDraft }
  | { readonly type: "delete"; readonly id: string; readonly label: string };

const PAGE_SIZE = 25;

/**
 * Образец суммы в поле высотой 68 (§6).
 *
 * Поле уже подписано «Сумма, ₽», поэтому подсказка не повторяет имя поля, а показывает число:
 * пустая коробка в кегль `display` читалась провалом в вёрстке, а не местом для суммы. Образец
 * набран ровно так, как поле принимает и хранит введённое, — без отбивки разрядов (её в поле
 * никто не расставит) и с запятой перед копейками (§7: десятичный разделитель — запятая).
 * Показывает и то, что копейки допустимы, и что их можно не писать.
 *
 * Чтобы образец нельзя было принять за уже введённую сумму, он набран начертанием 400 против 700
 * у значения: эмфаза весом на одном кегле (§2 исследования).
 */
const AMOUNT_PLACEHOLDER = "1200,50";

/** Квитанция записи: её же подводят под глаз после сохранения. */
export const SAVE_RECEIPT_ID = "operation-save-receipt";

/**
 * «1 операция», «2 операции», «5 операций».
 *
 * Число в русской строке склоняет за собой существительное, и «Всего в истории 4» без него
 * читается обрывком. Правило то же, что у любого счётного слова: одиннадцать–четырнадцать —
 * исключение из хвоста.
 */
export function operationsCount(count: number): string {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return `${count} операций`;
  if (last === 1) return `${count} операция`;
  if (last >= 2 && last <= 4) return `${count} операции`;
  return `${count} операций`;
}

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

// §6: состояние лимита рисует глиф из спрайта. Цвет плитки не единственный носитель смысла —
// рядом стоит статус-чип словами, а вся строка объявлена через `aria-label`.
const statusIcons: Record<CategoryBudgetStatus, IconName> = {
  no_plan: "circle-dashed",
  normal: "circle-check",
  near_limit: "triangle-alert",
  exhausted: "triangle-alert",
  over_limit: "circle-alert",
};

// §6: вид операции рисует тот же глиф, что и на «Сегодня» — один смысл, один глиф.
// Он достаётся только строке без категории: у категорийной строки плитку занимает категория.
const kindIcons: Record<TransactionKind, IconName> = {
  income: "arrow-down-left",
  expense: "arrow-up-right",
  refund: "rotate-ccw",
  transfer: "arrow-left-right",
  goal_contribution: "target",
};

/** Направление операции в строке: сумма хранится положительной, знак принадлежит строке. */
function kindSign(kind: TransactionKind): "+" | "−" | undefined {
  if (kind === "income" || kind === "refund") return "+";
  return kind === "expense" ? "−" : undefined;
}

/** Категория операции, если она у неё есть. Доход тоже бывает с категорией. */
function transactionCategory(transaction: Transaction, budget: BudgetState): BudgetState["categories"][number] | undefined {
  const id = transaction.kind === "expense" || transaction.kind === "refund" || transaction.kind === "income"
    ? transaction.categoryId
    : undefined;
  return id === undefined ? undefined : budget.categories.find((item) => item.id === id);
}

/**
 * Вторая строка операции — без названия категории: оно уже стоит первой строкой, а повтор в
 * плотной строке читается как шум.
 */
function transactionDetail(transaction: Transaction, budget: BudgetState): string {
  const account = (id: string) => budget.accounts.find((item) => item.id === id)?.name ?? "Неизвестный счёт";
  const goal = (id: string) => budget.goals.find((item) => item.id === id)?.name ?? "Неизвестная цель";
  switch (transaction.kind) {
    case "income":
    case "expense": return account(transaction.accountId);
    case "refund": return `возврат расхода · ${account(transaction.accountId)}`;
    case "transfer": return `${account(transaction.fromAccountId)} → ${account(transaction.toAccountId)}`;
    case "goal_contribution": return `${account(transaction.fromAccountId)} → ${goal(transaction.goalId)}`;
  }
}

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
      return { ...common, kind, accountId, categoryId: "" };
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
      return { ...common, kind: transaction.kind, accountId: transaction.accountId, categoryId: transaction.categoryId ?? "" };
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
    case "income": return transaction.categoryId === undefined
      ? account(transaction.accountId)
      : `${category(transaction.categoryId)} · ${account(transaction.accountId)}`;
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

/**
 * Квитанция записи: что записано и что от этого изменилось.
 *
 * Живая область здесь одна на всю карточку и объявляет итог, а не промежуточные цифры одометра
 * (§5 исследования, пункт 27): сам одометр `aria-hidden`, а произносимая строка собрана рядом
 * целиком и меняется один раз — вместе с квитанцией.
 *
 * Стоит над кнопкой сохранения, а не поверх экрана: плавающая плашка накрывает то, что под ней,
 * и ровно этим уже провинился тост «готово к работе офлайн». Квитанция занимает своё место в
 * потоке и ничего не закрывает.
 */
function SaveReceiptView({ receipt, afterMinor }: { readonly receipt: SaveReceipt; readonly afterMinor: number | null }) {
  const label = receipt.target ? effectLabel(receipt.target) : null;
  const changeMinor = afterMinor === null ? 0 : afterMinor - receipt.beforeMinor;
  const spokenValue = afterMinor === null
    ? ""
    : `${rubles(afterMinor)}${changeMinor === 0 ? "" : `, ${changeMinor < 0 ? "меньше" : "больше"} на ${rubles(Math.abs(changeMinor))}`}`;
  return <div className="save-receipt" id={SAVE_RECEIPT_ID} role="status" aria-live="polite" aria-atomic="true">
    <span className="save-receipt-mark" aria-hidden="true"><Icon name="circle-check" size={24} /></span>
    <div className="save-receipt-copy">
      <strong>{receipt.verb}: {kindLabels[receipt.kind].toLowerCase()} <Money value={receipt.amountMinor} /></strong>
      {label !== null && afterMinor !== null ? <>
        <small>{label}</small>
        <span className="save-receipt-value">
          <MoneyOdometer from={receipt.beforeMinor} to={afterMinor} />
          {changeMinor === 0 ? null : <span className="save-receipt-change" aria-hidden="true"><Money value={Math.abs(changeMinor)} sign={changeMinor < 0 ? "−" : "+"} /></span>}
          {/* Цифры одометра скрыты от чтения вслух, поэтому итог и разницу произносит эта строка. */}
          <span className="sr-only">{spokenValue}</span>
        </span>
      </> : null}
    </div>
  </div>;
}

function AccountSelect({ id, label, value, budget, onValue }: { id: string; label: string; value: string; budget: BudgetState; onValue: (value: string) => void }) {
  return <div className="field"><label htmlFor={id}>{label}</label><select id={id} value={value} onChange={(event) => onValue(event.target.value)}><option value="">Выберите счёт</option>{budget.accounts.filter((item) => item.active || item.id === value).map((item) => <option value={item.id} key={item.id}>{item.name}{item.active ? "" : " (в архиве)"}</option>)}</select></div>;
}

interface CategoryFieldProps {
  readonly label: string;
  readonly type: CategoryType;
  readonly budget: BudgetState;
  readonly value: string;
  readonly query: string;
  readonly optional: boolean;
  readonly onQuery: (value: string) => void;
  readonly onValue: (value: string) => void;
  readonly onCustom: (name: string) => void;
}

/**
 * Выбор категории: поиск, заголовки групп и «Своя категория» последним элементом.
 *
 * Поиск стоит над списком, а не вместо него. Пятнадцать расходных категорий — уже та стена,
 * из-за которой «приходится всё время мотать»; поле фильтра сужает список на месте, а когда не
 * находит ничего, последний элемент называет набранное: «Создать «‹текст›»». Выбранная категория
 * остаётся в списке при любом фильтре и даже из архива — список, из которого исчезло собственное
 * значение, врал бы о том, что выбрано.
 */
function CategoryField({ label, type, budget, value, query, optional, onQuery, onValue, onCustom }: CategoryFieldProps) {
  const view = categoryPickerView(budget, type, query, value === "" ? undefined : value);
  return <div className="field category-field">
    <label htmlFor="operation-category-search">Поиск по категориям</label>
    <input
      id="operation-category-search"
      type="search"
      autoComplete="off"
      maxLength={80}
      placeholder="Начните вводить название"
      value={query}
      aria-describedby="operation-category-status"
      onChange={(event) => onQuery(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
    />
    <p className="field-hint" id="operation-category-status" role="status">{view.status}</p>
    <label htmlFor="operation-categoryId">{label}</label>
    <select
      id="operation-categoryId"
      value={value}
      onChange={(event) => {
        if (event.target.value === CUSTOM_CATEGORY_VALUE) onCustom(view.createName);
        else onValue(event.target.value);
      }}
    >
      <option value="">{optional ? "Без категории" : "Выберите категорию"}</option>
      {view.groups.map((group) => <optgroup label={group.title} key={group.key}>
        {group.options.map((option) => <option value={option.id} key={option.id}>{option.name}{option.archived ? " (в архиве)" : ""}</option>)}
      </optgroup>)}
      <option value={CUSTOM_CATEGORY_VALUE}>{view.createLabel}</option>
    </select>
  </div>;
}

function TransactionFields({ budget, draft, patch, categoryQuery, onCategoryQuery, onCustomCategory }: { budget: BudgetState; draft: TransactionDraft; patch: (key: string, value: string) => void; categoryQuery: string; onCategoryQuery: (value: string) => void; onCustomCategory: (name: string, type: CategoryType) => void }) {
  const activeExpenses = budget.transactions.filter((item) => item.kind === "expense" && item.status === "posted");
  if (draft.kind === "income") return <>
    <AccountSelect id="operation-accountId" label="Счёт зачисления" value={draft.accountId} budget={budget} onValue={(value) => patch("accountId", value)} />
    <CategoryField label="Категория дохода — не обязательно" type="income" budget={budget} value={draft.categoryId} query={categoryQuery} optional onQuery={onCategoryQuery} onValue={(value) => patch("categoryId", value)} onCustom={(name) => onCustomCategory(name, "income")} />
  </>;
  // Категория стоит раньше счёта: у расхода спрашивают «на что», счёт же почти всегда один и
  // подставлен заранее. Порядок полей — это и есть порядок вопросов.
  if (draft.kind === "expense") return <>
    <CategoryField label="Категория расходов" type="expense" budget={budget} value={draft.categoryId} query={categoryQuery} optional={false} onQuery={onCategoryQuery} onValue={(value) => patch("categoryId", value)} onCustom={(name) => onCustomCategory(name, "expense")} />
    <AccountSelect id="operation-accountId" label="Счёт оплаты" value={draft.accountId} budget={budget} onValue={(value) => patch("accountId", value)} />
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

export function OperationsScreen({ budget, onChange, onDirtyChange, onPlanning }: OperationsScreenProps) {
  const [draft, setDraft] = useState<TransactionDraft>(() => defaultDraft("expense", budget));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SaveReceipt | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Фильтр истории — тоже не часть черновика: он ничего не записывает.
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyKind, setHistoryKind] = useState<TransactionKind | "all">("all");
  // Строка поиска живёт отдельно от черновика: она ничего не записывает и не делает форму грязной.
  const [categoryQuery, setCategoryQuery] = useState("");
  const [sheet, setSheet] = useState<CategorySheetDraft | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const gate = useRef(createOperationsSubmissionGate());
  const pristineDraft = useMemo(() => defaultDraft(draft.kind, budget), [budget, draft.kind]);
  const dirty = editingId !== null || JSON.stringify(draft) !== JSON.stringify(pristineDraft);
  const metrics = useMemo(() => calculateBudget(budget), [budget]);
  /**
   * Один список операций вместо двух. Раньше экран показывал полную историю и отдельным блоком
   * поиск по тем же операциям — две ленты об одном и том же, полтора экрана прокрутки. Теперь
   * поиск фильтрует саму историю, а «Показать ещё» по-прежнему держит разметку ограниченной:
   * даже на пятидесяти тысячах операций в DOM попадают только видимые строки.
   */
  const filtered = useMemo(
    () => searchOperations(budget, { query: historyQuery, kind: historyKind }),
    [budget, historyKind, historyQuery],
  );
  const filtering = historyQuery.trim().length > 0 || historyKind !== "all";
  const activeBudget = budget.budgets.find((item) => item.id === budget.activeBudgetId);
  const categoryIds = new Set(
    activeBudget?.lines
      .filter((item) => item.active !== false)
      .map((item) => item.categoryId) ?? [],
  );
  /**
   * Одна секция вместо двух. «Сигналы лимитов» и «Использованные категории» перечисляли одни и
   * те же категории с разных сторон: первая — те, у кого есть строка плана, вторая — те, по кому
   * есть операции. Здесь они объединены: у строки с планом есть состояние лимита, у остальных —
   * только история и кнопка «В архив». Категория без плана не объявляется как `status`: сообщать
   * нечего, а роль обещала бы состояние, которого нет.
   */
  const spentByCategory = new Map<string, number>();
  for (const transaction of budget.transactions) {
    if (transaction.kind !== "expense" && transaction.kind !== "refund") continue;
    const previous = spentByCategory.get(transaction.categoryId) ?? 0;
    spentByCategory.set(transaction.categoryId, previous + 1);
  }
  const categoryRows = budget.categories
    .filter((item) => item.active && item.type === "expense" && (categoryIds.has(item.id) || spentByCategory.has(item.id)))
    .map((category) => ({
      category,
      metric: categoryIds.has(category.id) ? metrics.categoryMetrics[category.id] : undefined,
    }));
  /**
   * Категории, которые можно убрать из новых операций. Действие редкое и управляющее, поэтому оно
   * свёрнуто под самим списком, а не повторяет его кнопкой в каждой строке: строка от этого росла
   * вдвое, а список категорий — на целый экран.
   */
  const archivable = budget.categories.filter((category) => category.active && category.type === "expense" && spentByCategory.has(category.id));

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
    setCategoryQuery("");
    setSheet(null);
    setSheetError(null);
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
        // Квитанция утверждает, что запись прошла. Рядом с сообщением об ошибке это ложь.
        setReceipt(null);
        window.setTimeout(() => document.getElementById("operation-form-error")?.focus(), 0);
      } finally {
        setBusy(false);
      }
    });
  };
  /**
   * Собирает квитанцию по черновику и расчёту, снятому до изменения.
   *
   * Число «до» берётся из этого же рендера — то есть из состояния бюджета, каким оно было в момент
   * нажатия. Число «после» квитанция не хранит вовсе: его каждый раз читает разметка из свежего
   * расчёта, поэтому чужая запись, пришедшая из журнала семьи, подвинет и его.
   */
  const recordReceipt = (verb: SaveReceipt["verb"], pending: TransactionDraft) => {
    let amountMinor = 0;
    try {
      amountMinor = parseMoney(pending.amount);
    } catch {
      // Сумму уже принял домен: сюда попадает только то, что разобралось. Ноль — на всякий случай.
    }
    const target = effectTarget(budget, metrics, pending);
    setReceipt({
      verb,
      kind: pending.kind,
      amountMinor,
      target,
      beforeMinor: target === null ? 0 : effectValueMinor(metrics, target),
    });
    // Кнопку сохранения нажимают у нижнего края экрана, и появившаяся над ней квитанция уезжает
    // под навигацию вместе с самой кнопкой. Отклик, которого не видно, — это тот же молчащий
    // экран, поэтому квитанцию подводят под глаз: она встаёт посреди экрана, а кнопка остаётся
    // под ней. Прокрутка мгновенная и уважает `prefers-reduced-motion` по умолчанию платформы.
    window.setTimeout(() => document.getElementById(SAVE_RECEIPT_ID)?.scrollIntoView({ block: "center" }), 0);
  };
  const reset = (kind: TransactionKind = draft.kind) => {
    setDraft(defaultDraft(kind, budget));
    setEditingId(null);
    setConfirmation(null);
    setCategoryQuery("");
    setSheet(null);
    setSheetError(null);
  };

  /**
   * Лист создания категории поверх формы. Черновик операции не трогается ничем из этого —
   * сумма, дата и счёт остаются ровно там, где их оставил человек, и после сохранения к ним
   * добавляется только выбранная категория.
   */
  const openCategorySheet = (name: string, type: CategoryType) => {
    setSheet({ name, type, group: type === "income" ? "income" : "everyday", limit: "" });
    setSheetError(null);
    setConfirmation(null);
  };
  const closeCategorySheet = () => {
    setSheet(null);
    setSheetError(null);
    window.setTimeout(() => document.getElementById("operation-categoryId")?.focus(), 0);
  };
  const selectCategory = (id: string) => {
    setDraft((current) => patchDraft(current, "categoryId", id));
    setCategoryQuery("");
    clearTransient();
    closeCategorySheet();
  };
  const runCategoryChange = (change: (current: BudgetState) => BudgetState, done: () => void) => {
    void gate.current.run(async () => {
      setBusy(true);
      setSheetError(null);
      try {
        await onChange(change);
        done();
      } catch (cause) {
        setSheetError(toOperationsErrorView(cause).message);
        window.setTimeout(() => document.getElementById(CATEGORY_SHEET_ERROR_ID)?.focus(), 0);
      } finally {
        setBusy(false);
      }
    });
  };
  const saveCategory = () => {
    const pending = sheet;
    if (!pending || busy) return;
    let createdId = "";
    runCategoryChange(
      (state) => {
        const result = createOperationCategory(state, pending);
        createdId = result.categoryId;
        return result.state;
      },
      () => selectCategory(createdId),
    );
  };
  const restoreArchivedCategory = (id: string) => {
    if (busy) return;
    runCategoryChange((state) => restoreCategory(state, id), () => selectCategory(id));
  };
  const editingTransaction = editingId === null ? undefined : budget.transactions.find((item) => item.id === editingId);
  const editingLabel = editingTransaction
    ? `${kindLabels[editingTransaction.kind]} ${rubles(editingTransaction.amountMinor)} от ${editingTransaction.occurredOn}`
    : "";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (editingId) {
      setConfirmation({ type: "edit", id: editingId, draft });
      return;
    }
    const pending = draft;
    void runChange((state) => createTransaction(state, pending), () => { recordReceipt("Записано", pending); reset(pending.kind); });
  };
  const confirm = () => {
    if (!confirmation || busy) return;
    if (confirmation.type === "edit") {
      const pending = confirmation;
      void runChange((state) => editTransaction(state, pending.id, pending.draft), () => { recordReceipt("Изменено", pending.draft); reset(pending.draft.kind); });
    } else {
      const pending = confirmation;
      const removed = budget.transactions.find((item) => item.id === pending.id);
      void runChange((state) => deleteTransaction(state, pending.id), () => {
        if (removed) recordReceipt("Удалено", draftFromTransaction(removed));
        setConfirmation(null);
        if (editingId === pending.id) reset();
      });
    }
  };
  const beginEdit = (transaction: Transaction) => {
    setDraft(draftFromTransaction(transaction));
    setEditingId(transaction.id);
    // Квитанция отвечала на прошлую запись; над формой, открывшей чужую операцию, она врёт.
    setReceipt(null);
    clearTransient();
    window.setTimeout(() => document.getElementById("operation-amount")?.focus(), 0);
  };
  const requestDelete = (transaction: Transaction) => {
    setConfirmation({ type: "delete", id: transaction.id, label: `${kindLabels[transaction.kind]} ${rubles(transaction.amountMinor)} от ${transaction.occurredOn}` });
    setError(null);
  };

  return <div className="operations-screen">
    {/* §8: экран «Записать» — это форма. Она стоит первой, а всё, что подтверждает и объясняет
        запись, идёт под ней. Заголовок экрана — заголовок самой формы: второго на экране нет,
        и читающему с экрана не приходится слушать одно название дважды. */}
    <section className="section-card" aria-labelledby="operation-form-title">
      <h1 id="operation-form-title">{editingId ? "Редактировать операцию" : "Записать операцию"}</h1>
      {/* Пока лист открыт, форма под ним выключена из фокуса и из дерева доступности: лист
          модальный, и Tab не должен уводить в поля, которые он собой закрывает. */}
      <form onSubmit={submit} noValidate aria-busy={busy} inert={sheet !== null}>
        <fieldset disabled={busy}>
          <legend>Данные операции</legend>
          <div className="field amount-field"><label htmlFor="operation-amount">Сумма, ₽</label><input id="operation-amount" inputMode="decimal" maxLength={24} placeholder={AMOUNT_PLACEHOLDER} value={draft.amount} onChange={(event) => patch("amount", event.target.value)} /></div>
          <div className="field"><label htmlFor="operation-kind">Тип</label><select id="operation-kind" value={draft.kind} disabled={Boolean(editingId)} onChange={(event) => chooseKind(event.target.value as TransactionKind)}>{Object.entries(kindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
          <TransactionFields budget={budget} draft={draft} patch={patch} categoryQuery={categoryQuery} onCategoryQuery={setCategoryQuery} onCustomCategory={openCategorySheet} />
          <div className="field"><label htmlFor="operation-occurredOn">Дата</label><input id="operation-occurredOn" type="date" value={draft.occurredOn} onChange={(event) => patch("occurredOn", event.target.value)} /></div>
          <FieldError message={error} />
          {receipt ? <SaveReceiptView receipt={receipt} afterMinor={receipt.target === null ? null : effectValueMinor(metrics, receipt.target)} /> : null}
          <button className="primary-button" type="submit" disabled={busy} aria-busy={busy} aria-label={editingId ? "Проверить изменения операции" : `Сохранить операцию «${kindLabels[draft.kind]}»`}>{editingId ? "Проверить изменения" : "Сохранить"}</button>
          {editingId ? <button className="secondary-button" type="button" aria-label="Отменить редактирование операции" onClick={() => reset()}>Отмена</button> : null}
          {/* Удаление живёт здесь, а не в каждой строке списка: разрушающее действие не должно
              стоять под пальцем при пролистывании истории. */}
          {editingTransaction ? <button className="secondary-button danger-button" type="button" disabled={busy} aria-label={`Удалить операцию «${editingLabel}»`} onClick={() => requestDelete(editingTransaction)}>Удалить</button> : null}
          {!editingId && dirty ? <button className="secondary-button" type="button" onClick={() => reset()}>Очистить черновик</button> : null}
        </fieldset>
      </form>
      {sheet ? <CategorySheet
        budget={budget}
        draft={sheet}
        busy={busy}
        error={sheetError}
        onPatch={(patch) => setSheet((current) => current ? { ...current, ...patch } : current)}
        onSave={saveCategory}
        onCancel={closeCategorySheet}
        onSelectExisting={selectCategory}
        onRestore={restoreArchivedCategory}
      /> : null}
      {confirmation ? <div className="limit-alert" role="alertdialog" aria-labelledby="operation-confirmation-title">
        <b id="operation-confirmation-title">{confirmation.type === "edit" ? "Подтвердить изменение операции?" : "Удалить операцию?"}</b>
        <span>{confirmation.type === "edit" ? "После сохранения все суммы и лимиты будут пересчитаны." : `${confirmation.label}. Все суммы и лимиты будут пересчитаны.`}</span>
        <button className="primary-button" type="button" disabled={busy} aria-busy={busy} onClick={confirm}>{confirmation.type === "edit" ? "Подтвердить изменения" : "Подтвердить удаление"}</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirmation(null)}>Не менять</button>
      </div> : null}
    </section>

    {/* §1: одна секция вместо двух списков одних и тех же категорий. Строка — две строки текста
        и плитка: название с состоянием и одна строка чисел. Проценты остаются в объявлении для
        читающих с экрана, а глазу в плотном списке важнее «сколько осталось». */}
    <section className="section-card" aria-labelledby="category-signals-title"><h2 id="category-signals-title">Категории месяца</h2><div className="plan-list">{categoryRows.map(({ category, metric }) => {
      const visual = categoryVisual(category);
      const planned = metric !== undefined;
      const over = planned && metric.status === "over_limit";
      return <article className="plan-row signal-row" role={planned ? "status" : undefined} aria-label={planned ? `${category.name}: ${statusLabels[metric.status]}, использовано ${rubles(metric.actualMinor)} из ${rubles(metric.availableMinor)}, ${percentage(metric.execution)}` : undefined} key={category.id}>
        <span className={`plan-icon tone-${visual.tone}`}><Icon name={visual.icon} size={24} /></span>
        <div className="signal-copy">
          <div className="signal-head"><strong>{category.name}</strong>{planned ? <span className={`status-chip ${metric.status}`}><Icon name={statusIcons[metric.status]} size={20} />{statusLabels[metric.status]}</span> : null}</div>
          {planned
            ? <small><Money value={metric.actualMinor} /> из <Money value={metric.availableMinor} /> · {over ? "сверх лимита" : "осталось"} <b>{over ? <Money value={metric.overMinor} /> : <Money value={metric.remainingMinor} />}</b></small>
            : <small>Без лимита в этом месяце · только история операций</small>}
        </div>
      </article>;
    })}{categoryRows.length === 0 ? <div className="empty-state">
      <span className="empty-state-mark"><Icon name="target" size={32} /></span>
      <h3>Лимитов на этот месяц нет</h3>
      <p>Лимит — сумма на месяц по одной статье: продукты, транспорт, развлечения. С ним строка показывает, сколько от неё осталось и обгоняете ли вы календарь.</p>
      {onPlanning ? <button className="primary-button" type="button" onClick={onPlanning}>Задать лимиты в плане</button> : null}
    </div> : null}</div>
      {archivable.length ? <details className="row-disclosure">
        <summary>Убрать категорию из списка</summary>
        <p className="field-hint">Архив прячет категорию из новых операций и сохраняет её в истории и расчётах.</p>
        <ul className="chip-list">{archivable.map((category) => <li key={category.id}><button className="secondary-button" type="button" disabled={busy} aria-label={`Архивировать использованную категорию «${category.name}»`} onClick={() => void runChange((state) => archiveCategory(state, category.id), () => undefined)}>{category.name}</button></li>)}</ul>
      </details> : null}
    </section>

    {/* Итоги — справка, а не действие: они свёрнуты, пока их не спросят (§1, уплотнение). */}
    <details className="section-card collapsible-card">
      <summary><span>Итоги и остатки</span><Icon name="chevron-right" size={24} className="row-chevron" /></summary>
      <div className="quick-grid" aria-label="Итоги бюджета">
        <article className="quick-card"><span className="quick-label">Доход</span><strong><Money value={metrics.incomeMinor} /></strong></article>
        <article className="quick-card"><span className="quick-label">Расходы с учётом возвратов</span><strong><Money value={metrics.expensesMinor} /></strong></article>
        <article className="quick-card"><span className="quick-label">Капитал</span><strong><Money value={metrics.capitalMinor} /></strong></article>
      </div>
      <dl className="summary-list">{budget.accounts.map((account) => <div key={account.id}><dt>{account.name}{account.active ? "" : " (в архиве)"}</dt><dd><Money value={metrics.accountBalancesMinor[account.id] ?? 0} /></dd></div>)}</dl>
    </details>

    <section className="section-card" aria-labelledby="operations-history-title">
      <h2 id="operations-history-title">Полная история</h2>
      <div className="search-controls">
        <label htmlFor="operation-history-search">Поиск по категории, счёту или сумме</label>
        <input id="operation-history-search" type="search" autoComplete="off" maxLength={80} value={historyQuery} onChange={(event) => { setHistoryQuery(event.target.value); setVisibleCount(PAGE_SIZE); }} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
        <label htmlFor="operation-history-kind">Вид операции</label>
        <select id="operation-history-kind" value={historyKind} onChange={(event) => { setHistoryKind(event.target.value as TransactionKind | "all"); setVisibleCount(PAGE_SIZE); }}>
          <option value="all">Все виды</option>
          {Object.entries(kindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
        <button className="secondary-button" type="button" disabled={!filtering} onClick={() => { setHistoryQuery(""); setHistoryKind("all"); setVisibleCount(PAGE_SIZE); }}>Сбросить</button>
      </div>
      {filtered.length ? <ul className="transaction-list">{filtered.slice(0, visibleCount).map(({ transaction }) => {
        const category = transactionCategory(transaction, budget);
        const visual = category ? categoryVisual(category) : null;
        const name = `${kindLabels[transaction.kind]} ${rubles(transaction.amountMinor)} от ${transaction.occurredOn}`;
        return <li className={`transaction-row history-row ${transaction.kind}`} key={transaction.id}>
          {/* Вся строка — одна цель нажатия: она открывает операцию в форме наверху, где её и
              меняют, и удаляют. Две текстовые кнопки в каждой строке занимали отдельный ряд и
              растили список вдвое, а разрушающее действие стояло под пальцем в каждой строке. */}
          <button className="row-open" type="button" disabled={busy} aria-label={`Изменить операцию «${name}»`} onClick={() => beginEdit(transaction)}>
            <span className={`transaction-icon ${visual ? `tone-${visual.tone}` : "tone-neutral"}`}><Icon name={visual ? visual.icon : kindIcons[transaction.kind]} size={24} /></span>
            <span className="transaction-copy"><strong>{category ? category.name : kindLabels[transaction.kind]}</strong><small>{transaction.occurredOn} · {category ? kindLabels[transaction.kind] : transactionDetail(transaction, budget)}</small></span>
            <b><Money value={transaction.amountMinor} sign={kindSign(transaction.kind)} /></b>
          </button>
        </li>;
      })}</ul> : <div className="empty-state">
        <span className="empty-state-mark"><Icon name="inbox" size={32} /></span>
        {/* §6 исследования, пункт 29: сообщить состояние, не соврав про него; объяснить, что сюда
            попадает; дать прямой путь к задаче. Фильтр и пустая история — разные состояния, и
            называть их одними словами значит соврать про одно из них. */}
        {filtering ? <>
          <h3>По этому запросу ничего не нашлось</h3>
          <p>В истории всё ещё {operationsCount(budget.transactions.length)}. Поиск идёт по названию категории, названию счёта и по сумме.</p>
          <button className="primary-button" type="button" onClick={() => { setHistoryQuery(""); setHistoryKind("all"); setVisibleCount(PAGE_SIZE); }}>Показать все операции</button>
        </> : <>
          <h3>Записей пока нет</h3>
          <p>Сюда попадает каждая покупка, доход и перевод — сразу после того, как их записали в форме наверху.</p>
          <button className="primary-button" type="button" onClick={() => {
            const amount = document.getElementById("operation-amount");
            amount?.scrollIntoView({ block: "center" });
            amount?.focus();
          }}>Записать первую операцию</button>
        </>}
      </div>}
      {visibleCount < filtered.length ? <button className="secondary-button" type="button" disabled={busy} aria-label={`Показать ещё операции, осталось ${filtered.length - visibleCount}`} onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>Показать ещё ({filtered.length - visibleCount})</button> : null}
      <p role="status">{filtering ? `Найдено ${filtered.length} из ${budget.transactions.length}. ` : ""}Показано {Math.min(visibleCount, filtered.length)} из {filtered.length}</p>
    </section>
  </div>;
}
