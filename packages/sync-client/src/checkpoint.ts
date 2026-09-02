/**
 * The journal integrity anchor as a reader sees it — `SYNC_ARCHITECTURE.md` 3.6.
 *
 * `sync-crypto` computes the two digests; this module owns everything around them: the shape of
 * the record, the chain `(deviceId, index)`, and the set comparison of 3.6 that decides whether
 * the family's journals agree. Nothing here changes a single value of the budget. 3.6 is explicit
 * that a divergence «не блокирует работу и не откатывает состояние» — it is a signal to a person
 * and a reason to rebuild by hand, never an automatic repair — so the widest thing this module
 * can produce is a {@link CheckpointAlarm}.
 *
 * **What travels and what is reconstructed.** The record carries `opCount`, `skipped` and
 * `digest`; it does not carry the identifiers themselves, and it must not — the set of an epoch
 * is every operation the family ever wrote, and a checkpoint listing them would be a megabyte
 * envelope written every ten minutes. So the reader rebuilds the author's set `T` out of its own
 * journal: the author writes a checkpoint only over a solid applied prefix (3.6), and both
 * devices read the same journal in the same order, so `T` is the first `opCount` operations of
 * this device's own journal order once the author's `skipped` are taken out. The digest is what
 * decides: rebuild, hash, compare with the value the author computed over the set it really had.
 *
 * That the prefix and not the whole set is compared is not a convenience either. A device that
 * has been offline for a week catches up half the journal and writes a checkpoint over what it
 * has; a reader that measured that checkpoint against *its own* complete set would call an
 * ordinary lagging family member a truncated journal, and the one alarm this system has would
 * fire every day for nothing. The truncation the anchor exists for survives the prefix reading
 * untouched: a reader whose tail was cut cannot rebuild a prefix of `opCount` at all, and says so.
 *
 * The residue, written down rather than papered over: when the digest disagrees while a full
 * prefix could be rebuilt, the reader knows that some identifier inside the compared prefix
 * differs and cannot say which — it never saw the author's list. It reports the counts, the
 * shortfall and the identifiers of its own that the checkpoint neither counts nor declares
 * skipped, which is as much of «чего именно недостаёт каждой стороне» as the wire allows.
 */
import { checkpointDigest, toHex } from "@family-budget/sync-crypto";

/**
 * The plaintext of a `kind = "checkpoint"` envelope — the record of 3.6, field for field.
 *
 * Two lists and they are never mixed: `skipped` holds **identifiers of operations** the author
 * passed over through quarantine (3.4), `inheritedGaps` holds **`seq` numbers of the previous
 * epoch** that were still gaps when it was carried across (5.5). The second is numbers and not
 * identifiers because nothing decrypted those envelopes: their `opId` is unknown by definition,
 * and putting a number into a list of identifiers would be writing a value of another kind.
 */
export interface CheckpointRecord {
  /** This device's checkpoint number in this epoch, from `1`. Numbering is per device. */
  readonly index: number;
  /** How many operations of the epoch the author had applied. The size of the set it hashed. */
  readonly opCount: number;
  /** Sorted identifiers the author skipped through quarantine — `S_T` of the formula. */
  readonly skipped: readonly string[];
  /** Sorted `seq` numbers of the previous epoch that were gaps when it was carried across. */
  readonly inheritedGaps: readonly number[];
  /** The previous checkpoint's `digest`, or the chain seed for `index = 1`. Lower-case hex. */
  readonly prevDigest: string;
  /** `SHA-256(enc(…))` over the author's set, as `sync-crypto` computes it. Lower-case hex. */
  readonly digest: string;
}

/**
 * How long a list this build will read out of one checkpoint.
 *
 * A bound of this client, like every other bound in it, and not a number anybody else writes. It
 * exists because both lists arrive as JSON from another device and a reader with no bound at all
 * hands whoever writes the record the right to decide how much memory the reader spends. The
 * value is far above any honest family: a device that quarantined ten thousand envelopes has a
 * problem the anchor is not going to be the one to report.
 */
export const MAX_CHECKPOINT_LIST = 10_000;

const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

/**
 * A refusal of a record, and deliberately not a {@link SyncClientError}.
 *
 * The codes of this package are the branches a screen renders, and a checkpoint this build cannot
 * read has one: the «обновите приложение» stop of 3.4, which `intake.ts` produces from the catch
 * around the parse. A code of its own would be a second name for the same screen. The messages
 * are fixed strings for the reason the whole package keeps them so — the record was written by
 * another device, and nothing out of it is repeated back into a message.
 */
function refuse(message: string): never {
  throw new Error(message);
}

