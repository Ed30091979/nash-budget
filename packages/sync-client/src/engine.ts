/**
 * The client engine: the queue, the pull and the single transaction that ties them to the state.
 *
 * Three properties this file exists to hold, all of them from `SYNC_ARCHITECTURE.md`:
 *
 * 1. **3.1 step 7** — the sealed envelope enters the queue in the *same* IndexedDB transaction as
 *    the changed state and the new clock. A state changed locally cannot exist without its queue
 *    entry, and a queue entry cannot exist without the state it came from. `commitWithSync` in
 *    `@family-budget/storage` is that transaction.
 * 2. **3.3, last paragraph** — a record leaves the queue only against a `seq` the server actually
 *    returned. A dropped connection, a `409` of any kind, a batch that was never answered: all of
 *    them leave the queue exactly as it was.
 * 3. **3.4 step 10 and the existing compare-and-set** — a delivery of somebody else's operations
 *    is written against the revision it was folded on. A local write that lands in between wins
 *    the race, and the delivery is folded again on top of it rather than over it.
 *
 * 4. **5.5 step 8** — the epoch is a single value. The engine is constructed with the key it
 *    holds and that key's epoch number, and every request, every envelope and every record it
 *    writes names *that* number. A cursor found under an earlier one is the ordinary outcome of a
 *    rotation and is reset to the beginning of the new epoch; a cursor found under a later one is
 *    a step down and is refused. Neither is allowed to degenerate into «ключ семьи не совпадает»,
 *    which is the one alarm this system has and is spent on a forged envelope alone. The queue
 *    crosses with the cursor: what is waiting is re-sealed under the key in hand, because the
 *    server refuses a whole batch over one envelope naming an epoch that is not in force, and a
 *    queue that cannot drain is a device that never proves its new epoch live and therefore never
 *    lets the old key be forgotten.
 *
 * And one property from section 9, which is a property of what this file does *not* do: nothing
 * here runs until an account exists. The engine is constructed after sign-in, so with no account
 * there is no queue, no cursor and not one request.
 */
import {
  type IndexedDbBudgetRepository,
  type OutboxAppend,
  type OutboxRecord,
  type SaveIfRevisionResult,
} from "@family-budget/storage";
import {
  checkpointDigest,
  checkpointSeedDigest,
  ENVELOPE_VERSION,
  openEnvelope,
  sealEnvelope,
  toHex,
  utf8,
} from "@family-budget/sync-crypto";
import {
  applyOperations,
  createClock,
  createEmptyJournal,
  createLocalOperation,
  encodeOperation,
  restoreJournal,
  type JournalSnapshot,
  type Operation,
  type OperationDraft,
  type SyncedBudgetState,
} from "@family-budget/sync-protocol";

import { fromBase64, toBase64 } from "./base64.js";
import {
  CHECKPOINT_ALARM_REASONS,
  encodeCheckpointRecord,
  type CheckpointAlarm,
  type CheckpointLink,
} from "./checkpoint.js";
import { SyncClientError } from "./errors.js";
import { applyDelivery } from "./intake.js";
import type { SyncTransport } from "./transport.js";
import { SYNC_STOP_REASONS } from "./types.js";
import type {
  AcceptedEpoch,
  OutgoingEnvelope,
  PullResult,
  PushResult,
  SyncCursor,
  SyncStatusReport,
  SyncStop,
  SyncStopReason,
} from "./types.js";

/** Names of the records this engine keeps in the sync store. */
export const SYNC_STATE_KEYS = {
  journal: "journal",
  cursor: "cursor",
  epoch: "epoch",
  stop: "stop",
  /**
   * The re-encrypted queue of 5.5 step 8, written down before the old records are removed.
   *
   * The store has no way to swap a queue entry for another under the same `opId` in one
   * transaction — the identifier is unique, so the old record has to go before the new one can be
   * added — and a crash between the two would take a local change with it. So the new envelopes
   * are put here first, and the record is cleared in the same transaction that adds them back.
   * A record found on the next run is a rewrite that was interrupted, and it is finished before
   * anything else touches the queue.
   */
  rekey: "rekey",
  /**
   * The journal integrity anchor of 3.6: the set `M`, the chain read from it, the last alarm and
   * this device's own place in its own chain.
   *
   * One record and not four, because all four belong to one epoch and are reset together the
   * moment a rotation moves the cursor. A record naming another epoch is not migrated: the digest
   * and the chain seed are both bound to the epoch number, so nothing in it can be recomputed
   * into the new one, and the new epoch starts its chains at `1` (5.5 step 2 has what the old one
   * lost travel in `inheritedGaps` of the first checkpoint of the new epoch instead).
   */
  anchor: "anchor",
} as const;

/**
 * How many envelopes one fetch asks for, and how many one submission carries.
 *
 * Both are constants of this build. The fetch size in particular is never taken from a response:
 * a limit derived from something the other side writes is a limit the other side sets.
 */
export const FETCH_LIMIT = 200;
export const SUBMIT_BATCH_SIZE = 200;

/**
 * When a checkpoint is written — 3.6, the rules of the anchor, as constants of this build.
 *
 * «Чекпойнт пишет любое устройство после каждых `200` применённых операций и при каждом переходе
 * в фон; чаще одного раза в `10` минут — не пишет.» The count is of operations folded out of the
 * journal, because those are the ones that change the set the digest is taken over; the floor is
 * read off this device's own clock. Neither number comes from a response, and neither could: the
 * anchor exists to measure the server, and a rate the server sets is a rate at which the server
 * decides how often it is measured.
 */
export const CHECKPOINT_EVERY_OPERATIONS = 200;
export const CHECKPOINT_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * How long a set this build will read back out of its own anchor record.
 *
 * Far above the server's envelope quota of `100 000` (5.5), so it bounds a corrupted record and
 * never an honest family.
 */
const MAX_JOURNAL_OP_IDS = 1_000_000;

/** How many pages one `pull()` will walk before returning. Bounds one call, not the journal. */
const MAX_PAGES_PER_PULL = 64;
/** Compare-and-set attempts before a write gives up and says so. */
const MAX_WRITE_ATTEMPTS = 4;

