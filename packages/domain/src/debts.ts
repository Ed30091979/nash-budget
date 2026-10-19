import { indexState, validateTransactionReferences, type StateIndex } from "./calculate.js";
import { dayIndex, isWithinDateWindow } from "./calendar.js";
import { convertMinor, isSupportedCurrency, safeMinorOrNull } from "./currency.js";
import { documentIds } from "./identity.js";
import { COLLECTION_LIMITS, MAX_MONEY_MINOR } from "./limits.js";
import {
  COUNTERPARTY_MAX_LENGTH,
  isReadableName,
  normalizeLabel,
  TextValidationError,
  type TextErrorCode,
} from "./text.js";
import type {
  BudgetState,
  CurrencyCode,
  Debt,
  DebtBalanceMetrics,
  DebtDirection,
  DebtId,
  DebtMetrics,
  LocalDate,
  MinorUnits,
} from "./types.js";

/**
 * Debts: money lent and borrowed, outside the budget.
 *
 * Lending is not an expense and borrowing is not an income (rule 4 of `contracts/README.md`), so no
 * figure of the budget reads a debt; a debt has a balance of its own, counted by
 * {@link calculateDebts}. The transitions here keep the one invariant the domain is strict about —
 * whatever a debt operation names exists — by refusing to delete a debt anything refers to: such a
 * debt is archived instead, and stays in every total.
 */

export type DebtErrorCode =
  | "counterparty_required"
  | "counterparty_too_long"
  | "counterparty_forbidden_characters"
  | "counterparty_mixed_scripts"
  | "counterparty_unreadable"
  | "unknown_direction"
  | "unknown_currency"
  | "invalid_amount"
  | "invalid_due_date"
  | "limit_reached"
  | "id_required"
  | "duplicate_id"
  | "unknown_debt"
  | "debt_in_use";

/** Refusal a person is meant to read: `code` for the caller, `message` for the screen. */
export class DebtValidationError extends Error {
  readonly code: DebtErrorCode;
  readonly field: "counterparty" | "direction" | "currency" | "openingMinor" | "dueDate" | "id";

  constructor(code: DebtErrorCode, field: DebtValidationError["field"], message: string) {
    super(message);
    this.name = "DebtValidationError";
    this.code = code;
    this.field = field;
  }
}

function fail(code: DebtErrorCode, field: DebtValidationError["field"], message: string): never {
  throw new DebtValidationError(code, field, message);
}

const COUNTERPARTY_REFUSALS: Readonly<Record<TextErrorCode, readonly [DebtErrorCode, string]>> = {
  required: ["counterparty_required", "Укажите, с кем долг."],
  too_long: ["counterparty_too_long", `Не более ${COUNTERPARTY_MAX_LENGTH} символов.`],
  forbidden_characters: ["counterparty_forbidden_characters", "Уберите скрытые или служебные символы."],
  mixed_scripts: ["counterparty_mixed_scripts", "Не смешивайте похожие символы разных алфавитов."],
};

/** Trims and normalises the name of whoever a debt is with, or refuses it — the rule of a name. */
export function normalizeCounterparty(value: string): string {
  let normalized: string;
  try {
    normalized = normalizeLabel(value, COUNTERPARTY_MAX_LENGTH);
  } catch (error) {
    if (!(error instanceof TextValidationError)) throw error;
    const [code, message] = COUNTERPARTY_REFUSALS[error.code];
    return fail(code, "counterparty", message);
  }
  if (!isReadableName(normalized)) fail("counterparty_unreadable", "counterparty", "В имени нужны буквы или цифры.");
  return normalized;
}

export interface DebtDraft {
  readonly counterparty: string;
  readonly direction: DebtDirection;
  readonly currency: CurrencyCode;
  readonly openingMinor: MinorUnits;
  readonly dueDate?: LocalDate;
}

export interface DebtCreation {
  readonly state: BudgetState;
  readonly debt: Debt;
}

/**
 * Creates an active debt. Refuses a malformed counterparty, an unknown direction or currency, an
 * opening amount outside zero and the field ceiling, an impossible due date, and the debt past
 * `COLLECTION_LIMITS.debts`. Two debts with one counterparty are allowed: «Петя» may owe for the
 * holiday and for the car.
 */