function readIdentifiers(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) refuse(`checkpoint ${field} is not a list`);
  if (value.length > MAX_CHECKPOINT_LIST) refuse(`checkpoint ${field} is too long to read`);
  let previous: string | null = null;
  for (const item of value) {
    if (typeof item !== "string" || !IDENTIFIER.test(item)) {
      refuse(`checkpoint ${field} holds something that is not an identifier`);
    }
    // Sorted and without repetition, which is the one shape the digest is defined on: a list a
    // reader had to sort for itself would let two spellings of one set produce two digests.
    if (previous !== null && item <= previous) refuse(`checkpoint ${field} is not sorted`);
    previous = item;
  }
  return value as readonly string[];
}

function readNumbers(value: unknown, field: string): readonly number[] {
  if (!Array.isArray(value)) refuse(`checkpoint ${field} is not a list`);
  if (value.length > MAX_CHECKPOINT_LIST) refuse(`checkpoint ${field} is too long to read`);
  let previous = 0;
  for (const item of value) {
    if (!Number.isSafeInteger(item) || (item as number) < 1) {
      refuse(`checkpoint ${field} holds something that is not a seq`);
    }
    if ((item as number) <= previous) refuse(`checkpoint ${field} is not sorted`);
    previous = item as number;
  }
  return value as readonly number[];
}

/**
 * Reads a checkpoint record out of the plaintext of an envelope, and refuses anything else.
 *
 * Strict on every field, because a record this build cannot read is not a record with defaults:
 * it was written by something other than this version of the scheme, and guessing at it would put
 * an invented verdict on a family's screen. The caller turns a refusal into the ordinary
 * «обновите приложение» stop of 3.4 — a checkpoint passed over in silence is what 3.6 forbids.
 */
export function parseCheckpointRecord(value: unknown): CheckpointRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse("a checkpoint envelope did not hold a record");
  }
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.index) || (record.index as number) < 1) {
    refuse("checkpoint index is not a position in a chain");
  }
  if (!Number.isSafeInteger(record.opCount) || (record.opCount as number) < 0) {
    refuse("checkpoint opCount is not a count");
  }
  if (typeof record.prevDigest !== "string" || !DIGEST.test(record.prevDigest)) {
    refuse("checkpoint prevDigest is not a digest");
  }
  if (typeof record.digest !== "string" || !DIGEST.test(record.digest)) {
    refuse("checkpoint digest is not a digest");
  }
  return {
    index: record.index as number,
    opCount: record.opCount as number,
    skipped: readIdentifiers(record.skipped, "skipped"),
    inheritedGaps: readNumbers(record.inheritedGaps, "inheritedGaps"),
    prevDigest: record.prevDigest,
    digest: record.digest,
  };
}

/**
 * The record as it is sealed: the six fields of 3.6 in the order the document writes them.
 *
 * `JSON.stringify` over a literal, so the key order is this source line and not the order some
 * object happened to acquire its properties in. The bytes are not hashed — the digest is over
 * `enc`, never over this text — so the canonical form matters for one smaller reason: two builds
 * writing the same record should produce the same envelope length, and a diff of two checkpoints
 * should be readable.
 */
export function encodeCheckpointRecord(record: CheckpointRecord): string {
  return JSON.stringify({
    index: record.index,
    opCount: record.opCount,
    skipped: [...record.skipped],
    inheritedGaps: [...record.inheritedGaps],
    prevDigest: record.prevDigest,
    digest: record.digest,
  });
}

/** The last checkpoint read from one device: what the next one of that device must follow on. */
export interface CheckpointLink {
  readonly deviceId: string;
  readonly index: number;
  readonly digest: string;
}

export const CHECKPOINT_ALARM_REASONS = [
  /**
   * The sets do not agree. Either this device cannot rebuild a prefix as long as the checkpoint
   * counts — the truncated journal 3.6 exists to catch — or it can and the digests differ.
   */
  "journal_diverged",
  /**
   * The chain `(deviceId, index)` skipped, or `prevDigest` does not match the checkpoint before
   * it. 3.6: a gap means the server deleted a checkpoint, and it is treated exactly as a
   * divergence of `digest`.
   */
  "chain_broken",
] as const;

export type CheckpointAlarmReason = (typeof CHECKPOINT_ALARM_REASONS)[number];

/**
 * «Журнал расходится» — the warning of 3.6, with the numbers it is shown with.
 *
 * Data and never prose: the screen that renders it belongs to the application, and everything it
 * needs to write a sentence is here as a value.
 */