/**
 * A key of an epoch this device has left behind, kept for one purpose only.
 *
 * 5.5 step 8 has the device re-encrypt its *outgoing queue* under the new key, and a queue entry
 * can only be re-encrypted by whoever can open it. So the engine that seals under `FK'` is handed
 * the keys of the epochs its queue may still be sealed under. 5.5 already says the owner keeps
 * both keys until the switch is confirmed; this is the same window, on the receiving side.
 *
 * They are used for nothing else: no delivery is ever opened with one, because an envelope of a
 * retired epoch arriving from the server is the alarm of 3.4 and not an invitation to try an old
 * key on it.
 */
export interface RetiredEpochKey {
  readonly keyEpoch: number;
  readonly key: CryptoKey;
}

export interface SyncEngineOptions {
  readonly repository: IndexedDbBudgetRepository<SyncedBudgetState>;
  readonly transport: SyncTransport;
  readonly familyId: string;
  readonly deviceId: string;
  /** The key of the epoch this device has accepted, and that epoch's number. */
  readonly familyKey: CryptoKey;
  readonly keyEpoch: number;
  /** `SHA-256(FK)` in lower-case hex, as 5.4.1 has the device remember it. */
  readonly keyDigest: string;
  /** Keys of epochs already left, so what is queued under them can be moved to the epoch in hand. */
  readonly retiredKeys?: readonly RetiredEpochKey[];
  readonly fetchLimit?: number;
  readonly batchSize?: number;
  /**
   * `S_M` of 3.6: identifiers this device passed over through quarantine (3.4).
   *
   * Empty in this phase — nothing skips an envelope yet — and threaded all the same, because the
   * formula of 3.6 is symmetric in the two skip lists and a build that hard-coded one of them to
   * empty would have the other half of the symmetry written nowhere.
   */
  readonly skipped?: readonly string[];
  /**
   * `seq` numbers of the previous epoch still missing when it was carried across (5.5 step 2).
   *
   * They travel in the **first** checkpoint of this epoch and nowhere else: they are a fact about
   * the crossing, not about this device's set, and repeating them in every checkpoint would make
   * one loss look like a recurring one.
   */
  readonly inheritedGaps?: readonly number[];
  /** This device's clock, for the once-in-ten-minutes floor of 3.6. Injected so tests can move it. */
  readonly now?: () => number;
}

/** What one pass over the queue moved to the epoch in hand, and what it could not move. */
interface OutboxRekey {
  /**
   * Envelopes left sealed under an epoch whose key this device no longer holds.
   *
   * They are not sent — the server refuses a batch in which a single envelope names an epoch that
   * is not in force, and one of these in the batch would take every other envelope down with it —
   * and they are not deleted either, because a queue entry is a local change that has not reached
   * the family yet. They stay, they are counted, and the count travels out in {@link PushResult}.
   */
  readonly stranded: number;
  /** What may actually be submitted: the batch, entirely under the epoch in hand. */
  readonly envelopes: readonly OutgoingEnvelope[];
}

/** What this device knows about the integrity of its own journal — 3.6, for a screen to render. */
export interface CheckpointReport {
  /** The last divergence seen in the epoch this device holds, or `null` when the journals agree. */
  readonly alarm: CheckpointAlarm | null;
  /** Operations of this epoch read out of the journal — the number «у себя» a report shows. */
  readonly journalOpCount: number;
  /** How many checkpoints this device has written in this epoch. `0` before the first. */
  readonly ownIndex: number;
}

export interface EnqueueResult {
  readonly snapshot: JournalSnapshot;
  readonly revision: string;
  readonly queued: number;
}

/**
 * The anchor of 3.6 as it is stored: the set, the chain, the last alarm, and this device's own
 * position in its own chain.
 */
interface StoredAnchor {
  readonly keyEpoch: number;
  /** `M`, in journal order — see `ApplyDeliveryParams.journalOpIds` for why the order matters. */
  readonly opIds: readonly string[];
  readonly chain: readonly CheckpointLink[];
  readonly alarm: CheckpointAlarm | null;
  /** The last link this device wrote itself, or `null` before it has written any. */
  readonly own: OwnCheckpointChain | null;
  /** Operations folded out of the journal since the last checkpoint — the `200` of 3.6. */
  readonly sinceLast: number;
  /** This device's own clock when it last wrote one — the ten-minute floor of 3.6. */
  readonly writtenAt: number;
}

/** What this device needs to write the *next* link of its own chain. */
interface OwnCheckpointChain {
  /** The `index` of the last checkpoint written. The next one is this plus one. */
  readonly index: number;
  /** Its `digest`, which becomes the next one's `prevDigest`. */
  readonly digest: string;
}

const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

function anchorRefusal(): never {
  throw new SyncClientError("corrupt_sync_state", "the stored anchor is not an anchor");
}

function readAnchorOpIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_JOURNAL_OP_IDS) anchorRefusal();
  for (const item of value) {
    if (typeof item !== "string" || !IDENTIFIER.test(item)) anchorRefusal();
  }
  return value as readonly string[];
}

function readAnchorChain(value: unknown): readonly CheckpointLink[] {
  if (!Array.isArray(value)) anchorRefusal();
  const links: CheckpointLink[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) anchorRefusal();
    const link = item as Partial<CheckpointLink>;
    if (
      typeof link.deviceId !== "string" ||
      link.deviceId.length === 0 ||
      !Number.isSafeInteger(link.index) ||
      (link.index as number) < 1 ||
      typeof link.digest !== "string" ||
      !DIGEST.test(link.digest)
    ) {
      anchorRefusal();
    }
    links.push({ deviceId: link.deviceId, index: link.index as number, digest: link.digest });
  }
  return links;
}

function readAnchorAlarm(value: unknown): CheckpointAlarm | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") anchorRefusal();
  const alarm = value as Partial<CheckpointAlarm>;
  const counts = [
    alarm.seq,
    alarm.index,
    alarm.ownCount,
    alarm.checkpointCount,
    alarm.missingHere,
    alarm.missingThere,
  ];
  if (
    typeof alarm.reason !== "string" ||
    !(CHECKPOINT_ALARM_REASONS as readonly string[]).includes(alarm.reason) ||
    typeof alarm.deviceId !== "string" ||
    alarm.deviceId.length === 0 ||
    counts.some((count) => !Number.isSafeInteger(count) || (count as number) < 0) ||
    !Array.isArray(alarm.examples) ||
    alarm.examples.some((example) => typeof example !== "string")
  ) {
    anchorRefusal();
  }
  return alarm as CheckpointAlarm;
}

