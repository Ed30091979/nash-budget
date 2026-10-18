import type { JournalSnapshot, OpId } from "@family-budget/sync-protocol";

import type { CheckpointAlarm, CheckpointLink } from "./checkpoint.js";

/**
 * An envelope as it travels: the header in the clear, the IV and the ciphertext in base64.
 *
 * The same six header fields the AAD binds (5.2), and no others. `seq` and `receivedAt` are not
 * here because the sender does not have them — the server assigns both after the envelope is
 * sealed, which is exactly why 3.4 makes the client check `seq` continuity itself.
 */
export interface OutgoingEnvelope {
  readonly envelopeVersion: number;
  readonly kind: string;
  readonly familyId: string;
  readonly opId: OpId;
  readonly deviceId: string;
  readonly keyEpoch: number;
  readonly iv: string;
  readonly ciphertext: string;
}

/** What the server hands back: the sealed envelope plus the two numbers it stamped on it. */
export interface DeliveredEnvelope extends OutgoingEnvelope {
  readonly seq: number;
  readonly receivedAt: number;
}

/**
 * Decision 15: the cursor is the pair `(keyEpoch, seq)`, and it lives only on the client.
 *
 * `seq: 0` means "nothing of this epoch has been applied", so the first envelope of an epoch must
 * be number `1` — the rule 3.4 step 2 states, expressed as arithmetic rather than as a special
 * case.
 */
export interface SyncCursor {
  readonly keyEpoch: number;
  readonly seq: number;
}

/**
 * The epoch this device has accepted, and the digest of the key it accepted it with.
 *
 * Local state and nothing else. 5.4.1 is explicit that the accepted epoch never travels to the
 * server: a server told which epoch a device holds can offer it a chain starting where it is
 * weakest, or read off which devices are behind and pick a convenient minute to ask a person to
 * confirm a key. Every request this package makes is therefore free of it — see `keys()` in
 * `transport.ts`, which takes no parameters at all.
 *
 * `live` records the proof of liveness of 5.4.1: the epoch is only "accepted" for the purpose of
 * refusing a step down once the server has taken at least one of this device's own envelopes in
 * it and answered with a `seq`.
 */
export interface AcceptedEpoch {
  readonly keyEpoch: number;
  /** `SHA-256(FK)` in lower-case hex — the value that decides "I have already closed this epoch". */
  readonly keyDigest: string;
  readonly live: boolean;
}

/**
 * Why the intake stopped. The cursor never moves past the envelope named here.
 *
 * A list and not a bare union, because the stop is written to disk and read back: a record whose
 * `reason` is a string no branch of this build knows would reach a screen as no message at all.
 */
export const SYNC_STOP_REASONS = [
  /**
   * A tag check failed on an envelope of this device's own live epoch, or an envelope arrived
   * under another epoch number with no legitimately announced epoch change behind it. 3.4 and
   * 5.4.1 give both the same treatment: alarm from the first envelope, cursor stopped, and no
   * automatic skip — not after ten retries, not after a day, not ever.
   */
  "key_mismatch",
  /** 3.4 step 2: the numbering skipped. The cursor stays put and the request is repeated. */
  "journal_incomplete",
  /** 3.4 steps 4 and 5, after the tag verified: this build cannot read what the family wrote. */
  "update_required",
  /** 3.4 step 6 and the bounds check: quarantine, with no automatic skip in this phase. */
  "quarantined",
] as const;

export type SyncStopReason = (typeof SYNC_STOP_REASONS)[number];

export interface SyncStop {
  readonly reason: SyncStopReason;
  /** The `seq` the delivery stopped on. */
  readonly seq: number;
  /** The `opId` of the envelope, as its open header spelled it. Data, never prose. */
  readonly opId: OpId;
  /**
   * Consecutive failed attempts on this very envelope. 3.4: `10` is a threshold of *retries* of
   * one envelope, after which the message changes from «не удалось прочитать» to «ключ семьи не
   * совпадает». It is never a threshold of how many different envelopes failed, and the counter
   * enforces that rather than assuming it: a delivery that stops on a different `opId` than the
   * one the previous stop named starts again at `1`. Without the reset a device that had been
   * retrying an incomplete journal for nine rounds would show «ключ семьи не совпадает» — the one
   * alarm this system has — for the first failure of an unrelated envelope.
   */
  readonly attempts: number;
}

/** 3.4 step 7: the stamp was folded, but this device's clock did not follow it there. */
export interface LamportNotice {
  readonly opId: OpId;
  /** The device the operation names as its author. Data for the consumer to render. */
  readonly deviceId: string;
}

