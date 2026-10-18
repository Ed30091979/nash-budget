import type {
  Account,
  AnnualCommitment,
  Budget,
  BudgetId,
  BudgetLine,
  Category,
  CurrencyCode,
  Debt,
  ExchangeRate,
  Goal,
  Household,
  ScheduledExpense,
  StableId,
  Tag,
  Transaction,
} from "@family-budget/domain";
import { COLLECTION_LIMITS, DEFAULT_BASE_CURRENCY, HOUSEHOLD_ID } from "@family-budget/domain";

import {
  canonicalOperationText,
  deepFreeze,
  HONEST_LAMPORT_CEILING,
  MAX_HONEST_LAMPORT,
  MAX_LAMPORT,
  MAX_LAMPORT_SKEW,
  MAX_MONEY_MINOR,
  parseOperation,
  parseUuid,
  SyncProtocolError,
} from "./codec.js";
import { sha256Hex } from "./digest.js";
import type {
  ActivateBudgetOperation,
  DeviceId,
  EntityKind,
  JournalEntry,
  JournalIntegrity,
  JournalProblem,
  JournalProblemCode,
  JournalSnapshot,
  Member,
  OpId,
  Operation,
  SyncedBudgetState,
  WithheldEntity,
} from "./types.js";
import { ENTITY_KINDS, UNSHOWABLE_PROBLEM_CODES } from "./types.js";

/**
 * Ceiling for every total the gate adds up: 10^13 minor units, a hundred billion roubles.
 *
 * The gate adds up, over the whole converged journal, every total the domain builds — the four
 * transaction totals, every account balance, capital, the planned expenses of every budget, the
 * goal plan, the scheduled expenses and the annual commitments — and says so out loud when one
 * of them leaves this ceiling. Every sum the domain can then build is a sum of like-signed terms
 * out of one of those totals, so it stays inside it as well, and {@link COMBINED_AGGREGATES} of
 * them added together still stay safe.
 *
 * Nothing is withheld for it, and this is the whole account of the eviction that used to be
 * here; everywhere else that mentions it points back at this constant. Round after round of
 * review was spent on the question of *which* entity an over-budget total should give up, and
 * every answer was the same defect in a new spelling: the dimension the eviction sorted by was
 * always a field the writing peer fills in for itself. The last of them sorted by `amountMinor`,
 * which looks like a measure with a meaning of its own and is not one — a peer that stamps its
 * amounts one kopeck below the family's puts the family's salary at the head of the queue, so
 * the family's own records go first and the family is told for ever that its budget is not
 * ready.
 *
 * The margin below the safe integer range is what makes the report enough. A total has to pass
 * a hundred billion roubles before this fires and nine quadrillion before the domain refuses to
 * add it, which is a flood of nine hundred thousand payments at the field ceiling — not a
 * distance an honest family covers, and a distance a participant who wanted the family's data
 * gone could cover far more cheaply by deleting it. See decision 39: the adversary of the merge
 * is the server and the network, not a member of the family.
 */
export const MAX_AGGREGATE_MINOR = 10 ** 13;

/**
 * Where every accumulator of the gate stops growing: the totals ceiling with a wide margin.
 *
 * The gate adds a total up before it knows whether the total fits, and nothing bounds how many
 * amounts a journal holds, so the pass that measures a family's money would otherwise be the
 * first thing a flood of amounts broke: the additions themselves would leave the safe integer
 * range and every comparison after them would be meaningless. Every accumulator saturates here
 * instead of climbing towards Number.MAX_SAFE_INTEGER, and a saturated accumulator reads as out
 * of range because this value is far above {@link MAX_AGGREGATE_MINOR}.
 *
 * Saturation loses information — a saturated total says "at least this much" and no more — and
 * that costs nothing here, because what the gate does with the answer is report it. This is the
 * whole of the safe integer invariant on the merge side: the gate never leaves the range while
 * measuring, whatever it is handed.
 */
export const SATURATION_MINOR = MAX_AGGREGATE_MINOR * 100;

/**
 * Entries one journal holds before the gate says so out loud — counted over the whole converged
 * journal, so tombstones and the entities the gate withholds are counted with the rest. Nothing
 * is withheld for crossing it, ever.
 *
 * This is the whole account of the eviction that used to stand here; everywhere else that
 * mentions it points back at this constant.
 *
 * It used to be enforced, and enforcing it was one appearance of a defect this package met again
 * and again. A limit needs a dimension — something to measure a participant's share by — and the
 * dimension chosen was the identifier of the writing device, so that a flooder would evict its
 * own entries and nobody else's. But `deviceId` is a field of the operation: the codec checks
 * that it has the shape of a UUID and nothing else, and SYNC_ARCHITECTURE forbids the server to
 * compare it with the device that uploaded the envelope, because a device that rotates its key
 * must go on writing under the identity it had. So the peer being bounded wrote the measure of
 * its own share, drew itself a fresh identity for every entry, and the budget was shared again —
 * one flood took every account, every category, the budget and all five hundred transactions of
 * a family out of the state, identically in both delivery orders and for good, because the
 * journal never shrinks.
 *
 * The whole class goes with the enforcement, and the last eviction this package had went the
 * same way for the same reason — see {@link MAX_AGGREGATE_MINOR}. What holds the safe integer
 * invariant is {@link SATURATION_MINOR} on the merge side and the domain's own refusal to add
 * an unsafe total on the consumer side; neither of them needs anybody's records taken away.
 *
 * What is left here is a number a consumer can show a person: a journal this large is worth
 * looking at, and the family goes on seeing every entry in it.
 */
export const MAX_JOURNAL_ENTRIES = 100_000;

/** Operations one call may fold. Matches the epoch quota of the sync protocol. */
export const MAX_BATCH_OPERATIONS = 100_000;

/*
 * There is deliberately no ceiling here on the entries a snapshot from storage may carry, and
 * this note stands where the constant used to.
 *
 * There used to be one — the entry budget plus one batch quota — and it was a ceiling below what
 * the fold builds. The fold bounds nothing: it keeps every distinct identifier the journal has
 * ever seen, because dropping an entry would revive an entity a tombstone had ended, and a
 * device folding envelope after envelope passes any fixed number given enough of them. So a
 * device could write a snapshot it was afterwards unable to read: `restoreJournal` threw, every
 * later call threw with it, and the device never started again. Whatever the fold can build, the
 * restore must accept.
 *
 * Nothing is given up by dropping the ceiling. It never bounded the memory it looked like it
 * bounded — the array is already in the caller's hands, fully materialised, before the first
 * length is read — and every entry is still validated one by one against the codec, which bounds
 * each of them to MAX_OPERATION_BYTES. What keeps the gate's own arithmetic safe while it adds
 * those numbers up is the saturating accumulator of MAX_AGGREGATE_MINOR; the entry count bounds
 * nothing at all any more, for the reasons written at MAX_JOURNAL_ENTRIES. What the ceiling
 * actually did was turn an oversized journal into a device that never starts again.
 */

/**
 * Operation identifiers one journal remembers, as a sliding window over the epochs it folded.
 *
 * Bookkeeping must not grow without end, and on the fold side the ceiling used to be a throw.
 * That handed a peer an off switch: a forged snapshot listing a million identifiers locked the
 * device out of its own journal for good, including the operations it wrote itself, because
 * every later call threw before it applied anything. A fold that crosses the ceiling drops the
 * oldest identifiers instead and reports the drop. Nothing depends on the set for correctness
 * — it is never a reason to skip an operation — so a forgotten identifier costs an extra fold,
 * not a divergence.
 *
 * Reading a snapshot back from storage still refuses a set larger than this, and that refusal
 * is not the lockout it replaced. A snapshot this module writes never carries more than the
 * ceiling, because the fold that produced it trimmed the window before handing it back, so the
 * refusal can only fall on a set some other writer made up — never on a device's own journal.
 * It stays a rejection of malformed input rather than an off switch. See `readAppliedOpIds`.
 */
export const MAX_APPLIED_OP_IDS = 1_000_000;

/**
 * How much of the bookkeeping window one trim gives back: a whole epoch quota.
 *
 * Dropping exactly the excess meant a trim on every envelope once the ceiling was reached, and
 * every trim shifts the whole window — a million moves per envelope at the ceiling, which is
 * the same denial of service the throw used to be, only quieter. The window is cut back by an
 * epoch instead, so the shift is paid once per epoch of operations. Dropping more than strictly
 * necessary costs nothing but a repeated fold, because the set is bookkeeping and never a
 * reason to skip an operation.
 */
const APPLIED_OP_ID_EPOCH = 100_000;

/**
 * Tombstones one author may own before the gate says so out loud.
 *
 * A delete is applied whatever the journal has seen, because refusing an unknown target made
 * the outcome depend on delivery order and split families for good. The remaining abuse — a
 * peer minting tombstones against identifiers it invented — is answered by a budget, not by
 * a drop: crossing it is reported and nothing is withheld, so an honest bulk deletion still
 * shows the family its budget.
 *
 * "Author" is not "deviceId", and that distinction is the whole value of the signal. Counting
 * strictly per `deviceId` made this the last thing a fresh identity switched off: a peer that
 * drew itself a new identifier every five thousand deletes reset the count every five thousand
 * deletes, so the one report that says a family is being emptied never fired. Authors the
 * family has never seen anything from share one bucket — see {@link reportTombstoneBudget}.
 */
export const MAX_TOMBSTONES_PER_DEVICE = 5_000;

/** Totals the annual plan adds together at once: scheduled + flexible + reserve + goal plan. */
const COMBINED_AGGREGATES = 4;

/**
 * The invariant the ceilings above hold between them, checked where it cannot be silently
 * broken by editing one of them.
 *
 * 1. Every total the gate bounds stays safe when the annual plan adds
 *    {@link COMBINED_AGGREGATES} of them together. The domain throws on the first unsafe
 *    addition and takes every calculation in the family with it.
 * 2. A single amount the codec accepts is never larger than the totals ceiling, so one honest
 *    payment can never be refused by the gate that is supposed to bound sums of payments.
 * 3. A saturated accumulator always reads as out of range, so a total the gate could not
 *    measure exactly can never be mistaken for a total that fits.
 * 4. Every addition the gate performs stays a safe integer on its own: an accumulator sits at
 *    most at the saturation point, the widest single step is one saturated balance added to a
 *    saturated running capital, and one more amount on top of that is still safe. Without this
 *    the gate would lose its own arithmetic before it could report anything about the journal's.
 *
 * The count-based clause that used to head this list — a bounded number of entities carrying a
 * bounded number of amounts — is gone with the enforcement of {@link MAX_JOURNAL_ENTRIES}, and
 * so is the circularity it rested on: see that constant for why nothing is evicted any more.
 */
