import type {
  Account,
  AnnualCommitment,
  Budget,
  BudgetId,
  BudgetLine,
  BudgetState,
  Category,
  Goal,
  Member,
  MemberId,
  MemberRole,
  ScheduledExpense,
  StableId,
  Transaction,
} from "@family-budget/domain";

export type DeviceId = string;
export type OpId = string;

/**
 * The participant, the identifier that names one and the label a participant carries, taken
 * from the domain rather than declared again.
 *
 * They lived here while the domain had no model of a participant. It has one now, field for
 * field the same, and two identical declarations of one concept are not a redundancy that
 * costs nothing: they drift the moment either side gains a field, and the journal would then
 * replicate a participant the budget cannot read.
 *
 * What does not come from the domain is the standing of a role *in the journal*. A role here
 * is whatever the writing device claimed, because any device can author any operation, so it
 * may never be used to authorise anything: it labels a participant in the history and nothing
 * more. The server decides who may read or write a family, and its decision is the only one
 * that binds.
 */
export type { Member, MemberId, MemberRole };

/**
 * A {@link BudgetState} whose participants are always present.
 *
 * Not redundant now that the domain carries members itself: the domain declares them optional,
 * because every backup and every budget written before participants existed omits them and
 * stays valid. A journal has no such history to honour — it materialises the list on every
 * pass, empty when a family has named nobody — so the state it produces promises the list, and
 * a consumer of this package reads `state.members` without a fallback.
 */
export interface SyncedBudgetState extends BudgetState {
  readonly members: readonly Member[];
}

/** Omit that keeps a discriminated union discriminated. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type AccountFields = Omit<Account, "id">;
export type CategoryFields = Omit<Category, "id">;
/** Budget lines are replicated one by one, so the header never carries them. */
export type BudgetFields = Omit<Budget, "id" | "lines">;
export interface BudgetLineFields extends Omit<BudgetLine, "id"> {
  /** Fixed when the line is created; move a line by deleting and recreating it. */
  readonly budgetId: BudgetId;
}
export type GoalFields = Omit<Goal, "id">;
export type AnnualCommitmentFields = Omit<AnnualCommitment, "id">;
export type ScheduledExpenseFields = Omit<ScheduledExpense, "id">;
export type TransactionFields = DistributiveOmit<Transaction, "id">;
export type MemberFields = Omit<Member, "id">;

export interface EntityFieldsByKind {
  readonly account: AccountFields;
  readonly category: CategoryFields;
  readonly budget: BudgetFields;
  readonly budgetLine: BudgetLineFields;
  readonly goal: GoalFields;
  readonly annualCommitment: AnnualCommitmentFields;
  readonly scheduledExpense: ScheduledExpenseFields;
  readonly transaction: TransactionFields;
  readonly member: MemberFields;
}

export type EntityKind = keyof EntityFieldsByKind;
export type EntityFields = EntityFieldsByKind[EntityKind];

export const ENTITY_KINDS = [
  "account",
  "category",
  "budget",
  "budgetLine",
  "goal",
  "annualCommitment",
  "scheduledExpense",
  "transaction",
  "member",
] as const satisfies readonly EntityKind[];

export const OPERATION_ACTIONS = ["create", "update", "delete", "activate"] as const;

export interface OperationHeader {
  readonly opId: OpId;
  readonly deviceId: DeviceId;
  readonly lamport: number;
  /** Family participant credited with the change. */
  readonly memberId?: MemberId;
}

/**
 * A create or an update. Both carry the complete field set: conflict resolution is
 * last-write-wins per entity, so a partial patch could never be merged safely.
 */
export interface EntityWriteOperation<K extends EntityKind> extends OperationHeader {
  readonly entity: K;
  readonly action: "create" | "update";
  readonly targetId: StableId;
  readonly fields: EntityFieldsByKind[K];
}

/** A delete is final: no later write revives the entity. */
export interface EntityDeleteOperation extends OperationHeader {
  readonly entity: EntityKind;
  readonly action: "delete";
  readonly targetId: StableId;
}

/**
 * Points activeBudgetId at a budget.
 *
 * Not a last-write-wins register of the family: the pointer is chosen on the converged journal
 * among the activations whose budget is actually in it — see `selectActiveBudget` in journal.ts
 * for the permanent freeze that rule replaced.
 */
export interface ActivateBudgetOperation extends OperationHeader {
  readonly entity: "budget";
  readonly action: "activate";
  readonly targetId: BudgetId;
}

export type EntityWrite = { [K in EntityKind]: EntityWriteOperation<K> }[EntityKind];
export type Operation = EntityWrite | EntityDeleteOperation | ActivateBudgetOperation;
export type OperationAction = Operation["action"];