export interface IntakeResult {
  readonly snapshot: JournalSnapshot;
  readonly cursor: SyncCursor;
  /** Operations folded into {@link snapshot} by this delivery. */
  readonly applied: number;
  /** Checkpoint envelopes read, this device's own included. */
  readonly checkpoints: number;
  /**
   * Of those, the ones actually measured against this device's set — somebody else's (3.6).
   *
   * Kept apart from {@link checkpoints} because it is what clears a warning: a peer's checkpoint
   * that agreed is evidence the journals agree *now*, while this device's own checkpoint is only
   * evidence that it agrees with itself.
   */
  readonly compared: number;
  readonly notices: readonly LamportNotice[];
  /** `M` of 3.6 after this delivery: the operations of the epoch read out of the journal. */
  readonly journalOpIds: readonly string[];
  /** The chain `(deviceId, index)` after this delivery — one link per device. */
  readonly chain: readonly CheckpointLink[];
  /**
   * Checkpoints that did not agree — «журнал расходится» (3.6).
   *
   * Not a stop. A divergence neither blocks work nor rewinds state: it is a signal to a person
   * and a reason to rebuild by hand. The cursor moves past a checkpoint that disagreed exactly as
   * it moves past one that agreed, and the alarm travels beside it.
   */
  readonly alarms: readonly CheckpointAlarm[];
  /** `null` when the whole delivery was consumed. */
  readonly stop: SyncStop | null;
}

export interface PushResult {
  /** Envelopes the server numbered and this device removed from the queue. */
  readonly confirmed: number;
  /** Envelopes still waiting after this attempt. Includes {@link stranded}. */
  readonly pending: number;
  /**
   * Queued envelopes sealed under an epoch whose key this device no longer holds — 5.5 step 8.
   *
   * They were not submitted: the server refuses a whole batch over one envelope naming an epoch
   * that is not in force. They were not deleted either, because each one is a local change that
   * has not reached the family yet. Anything other than `0` is a device that needs the key of the
   * epoch it left in order to finish moving its own queue across.
   */
  readonly stranded: number;
}

export interface PullResult
  extends Omit<IntakeResult, "snapshot" | "journalOpIds" | "chain"> {
  /** Requests actually made. Zero means the cursor was already at the end of the journal. */
  readonly requests: number;
  /**
   * The document was rewritten from the journal before the walk began, with nothing fetched: a
   * hold lifted because this build now opens the journal's state, or the family's state taken up
   * by a device that held it without the record saying so. A screen showing the document has a
   * new state to show even when {@link applied} is `0`.
   */
  readonly settled: boolean;
  /**
   * The walk stopped on this build's own page cap, not at the end of the journal.
   *
   * The cap bounds one call and not the journal, so `true` means "there is more, call again" and
   * is a different answer from the `stop` of an alarm: nothing is wrong, the budget of this call
   * is simply spent.
   */
  readonly pageLimitReached: boolean;
}

/**
 * Why the document does not show the family's journal although the journal says it can be shown.
 *
 * A list and not a bare union for the reason {@link SYNC_STOP_REASONS} is: the record is written to
 * disk and read back, and a reason no branch of this build knows would reach a screen as nothing.
 */
export const DOCUMENT_HOLD_REASONS = [
  /**
   * The application's own gate (`SyncEngineOptions.acceptsState`) refused the state the journal
   * materialised — a version skew: a newer build of a peer wrote something this one does not open.
   * The journal and the cursor moved, nothing of the family's is lost, the document holds what the
   * application last accepted, and local writes are refused (`document_held`) — so the family is
   * told, instead of looking at yesterday's budget in silence or writing over today's.
   */
  "rejected_by_app",
] as const;

export type DocumentHoldReason = (typeof DOCUMENT_HOLD_REASONS)[number];

export interface DocumentHold {
  readonly reason: DocumentHoldReason;
  /**
   * What the document holds instead. `kept` — the last state of this family's journal the
   * application accepted (or the budget this device founded the family with); `empty` — nothing of
   * the family's: no document at all, or one that never was a state of this family's journal — the
   * personal budget of a device that joined, for one — and a state the application refuses is not
   * written in its place. Either way the device writes nothing while the hold is in force.
   */
  readonly document: "kept" | "empty";
}

export interface SyncStatusReport {
  readonly cursor: SyncCursor;
  readonly queued: number;
  readonly epoch: AcceptedEpoch;
  readonly stop: SyncStop | null;
  /** The journal's state that the document does not show, and why; `null` while it shows it. */
  readonly hold: DocumentHold | null;
  /**
   * Whether the document, when there is one, is this family's: written from a state of the
   * family's journal that the application accepted, or the budget this device founded the family
   * with (`SyncEngineOptions.foundedDocument`). `false` is a device whose document is still what
   * it held before it joined — not a budget to show as the family's, nor one to write the family's
   * operations from — or that never received one.
   */
  readonly familyDocument: boolean;
}