function assertMoneyCeilings(): void {
  if (COMBINED_AGGREGATES * MAX_AGGREGATE_MINOR > Number.MAX_SAFE_INTEGER) {
    throw new SyncProtocolError("aggregate ceiling allows a combined total outside the safe integer range");
  }
  if (MAX_MONEY_MINOR > MAX_AGGREGATE_MINOR) {
    throw new SyncProtocolError("aggregate ceiling is below the ceiling of a single amount");
  }
  if (SATURATION_MINOR <= MAX_AGGREGATE_MINOR) {
    throw new SyncProtocolError("saturation point is not above the aggregate ceiling");
  }
  if (2 * SATURATION_MINOR + MAX_MONEY_MINOR > Number.MAX_SAFE_INTEGER) {
    throw new SyncProtocolError("saturating accumulators allow an addition outside the safe integer range");
  }
}

/**
 * Adds one term to an accumulator of the gate and stops at {@link SATURATION_MINOR}.
 *
 * Nothing bounds how many entities a journal holds — see {@link MAX_JOURNAL_ENTRIES} for why
 * that is deliberate — so nothing bounds how many terms land in one of these totals either.
 * Left alone, the pass that measures a family's money would be the first thing a flood of
 * amounts broke: additions would leave the safe integer range, every comparison after that
 * would be meaningless, and the gate would hand the domain a state it had never actually
 * measured.
 */
function addSaturating(total: number, delta: number): number {
  const sum = total + delta;
  if (sum > SATURATION_MINOR) return SATURATION_MINOR;
  if (sum < -SATURATION_MINOR) return -SATURATION_MINOR;
  return sum;
}

assertMoneyCeilings();

const ENTITY_ORDER = new Map<EntityKind, number>(ENTITY_KINDS.map((entity, index) => [entity, index]));
/**
 * The codes that say the state itself cannot be shown. Nothing else lowers `ready` — see
 * UNSHOWABLE_PROBLEM_CODES in types.ts for the two questions this separates.
 */
const UNSHOWABLE = new Set<JournalProblemCode>(UNSHOWABLE_PROBLEM_CODES);

/**
 * Separator for every composite key this module builds.
 *
 * U+0000 is refused by the codec in identifiers and in names alike, so a key built with it can
 * be taken apart again in exactly one way. A space cannot: the codec allows one inside an
 * identifier, so `${budgetId} ${categoryId}` gave the pair ("fam 1", "cat") and the pair
 * ("fam", "1 cat") one and the same key — and one operation naming identifiers that never
 * existed then deleted the line a family had planned, before being swept out as dangling
 * itself. Nothing here may be joined with a character an identifier is allowed to carry.
 */
const KEY_SEPARATOR = "\u0000";

function entryKey(entity: EntityKind, targetId: StableId): string {
  return `${entity}${KEY_SEPARATOR}${targetId}`;
}

/**
 * The stamp as the merge ranks it, which is not the stamp as the writer wrote it.
 *
 * A Lamport stamp is a number the writing device chooses for itself, and for four rounds of
 * review the first key of this total order was that number. So "decided by the total order"
 * meant "decided in favour of whoever wrote the larger number": one operation stamped 2^40
 * took the budget line a family had planned, took a salary out of the state through an
 * identifier collision, and rewrote the family's account with a balance of its own — each
 * time deterministically, on every replica, with the snapshot still calling itself ready.
 *
 * At {@link HONEST_LAMPORT_CEILING} and above no clock reading exists: see the arithmetic
 * there. A stamp on the line or above it is therefore given no rank at all rather than the
 * highest one. Clamping it down *to* the ceiling would have left the lever exactly where it was
 * — the hostile stamp would still have stood above every honest one, and the family, whose
 * clock is nowhere near the ceiling, could never have written anything above it to answer with.
 * Ranked at the floor instead, such an operation loses every contest with an honest write, ties
 * with every other implausible one, and the tie goes to the digest tiebreaker below. The
 * comparison is deliberately not strict: a strict one spared the value of the ceiling itself,
 * and `2 ** 32` ranked at 4 294 967 296.
 *
 * The line is the codec's constant and nothing else. The sixth round replaced it with a
 * threshold derived from the journal — the top of the ladder of stamps the journal itself
 * contained — so that outranking a family would cost the ladder that family had climbed. It
 * cost 4295 operations, 4.3 % of one batch quota, to build that ladder to the absolute ceiling;
 * and until it was built, a young family's line sat at MAX_LAMPORT_SKEW, so one operation
 * stamped just below it took any entity in the family. Every input to a journal-derived
 * threshold is written by the peer the threshold is supposed to bound, so the threshold is
 * whatever that peer decides it should be. Decision 39 settles the boundary instead: the
 * adversary of the merge is the server and the network — delivery order, delay, duplication,
 * restart — not a member of the family, who can delete the whole budget through the front door.
 * Ranking by the stamp and the digest is what makes the merge deterministic and order
 * independent; the anchor that makes it byzantine-proof is the server's own sequencing, and it
 * arrives in phase S4.
 *
 * The operation is still merged, and it still owns an entity nobody else wrote: refusing it
 * would make the journal depend on which device the delivery reached first, which is the
 * defect this whole file is built to avoid. What it can no longer do is take something.
 */
function rankedLamport(lamport: number): number {
  return lamport >= HONEST_LAMPORT_CEILING ? 0 : lamport;
}

/**
 * The value that settles a tie in the ranked stamp: SHA-256 over the writing device, the
 * operation identifier and the canonical encoding of the operation.
 *
 * The tie used to be settled by the raw identifiers, compared as text. Both of them are UUID v4
 * by the codec, and that was taken to mean no participant could reach for a value the others
 * could not — but a UUID v4 has a largest string, `ffffffff-ffff-4fff-bfff-ffffffffffff`, and
 * anybody can write it down. A peer that called itself that won every conflict at an equal
 * stamp, which is exactly the set of conflicts this order exists to settle: the same
 * "alphabet of the identifier" lever as the very first round, in a smaller alphabet.
 *
 * A digest has no reachable maximum. It stays a pure function of the operation, so every replica
 * still settles the tie the same way and a restore settles it the same way as the fold that
 * built the journal; what changes is the price of aiming it, from one hardcoded string to a
 * search per conflict. Both identifiers are hashed in as well as the encoding that already
 * carries them, so nothing about the tie depends on how the encoding happens to order its keys.
 *
 * Memoised per operation object, because a comparator runs a great many times over the same
 * frozen operations: a sort over a journal-sized set compares a hundred thousand of them, and
 * hashing inside the comparison rather than once per operation is the difference between
 * milliseconds and minutes.
 */
const TIEBREAK_DIGESTS = new WeakMap<Operation, string>();

function tiebreakDigest(operation: Operation): string {
  const known = TIEBREAK_DIGESTS.get(operation);
  if (known !== undefined) return known;
  // Joined with the one character the codec refuses inside an identifier, so the parts of the
  // hashed text cannot be shifted from one field into another. See {@link KEY_SEPARATOR}.
  const digest = sha256Hex(
    `${operation.deviceId}${KEY_SEPARATOR}${operation.opId}${KEY_SEPARATOR}${canonicalOperationText(operation)}`,
  );
  TIEBREAK_DIGESTS.set(operation, digest);
  return digest;
}

/**
 * Total order used for last-write-wins. The ranked stamp comes first and the digest of the
 * operation settles every tie in it — including the tie between two devices that reused one
 * identifier for different content, which must still produce one winner or the family would
 * never converge again. Equal digests mean equal operations, so they are equal here too.
 *
 * A pure function of the two operations, so a device that folded them one envelope at a time
 * and a device that restored the same journal from disk order them alike. It was a function of
 * three arguments for one round, the third being a threshold read off the converged journal;
 * see {@link rankedLamport} for why that threshold is gone.
 */
export function compareOperations(left: Operation, right: Operation): number {
  const leftRank = rankedLamport(left.lamport);
  const rightRank = rankedLamport(right.lamport);
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  if (left === right) return 0;
  const leftDigest = tiebreakDigest(left);
  const rightDigest = tiebreakDigest(right);
  if (leftDigest === rightDigest) return 0;
  return leftDigest < rightDigest ? -1 : 1;
}

/**
 * Where an entity kind sits in the order entries are listed in.
 *
 * {@link ENTITY_ORDER} is built from ENTITY_KINDS and an entry's kind is whatever the codec
 * accepted, which is exactly that list, so the lookup cannot miss. It used to answer a miss by
 * throwing, and that branch could not run: a branch nobody can reach is a rule nobody can
 * check and a place a later edit can hide a silent tie in. A kind added to the protocol and
 * forgotten in ENTITY_KINDS sorts last here instead — deterministically, on every replica,
 * rather than stopping the merge of a family's journal.
 */
function entityOrder(entity: EntityKind): number {
  return ENTITY_ORDER.get(entity) ?? ENTITY_KINDS.length;
}

/**
 * The order entries are listed in: one entry per entity, so the kind and the target settle it.
 *
 * Total, and total is the point. A journal holds exactly one entry per (kind, target) pair —
 * see {@link entryKey} — so nothing here can tie, and the listing a device produces never
 * depends on the order the server chose to deliver in.
 */
function compareEntries(left: JournalEntry, right: JournalEntry): number {
  const order = entityOrder(left.entity) - entityOrder(right.entity);
  if (order !== 0) return order;
  if (left.targetId === right.targetId) return 0;
  return left.targetId < right.targetId ? -1 : 1;
}