/** The operation that currently owns an entity: its winning write, or the delete that ended it. */
export type JournalEntry = EntityWrite | EntityDeleteOperation;

/**
 * Why the integrity gate withheld something, or what it wants a person to look at.
 *
 * Structured on purpose. A sentence built around an identifier hands the writer of that
 * identifier a hundred and twenty-eight characters of free text on somebody else's screen,
 * and an operation is written by whichever device sent it. The consumer renders the code in
 * its own words and treats {@link JournalProblem.id} as data, never as prose.
 */
export const JOURNAL_PROBLEM_CODES = [
  /** No budget has been activated yet. */
  "no_active_budget",
  /** The activation points at a budget that has not arrived. */
  "unknown_active_budget",
  /** Two entity kinds claim one identifier; the loser of the total order is withheld. */
  "identifier_claimed_twice",
  /** A reference does not resolve: the account, category, budget, goal or expense is gone. */
  "unknown_reference",
  /** An expense-only reference points at an income category. */
  "wrong_category_type",
  /** A refund does not match the posted expense it refunds. */
  "invalid_refund",
  /** A goal contribution does not land on the account linked to the goal. */
  "goal_account_mismatch",
  /** One budget plans one category twice. */
  "duplicate_budget_line",
  /**
   * A total the domain sums has left the range a domain calculation stays safe in. A property
   * of the journal, with no entity named — nothing is withheld for it.
   */
  "amount_out_of_range",
  /**
   * The journal holds more entries than any family fills. Nothing is withheld for it and no
   * author is named — the count is reported, and that is all it does.
   */
  "journal_entry_budget",
  /**
   * One author owns more tombstones than any honest history explains. Nothing is withheld for
   * it: an honest bulk deletion still shows the family its budget.
   */
  "tombstone_budget",
  /**
   * The oldest operation identifiers fell out of the bookkeeping window. Nothing is withheld
   * for it, and nothing in the state depends on the window.
   */
  "applied_id_budget",
  /**
   * A device stamped an operation at or past anything honest work produces, so the stamp
   * carries no rank in the merge. Nothing is withheld for it — the stamp has already cost its
   * writer every conflict. A property of the converged journal, not of a delivery.
   * The empty identifier means this device's own stored clock, read back above the line from a
   * snapshot and brought below it.
   */
  "implausible_lamport",
] as const;

export type JournalProblemCode = (typeof JOURNAL_PROBLEM_CODES)[number];

/**
 * Why an entity the journal holds is not in the state.
 *
 * Every reason here is also a {@link JournalProblemCode}, because the rule that withheld the
 * entity and the record of what it withheld are the same finding seen from two sides. They are
 * kept apart all the same: a problem answers *what the gate found*, a withholding answers *what
 * this family cannot see*, and the second question is the one a person asks.
 *
 * - `identifier_claimed_twice`, `duplicate_budget_line` — the loser of the total order, dropped
 *   so that the winner can be shown.
 * - `unknown_reference`, `wrong_category_type` — the entity points at something the state does
 *   not hold, and the domain throws on such a reference rather than ignoring it.
 * - `invalid_refund`, `goal_account_mismatch` — reachable by honest concurrent editing (moving a
 *   goal to another account while a contribution is in flight); the offending transaction is
 *   dropped and everything around it stays correct.
 * - `unknown_active_budget` — an activation whose budget is not in the state, passed over so
 *   that a budget the family can actually see owns the pointer. When *no* activation resolves,
 *   the same code appears as a problem instead, and then the state cannot be shown at all.
 */
export const WITHHOLDING_REASONS = [
  "identifier_claimed_twice",
  "unknown_reference",
  "wrong_category_type",
  "invalid_refund",
  "goal_account_mismatch",
  "duplicate_budget_line",
  "unknown_active_budget",
] as const satisfies readonly JournalProblemCode[];

export type WithholdingReason = (typeof WITHHOLDING_REASONS)[number];

/**
 * One entity the merge kept in the journal and left out of the state.
 *
 * Structured for the same reason {@link JournalProblem} is: the identifier is written by
 * whichever device sent the operation, so it is data for the consumer to render, never prose.
 */
export interface WithheldEntity {
  /** Kind of the entity that is missing from the state. */
  readonly entity: EntityKind;
  /** Identifier of the entity that is missing from the state. */
  readonly id: StableId;
  readonly reason: WithholdingReason;
}

