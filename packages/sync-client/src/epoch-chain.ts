/**
 * Accepting a new family key — `SYNC_ARCHITECTURE.md` 5.4 and 5.4.1.
 *
 * The whole section reduces to one sentence that has to survive contact with an implementation:
 * **a change of key epoch is never accepted on the server's word.** There are two paths and no
 * third — a chain of confirmations from an epoch whose key this device already holds, or a
 * ceremony a person started. This module implements the first and refuses everything that is not
 * one of the two.
 *
 * Three rules are easy to get wrong and each of them has a comment at the line that enforces it:
 *
 * - **the device never says which epoch it has accepted.** That is why the input of this function
 *   is "every wrap the server volunteered", not "the wraps after epoch N": a server told where a
 *   device stands can start the chain where the device is weakest, or read off the family list
 *   who is behind and pick a convenient minute to ask a human to confirm a key. The transport
 *   sends no query string at all (`keys()` in `transport.ts`);
 * - **a gap in epoch numbers is not a break in the chain.** A cancelled rotation takes its number
 *   with it and leaves a number that will never have a link. An implementation that walked every
 *   number from its own to the current one would call each honest gap a break and lock out any
 *   device that slept through a cancelled attempt. A break is a missing *link* — no confirmation,
 *   a confirmation that does not verify on the key actually held, or a link derived from a key
 *   this device never accepted;
 * - **an epoch below the accepted one is refused with an alarm and never enters the chain.** It is
 *   not a stale answer: it is an attempt to put the family back on a key that may already have
 *   leaked to a revoked device. «Не входит в цепочку» is a wrap passed over unopened and counted,
 *   not a walk abandoned: the server hands back *every* wrap this device was ever sent, in
 *   ascending order, and the old ones survive a lawful rotation — they are what a device two
 *   epochs behind catches up on. A walk that stopped at the first of them would leave every
 *   device stranded one epoch after its first rotation and would call the ordinary answer an
 *   alarm. Whether the wrap is worth showing to a person is the caller's decision, and it is
 *   handed the count to make it.
 */
import {
  deviceKeyFingerprint,
  equalBytes,
  familyKeyFingerprint,
  toHex,
  unwrapFamilyKey,
  verifyEpochConfirm,
} from "@family-budget/sync-crypto";

import { fromBase64 } from "./base64.js";
import type { KeyWrapRecord } from "./transport.js";
import type { AcceptedEpoch } from "./types.js";

/**
 * State of the local pin for one sender — table of 5.4.1.
 *
 * The state lives on this device and nowhere else. Server lists may *hint* that a comparison is
 * due; they never grant one, which is why nothing here is read out of a response.
 */
export type PinState =
  | { readonly state: "pinned"; readonly fingerprint: Uint8Array }
  | { readonly state: "absent" }
  | { readonly state: "repin_required" };

export type EpochChainRefusal =
  /** A wrap for the epoch already held, carrying a different key. The substitution 5.4.1 names. */
  | "key_substituted"
  /** No confirmation travelled with a wrap that changes the number. */
  | "missing_confirmation"
  /** The confirmation did not verify on the key of the epoch actually held. */
  | "confirmation_failed"
  /** No local pin for the sender, or the pin is waiting to be made again. */
  | "sender_not_pinned"
  /** The SPKI the server offered does not hash to the pin. */
  | "sender_key_changed"
  /** The wrap did not open, or its fields are not what the wire says they are. */
  | "unwrap_failed";

export interface EpochChainParams {
  readonly familyId: string;
  readonly deviceId: string;
  readonly deviceSpki: Uint8Array;
  readonly devicePrivateKey: CryptoKey;
  /** Every wrap the server volunteered, in whatever order it chose. */
  readonly wraps: readonly KeyWrapRecord[];
  /**
   * The epoch this device holds, or `null` when it holds none.
   *
   * `null` is the case 5.4.1 spells out at length: a device being admitted for the first time has
   * no earlier key, so no chain of confirmations can exist for it, and the ceremony that bound it
   * is what authorises the first wrap. That is not a third path — it is the second one.
   */
  readonly accepted: {
    readonly keyEpoch: number;
    readonly key: CryptoKey;
    /**
     * Whether that epoch has already been proven live (5.4.1), so the walk can hand it back.
     *
     * The proof is expensive — it costs a round trip in which the server numbers one of this
     * device's own envelopes — and 5.4.1 leans on it: an epoch below the *proven* one is what may
     * not be stepped down to. A walk that always answered `live: false` would have the caller
     * write that over a proof already earned, and the device would go back to being unable to
     * forget the key it left.
     */
    readonly live?: boolean;
  } | null;
  /** The local pin for a sender device. Never read from a server response. */
  readonly pin: (senderDeviceId: string) => PinState;
  /** The SPKI the server offers for a sender. Untrusted until it hashes to the pin. */
  readonly senderSpki: (senderDeviceId: string) => Uint8Array | undefined;
}