function readAnchorOwn(value: unknown): OwnCheckpointChain | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") anchorRefusal();
  const own = value as Partial<OwnCheckpointChain>;
  if (
    !Number.isSafeInteger(own.index) ||
    (own.index as number) < 1 ||
    typeof own.digest !== "string" ||
    !DIGEST.test(own.digest)
  ) {
    anchorRefusal();
  }
  return { index: own.index as number, digest: own.digest };
}

function readAnchorCount(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) anchorRefusal();
  return value as number;
}

/** The anchor as it is written down: plain data, copied out of whatever built it. */
function serializeAnchor(anchor: StoredAnchor): unknown {
  return {
    keyEpoch: anchor.keyEpoch,
    opIds: [...anchor.opIds],
    chain: anchor.chain.map((link) => ({ ...link })),
    alarm: anchor.alarm === null ? null : { ...anchor.alarm, examples: [...anchor.alarm.examples] },
    own: anchor.own === null ? null : { ...anchor.own },
    sinceLast: anchor.sinceLast,
    writtenAt: anchor.writtenAt,
  };
}

interface StoredJournal {
  readonly entries: unknown;
  readonly activations: unknown;
  readonly appliedOpIds: unknown;
  readonly lamport: number;
}

/**
 * What of a snapshot is written down.
 *
 * Only the four fields `restoreJournal` reads. `state`, `integrity` and `entries` each cost a
 * full pass over the journal on first read, and `structuredClone` would have evaluated all three
 * on every save — so the record is built by hand, once, from the two that are actually needed.
 */
function serializeJournal(snapshot: JournalSnapshot): StoredJournal {
  return {
    entries: snapshot.entries.map((entry) => ({ ...entry })),
    activations: snapshot.activations.map((entry) => ({ ...entry })),
    appliedOpIds: [...snapshot.appliedOpIds],
    lamport: snapshot.lamport,
  };
}

export class SyncEngine {
  private readonly repository: IndexedDbBudgetRepository<SyncedBudgetState>;
  private readonly transport: SyncTransport;
  private readonly familyId: string;
  private readonly deviceId: string;
  private readonly familyKey: CryptoKey;
  private readonly keyEpoch: number;
  private readonly keyDigest: string;
  private readonly retiredKeys: ReadonlyMap<number, CryptoKey>;
  private readonly fetchLimit: number;
  private readonly batchSize: number;
  private readonly skipped: readonly string[];
  private readonly inheritedGaps: readonly number[];
  private readonly now: () => number;

  constructor(options: SyncEngineOptions) {
    this.repository = options.repository;
    this.transport = options.transport;
    this.familyId = options.familyId;
    this.deviceId = options.deviceId;
    this.familyKey = options.familyKey;
    this.keyEpoch = options.keyEpoch;
    this.keyDigest = options.keyDigest;
    this.retiredKeys = new Map(
      (options.retiredKeys ?? [])
        .filter((retired) => retired.keyEpoch !== options.keyEpoch)
        .map((retired) => [retired.keyEpoch, retired.key] as const),
    );
    this.fetchLimit = options.fetchLimit ?? FETCH_LIMIT;
    this.batchSize = options.batchSize ?? SUBMIT_BATCH_SIZE;
    // Sorted here rather than trusted sorted: both lists go into a checkpoint record, and the
    // record's contract is that they arrive sorted and without repetition.
    this.skipped = [...new Set(options.skipped ?? [])].sort();
    this.inheritedGaps = [...new Set(options.inheritedGaps ?? [])].sort((a, b) => a - b);
    this.now = options.now ?? (() => Date.now());
  }

  private async readJournal(): Promise<JournalSnapshot> {
    const stored = await this.repository.readSyncState(SYNC_STATE_KEYS.journal);
    if (stored === undefined || stored === null) return createEmptyJournal();
    try {
      return restoreJournal(stored);
    } catch {
      // A snapshot this build wrote always restores. One that does not was written by something
      // else, and guessing at it would put an invented budget on the family's screen.
      throw new SyncClientError("corrupt_sync_state", "the stored journal cannot be restored");
    }
  }

  /** The cursor as the store holds it, checked but not yet measured against the epoch held. */
  private async storedCursor(): Promise<SyncCursor> {
    const stored = await this.repository.readSyncState(SYNC_STATE_KEYS.cursor);
    if (stored === undefined || stored === null) return { keyEpoch: this.keyEpoch, seq: 0 };
    const record = stored as Partial<SyncCursor>;
    if (
      !Number.isSafeInteger(record.keyEpoch) ||
      (record.keyEpoch as number) < 1 ||
      !Number.isSafeInteger(record.seq) ||
      (record.seq as number) < 0
    ) {
      throw new SyncClientError("corrupt_sync_state", "the stored cursor is not a cursor");
    }
    return { keyEpoch: record.keyEpoch as number, seq: record.seq as number };
  }

  /**
   * The barrier of 5.5 step 8, and the only place where two epoch numbers are allowed to meet.
   *
   * Everything else in this class names `this.keyEpoch` — the epoch of the key the engine was
   * constructed with, which is the key its envelopes are sealed under and the key its deliveries
   * are opened with. The store may still hold a cursor of the epoch before it, and that is not an
   * error: it is what a rotation leaves behind. The journal of the retired epoch was deleted by
   * the server (5.5 step 7), so there is nothing to continue and the cursor starts again at `0`.
   *
   * The other direction is not a rotation and never becomes one. A cursor further ahead than the
   * key this device holds would have the engine re-read a journal it has already passed under a
   * key that cannot open it — every envelope failing its tag, and the alarm of 3.4 raised on a
   * state error. It is refused by name instead.
   */
  private resolveCursor(stored: SyncCursor): SyncCursor {
    if (stored.keyEpoch === this.keyEpoch) return stored;
    if (stored.keyEpoch > this.keyEpoch) {
      throw new SyncClientError(
        "epoch_conflict",
        "the stored cursor names a later key epoch than the key this device holds",
      );
    }
    return { keyEpoch: this.keyEpoch, seq: 0 };
  }

