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
 * And one property from section 9, which is a property of what this file does *not* do: nothing
 * here runs until an account exists. The engine is constructed after sign-in, so with no account
 * there is no queue, no cursor and not one request.
 */
import {
  type IndexedDbBudgetRepository,
  type OutboxAppend,
  type SaveIfRevisionResult,
} from "@family-budget/storage";
import { ENVELOPE_VERSION, sealEnvelope, utf8 } from "@family-budget/sync-crypto";
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

import { toBase64 } from "./base64.js";
import { SyncClientError } from "./errors.js";
import { applyDelivery } from "./intake.js";
import type { SyncTransport } from "./transport.js";
import type {
  AcceptedEpoch,
  OutgoingEnvelope,
  PullResult,
  PushResult,
  SyncCursor,
  SyncStatusReport,
  SyncStop,
} from "./types.js";

/** Names of the records this engine keeps in the sync store. */
export const SYNC_STATE_KEYS = {
  journal: "journal",
  cursor: "cursor",
  epoch: "epoch",
  stop: "stop",
} as const;

/**
 * How many envelopes one fetch asks for, and how many one submission carries.
 *
 * Both are constants of this build. The fetch size in particular is never taken from a response:
 * a limit derived from something the other side writes is a limit the other side sets.
 */
export const FETCH_LIMIT = 200;
export const SUBMIT_BATCH_SIZE = 200;

/** How many pages one `pull()` will walk before returning. Bounds one call, not the journal. */
const MAX_PAGES_PER_PULL = 64;
/** Compare-and-set attempts before a write gives up and says so. */
const MAX_WRITE_ATTEMPTS = 4;

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
  readonly fetchLimit?: number;
  readonly batchSize?: number;
}

export interface EnqueueResult {
  readonly snapshot: JournalSnapshot;
  readonly revision: string;
  readonly queued: number;
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
  private readonly fetchLimit: number;
  private readonly batchSize: number;

  constructor(options: SyncEngineOptions) {
    this.repository = options.repository;
    this.transport = options.transport;
    this.familyId = options.familyId;
    this.deviceId = options.deviceId;
    this.familyKey = options.familyKey;
    this.keyEpoch = options.keyEpoch;
    this.keyDigest = options.keyDigest;
    this.fetchLimit = options.fetchLimit ?? FETCH_LIMIT;
    this.batchSize = options.batchSize ?? SUBMIT_BATCH_SIZE;
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

  async readCursor(): Promise<SyncCursor> {
    const stored = await this.repository.readSyncState(SYNC_STATE_KEYS.cursor);
    if (stored === undefined || stored === null) return { keyEpoch: this.keyEpoch, seq: 0 };
    const record = stored as Partial<SyncCursor>;
    if (
      !Number.isSafeInteger(record.keyEpoch) ||
      !Number.isSafeInteger(record.seq) ||
      (record.seq as number) < 0
    ) {
      throw new SyncClientError("corrupt_sync_state", "the stored cursor is not a cursor");
    }
    return { keyEpoch: record.keyEpoch as number, seq: record.seq as number };
  }

  async readStop(): Promise<SyncStop | null> {
    const stored = await this.repository.readSyncState(SYNC_STATE_KEYS.stop);
    return (stored as SyncStop | undefined) ?? null;
  }

  async readEpoch(): Promise<AcceptedEpoch> {
    const stored = await this.repository.readSyncState(SYNC_STATE_KEYS.epoch);
    if (stored === undefined || stored === null) {
      return { keyEpoch: this.keyEpoch, keyDigest: this.keyDigest, live: false };
    }
    return stored as AcceptedEpoch;
  }

  async status(): Promise<SyncStatusReport> {
    return {
      cursor: await this.readCursor(),
      queued: await this.repository.countOutbox(),
      epoch: await this.readEpoch(),
      stop: await this.readStop(),
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

  /**
   * Sends what is queued and removes exactly what the server numbered.
   *
   * A refusal propagates untouched and the queue survives it: `409 epoch_mismatch`,
   * `409 rotation_in_progress` and a cut cable all leave the same twenty envelopes in the same
   * order, which is what makes them arrive once and only once when the link comes back.
   */
  async push(): Promise<PushResult> {
    const queued = await this.repository.listOutbox(this.batchSize);
    if (queued.length === 0) return { confirmed: 0, pending: 0 };

    const envelopes = queued.map((record) => record.envelope as OutgoingEnvelope);
    const sent = new Set(envelopes.map((envelope) => envelope.opId));
    const answer = await this.transport.submit(this.familyId, envelopes);

    // Only identifiers this device actually sent, and only with a number that can be a `seq`.
    // A server that answered with somebody else's identifier, or with `seq: 0`, would otherwise
    // be able to empty a queue it never accepted anything from.
    const confirmable = answer.accepted
      .filter((entry) => sent.has(entry.opId) && Number.isSafeInteger(entry.seq) && entry.seq > 0)
      .map((entry) => entry.opId);
    const confirmed = await this.repository.confirmOutbox(confirmable);

    if (confirmed > 0) {
      // 5.4.1: the proof that an epoch is live is that the server took one of this device's own
      // envelopes in it and gave it a number. Until then the previous key is kept.
      const epoch = await this.readEpoch();
      if (!epoch.live) {
        await this.repository.writeSyncState([
          { key: SYNC_STATE_KEYS.epoch, value: { ...epoch, live: true } },
        ]);
      }
    }

    return { confirmed, pending: await this.repository.countOutbox() };
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
    let cursor = await this.readCursor();
    let stop: SyncStop | null = null;
    const notices: PullResult["notices"][number][] = [];
    const priorStop = await this.readStop();
    let priorAttempts = priorStop === null ? 0 : priorStop.attempts;

    for (let page = 0; page < MAX_PAGES_PER_PULL; page += 1) {
      const answer = await this.transport.fetch(this.familyId, {
        keyEpoch: cursor.keyEpoch,
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
          deviceId: this.deviceId,
          snapshot: journal,
          priorAttempts,
        });

        if (result.applied === 0 && result.checkpoints === 0) {
          // Nothing was folded, so neither the journal nor the cursor moved and the document
          // cannot have changed. Writing it anyway would have created an empty budget on a device
          // whose very first delivery was refused — which is precisely the case an alarm covers.
          await this.repository.writeSyncState([
            { key: SYNC_STATE_KEYS.stop, value: result.stop === null ? null : { ...result.stop } },
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
            ],
          );
          if (commit.status !== "saved") continue;
        }

        written = true;
        cursor = result.cursor;
        applied += result.applied;
        checkpoints += result.checkpoints;
        notices.push(...result.notices);
        stop = result.stop;
        priorAttempts = result.stop === null ? 0 : result.stop.attempts;
      }
      if (!written) throw new SyncClientError("write_conflict", "the delivery lost its revision check");
      if (stop !== null) break;
      // The client's own end-of-journal test (3.6). A short page is the end of what the server
      // holds; anything else would be trusting `hasMore`.
      if (answer.envelopes.length < this.fetchLimit) break;
    }

    return { cursor, applied, checkpoints, notices, stop, requests };
  }

  /** 3.4: the poll follows a successful submission, so this device sees its own `seq` at once. */
  async sync(): Promise<{ readonly push: PushResult; readonly pull: PullResult }> {
    const pushed = await this.push();
    const pulled = await this.pull();
    return { push: pushed, pull: pulled };
  }
}