export function createDebt(
  state: BudgetState,
  draft: DebtDraft,
  makeId: () => DebtId = () => crypto.randomUUID(),
): DebtCreation {
  const counterparty = normalizeCounterparty(draft.counterparty);
  if (draft.direction !== "i_owe" && draft.direction !== "owed_to_me") {
    fail("unknown_direction", "direction", "Выберите, кто кому должен.");
  }
  if (!isSupportedCurrency(draft.currency)) fail("unknown_currency", "currency", "Выберите валюту из списка.");
  if (!Number.isSafeInteger(draft.openingMinor) || draft.openingMinor < 0 || draft.openingMinor > MAX_MONEY_MINOR) {
    fail("invalid_amount", "openingMinor", "Укажите сумму не меньше нуля.");
  }
  if (draft.dueDate !== undefined) {
    let valid = true;
    try {
      dayIndex(draft.dueDate);
    } catch {
      valid = false;
    }
    if (!valid || !isWithinDateWindow(draft.dueDate)) fail("invalid_due_date", "dueDate", "Выберите существующую дату с 1900 по 2199 год.");
  }
  const debts = state.debts ?? [];
  if (debts.length >= COLLECTION_LIMITS.debts) {
    fail("limit_reached", "counterparty", `Долгов уже ${COLLECTION_LIMITS.debts} — это предел.`);
  }
  const id = makeId();
  if (typeof id !== "string" || id.trim().length === 0) fail("id_required", "id", "Не удалось создать идентификатор долга.");
  if (documentIds(state).includes(id)) fail("duplicate_id", "id", "Не удалось создать уникальный идентификатор долга.");

  const debt: Debt = {
    id,
    counterparty,
    direction: draft.direction,
    currency: draft.currency,
    openingMinor: draft.openingMinor,
    ...(draft.dueDate === undefined ? {} : { dueDate: draft.dueDate }),
    active: true,
  };
  const next: BudgetState = { ...state, debts: [...debts, debt] };
  // The whole state, by the domain's own rules: a due date outside the window, for one.
  indexState(next);
  return { state: next, debt };
}

function requireDebt(state: BudgetState, id: DebtId): Debt {
  const debt = (state.debts ?? []).find((item) => item.id === id);
  if (debt === undefined) fail("unknown_debt", "id", "Долг не найден.");
  return debt;
}

/**
 * Archives a debt: it is no longer offered for new operations and stays in every total and on every
 * operation that names it. Archiving an archived debt changes nothing.
 */
export function archiveDebt(state: BudgetState, id: DebtId): BudgetState {
  const debt = requireDebt(state, id);
  if (!debt.active) return state;
  return { ...state, debts: (state.debts ?? []).map((item) => (item.id === id ? { ...item, active: false } : item)) };
}

/** Whether any operation names the debt. */
function isReferenced(state: BudgetState, id: DebtId): boolean {
  return state.transactions.some(
    (transaction) => (transaction.kind === "debt_out" || transaction.kind === "debt_in") && transaction.debtId === id,
  );
}

/**
 * Deletes a debt nothing refers to, and refuses one an operation names: that one is archived
 * instead ({@link archiveDebt}). An operation on a deleted debt would have nothing to move, and its
 * money cannot be quietly dropped the way a label can.
 */
export function deleteDebt(state: BudgetState, id: DebtId): BudgetState {
  requireDebt(state, id);
  if (isReferenced(state, id)) {
    fail("debt_in_use", "id", "По долгу есть операции. Его можно убрать в архив: в итогах он останется.");
  }
  return { ...state, debts: (state.debts ?? []).filter((item) => item.id !== id) };
}

/** A sum that stays a safe integer, or null when it would not. */
function addOrNull(total: MinorUnits, value: MinorUnits): MinorUnits | null {
  const sum = total + value;
  return Number.isSafeInteger(sum) ? sum : null;
}

/**
 * Every debt of the household on `asOf`: what was owed at the start, what moved since, and what is
 * owed now — in the debt's own currency, and in the base currency at the latest rate dated on or
 * before `asOf`.
 *
 * Cumulative, and blind to budgets: a debt's balance does not reset with the month. Only posted
 * operations dated on or before `asOf` count. Archived debts count like any other: archiving hides a
 * debt from new operations, it does not forgive it.
 *
 * Never throws on a magnitude. Every amount here is written by some participant of the family — an
 * opening balance, a movement, a rate up to a trillion — and an exception would refuse the whole
 * state on every device, including the day a movement dated next month comes into the window. So
 * the arithmetic is exact, in BigInt, and what cannot be represented is null: a sum of movements or
 * a balance outside the safe range, a balance with no rate or worth more than the safe range in the
 * base currency (listed in `unvaluedDebtIds`, left out of the totals), and a net position the two
 * totals cannot be subtracted into. It does throw, like every calculation, on a state the domain
 * refuses.
 */
