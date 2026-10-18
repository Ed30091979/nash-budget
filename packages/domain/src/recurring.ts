import { indexState, validateTransactionReferences } from "./calculate.js";
import { addDays, dayIndex, MAX_LOCAL_DATE, monthIndex, monthOfDate, shiftDate } from "./calendar.js";
import { convertMinor, type RateIndex } from "./currency.js";
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

/**
 * Why a day of a rule was passed over. Reported, never silent.
 *
 * - `missing_rate`, `limit` — the rule stops on that day, and the next call starts from it.
 * - `archived_account`, `archived_category` — the family closed what the rule writes to; the day is
 *   passed over for good.
 * - `id_conflict` — another entity, not an operation, already holds the identifier the day's
 *   occurrence is derived to: the day cannot be written without overwriting it, so it is passed over
 *   for good rather than throwing on every device of the family.
 * - `deleted` — the family deleted that occurrence (a tombstone of the journal): it is not written
 *   again, whatever the watermark says.
 */
export type RecurringSkipReason =
  | "missing_rate"
  | "archived_account"
  | "archived_category"
  | "limit"
  | "id_conflict"
  | "deleted";

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
  /**
   * How many occurrences one call may write in all, whatever the number of rules; the rest waits
   * for the next call. Bounded because a call's occurrences travel as one batch of the journal and
   * land in one document: three hundred daily rules from 1900 would otherwise be 120 000 operations
   * in one call, past both the journal's batch and the backup's limit of operations.
   */
  readonly maxTotal?: number;
  /**
   * Identifiers the family has deleted — the journal's tombstones. A day whose derived identifier
   * is among them is passed over (`deleted`) and never written again: a delete is final in the
   * journal, and an occurrence written over its tombstone would show on this device alone.
   */
  readonly deletedIds?: ReadonlySet<StableId>;
}

/** The default bound of {@link MaterializeOptions.maxPerRule}: more than a year of daily occurrences. */
export const DEFAULT_MAX_OCCURRENCES_PER_RULE = 400;

/**
 * The default bound of {@link MaterializeOptions.maxTotal}: far below the journal's batch of
 * 100 000 operations and the backup's 50 000, and still a year of a family's regular payments.
 */
export const DEFAULT_MAX_OCCURRENCES_PER_CALL = 1_000;

/**
 * The days a rule falls on after `after` and on or before `through`, within its own start and end,
 * in order, one at a time: nothing is computed beyond the day the caller stops at.
 *
 * Every occurrence is counted from the start date, never from the occurrence before it: a monthly
 * rule from 31 January falls on 28 February and then on 31 March, not on the 28th for ever after,
 * and a yearly one from 29 February falls on 28 February in a common year and on the 29th again in a
 * leap one. Days and weeks are plain day arithmetic.
 */
export function* occurrenceDays(
  rule: Pick<RecurringRule, "frequency" | "interval" | "startDate" | "endDate">,
  after: LocalDate,
  through: LocalDate,
): Generator<LocalDate, void, undefined> {
  const last = rule.endDate !== undefined && rule.endDate < through ? rule.endDate : through;
  if (last < rule.startDate || last <= after) return;
  const start = dayIndex(rule.startDate, "startDate");
  const afterIndex = dayIndex(after, "after");

  if (rule.frequency === "daily" || rule.frequency === "weekly") {
    const step = rule.interval * (rule.frequency === "weekly" ? 7 : 1);
    // The first k whose day lies after `after`.
    for (let k = Math.max(0, Math.floor((afterIndex - start) / step) + 1); ; k += 1) {
      const date = addDays(rule.startDate, k * step);
      if (date > last) return;
      yield date;
    }
  }

  const stepMonths = rule.interval * (rule.frequency === "yearly" ? 12 : 1);
  // Start a step before the month of `after`, so a clipped day of that month is not missed.
  const monthsAfter = monthIndex(monthOfDate(after), "after") - monthIndex(monthOfDate(rule.startDate), "startDate");
  for (let k = Math.max(0, Math.floor(monthsAfter / stepMonths) - 1); ; k += 1) {
    const date = shiftDate(rule.startDate, k * stepMonths);
    if (date > last) return;
    if (date > after) yield date;
  }
}

/**
 * The days of {@link occurrenceDays} as a list, at most `limit` of them.
 */
