import { indexState, validateTransactionReferences } from "./calculate.js";
import { addDays, dayIndex, monthIndex, monthOfDate, shiftDate } from "./calendar.js";
import { convertMinor, findRate } from "./currency.js";
import { documentIds, recurringOccurrenceId } from "./identity.js";
import { MAX_MONEY_MINOR } from "./limits.js";
import type {
  BudgetState,
  ExchangeRate,
  LocalDate,
  RecurringRule,
  RecurringRuleId,
  StableId,
  Transaction,
} from "./types.js";

/*
 * ─────────────────────────── Recurring operations ───────────────────────────
 *
 * A rule does not show virtual rows: it writes ordinary posted operations, one per day it falls on,
 * and remembers how far it has written (D-035). Everything here is a pure function of the state and
 * the day it is asked about — no clock, no randomness — so two devices that materialise the same
 * rule offline write the same operations under the same derived identifiers, and the journal meets
 * each of them once.
 */

/** Why a day of a rule was passed over. Reported, never silent. */
export type RecurringSkipReason = "missing_rate" | "archived_account" | "archived_category" | "limit";

export interface RecurringSkip {
  readonly ruleId: RecurringRuleId;
  readonly date: LocalDate;
  readonly reason: RecurringSkipReason;
}

export interface RecurringMaterialization {
  /** The state with the occurrences written and the watermarks moved; the same object when nothing changed. */
  readonly state: BudgetState;
  /** The operations written, in the order of the rules and then of their days. */
  readonly created: readonly Transaction[];
  readonly skipped: readonly RecurringSkip[];
}

export interface MaterializeOptions {
  /** How many occurrences one rule may write in one call; the rest waits for the next call. */
  readonly maxPerRule?: number;
}

/** The default bound of {@link MaterializeOptions.maxPerRule}: more than a year of daily occurrences. */
export const DEFAULT_MAX_OCCURRENCES_PER_RULE = 400;

/**
 * The days a rule falls on after `after` and on or before `through`, within its own start and end,
 * in order, at most `limit` of them.
 *
 * Every occurrence is counted from the start date, never from the occurrence before it: a monthly
 * rule from 31 January falls on 28 February and then on 31 March, not on the 28th for ever after,
 * and a yearly one from 29 February falls on 28 February in a common year and on the 29th again in a
 * leap one. Days and weeks are plain day arithmetic.
 */
export function occurrenceDates(
  rule: Pick<RecurringRule, "frequency" | "interval" | "startDate" | "endDate">,
  after: LocalDate,
  through: LocalDate,
  limit = Number.MAX_SAFE_INTEGER,
): LocalDate[] {
  const last = rule.endDate !== undefined && rule.endDate < through ? rule.endDate : through;
  const dates: LocalDate[] = [];
  if (last < rule.startDate || last <= after) return dates;
  const start = dayIndex(rule.startDate, "startDate");
  const afterIndex = dayIndex(after, "after");

  if (rule.frequency === "daily" || rule.frequency === "weekly") {
    const step = rule.interval * (rule.frequency === "weekly" ? 7 : 1);
    // The first k whose day lies after `after`.
    let k = Math.max(0, Math.floor((afterIndex - start) / step) + 1);
    for (; dates.length < limit; k += 1) {
      const date = addDays(rule.startDate, k * step);
      if (date > last) break;
      dates.push(date);
    }
    return dates;
  }

  const stepMonths = rule.interval * (rule.frequency === "yearly" ? 12 : 1);
  // Start a step before the month of `after`, so a clipped day of that month is not missed.
  const monthsAfter = monthIndex(monthOfDate(after), "after") - monthIndex(monthOfDate(rule.startDate), "startDate");
  let k = Math.max(0, Math.floor(monthsAfter / stepMonths) - 1);
  for (; dates.length < limit; k += 1) {
    const date = shiftDate(rule.startDate, k * stepMonths);
    if (date > last) break;
    if (date > after) dates.push(date);
  }
  return dates;
}

