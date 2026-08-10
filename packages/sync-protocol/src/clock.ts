import {
  MAX_HONEST_LAMPORT,
  MAX_LAMPORT,
  MAX_LAMPORT_SKEW,
  parseOperation,
  parseUuid,
  SyncProtocolError,
} from "./codec.js";
import type { DeviceId, LamportClock, LocalOperation, Operation, OperationDraft } from "./types.js";

export { HONEST_LAMPORT_CEILING, MAX_HONEST_LAMPORT, MAX_LAMPORT, MAX_LAMPORT_SKEW } from "./codec.js";

/** Why a received stamp was not adopted, or "accepted" when it was. */
export type LamportVerdict = "accepted" | "beyond_skew" | "above_ceiling" | "not_a_stamp";

/**
 * The outcome of receiving a stamp. The clock is returned either way, unchanged when the
 * stamp was refused, so a caller that quarantines the envelope keeps working from a clock
 * no hostile peer has touched.
 */
export interface LamportReception {
  readonly clock: LamportClock;
  readonly verdict: LamportVerdict;
}

export function createClock(deviceId: DeviceId, lamport = 0): LamportClock {
  // The codec decides what a device may call itself. A clock that accepted a different
  // shape would let a device author operations every peer refuses, and it would find out
  // only after the work was lost.
  parseUuid(deviceId, "clock deviceId");
  if (!Number.isSafeInteger(lamport) || lamport < 0) {
    throw new SyncProtocolError("clock lamport must be a non-negative integer");
  }
  if (lamport > MAX_LAMPORT) {
    throw new SyncProtocolError(`clock lamport must be at most ${MAX_LAMPORT}`);
  }
  return { deviceId, lamport };
}

/**
 * A local change moves the clock one step forward, and the step stops at
 * {@link MAX_HONEST_LAMPORT} rather than at {@link MAX_LAMPORT}.
 *
 * The merge gives no rank at all to a stamp on the honest ceiling or above it, so writing from
 * there would cost this device every conflict it will ever have. A clock that arrived on the
 * line or above it — restored from a snapshot a hostile peer had a hand in — therefore comes
 * back down to the last stamp that still ranks and goes on writing from there, instead of
 * saturating on a number that loses.
 *
 * Saturating *at* the ceiling was the other half of the fifth round's defect: while ranking
 * spared the ceiling, a device that reached it was writing at the highest rank in the protocol
 * and quietly outranked its whole family; once ranking stopped sparing it, the same device
 * would have dropped to the floor rank instead. One below the line is the only value that is
 * neither. Once stamps stop growing the digest tiebreaker alone keeps every merge
 * deterministic — see `compareOperations` in journal.ts.
 */
export function tickClock(clock: LamportClock): LamportClock {
  if (clock.lamport >= MAX_HONEST_LAMPORT) {
    return { deviceId: clock.deviceId, lamport: MAX_HONEST_LAMPORT };
  }
  return { deviceId: clock.deviceId, lamport: clock.lamport + 1 };
}

/**
 * Receives a stamp and returns a verdict.
 *
 * This is the local clock and nothing else: it decides what this device stamps its own writes
 * with, never what any journal contains. A stamp further than {@link MAX_LAMPORT_SKEW} ahead
 * is not adopted and not silently reduced, because one envelope must not be able to spend a
 * family's whole supply of stamps in a single step; the caller is told, and quarantines the
 * envelope it came from. Adoption also stops at {@link MAX_HONEST_LAMPORT}, from the line above
 * it onwards a stamp carries no rank in the merge and is therefore worth nothing to write from.
 */