function compareProblems(left: JournalProblem, right: JournalProblem): number {
  if (left.code !== right.code) return left.code < right.code ? -1 : 1;
  const leftEntity = left.entity ?? "";
  const rightEntity = right.entity ?? "";
  if (leftEntity !== rightEntity) return leftEntity < rightEntity ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function problem(code: JournalProblemCode, entity: EntityKind | null, id: string): JournalProblem {
  return { code, entity, id };
}

/**
 * The order withheld entities are listed in: kind, identifier, reason.
 *
 * Total, like every other order in this file, and for the same reason — two devices holding the
 * same journal must hand a person the same list whatever order the operations reached them in.
 * The kind comes first because that is the grouping an interface shows.
 */
function compareWithheld(left: WithheldEntity, right: WithheldEntity): number {
  const order = entityOrder(left.entity) - entityOrder(right.entity);
  if (order !== 0) return order;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  if (left.reason === right.reason) return 0;
  return left.reason < right.reason ? -1 : 1;
}

/**
 * Records that an entity the journal holds is not in the state, and says so out loud.
 *
 * A rule that drops an entity does both at once, so they are done in one place: the problem
 * tells a consumer which rule fired, the withholding tells it which record a person will not
 * find on the screen. Decision 39 asked that nothing disappear silently; decision 40 is what
 * makes that possible without freezing a family — see UNSHOWABLE_PROBLEM_CODES in types.ts.
 *
 * One site records without reporting, and says why where it does it: see
 * {@link selectActiveBudget}, where the same code as a problem would mean the pointer this
 * snapshot carries does not resolve at all.
 */
function withhold(
  report: (problem: JournalProblem) => void,
  record: (entity: WithheldEntity) => void,
  entity: WithheldEntity,
): void {
  report(problem(entity.reason, entity.entity, entity.id));
  record(entity);
}

/**
 * The operation that owns a living entity.
 *
 * Every entity in {@link LiveEntities} was put there by a non-delete entry, and the same pass
 * records that entry in `owners`, so a living entity always has one. Three call sites used to
 * carry a branch for the missing case, and none of the three could run: a branch that cannot
 * run is a rule nobody can check and a place a later edit can hide a silent tie in. The
 * invariant is stated here once instead, and breaking it stops the merge rather than letting
 * some other rule pick a winner.
 */
function ownerOf(
  owners: ReadonlyMap<string, JournalEntry>,
  entity: EntityKind,
  id: StableId,
): JournalEntry {
  const owner = owners.get(entryKey(entity, id));
  if (owner === undefined) {
    throw new SyncProtocolError("journal integrity gate lost the operation that owns a living entity");
  }
  return owner;
}

interface JournalLine {
  readonly budgetId: BudgetId;
  readonly line: BudgetLine;
}

/** Every living entity of the journal, indexed by identifier, before the integrity gate runs. */
interface LiveEntities {
  readonly accounts: Map<StableId, Account>;
  readonly categories: Map<StableId, Category>;
  readonly budgets: Map<StableId, Omit<Budget, "lines">>;
  readonly budgetLines: Map<StableId, JournalLine>;
  readonly goals: Map<StableId, Goal>;
  readonly annualCommitments: Map<StableId, AnnualCommitment>;
  readonly scheduledExpenses: Map<StableId, ScheduledExpense>;
  readonly transactions: Map<StableId, Transaction>;
  readonly members: Map<StableId, Member>;
  readonly tags: Map<StableId, Tag>;
  readonly exchangeRates: Map<StableId, ExchangeRate>;
  /** At most one entry, under `HOUSEHOLD_ID`: the codec refuses any other target. */
  readonly households: Map<StableId, Household>;
  readonly debts: Map<StableId, Debt>;
}

function collectLiveEntities(ordered: readonly JournalEntry[]): LiveEntities {
  const live: LiveEntities = {
    accounts: new Map(),
    categories: new Map(),
    budgets: new Map(),
    budgetLines: new Map(),
    goals: new Map(),
    annualCommitments: new Map(),
    scheduledExpenses: new Map(),
    transactions: new Map(),
    members: new Map(),
    tags: new Map(),
    exchangeRates: new Map(),
    households: new Map(),
    debts: new Map(),
  };

  for (const entry of ordered) {
    if (entry.action === "delete") continue;
    switch (entry.entity) {
      case "account":
        live.accounts.set(entry.targetId, { id: entry.targetId, ...entry.fields });
        break;
      case "category":
        live.categories.set(entry.targetId, { id: entry.targetId, ...entry.fields });
        break;
      case "budget":
        live.budgets.set(entry.targetId, { id: entry.targetId, ...entry.fields });
        break;
      case "budgetLine": {
        const { budgetId, ...line } = entry.fields;
        live.budgetLines.set(entry.targetId, { budgetId, line: { id: entry.targetId, ...line } });
        break;
      }
      case "goal":
        live.goals.set(entry.targetId, { id: entry.targetId, ...entry.fields });
        break;
      case "annualCommitment":
        live.annualCommitments.set(entry.targetId, { id: entry.targetId, ...entry.fields });
        break;
      case "scheduledExpense":
        live.scheduledExpenses.set(entry.targetId, { id: entry.targetId, ...entry.fields });
        break;
      case "transaction":
        live.transactions.set(entry.targetId, { id: entry.targetId, ...entry.fields });
        break;
      case "member":
        live.members.set(entry.targetId, { id: entry.targetId, ...entry.fields });
        break;
      case "tag":
        live.tags.set(entry.targetId, { id: entry.targetId, ...entry.fields });
        break;
      case "exchangeRate":
        live.exchangeRates.set(entry.targetId, { id: entry.targetId, ...entry.fields });
        break;
      case "household":
        live.households.set(entry.targetId, { id: entry.targetId, ...entry.fields });
        break;
      case "debt":
        live.debts.set(entry.targetId, { id: entry.targetId, ...entry.fields });
        break;
    }
  }

  return live;
}

function entityIndexes(live: LiveEntities): readonly (readonly [EntityKind, Map<StableId, unknown>])[] {
  return [
    ["account", live.accounts],
    ["category", live.categories],
    ["budget", live.budgets],
    ["budgetLine", live.budgetLines],
    ["goal", live.goals],
    ["annualCommitment", live.annualCommitments],
    ["scheduledExpense", live.scheduledExpenses],
    ["transaction", live.transactions],
    ["member", live.members],
    ["tag", live.tags],
    ["exchangeRate", live.exchangeRates],
    ["household", live.households],
    ["debt", live.debts],
  ];
}

/**
 * Says out loud that this journal is larger than any family fills. Withholds nothing.
 *
 * Round after round of review was spent on the question of *which* entries an over-budget
 * journal should drop, and every answer was a lever for the peer being bounded: dropping by
 * identifier let it name its entries so that the family's went first, dropping by rank let it
 * stamp them so, and a budget per device let it mint a fresh `deviceId` per entry. The answer
 * is that there is nothing to drop — nothing in the domain needs this count bounded, so the
 * report is all that is left and the family keeps its data. {@link MAX_JOURNAL_ENTRIES} carries
 * the whole account, including what the last of those floods cost a family; see
 * {@link MAX_AGGREGATE_MINOR} for what actually holds the safe integer invariant up.
 *
 * One problem for the journal rather than one per author: naming an author would put a string
 * of the flooder's choosing in the report for no purpose, since nothing follows from it.
 * Nothing is withheld for it.
 */
function reportEntryBudget(
  ordered: readonly JournalEntry[],
  report: (problem: JournalProblem) => void,
): void {
  if (ordered.length > MAX_JOURNAL_ENTRIES) report(problem("journal_entry_budget", null, ""));
}

/**
 * An identifier belongs to one entity for good, because a backup export keeps one flat set
 * of identifiers and a collision would make it refuse the whole file.
 *
 * The collision is resolved, not punished. Withholding both sides turned one hostile
 * operation that reused somebody else's identifier into an off switch for the whole family:
 * the state never became ready again, and every device went on showing an old snapshot. The
 * total order that decides every other conflict decides this one too, so the entity ranked
 * higher stays and only the loser is withheld — the same loser on every replica.
 *
 * "Ranked higher" is not "stamped higher": an operation stamped past
 * {@link HONEST_LAMPORT_CEILING} ranks at the floor, so claiming the identifier of a family's
 * salary with a stamp of 2^40 now loses the claim instead of taking the salary out of the
 * state. See {@link rankedLamport}.
 */
function resolveSharedIdentifiers(
  live: LiveEntities,
  owners: ReadonlyMap<string, JournalEntry>,
  report: (problem: JournalProblem) => void,
  record: (entity: WithheldEntity) => void,
): void {
  const claims = new Map<StableId, EntityKind[]>();
  for (const [kind, index] of entityIndexes(live)) {
    for (const id of index.keys()) {
      const kinds = claims.get(id);
      if (kinds === undefined) claims.set(id, [kind]);
      else kinds.push(kind);
    }
  }

  for (const [id, kinds] of claims) {
    if (kinds.length < 2) continue;
    let winner = kinds[0]!;
    for (const kind of kinds) {
      if (compareOperations(ownerOf(owners, winner, id), ownerOf(owners, kind, id)) < 0) winner = kind;
    }
    for (const [kind, index] of entityIndexes(live)) {
      if (kind === winner || !kinds.includes(kind)) continue;
      index.delete(id);
      withhold(report, record, withheldFor(kind, id, "identifier_claimed_twice"));
    }
  }
}

/**
 * Why an entity cannot be shown, in the shape the withheld list carries.
 *
 * These used to return a {@link JournalProblem}, whose `entity` is nullable and whose `id` may
 * name a device rather than an entity. Every answer here names one entity of the state, so the
 * narrower type says that in the signature instead of leaving a call site to assert it: the
 * problem is derived from the withholding, never the other way round.
 */
function withheldFor(entity: EntityKind, id: StableId, reason: WithheldEntity["reason"]): WithheldEntity {
  return { entity, id, reason };
}

function expenseCategoryProblem(
  live: LiveEntities,
  entity: EntityKind,
  ownerId: StableId,
  categoryId: StableId,
): WithheldEntity | null {
  const category = live.categories.get(categoryId);
  if (category === undefined) return withheldFor(entity, ownerId, "unknown_reference");
  if (category.type !== "expense") return withheldFor(entity, ownerId, "wrong_category_type");
  return null;
}

/** The currency the household counts in: its own, or roubles while no household has arrived. */
function baseCurrencyOf(live: LiveEntities): CurrencyCode {
  return live.households.get(HOUSEHOLD_ID)?.baseCurrency ?? DEFAULT_BASE_CURRENCY;
}

/**
 * Why a plan — a goal, a large payment, a schedule — cannot sit on this account: it is kept in a
 * currency other than the base one, and the annual plan adds plans up without a rate (D-032). The
 * account's currency, or the household's base, may have changed on another device after the plan
 * was written; the plan is withheld and comes back if the currencies agree again.
 */
function planAccountProblem(live: LiveEntities, entity: EntityKind, id: StableId, accountId: StableId): WithheldEntity | null {
  const account = live.accounts.get(accountId);
  if (account === undefined) return withheldFor(entity, id, "unknown_reference");
  if (account.currency !== baseCurrencyOf(live)) return withheldFor(entity, id, "currency_mismatch");
  return null;
}

/**
 * Whether the base-currency snapshot of an income, an expense or a refund fits its account, by the
 * rule the domain enforces: none on an account in the base currency, all three fields in the base
 * currency on any other. The codec has already made sure a snapshot is whole when it is there.
 */
function snapshotFits(
  transaction: Extract<Transaction, { readonly kind: "income" | "expense" | "refund" }>,
  account: Account,
  baseCurrency: CurrencyCode,
): boolean {
  if (account.currency === baseCurrency) return transaction.baseAmountMinor === undefined;
  return transaction.baseAmountMinor !== undefined && transaction.baseCurrency === baseCurrency;
}

function goalProblem(live: LiveEntities, goal: Goal): WithheldEntity | null {
  return planAccountProblem(live, "goal", goal.id, goal.linkedAccountId);
}

function budgetLineProblem(live: LiveEntities, id: StableId, entry: JournalLine): WithheldEntity | null {
  if (!live.budgets.has(entry.budgetId)) return withheldFor("budgetLine", id, "unknown_reference");
  return expenseCategoryProblem(live, "budgetLine", id, entry.line.categoryId);
}

function annualCommitmentProblem(live: LiveEntities, item: AnnualCommitment): WithheldEntity | null {
  return planAccountProblem(live, "annualCommitment", item.id, item.accountId)
    ?? expenseCategoryProblem(live, "annualCommitment", item.id, item.categoryId);
}

function scheduledExpenseProblem(live: LiveEntities, item: ScheduledExpense): WithheldEntity | null {
  return planAccountProblem(live, "scheduledExpense", item.id, item.accountId)
    ?? expenseCategoryProblem(live, "scheduledExpense", item.id, item.categoryId);
}

function transactionProblem(live: LiveEntities, transaction: Transaction): WithheldEntity | null {
  const id = transaction.id;
  const missing = withheldFor("transaction", id, "unknown_reference");
  const mismatch = withheldFor("transaction", id, "currency_mismatch");
  const base = baseCurrencyOf(live);
  switch (transaction.kind) {
    case "income": {
      // The account decides whether an income can be shown at all; its category never does.
      // A category on an income is a label, and an unresolved label is cleared rather than
      // withheld — see clearUnresolvedLabels for why the money may not go down with it.
      const account = live.accounts.get(transaction.accountId);
      if (account === undefined) return missing;
      return snapshotFits(transaction, account, base) ? null : mismatch;
    }
    case "expense": {
      const account = live.accounts.get(transaction.accountId);
      if (account === undefined) return missing;
      if (!snapshotFits(transaction, account, base)) return mismatch;
      return expenseCategoryProblem(live, "transaction", id, transaction.categoryId);
    }
    case "refund": {
      const account = live.accounts.get(transaction.accountId);
      if (account === undefined) return missing;
      if (!snapshotFits(transaction, account, base)) return mismatch;
      const categoryProblem = expenseCategoryProblem(live, "transaction", id, transaction.categoryId);
      if (categoryProblem !== null) return categoryProblem;
      const original = live.transactions.get(transaction.originalTransactionId);
      if (original === undefined) return missing;
      const invalid = withheldFor("transaction", id, "invalid_refund");
      if (original.kind !== "expense" || original.status !== "posted") return invalid;
      if (original.categoryId !== transaction.categoryId) return invalid;
      if (transaction.occurredOn < original.occurredOn) return invalid;
      return null;
    }
    case "transfer": {
      const from = live.accounts.get(transaction.fromAccountId);
      const to = live.accounts.get(transaction.toAccountId);
      if (from === undefined || to === undefined) return missing;
      // The amount that arrived is named exactly when the currencies differ.
      return (from.currency === to.currency) === (transaction.toAmountMinor === undefined) ? null : mismatch;
    }
    case "goal_contribution": {
      const from = live.accounts.get(transaction.fromAccountId);
      const to = live.accounts.get(transaction.toAccountId);
      if (from === undefined || to === undefined) return missing;
      if (from.currency !== to.currency) return mismatch;
      const goal = live.goals.get(transaction.goalId);
      if (goal === undefined) return missing;
      if (goal.linkedAccountId !== transaction.toAccountId) {
        return withheldFor("transaction", id, "goal_account_mismatch");
      }
      return null;
    }
  }
}

/**
 * Why the category on an income cannot stand, or null while it can.
 *
 * The domain accepts an income with no category and an income filed under a category of type
 * `income`, and refuses everything between: a category that is not in the state, and a category
 * of the wrong type. The two answers are told apart here exactly as {@link expenseCategoryProblem}
 * tells them apart on the expense side, so one wrong reference does not report itself under two
 * different codes depending on which side of the ledger it is on.
 */
function incomeCategoryCode(live: LiveEntities, categoryId: StableId): JournalProblemCode | null {
  const category = live.categories.get(categoryId);
  if (category === undefined) return "unknown_reference";
  if (category.type !== "income") return "wrong_category_type";
  return null;
}

/**
 * Clears a label whose referent the journal does not hold, and says so out loud.
 *
 * Four labels reach a transaction this way — the participant credited with it, the category an
 * income is filed under, its tags, and the recurring rule it is an occurrence of — and all of them
 * are governed by the one rule written here rather than by a rule each, because the case is the
 * same case. Tags are cleared one by one: a transaction keeps every tag that resolves, and loses
 * the field only when none does, because there is no empty list of tags. Recurring rules are not
 * part of this version of the model, so a rule label names nothing on any replica and is cleared
 * wherever it appears — the same answer the backup gate gives it.
 *
 * The state has to be one the domain accepts, and it refuses all four: `calculateMemberExpenses`
 * refuses a transaction whose `memberId` names nobody, and `calculateBudget` refuses an income
 * whose `categoryId` names nothing or names an expense category, and a tag or a rule that names
 * nothing on any transaction at all. But the answer cannot be the one
 * an unresolved account or an expense category gets: a family deleting a participant, or deleting
 * a category it no longer uses, is an ordinary thing to do, and doing it while another device
 * labels a transaction is ordinary concurrency. If the transaction went down with the label,
 * deleting one participant would quietly take every purchase ever attributed to them out of the
 * family's budget, and deleting one income category would take the salary filed under it out of
 * the family's income — the totals on the screen would then be wrong rather than merely
 * incomplete. It would also be a lever: one delete, and whichever money the deleter chose to have
 * labelled disappears from the figures everybody else is reading. The domain draws the same line
 * from its own side — both fields are labels, no figure in `BudgetMetrics` reads either, and no
 * headline figure may move because a label was added, changed or dropped.
 *
 * So the transaction stays, to the kopeck, and only the label goes. It is reported about the
 * transaction — `unknown_reference` when the referent is not there, `wrong_category_type` when an
 * income names a category of the wrong side — because nothing may disappear silently; and nothing
 * is withheld for it, since the transaction is on the screen and counted and is merely labelled
 * with less. If the operation that creates the participant or the category is only late, the label
 * comes back by itself on the pass after it arrives — this reads the converged journal and keeps
 * nothing of its own between passes.
 */
function clearUnresolvedLabels(live: LiveEntities, report: (problem: JournalProblem) => void): void {
  for (const [id, transaction] of live.transactions) {
    // Read first, copied only when there is something to clear: this runs over every
    // transaction of the journal on every materialisation, and almost none of them need it.
    let cleared: Transaction = transaction;
    if (cleared.memberId !== undefined && !live.members.has(cleared.memberId)) {
      const { memberId: _unknown, ...unlabelled } = cleared;
      cleared = unlabelled;
      report(problem("unknown_reference", "transaction", id));
    }
    if (cleared.kind === "income" && cleared.categoryId !== undefined) {
      const code = incomeCategoryCode(live, cleared.categoryId);
      if (code !== null) {
        const { categoryId: _unresolved, ...uncategorised } = cleared;
        cleared = uncategorised;
        report(problem(code, "transaction", id));
      }
    }
    if (cleared.tagIds !== undefined && cleared.tagIds.some((tagId) => !live.tags.has(tagId))) {
      const { tagIds, ...untagged } = cleared;
      const resolved = tagIds.filter((tagId) => live.tags.has(tagId));
      cleared = resolved.length === 0 ? untagged : { ...untagged, tagIds: resolved };
      report(problem("unknown_reference", "transaction", id));
    }
    if (cleared.recurringRuleId !== undefined) {
      const { recurringRuleId: _unresolved, ...unlinked } = cleared;
      cleared = unlinked;
      report(problem("unknown_reference", "transaction", id));
    }
    if (cleared !== transaction) live.transactions.set(id, cleared);
  }
}

/**
 * Drops every entity whose references no longer resolve, repeating until nothing changes:
 * losing an account takes its goal down, and losing an expense takes the refund that
 * points at it down as well.
 */
function dropDanglingEntities(
  live: LiveEntities,
  report: (problem: JournalProblem) => void,
  record: (entity: WithheldEntity) => void,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    const sweep = <T>(
      index: Map<StableId, T>,
      reason: (value: T, id: StableId) => WithheldEntity | null,
    ): void => {
      for (const [id, value] of [...index]) {
        const found = reason(value, id);
        if (found === null) continue;
        index.delete(id);
        withhold(report, record, found);
        changed = true;
      }
    };

    sweep(live.goals, (goal) => goalProblem(live, goal));
    sweep(live.budgetLines, (entry, id) => budgetLineProblem(live, id, entry));
    sweep(live.annualCommitments, (item) => annualCommitmentProblem(live, item));
    sweep(live.scheduledExpenses, (item) => scheduledExpenseProblem(live, item));
    sweep(live.transactions, (item) => transactionProblem(live, item));
  }
}