/** The base-currency snapshot of an occurrence on a foreign account, or null without a usable rate. */
function snapshotFor(
  amountMinor: number,
  currency: string,
  baseCurrency: string,
  rates: readonly ExchangeRate[],
  date: LocalDate,
): { readonly baseAmountMinor: number; readonly baseCurrency: string; readonly rate: ExchangeRate["rate"] } | null {
  const rate = findRate(rates, currency, baseCurrency, date);
  if (rate === undefined) return null;
  let baseAmountMinor: number;
  try {
    baseAmountMinor = convertMinor(amountMinor, rate.rate);
  } catch {
    return null;
  }
  // A rate that values the amount at nothing, or past a field's ceiling, is no usable rate either.
  if (baseAmountMinor < 1 || baseAmountMinor > MAX_MONEY_MINOR) return null;
  return { baseAmountMinor, baseCurrency, rate: rate.rate };
}

/**
 * Writes every occurrence of every active rule up to `through`, and moves each rule's watermark.
 *
 * For each rule the days are those after its watermark (or from its start) up to `through` and its
 * end. A day whose operation already exists — written by this device earlier or by another one — is
 * passed over, which is what makes the call idempotent. A day on an archived account or category is
 * passed over and reported, and the watermark moves past it: the family archived the account, and
 * writing into it later would be the app deciding otherwise.
 *
 * Two reasons stop a rule instead of passing a day over: a foreign occurrence with no usable rate
 * for its day (`missing_rate`), and the `maxPerRule` bound (`limit`). The watermark then stops on the
 * day before, so the next call — after a rate is entered, or simply the next one — writes the rest.
 * Writing the occurrence without its value in the base currency is not an option: the budget counts
 * that value, and the rate of a later day would revalue the past.
 *
 * Every occurrence is posted, labelled with its rule, identified by `recurringOccurrenceId`, and in
 * a foreign currency carries the snapshot of its own day. The result is checked by the domain's own
 * rules before it is returned, and a derived identifier already taken by an entity that is not that
 * occurrence is refused rather than overwritten, as a carried-forward month refuses one.
 */