export interface EpochChainResult {
  /** The epoch this device holds after the walk, and the digest it remembers it by. */
  readonly epoch: AcceptedEpoch | null;
  readonly key: CryptoKey | null;
  /** Links actually consumed. Zero means the device was already current. */
  readonly advanced: number;
  /** Wraps of the accepted epoch that carried the same key and were therefore redundant. */
  readonly ignored: number;
  /**
   * Wraps naming an epoch below the one held: passed over unopened, and counted here.
   *
   * Ordinary after any rotation — the server keeps every wrap a device was ever sent — so this
   * being non-zero is not by itself a reason to say anything to anybody. What 5.4.1 calls an
   * alarm is a *proposal* to move down, and only the caller knows whether it is looking at one:
   * it is the side that knows whether the epoch it holds was ever proven live, and the side that
   * owns the one loud signal this system has.
   */
  readonly belowAccepted: number;
  /** Where the walk stopped, and why. `null` when every link was consumed. */
  readonly refusal: { readonly reason: EpochChainRefusal; readonly keyEpoch: number } | null;
}

function decodeWrap(record: KeyWrapRecord, familyId: string, deviceId: string) {
  const salt = fromBase64(record.salt);
  const iv = fromBase64(record.iv);
  const ciphertext = fromBase64(record.ciphertext);
  if (salt === null || iv === null || ciphertext === null) return null;
  return {
    familyId,
    keyEpoch: record.keyEpoch,
    rotationId: record.rotationId,
    senderDeviceId: record.senderDeviceId,
    recipientDeviceId: deviceId,
    salt,
    iv,
    ciphertext,
  };
}

/**
 * Walks the wraps the server volunteered and returns the furthest epoch this device may hold.
 *
 * Strictly sequential and strictly ascending: each link is confirmed on the key of the link
 * before it, which is the only thing a server cannot forge — it has never held any of them.
 */
