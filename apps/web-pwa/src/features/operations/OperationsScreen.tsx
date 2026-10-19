import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  calculateBudget,
  type BudgetState,
  type CategoryType,
  type Transaction,
  type TransactionKind,
} from "@family-budget/domain";
import { Icon, type IconName } from "../../components/Icon";
import { Money } from "../../components/Money";
import { MoneyOdometer } from "../../components/MoneyOdometer";
import { categoryVisual } from "../../category-visual";
import { parseMoney } from "../../money";
import {
  localToday as calendarToday,
  periodClock,
  reach,
  reachWord,
  runsOutOn,
  type PeriodClock,
  type ReachState,
} from "../../reach";
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
import { groupedCategoryOptions } from "./category-picker";
import { CategorySheet, CATEGORY_SHEET_ERROR_ID, type CategorySheetDraft } from "./CategorySheet";
import { editAmount, evaluateAmount, settleAmount, type AmountSelection, type KeypadKey } from "./amount-expression";
import { Keypad, useKeypadAvailable } from "./Keypad";
import { amountText, draftCurrency, kindLabels, moneyIn, operationLabel, rubles, transactionDetail } from "./transaction-words";
import { OperationAmount } from "./OperationAmount";
import { createDraftSaving, useDraftGuard } from "../../navigation/draft-guard";

/** Просьба открыть операцию в форме — из «Операций», адресом `#/new?edit=<id>`. `nonce` отличает две просьбы об одной операции. */
export interface EditRequest {
  readonly id: string;
  readonly nonce: number;
}

interface OperationsScreenProps {
  readonly budget: BudgetState;
  readonly onChange: (change: (current: BudgetState) => BudgetState) => Promise<unknown>;
  /**
   * Прямой путь из пустого состояния «Конверты»: лимиты задают в плане.
   *
   * Необязателен: экран, вставленный без навигации, посылать человека некуда, и мёртвая кнопка
   * была бы хуже её отсутствия. Приложение его передаёт всегда.
   */
  readonly onPlanning?: () => void;
  /**
   * Часы периода — те же, что у «Сегодня»: линейка в конверте считает от того же дня и до той же
   * выплаты. Без них экран заводит часы сам по календарю; так его рисуют проверки.
   */
  readonly clock?: PeriodClock;
  /**
   * Просьба открыть операцию из истории. Экран открывает её в форме и тут же сообщает, что
   * просьба выполнена: повторный приход на экран не должен открыть ту же операцию снова.
   */
  readonly editRequest?: EditRequest | null;
  readonly onEditRequestHandled?: () => void;
  /**
   * Правка, открытая по просьбе, кончилась — сохранена, отменена или операция удалена. Адрес
   * правки (`#/new?edit=…`) тогда меняется на адрес записи: форма уже про новую операцию.
   */
  readonly onEditFinished?: () => void;
}

/**
 * Отклик на запись (§5 исследования, пункты 27–28).
 *
 * Самое частое действие приложения проходило молча: форма очищалась, и всё. Человек не узнавал ни
 * того, записалось ли, ни того, что от этого изменилось. Квитанция отвечает на оба вопроса сразу:
 * называет записанное и показывает число, которое от записи поехало, — одометром, чтобы движение
 * объяснило, что оно изменилось, и на сколько.
 */
export interface SaveReceipt {
  readonly verb: "Записано" | "Изменено" | "Удалено";
  readonly kind: TransactionKind;
  readonly amountMinor: number;
  /** Валюта суммы — валюта счёта операции, как в истории; конверты ниже — в рублях бюджета. */
  readonly currency: string;
  /** Чьё число объявляем; `null` — объявлять нечего, и тогда квитанция называет только запись. */
  readonly target: EffectTarget | null;
  /** Значение до изменения: одометр едет от него, а подпись называет разницу. */
  readonly beforeMinor: number;
}

type Confirmation =
  | { readonly type: "edit"; readonly id: string; readonly draft: TransactionDraft }
  | { readonly type: "delete"; readonly id: string; readonly label: string };

/**
 * Образец суммы в поле высотой 68 (§6).
 *
 * Пустая коробка в кегль `hero` читалась провалом в вёрстке, а не местом для суммы. Образец
 * набран ровно так, как поле принимает и хранит введённое, — без отбивки разрядов (её в поле
 * никто не расставит) и с запятой перед копейками (§7: десятичный разделитель — запятая).
 * Чтобы образец нельзя было принять за уже введённую сумму, он набран начертанием 400 против 700
 * у значения: эмфаза весом на одном кегле (§2 исследования).
 */
const AMOUNT_PLACEHOLDER = "1200,50";

/** Что произносит клавиатура суммы после нажатия: набранное, а у выражения — и его итог. */
function spokenAmountText(text: string): string {
  if (text === "") return "Сумма пуста";
  const result = evaluateAmount(text);
  return result.kind === "value" && result.compound ? `${text}, итого ${rubles(result.minor)}` : text;
}

/** Квитанция записи: её же подводят под глаз после сохранения. */
export const SAVE_RECEIPT_ID = "operation-save-receipt";

/**
 * Виды, которые записывает эта форма. Долги и операции в другой валюте приходят из копии или от
 * другого устройства, и форма их не записывает и не правит — у неё нет ни долга, ни курса (план,
 * §3.4). Поэтому список видов — свой, а не все подписи `kindLabels`.
 */