export function occurrenceDates(
  rule: Pick<RecurringRule, "frequency" | "interval" | "startDate" | "endDate">,
  after: LocalDate,
  through: LocalDate,
  limit = Number.MAX_SAFE_INTEGER,
): LocalDate[] {
  const dates: LocalDate[] = [];
  if (dates.length >= limit) return dates;
  for (const date of occurrenceDays(rule, after, through)) {
    dates.push(date);
    if (dates.length >= limit) break;
  }
  return dates;
}

/** The base-currency snapshot of an occurrence on a foreign account, or null without a usable rate. */
function snapshotFor(
  amountMinor: number,
  currency: string,
  baseCurrency: string,
  rates: RateIndex,
  date: LocalDate,
): { readonly baseAmountMinor: number; readonly baseCurrency: string; readonly rate: ExchangeRate["rate"] } | null {
  const rate = rates.find(currency, baseCurrency, date);
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
 * For each rule the days are those after its watermark (or from its start) up to `through`, its end
 * and the last day the journal carries. A day whose operation already exists — written by this
 * device earlier or by another one — is passed over, which is what makes the call idempotent. A day
 * on an archived account or category is passed over and reported, and the watermark moves past it:
 * the family archived the account, and writing into it later would be the app deciding otherwise.
 * So is a day whose derived identifier another entity holds (`id_conflict`) or the family deleted
 * (`deleted`, from {@link MaterializeOptions.deletedIds}): neither can ever be written, and neither
 * may throw, because the state that holds it is every device's state.
 *
 * Two reasons stop a rule instead of passing a day over: a foreign occurrence with no usable rate
 * for its day (`missing_rate`), and the bounds of one call (`limit`) — `maxPerRule` occurrences of
 * one rule, `maxTotal` of all rules together. The watermark then stops on the day before, so the
 * next call — after a rate is entered, or simply the next one — writes the rest. The days are
 * produced one at a time and the watermark is the last day actually considered, so a stop never
 * closes a day nobody looked at: days already written do not count toward the bound, and a rule
 * whose first hundred days exist goes on past them to the days that do not.
 *
 * Writing the occurrence without its value in the base currency is not an option: the budget counts
 * that value, and the rate of a later day would revalue the past.
 *
 * Every occurrence is posted, labelled with its rule, identified by `recurringOccurrenceId`, and in
 * a foreign currency carries the snapshot of its own day. It carries no participant: the rule wrote
 * it, not whichever device happened to materialise it. The result is checked by the domain's own
 * rules before it is returned.
 */
export function materializeRecurring(
  state: BudgetState,
  through: LocalDate,
  options: MaterializeOptions = {},
): RecurringMaterialization {
  const maxPerRule = options.maxPerRule ?? DEFAULT_MAX_OCCURRENCES_PER_RULE;
  if (!Number.isSafeInteger(maxPerRule) || maxPerRule < 1) throw new Error("maxPerRule must be a positive integer");
  const maxTotal = options.maxTotal ?? DEFAULT_MAX_OCCURRENCES_PER_CALL;
  if (!Number.isSafeInteger(maxTotal) || maxTotal < 1) throw new Error("maxTotal must be a positive integer");
  const index = indexState(state);
  dayIndex(through, "through");
  // An occurrence past the last day the journal carries could not reach the family.
  const horizon = through < MAX_LOCAL_DATE ? through : MAX_LOCAL_DATE;
  const deleted = options.deletedIds ?? new Set<StableId>();

  const transactionIds = new Set<StableId>(state.transactions.map((item) => item.id));
  const otherIds = new Set<StableId>(documentIds(state).filter((id) => !transactionIds.has(id)));
  const rates = index.rates;
  const created: Transaction[] = [];
  const skipped: RecurringSkip[] = [];
  const watermarks = new Map<RecurringRuleId, LocalDate>();

  for (const rule of index.recurringRules.values()) {
    if (!rule.active) continue;
    const closed = rule.materializedThrough ?? addDays(rule.startDate, -1);
    const end = rule.endDate !== undefined && rule.endDate < horizon ? rule.endDate : horizon;
    let watermark = end;
    let written = 0;

    for (const date of occurrenceDays(rule, closed, end)) {
      const id = recurringOccurrenceId(rule.id, date);
      if (transactionIds.has(id)) continue;
      if (otherIds.has(id)) {
        skipped.push({ ruleId: rule.id, date, reason: "id_conflict" });
        continue;
      }
      if (deleted.has(id)) {
        skipped.push({ ruleId: rule.id, date, reason: "deleted" });
        continue;
      }

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
      if (written === maxPerRule || created.length === maxTotal) {
        skipped.push({ ruleId: rule.id, date, reason: "limit" });
        watermark = addDays(date, -1);
        break;
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
