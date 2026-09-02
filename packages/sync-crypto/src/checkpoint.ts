/**
 * The journal integrity anchor — `SYNC_ARCHITECTURE.md` 3.6.
 *
 * Decryption proves an envelope is genuine. It proves nothing about there being *this many* of
 * them: a server that deleted half the journal hands a joining device an internally consistent,
 * fully decryptable and completely wrong budget, and the `seq` continuity check of 3.4 cannot see
 * it, because a range truncated at the end is continuous. The anchor is the only measure this
 * scheme has against that (section 7, «Откат состояния»), and this module is the half of it that
 * computes values: the two digests, and nothing else.
 *
 * **Why the computation lives here and not in `sync-protocol`.** 3.6 says it in as many words,
 * because two different SHA-256 implementations sit in this repository and neither is universal.
 * `enc` lives in this package and is exported from it; so does the WebCrypto SHA-256 that every
 * hash of the scheme is computed with. `digest` and `prevDigest` are computed with *that* pair.
 * The second implementation — the synchronous SHA-256 inside `sync-protocol` — exists for one
 * reason: `crypto.subtle.digest` is asynchronous and the hash tiebreaker of 4.1 is called *inside*
 * a comparator of a total order, where `await` is impossible. Its subject is that tiebreaker, and
 * it hashes the canonical **text** of an operation. Computing a checkpoint digest with it is
 * forbidden: `enc` produces bytes and not text, and "the hash of a string" parts company with
 * "the hash of bytes" on the first value that is not a string. The substitution the other way is
 * forbidden for the same reason and additionally breaks the comparator's synchrony. So the two
 * implementations stay two, deliberately, and this is the file that says why.
 *
 * What is *not* here: the record itself. The plaintext of an envelope is never read by this
 * package (see `envelope.ts`), so the shape of the checkpoint record, its canonical JSON and the
 * set comparison of 3.6 belong to the client that reads journals.
 */
import { encList } from "./encoding.js";
import { fail } from "./errors.js";
import { sha256 } from "./webcrypto.js";

/**
 * The domain labels, in both digests, so a value computed in one context cannot be replayed in
 * the other — and so that neither can be confused with the AAD of an envelope or with
 * `rotateConfirm`, which share the same `enc`.
 */
export const CHECKPOINT_DIGEST_LABEL = "nash-budget/checkpoint/v1";
export const CHECKPOINT_PREV_LABEL = "nash-budget/checkpoint-prev/v1";

export interface CheckpointDigestParams {
  readonly familyId: string;
  readonly keyEpoch: number;
  /**
   * The identifiers of every operation of the epoch the device has applied.
   *
   * A set: this function sorts and de-duplicates, so the caller may hand over its journal order
   * and two devices that applied the same operations in different orders still agree. Envelopes
   * of `kind = "checkpoint"` are not operations and do not belong here.
   *
   * Nothing of the server's is a member and nothing of the server's bounds the set. 3.6 had an
   * earlier edition that limited it to a window «up to such-and-such `seq`», and that was an
   * error of exactly the class this project keeps finding: the boundary would have been drawn by
   * the very side the anchor defends against, and the server would have drawn it so that the
   * truncated tail fell outside.
   */
  readonly opIds: Iterable<string>;
}

/**
 * ```
 * digest = SHA-256(enc("nash-budget/checkpoint/v1", familyId, keyEpoch,
 *                      opCount, opId₁, …, opIdₙ))
 * ```
 *
 * `opCount` is the number of identifiers and travels *inside* the hash as well as beside it in the
 * record: without it a set and a longer set that begins with it would be distinguished only by
 * `enc`'s length prefixes, and the count is what a reader compares against before it has anything
 * else to compare.
 *
 * The ordering is lexicographic. Every identifier of this protocol is a UUID v4 written in
 * lower-case hexadecimal with dashes, so its UTF-16 code units, its Unicode code points and its
 * UTF-8 bytes are the same sequence and the three possible readings of "lexicographic" coincide;
 * a value outside that alphabet is refused below rather than sorted by a rule that would depend
 * on which of the three a runtime chose.
 */
export async function checkpointDigest(params: CheckpointDigestParams): Promise<Uint8Array> {
  const sorted = sortedIdentifiers(params.opIds);
  return sha256(
    encList([
      CHECKPOINT_DIGEST_LABEL,
      params.familyId,
      params.keyEpoch,
      sorted.length,
      ...sorted,
    ]),
  );
}

export interface CheckpointSeedParams {
  readonly familyId: string;
  readonly keyEpoch: number;
  /** The device whose chain this seeds. Numbering is per device, per 3.6, and so is the seed. */
  readonly deviceId: string;
}

/**
 * ```
 * prevDigest = SHA-256(enc("nash-budget/checkpoint-prev/v1", familyId, keyEpoch, deviceId))
 * ```
 *
 * The `prevDigest` of a device's **first** checkpoint in an epoch; every later one carries the
 * `digest` of the checkpoint before it. A constant would have done the job of "there is nothing
 * behind this one" just as well for the chain, and would have done nothing at all for the second
 * job: a first link that is a function of the family, the epoch and the device cannot be moved
 * from one chain to another, so a server cannot present a device's first checkpoint as somebody
 * else's, or as the first link of a later epoch.
 */
export async function checkpointSeedDigest(params: CheckpointSeedParams): Promise<Uint8Array> {
  return sha256(
    encList([CHECKPOINT_PREV_LABEL, params.familyId, params.keyEpoch, params.deviceId]),
  );
}

/** The identifier alphabet of the protocol: a UUID as `parseOperation` accepts it. */
const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function sortedIdentifiers(opIds: Iterable<string>): readonly string[] {
  const unique = new Set<string>();
  for (const opId of opIds) {
    if (typeof opId !== "string" || !IDENTIFIER.test(opId)) fail("invalid_input");
    unique.add(opId);
  }
  return [...unique].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
}
