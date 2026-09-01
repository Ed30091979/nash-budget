/**
 * Receiving and applying somebody else's operations — `SYNC_ARCHITECTURE.md` 3.4, step by step.
 *
 * The order of the steps is the substance of the section, not its presentation, and two of them
 * are easy to reverse by accident:
 *
 * - **nothing in the open header may produce a verdict before the tag has verified.** The header
 *   is not authenticated until then, so a build that refused an unknown `envelopeVersion` early
 *   would let a server hang «требуется обновление» on a whole family by flipping one open byte.
 *   The header is read before decryption for one purpose only — choosing which parser to use;
 * - **the tag failing on this device's own live epoch is an alarm, from the first envelope.** Not
 *   a quarantine, not "three attempts in a day", not a skip a user can approve. The cursor stops
 *   where it stopped. `10` is a threshold of retries of *one* envelope, and all it changes is the
 *   wording; a threshold counting how many *different* envelopes failed cannot exist, because
 *   after the first failure the cursor is standing still and no second one is ever delivered.
 *
 * Nothing here is measured against a number the server writes. The delivery limit is a constant
 * of this client, the end of the journal is decided by the client (3.6), and `seq` — which the
 * AAD does not cover and the server can therefore write freely — is checked for continuity
 * against the cursor rather than trusted.
 */
import { openEnvelope, ENVELOPE_KINDS, ENVELOPE_VERSION, fromUtf8 } from "@family-budget/sync-crypto";
import {
  applyOperations,
  createClock,
  MAX_LAMPORT,
  parseOperation,
  receiveLamport,
  type JournalSnapshot,
  type Operation,
} from "@family-budget/sync-protocol";

import { fromBase64 } from "./base64.js";
import type {
  DeliveredEnvelope,
  IntakeResult,
  LamportNotice,
  SyncCursor,
  SyncStop,
  SyncStopReason,
} from "./types.js";

export interface ApplyDeliveryParams {
  readonly envelopes: readonly DeliveredEnvelope[];
  readonly cursor: SyncCursor;
  /** The epoch this device has accepted. Local state; it never travelled to the server. */
  readonly acceptedEpoch: number;
  readonly familyKey: CryptoKey;
  readonly deviceId: string;
  readonly snapshot: JournalSnapshot;
  /**
   * The stop this delivery is retrying, as it was written down.
   *
   * The whole record and not just its counter: 3.4 counts retries of *one* envelope, so the
   * counter only carries over while the delivery stops on the same `opId`. Handing this function
   * a number alone would make "nine attempts" a property of the device rather than of an
   * envelope, and the tenth failure — of any envelope at all — would raise the alarm.
   */
  readonly priorStop?: SyncStop | null;
}

/**
 * Which refusal a plaintext that will not decode earns.
 *
 * 3.4 asks for two different verdicts here — an unknown entity, action or field means "update the
 * application", and an operation that fails a bounds check is quarantined — and the codec of
 * phase S1 reports both through one error type with one message. Reading that message would make
 * this classification depend on prose, so the split is made on the one thing this build can decide
 * for itself, from its own constant:
 *
 * - the stamp is outside `1 … 2^40`: a bounds failure, and the one bound 3.4 names by itself;
 * - everything else: «update the application». An unknown entity, an unknown action and an
 *   unknown *field* inside `fields` all end here, and there is nothing to gain by asking after
 *   the first two separately — the answer is the same sentence on the same screen, and a branch
 *   that cannot change an outcome only makes it look as though it could.
 *
 * The residue is honest and small: an in-range operation that fails a money bound is reported as
 * "update required" rather than quarantined. Both stop the cursor and neither skips anything, so
 * the difference is the wording on one screen. It is written down here rather than papered over.
 */
function classifyUndecodable(plaintext: string): SyncStopReason {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return "update_required";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "update_required";
  }
  const lamport = (parsed as Record<string, unknown>).lamport;
  const inBounds =
    typeof lamport === "number" &&
    Number.isSafeInteger(lamport) &&
    lamport >= 1 &&
    lamport <= MAX_LAMPORT;
  return inBounds ? "update_required" : "quarantined";
}

/**
 * Folds one delivery. Returns where it got to and why it stopped, and writes nothing.
 *
 * The snapshot's `state`, `integrity` and `entries` are deliberately never read inside the loop:
 * each of them costs a full pass over the journal, and reading one per envelope turns a delivery
 * of a few thousand into minutes of a blocked main thread. The caller reads the verdict once,
 * after the fold — the contract `JournalSnapshot` states in its own documentation.
 */