export function receiveLamport(clock: LamportClock, lamport: number): LamportReception {
  if (!Number.isSafeInteger(lamport) || lamport < 0) return { clock, verdict: "not_a_stamp" };
  if (lamport > MAX_LAMPORT) return { clock, verdict: "above_ceiling" };
  if (lamport > clock.lamport + MAX_LAMPORT_SKEW) return { clock, verdict: "beyond_skew" };
  if (lamport <= clock.lamport) return { clock, verdict: "accepted" };
  return {
    clock: { deviceId: clock.deviceId, lamport: Math.min(lamport, MAX_HONEST_LAMPORT) },
    verdict: "accepted",
  };
}

/**
 * Receives a stamp, or throws when it is not plausible. Callers that already quarantine on a
 * SyncProtocolError use this one; callers that want to report the reason use
 * {@link receiveLamport}.
 */
export function receiveClock(clock: LamportClock, lamport: number): LamportClock {
  const reception = receiveLamport(clock, lamport);
  if (reception.verdict === "accepted") return reception.clock;
  if (reception.verdict === "not_a_stamp") {
    throw new SyncProtocolError("received lamport must be a non-negative integer");
  }
  throw new SyncProtocolError(
    reception.verdict === "above_ceiling"
      ? `received lamport must be at most ${MAX_LAMPORT}`
      : `received lamport must not be more than ${MAX_LAMPORT_SKEW} ahead of this clock`,
  );
}

/**
 * Receives a whole batch, measured against the clock the batch started from.
 *
 * Folding {@link receiveClock} over the operations was a ladder, not a check: each stamp was
 * compared with a clock the stamps before it had already raised, so a batch of two thousand
 * operations one skew apart walked the clock of the family two billion steps forward without
 * a single refusal. The horizon is fixed before the first operation is read instead, so the
 * distance one call may move the clock is the distance one honest peer can be ahead, in
 * whatever order the batch arrives and however many operations it holds.
 *
 * Across calls it is still a ladder, and deliberately so. The horizon is per call, the standard
 * contract is one operation per envelope, and a peer willing to spend one envelope per rung
 * therefore walks this clock up one skew at a time. That costs the family nothing that it did
 * not already cost: this clock is bookkeeping about the receiver — it decides what this device
 * stamps its own writes with and never which operation owns an entity — so two devices handed
 * the same operations in different batches may hold different clocks here and still agree about
 * the family down to the last kopeck.
 *
 * A peer does not need the ladder to write a large stamp in the first place: the stamp is a
 * field of the operation, and any value below {@link MAX_HONEST_LAMPORT} outranks a family whose
 * own clock is lower. Nothing on this side prevents that, and decision 39 says so rather than
 * building a seventh mechanism that does not: the merge is what makes a family converge against
 * a server and a network that reorder, delay, duplicate and interrupt, not what stands between a
 * family and one of its own members, who can delete the whole budget through the front door. The
 * anchor that orders writes against a peer is the server's own sequencing, in phase S4.
 *
 * The top of the climb is one below the ranking line rather than on it, so a device a ladder
 * pushed all the way up still writes at a rank of its own instead of at the floor — and, before
 * the fifth round moved this value, instead of at the highest rank in the protocol.
 */
export function receiveOperations(clock: LamportClock, operations: readonly Operation[]): LamportClock {
  let highest = clock.lamport;
  for (const operation of operations) {
    // Every operation is measured against `clock`, never against `highest`.
    receiveClock(clock, operation.lamport);
    if (operation.lamport > highest) highest = Math.min(operation.lamport, MAX_HONEST_LAMPORT);
  }
  return highest === clock.lamport ? clock : { deviceId: clock.deviceId, lamport: highest };
}

function randomOpId(): string {
  return globalThis.crypto.randomUUID();
}

/** Stamps a draft with this device's identity and its next Lamport value. */
export function createLocalOperation(clock: LamportClock, draft: OperationDraft): LocalOperation {
  const next = tickClock(clock);
  const operation = parseOperation({
    ...draft,
    opId: draft.opId ?? randomOpId(),
    deviceId: next.deviceId,
    lamport: next.lamport,
  });
  return { clock: next, operation };
}