  async readCursor(): Promise<SyncCursor> {
    return this.resolveCursor(await this.storedCursor());
  }

  /**
   * The alarm state, read back with the same suspicion as the cursor.
   *
   * `attempts` is compared against the threshold of 3.4 and `reason` selects the message: a record
   * that came back with a string where the counter was, or with a reason no branch of this build
   * knows, would turn a comparison into `"9" >= 10` and a screen into a blank.
   */
  async readStop(): Promise<SyncStop | null> {
    const stored = await this.repository.readSyncState(SYNC_STATE_KEYS.stop);
    if (stored === undefined || stored === null) return null;
    const record = stored as Partial<SyncStop>;
    if (
      typeof record.reason !== "string" ||
      !(SYNC_STOP_REASONS as readonly string[]).includes(record.reason) ||
      !Number.isSafeInteger(record.seq) ||
      (record.seq as number) < 0 ||
      typeof record.opId !== "string" ||
      record.opId.length === 0 ||
      !Number.isSafeInteger(record.attempts) ||
      (record.attempts as number) < 0
    ) {
      throw new SyncClientError("corrupt_sync_state", "the stored stop is not a stop");
    }
    return {
      reason: record.reason as SyncStopReason,
      seq: record.seq as number,
      opId: record.opId,
      attempts: record.attempts as number,
    };
  }

