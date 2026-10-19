import { documentIds } from "./identity.js";
import { COLLECTION_LIMITS } from "./limits.js";
import {
  isReadableName,
  labelKey,
  normalizeLabel,
  TAG_NAME_MAX_LENGTH,
  TextValidationError,
  type TextErrorCode,
} from "./text.js";
import type { BudgetState, Tag, TagId } from "./types.js";

/**
 * Tags: labels a family puts on operations, and the transitions that keep every label resolvable.
 *
 * A tag is attribution in the sense a participant is (`Member`): no figure of the budget reads it.
 * What this module guarantees is the one thing the domain is strict about — every `tagIds` entry
 * of every operation names a tag the state holds — and it guarantees it by refusal: a tag that is
 * on an operation is archived, never deleted, so there is never a state `calculateBudget` refuses.
 */

export type TagErrorCode =
  | "name_required"
  | "name_too_long"
  | "name_forbidden_characters"
  | "name_mixed_scripts"
  | "name_unreadable"
  | "duplicate_name"
  | "limit_reached"
  | "id_required"
  | "duplicate_id"
  | "unknown_tag"
  | "tag_in_use";

/** Refusal a person is meant to read: `code` for the caller, `message` for the screen. */
export class TagValidationError extends Error {
  readonly code: TagErrorCode;
  readonly field: "name" | "id";

  constructor(code: TagErrorCode, field: "name" | "id", message: string) {
    super(message);
    this.name = "TagValidationError";
    this.code = code;
    this.field = field;
  }
}

function fail(code: TagErrorCode, field: "name" | "id", message: string): never {
  throw new TagValidationError(code, field, message);
}

const NAME_REFUSALS: Readonly<Record<TextErrorCode, readonly [TagErrorCode, string]>> = {
  required: ["name_required", "Укажите название метки."],
  too_long: ["name_too_long", `Не более ${TAG_NAME_MAX_LENGTH} символов.`],
  forbidden_characters: ["name_forbidden_characters", "Уберите скрытые или служебные символы."],
  mixed_scripts: ["name_mixed_scripts", "Не смешивайте похожие символы разных алфавитов."],
};

/**
 * Trims and normalises a tag name the way it will be stored, or refuses it: the text rule of every
 * label, and a name someone can read — a letter or a digit, no combining mark first, no blank that
 * only looks like text (`isReadableName`).
 */
export function normalizeTagName(value: string): string {
  let normalized: string;
  try {
    normalized = normalizeLabel(value, TAG_NAME_MAX_LENGTH);
  } catch (error) {
    if (!(error instanceof TextValidationError)) throw error;
    const [code, message] = NAME_REFUSALS[error.code];
    return fail(code, "name", message);
  }
  if (!isReadableName(normalized)) fail("name_unreadable", "name", "В названии метки нужны буквы или цифры.");
  return normalized;
}

/**
 * The tag carrying that name, archived ones included. The interface uses it to offer restoring an
 * archived tag instead of creating a second one with the same name, as it does for categories.
 */
export function findTagByName(state: Pick<BudgetState, "tags">, name: string): Tag | undefined {
  const key = labelKey(name);
  return (state.tags ?? []).find((tag) => labelKey(tag.name) === key);
}

/**
 * A list of tags as an operation stores it: no repeats, in one order, and no empty list.
 *
 * Sorted so that the same set of tags is one value however it was picked — two devices that tag
 * an operation «Дом» then «Отпуск» and «Отпуск» then «Дом» write equal fields, and the journal
 * sees no change. An empty selection comes back as `undefined`: an operation without tags omits
 * the field, because an empty list and no list are two different values to every reader.
 */
export function normalizeTagIds(ids: readonly TagId[]): readonly TagId[] | undefined {
  const unique = [...new Set(ids)].sort();
  return unique.length === 0 ? undefined : unique;
}

export interface TagCreation {
  readonly state: BudgetState;
  readonly tag: Tag;
}

/**
 * Creates an active tag. Refuses an empty or malformed name and a name an active tag already
 * carries; an archived namesake is not a duplicate, and {@link findTagByName} lets the caller
 * offer to restore it instead. Refuses the tag past `COLLECTION_LIMITS.tags`, archived ones
 * counted, because a backup counts them all. Nothing else in the state moves.
 */