export function calculateDebts(state: BudgetState, asOf: LocalDate): DebtMetrics {
  const index = indexState(state);
  dayIndex(asOf, "asOf");
  for (const transaction of state.transactions) validateTransactionReferences(transaction, index);
  return debtMetricsOf(state, index, asOf);
}

/**
 * {@link calculateDebts} over a state already indexed and validated with `index`, so the holdings
 * of the same state on the same day value its debts without indexing and validating it twice. Not
 * part of the package's public surface.
 */
export function debtMetricsOf(state: BudgetState, index: StateIndex, asOf: LocalDate): DebtMetrics {
  const baseCurrency = index.baseCurrency;

  // What moved on each debt up to the day, in the debt's own currency: the debt amount when the
  // account is in another currency, the amount itself otherwise. Exact, whatever the count.
  const moved = new Map<DebtId, { out: bigint; in: bigint }>();
  for (const transaction of state.transactions) {
    if (transaction.kind !== "debt_out" && transaction.kind !== "debt_in") continue;
    if (transaction.status !== "posted" || transaction.occurredOn > asOf) continue;
    const amount = BigInt(transaction.debtAmountMinor ?? transaction.amountMinor);
    const current = moved.get(transaction.debtId) ?? { out: 0n, in: 0n };
    moved.set(
      transaction.debtId,
      transaction.kind === "debt_out" ? { out: current.out + amount, in: current.in } : { out: current.out, in: current.in + amount },
    );
  }

  const debts: DebtBalanceMetrics[] = [];
  const byDebt = Object.create(null) as Record<DebtId, DebtBalanceMetrics>;
  const unvaluedDebtIds: DebtId[] = [];
  let receivableInBaseMinor = 0;
  let payableInBaseMinor = 0;

  for (const debt of index.debts.values()) {
    const out = moved.get(debt.id)?.out ?? 0n;
    const into = moved.get(debt.id)?.in ?? 0n;
    const opening = BigInt(debt.openingMinor);
    const balance = debt.direction === "owed_to_me" ? opening + out - into : opening + into - out;
    const balanceMinor = safeMinorOrNull(balance);

    let balanceInBaseMinor: MinorUnits | null = null;
    if (balanceMinor !== null && debt.currency === baseCurrency) {
      balanceInBaseMinor = balanceMinor;
    } else if (balanceMinor !== null) {
      const rate = index.rates.find(debt.currency, baseCurrency, asOf);
      if (rate !== undefined) {
        try {
          balanceInBaseMinor = convertMinor(balanceMinor, rate.rate);
        } catch {
          balanceInBaseMinor = null;
        }
      }
    }
    if (balanceInBaseMinor !== null) {
      // A debt that would carry its total past what can be represented is not valued either: a
      // total that silently left it out would be a figure nobody could check.
      const total = debt.direction === "owed_to_me" ? receivableInBaseMinor : payableInBaseMinor;
      const next = addOrNull(total, balanceInBaseMinor);
      if (next === null) balanceInBaseMinor = null;
      else if (debt.direction === "owed_to_me") receivableInBaseMinor = next;
      else payableInBaseMinor = next;
    }
    if (balanceInBaseMinor === null) unvaluedDebtIds.push(debt.id);

    const metrics: DebtBalanceMetrics = {
      debtId: debt.id,
      direction: debt.direction,
      currency: debt.currency,
      outMinor: safeMinorOrNull(out),
      inMinor: safeMinorOrNull(into),
      balanceMinor,
      balanceInBaseMinor,
      // Decided on the exact balance, so a balance too large to show is still overdue when it is.
      overdue: debt.dueDate !== undefined && debt.dueDate < asOf && balance > 0n,
    };
    debts.push(metrics);
    byDebt[debt.id] = metrics;
  }

  return {
    asOf,
    baseCurrency,
    debts,
    byDebt,
    receivableInBaseMinor,
    payableInBaseMinor,
    // Exactly, in BigInt: two totals each within the safe range — a receivable and an overpaid,
    // negative payable — may still not subtract into it.
    netInBaseMinor: safeMinorOrNull(BigInt(receivableInBaseMinor) - BigInt(payableInBaseMinor)),
    unvaluedDebtIds,
  };
}