/**
 * Two devices may plan the same category of the same budget at the same time. The domain
 * allows one line per category, so one of the two has to go, and which one is decided by the
 * same total order that decides every other conflict.
 *
 * It used to be the lowest identifier that stayed, and an identifier is whatever the writing
 * device chose to call the line: naming one `!` replaced the limit the family had planned for
 * that category however long ago the family had planned it, and it worked for every category
 * the writer cared to name.
 *
 * Two things had to change for the total order to be an answer to that rather than another
 * spelling of it. The stamp, which the writing device also chooses, ranks only up to
 * {@link HONEST_LAMPORT_CEILING}, so a line stamped 2^40 no longer takes the family's — the
 * earlier claim here, that a stamp is bounded relative to the receiving clock, was simply
 * untrue: that bound governs which stamp a clock adopts, never which operation wins. And the
 * pair of identifiers this groups by is kept as a pair, because joining them with a space made
 * ("fam 1", "cat") and ("fam", "1 cat") the same category of the same budget, and one
 * operation naming identifiers that never existed could delete a real line and then be swept
 * out as dangling itself.
 */
function rejectDuplicateBudgetLines(
  live: LiveEntities,
  owners: ReadonlyMap<string, JournalEntry>,
  report: (problem: JournalProblem) => void,
  record: (entity: WithheldEntity) => void,
): void {
  const planned = new Map<BudgetId, Map<StableId, StableId>>();
  for (const [id, entry] of [...live.budgetLines]) {
    let byCategory = planned.get(entry.budgetId);
    if (byCategory === undefined) {
      byCategory = new Map<StableId, StableId>();
      planned.set(entry.budgetId, byCategory);
    }
    const held = byCategory.get(entry.line.categoryId);
    if (held === undefined) {
      byCategory.set(entry.line.categoryId, id);
      continue;
    }
    const challengerWins =
      compareOperations(ownerOf(owners, "budgetLine", held), ownerOf(owners, "budgetLine", id)) < 0;
    const loser = challengerWins ? held : id;
    if (challengerWins) byCategory.set(entry.line.categoryId, id);
    live.budgetLines.delete(loser);
    withhold(report, record, withheldFor("budgetLine", loser, "duplicate_budget_line"));
  }
}