export function materializeRecurring(
  state: BudgetState,
  through: LocalDate,
  options: MaterializeOptions = {},
): RecurringMaterialization {
  const maxPerRule = options.maxPerRule ?? DEFAULT_MAX_OCCURRENCES_PER_RULE;
  if (!Number.isSafeInteger(maxPerRule) || maxPerRule < 1) throw new Error("maxPerRule must be a positive integer");
  const index = indexState(state);
  dayIndex(through, "through");

  const transactionIds = new Set<StableId>(state.transactions.map((item) => item.id));
  const otherIds = new Set<StableId>(documentIds(state).filter((id) => !transactionIds.has(id)));
  const rates = [...index.exchangeRates.values()];
  const created: Transaction[] = [];
  const skipped: RecurringSkip[] = [];
  const watermarks = new Map<RecurringRuleId, LocalDate>();

  for (const rule of index.recurringRules.values()) {
    if (!rule.active) continue;
    const closed = rule.materializedThrough ?? addDays(rule.startDate, -1);
    const end = rule.endDate !== undefined && rule.endDate < through ? rule.endDate : through;
    // One more day than the bound, to know whether the bound stopped the rule.
    const dates = occurrenceDates(rule, closed, end, maxPerRule + 1);
    let watermark = end;
    let written = 0;

    for (const date of dates) {
      if (written === maxPerRule) {
        skipped.push({ ruleId: rule.id, date, reason: "limit" });
        watermark = addDays(date, -1);
        break;
      }
      const id = recurringOccurrenceId(rule.id, date);
      if (transactionIds.has(id)) continue;
      if (otherIds.has(id)) throw new Error(`derived occurrence identifier ${id} is already used`);

      const template = rule.template;
      const accounts = template.kind === "transfer" ? [template.fromAccountId, template.toAccountId] : [template.accountId];
      if (accounts.some((accountId) => index.accounts.get(accountId)?.active === false)) {
        skipped.push({ ruleId: rule.id, date, reason: "archived_account" });
        continue;
      }
      const categoryId = template.kind === "transfer" ? undefined : template.categoryId;
      if (categoryId !== undefined && index.categories.get(categoryId)?.active === false) {
        skipped.push({ ruleId: rule.id, date, reason: "archived_category" });
        continue;
      }

      const labels = {
        ...(template.note === undefined ? {} : { note: template.note }),
        ...(template.tagIds === undefined ? {} : { tagIds: [...template.tagIds] }),
        recurringRuleId: rule.id,
      };
      const common = { id, occurredOn: date, status: "posted" as const, amountMinor: template.amountMinor, ...labels };
      let occurrence: Transaction;
      if (template.kind === "transfer") {
        occurrence = {
          ...common,
          kind: "transfer",
          fromAccountId: template.fromAccountId,
          toAccountId: template.toAccountId,
          ...(template.toAmountMinor === undefined ? {} : { toAmountMinor: template.toAmountMinor }),
        };
      } else {
        const currency = index.accounts.get(template.accountId)!.currency;
        let snapshot = {};
        if (currency !== index.baseCurrency) {
          const value = snapshotFor(template.amountMinor, currency, index.baseCurrency, rates, date);
          if (value === null) {
            skipped.push({ ruleId: rule.id, date, reason: "missing_rate" });
            watermark = addDays(date, -1);
            break;
          }
          snapshot = value;
        }
        occurrence = template.kind === "expense"
          ? { ...common, ...snapshot, kind: "expense", accountId: template.accountId, categoryId: template.categoryId }
          : {
            ...common,
            ...snapshot,
            kind: "income",
            accountId: template.accountId,
            ...(template.categoryId === undefined ? {} : { categoryId: template.categoryId }),
          };
      }
      created.push(occurrence);
      transactionIds.add(id);
      written += 1;
    }

    // The watermark only ever moves forward, and only when it moves: an unchanged rule is not
    // rewritten, so a call that writes nothing gives the journal nothing to send.
    if (watermark > closed) watermarks.set(rule.id, watermark);
  }

  if (created.length === 0 && watermarks.size === 0) return { state, created, skipped };
  const next: BudgetState = {
    ...state,
    recurringRules: (state.recurringRules ?? []).map((rule) => {
      const watermark = watermarks.get(rule.id);
      return watermark === undefined ? rule : { ...rule, materializedThrough: watermark };
    }),
    transactions: created.length === 0 ? state.transactions : [...state.transactions, ...created],
  };
  const checked = indexState(next);
  for (const transaction of created) validateTransactionReferences(transaction, checked);
  return { state: next, created, skipped };
}

/**
 * Stops a rule: it writes nothing more, and every occurrence it wrote stays. Archiving an archived
 * rule changes nothing.
 */
export function archiveRecurringRule(state: BudgetState, id: RecurringRuleId): BudgetState {
  const rule = (state.recurringRules ?? []).find((item) => item.id === id);
  if (rule === undefined) throw new Error(`recurring rule ${id} is not in the state`);
  if (!rule.active) return state;
  return { ...state, recurringRules: (state.recurringRules ?? []).map((item) => (item.id === id ? { ...item, active: false } : item)) };
}

/**
 * Deletes a rule no operation is an occurrence of, and refuses one that has occurrences: that one
 * is stopped instead ({@link archiveRecurringRule}).
 *
 * The plan had the delete take the label off every occurrence. Through the journal that is one
 * whole-entity update per occurrence, settled by last writer wins, and it could silently undo a
 * correction another device made to one of them at the same moment — the reason a tag in use is not
 * deleted either (security review, orchestrator's decision).
 */
export function deleteRecurringRule(state: BudgetState, id: RecurringRuleId): BudgetState {
  if (!(state.recurringRules ?? []).some((item) => item.id === id)) throw new Error(`recurring rule ${id} is not in the state`);
  if (state.transactions.some((transaction) => transaction.recurringRuleId === id)) {
    throw new Error(`recurring rule ${id} has occurrences; stop it instead of deleting it`);
  }
  return { ...state, recurringRules: (state.recurringRules ?? []).filter((item) => item.id !== id) };
}