export async function resolveEpochChain(params: EpochChainParams): Promise<EpochChainResult> {
  let currentKey = params.accepted?.key ?? null;
  let currentEpoch = params.accepted?.keyEpoch ?? null;
  let advanced = 0;
  let ignored = 0;
  let belowAccepted = 0;

  const ordered = [...params.wraps]
    .filter((wrap) => wrap.deviceId === params.deviceId)
    .sort((left, right) => left.keyEpoch - right.keyEpoch);

  /**
   * The result, however the walk ended.
   *
   * `live` is carried over only while the walk never left the epoch it was earned in — which is
   * exactly the case `currentEpoch` still names the accepted one, because the walk only ever goes
   * up. One link consumed and the proof is spent: the new key has not been numbered by anything.
   */
  const settle = async (
    refusal: { readonly reason: EpochChainRefusal; readonly keyEpoch: number } | null,
  ): Promise<EpochChainResult> => ({
    epoch:
      currentKey === null || currentEpoch === null
        ? null
        : {
            keyEpoch: currentEpoch,
            keyDigest: toHex(await familyKeyFingerprint(currentKey)),
            live: currentEpoch === params.accepted?.keyEpoch && params.accepted.live === true,
          },
    key: currentKey,
    advanced,
    ignored,
    belowAccepted,
    refusal,
  });

  const halt = (reason: EpochChainRefusal, keyEpoch: number): Promise<EpochChainResult> =>
    settle({ reason, keyEpoch });

  for (const record of ordered) {
    // An epoch below the one held is not a stale answer and not a reason to ask a person
    // anything: it is an attempt to return the family to a key a revoked device may still have.
    // It is passed over without being opened — deriving anything from a key that far back is the
    // very thing being refused — and the walk goes on to the wraps that are ahead of it, which is
    // where the catching up lives. Downwards it cannot go in any case: the epoch held only rises,
    // and one equal to it is settled by digest below.
    if (currentEpoch !== null && record.keyEpoch < currentEpoch) {
      belowAccepted += 1;
      continue;
    }

    const pin = params.pin(record.senderDeviceId);
    if (pin.state !== "pinned") {
      // "Absent" and "repin required" refuse alike, and the second one refuses even mid-chain:
      // 5.4.1 has a pin waiting to be made again break the chain as hard as a missing link,
      // because trust in that link is gone.
      return halt("sender_not_pinned", record.keyEpoch);
    }
    const spki = params.senderSpki(record.senderDeviceId);
    if (spki === undefined) return halt("sender_not_pinned", record.keyEpoch);

    const wrap = decodeWrap(record, params.familyId, params.deviceId);
    if (wrap === null) return halt("unwrap_failed", record.keyEpoch);

    // The order 5.4 prescribes: hash the delivered SPKI, compare with the pin, and only then
    // derive. `unwrapFamilyKey` performs the comparison itself; the explicit check here is what
    // turns its refusal into the two different verdicts a person is shown.
    //
    // `equalBytes` and not two hex strings, because 5.4 asks for this comparison by name to be
    // made **in constant time** and a JavaScript string comparison returns at the first differing
    // character. What leaks here is small — a prefix of the hash of a public key the server
    // already holds — and it is still the wrong instrument: the package has one comparison for
    // values an attacker controls an end of, and the way a build ends up using the early-exit one
    // where it matters is by keeping it around for the cases where it does not.
    const delivered = await deviceKeyFingerprint(spki);
    if (!equalBytes(delivered, pin.fingerprint)) {
      return halt("sender_key_changed", record.keyEpoch);
    }

    let unwrapped: CryptoKey;
    try {
      unwrapped = await unwrapFamilyKey({
        wrap,
        recipientPrivateKey: params.devicePrivateKey,
        recipientSpki: params.deviceSpki,
        senderSpki: spki,
        pinnedSenderFingerprint: pin.fingerprint,
      });
    } catch {
      return halt("unwrap_failed", record.keyEpoch);
    }

    if (currentEpoch !== null && record.keyEpoch === currentEpoch) {
      // 5.4.1: a wrap for an epoch already held is never accepted. Same key — redundant, ignore
      // it. Different key — this is the substitution the whole section exists to catch, because a
      // wrap of the current epoch changes the key without changing the number, and nothing would
      // have to be confirmed.
      // The same rule, and here the value is the family key's own fingerprint rather than a
      // public key's: an early exit would leak its prefix a character at a time to a server that
      // can offer as many wraps as it likes.
      const held = await familyKeyFingerprint(currentKey!);
      const offered = await familyKeyFingerprint(unwrapped);
      if (equalBytes(held, offered)) {
        ignored += 1;
        continue;
      }
      return halt("key_substituted", record.keyEpoch);
    }

    if (currentKey === null) {
      // First issue. There is no earlier key, so there can be no confirmation to check, and the
      // ceremony that produced the pin is what authorises this wrap.
      currentKey = unwrapped;
      currentEpoch = record.keyEpoch;
      advanced += 1;
      continue;
    }

    const confirmBytes = record.rotateConfirm === null ? null : fromBase64(record.rotateConfirm);
    if (confirmBytes === null) return halt("missing_confirmation", record.keyEpoch);

    const verified = await verifyEpochConfirm(
      {
        previousFamilyKey: currentKey,
        familyId: params.familyId,
        keyEpoch: record.keyEpoch,
        // The confirmation carries the rotation that produced it, which is not always the
        // rotation named on the wrap: a wrap issued out of band cites the rotation the epoch in
        // force came from.
        rotationId: record.confirmRotationId ?? record.rotationId,
        nextFamilyKey: unwrapped,
      },
      confirmBytes,
    );
    if (!verified) return halt("confirmation_failed", record.keyEpoch);

    currentKey = unwrapped;
    currentEpoch = record.keyEpoch;
    advanced += 1;
  }

  return settle(null);
}
