import { indexState, validateTransactionReferences } from "./calculate.js";
import { addDays, dayIndex, MAX_LOCAL_DATE, monthIndex, monthOfDate, shiftDate } from "./calendar.js";
import { documentIds, recurringOccurrenceId } from "./identity.js";
import { baseSnapshot } from "./rates.js";
import type {
  BudgetState,
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
 * - `missing_rate`, `limit` — the rule stops on that day, and the next call starts from it. `limit`
 *   is any bound of one call: occurrences of one rule, occurrences of all rules, or days considered.
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

/**
 * Days of one rule passed over for one reason: `from` and `to` are its first and last day, the same
 * day when the run is one day long.
 *
 * A run is consecutive days of the rule — no day of it written or found written in between — passed
 * over for the same reason. One entry per run rather than per day, because a rule on an archived
 * account from 1900 is forty-six thousand days passed over for one reason, and an entry each made the
 * report the largest thing the call produced (second review of wave 1).
 */
export interface RecurringSkip {
  readonly ruleId: RecurringRuleId;
  readonly from: LocalDate;
  readonly to: LocalDate;
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
  /**
   * How many days one call may consider in all, across every rule — written, found written, or
   * passed over alike. The other two bounds count occurrences written, so days passed over (on an
   * archived account, a deleted occurrence, one already written) cost nothing against them, and ten
   * daily rules from 1900 on an archived account made one call walk four hundred and sixty thousand
   * days. The watermark stops on the last day considered, so the next call goes on from there.
   */
  readonly maxConsidered?: number;
}

/** The default bound of {@link MaterializeOptions.maxPerRule}: more than a year of daily occurrences. */
export const DEFAULT_MAX_OCCURRENCES_PER_RULE = 400;

/**
 * The default bound of {@link MaterializeOptions.maxTotal}: far below the journal's batch of
 * 100 000 operations and the backup's 50 000, and still a year of a family's regular payments.
 */
export const DEFAULT_MAX_OCCURRENCES_PER_CALL = 1_000;

/**
 * The default bound of {@link MaterializeOptions.maxConsidered}: fifty-five years of one daily rule,
 * twenty times the occurrences a call may write, and a few milliseconds of work.
 */
export const DEFAULT_MAX_CONSIDERED_DAYS_PER_CALL = 20_000;

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
 * one rule, `maxTotal` of all rules together, `maxConsidered` days of all rules together, whatever
 * became of them. The watermark then stops on the day before, so the next call — after a rate is
 * entered, or simply the next one — writes the rest. The days are produced one at a time and the
 * watermark is the last day actually considered, so a stop never closes a day nobody looked at:
 * days already written do not count toward the bounds of occurrences, and a rule whose first
 * hundred days exist goes on past them to the days that do not — but every day counts toward the
 * days considered, so no call walks further than that, whatever its days turn out to be.
 *
 * Days passed over are reported in runs ({@link RecurringSkip}): consecutive days of a rule passed
 * over for one reason are one entry.
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
  const maxConsidered = options.maxConsidered ?? DEFAULT_MAX_CONSIDERED_DAYS_PER_CALL;
  if (!Number.isSafeInteger(maxConsidered) || maxConsidered < 1) throw new Error("maxConsidered must be a positive integer");
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
  let considered = 0;
  // Whether the last entry of `skipped` is a run still open: the day considered before this one was
  // passed over too. Any day written or found written closes it.
  let open = false;
  const skip = (ruleId: RecurringRuleId, date: LocalDate, reason: RecurringSkipReason): void => {
    const last = skipped[skipped.length - 1];
    if (open && last !== undefined && last.ruleId === ruleId && last.reason === reason) {
      skipped[skipped.length - 1] = { ...last, to: date };
    } else {
      skipped.push({ ruleId, from: date, to: date, reason });
    }
    open = true;
  };

  for (const rule of index.recurringRules.values()) {
    if (!rule.active) continue;
    const closed = rule.materializedThrough ?? addDays(rule.startDate, -1);
    const end = rule.endDate !== undefined && rule.endDate < horizon ? rule.endDate : horizon;
    let watermark = end;
    let written = 0;
    open = false;

    for (const date of occurrenceDays(rule, closed, end)) {
      if (considered === maxConsidered) {
        skip(rule.id, date, "limit");
        watermark = addDays(date, -1);
        break;
      }
      considered += 1;
      const id = recurringOccurrenceId(rule.id, date);
      if (transactionIds.has(id)) {
        open = false;
        continue;
      }
      if (otherIds.has(id)) {
        skip(rule.id, date, "id_conflict");
        continue;
      }
      if (deleted.has(id)) {
        skip(rule.id, date, "deleted");
        continue;
      }

      const template = rule.template;
      const accounts = template.kind === "transfer" ? [template.fromAccountId, template.toAccountId] : [template.accountId];
      if (accounts.some((accountId) => index.accounts.get(accountId)?.active === false)) {
        skip(rule.id, date, "archived_account");
        continue;
      }
      const categoryId = template.kind === "transfer" ? undefined : template.categoryId;
      if (categoryId !== undefined && index.categories.get(categoryId)?.active === false) {
        skip(rule.id, date, "archived_category");
        continue;
      }
      if (written === maxPerRule || created.length === maxTotal) {
        skip(rule.id, date, "limit");
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
          const value = baseSnapshot(template.amountMinor, currency, index.baseCurrency, rates, date);
          if (value === null) {
            skip(rule.id, date, "missing_rate");
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
      open = false;
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