  /**
   * The epoch this device has accepted, measured against the epoch it actually holds.
   *
   * Three cases and no fourth. The record names the epoch held — it is returned as written, and
   * its `live` is the proof of 5.4.1. It names an *earlier* one — the rotation has already been
   * accepted by 5.4 elsewhere, so the record is superseded by the epoch in hand, which is not
   * live until this device's own envelope comes back numbered *in it*. It names a later one, or
   * the same one under a different key digest — the first is the step down 5.4.1 refuses outright
   * and the second is the substitution the whole of 5.4.1 exists to catch. Both are refused here,
   * loudly and by their own name, rather than left to surface as an alarm about somebody's key.
   */
  async readEpoch(): Promise<AcceptedEpoch> {
    const held: AcceptedEpoch = {
      keyEpoch: this.keyEpoch,
      keyDigest: this.keyDigest,
      live: false,
    };
    const stored = await this.repository.readSyncState(SYNC_STATE_KEYS.epoch);
    if (stored === undefined || stored === null) return held;
    const record = stored as Partial<AcceptedEpoch>;
    if (
      !Number.isSafeInteger(record.keyEpoch) ||
      (record.keyEpoch as number) < 1 ||
      typeof record.keyDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.keyDigest) ||
      typeof record.live !== "boolean"
    ) {
      throw new SyncClientError("corrupt_sync_state", "the stored epoch is not an epoch");
    }
    const keyEpoch = record.keyEpoch as number;
    if (keyEpoch > this.keyEpoch) {
      throw new SyncClientError(
        "epoch_conflict",
        "the stored epoch is later than the key this device holds",
      );
    }
    if (keyEpoch < this.keyEpoch) return held;
    if (record.keyDigest !== this.keyDigest) {
      throw new SyncClientError(
        "epoch_conflict",
        "the stored epoch holds the same number under another key",
      );
    }
    return { keyEpoch, keyDigest: record.keyDigest, live: record.live };
  }

  /**
   * The anchor record of 3.6, read back with the same suspicion as the cursor.
   *
   * A record of another epoch is not an error and is not migrated: both digests of 3.6 are bound
   * to the epoch number, so nothing in it survives a rotation, and the fresh value returned here
   * is what makes the new epoch's chains start at `1`.
   */
  private async readAnchor(): Promise<StoredAnchor> {
    const fresh: StoredAnchor = {
      keyEpoch: this.keyEpoch,
      opIds: [],
      chain: [],
      alarm: null,
      own: null,
      sinceLast: 0,
      writtenAt: 0,
    };
    const stored = await this.repository.readSyncState(SYNC_STATE_KEYS.anchor);
    if (stored === undefined || stored === null) return fresh;
    const record = stored as Partial<StoredAnchor>;
    if (!Number.isSafeInteger(record.keyEpoch) || (record.keyEpoch as number) < 1) {
      throw new SyncClientError("corrupt_sync_state", "the stored anchor is not an anchor");
    }
    if (record.keyEpoch !== this.keyEpoch) return fresh;
    const opIds = readAnchorOpIds(record.opIds);
    const chain = readAnchorChain(record.chain);
    return {
      keyEpoch: this.keyEpoch,
      opIds,
      chain,
      alarm: readAnchorAlarm(record.alarm),
      own: readAnchorOwn(record.own),
      sinceLast: readAnchorCount(record.sinceLast),
      writtenAt: readAnchorCount(record.writtenAt),
    };
  }

  /**
   * What the anchor of 3.6 has to say, for the «Семья» screen.
   *
   * Separate from {@link status} rather than folded into it: the alarm belongs to one screen and
   * one section, and a caller that only wants to know whether the queue is draining should not
   * have to read a set of a hundred thousand identifiers to find out.
   */
  async readCheckpointReport(): Promise<CheckpointReport> {
    // A record of a retired epoch comes back empty from `readAnchor`, because a checkpoint of an
    // epoch that no longer exists is about a set that no longer exists.
    const anchor = await this.readAnchor();
    return {
      alarm: anchor.alarm,
      journalOpCount: anchor.opIds.length,
      ownIndex: anchor.own === null ? 0 : anchor.own.index,
    };
  }

  async status(): Promise<SyncStatusReport> {
    const stored = await this.storedCursor();
    const cursor = this.resolveCursor(stored);
    return {
      cursor,
      queued: await this.repository.countOutbox(),
      epoch: await this.readEpoch(),
      // The stop names an envelope of the cursor's epoch. When a rotation has left that cursor
      // behind, the envelope went with the journal it belonged to (5.5 step 7) and the alarm is
      // no longer about anything; `pull()` erases the record itself on its next run.
      stop: stored.keyEpoch === cursor.keyEpoch ? await this.readStop() : null,
    };
  }

  private outgoing(operation: Operation, ciphertext: Uint8Array, iv: Uint8Array): OutgoingEnvelope {
    return {
      envelopeVersion: ENVELOPE_VERSION,
      kind: "operation",
      familyId: this.familyId,
      opId: operation.opId,
      deviceId: operation.deviceId,
      keyEpoch: this.keyEpoch,
      iv: toBase64(iv),
      ciphertext: toBase64(ciphertext),
    };
  }

  /**
   * 3.1, all eight steps.
   *
   * The stamp, the identifier, the canonical text, the wire limits and the sealing all happen
   * before the transaction opens — step 5 says an operation that fails a limit is not created at
   * all, and a limit checked inside the transaction would already have written half of it.
   */
  async enqueue(drafts: readonly OperationDraft[]): Promise<EnqueueResult> {
    if (drafts.length === 0) throw new SyncClientError("corrupt_sync_state", "nothing to enqueue");
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const document = await this.repository.loadVersioned();
      const journal = await this.readJournal();

      let clock = createClock(this.deviceId, journal.lamport);
      const operations: Operation[] = [];
      for (const draft of drafts) {
        const local = createLocalOperation(clock, draft);
        clock = local.clock;
        operations.push(local.operation);
      }

      const appends: OutboxAppend[] = [];
      for (const operation of operations) {
        // Throws before anything is written when the operation is over 8 KiB or otherwise
        // outside the wire limits of 3.2 — step 5.
        const text = encodeOperation(operation);
        const sealed = await sealEnvelope(
          this.familyKey,
          {
            envelopeVersion: ENVELOPE_VERSION,
            kind: "operation",
            familyId: this.familyId,
            opId: operation.opId,
            deviceId: operation.deviceId,
            keyEpoch: this.keyEpoch,
          },
          utf8(text),
        );
        appends.push({
          opId: operation.opId,
          envelope: this.outgoing(operation, sealed.ciphertext, sealed.iv),
        });
      }

      const snapshot = applyOperations(journal, operations);
      const commit = await this.commit(document, snapshot, appends, [
        { key: SYNC_STATE_KEYS.journal, value: serializeJournal(snapshot) },
      ]);
      if (commit.status === "saved") {
        return { snapshot, revision: commit.revision, queued: appends.length };
      }
      // Somebody else wrote in between — a delivery being applied, or another tab. The drafts are
      // stamped again on the newer journal rather than forced onto a state they never saw.
    }
    throw new SyncClientError("write_conflict", "the local write lost its revision check");
  }

  /**
   * One write of everything a step produced.
   *
   * The materialised state is only handed to the document when the integrity gate says it can be
   * shown. When it cannot — no active budget, or one the journal does not hold — the document
   * keeps the last state that could, exactly as decision 19 asks, and the journal is still saved
   * so the missing operation repairs it when it arrives.
   */
  private async commit(
    document: { readonly value: SyncedBudgetState; readonly revision: string } | null,
    snapshot: JournalSnapshot,
    outbox: readonly OutboxAppend[],
    syncState: readonly { readonly key: string; readonly value: unknown }[],
  ): Promise<SaveIfRevisionResult<SyncedBudgetState>> {
    const value =
      snapshot.integrity.ready || document === null ? snapshot.state : document.value;
    return this.repository.commitWithSync({
      expectedRevision: document?.revision ?? null,
      value,
      outbox,
      syncState,
    });
  }

  /** A queue record as it was written, or `null` when it is not the shape this build writes. */
  private static queuedEnvelope(value: unknown): OutgoingEnvelope | null {
    if (typeof value !== "object" || value === null) return null;
    const record = value as Partial<OutgoingEnvelope>;
    if (
      !Number.isSafeInteger(record.envelopeVersion) ||
      typeof record.kind !== "string" ||
      typeof record.familyId !== "string" ||
      typeof record.opId !== "string" ||
      record.opId.length === 0 ||
      record.opId.length > 128 ||
      typeof record.deviceId !== "string" ||
      !Number.isSafeInteger(record.keyEpoch) ||
      (record.keyEpoch as number) < 1 ||
      typeof record.iv !== "string" ||
      typeof record.ciphertext !== "string"
    ) {
      return null;
    }
    return record as OutgoingEnvelope;
  }

  /**
   * Moves one queued envelope from a retired epoch to the epoch in hand — 5.5 step 8.
   *
   * The plaintext is carried across as bytes and is never re-encoded: `opId` and `lamport` live
   * inside it, and the merge tiebreaker is computed over that exact text, so a re-serialisation
   * would change what the family already agreed on. What does change is what step 8 names — a
   * fresh IV, the new epoch number, and the tag that binds them.
   *
   * `null` when the envelope will not open under the key offered, which is not a case to guess
   * at: an entry this device sealed itself and can no longer read is left where it is.
   */
  private async reseal(
    envelope: OutgoingEnvelope,
    retired: CryptoKey,
  ): Promise<OutgoingEnvelope | null> {
    const iv = fromBase64(envelope.iv);
    const ciphertext = fromBase64(envelope.ciphertext);
    if (iv === null || ciphertext === null) return null;
    let plaintext: Uint8Array;
    try {
      plaintext = await openEnvelope(retired, {
        envelopeVersion: envelope.envelopeVersion,
        kind: envelope.kind,
        familyId: envelope.familyId,
        opId: envelope.opId,
        deviceId: envelope.deviceId,
        keyEpoch: envelope.keyEpoch,
        iv,
        ciphertext,
      });
    } catch {
      return null;
    }
    const header = {
      envelopeVersion: envelope.envelopeVersion,
      kind: envelope.kind,
      familyId: envelope.familyId,
      opId: envelope.opId,
      deviceId: envelope.deviceId,
      keyEpoch: this.keyEpoch,
    };
    const sealed = await sealEnvelope(this.familyKey, header, plaintext);
    return { ...header, iv: toBase64(sealed.iv), ciphertext: toBase64(sealed.ciphertext) };
  }

  /**
   * Swaps re-encrypted envelopes in for the ones they replace, without a window in which neither
   * exists.
   *
   * The order is the whole point. The new envelopes are written to {@link SYNC_STATE_KEYS.rekey}
   * first, so from that moment on every operation exists either in the queue or in that record or
   * in both; the old records are removed next; the new ones are added and the record cleared in
   * one transaction. A crash anywhere leaves the record behind, and the next run finishes the
   * same rewrite — adding an envelope whose identifier is already in the queue is a no-op, so
   * finishing it twice costs nothing.
   */
  private async rewriteOutbox(appends: readonly OutboxAppend[]): Promise<void> {
    // The removal, and not a confirmation: `confirmOutbox` is how a record leaves the queue, and
    // the record leaving here is being replaced in the same breath rather than sent. Nothing about
    // 3.3 is weakened by that — no envelope is dropped without a `seq`, one is swapped for the
    // same operation under a new key.
    await this.repository.confirmOutbox(appends.map((append) => append.opId));
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const document = await this.repository.loadVersioned();
      const commit = await this.repository.commitWithSync({
        expectedRevision: document?.revision ?? null,
        // The document is not what changed here — only the queue is — so it is written back as it
        // was found. A device with a queue always has a document (3.1 step 7 writes both), and the
        // journal answers for the case that cannot happen rather than leaving it to `null`.
        value: document?.value ?? (await this.readJournal()).state,
        outbox: appends,
        syncState: [{ key: SYNC_STATE_KEYS.rekey, value: null }],
      });
      if (commit.status === "saved") return;
    }
    throw new SyncClientError("write_conflict", "the re-encrypted queue lost its revision check");
  }

  /** Finishes a rewrite that a crash interrupted, whatever epoch it was going to. */
  private async resumeRekey(): Promise<void> {
    const stored = await this.repository.readSyncState(SYNC_STATE_KEYS.rekey);
    if (stored === undefined || stored === null) return;
    const record = stored as { readonly envelopes?: unknown };
    if (!Array.isArray(record.envelopes)) {
      throw new SyncClientError("corrupt_sync_state", "the stored re-encryption is not a queue");
    }
    const appends: OutboxAppend[] = [];
    for (const value of record.envelopes) {
      const envelope = SyncEngine.queuedEnvelope(value);
      if (envelope === null) {
        throw new SyncClientError("corrupt_sync_state", "the stored re-encryption is not a queue");
      }
      appends.push({ opId: envelope.opId, envelope });
    }
    // Restored even when it names an epoch this device has since left again: the record may be the
    // only copy of those operations, and putting them back is what lets the pass below move them
    // on to the epoch actually in hand.
    if (appends.length > 0) await this.rewriteOutbox(appends);
    else await this.repository.writeSyncState([{ key: SYNC_STATE_KEYS.rekey, value: null }]);
  }

  /**
   * 5.5 step 8, first half: the queue is moved to the epoch in hand before anything is sent.
   *
   * Without it a device that had anything queued at the moment of a rotation is finished: the
   * server refuses a whole batch in which one envelope names an epoch not in force, so the queue
   * never drains, everything written afterwards waits behind it, no envelope of the new epoch is
   * ever numbered — and the new epoch, never having been proven live, does not let the old key be
   * forgotten either.
   */
  private async rekeyOutbox(limit?: number): Promise<OutboxRekey> {
    await this.resumeRekey();
    const queued: readonly OutboxRecord[] = await this.repository.listOutbox(limit);
    const envelopes: OutgoingEnvelope[] = [];
    const appends: OutboxAppend[] = [];
    let stranded = 0;
    for (const record of queued) {
      const envelope = SyncEngine.queuedEnvelope(record.envelope);
      if (envelope === null) {
        throw new SyncClientError("corrupt_sync_state", "a queued envelope is not an envelope");
      }
      if (envelope.keyEpoch === this.keyEpoch) {
        envelopes.push(envelope);
        continue;
      }
      const retired = this.retiredKeys.get(envelope.keyEpoch);
      const resealed = retired === undefined ? null : await this.reseal(envelope, retired);
      if (resealed === null) {
        stranded += 1;
        continue;
      }
      appends.push({ opId: resealed.opId, envelope: resealed });
      envelopes.push(resealed);
    }
    if (appends.length > 0) await this.rewriteOutbox(appends);
    return { stranded, envelopes };
  }

  /**
   * Sends what is queued and removes exactly what the server numbered.
   *
   * A refusal propagates untouched and the queue survives it: `409 epoch_mismatch`,
   * `409 rotation_in_progress` and a cut cable all leave the same twenty envelopes in the same
   * order, which is what makes them arrive once and only once when the link comes back.
   */
  async push(): Promise<PushResult> {
    // Everything about to be submitted is under the epoch this engine seals with, because that is
    // what the pass above guarantees: what could be moved was moved, and what could not is not in
    // the batch. So a number coming back is a number given to an envelope of *this* epoch, which
    // is exactly what 5.4.1 asks liveness to be.
    const prepared = await this.rekeyOutbox(this.batchSize);
    const envelopes = prepared.envelopes;
    if (envelopes.length === 0) {
      return {
        confirmed: 0,
        pending: await this.repository.countOutbox(),
        stranded: prepared.stranded,
      };
    }

    const sent = new Set(envelopes.map((envelope) => envelope.opId));
    const answer = await this.transport.submit(this.familyId, envelopes);

    // Only identifiers this device actually sent in *this* batch, and only with a number that can
    // be a `seq`. A server that answered with somebody else's identifier, with one this device is
    // holding back for a later batch, or with `seq: 0`, would otherwise be able to empty a queue
    // it never accepted anything from.
    const confirmable = answer.accepted
      .filter((entry) => sent.has(entry.opId) && Number.isSafeInteger(entry.seq) && entry.seq > 0)
      .map((entry) => entry.opId);
    const confirmed = await this.repository.confirmOutbox(confirmable);

    if (confirmed > 0) {
      // The mark is written for the epoch this engine seals under, addressed by number and by
      // digest rather than copied from whatever the record on disk happened to hold.
      const epoch = await this.readEpoch();
      if (!epoch.live) {
        await this.repository.writeSyncState([
          {
            key: SYNC_STATE_KEYS.epoch,
            value: { keyEpoch: this.keyEpoch, keyDigest: this.keyDigest, live: true },
          },
        ]);
      }
    }

    return {
      confirmed,
      pending: await this.repository.countOutbox(),
      stranded: prepared.stranded,
    };
  }

  /**
   * Crosses the epoch barrier — 5.5 step 8, both halves — before the first request of a pull.
   *
   * «Затем перешифровывает непустую исходящую очередь под `FK'` с новыми `iv` и `keyEpoch'`,
   * сохраняя `opId` и `lamport`, сбрасывает курсор на `(keyEpoch', 0)` и заново проходит журнал»:
   * the queue moves first, then the cursor. The retired epoch's envelopes were destroyed with it,
   * its numbering has nothing to do with the new one, and the alarm that stood against one of its
   * envelopes is about an envelope that no longer exists — so cursor, alarm and epoch record are
   * rewritten in one write and before the first request, and a device interrupted between the
   * reset and the first page does not come back and walk the new journal from a number of the old
   * one.
   *
   * What this is *not* is a way into a new epoch. The key was accepted before this engine was
   * built — by the chain of 5.4 or by a ceremony a person ran — and no answer of the server takes
   * part in the decision. This function reacts to the key the engine already holds.
   */
  private async openEpoch(): Promise<{
    readonly cursor: SyncCursor;
    readonly stop: SyncStop | null;
  }> {
    const stored = await this.storedCursor();
    // Before anything is written: a cursor ahead of the key in hand is a step down, and a state
    // this broken is not a rotation to be tidied up after.
    const cursor = this.resolveCursor(stored);

    // The queue is asked about itself rather than deduced from the cursor. A device that wrote
    // something and never pulled has no cursor record at all, and its queue would otherwise stay
    // sealed under the epoch it was written in for ever. One record answers the question: the
    // queue is in insertion order and the epoch a device seals under only rises, so a head under
    // the epoch in hand has nothing retired behind it. `push` re-encrypts every batch it takes,
    // which is what covers the one case this probe cannot see — a second, stale tab appending
    // behind a head this engine already moved.
    await this.resumeRekey();
    const head = await this.repository.listOutbox(1);
    const first = head.length === 0 ? null : SyncEngine.queuedEnvelope(head[0]!.envelope);
    if (head.length > 0 && (first === null || first.keyEpoch !== this.keyEpoch)) {
      // The whole queue, not one batch: this is the moment the rotation is being crossed, and the
      // order of what is waiting is kept by moving all of it at once.
      await this.rekeyOutbox();
    }

    if (stored.keyEpoch === cursor.keyEpoch) return { cursor, stop: await this.readStop() };
    // `readEpoch` carries the liveness proof over when it has already been earned in this epoch,
    // and refuses the two states that are not a rotation at all.
    const epoch = await this.readEpoch();
    await this.repository.writeSyncState([
      { key: SYNC_STATE_KEYS.cursor, value: { ...cursor } },
      { key: SYNC_STATE_KEYS.stop, value: null },
      { key: SYNC_STATE_KEYS.epoch, value: { ...epoch } },
      // The anchor goes with them. Its set, its chains and its alarm were all about the epoch
      // that has just been left, and 3.6 binds every one of those values to the epoch number.
      { key: SYNC_STATE_KEYS.anchor, value: null },
    ]);
    return { cursor, stop: null };
  }

  /**
   * Pulls everything after the cursor and folds it — 3.4.
   *
   * The end of the journal is decided here and not by the server: a page shorter than the limit
   * this build asked for, or a page with nothing new in it, ends the walk. `hasMore` is carried
   * through the transport and never acted on, because a server that left it `true` for ever would
   * otherwise hold every device in a fetch loop for nothing.
   */
  async pull(): Promise<PullResult> {
    let requests = 0;
    let applied = 0;
    let checkpoints = 0;
    let compared = 0;
    const opened = await this.openEpoch();
    let cursor = opened.cursor;
    let stop: SyncStop | null = null;
    let pageLimitReached = false;
    const notices: PullResult["notices"][number][] = [];
    let priorStop = opened.stop;
    // Read after `openEpoch`, which is where a rotation clears it.
    let anchor = await this.readAnchor();
    const alarms: CheckpointAlarm[] = [];

    for (let page = 0; page < MAX_PAGES_PER_PULL; page += 1) {
      const answer = await this.transport.fetch(this.familyId, {
        // The epoch of the key in hand, the same one `applyDelivery` measures the delivery
        // against below. The cursor contributes the number it is the cursor of, and nothing else.
        keyEpoch: this.keyEpoch,
        after: cursor.seq,
        limit: this.fetchLimit,
      });
      requests += 1;
      if (answer.envelopes.length === 0) break;

      let written = false;
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS && !written; attempt += 1) {
        const document = await this.repository.loadVersioned();
        const journal = await this.readJournal();
        const result = await applyDelivery({
          envelopes: answer.envelopes,
          cursor,
          acceptedEpoch: this.keyEpoch,
          familyKey: this.familyKey,
          familyId: this.familyId,
          deviceId: this.deviceId,
          snapshot: journal,
          priorStop,
          journalOpIds: anchor.opIds,
          chain: anchor.chain,
          skipped: this.skipped,
        });
        // What the delivery made of the anchor, kept in one place so that both branches of the
        // write below and the accounting after it name the same value.
        const folded: StoredAnchor = {
          keyEpoch: this.keyEpoch,
          opIds: result.journalOpIds,
          chain: result.chain,
          // The latest verdict and not a sticky flag: 3.6 has the warning describe the state of
          // the journals now. A device that diverged, was rebuilt by hand and then received a
          // checkpoint that agrees is a device whose journals agree, and a flag that could only
          // ever be set would tell it otherwise for ever. A delivery that measured nothing —
          // operations only, or none but this device's own checkpoints — decides nothing either
          // way and leaves the previous verdict standing.
          alarm:
            result.alarms.length > 0
              ? result.alarms[result.alarms.length - 1]!
              : result.compared > 0
                ? null
                : anchor.alarm,
          own: anchor.own,
          sinceLast: anchor.sinceLast + result.applied,
          writtenAt: anchor.writtenAt,
        };
        const anchorEntry = { key: SYNC_STATE_KEYS.anchor, value: serializeAnchor(folded) };

        if (result.applied === 0 && result.checkpoints === 0) {
          // Nothing was folded, so neither the journal nor the cursor moved and the document
          // cannot have changed. Writing it anyway would have created an empty budget on a device
          // whose very first delivery was refused — which is precisely the case an alarm covers.
          //
          // The cursor is written all the same, at the value it already has. The stop names an
          // envelope, an envelope belongs to an epoch, and the cursor beside it is what records
          // which one: without it, a device whose *first* delivery raised the alarm would carry
          // that alarm across a rotation with nothing to date it by.
          await this.repository.writeSyncState([
            { key: SYNC_STATE_KEYS.cursor, value: { ...result.cursor } },
            { key: SYNC_STATE_KEYS.stop, value: result.stop === null ? null : { ...result.stop } },
            anchorEntry,
          ]);
        } else {
          const commit = await this.commit(
            document,
            result.snapshot,
            [],
            [
              { key: SYNC_STATE_KEYS.journal, value: serializeJournal(result.snapshot) },
              { key: SYNC_STATE_KEYS.cursor, value: { ...result.cursor } },
              { key: SYNC_STATE_KEYS.stop, value: result.stop === null ? null : { ...result.stop } },
              anchorEntry,
            ],
          );
          if (commit.status !== "saved") continue;
        }

        written = true;
        cursor = result.cursor;
        applied += result.applied;
        checkpoints += result.checkpoints;
        compared += result.compared;
        notices.push(...result.notices);
        alarms.push(...result.alarms);
        anchor = folded;
        stop = result.stop;
        priorStop = result.stop;
      }
      if (!written) throw new SyncClientError("write_conflict", "the delivery lost its revision check");
      if (stop !== null) break;
      // The client's own end-of-journal test (3.6). A short page is the end of what the server
      // holds; anything else would be trusting `hasMore`.
      if (answer.envelopes.length < this.fetchLimit) break;
      // A full page on the last iteration means the walk ran out of this call's budget, not that
      // the journal ended. The two ask for different things from the caller — one is "done", the
      // other is "call again" — so they are not returned as the same silence.
      pageLimitReached = page === MAX_PAGES_PER_PULL - 1;
    }

    return {
      cursor,
      applied,
      checkpoints,
      compared,
      notices,
      alarms,
      stop,
      requests,
      pageLimitReached,
    };
  }

  /**
   * Writes this device's own checkpoint — the anchor of 3.6, from the writing side.
   *
   * Returns whether one was written. The two rules of 3.6 are both here and neither of them is a
   * number anybody else supplies: `200` operations folded out of the journal, or a caller saying
   * "now" (the transition to the background, which only the application can see), and never more
   * often than once in ten minutes.
   *
   * `force` lifts the count and not the floor. It is the background transition of 3.6, and a
   * checkpoint written on every such transition without a floor would be a device that leaves and
   * returns to the foreground writing an envelope a second.
   *
   * The set is `M` — the operations of this epoch this device has read out of the journal, and
   * only those. 3.6 is explicit that envelopes still sitting in the outgoing queue stay out: a
   * device that spent an evening offline would otherwise announce a checkpoint over operations
   * the rest of the family does not physically have, and raise a divergence about itself.
   */
  async writeCheckpoint(options: { readonly force?: boolean } = {}): Promise<boolean> {
    const anchor = await this.readAnchor();
    const now = this.now();
    // Nothing new to anchor. A second checkpoint over the same set would spend an envelope and a
    // chain index to repeat a value the family already has.
    if (anchor.sinceLast === 0) return false;
    if (!(options.force ?? false) && anchor.sinceLast < CHECKPOINT_EVERY_OPERATIONS) return false;
    if (anchor.own !== null && now - anchor.writtenAt < CHECKPOINT_MIN_INTERVAL_MS) return false;

    const skipped = new Set(this.skipped);
    const mine = anchor.opIds.filter((opId) => !skipped.has(opId));
    const index = anchor.own === null ? 1 : anchor.own.index + 1;
    const prevDigest =
      anchor.own === null
        ? toHex(
            await checkpointSeedDigest({
              familyId: this.familyId,
              keyEpoch: this.keyEpoch,
              deviceId: this.deviceId,
            }),
          )
        : anchor.own.digest;
    const digest = toHex(
      await checkpointDigest({ familyId: this.familyId, keyEpoch: this.keyEpoch, opIds: mine }),
    );
    const record = encodeCheckpointRecord({
      index,
      opCount: mine.length,
      skipped: this.skipped,
      // 5.5 step 2 puts what the crossing lost into the **first** checkpoint of the new epoch.
      inheritedGaps: index === 1 ? this.inheritedGaps : [],
      prevDigest,
      digest,
    });

    const opId = crypto.randomUUID();
    const header = {
      envelopeVersion: ENVELOPE_VERSION,
      kind: "checkpoint" as const,
      familyId: this.familyId,
      opId,
      deviceId: this.deviceId,
      keyEpoch: this.keyEpoch,
    };
    const sealed = await sealEnvelope(this.familyKey, header, utf8(record));
    const append: OutboxAppend = {
      opId,
      envelope: { ...header, iv: toBase64(sealed.iv), ciphertext: toBase64(sealed.ciphertext) },
    };

    // The queue entry and this device's new place in its own chain go into one transaction. Split
    // apart, a crash between them would either spend an index on an envelope that was never
    // queued — leaving a permanent gap in this device's own chain, which every other device reads
    // as the server having deleted a checkpoint — or queue a checkpoint whose index the next one
    // would claim again.
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const document = await this.repository.loadVersioned();
      const commit = await this.repository.commitWithSync({
        expectedRevision: document?.revision ?? null,
        // A checkpoint changes nothing in the budget, so the document is written back as found.
        value: document?.value ?? (await this.readJournal()).state,
        outbox: [append],
        syncState: [
          {
            key: SYNC_STATE_KEYS.anchor,
            value: serializeAnchor({
              ...anchor,
              own: { index, digest },
              sinceLast: 0,
              writtenAt: now,
            }),
          },
        ],
      });
      if (commit.status === "saved") return true;
    }
    throw new SyncClientError("write_conflict", "the checkpoint lost its revision check");
  }

  /**
   * 3.4: the poll follows a successful submission, so this device sees its own `seq` at once.
   *
   * The anchor is written at the end, when the delivery has been folded and the count of 3.6 is
   * up to date. It leaves with the next push: a checkpoint is an ordinary envelope and waits in
   * the queue like any other.
   */
  async sync(): Promise<{ readonly push: PushResult; readonly pull: PullResult }> {
    const pushed = await this.push();
    const pulled = await this.pull();
    await this.writeCheckpoint();
    return { push: pushed, pull: pulled };
  }
}
