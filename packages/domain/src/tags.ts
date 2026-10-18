import { documentIds } from "./identity.js";
import {
  labelKey,
  normalizeLabel,
  TAG_NAME_MAX_LENGTH,
  TextValidationError,
  type TextErrorCode,
} from "./text.js";
import type { BudgetState, Tag, TagId, Transaction } from "./types.js";

/**
 * Tags: labels a family puts on operations, and the transitions that keep every label resolvable.
 *
 * A tag is attribution in the sense a participant is (`Member`): no figure of the budget reads it.
 * What this module guarantees is the one thing the domain is strict about — every `tagIds` entry
 * of every operation names a tag the state holds — and it guarantees it by construction: deleting a
 * tag takes it off every operation in the same transition, so there is never a state in between
 * that `calculateBudget` would refuse.
 */

export type TagErrorCode =
  | "name_required"
  | "name_too_long"
  | "name_forbidden_characters"
  | "name_mixed_scripts"
  | "duplicate_name"
  | "id_required"
  | "duplicate_id"
  | "unknown_tag";

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

/** Trims and normalises a tag name the way it will be stored, or refuses it. */
export function normalizeTagName(value: string): string {
  try {
    return normalizeLabel(value, TAG_NAME_MAX_LENGTH);
  } catch (error) {
    if (!(error instanceof TextValidationError)) throw error;
    const [code, message] = NAME_REFUSALS[error.code];
    return fail(code, "name", message);
  }
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
 * offer to restore it instead. Nothing else in the state moves.
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
 * Deletes a tag and takes it off every operation in the same transition.
 *
 * One transition and not two, because the state between them — an operation naming a tag that
 * no longer exists — is one the domain refuses. An operation left with no tags loses the field
 * rather than keeping an empty list. Only labels change: no amount, date or account moves, so no
 * figure of any budget does either.
 */
export function deleteTag(state: BudgetState, id: TagId): BudgetState {
  requireTag(state, id);
  return {
    ...state,
    tags: (state.tags ?? []).filter((item) => item.id !== id),
    transactions: state.transactions.map((transaction): Transaction => {
      const tagIds = transaction.tagIds;
      if (tagIds === undefined || !tagIds.includes(id)) return transaction;
      const { tagIds: _removed, ...untagged } = transaction;
      const remaining = tagIds.filter((tagId) => tagId !== id);
      return remaining.length === 0 ? untagged : { ...untagged, tagIds: remaining };
    }),
  };
}
