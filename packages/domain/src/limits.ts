/**
 * The bounds the model shares with every gate in front of it: the backup gate of the app and the
 * codec of the sync journal.
 *
 * Each of them used to keep its own copy, and the copies disagreed in the one direction that costs
 * data: a goal deadline in the year 2200 or an account sort order of 1 000 001 passed the domain
 * and the backup gate and was then refused by the codec, so the family's first sync threw on every
 * write and the value was stranded on the device that wrote it. A bound written once, here, and
 * imported by all three cannot disagree with itself.
 *
 * Every new field is held to these bounds by the domain itself. Fields that existed before them —
 * the date of an operation, a category's sort order, the amounts — are bounded by the codec and not
 * by the domain: a document written by 1.0.0 may carry a value outside, and it must keep opening.
 * New input is held to them at the form that takes it.
 */

/**
 * Upper bound for a single money field on the wire: 10^10 minor units, a hundred million roubles
 * for one amount. A field bound only; sums are bounded by the journal's integrity gate, because no
 * per-field ceiling can bound a sum.
 */
export const MAX_MONEY_MINOR = 10 ** 10;

/** The bound of a sort order, positive and negative: far beyond any list a family keeps. */
export const MAX_SORT_ORDER = 1_000_000;

/**
 * How many entities of a kind one document may hold. Every kind grows through the journal: a
 * family's devices add accounts, operations and participants alike independently, so the count is
 * a property of the merged journal and not of any one device.
 *
 * Creation refuses beyond the limit where a form creates the kind, so no single device exceeds it.
 * A backup file is refused beyond it, because a file is untrusted input and these counts bound the
 * work its restore does. A document the app already holds — written by this device, or
 * materialised from the journal — is not refused for a count of any kind: several devices creating
 * offline can pass a limit together, an honest offline merge of two devices with sixty accounts
 * each is a hundred and twenty, and refusing the merged state would freeze every device of the
 * family on its last snapshot. The journal reports the overflow instead (`collection_limit`).
 *
 * `budgetLines` bounds the lines of all budgets together and `linesPerBudget` the lines of one.
 */
export const COLLECTION_LIMITS = {
  members: 100,
  tags: 500,
  exchangeRates: 10_000,
  debts: 500,
  recurringRules: 1_000,
  accounts: 100,
  categories: 500,
  budgets: 240,
  goals: 200,
  annualCommitments: 1_000,
  scheduledExpenses: 1_000,
  transactions: 50_000,
  linesPerBudget: 500,
  budgetLines: 10_000,
} as const;

/** How often a recurring rule may repeat: every 1 to 999 days, weeks, months or years. */
export const MAX_RECURRENCE_INTERVAL = 999;