function availableMinor(line: BudgetLine): number {
  return line.plannedMinor + (line.rolloverMinor ?? 0) + (line.adjustmentMinor ?? 0);
}

function beyondBound(value: number): boolean {
  return !Number.isSafeInteger(value) || Math.abs(value) > MAX_AGGREGATE_MINOR;
}

/** Where one transaction lands: the running total of its kind and the balances it moves. */
type Contribution = readonly [Map<string, number>, string, number];

/**
 * Where one transaction lands, the way the domain counts it: the totals in the base currency — the
 * snapshot of an operation in another currency, its amount otherwise — and each balance in its own
 * account's currency, the receiving side of a transfer between currencies by what arrived.
 */
function transactionContributions(
  totals: Map<string, number>,
  balances: Map<string, number>,
  transaction: Transaction,
): readonly Contribution[] {
  const amount = transaction.amountMinor;
  switch (transaction.kind) {
    case "income":
      return [
        [totals, "income", transaction.baseAmountMinor ?? amount],
        [balances, transaction.accountId, amount],
      ];
    case "expense":
      return [
        [totals, "grossExpenses", transaction.baseAmountMinor ?? amount],
        [balances, transaction.accountId, -amount],
      ];
    case "refund":
      return [
        [totals, "refunds", transaction.baseAmountMinor ?? amount],
        [balances, transaction.accountId, amount],
      ];
    case "transfer":
      return [
        [balances, transaction.fromAccountId, -amount],
        [balances, transaction.toAccountId, transaction.toAmountMinor ?? amount],
      ];
    case "goal_contribution":
      return [
        [totals, "goalContributions", amount],
        [balances, transaction.fromAccountId, -amount],
        [balances, transaction.toAccountId, amount],
      ];
  }
}

/**
 * Adds up every total the domain will build and says out loud when one of them leaves the range
 * a domain calculation stays safe in. Withholds nothing.
 *
 * The domain adds amounts up without a ceiling of its own and throws the moment a sum stops
 * being a safe integer, and a field ceiling cannot prevent that — enough amounts below any
 * ceiling still overflow. So the same totals are built here first, over the whole converged
 * journal, with accumulators that saturate rather than overflow, and a total past
 * {@link MAX_AGGREGATE_MINOR} is reported.
 *
 * It used to withhold, choosing the entity to give up by `amountMinor` — a field of the
 * operation, so the peer being measured picked what left the family's state first. That was the
 * last eviction this package had; {@link MAX_AGGREGATE_MINOR} carries the whole account and the
 * boundary it settles on.
 *
 * One problem for the journal, not one per entity: no entity is named because none is missing.
 * Nothing lands in the withheld list for it either, for the same reason.
 */
function reportAggregateBounds(live: LiveEntities, report: (problem: JournalProblem) => void): void {
  const totals = new Map<string, number>([
    ["income", 0],
    ["grossExpenses", 0],
    ["refunds", 0],
    ["goalContributions", 0],
  ]);
  const balances = new Map<StableId, number>();
  for (const [id, account] of live.accounts) balances.set(id, account.openingBalanceMinor);
  for (const transaction of live.transactions.values()) {
    for (const [map, key, delta] of transactionContributions(totals, balances, transaction)) {
      map.set(key, addSaturating(map.get(key) ?? 0, delta));
    }
  }

  // Capital is the sum of the balances of the accounts in the base currency, as the domain builds
  // it, so it needs a pass of its own.
  let capital = 0;
  const base = baseCurrencyOf(live);
  for (const [id, balance] of balances) {
    if (live.accounts.get(id)?.currency === base) capital = addSaturating(capital, balance);
  }

  // Planned expenses are summed per budget, both by calculateBudget and by the annual plan.
  const plannedByBudget = new Map<BudgetId, number>();
  for (const entry of live.budgetLines.values()) {
    plannedByBudget.set(
      entry.budgetId,
      addSaturating(plannedByBudget.get(entry.budgetId) ?? 0, availableMinor(entry.line)),
    );
  }

  let goals = 0;
  for (const goal of live.goals.values()) {
    if (goal.status === "active") goals = addSaturating(goals, goal.plannedContributionMinor);
  }

  let scheduled = 0;
  for (const item of live.scheduledExpenses.values()) {
    if (item.active) scheduled = addSaturating(scheduled, item.amountMinor);
  }

  // The monthly reserve of a commitment never exceeds its amount, so measuring the amounts
  // measures both the reserve line and the due line of every planning month.
  let commitments = 0;
  for (const item of live.annualCommitments.values()) {
    if (item.active) commitments = addSaturating(commitments, item.amountMinor);
  }

  const measured = [
    ...totals.values(),
    ...balances.values(),
    capital,
    ...plannedByBudget.values(),
    goals,
    scheduled,
    commitments,
  ];
  if (measured.some(beyondBound)) report(problem("amount_out_of_range", null, ""));
}

/**
 * Says out loud that the state holds more participants, tags, exchange rates or debts than a
 * document may. Withholds nothing.
 *
 * The limit is the domain's (`COLLECTION_LIMITS`), shared with the backup gate, and each device
 * stays under it when it creates. Several devices creating offline can still pass it together, and
 * withholding the excess would mean choosing which of the family's entities to drop — by an order a
 * writing peer controls, which is the eviction {@link MAX_AGGREGATE_MINOR} gave up for good. So the
 * count is reported against the kind, the state stays ready, and the app goes on showing everything.
 */
function reportCollectionLimits(live: LiveEntities, report: (problem: JournalProblem) => void): void {
  if (live.members.size > COLLECTION_LIMITS.members) report(problem("collection_limit", "member", ""));
  if (live.tags.size > COLLECTION_LIMITS.tags) report(problem("collection_limit", "tag", ""));
  if (live.exchangeRates.size > COLLECTION_LIMITS.exchangeRates) report(problem("collection_limit", "exchangeRate", ""));
  if (live.debts.size > COLLECTION_LIMITS.debts) report(problem("collection_limit", "debt", ""));
}

/**
 * Counts the tombstones each author owns and reports the ones that overshoot the budget.
 *
 * Pairing a tombstone with the create it ended is not recoverable from a converged journal:
 * a delete replaces the write it wins over, and a device that restarts and rebuilds from
 * storage sees exactly the tombstone and nothing else. Any counter that remembered the
 * create would therefore differ between a device that folded both operations and a device
 * that restored the same journal from disk, and the two would disagree about the state of
 * the family. What is bounded in an honest history is how many entities one author buried,
 * so that is what is counted, and crossing the budget withholds nothing.
 *
 * Who counts as one author is the part that had to be repaired here. Counting per `deviceId`
 * made the identifier of the writing device the measure of the writing device's own share, and
 * that identifier is a field of the operation: nothing in the protocol confirms it, and
 * SYNC_ARCHITECTURE forbids the server to compare it with the device that uploaded the envelope
 * so that key rotation keeps working. So a peer that drew a fresh identity every five thousand
 * deletes reset its own count every five thousand deletes, and the one signal that says a
 * family is being emptied never fired at all.
 *
 * The confirmed devices of a family are the ones it has something to show for: an author of a
 * living entity in the state this gate is about to hand over. They are counted one by one, and
 * every other author — an identity that buried things and left nothing behind, which is what a
 * minted identity looks like from inside a journal — shares one bucket, reported under the
 * empty identifier. An honest device is never in the shared bucket while any of its writes is
 * still in the state, and a device with no writes left in the state has no history a person
 * could tell apart from a mint.
 */
function reportTombstoneBudget(
  ordered: readonly JournalEntry[],
  confirmed: ReadonlySet<DeviceId>,
  report: (problem: JournalProblem) => void,
): void {
  const SHARED_BUCKET = "";
  const byAuthor = new Map<DeviceId, number>();
  for (const entry of ordered) {
    if (entry.action !== "delete") continue;
    const bucket = confirmed.has(entry.deviceId) ? entry.deviceId : SHARED_BUCKET;
    byAuthor.set(bucket, (byAuthor.get(bucket) ?? 0) + 1);
  }
  for (const [bucket, count] of byAuthor) {
    if (count > MAX_TOMBSTONES_PER_DEVICE) report(problem("tombstone_budget", null, bucket));
  }
}

/** Devices the family has something to show for: the authors of the entities in the state. */
function confirmedDevices(live: LiveEntities, owners: ReadonlyMap<string, JournalEntry>): Set<DeviceId> {
  const devices = new Set<DeviceId>();
  for (const [kind, index] of entityIndexes(live)) {
    for (const id of index.keys()) devices.add(ownerOf(owners, kind, id).deviceId);
  }
  return devices;
}