type FormKind = TransactionDraft["kind"];
const FORM_KINDS: readonly FormKind[] = ["income", "expense", "refund", "transfer", "goal_contribution"];

/** «Записать доход» — глагол и вид операции в винительном падеже. */
const kindObjects: Record<FormKind, string> = {
  income: "доход",
  expense: "покупку",
  refund: "возврат",
  transfer: "перевод",
  goal_contribution: "взнос в цель",
};

/** Глиф состояния линейки: слово и глиф вместе, цвет — третьим (§6). */
const reachIcons: Record<ReachState, IconName> = {
  reaches: "circle-check",
  short: "triangle-alert",
  out: "circle-alert",
};

const dateLong = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const dateLongYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });

/** «9 июля» — дата словом; пробел внутри неразрывный, как в сумме (§7.9). */
function formatDay(value: string, withYear = false): string {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return (withYear ? dateLongYear.format(date).replace(" г.", "") : dateLong.format(date)).replace(/ /gu, "\u00a0");
}

/** «июля» — месяц периода в родительном падеже, отрезанный от «15 июля». */
function monthGenitive(value: string): string {
  const parts = formatDay(value).split(" ");
  return parts[parts.length - 1] ?? value;
}

/** «сегодня, 9 июля» — дата операции так, как её называют вслух. */
function dateWords(value: string, today: string): string {
  const yesterday = (() => {
    const date = new Date(`${today}T12:00:00`);
    date.setDate(date.getDate() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  })();
  if (value === today) return `сегодня, ${formatDay(value)}`;
  if (value === yesterday) return `вчера, ${formatDay(value)}`;
  return formatDay(value, value.slice(0, 4) !== today.slice(0, 4));
}

function moneyInput(minor: number): string {
  const absolute = Math.abs(minor);
  const rublePart = Math.floor(absolute / 100);
  const kopeckPart = String(absolute % 100).padStart(2, "0");
  const formatted = kopeckPart === "00" ? String(rublePart) : `${rublePart}.${kopeckPart}`;
  return minor < 0 ? `-${formatted}` : formatted;
}

function firstActiveAccount(budget: BudgetState): string {
  return budget.accounts.find((item) => item.active)?.id ?? "";
}

function firstOriginalExpense(budget: BudgetState): string {
  return budget.transactions.find((item) => item.kind === "expense" && item.status === "posted")?.id ?? "";
}

function firstActiveGoal(budget: BudgetState): string {
  return budget.goals.find((item) => item.status === "active")?.id ?? "";
}

/**
 * Пустой черновик вида операции.
 *
 * У покупки категория не подставляется заранее: конверт выбирают на табло, и заранее выбранный
 * «Жильё» был бы случайной записью не туда, а не подсказкой. Счёт подставляется — он почти
 * всегда один.
 */
function defaultDraft(kind: FormKind, budget: BudgetState, occurredOn: string): TransactionDraft {
  const accountId = firstActiveAccount(budget);
  const common = { status: "posted" as const, occurredOn, amount: "" };
  switch (kind) {
    case "income":
      return { ...common, kind, accountId, categoryId: "" };
    case "expense":
      return { ...common, kind, accountId, categoryId: "" };
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

/** Черновик формы по операции — или `null`, если форма такую операцию показать не может (долг). */
function draftFromTransaction(transaction: Transaction): TransactionDraft | null {
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
    case "debt_out":
    case "debt_in":
      return null;
  }
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
    case "debt_out":
    case "debt_in": return transactionDetail(transaction, budget);
  }
}

function patchDraft(draft: TransactionDraft, key: string, value: string): TransactionDraft {
  return { ...draft, [key]: value } as TransactionDraft;
}

/** Категория черновика, если у этого вида она бывает. */
function draftCategoryId(draft: TransactionDraft): string {
  return draft.kind === "expense" || draft.kind === "income" ? draft.categoryId : "";
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
 * Стоит в потоке под карточкой суммы, а не поверх экрана: плавающая плашка накрывает то, что под
 * ней. Квитанция занимает своё место и ничего не закрывает.
 */
export function SaveReceiptView({ receipt, afterMinor }: { readonly receipt: SaveReceipt; readonly afterMinor: number | null }) {
  const label = receipt.target ? effectLabel(receipt.target) : null;
  const changeMinor = afterMinor === null ? 0 : afterMinor - receipt.beforeMinor;
  const spokenValue = afterMinor === null
    ? ""
    : `${rubles(afterMinor)}${changeMinor === 0 ? "" : `, ${changeMinor < 0 ? "меньше" : "больше"} на ${rubles(Math.abs(changeMinor))}`}`;
  return <div className="save-receipt" id={SAVE_RECEIPT_ID} role="status" aria-live="polite" aria-atomic="true">
    <span className="save-receipt-mark" aria-hidden="true"><Icon name="circle-check" size={24} /></span>
    <div className="save-receipt-copy">
      <strong>{receipt.verb}: {kindLabels[receipt.kind].toLowerCase()} <OperationAmount value={receipt.amountMinor} currency={receipt.currency} /></strong>
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

/**
 * Категория дохода — необязательная, списком с заголовками групп и «Своей категорией» последним
 * элементом. Выбранная категория остаётся в списке даже из архива: список, из которого исчезло
 * собственное значение, врал бы о том, что выбрано.
 */
function IncomeCategoryField({ budget, value, onValue, onCustom }: { budget: BudgetState; value: string; onValue: (value: string) => void; onCustom: () => void }) {
  const optional = true;
  const groups = groupedCategoryOptions(budget, "income", "", value === "" ? undefined : value);
  return <div className="field">
    <label htmlFor="operation-categoryId">Категория дохода — не обязательно</label>
    <select
      id="operation-categoryId"
      value={value}
      onChange={(event) => {
        if (event.target.value === "#custom") onCustom();
        else onValue(event.target.value);
      }}
    >
      <option value="">{optional ? "Без категории" : "Выберите категорию"}</option>
      {groups.map((group) => <optgroup label={group.title} key={group.key}>
        {group.options.map((option) => <option value={option.id} key={option.id}>{option.name}{option.archived ? " (в архиве)" : ""}</option>)}
      </optgroup>)}
      <option value="#custom">Своя категория</option>
    </select>
  </div>;
}

function TransactionFields({ budget, draft, patch, onCustomCategory }: { budget: BudgetState; draft: TransactionDraft; patch: (key: string, value: string) => void; onCustomCategory: (name: string, type: CategoryType) => void }) {
  const activeExpenses = budget.transactions.filter((item) => item.kind === "expense" && item.status === "posted");
  if (draft.kind === "income") return <>
    <AccountSelect id="operation-accountId" label="Счёт зачисления" value={draft.accountId} budget={budget} onValue={(value) => patch("accountId", value)} />
    <IncomeCategoryField budget={budget} value={draft.categoryId} onValue={(value) => patch("categoryId", value)} onCustom={() => onCustomCategory("", "income")} />
  </>;
  // У покупки категорию выбирают на табло конвертов; здесь остаётся только счёт.
  if (draft.kind === "expense") return <AccountSelect id="operation-accountId" label="Счёт оплаты" value={draft.accountId} budget={budget} onValue={(value) => patch("accountId", value)} />;
  if (draft.kind === "refund") {
    const original = budget.transactions.find((item): item is Extract<Transaction, { kind: "expense" }> => item.id === draft.originalTransactionId && item.kind === "expense");
    const derivedCategory = original ? budget.categories.find((item) => item.id === original.categoryId)?.name : undefined;
    return <>
      <AccountSelect id="operation-accountId" label="Счёт возврата" value={draft.accountId} budget={budget} onValue={(value) => patch("accountId", value)} />
      <div className="field"><label htmlFor="operation-originalTransactionId">Исходный расход</label><select id="operation-originalTransactionId" value={draft.originalTransactionId} onChange={(event) => patch("originalTransactionId", event.target.value)}><option value="">Выберите расход</option>{activeExpenses.map((item) => <option value={item.id} key={item.id}>{item.occurredOn} · {amountText(item, budget)} · {transactionContext(item, budget)}</option>)}</select><small>Категория определяется исходным расходом: {derivedCategory ?? "выберите расход"}.</small></div>
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

/** Строка факта под суммой: откуда деньги и когда. Меняют её кнопкой «Изменить». */
function factWords(draft: TransactionDraft, budget: BudgetState, today: string): string {
  const account = (id: string) => budget.accounts.find((item) => item.id === id)?.name ?? "счёт не выбран";
  const goal = (id: string) => budget.goals.find((item) => item.id === id)?.name ?? "цель не выбрана";
  const when = dateWords(draft.occurredOn, today);
  switch (draft.kind) {
    case "income": return `На счёт «${account(draft.accountId)}» · ${when}`;
    case "expense":
    case "refund": return `Со счёта «${account(draft.accountId)}» · ${when}`;
    case "transfer": return `«${account(draft.fromAccountId)}» → «${account(draft.toAccountId)}» · ${when}`;
    case "goal_contribution": return `«${account(draft.fromAccountId)}» → цель «${goal(draft.goalId)}» · ${when}`;
  }
}

type CategoryMetric = ReturnType<typeof calculateBudget>["categoryMetrics"][string];

interface EnvelopeRow {
  readonly category: BudgetState["categories"][number];
  readonly metric: CategoryMetric;
}

/**
 * Конверт на табло: что в нём сейчас и что останется после этой покупки.
 *
 * Это ответ на «а мы можем себе это позволить?» до траты, а не после, и сразу по всем конвертам.
 * Темп трат берётся нынешний: покупка разовая, и вопрос в том, дотянет ли конверт при обычном
 * темпе, если из него вычесть эту сумму. Заливка — та же линейка до выплаты, что и на «Сегодня»,
 * с той же насечкой; «укус» покупки — штрихованный отрезок между «было» и «станет».
 */
function Envelope({ row, amountMinor, applies, selected, clock, onSelect }: { row: EnvelopeRow; amountMinor: number; applies: boolean; selected: boolean; clock: PeriodClock; onSelect: () => void }) {
  const { category, metric } = row;
  const visual = categoryVisual(category);
  const { today, payday, elapsedDays } = clock;
  const overNow = metric.status === "over_limit" ? Math.max(metric.overMinor, 0) : 0;
  const before = reach({ remainingMinor: metric.remainingMinor, spentMinor: metric.actualMinor, elapsedDays, daysAhead: payday.daysAhead, overLimit: metric.status === "over_limit" });
  const afterRemaining = applies ? metric.remainingMinor - amountMinor : metric.remainingMinor;
  const after = applies
    ? reach({ remainingMinor: afterRemaining, spentMinor: metric.actualMinor, elapsedDays, daysAhead: payday.daysAhead, overLimit: metric.status === "over_limit" || afterRemaining < 0 })
    : before;
  const overAfter = afterRemaining < 0 ? -afterRemaining : overNow;
  const rate = after.perDayMinor === null ? null : Math.round(after.perDayMinor / 100) * 100;
  const out = runsOutOn(today, after.daysCovered);
  const line = after;
  // Факт и путь (§6): «не дотянет» не называется без числа, которым нехватку закрывают, —
  // сколько в день надо тратить, чтобы этот конверт дожил до выплаты.
  const needPerDay = payday.daysAhead > 0 ? Math.round(Math.max(0, afterRemaining) / payday.daysAhead / 100) * 100 : 0;
  const bite = applies && before.fill > after.fill ? before.fill : null;

  const nowWords = overNow > 0
    ? `лимит ${rubles(metric.availableMinor)} · ушло ${rubles(metric.actualMinor)}`
    : `сейчас ${rubles(Math.max(0, metric.remainingMinor))}`;
  const resultLabel = !applies
    ? (overNow > 0 ? "перелимит" : "в конверте")
    : (afterRemaining < 0 ? "перелимит станет" : "останется");
  const resultMinor = !applies
    ? (overNow > 0 ? overNow : Math.max(0, metric.remainingMinor))
    : (afterRemaining < 0 ? overAfter : afterRemaining);
  const resultTone = (applies ? afterRemaining < 0 : overNow > 0) ? "out" : line.state === "short" && clock.inPeriod ? "short" : "";
  const footRight = !clock.inPeriod
    ? ""
    : line.state === "out"
      ? (overAfter > 0 ? "сверх лимита" : "конверт пуст")
      : out === null
        ? "до конца месяца"
        : line.state === "short"
          ? `до ${formatDay(out)} · не дотянет · чтобы дотянуть — ${rubles(needPerDay)} в день`
          : `до ${formatDay(out)} · ${reachWord(line.state).toLowerCase()}`;
  const footLeft = !clock.inPeriod
    ? `ушло ${rubles(metric.actualMinor)} из ${rubles(metric.availableMinor)}`
    : line.state === "out"
      ? "конверт пуст"
      : rate === null ? "трат не было" : `${rubles(rate)} в день`;
  const spoken = [
    `${category.name}: ${resultLabel} ${rubles(resultMinor)}`,
    applies ? `сейчас ${rubles(Math.max(0, metric.remainingMinor))}` : "",
    clock.inPeriod ? footRight : "",
    selected ? "выбран" : "",
  ].filter((part) => part).join(", ");

  return <button className={`envelope${selected ? " selected" : ""}`} type="button" aria-pressed={selected} aria-label={spoken} onClick={onSelect}>
    <span className="envelope-head">
      <span className={`category-tile tone-${visual.tone}`}><Icon name={visual.icon} size={24} /></span>
      <span className="envelope-name"><strong>{category.name}</strong><small>{selected ? "выбран · " : ""}{nowWords}</small></span>
      <span className={`envelope-after${resultTone ? ` ${resultTone}` : ""}`}><small>{resultLabel}</small><b><Money value={resultMinor} /></b></span>
    </span>
    {clock.inPeriod ? <span className={`limit-bar ${line.state}`} data-spent={line.fill} data-bite={bite ?? undefined} aria-hidden="true" /> : null}
    <span className="envelope-foot">
      <span>{footLeft}</span>
      {footRight ? <span className={line.state === "out" ? "out" : line.state === "short" ? "short" : undefined}><Icon name={reachIcons[line.state]} size={20} />{footRight}</span> : null}
    </span>
  </button>;
}

/**
 * Экран «Записать».
 *
 * Формы больше нет: вводишь сумму, и каждый конверт показывает, что в нём останется. Нажатие на
 * конверт его выбирает, а записывает отдельная кнопка, которая называет действие словами:
 * мгновенная запись по касанию ничего не добавляла к предпросмотру, но добавляла случайную трату
 * от задетого пальцем экрана. Счёт и дата стоят строкой факта с «Изменить»; доход и перевод —
 * строкой под конвертами, и та же форма ведёт их до конца.
 */
export function OperationsScreen({ budget, onChange, onPlanning, clock: givenClock, editRequest = null, onEditRequestHandled, onEditFinished }: OperationsScreenProps) {
  const activeBudget = budget.budgets.find((item) => item.id === budget.activeBudgetId);
  // Часы периода те же, что на «Сегодня». Без переданных — свои, по календарю семьи.
  const clock = useMemo<PeriodClock>(() => {
    if (givenClock) return givenClock;
    const today = calendarToday(new Date());
    const period = activeBudget ?? { startDate: today, endDate: today };
    return periodClock(period, budget.transactions.filter((item) => item.status === "posted" && item.kind === "income").map((item) => item.occurredOn), today);
  }, [activeBudget, budget.transactions, givenClock]);
  const today = clock.today;
  const [draft, setDraft] = useState<TransactionDraft>(() => defaultDraft("expense", budget, today));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SaveReceipt | null>(null);
  // Строка факта раскрывается по «Изменить»; у дохода и перевода поля открыты всегда — это их форма.
  const [factOpen, setFactOpen] = useState(false);
  // Клавиатура суммы и то, что она произносит читающему с экрана: поле не в фокусе, и его
  // значение само не объявляется. Каретка ставится после отрисовки, если поле в фокусе.
  const keypadAvailable = useKeypadAvailable();
  const amountRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const [spokenAmount, setSpokenAmount] = useState("");
  const [sheet, setSheet] = useState<CategorySheetDraft | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const gate = useRef(createOperationsSubmissionGate());
  // «Грязно» — отличается от снимка, сделанного при открытии и при каждом сбросе, а не от черновика
  // по умолчанию, пересчитанного от бюджета: счёт или категория, пришедшие от семьи, и смена дня
  // не делают нетронутую форму несохранённой (план волны 2, §2.4).
  const [pristineDraft, setPristineDraft] = useState<TransactionDraft>(draft);
  const dirty = editingId !== null || JSON.stringify(draft) !== JSON.stringify(pristineDraft);
  const metrics = useMemo(() => calculateBudget(budget), [budget]);
  const envelopeIds = new Set(
    activeBudget?.lines
      .filter((item) => item.active !== false)
      .map((item) => item.categoryId) ?? [],
  );
  const envelopes: EnvelopeRow[] = budget.categories
    .filter((item) => item.active && item.type === "expense" && envelopeIds.has(item.id))
    .flatMap((category) => {
      const metric = metrics.categoryMetrics[category.id];
      return metric ? [{ category, metric }] : [];
    });
  const spentByCategory = new Set<string>();
  for (const transaction of budget.transactions) {
    if (transaction.kind === "expense" || transaction.kind === "refund") spentByCategory.add(transaction.categoryId);
  }
  /**
   * Категории, которые можно убрать из новых операций. Действие редкое и управляющее, поэтому оно
   * свёрнуто под списком «Вне конвертов», а не повторяет его кнопкой в каждой строке.
   */
  const archivable = budget.categories.filter((category) => category.active && category.type === "expense" && spentByCategory.has(category.id));
  const selectedCategoryId = draftCategoryId(draft);
  const selectedCategory = budget.categories.find((item) => item.id === selectedCategoryId);
  const outsideGroups = groupedCategoryOptions(budget, "expense", "", selectedCategoryId === "" ? undefined : selectedCategoryId)
    .map((group) => ({ ...group, options: group.options.filter((option) => !envelopeIds.has(option.id)) }))
    .filter((group) => group.options.length > 0);
  const outsideSelected = selectedCategory !== undefined && !envelopeIds.has(selectedCategory.id);

  // Сумма — выражение: «1200+350» считается слева направо. Пока оно не разобралось,
  // предпросмотра нет: конверты показывают, что в них сейчас.
  const amount = evaluateAmount(draft.amount);
  const amountMinor = amount.kind === "value" ? amount.minor : 0;
  const dateInPeriod = activeBudget !== undefined && draft.occurredOn >= activeBudget.startDate && draft.occurredOn <= activeBudget.endDate;
  // Предпросмотр считается только для новой покупки внутри месяца плана: при редактировании
  // сумма уже учтена в остатках, и вычитать её второй раз значило бы показать неправду.
  const previewApplies = draft.kind === "expense" && editingId === null && amountMinor > 0 && dateInPeriod;
  const detailsOpen = factOpen || draft.kind !== "expense" || editingId !== null;

  // Черновик, ушедший в запись, — уже не несохранённый черновик (третье ревью, e2e b1). Реестр
  // черновиков спрашивает `isDirty` синхронно в момент нажатия, поэтому запись переводит черновик в
  // «записывается» сама и до первого `await` (`beginSaving`). Неудача возвращает его: содержимое
  // формы никуда не делось. Удача держит «записывается», пока сброшенная форма не нарисована: между
  // ответом координатора и этой отрисовкой старая, грязная отрисовка ответила бы реестру неправду.
  const [saving] = useState(createDraftSaving);
  const beginSaving = () => saving.begin();
  useLayoutEffect(() => {
    if (!dirty) saving.end();
  }, [dirty, saving]);
  useDraftGuard({
    label: editingId === null ? "операция, которую вы набирали" : "изменения в операции",
    isDirty: () => dirty && !saving.saving,
    discard: () => clearForm(),
  });

  const clearTransient = () => {
    setError(null);
    setConfirmation(null);
  };
  const patch = (key: string, value: string) => {
    setDraft((current) => patchDraft(current, key, value));
    clearTransient();
  };
  const chooseKind = (kind: FormKind) => {
    const fresh = defaultDraft(kind, budget, today);
    setPristineDraft(fresh);
    setDraft((current) => ({ ...fresh, amount: current.amount, occurredOn: current.occurredOn }));
    setEditingId(null);
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
        // Не записалось: черновик на месте и снова несохранённый.
        saving.end();
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
    let pendingMinor = 0;
    try {
      pendingMinor = parseMoney(pending.amount);
    } catch {
      // Сумму уже принял домен: сюда попадает только то, что разобралось. Ноль — на всякий случай.
    }
    const target = effectTarget(budget, metrics, pending);
    setReceipt({
      verb,
      kind: pending.kind,
      amountMinor: pendingMinor,
      currency: draftCurrency(pending, budget),
      target,
      beforeMinor: target === null ? 0 : effectValueMinor(metrics, target),
    });
    // Кнопку записи нажимают у нижнего края экрана, а квитанция встаёт под карточкой суммы.
    // Отклик, которого не видно, — это тот же молчащий экран, поэтому квитанцию подводят под
    // глаз. Прокрутка мгновенная и уважает `prefers-reduced-motion` по умолчанию платформы.
    window.setTimeout(() => document.getElementById(SAVE_RECEIPT_ID)?.scrollIntoView({ block: "center" }), 0);
  };
  /** Пустая форма записи. Адрес не трогает: так её очищает и «Не сохранять» на уходе с экрана. */
  const clearForm = (kind: FormKind = draft.kind) => {
    const fresh = defaultDraft(kind, budget, today);
    setDraft(fresh);
    setPristineDraft(fresh);
    setEditingId(null);
    setConfirmation(null);
    setFactOpen(false);
    setSheet(null);
    setSheetError(null);
  };
  /** Сброс после записи, отмены или удаления: правка, если была, кончилась — и адрес это узнаёт. */
  const reset = (kind: FormKind = draft.kind) => {
    if (editingId !== null) onEditFinished?.();
    clearForm(kind);
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
    window.setTimeout(() => document.getElementById("operation-amount")?.focus(), 0);
  };
  const selectCategory = (id: string) => {
    setDraft((current) => patchDraft(current, "categoryId", id));
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
    ? operationLabel(editingTransaction, budget)
    : "";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    // Выражение сворачивается в число здесь: «=» — это и есть кнопка записи.
    const pending = { ...draft, amount: settleAmount(draft.amount) };
    if (editingId) {
      setConfirmation({ type: "edit", id: editingId, draft: pending });
      return;
    }
    // Записанный черновик сбрасывается: с этого касания он не «несохранённый».
    beginSaving();
    void runChange((state) => createTransaction(state, pending), () => { recordReceipt("Записано", pending); reset(pending.kind); });
  };
  const confirm = () => {
    if (!confirmation || busy) return;
    if (confirmation.type === "edit") {
      const pending = confirmation;
      beginSaving();
      void runChange((state) => editTransaction(state, pending.id, pending.draft), () => { recordReceipt("Изменено", pending.draft); reset(pending.draft.kind); });
    } else {
      const pending = confirmation;
      const removed = budget.transactions.find((item) => item.id === pending.id);
      // Удаление открытой в форме операции сбрасывает форму; удаление другой оставляет черновик.
      if (editingId === pending.id) beginSaving();
      void runChange((state) => deleteTransaction(state, pending.id), () => {
        const removedDraft = removed === undefined ? null : draftFromTransaction(removed);
        if (removedDraft !== null) recordReceipt("Удалено", removedDraft);
        setConfirmation(null);
        if (editingId === pending.id) reset();
      });
    }
  };
  const beginEdit = (transaction: Transaction) => {
    const editable = draftFromTransaction(transaction);
    if (editable === null) {
      // Операция по долгу: у формы нет полей долга, и правка ею потеряла бы его. Говорим это, а не
      // открываем форму, которая записала бы что-то другое.
      setError("Операцию по долгу эта форма пока не изменяет.");
      window.setTimeout(() => document.getElementById("operation-form-error")?.focus(), 0);
      return;
    }
    setDraft(editable);
    setEditingId(transaction.id);
    setFactOpen(true);
    // Квитанция отвечала на прошлую запись; над формой, открывшей чужую операцию, она врёт.
    setReceipt(null);
    clearTransient();
    // Фокус остаётся на заголовке маршрута: читающий с экрана слышит «Изменить операцию», а не
    // голое поле. Сумму лишь подводят под глаз.
    window.setTimeout(() => document.getElementById("operation-amount")?.scrollIntoView({ block: "center" }), 0);
  };
  useEffect(() => {
    if (!editRequest) return;
    const transaction = budget.transactions.find((item) => item.id === editRequest.id);
    if (transaction) beginEdit(transaction);
    onEditRequestHandled?.();
    // Просьба — событие, а не состояние: выполняется один раз на каждую, чем бы ни было занято
    // остальное. Более широкие зависимости открывали бы операцию заново на каждой правке.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest]);
  /**
   * Клавиша клавиатуры суммы. Если поле в фокусе, правка идёт по каретке, как с обычной
   * клавиатуры; иначе — в конец. Результат произносится отдельно: значение поля, которое не в
   * фокусе, читающему с экрана само не объявляется.
   */
  const pressKey = (key: KeypadKey) => {
    const input = amountRef.current;
    const focused = input !== null && document.activeElement === input && input.selectionStart !== null && input.selectionEnd !== null;
    const selection: AmountSelection | null = focused ? { start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 } : null;
    const next = editAmount(draft.amount, key, selection);
    if (next.text !== draft.amount) {
      caretRef.current = focused ? next.caret : null;
      patch("amount", next.text);
    }
    setSpokenAmount(spokenAmountText(next.text));
  };
  useLayoutEffect(() => {
    const caret = caretRef.current;
    if (caret === null) return;
    caretRef.current = null;
    amountRef.current?.setSelectionRange(caret, caret);
  });
  const requestDelete = (transaction: Transaction) => {
    // В валюте счёта операции, как в истории: «Расход 40 $ от …», а не «40 ₽».
    setConfirmation({ type: "delete", id: transaction.id, label: operationLabel(transaction, budget) });
    setError(null);
  };

  const title = editingId ? "Изменить операцию" : `Записать ${kindObjects[draft.kind]}`;
  const submitLabel = editingId
    ? "Проверить изменения"
    : draft.kind === "expense"
      ? (selectedCategory ? `Записать ${amountMinor > 0 ? moneyIn(amountMinor, draftCurrency(draft, budget)) : "покупку"} в «${selectedCategory.name}»` : "Записать покупку")
      : `Записать ${kindObjects[draft.kind]}`;
  const periodMonth = activeBudget ? monthGenitive(activeBudget.startDate) : "";

  return <div className="operations-screen">
    {/* §8: экран «Записать» — сумма первой, под ней строка факта, под ними конверты. Всё это одна
        форма: кнопка записи внизу относится и к сумме, и к выбранному конверту. Заголовок экрана —
        заголовок карточки суммы: второго на экране нет. */}
    <form className="record-form" onSubmit={submit} noValidate aria-busy={busy} inert={sheet !== null}>
      <section className="section-card record-card" aria-labelledby="operation-form-title">
        {/* «Очистить черновик» стоит у заголовка, а не в полосе записи: полоса с клавиатурой не
            меняет высоты от первой цифры, и на 320 pt под ней остаётся место конверту. */}
        <div className="record-head">
          <h1 id="operation-form-title">{title}</h1>
          {!editingId && dirty ? <button className="text-button" type="button" aria-label="Очистить черновик" onClick={() => reset()}>Очистить</button> : null}
        </div>
        <fieldset disabled={busy}>
          <legend>Данные операции</legend>
          <div className="field amount-field">
            <label htmlFor="operation-amount">Сумма, ₽</label>
            {/* Поле настоящее. `inputmode="none"` просит платформу не поднимать системную
                клавиатуру — и только: `readonly` разом сломал бы физическую клавиатуру, вставку
                из буфера и экранный диктор. Без клавиатуры на экране поле зовёт системную. */}
            <input ref={amountRef} id="operation-amount" inputMode={keypadAvailable ? "none" : "decimal"} maxLength={24} placeholder={AMOUNT_PLACEHOLDER} value={draft.amount} onChange={(event) => patch("amount", event.target.value)} />
            {amount.kind === "value" && amount.compound ? <output htmlFor="operation-amount" className="amount-total">= <Money value={amount.minor} /></output> : null}
          </div>
          <div className="record-fact">
            <p>{factWords(draft, budget, today)}</p>
            {draft.kind === "expense" && editingId === null
              ? <button className="text-button" type="button" aria-expanded={detailsOpen} aria-controls="operation-details" onClick={() => setFactOpen((open) => !open)}>{factOpen ? "Свернуть" : "Изменить"}</button>
              : null}
          </div>
          {/* Дата вне месяца плана: конверты покупку не увидят, и табло так и говорит — до записи. */}
          {draft.kind === "expense" && activeBudget && !dateInPeriod ? <p className="field-hint record-outside" role="status">{formatDay(draft.occurredOn)} — вне {periodMonth}, месяца плана. Конверты не изменятся: покупка попадёт только в историю.</p> : null}
          <div id="operation-details" className="record-details" hidden={!detailsOpen}>
            <div className="field"><label htmlFor="operation-kind">Тип</label><select id="operation-kind" value={draft.kind} disabled={Boolean(editingId)} onChange={(event) => chooseKind(event.target.value as FormKind)}>{FORM_KINDS.map((value) => <option value={value} key={value}>{kindLabels[value]}</option>)}</select></div>
            <TransactionFields budget={budget} draft={draft} patch={patch} onCustomCategory={openCategorySheet} />
            <div className="field"><label htmlFor="operation-occurredOn">Дата</label><input id="operation-occurredOn" type="date" value={draft.occurredOn} onChange={(event) => patch("occurredOn", event.target.value)} /></div>
          </div>
          <FieldError message={error} />
          {editingTransaction && draft.kind === "expense" && selectedCategory ? <p className="field-hint">Конверт: <b>{selectedCategory.name}</b>. Выберите другой на табло ниже, если нужно.</p> : null}
        </fieldset>
      </section>

      {receipt ? <SaveReceiptView receipt={receipt} afterMinor={receipt.target === null ? null : effectValueMinor(metrics, receipt.target)} /> : null}

      {draft.kind === "expense" ? <>
        {/* Табло конвертов: каждый — цель нажатия, выбирающая категорию. Насечка одна на все. */}
        <section className="envelopes" aria-labelledby="envelopes-title">
          <h2 id="envelopes-title" className="visually-hidden">Конверты</h2>
          {envelopes.length ? <div className={`envelope-board${clock.inPeriod ? "" : " closed"}`} role="group" aria-label={previewApplies ? `Конверты: что останется после покупки на ${rubles(amountMinor)}` : "Конверты"}>
            {envelopes.map((row) => <Envelope key={row.category.id} row={row} amountMinor={amountMinor} applies={previewApplies} selected={selectedCategoryId === row.category.id} clock={clock} onSelect={() => patch("categoryId", row.category.id)} />)}
          </div> : <div className="section-card"><div className="empty-state">
            <span className="empty-state-mark"><Icon name="target" size={32} /></span>
            <h3>Лимитов на этот месяц нет</h3>
            <p>Лимит — сумма на месяц по одной статье: продукты, транспорт, развлечения. С ним конверт показывает, что в нём останется после покупки и дотянет ли он до выплаты.</p>
            {onPlanning ? <button className="primary-button" type="button" onClick={onPlanning}>Задать лимиты в плане</button> : null}
          </div></div>}
        </section>

        {/* Категории без лимита: жильё, подарки, прочее. Свёрнуты — это не конверты, и тратить из них
            «сколько осталось» нельзя; выбранная строка держит список открытым. */}
        <details className="section-card outside-card" open={outsideSelected || undefined}>
          <summary>
            <span className="category-tile tone-neutral"><Icon name="ellipsis" size={24} /></span>
            <span className="envelope-name"><strong>Вне конвертов{outsideSelected && selectedCategory ? ` · ${selectedCategory.name}` : ""}</strong><small>жильё, подарки, прочее — без лимита</small></span>
            <Icon name="chevron-right" size={24} className="row-chevron" />
          </summary>
          {outsideGroups.map((group) => <div className="chip-group" key={group.key}>
            <p className="field-hint">{group.title}</p>
            <ul className="chip-list">{group.options.map((option) => <li key={option.id}><button className="secondary-button" type="button" aria-pressed={selectedCategoryId === option.id} onClick={() => patch("categoryId", option.id)}>{option.name}{option.archived ? " (в архиве)" : ""}</button></li>)}</ul>
          </div>)}
          <ul className="chip-list"><li><button className="secondary-button" type="button" onClick={() => openCategorySheet("", "expense")}>Своя категория</button></li></ul>
          {archivable.length ? <details className="row-disclosure">
            <summary>Убрать категорию из списка</summary>
            <p className="field-hint">Архив прячет категорию из новых операций и сохраняет её в истории и расчётах.</p>
            <ul className="chip-list">{archivable.map((category) => <li key={category.id}><button className="secondary-button" type="button" disabled={busy} aria-label={`Архивировать использованную категорию «${category.name}»`} onClick={() => void runChange((state) => archiveCategory(state, category.id), () => undefined)}>{category.name}</button></li>)}</ul>
          </details> : null}
        </details>
      </> : null}

      <div className={`record-action${keypadAvailable ? " with-keypad" : ""}`}>
        <button className="primary-button wide" type="submit" disabled={busy} aria-busy={busy}>{submitLabel}</button>
        {editingId ? <div className="record-edit-actions">
          <button className="secondary-button wide" type="button" aria-label="Отменить редактирование операции" onClick={() => reset()}>Отмена</button>
          {/* Удаление живёт здесь, а не в строке истории: разрушающее действие не должно стоять
              под пальцем при пролистывании. */}
          {editingTransaction ? <button className="secondary-button danger-button wide" type="button" disabled={busy} aria-label={`Удалить операцию «${editingLabel}»`} onClick={() => requestDelete(editingTransaction)}>Удалить</button> : null}
        </div> : null}
        {/* §6 Клавиатура суммы: в той же липкой полосе, что и кнопка записи, — над навигацией и
            под табло, которое она не закрывает. Без неё поле зовёт системную клавиатуру. */}
        {keypadAvailable ? <>
          <Keypad onKey={pressKey} disabled={busy} />
          <span className="sr-only" role="status">{spokenAmount}</span>
        </> : null}
      </div>

      {confirmation ? <div className="limit-alert" role="alertdialog" aria-labelledby="operation-confirmation-title">
        <b id="operation-confirmation-title">{confirmation.type === "edit" ? "Подтвердить изменение операции?" : "Удалить операцию?"}</b>
        <span>{confirmation.type === "edit" ? "После сохранения все суммы и лимиты будут пересчитаны." : `${confirmation.label}. Все суммы и лимиты будут пересчитаны.`}</span>
        <button className="primary-button" type="button" disabled={busy} aria-busy={busy} onClick={confirm}>{confirmation.type === "edit" ? "Подтвердить изменения" : "Подтвердить удаление"}</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirmation(null)}>Не менять</button>
      </div> : null}

      {draft.kind === "expense" && editingId === null ? <ul className="list-card">
        <li><button className="list-row" type="button" onClick={() => { chooseKind("income"); setFactOpen(true); }}><span className="list-icon"><Icon name="arrow-down-left" size={24} /></span><span className="list-copy"><strong>Доход или перевод</strong><small>зарплата, между счетами, возврат, взнос в цель</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></button></li>
      </ul> : null}
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

  </div>;
}