export interface CheckpointAlarm {
  readonly reason: CheckpointAlarmReason;
  /** The device whose checkpoint disagreed. Open header field, authenticated by the tag. */
  readonly deviceId: string;
  /** Where the checkpoint sat in the journal. Reporting only — no comparison is measured by it. */
  readonly seq: number;
  readonly index: number;
  /** Operations of this epoch this device holds. */
  readonly ownCount: number;
  /** Operations the checkpoint counts. */
  readonly checkpointCount: number;
  /**
   * `T \ (M ∪ S_M)` — how many operations the checkpoint accounts for that this device does not
   * hold and did not itself skip. A count and not identifiers: this device never saw them, so it
   * has no name to give, exactly as 3.6 says of envelopes lost to truncation.
   */
  readonly missingHere: number;
  /** `M \ (T ∪ S_T)` — how many this device holds that the checkpoint neither counts nor skipped. */
  readonly missingThere: number;
  /** A few of the identifiers behind {@link missingThere}, so the report can name something. */
  readonly examples: readonly string[];
}

/** How many identifiers an alarm carries. The alarm is written to disk; it stays small. */
const ALARM_EXAMPLES = 8;

export interface CompareCheckpointParams {
  readonly record: CheckpointRecord;
  readonly familyId: string;
  readonly keyEpoch: number;
  /** The device that wrote the checkpoint, and the `seq` the server gave the envelope. */
  readonly deviceId: string;
  readonly seq: number;
  /**
   * Every operation of this epoch this device has read out of the journal, in the order the
   * journal delivered them — applied or skipped, checkpoints excluded.
   *
   * Journal order and not sorted order, because the author's set is a prefix of it. Nothing this
   * device merely wrote locally belongs here: 3.6 keeps envelopes still sitting in the outgoing
   * queue out of the set, or a device that worked offline would raise a divergence over its own
   * unsent work.
   */
  readonly journalOpIds: readonly string[];
  /** `S_M` — what this device skipped through quarantine (3.4). */
  readonly skipped: readonly string[];
}

/**
 * The comparison of 3.6, and the formula of the third rule exactly as it is written there.
 *
 * `M` is this device's set, `S_M` its own skipped, `T` the checkpoint's set and `S_T` the
 * checkpoint's skipped. The alarm is raised when either `M \ (T ∪ S_T)` or `T \ (M ∪ S_M)` is
 * non-empty, and the sides are those and not the other way round: the element is forgiven by the
 * side that does **not** have it. Subtracting `S_M` from `M` would be subtracting a set `M` does
 * not intersect — `M \ (T ∪ S_M)` is identically `M \ T` — and the symmetry would be idle while
 * this device's own skip produced a permanent warning about itself.
 */
export async function compareCheckpoint(
  params: CompareCheckpointParams,
): Promise<CheckpointAlarm | null> {
  const theirSkipped = new Set(params.record.skipped);
  const ownSkipped = new Set(params.skipped);

  // `T`, rebuilt: the author's solid prefix, with the identifiers it declares it passed over
  // taken out of this device's own journal order first.
  const rebuildable = params.journalOpIds.filter((opId) => !theirSkipped.has(opId));
  const theirs = rebuildable.slice(0, params.record.opCount);
  const shortBy = params.record.opCount - theirs.length;

  if (shortBy === 0) {
    const digest = toHex(
      await checkpointDigest({
        familyId: params.familyId,
        keyEpoch: params.keyEpoch,
        opIds: theirs,
      }),
    );
    // The fast sign that everything agreed. 3.6 keeps the sets in the comparison all the same:
    // they are what a divergence is explained with, below.
    if (digest === params.record.digest) return null;
  }

  const theirSet = new Set(theirs);
  const mine = params.journalOpIds.filter((opId) => !ownSkipped.has(opId));
  const missingThere = mine.filter((opId) => !theirSet.has(opId) && !theirSkipped.has(opId));
  // `T \ (M ∪ S_M)`: what the checkpoint counts and this device could not rebuild. An identifier
  // this device skipped itself is forgiven by being rebuildable all the same — it was read from
  // the journal, so it is in `journalOpIds` and takes its place in the prefix.
  //
  // Zero with the digests still apart is a real answer and not a missing one: the prefix is as
  // long as the checkpoint counts, so nothing is *absent*, and what differs is which identifier
  // stands in it. This device never saw the author's list and cannot name that identifier — it
  // reports the disagreement and leaves the naming to a full rebuild.
  const missingHere = shortBy;

  return {
    reason: "journal_diverged",
    deviceId: params.deviceId,
    seq: params.seq,
    index: params.record.index,
    ownCount: mine.length,
    checkpointCount: params.record.opCount,
    missingHere,
    missingThere: missingThere.length,
    examples: missingThere.slice(0, ALARM_EXAMPLES),
  };
}

/** The chain state of one device, and the alarm a break in it raises. */
export function chainBreak(
  deviceId: string,
  seq: number,
  index: number,
  ownCount: number,
  checkpointCount: number,
): CheckpointAlarm {
  return {
    reason: "chain_broken",
    deviceId,
    seq,
    index,
    ownCount,
    checkpointCount,
    missingHere: 0,
    missingThere: 0,
    examples: [],
  };
}