/**
 * Reports every device that wrote into this journal at or above the stamp no clock reaches.
 *
 * A property of the converged journal rather than of a batch: it is read off the entries and
 * activations the merge kept — the same set a restore rebuilds from — so two devices holding
 * the same operations report the same devices however the operations reached them, restart
 * included. It replaced a verdict about the delivery, "this batch carried a stamp further
 * ahead than my clock", which was a fact about the receiver rather than about the family: it
 * went missing whenever a batch changed nothing, and any peer could produce it on demand by
 * sending one operation per envelope.
 *
 * The line it compares against is {@link HONEST_LAMPORT_CEILING}, the same line the merge ranks
 * by, deliberately. They were one constant with two different comparisons for a round, then two
 * constants one apart for a round, and each time the gap held exactly one value: a stamp that
 * won every conflict in the protocol and appeared in no report. There is no gap now: a stamp
 * carries no rank exactly when it is named here.
 *
 * Every implausible stamp the journal holds is reported. What the journal does not hold is a
 * write some other write outranked, so an operation that reached for an entity and lost it
 * leaves nothing to name — exactly like any other loser of the total order. That is the price of
 * the report being a function of the converged journal rather than of a delivery: a restore sees
 * the entries and nothing else, so anything counted outside them would make a device that
 * restarted disagree with a device that did not. What is left is a report of every implausible
 * stamp that actually owns something, which is every implausible stamp that took anything.
 *
 * Nothing is withheld for it: the stamp costs its writer every conflict already (see
 * {@link rankedLamport}). What it gives a consumer is a reason to quarantine the device.
 */
function reportImplausibleStamps(
  ordered: readonly JournalEntry[],
  activations: Iterable<ActivateBudgetOperation>,
  report: (problem: JournalProblem) => void,
): void {
  const seen = new Set<DeviceId>();
  const check = (operation: Operation): void => {
    // On the line as well as above it: the ranking treats the line the same way, and the two
    // comparisons are one comparison. See {@link rankedLamport}.
    if (operation.lamport < HONEST_LAMPORT_CEILING || seen.has(operation.deviceId)) return;
    seen.add(operation.deviceId);
    report(problem("implausible_lamport", null, operation.deviceId));
  };
  for (const entry of ordered) check(entry);
  for (const activation of activations) check(activation);
}

/**
 * The activation that owns the pointer: the highest ranked one whose budget is in the state.
 *
 * The pointer used to be a last-write-wins register of its own, and that made one operation
 * enough to switch a family off for good. An activation of a budget that had never existed,
 * stamped at the ceiling, won the register; the register has no delete, so nothing could take
 * the pointer back; and the family's own clock stayed where it was, because a stamp that far
 * ahead is not adopted, so no honest activation could ever outrank it. Every device kept
 * showing `unknown_active_budget`, restart included.
 *
 * Choosing among the activations whose target actually resolves is still a function of the
 * converged set — the whole register is kept and every replica holds the same one — and it is
 * a rule a hostile peer cannot use: pointing at nothing now wins nothing. An activation of a
 * budget that has genuinely not been delivered yet is the honest case, and it is what the
 * verdict is for, so when nothing resolves the highest ranked activation is still the pointer
 * and `unknown_active_budget` still says the delivery is incomplete.
 *
 * Every activation passed over here is recorded as withheld, because passing one over is how a
 * family's own choice of budget stops being visible: somebody activated a budget, the budget is
 * not in the state, and the screen shows a different one. It is recorded and not reported as a
 * problem — `unknown_active_budget` as a *problem* means the pointer this snapshot actually
 * carries does not resolve, which is the one case where the state cannot be shown at all, and
 * saying it here would freeze a family over an activation the merge has already worked around.
 * See UNSHOWABLE_PROBLEM_CODES in types.ts.
 */
function selectActiveBudget(
  activations: Iterable<ActivateBudgetOperation>,
  budgets: ReadonlyMap<StableId, unknown>,
  record: (entity: WithheldEntity) => void,
): ActivateBudgetOperation | null {
  let living: ActivateBudgetOperation | null = null;
  let any: ActivateBudgetOperation | null = null;
  const dangling: ActivateBudgetOperation[] = [];
  for (const activation of activations) {
    if (any === null || compareOperations(any, activation) < 0) any = activation;
    if (!budgets.has(activation.targetId)) {
      dangling.push(activation);
      continue;
    }
    if (living === null || compareOperations(living, activation) < 0) living = activation;
  }
  const chosen = living ?? any;
  for (const activation of dangling) {
    if (activation === chosen) continue;
    record(withheldFor("budget", activation.targetId, "unknown_active_budget"));
  }
  return chosen;
}

interface MaterialView {
  readonly entries: readonly JournalEntry[];
  readonly state: SyncedBudgetState;
  readonly integrity: JournalIntegrity;
  readonly activeBudget: ActivateBudgetOperation | null;
}

function buildView(
  entries: ReadonlyMap<string, JournalEntry>,
  activations: ReadonlyMap<string, ActivateBudgetOperation>,
  folded: readonly JournalProblem[],
): MaterialView {
  const ordered = [...entries.values()].sort(compareEntries);
  const found: JournalProblem[] = [...folded];
  const report = (value: JournalProblem): void => {
    found.push(value);
  };
  const missing: WithheldEntity[] = [];
  const record = (value: WithheldEntity): void => {
    missing.push(value);
  };

  // The gate below is the whole contract of this function: whatever a merge produces, the
  // state handed to @family-budget/domain never contains a reference the domain would
  // reject. Every step of it reads the converged journal and nothing else, so two devices
  // holding the same operations answer the same way however those operations reached them —
  // which is what the merge is here to guarantee, against a server and a network that may
  // reorder, delay, duplicate and interrupt a delivery. See decision 39 for what it is *not*
  // here to guarantee.
  reportEntryBudget(ordered, report);
  const live = collectLiveEntities(ordered);
  const owners = new Map<string, JournalEntry>();
  for (const entry of ordered) {
    if (entry.action !== "delete") owners.set(entryKey(entry.entity, entry.targetId), entry);
  }

  resolveSharedIdentifiers(live, owners, report, record);
  rejectDuplicateBudgetLines(live, owners, report, record);
  dropDanglingEntities(live, report, record);
  // After the sweep, so that a transaction already on its way out is not reported twice over,
  // and after resolveSharedIdentifiers, which is the one step that can take a participant, a
  // category or a tag out without a delete having been written for it.
  clearUnresolvedLabels(live, report);
  reportCollectionLimits(live, report);
  reportAggregateBounds(live, report);
  reportTombstoneBudget(ordered, confirmedDevices(live, owners), report);
  reportImplausibleStamps(ordered, activations.values(), report);

  const activeBudget = selectActiveBudget(activations.values(), live.budgets, record);
  if (activeBudget === null) report(problem("no_active_budget", "budget", ""));
  else if (!live.budgets.has(activeBudget.targetId)) {
    report(problem("unknown_active_budget", "budget", activeBudget.targetId));
  }

  const linesByBudget = new Map<BudgetId, BudgetLine[]>();
  for (const entry of live.budgetLines.values()) {
    const bucket = linesByBudget.get(entry.budgetId);
    if (bucket) bucket.push(entry.line);
    else linesByBudget.set(entry.budgetId, [entry.line]);
  }

  const state: SyncedBudgetState = {
    activeBudgetId: activeBudget?.targetId ?? "",
    accounts: [...live.accounts.values()],
    categories: [...live.categories.values()],
    budgets: [...live.budgets.values()].map((header) => ({ ...header, lines: linesByBudget.get(header.id) ?? [] })),
    goals: [...live.goals.values()],
    annualCommitments: [...live.annualCommitments.values()],
    scheduledExpenses: [...live.scheduledExpenses.values()],
    transactions: [...live.transactions.values()],
    members: [...live.members.values()],
    tags: [...live.tags.values()],
    exchangeRates: [...live.exchangeRates.values()],
    debts: [...live.debts.values()],
    // Absent stays absent: a journal without a household is counted in roubles, like a backup.
    ...(live.households.has(HOUSEHOLD_ID) ? { household: live.households.get(HOUSEHOLD_ID)! } : {}),
  };

  const unique = new Map<string, JournalProblem>();
  // The identifier of a problem is written by whichever device sent the operation, so the key
  // is joined with the one character an identifier may not carry. See {@link KEY_SEPARATOR}.
  for (const value of found) {
    unique.set(`${value.code}${KEY_SEPARATOR}${value.entity ?? ""}${KEY_SEPARATOR}${value.id}`, value);
  }
  const problems = [...unique.values()].sort(compareProblems);
  // Deduplicated the same way and with the same separator: an entity may be reached by two rules
  // in one sweep, and a person is told once. See {@link KEY_SEPARATOR}.
  const held = new Map<string, WithheldEntity>();
  for (const value of missing) {
    held.set(`${value.entity}${KEY_SEPARATOR}${value.id}${KEY_SEPARATOR}${value.reason}`, value);
  }
  const integrity: JournalIntegrity = {
    // Only the state's own showability. What was withheld is in `withheld`, and a resolved
    // conflict never freezes a family — see UNSHOWABLE_PROBLEM_CODES in types.ts.
    ready: !problems.some((value) => UNSHOWABLE.has(value.code)),
    problems,
    withheld: [...held.values()].sort(compareWithheld),
  };

  return deepFreeze({ entries: ordered, state, integrity, activeBudget });
}

/**
 * Working state of one chain of merges, shared by the snapshots built from it.
 *
 * Rebuilding these indexes on every call is what made a stream of envelopes quadratic, so
 * the chain keeps them and appends to them. Only one snapshot at a time owns the right to
 * mutate them; every other snapshot rebuilds its own view by undoing the steps recorded
 * after it, which costs nothing until somebody actually asks an outdated snapshot for its
 * state.
 */
type UndoStep =
  | { readonly index: "entries"; readonly key: string; readonly previous: JournalEntry | undefined }
  | { readonly index: "activations"; readonly key: string; readonly previous: ActivateBudgetOperation | undefined };

/**
 * How far back a superseded snapshot may be rewound: one epoch quota of merges.
 *
 * The undo log is what keeps a stream of envelopes linear, and left alone it is also the one
 * structure here that grows with everything a device has ever written rather than with what it
 * currently holds: every operation a later write replaced stays reachable through it for the
 * life of the process, so a family that edits the same budget line every week pays memory for
 * every edit it ever made. The window is trimmed from the front instead.
 *
 * One epoch quota is what the read contract of {@link JournalSnapshot} asks a consumer to fold
 * in one delivery while it goes on showing the last snapshot that was ready, so a snapshot
 * still in use is always inside it. A snapshot older than the window answers with a
 * {@link SyncProtocolError} rather than with the state of a journal it never saw: a caller can
 * fold its delivery again, but a family shown a budget that was never anybody's is a wrong
 * answer nobody can detect.
 */
export const MAX_UNDO_STEPS = MAX_BATCH_OPERATIONS;

/**
 * How much of the undo window one trim gives back.
 *
 * Dropping exactly the excess would shift the whole window on every envelope once the ceiling
 * is reached, which is the denial of service the applied-identifier window already learned to
 * avoid. A tenth of the window is dropped at a time instead, so the shift is paid once per ten
 * thousand merges.
 */