/**
 * Codes that make {@link JournalIntegrity.ready} false, and the only ones that do.
 *
 * Sorting problems into "advisory" and "not advisory" was the wrong shape, and it forced a
 * choice between two requirements that both had to hold. Nothing may disappear silently — so
 * every withholding had to be a problem that lowered `ready`. And a conflict the merge has
 * already settled may not freeze a family — so a withholding must *not* lower `ready`, because
 * the journal never shrinks and no later operation revives a loser: an invalid refund or a goal
 * contribution left over from a moved goal, both reachable by honest concurrent editing, would
 * have meant a real family stuck for ever on an old snapshot.
 *
 * Two separate questions were being asked through one field. They are asked separately now:
 *
 * - **`ready` asks only whether this state is safe to show.** It is false when the state itself
 *   cannot be rendered — there is no active budget, or the pointer names a budget the journal
 *   does not hold, and every domain calculation over it throws. Nothing else lowers it.
 * - **{@link JournalIntegrity.withheld} asks what the family cannot see.** Every entity left out
 *   of the state is listed there with its kind, its identifier and its reason, whether or not
 *   the snapshot is ready.
 *
 * So both requirements hold at once: nothing disappears silently, and no resolved conflict
 * freezes a family.
 */
export const UNSHOWABLE_PROBLEM_CODES = [
  "no_active_budget",
  "unknown_active_budget",
] as const satisfies readonly JournalProblemCode[];

export interface JournalProblem {
  readonly code: JournalProblemCode;
  /** Entity kind the problem is about, or null when it is not about one entity. */
  readonly entity: EntityKind | null;
  /**
   * Identifier the problem is about: an entity for most codes, and a device for a tombstone
   * budget or an implausible stamp. The empty string means the problem is about no single
   * identifier — a property of the journal itself, the shared bucket of authors the family has
   * nothing to show for, or this device's own clock read back from a snapshot.
   */
  readonly id: string;
}

/**
 * Verdict of the integrity gate that stands between the journal and the domain.
 *
 * A merge can produce a combination no single device ever wrote: a category deleted while a
 * budget line still points at it, a transaction whose account is gone, or an activation of a
 * budget that never arrived. The domain refuses such a state by throwing, and a tombstone is
 * final, so recreating the entity would not repair it. The gate therefore keeps those entities
 * in the journal but leaves them out of the state, and records why here.
 *
 * **What the gate is for, and what it is not for.** It exists so that a family converges on one
 * budget whatever the server and the network do to a delivery — reorder it, delay it, duplicate
 * it, cut it in half, or interrupt the device folding it. It is not a defence against a member
 * of the family: every input a rule on this side could measure — the stamp, the device
 * identifier, the entity identifier, the amount — is written by the peer the rule would bound,
 * and a member who wants the family's data gone can delete it outright without touching any of
 * them. Six rounds of hardening against a participant produced six levers and no protection;
 * decision 39 fixes the boundary instead, and the anchor that orders writes against a peer is
 * the server's own sequencing, arriving in phase S4.
 */
export interface JournalIntegrity {
  /**
   * True when {@link JournalSnapshot.state} is safe to show: it has an active budget, and that
   * budget is in the journal, so a domain calculation over it returns rather than throws.
   *
   * It is not a verdict that everything is in order. A ready snapshot may still be missing
   * entities — read {@link withheld} to find out, and see {@link UNSHOWABLE_PROBLEM_CODES} for
   * why the two questions are asked separately. False means a consumer must go on showing the
   * last snapshot that was ready, because this one cannot be rendered at all.
   */
  readonly ready: boolean;
  /** Sorted, deduplicated. Empty when the gate found nothing at all. */
  readonly problems: readonly JournalProblem[];
  /**
   * Every entity the journal holds and the state does not, with the reason for each.
   * Sorted by kind, identifier and reason; deduplicated; empty when nothing was withheld.
   *
   * **Contract for phase S6, part of the interface rather than an implementation note.** An
   * interface that shows {@link JournalSnapshot.state} must show this list too, including when
   * {@link ready} is true — that is the case it exists for. A family that is shown its budget
   * while a payment of its own is quietly absent has been told something false; whichever device
   * wrote the operation that displaced it, the family is entitled to know the record exists, what
   * kind of record it is, and why it is not on the screen. Silence here is a defect, not a tidier
   * screen.
   *
   * A withheld entity is not lost: the journal keeps it, and it comes back by itself if what it
   * was waiting for arrives — a parent that has not been delivered yet, for instance. The ones
   * that will never come back are the losers of a conflict the merge has already settled, and
   * they are exactly the ones a person has to be told about, since no later delivery will
   * explain their absence.
   */
  readonly withheld: readonly WithheldEntity[];
}