export async function applyDelivery(params: ApplyDeliveryParams): Promise<IntakeResult> {
  let snapshot = params.snapshot;
  let cursor = params.cursor;
  let applied = 0;
  let checkpoints = 0;
  const notices: LamportNotice[] = [];

  /**
   * Everything the caller is owed when a delivery stops, in one place.
   *
   * The counter is the substance here rather than the tidying: `attempts` counts consecutive
   * failures of *this* envelope, so it continues only while the previous stop named the same
   * `opId` and starts at `1` for any other. The rest of the result is what was folded before the
   * stop — the cursor never moves past the envelope named.
   */
  const halt = (reason: SyncStopReason, envelope: DeliveredEnvelope): IntakeResult => {
    const prior = params.priorStop ?? null;
    const attempts = prior !== null && prior.opId === envelope.opId ? prior.attempts + 1 : 1;
    return {
      snapshot,
      cursor,
      applied,
      checkpoints,
      notices,
      stop: { reason, seq: envelope.seq, opId: envelope.opId, attempts },
    };
  };

  for (const envelope of params.envelopes) {
    // 3.4 step 1. Outside a legitimately announced change of epoch — one that came with a wrap
    // and a confirmation this device verified for itself (5.4) — an envelope numbered under
    // another epoch is treated exactly as an envelope of this epoch whose tag failed. The header
    // number is open and unauthenticated, so letting it move the envelope into the milder class
    // would hand the server a one-digit edit that lifts a forged envelope out of the alarm.
    if (envelope.keyEpoch !== params.acceptedEpoch) {
      return halt("key_mismatch", envelope);
    }

    // 3.4 step 2. `seq` is outside the AAD and the server writes it freely, so continuity is the
    // only thing standing between this device and a journal quietly missing its middle.
    if (envelope.seq !== cursor.seq + 1) {
      return halt("journal_incomplete", envelope);
    }

    // 3.4 step 3.
    const iv = fromBase64(envelope.iv);
    const ciphertext = fromBase64(envelope.ciphertext);
    let plaintextBytes: Uint8Array;
    try {
      if (iv === null || ciphertext === null) throw new Error("not base64");
      plaintextBytes = await openEnvelope(params.familyKey, {
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
      return halt("key_mismatch", envelope);
    }

    // 3.4 step 4. Only now may an open header field produce a verdict.
    const knownKind = (ENVELOPE_KINDS as readonly string[]).includes(envelope.kind);
    if (envelope.envelopeVersion !== ENVELOPE_VERSION || !knownKind) {
      return halt("update_required", envelope);
    }

    let plaintext: string;
    try {
      plaintext = fromUtf8(plaintextBytes);
    } catch {
      return halt("update_required", envelope);
    }

    if (envelope.kind === "checkpoint") {
      // 3.6 belongs to a later phase: the anchor is read far enough to know it is well-formed,
      // the cursor moves past it, and no comparison is claimed. Passing over an unreadable one in
      // silence is not allowed, so a checkpoint that will not parse stops the delivery like any
      // other plaintext this build cannot read.
      try {
        const record: unknown = JSON.parse(plaintext);
        if (typeof record !== "object" || record === null || Array.isArray(record)) {
          throw new Error("not a checkpoint");
        }
      } catch {
        return halt("update_required", envelope);
      }
      checkpoints += 1;
      cursor = { keyEpoch: params.acceptedEpoch, seq: envelope.seq };
      continue;
    }

    // 3.4 step 5.
    let operation: Operation;
    try {
      operation = parseOperation(JSON.parse(plaintext));
    } catch {
      return halt(classifyUndecodable(plaintext), envelope);
    }

    // 3.4 step 6.
    if (operation.deviceId !== envelope.deviceId) {
      return halt("quarantined", envelope);
    }

    // 3.4 steps 7 and 8. The stamp is folded whatever the verdict — it ranks by its own value,
    // so the state does not depend on whose clock read what — and only the *adoption* of it into
    // this device's clock is bounded. The fold performs the adoption itself, against the clock it
    // carries; the verdict is recomputed here for one purpose only, to be able to say which
    // device wrote a stamp beyond the horizon.
    const reception = receiveLamport(
      createClock(params.deviceId, snapshot.lamport),
      operation.lamport,
    );
    if (reception.verdict !== "accepted") {
      notices.push({ opId: operation.opId, deviceId: operation.deviceId });
    }

    // 3.4 step 9.
    snapshot = applyOperations(snapshot, [operation]);
    applied += 1;
    // 3.4 step 10 — the caller performs the single transaction; this function decides what goes
    // into it. The epoch of the cursor is the epoch of the key that opened the envelope, which
    // step 1 has already established the header agrees with; taking it from the header instead
    // would make the one number the whole client keys off a value the server writes.
    cursor = { keyEpoch: params.acceptedEpoch, seq: envelope.seq };
  }

  return { snapshot, cursor, applied, checkpoints, notices, stop: null };
}