const UNDO_TRIM_STEP = 10_000;

interface JournalMemo {
  /** The operation that owns each entity, keyed by {@link entryKey}: one per entity. */
  readonly entries: Map<string, JournalEntry>;
  /**
   * The best activation of every budget ever activated, from which the pointer is chosen, keyed
   * by target.
   *
   * It grows with the identifiers a journal has seen, not with the operations it has folded.
   * Keeping the whole register is what makes the choice of pointer a function of the converged
   * set even after the winning budget is deleted; keeping only the winner would have made a
   * device that restarted disagree with one that did not.
   */
  readonly activations: Map<string, ActivateBudgetOperation>;
  readonly undo: UndoStep[];
  /** How many undo steps the window has already dropped, so a snapshot can place its own. */
  undoBase: number;
  readonly applied: Set<OpId>;
  /**
   * Applied identifiers, oldest first, and the window is trimmed from the front.
   *
   * Arrival order inside one chain of merges. A chain that begins from a copy — a snapshot
   * folded onto after it lost the shared indexes — or from a restore starts with the sorted
   * set the snapshot carried, because a snapshot exposes the identifiers sorted and nothing
   * else. Which identifiers a trim drops therefore differs between the two, and nothing
   * depends on it: the set is never a reason to skip an operation.
   */
  readonly order: OpId[];
  /** How many identifiers the window has already dropped, so a snapshot can place its own. */
  dropped: number;
  owner: JournalSnapshot | null;
}

interface JournalHandle {
  readonly memo: JournalMemo;
  /** Undo steps recorded before this snapshot, counted from the first the chain ever made. */
  readonly undoCount: number;
  /** Identifiers folded by this snapshot, counted from the first one the chain ever saw. */
  readonly appliedCount: number;
}

/** The two indexes as one handle's snapshot saw them. */
interface JournalIndexes {
  readonly entries: ReadonlyMap<string, JournalEntry>;
  readonly activations: ReadonlyMap<string, ActivateBudgetOperation>;
}

/**
 * Snapshots this module built itself, with the working state each of them belongs to.
 * Anything else — a snapshot read back from storage or handed over by another process — is
 * rebuilt from its entries before a single operation is folded into it, so an attacker
 * cannot smuggle state past the codec by forging a snapshot.
 */
const HANDLES = new WeakMap<JournalSnapshot, JournalHandle>();

function emptyMemo(): JournalMemo {
  return {
    entries: new Map(),
    activations: new Map(),
    undo: [],
    undoBase: 0,
    applied: new Set(),
    order: [],
    dropped: 0,
    owner: null,
  };
}

/** The indexes as this handle's snapshot saw them, undoing whatever happened afterwards. */
function indexesOf(handle: JournalHandle): JournalIndexes {
  const { memo, undoCount } = handle;
  if (memo.undoBase + memo.undo.length === undoCount) return memo;
  if (undoCount < memo.undoBase) {
    throw new SyncProtocolError("journal snapshot is older than the undo window this journal keeps");
  }
  const entries = new Map(memo.entries);
  const activations = new Map(memo.activations);
  for (let index = memo.undo.length - 1; index >= undoCount - memo.undoBase; index -= 1) {
    const step = memo.undo[index]!;
    if (step.index === "entries") {
      if (step.previous === undefined) entries.delete(step.key);
      else entries.set(step.key, step.previous);
    } else if (step.previous === undefined) activations.delete(step.key);
    else activations.set(step.key, step.previous);
  }
  return { entries, activations };
}

/**
 * Builds the snapshot object. Everything a caller may never ask for is computed on first
 * access and kept: folding a stream of envelopes one by one must not sort and re-materialise
 * the whole journal once per envelope, which is minutes of a blocked main thread at the size
 * of one epoch.
 */
function materialize(
  memo: JournalMemo,
  lamport: number,
  folded: readonly JournalProblem[],
): JournalSnapshot {
  const handle: JournalHandle = {
    memo,
    undoCount: memo.undoBase + memo.undo.length,
    appliedCount: memo.dropped + memo.order.length,
  };
  let indexes: JournalIndexes | null = null;
  let view: MaterialView | null = null;
  let activations: readonly ActivateBudgetOperation[] | null = null;
  let appliedOpIds: readonly OpId[] | null = null;
  const held = (): JournalIndexes => (indexes ??= indexesOf(handle));
  const materialised = (): MaterialView =>
    (view ??= buildView(held().entries, held().activations, folded));
  // Ordered by target, which is the key the register is held under, so a stored snapshot holds
  // it in one shape on every device whatever order the operations were folded in.
  const activated = (): readonly ActivateBudgetOperation[] =>
    (activations ??= deepFreeze(
      [...held().activations.values()].sort((left, right) =>
        left.targetId === right.targetId ? 0 : left.targetId < right.targetId ? -1 : 1,
      ),
    ));
  // Freezing the array is enough: it holds nothing but strings, and deepFreeze over a window
  // of a million identifiers would build a descriptor for every one of them for no gain.
  const remembered = (): readonly OpId[] =>
    (appliedOpIds ??= Object.freeze(
      memo.order.slice(0, Math.max(0, handle.appliedCount - memo.dropped)).sort(),
    ));

  const snapshot = {} as JournalSnapshot;
  Object.defineProperties(snapshot, {
    state: { enumerable: true, get: (): SyncedBudgetState => materialised().state },
    integrity: { enumerable: true, get: (): JournalIntegrity => materialised().integrity },
    entries: { enumerable: true, get: (): readonly JournalEntry[] => materialised().entries },
    activeBudget: { enumerable: true, get: (): ActivateBudgetOperation | null => materialised().activeBudget },
    activations: { enumerable: true, get: activated },
    appliedOpIds: { enumerable: true, get: remembered },
    lamport: { enumerable: true, value: lamport },
  });
  Object.freeze(snapshot);

  HANDLES.set(snapshot, handle);
  memo.owner = snapshot;
  return snapshot;
}

export function createEmptyJournal(): JournalSnapshot {
  return materialize(emptyMemo(), 0, []);
}

/**
 * Which of two operations owns an entity. A delete outranks every write of the same entity
 * whatever its stamp, because a tombstone is final; two deletes keep the higher stamp so the
 * tombstone itself is deterministic; two writes are decided by the total order. The loser is
 * the loser on every replica, and its identifier is recorded either way.
 */
function outranks(current: JournalEntry | undefined, incoming: JournalEntry): boolean {
  if (current === undefined) return true;
  if (current.action === "delete") {
    return incoming.action === "delete" && compareOperations(current, incoming) < 0;
  }
  if (incoming.action === "delete") return true;
  return compareOperations(current, incoming) < 0;
}

interface FoldResult {
  readonly lamport: number;
  readonly changed: boolean;
  /** What the fold itself has to say. Everything else is decided by the gate on the entries. */
  readonly problems: readonly JournalProblem[];
}

function foldInto(
  memo: JournalMemo,
  base: { readonly lamport: number },
  incoming: readonly Operation[],
): FoldResult {
  let lamport = base.lamport;
  let changed = false;
  const problems: JournalProblem[] = [];

  // How far this call may move the clock, fixed before the first operation is read.
  //
  // This is bookkeeping about the receiver and nothing else: the clock decides what this
  // device stamps its own writes with, never which operation owns an entity, so two devices
  // that were handed the same operations in different batches may hold different clocks and
  // still agree about the family down to the last kopeck. That is why there is no verdict
  // about it in the integrity problems any more — a report a peer could produce on demand by
  // sending one operation per envelope, and which went missing whenever a batch changed
  // nothing, said nothing about the state either way.
  //
  // The horizon is still fixed rather than measured against a clock the batch has already
  // raised: that was a ladder, two thousand operations one skew apart moved a family's clock
  // two billion steps inside a single batch. And it never reaches the honest ceiling, because a
  // stamp on the line or above it carries no rank, so a device that wrote from there would lose
  // every conflict it ever had.
  const horizon = Math.min(base.lamport + MAX_LAMPORT_SKEW, MAX_HONEST_LAMPORT);

  for (const operation of incoming) {
    // The identifier is recorded, never used to skip: two devices may stamp different
    // content with the same opId, and dropping the second one would split the family.
    if (!memo.applied.has(operation.opId)) {
      memo.applied.add(operation.opId);
      memo.order.push(operation.opId);
      changed = true;
    }
    // The stamp may be refused, the operation never is. Refusing the operation would make the
    // journal itself depend on which device happened to receive it first, and the family would
    // disagree about entities over a number that decides nothing but ties.
    if (operation.lamport <= horizon && operation.lamport > lamport) {
      lamport = operation.lamport;
      changed = true;
    }

    if (operation.action === "activate") {
      // Last-write-wins per target rather than one register for the whole family: which of them
      // owns the pointer is decided on the converged journal, among the budgets that are in it.
      // See selectActiveBudget for the permanent freeze this replaced.
      const key = operation.targetId;
      const current = memo.activations.get(key);
      if (current === undefined || compareOperations(current, operation) < 0) {
        memo.undo.push({ index: "activations", key, previous: current });
        memo.activations.set(key, operation);
        changed = true;
      }
    } else {
      // Nothing is dropped here that another replica keeps. A delete is applied whatever
      // this journal has seen of the entity: refusing a tombstone for an unknown target made
      // the result depend on the order the server chose to deliver in, and a delete handed
      // over before its create was dropped without a word while its identifier was recorded
      // as applied, so two devices agreed on their checkpoints and disagreed about the
      // family for good. What loses here loses the same way on every device, by the total
      // order, and it is recorded as applied all the same. Nothing here counts anything up
      // to a ceiling either: every budget of this journal is a property of the whole merged
      // set of operations, and is measured on it after the merge.
      const key = entryKey(operation.entity, operation.targetId);
      const current = memo.entries.get(key);
      if (outranks(current, operation)) {
        memo.undo.push({ index: "entries", key, previous: current });
        memo.entries.set(key, operation);
        changed = true;
      }
    }
  }

  // The window is trimmed, never closed. Throwing here handed a peer an off switch: a forged
  // snapshot listing a million identifiers locked the device out of its own journal for good,
  // because every later call threw before it applied anything, including the device's own work.
  if (memo.applied.size > MAX_APPLIED_OP_IDS) {
    const excess = Math.min(memo.applied.size - MAX_APPLIED_OP_IDS + APPLIED_OP_ID_EPOCH, memo.order.length);
    for (const opId of memo.order.splice(0, excess)) memo.applied.delete(opId);
    memo.dropped += excess;
    problems.push(problem("applied_id_budget", null, ""));
  }

  // And the rewind window the same way. Nothing the journal holds is dropped with it: what a
  // trimmed step carried is the value some earlier snapshot would have rebuilt, never a value
  // the current one shows.
  if (memo.undo.length > MAX_UNDO_STEPS + UNDO_TRIM_STEP) {
    memo.undo.splice(0, UNDO_TRIM_STEP);
    memo.undoBase += UNDO_TRIM_STEP;
  }

  return { lamport, changed, problems };
}