/**
 * The result of a merge.
 *
 * **Read contract, part of the interface rather than an implementation note.** The integrity
 * gate that produces {@link JournalSnapshot.state}, {@link JournalSnapshot.integrity} and
 * {@link JournalSnapshot.entries} walks the whole converged journal, because every limit it
 * applies is a function of that whole set and of nothing else. Each of the three therefore
 * costs O(entries) the first time it is read on a given snapshot, and nothing on every read
 * after that. Folding is cheap and independent of it.
 *
 * So a consumer that reads any of the three after every envelope pays O(envelopes × entries):
 * measured at eighteen seconds for four thousand envelopes, and at the quota of one epoch that
 * is minutes of a blocked main thread. The contract is **fold the whole delivery, then read
 * the verdict once**:
 *
 * ```ts
 * let snapshot = createEmptyJournal();
 * for (const envelope of delivery) snapshot = applyOperations(snapshot, [envelope]);
 * if (snapshot.integrity.ready) show(snapshot.state); // once per delivery, never per envelope
 * ```
 *
 * A consumer that must show progress mid-delivery reads on a fixed schedule — once per screen
 * refresh — and never once per envelope.
 */
export interface JournalSnapshot {
  /**
   * Materialised state, ready for @family-budget/domain.
   *
   * Always syntactically valid. When {@link JournalIntegrity.ready} is false the active budget
   * does not resolve and every domain calculation over it would throw, so a consumer must keep
   * the last snapshot whose integrity was ready and go on showing that one until the missing
   * operations arrive. When it is true the state can be rendered — which does not mean nothing
   * is missing from it: {@link JournalIntegrity.withheld} lists what is, and an interface has to
   * show that list either way.
   *
   * Costs a full pass over the journal on first read. See the read contract above.
   */
  readonly state: SyncedBudgetState;
  /**
   * Whether {@link state} is safe to hand to the domain, and what is wrong when it is not.
   * Costs a full pass over the journal on first read. See the read contract above.
   */
  readonly integrity: JournalIntegrity;
  /**
   * One winning operation per entity, tombstones included, ordered by entity and target.
   * Costs a full pass over the journal on first read. See the read contract above.
   */
  readonly entries: readonly JournalEntry[];
  /**
   * Winning pointer to the active budget, or null while no budget has been activated.
   *
   * Derived from {@link activations} and from the entities the journal holds, so it is not
   * input: restoring a snapshot recomputes it. See `selectActiveBudget` in journal.ts.
   */
  readonly activeBudget: ActivateBudgetOperation | null;
  /**
   * The best activation of every budget ever activated, ordered by target.
   *
   * The whole register is carried rather than the winner alone, because the pointer is chosen
   * among the activations whose budget is still in the journal: a device that kept only the
   * winner and then saw that budget deleted would fall back to a different pointer than a
   * device that never restarted, and the two would disagree about which budget the family is
   * looking at. One entry per distinct target, so it grows with the budgets a family has
   * activated and not with the operations it has folded.
   */
  readonly activations: readonly ActivateBudgetOperation[];
  /**
   * Sorted identifiers of every operation folded into this snapshot, including the ones a
   * later write has already overridden. Bookkeeping for the unchanged-snapshot fast path,
   * for checkpoints and for audit only: it is never a reason to skip an operation, because
   * two devices may reuse one identifier for different content. It is carried through a
   * restore rather than recomputed, so restarting a device does not change what it has
   * already acknowledged.
   */
  readonly appliedOpIds: readonly OpId[];
  /**
   * The highest stamp this journal *adopted*, which is not the highest stamp it has seen: a
   * stamp further than MAX_LAMPORT_SKEW beyond the clock the fold started from is folded but
   * not adopted, and adoption stops at MAX_HONEST_LAMPORT. It is local bookkeeping — what
   * this device stamps its own writes with — so two devices handed the same operations in
   * different deliveries may carry different values here and still agree about the family down
   * to the last kopeck. Nothing in the state is decided by it.
   */
  readonly lamport: number;
}

export interface LamportClock {
  readonly deviceId: DeviceId;
  readonly lamport: number;
}

export type OperationDraft = (
  | { [K in EntityKind]: Omit<EntityWriteOperation<K>, keyof OperationHeader> }[EntityKind]
  | Omit<EntityDeleteOperation, keyof OperationHeader>
  | Omit<ActivateBudgetOperation, keyof OperationHeader>
) & {
  /** Generated from crypto.randomUUID() when omitted. */
  readonly opId?: OpId;
  readonly memberId?: MemberId;
};

export interface LocalOperation {
  readonly clock: LamportClock;
  readonly operation: Operation;
}
