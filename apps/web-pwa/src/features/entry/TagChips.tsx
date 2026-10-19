import { useState, type KeyboardEvent } from "react";
import { MAX_TAGS_PER_TRANSACTION, TAG_NAME_MAX_LENGTH, type BudgetState } from "@family-budget/domain";
import { Icon } from "../../components/Icon";
import { plainInputValue } from "../../plain-text";
import { frequentTags, tagRoom, type EntryDraft } from "./entry-model";

/**
 * Метки операции (план волны 2, §1.2): частые активные — чипами, выбранные — нажатыми; «+ метка»
 * называет новую, и она создаётся той же записью, что и операция. Больше
 * `MAX_TAGS_PER_TRANSACTION` не выбрать: чипы перестают добавлять, и это сказано словами.
 */
export function TagChips({ budget, draft, onChange }: { readonly budget: BudgetState; readonly draft: EntryDraft; readonly onChange: (change: (draft: EntryDraft) => EntryDraft) => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const frequent = frequentTags(budget);
  const known = new Map((budget.tags ?? []).map((tag) => [tag.id, tag.name]));
  const shown = [...frequent.map((tag) => tag.id), ...draft.tagIds.filter((id) => !frequent.some((tag) => tag.id === id))];
  const room = tagRoom(draft);
  const toggle = (id: string) => onChange((current) => (current.tagIds.includes(id)
    ? { ...current, tagIds: current.tagIds.filter((item) => item !== id) }
    : tagRoom(current) > 0 ? { ...current, tagIds: [...current.tagIds, id] } : current));
  const add = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    onChange((current) => (tagRoom(current) > 0 && !current.newTags.includes(trimmed) ? { ...current, newTags: [...current.newTags, trimmed] } : current));
    setName("");
    setAdding(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    }
  };
  return (
    <fieldset className="tag-chips">
      <legend className="visually-hidden">Метки</legend>
      <div className="chip-row">
        {shown.map((id) => (
          <button key={id} className="chip" type="button" aria-pressed={draft.tagIds.includes(id)} onClick={() => toggle(id)}>
            <span className="chip-face"><Icon name="hash" size={20} /><bdi dir="auto">{known.get(id) ?? "метка"}</bdi></span>
          </button>
        ))}
        {draft.newTags.map((tag) => (
          <button key={`new:${tag}`} className="chip" type="button" aria-pressed="true" aria-label={`Новая метка «${tag}», убрать`} onClick={() => onChange((current) => ({ ...current, newTags: current.newTags.filter((item) => item !== tag) }))}>
            <span className="chip-face"><Icon name="hash" size={20} /><bdi dir="auto">{tag}</bdi></span>
          </button>
        ))}
        {room > 0 && !adding ? <button className="chip add-chip" type="button" aria-expanded={false} onClick={() => setAdding(true)}><span className="chip-face"><Icon name="plus" size={20} /><span className="visually-hidden">+ </span>метка</span></button> : null}
      </div>
      {adding ? <div className="tag-new">
        <div className="field">
          <label htmlFor="entry-new-tag">Новая метка</label>
          <input id="entry-new-tag" dir="auto" autoComplete="off" maxLength={TAG_NAME_MAX_LENGTH} value={name} onChange={(event) => setName(plainInputValue(event.currentTarget))} onKeyDown={onKeyDown} />
        </div>
        <button className="secondary-button" type="button" onClick={add}>Добавить</button>
      </div> : null}
      {room <= 0 ? <p className="field-hint">Меток на одной операции — не больше {MAX_TAGS_PER_TRANSACTION}.</p> : null}
    </fieldset>
  );
}
