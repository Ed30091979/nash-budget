import { calculateBudget } from "./calculate.js";
import { carriedId, documentIds } from "./identity.js";
import {
  monthEndDate,
  monthIndex,
  monthOfDate,
  monthStartDate,
  shiftMonth,
} from "./calendar.js";
import type {
  Budget,
  BudgetId,
  BudgetLine,
  BudgetLineId,
  BudgetState,
  LocalDate,
  StableId,
} from "./types.js";

export { carriedId } from "./identity.js";

/**
 * Carrying a plan into the next month — the envelope method the data model was always shaped for
 * and nothing ever performed.
 *
 * A budget covers one month. Until this file existed the only place a monthly budget was ever
 * created was onboarding, so a household that set the app up in July still had a July plan in
 * August: the month showed as closed, every new purchase went into history without landing in a
 * single envelope, and limits stopped meaning anything. `rolloverMinor` had been on
 * {@link BudgetLine} from the beginning and counted towards the available amount
 * (`calculate.ts`), but nothing wrote it. This is what writes it.
 *
 * Everything here is a pure function of the state it is given. It reads no clock and mints no
 * randomness, because both of those would make two devices of one family disagree about what
 * they just did — see {@link carriedId}.
 */

/** The month a budget plans for. */
export function budgetMonth(budget: Budget): string {
  return monthOfDate(budget.startDate);
}

/** The budget that plans `month`, if the state has one. */
export function findBudgetForMonth(state: BudgetState, month: string): Budget | undefined {
  monthIndex(month, "month");
  return state.budgets.find((budget) => budgetMonth(budget) === month);
}

/**
 * Which month a finished plan should be continued into: the month today falls in.
 *
 * Not "the month after the plan", because a family that was away for the whole of August wants
 * September — the month its money is being spent in — and not a month that is already over. The
 * one thing this may never return is the plan's own month, so a period shorter than a calendar
 * month still moves forward instead of offering to open the month it is already in.
 */
export function monthAfterPeriod(budget: Budget, today: LocalDate): string {
  const own = budgetMonth(budget);
  const now = monthOfDate(today);
  return monthIndex(now, "today") > monthIndex(own, "budget month") ? now : shiftMonth(own, 1);
}

/*
 * ─────────────────────────── Identity ───────────────────────────
 *
 * The identifiers of a carried-forward month are derived, not drawn, so that two devices opening
 * the same month offline name it the same way — see {@link carriedId}, which lives in
 * `identity.ts` with every other derived identifier and is re-exported here for the callers that
 * have always found it in this module.
 */

/** The identifier the plan of `month`, carried forward from `sourceBudgetId`, always gets. */
export function carriedBudgetId(sourceBudgetId: BudgetId, month: string): BudgetId {
  return carriedId("budget", sourceBudgetId, month);
}

/** The identifier a carried-forward line always gets, derived from the line it continues. */
export function carriedBudgetLineId(sourceLineId: BudgetLineId, month: string): BudgetLineId {
  return carriedId("budgetLine", sourceLineId, month);
}

/* ─────────────────────────── Carrying forward ─────────────────────────── */

export interface CarriedBudget {
  /** The state with the month opened and pointed at. */
  readonly state: BudgetState;
  /** The budget that now plans the month. */
  readonly budget: Budget;
  /** False when the month was already planned and the state merely points at it now. */
  readonly created: boolean;
}

/**
 * The budget a new month continues: the last one that starts before it.
 *
 * Deliberately not "the active one". The active pointer is one more thing two devices have to
 * agree about, while the list of budgets and their dates is the same on both; picking the latest
 * one that precedes the month is a function of that list alone.
 */
function sourceBudgetFor(state: BudgetState, month: string): Budget | undefined {
  const start = monthStartDate(month);
  return [...state.budgets]
    .filter((budget) => budget.startDate < start)
    // Two budgets are never allowed to start on the same day, but the tie is broken anyway so
    // that the choice cannot depend on the order the journal happened to deliver them in.
    .sort((left, right) => left.startDate.localeCompare(right.startDate) || left.id.localeCompare(right.id))
    .at(-1);
}

/**
 * Opens `month` by carrying the previous plan into it, and points the state at it.
 *
 * The plan carries: every line keeps its `plannedMinor`, so next month starts with the same
 * envelopes the family sized itself. What the family did not spend carries too — into
 * `rolloverMinor`, which the domain adds to the plan when it works out what is available. That
 * is the envelope method: money left in an envelope stays in that envelope.
 *
 * Idempotent by construction. Calling it twice, or on two devices at once, cannot produce two
 * budgets for one month: the second call finds the month already planned and only moves the
 * pointer, and two devices that never met derive the same identifiers for the budget and each of
 * its lines (see {@link carriedId}).
 */
