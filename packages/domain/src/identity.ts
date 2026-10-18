import type { BudgetState, StableId } from "./types.js";

/*
 * ─────────────────────────── Identity ───────────────────────────
 *
 * Two devices of one family may each notice that the month is over and each open the new one,
 * offline, before either has heard of the other. They must not end up with two budgets for one
 * month.
 *
 * The journal merges by "last writer wins by (lamport, digest)" per `(entity, targetId)`, so
 * the whole question is the identifier. A `crypto.randomUUID()` would make the two devices name
 * two different budgets, both would survive the merge, and the family would own two Septembers.
 *
 * So the identifier is derived, not drawn: a pure function of things both devices already agree
 * on — the identifier of the budget being carried forward, and the target month. Both of those
 * came out of the shared journal, so both devices compute the same name, the two creations meet
 * as one entity, and the merge decides between two spellings of the same September rather than
 * between two Septembers. The value that settles the conflict is not chosen by the party the
 * conflict is about.
 *
 * This lived in `rollover.ts`, the first thing that needed it. Every derived identifier of the
 * model is built here now, and nothing here imports a calculation: a module that both derives
 * identifiers and computes budgets would make every future caller of the one depend on the other.
 */

/** The separator: an identifier may not carry a control character, so no two joins can collide. */
const KEY_SEPARATOR = "\u0000";

const FNV_OFFSET = 2_166_136_261;
const FNV_PRIME = 16_777_619;

/** FNV-1a over the UTF-16 code units, low byte first, so the host's encoding cannot change it. */
function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    hash = Math.imul(hash ^ (code & 0xff), FNV_PRIME);
    hash = Math.imul(hash ^ (code >>> 8), FNV_PRIME);
  }
  return hash >>> 0;
}

/** MurmurHash3's finalizer: spreads every input bit across the whole word. */
function avalanche(value: number): number {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85eb_ca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2_ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * A name-based identifier, in the shape everything downstream demands of one.
 *
 * The shape is not decoration: a backup is refused unless every identifier in it is a UUID, so a
 * readable name like `budget:2026-09` would produce a state the family could never export. The
 * digest fills the random part and the version nibble says 8 — the version reserved for exactly
 * this, an identifier a program derives rather than draws.
 *
 * Four hash lanes, each salted with its own index, give the 128 bits. This is not a
 * cryptographic hash and does not need to be: nothing here defends against an adversary picking
 * a collision, it only has to keep a household's few dozen derived names apart from each other.
 */
export function carriedId(...parts: readonly string[]): StableId {
  const text = parts.join(KEY_SEPARATOR);
  const digits = [0, 1, 2, 3]
    .map((lane) => avalanche(fnv1a(`${lane}${KEY_SEPARATOR}${text}`)).toString(16).padStart(8, "0"))
    .join("");
  // RFC 9562 variant bits: the nibble keeps its own two low bits and takes 10 on top.
  const variant = ((Number.parseInt(digits[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    digits.slice(0, 8),
    digits.slice(8, 12),
    `8${digits.slice(13, 16)}`,
    `${variant}${digits.slice(17, 20)}`,
    digits.slice(20, 32),
  ].join("-");
}

/**
 * Every identifier the document holds, budget lines included, in one census.
 *
 * Identifiers are unique across the whole document, not only inside each collection: a backup
 * keeps one flat set of them and refuses a file in which two entities of different kinds share
 * one. So whatever mints or derives a new identifier has to check it against all of them, and
 * a census that forgot a collection would let a derived name land on top of an entity of that
 * kind. Duplicates are returned as they occur; deciding what a repeat means is the caller's job.
 */
export function documentIds(state: BudgetState): StableId[] {
  return [
    ...(state.members ?? []).map((item) => item.id),
    ...(state.tags ?? []).map((item) => item.id),
    ...state.accounts.map((item) => item.id),
    ...state.categories.map((item) => item.id),
    ...state.budgets.flatMap((item) => [item.id, ...item.lines.map((line) => line.id)]),
    ...state.goals.map((item) => item.id),
    ...state.annualCommitments.map((item) => item.id),
    ...state.scheduledExpenses.map((item) => item.id),
    ...state.transactions.map((item) => item.id),
  ];
}