export function createTag(
  state: BudgetState,
  name: string,
  makeId: () => TagId = () => crypto.randomUUID(),
): TagCreation {
  const normalized = normalizeTagName(name);
  const key = labelKey(normalized);
  const tags = state.tags ?? [];
  if (tags.some((tag) => tag.active && labelKey(tag.name) === key)) {
    fail("duplicate_name", "name", "Активная метка с таким названием уже существует.");
  }
  if (tags.length >= COLLECTION_LIMITS.tags) {
    fail("limit_reached", "name", `Меток уже ${COLLECTION_LIMITS.tags} — это предел. Удалите метки, которых нет ни на одной операции.`);
  }

  const id = makeId();
  if (typeof id !== "string" || id.trim().length === 0) {
    fail("id_required", "id", "Не удалось создать идентификатор метки.");
  }
  // Identifiers are unique across the whole document, not only among tags: a backup refuses a
  // file in which a tag and a transaction share one.
  if (documentIds(state).includes(id)) {
    fail("duplicate_id", "id", "Не удалось создать уникальный идентификатор метки.");
  }

  const tag: Tag = { id, name: normalized, active: true };
  return { state: { ...state, tags: [...tags, tag] }, tag };
}

function requireTag(state: BudgetState, id: TagId): Tag {
  const tag = (state.tags ?? []).find((item) => item.id === id);
  if (tag === undefined) fail("unknown_tag", "id", "Метка не найдена.");
  return tag;
}

/**
 * Archives a tag: it is no longer offered for new operations and stays on every operation that
 * carries it, so no history loses a label. Archiving an archived tag changes nothing.
 */
export function archiveTag(state: BudgetState, id: TagId): BudgetState {
  const tag = requireTag(state, id);
  if (!tag.active) return state;
  return {
    ...state,
    tags: (state.tags ?? []).map((item) => (item.id === id ? { ...item, active: false } : item)),
  };
}

/**
 * Deletes a tag no operation and no recurring rule carries, and refuses one that is on any of them:
 * that one is archived instead ({@link archiveTag}).
 *
 * Deleting a tag used to take it off every operation in the same transition. On one device that is
 * one tidy change; through the journal it is one whole-entity update per tagged operation, and the
 * journal settles each entity by last writer wins — so a family member correcting the amount of one
 * of those operations on another device at the same moment could have the correction silently
 * replaced by the copy that only lost its tag. A refusal moves no operation at all, and the archive
 * keeps every history labelled.
 */
export function deleteTag(state: BudgetState, id: TagId): BudgetState {
  requireTag(state, id);
  if (state.transactions.some((transaction) => transaction.tagIds?.includes(id) === true)) {
    fail("tag_in_use", "id", "Метка стоит на операциях. Её можно убрать в архив: на операциях она останется.");
  }
  // A rule writes its tags onto every occurrence, so a tag a rule carries is in use as well.
  if ((state.recurringRules ?? []).some((rule) => rule.template.tagIds?.includes(id) === true)) {
    fail("tag_in_use", "id", "Метка стоит в регулярной операции. Её можно убрать в архив: в правиле она останется.");
  }
  return { ...state, tags: (state.tags ?? []).filter((item) => item.id !== id) };
}

/** A change to a tag; a field left out stays as it is. */
export interface TagPatch {
  readonly name?: string;
}

/**
 * Renames a tag. The name follows the rule of {@link createTag}; a duplicate counts only while the
 * tag is active, as for creation. The operations that carry the tag keep carrying it — they name it
 * by identifier — so no operation is written, and a concurrent edit of one on another device is never
 * overwritten by a rename. A patch that changes nothing returns the very same state.
 */
export function updateTag(state: BudgetState, id: TagId, patch: TagPatch): BudgetState {
  const tag = requireTag(state, id);
  if (patch.name === undefined) return state;
  const name = normalizeTagName(patch.name);
  if (name === tag.name) return state;
  const key = labelKey(name);
  if (tag.active && (state.tags ?? []).some((item) => item.id !== id && item.active && labelKey(item.name) === key)) {
    fail("duplicate_name", "name", "Активная метка с таким названием уже существует.");
  }
  return { ...state, tags: (state.tags ?? []).map((item) => (item.id === id ? { ...item, name } : item)) };
}

/** {@link updateTag} with a new name — the one change a tag has. */
export function renameTag(state: BudgetState, id: TagId, name: string): BudgetState {
  return updateTag(state, id, { name });
}

/**
 * Brings a tag back from the archive, so it is offered for new operations again. Refuses when an
 * active tag already carries its name; an active tag is left as it is.
 */
export function restoreTag(state: BudgetState, id: TagId): BudgetState {
  const tag = requireTag(state, id);
  if (tag.active) return state;
  const key = labelKey(tag.name);
  if ((state.tags ?? []).some((item) => item.id !== id && item.active && labelKey(item.name) === key)) {
    fail("duplicate_name", "name", "Активная метка с таким названием уже существует.");
  }
  return { ...state, tags: (state.tags ?? []).map((item) => (item.id === id ? { ...item, active: true } : item)) };
}

/** How many operations carry each tag — the count the list of tags shows. */
export function tagUsage(state: Pick<BudgetState, "transactions">): ReadonlyMap<TagId, number> {
  const counts = new Map<TagId, number>();
  for (const transaction of state.transactions) {
    for (const id of transaction.tagIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