export function carryBudgetForward(state: BudgetState, month: string): CarriedBudget {
  const existing = findBudgetForMonth(state, month);
  if (existing !== undefined) {
    return {
      state: state.activeBudgetId === existing.id ? state : { ...state, activeBudgetId: existing.id },
      budget: existing,
      created: false,
    };
  }

  const source = sourceBudgetFor(state, month);
  if (source === undefined) {
    throw new Error(`no budget precedes ${month}, so there is nothing to carry forward`);
  }

  // Validates the whole state on the way, exactly like every other calculation: a plan is never
  // carried out of a state the domain would refuse.
  const metrics = calculateBudget(state, source.id);
  const categories = new Map(state.categories.map((category) => [category.id, category]));

  const lines: BudgetLine[] = [];
  for (const line of source.lines) {
    const category = categories.get(line.categoryId);
    // A line whose category was archived does not come along. The category is gone from the
    // household, the domain already gives such a line nothing available, and resurrecting the
    // envelope in a new month would be the app deciding to keep a category the family retired.
    if (category === undefined || !category.active) continue;

    const remainingMinor = metrics.categoryMetrics[line.categoryId]?.remainingMinor ?? 0;
    // Two decisions live in this one line.
    //
    // An archived line keeps its plan and arrives with its envelope empty. Its remainder is not
    // money: the domain makes an archived line's available amount zero for the whole month, so
    // there was never anything in that envelope to carry. The plan survives so that
    // un-archiving restores the number the family chose rather than a zero.
    //
    // And overspending does not carry as a debt. The model says so before the product does —
    // `rolloverMinor` is validated as non-negative, so a minus has nowhere to live — and the
    // product agrees: the overspend already happened, the month it happened in goes on saying so
    // for as long as it exists, and opening the next month already in the red would be the app
    // punishing a family for a month it has closed. What carries is what is left over; nothing
    // left over carries nothing.
    const rolloverMinor = line.active === false ? 0 : Math.max(0, remainingMinor);

    lines.push({
      id: carriedBudgetLineId(line.id, month),
      categoryId: line.categoryId,
      plannedMinor: line.plannedMinor,
      // Absent stays absent: an omitted field is how every budget written before this one spells
      // "no adjustment", and the journal compares fields, not intentions.
      ...(line.active === false ? { active: false as const } : {}),
      ...(rolloverMinor > 0 ? { rolloverMinor } : {}),
      // `adjustmentMinor` is not carried on purpose: an adjustment is a correction the family
      // made to one month — "this month we also need 2 000 ₽ for the dentist" — and repeating it
      // silently every month afterwards is precisely the sort of thing nobody asked for.
    });
  }

  const budget: Budget = {
    id: carriedBudgetId(source.id, month),
    startDate: monthStartDate(month),
    endDate: monthEndDate(month),
    status: "open",
    // The income plan and the warning threshold are the family's settings, not the month's
    // outcome: they carry unchanged, and the planning screen edits them when they change.
    plannedIncomeMinor: source.plannedIncomeMinor,
    warningThreshold: source.warningThreshold,
    lines,
  };

  assertFreshIds(state, budget);

  return {
    state: {
      ...state,
      activeBudgetId: budget.id,
      budgets: [
        ...state.budgets.map((item) =>
          // A period that ends before the new one begins is over, and the record now says so.
          // Nothing computes anything from `status`; it is there to be true.
          item.id === source.id && item.endDate < budget.startDate && item.status !== "closed"
            ? { ...item, status: "closed" as const }
            : item,
        ),
        budget,
      ],
    },
    budget,
    created: true,
  };
}

/**
 * Refuses to write a derived name that is already taken by anything at all.
 *
 * A 128-bit digest colliding inside one household is not a thing that happens, which is exactly
 * why the branch has to exist: if it ever did happen, silently overwriting the family's plan
 * with a new month's would be far worse than refusing to open the month. Every entity is
 * counted, not only budgets: identifiers are checked for uniqueness across the whole document.
 */
function assertFreshIds(state: BudgetState, budget: Budget): void {
  const taken = new Set<StableId>(documentIds(state));
  for (const id of [budget.id, ...budget.lines.map((line) => line.id)]) {
    if (taken.has(id)) throw new Error(`carried identifier ${id} is already used`);
    taken.add(id);
  }
}
