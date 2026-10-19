import { deleteTag, labelKey, TagValidationError, tagUsage, type BudgetState, type Tag } from "@family-budget/domain";
import { plural } from "../../plural";
import { writeFailureText } from "../../write/useBudgetWrite";

/**
 * Метки (план волны 2, §1.8): список с числом операций, без React. Метка справочная (D-034): ни одна
 * сумма её не читает, переименование не пишет ни одной операции, а удалить можно только ту, что не
 * стоит ни на одной операции и ни в одном правиле, — домен отказывает сам (`deleteTag`).
 */

export interface TagRow {
  readonly tag: Tag;
  /** Сколько операций несут метку. */
  readonly count: number;
}

export interface TagsView {
  readonly active: readonly TagRow[];
  readonly archived: readonly TagRow[];
}

/** Активные и архивные, каждые — по алфавиту: метку ищут глазами по имени. */
export function tagsView(state: BudgetState): TagsView {
  const usage = tagUsage(state);
  const rows = [...(state.tags ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name, "ru"))
    .map((tag) => ({ tag, count: usage.get(tag.id) ?? 0 }));
  return { active: rows.filter((row) => row.tag.active), archived: rows.filter((row) => !row.tag.active) };
}

/** «12 операций», «ни одной операции». */
export function tagCountWords(count: number): string {
  return count === 0 ? "ни одной операции" : plural(count, ["операция", "операции", "операций"]);
}

/**
 * Можно ли удалить метку — ответ домена на нынешнем бюджете, до вопроса: метку на операциях не
 * удаляют, а убирают в архив, и человек слышит это сразу, а не после «Удалить?».
 */
export function deleteRefusal(state: BudgetState, id: string): string | null {
  try {
    deleteTag(state, id);
    return null;
  } catch (error) {
    return tagErrorText(error);
  }
}

/**
 * Архивная метка с этим именем, пока активной тёзки нет: её предлагают вернуть, а не заводить вторую.
 * С активной тёзкой ответ — отказ домена «уже существует», а не предложение.
 */
export function archivedNamesake(state: BudgetState, name: string): Tag | null {
  if (name.trim() === "") return null;
  const key = labelKey(name.trim());
  const same = (state.tags ?? []).filter((tag) => labelKey(tag.name) === key);
  if (same.some((tag) => tag.active)) return null;
  return same[0] ?? null;
}

/** Отказ — словами домена; задержка, конфликт и сбой — общими словами записи. */
export function tagErrorText(error: unknown): string {
  if (error instanceof TagValidationError) return error.message;
  return writeFailureText(error);
}