/** The working state of a snapshot this chain no longer owns, copied so it can be folded onto. */
function copyMemo(handle: JournalHandle, base: JournalSnapshot): JournalMemo {
  const memo = emptyMemo();
  const indexes = indexesOf(handle);
  for (const [key, entry] of indexes.entries) memo.entries.set(key, entry);
  for (const [key, activation] of indexes.activations) memo.activations.set(key, activation);
  for (const opId of base.appliedOpIds) {
    memo.applied.add(opId);
    memo.order.push(opId);
  }
  return memo;
}

function fold(base: JournalSnapshot, incoming: readonly Operation[]): JournalSnapshot {
  const handle = HANDLES.get(base)!;
  const owned = handle.memo.owner === base;
  const memo = owned ? handle.memo : copyMemo(handle, base);
  if (owned) {
    // The claim is dropped before the first mutation: a rejected batch must not leave a
    // snapshot behind that still says the shared indexes match its own view.
    memo.owner = null;
  }

  const result = foldInto(memo, base, incoming);
  if (!result.changed) {
    if (owned) memo.owner = base;
    else {
      // The copy this call had to make becomes the snapshot's own working state. Without
      // this, a snapshot that lost the claim paid for a full copy of the journal on every
      // later call — measured at 14.8 ms for one refused operation, on every one of them —
      // and a caller that folds onto the snapshot it kept does exactly that.
      memo.owner = base;
      HANDLES.set(base, {
        memo,
        undoCount: memo.undoBase + memo.undo.length,
        appliedCount: memo.dropped + memo.order.length,
      });
    }
    return base;
  }
  return materialize(memo, result.lamport, result.problems);
}

/**
 * Folds operations into a snapshot. Every operation is validated first, so this is a safe
 * entry point even for a batch that never went through parseOperation: applying the same
 * operation twice changes nothing, a delete outranks every change to the same entity, and
 * the result never depends on the order in which operations arrive.
 *
 * Folding is cheap; reading {@link JournalSnapshot.state}, {@link JournalSnapshot.integrity},
 * {@link JournalSnapshot.entries} or {@link JournalSnapshot.activeBudget} is not — see
 * {@link JournalSnapshot} for the read contract this asks of a consumer that folds a stream of
 * envelopes.
 *
 * Which operation wins an entity does not depend on this call: it is decided by the total
 * order over the converged journal, and a stamp past the honest ceiling carries no weight in
 * it — see {@link rankedLamport}. What this call does decide is the clock the snapshot carries
 * on, which is local bookkeeping about the receiver: every stamp of the batch is measured
 * against the stamp the snapshot held when the call began, never against one the batch has
 * already adopted, and a stamp further than MAX_LAMPORT_SKEW beyond it is not adopted. The
 * operation itself is folded all the same, so no device is left holding entities another
 * device dropped.
 *
 * A snapshot that this module did not build is rebuilt from its entries before use. A snapshot
 * this module built but has since rewound past — see {@link MAX_UNDO_STEPS} — is refused with
 * a {@link SyncProtocolError} rather than merged onto the wrong journal.
 */
export function applyOperations(
  snapshot: JournalSnapshot,
  operations: readonly Operation[],
): JournalSnapshot {
  if (!Array.isArray(operations)) throw new SyncProtocolError("operations must be an array");
  if (operations.length > MAX_BATCH_OPERATIONS) {
    throw new SyncProtocolError(`a batch must hold at most ${MAX_BATCH_OPERATIONS} operations`);
  }
  const base = HANDLES.has(snapshot) ? snapshot : restoreJournal(snapshot);
  return fold(base, parseEach(operations, "operation"));
}

/**
 * Validates a list of operations. Indexed rather than mapped on purpose: `map` walks past the
 * holes of a sparse array and leaves them holes, so `new Array(3)` reached the merge as three
 * undefined operations and answered with a TypeError — which a caller cannot tell apart from a
 * bug in the protocol, and therefore cannot quarantine.
 */
function parseEach(values: readonly unknown[], label: string): Operation[] {
  const operations: Operation[] = new Array<Operation>(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) throw new SyncProtocolError(`${label} must not be empty`);
    operations[index] = parseOperation(value);
  }
  return operations;
}

/** Replays a whole journal from scratch. The order of the input does not matter. */
export function applyJournal(operations: readonly Operation[]): JournalSnapshot {
  return applyOperations(createEmptyJournal(), operations);
}

function readAppliedOpIds(value: unknown): readonly OpId[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SyncProtocolError("journal snapshot appliedOpIds must be an array");
  if (value.length > MAX_APPLIED_OP_IDS) {
    throw new SyncProtocolError(`journal snapshot must list at most ${MAX_APPLIED_OP_IDS} applied operations`);
  }
  // Indexed rather than mapped: `map` leaves the holes of a sparse array alone, and an
  // unvalidated hole would reach the bookkeeping set as undefined.
  const opIds: OpId[] = new Array<OpId>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    opIds[index] = parseUuid(value[index], "journal snapshot appliedOpId");
  }
  return opIds;
}

/**
 * The clock a stored snapshot carries. Read rather than recomputed, for the same reason the
 * applied identifiers are: an entry only holds the operation that still owns its entity, so
 * the highest stamp of the entries is not the highest stamp the device ever saw. Recomputing
 * dropped a device from 900 000 to 3 across a restart, after which it wrote its own history
 * under stamps it had already used and lost every conflict against its own past.
 *
 * Validation only: the value is checked for shape and refused above {@link MAX_LAMPORT}, and it
 * is returned as it was stored. What a stored clock at or above the honest ceiling costs, and
 * what `restoreJournal` does about it, is written there.
 */
function readLamport(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SyncProtocolError("journal snapshot lamport must be a non-negative integer");
  }
  if (value > MAX_LAMPORT) {
    throw new SyncProtocolError(`journal snapshot lamport must be at most ${MAX_LAMPORT}`);
  }
  return value;
}

/**
 * Reads the activation register a stored snapshot carries.
 *
 * The whole register is restored, not the winning pointer alone: the pointer is chosen among
 * the activations whose budget is still in the journal, so a device that kept only the winner
 * and later saw that budget deleted would fall back to a different pointer than a device that
 * never restarted. `activeBudget` is accepted as well and merged in, so a snapshot written
 * before the register existed still restores — it is derived output, and folding it back in
 * costs nothing because the register is keyed by target.
 */
function readActivations(value: unknown, pointer: unknown): ActivateBudgetOperation[] {
  const source: unknown[] = [];
  if (value !== undefined && value !== null) {
    if (!Array.isArray(value)) throw new SyncProtocolError("journal snapshot activations must be an array");
    // No ceiling, for the same reason the entries have none: the register grows with every
    // budget a family ever activated, the fold bounds it nowhere, and a device that cannot read
    // back a register it wrote itself never starts again. See {@link MAX_JOURNAL_ENTRIES}.
    for (const entry of value as readonly unknown[]) source.push(entry);
  }
  if (pointer !== undefined && pointer !== null) source.push(pointer);

  const activations: ActivateBudgetOperation[] = [];
  for (const entry of parseEach(source, "journal snapshot activation")) {
    if (entry.action !== "activate") {
      throw new SyncProtocolError("journal snapshot activation must be a budget activation");
    }
    activations.push(entry);
  }
  return activations;
}

/**
 * Rebuilds a snapshot that came from outside this module — storage, a worker, a network
 * peer. The entries, the activation register, the applied identifiers and the clock are the
 * only input trusted, and each of them is validated one by one; the state is recomputed
 * rather than believed.
 *
 * The applied identifiers and the clock are read rather than recomputed on purpose. An entry
 * only carries the operation that still owns its entity, so recomputing either of them would
 * forget every operation a later write has overridden, and a device that restarted would
 * acknowledge less than it did before the restart and write under stamps it had already used.
 */
export function restoreJournal(value: unknown): JournalSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SyncProtocolError("journal snapshot must be an object");
  }
  const record = value as {
    readonly entries?: unknown;
    readonly activeBudget?: unknown;
    readonly activations?: unknown;
    readonly appliedOpIds?: unknown;
    readonly lamport?: unknown;
  };
  if (!Array.isArray(record.entries)) throw new SyncProtocolError("journal snapshot entries must be an array");

  const operations = parseEach(record.entries, "journal snapshot entry");
  for (const operation of operations) {
    if (operation.action === "activate") {
      throw new SyncProtocolError("journal snapshot entries must not hold a budget activation");
    }
  }
  operations.push(...readActivations(record.activations, record.activeBudget));

  const memo = emptyMemo();
  for (const opId of readAppliedOpIds(record.appliedOpIds)) {
    if (memo.applied.has(opId)) continue;
    memo.applied.add(opId);
    memo.order.push(opId);
  }

  // A stored clock is carried no further than MAX_HONEST_LAMPORT, and never silently. From the
  // honest ceiling upwards a stamp carries no rank at all, so a device that restored a poisoned
  // clock and went on writing from there would lose every conflict for the rest of its life
  // without ever being told why.
  //
  // Clamping alone used to be the whole answer, and it laundered rather than repaired: a forged
  // snapshot claiming 2^40 came back as exactly 2^32, which — while the ranking spared its own
  // ceiling — was not the least plausible stamp in the protocol but the most powerful one, handed
  // to the device that had just been attacked. So the value is brought down below the line and
  // the event is reported as `implausible_lamport` about this device, whose identifier a snapshot
  // does not carry: the empty identifier means the clock of the device doing the restoring rather
  // than a peer. Nothing is withheld for it, as with every other report of that code — the family
  // goes on seeing its budget, and its own device is named as the one to look at.
  const stored = readLamport(record.lamport);
  const restored: JournalProblem[] = [];
  if (stored >= HONEST_LAMPORT_CEILING) restored.push(problem("implausible_lamport", null, ""));
  const lamport = Math.min(stored, MAX_HONEST_LAMPORT);

  const result = foldInto(memo, { lamport }, operations);
  return materialize(memo, result.lamport, [...restored, ...result.problems]);
}
