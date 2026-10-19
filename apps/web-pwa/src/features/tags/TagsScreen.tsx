import { useMemo, useState, type FormEvent } from "react";
import {
  archiveTag,
  createTag,
  deleteTag,
  renameTag,
  restoreTag,
  TAG_NAME_MAX_LENGTH,
  type BudgetState,
  type Tag,
} from "@family-budget/domain";
import { TitleBar } from "../../components/TitleBar";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useFocusAfterRender } from "../../components/focus-after-render";
import { Icon } from "../../components/Icon";
import { useFormDraft } from "../../navigation/draft-guard";
import { plainInputValue } from "../../plain-text";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { archivedNamesake, deleteRefusal, tagCountWords, tagErrorText, tagsView, type TagRow } from "./tags-model";

export interface TagsScreenProps {
  readonly budget: BudgetState;
  readonly write: BudgetWriter;
  readonly onBack: () => void;
}

/** `id` кнопок и поля строки — по идентификатору метки: фокус следует за меткой между списками. */
const editId = (tagId: string) => `tag-edit-${tagId}`;
const renameId = (tagId: string) => `tag-rename-${tagId}`;
const archiveId = (tagId: string) => `tag-archive-${tagId}`;
const restoreId = (tagId: string) => `tag-restore-${tagId}`;

/** Отказ у строки: к какой метке он относится и что сказать. */
interface RowNotice {
  readonly tagId: string;
  readonly message: string;
}

/**
 * «Метки» (план волны 2, §1.8): новая метка, список с числом операций у каждой, переименование на
 * месте, архив и возврат, удаление — только неиспользуемой: на метку, которая стоит на операциях,
 * «Удалить» отвечает словами домена сразу и предлагает архив (D-034). Две формы — новая метка и
 * переименование — черновики экрана: уход с набранным спрашивает диалог приложения.
 */
export function TagsScreen({ budget, write, onBack }: TagsScreenProps) {
  const view = useMemo(() => tagsView(budget), [budget]);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ readonly tag: Tag; readonly name: string } | null>(null);
  const [notice, setNotice] = useState<RowNotice | null>(null);
  const [removing, setRemoving] = useState<TagRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // Фокус после действия на месте — на том, что его продолжает (ревью 2c, MEDIUM-3). Кнопки строки
  // во время записи не выключаются, а говорят `aria-disabled`: выключенная теряет фокус.
  const focusAfterRender = useFocusAfterRender();

  const creating = useFormDraft({ label: "новая метка", dirty: name.trim() !== "", discard: () => setName("") });
  const renaming = useFormDraft({
    label: editing === null ? "новое имя метки" : `новое имя метки «${editing.tag.name}»`,
    dirty: editing !== null && editing.name.trim() !== editing.tag.name,
    discard: () => setEditing(null),
  });
  const namesake = archivedNamesake(budget, name);

  /** Запись строки: отказ — у этой строки, удача — в строке состояния экрана и фокус на `then`. */
  const rowWrite = async (tagId: string, change: (state: BudgetState) => BudgetState, done: string, then?: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setNotice(null);
    try {
      await write.run(change);
      setStatus(done);
      if (then !== undefined) focusAfterRender(then);
      return true;
    } catch (cause) {
      setNotice({ tagId, message: tagErrorText(cause) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || name.trim() === "") return;
    const typed = name.trim();
    const ticket = creating.begin();
    setBusy(true);
    setCreateError(null);
    try {
      await write.run((state) => createTag(state, name).state);
      creating.succeed(ticket);
      setName("");
      setStatus(`Метка «${typed}» добавлена.`);
      // «Добавить» пустого поля молчит — фокус в поле, где набирают следующую.
      focusAfterRender("tag-new-name");
    } catch (cause) {
      creating.fail(ticket);
      setCreateError(tagErrorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const restoreNamesake = async (tag: Tag) => {
    if (await rowWrite(tag.id, (state) => restoreTag(state, tag.id), `Метка «${tag.name}» снова в выборе.`, editId(tag.id))) setName("");
  };
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (editing === null || busy) return;
    const { tag, name: next } = editing;
    const ticket = renaming.begin();
    const ok = await rowWrite(tag.id, (state) => renameTag(state, tag.id, next), `Метка «${tag.name}» теперь «${next.trim()}».`, editId(tag.id));
    if (ok) {
      renaming.succeed(ticket);
      setEditing(null);
    } else {
      renaming.fail(ticket);
    }
  };
  const startRename = (tag: Tag) => {
    if (busy) return;
    setEditing({ tag, name: tag.name });
    setNotice(null);
    focusAfterRender(renameId(tag.id));
  };
  const cancelRename = (tag: Tag) => {
    if (busy) return;
    setEditing(null);
    setNotice(null);
    focusAfterRender(editId(tag.id));
  };
  const askDelete = (row: TagRow) => {
    if (busy) return;
    const refusal = deleteRefusal(budget, row.tag.id);
    if (refusal !== null) {
      setNotice({ tagId: row.tag.id, message: refusal });
      return;
    }
    setNotice(null);
    setRemoving(row);
  };

  const row = (item: TagRow) => {
    const { tag, count } = item;
    const isEditing = editing?.tag.id === tag.id;
    const rowNotice = notice?.tagId === tag.id ? notice.message : null;
    return (
      <li key={tag.id} className="manage-row tag-row">
        {isEditing ? (
          <form className="tag-rename" onSubmit={(event) => void rename(event)} noValidate>
            <div className="field">
              <label htmlFor={renameId(tag.id)}>Новое имя метки «<bdi dir="auto">{tag.name}</bdi>»</label>
              <input id={renameId(tag.id)} dir="auto" autoComplete="off" maxLength={TAG_NAME_MAX_LENGTH} value={editing.name} readOnly={busy} aria-invalid={rowNotice === null ? undefined : true} aria-describedby={rowNotice === null ? undefined : `tag-notice-${tag.id}`} onChange={(event) => setEditing({ tag, name: plainInputValue(event.currentTarget) })} />
            </div>
            <div className="tag-actions">
              <button className="primary-button" type="submit" aria-disabled={busy || undefined} aria-busy={busy}>Сохранить</button>
              <button className="secondary-button" type="button" aria-disabled={busy || undefined} onClick={() => cancelRename(tag)}>Отмена</button>
            </div>
          </form>
        ) : <>
          <div className="tag-copy">
            <span className="icon-plate tone-neutral" aria-hidden="true"><Icon name="hash" size={24} /></span>
            <span className="manage-copy"><strong><bdi dir="auto">{tag.name}</bdi></strong><small>{tagCountWords(count)}</small></span>
          </div>
          <div className="tag-actions">
            <button id={editId(tag.id)} className="secondary-button" type="button" aria-disabled={busy || undefined} aria-label={`Переименовать метку «${tag.name}»`} onClick={() => startRename(tag)}>
              <span className="icon-label"><Icon name="pencil" size={20} />Изменить</span>
            </button>
            {tag.active ? (
              <button id={archiveId(tag.id)} className="secondary-button" type="button" aria-disabled={busy || undefined} aria-label={`Убрать метку «${tag.name}» в архив`} onClick={() => void rowWrite(tag.id, (state) => archiveTag(state, tag.id), `Метка «${tag.name}» в архиве; на операциях она осталась.`, restoreId(tag.id))}>
                <span className="icon-label"><Icon name="archive" size={20} />В архив</span>
              </button>
            ) : (
              <button id={restoreId(tag.id)} className="secondary-button" type="button" aria-disabled={busy || undefined} aria-label={`Вернуть метку «${tag.name}» из архива`} onClick={() => void rowWrite(tag.id, (state) => restoreTag(state, tag.id), `Метка «${tag.name}» снова в выборе.`, archiveId(tag.id))}>
                Вернуть
              </button>
            )}
            <button className="quiet-button danger-text" type="button" aria-disabled={busy || undefined} aria-label={`Удалить метку «${tag.name}»`} onClick={() => askDelete(item)}>Удалить</button>
          </div>
        </>}
        {rowNotice === null ? null : <p className="field-error tag-notice" id={`tag-notice-${tag.id}`} role="alert">{rowNotice}</p>}
      </li>
    );
  };

  return (
    <div className="manage-screen tags-screen">
      <TitleBar back={{ label: "Ещё", onClick: onBack }} title="Метки" />
      <header className="manage-head">
        <p>Метка — пометка поверх категории: «отпуск», «ремонт», «дача». Её ставят при записи операции, а деньги по меткам видны в «Отчётах». Ни одна сумма бюджета от меток не зависит.</p>
      </header>

      <form className="tag-new manage-new-tag" onSubmit={(event) => void create(event)} noValidate>
        <div className="field">
          <label htmlFor="tag-new-name">Новая метка</label>
          <input id="tag-new-name" dir="auto" autoComplete="off" maxLength={TAG_NAME_MAX_LENGTH} placeholder="Например, отпуск" value={name} readOnly={busy} aria-invalid={createError === null ? undefined : true} aria-describedby={createError === null ? (namesake === null ? undefined : "tag-new-hint") : "tag-new-error"} onChange={(event) => { setName(plainInputValue(event.currentTarget)); setCreateError(null); }} />
        </div>
        <button className="primary-button" type="submit" aria-disabled={busy || name.trim() === "" || undefined} aria-busy={busy}>Добавить</button>
      </form>
      {namesake === null ? null : (
        <div className="sheet-hint manage-hint" id="tag-new-hint" role="status">
          <span>Метка «<bdi dir="auto">{namesake.name}</bdi>» уже была — сейчас в архиве. Вернуть её, а не заводить вторую?</span>
          <button className="secondary-button" type="button" aria-disabled={busy || undefined} aria-label={`Вернуть метку «${namesake.name}» из архива`} onClick={() => void restoreNamesake(namesake)}>Вернуть из архива</button>
        </div>
      )}
      {createError === null ? null : <p className="field-error" id="tag-new-error" role="alert">{createError}</p>}
      <p className="manage-status" role="status">{status}</p>

      <section className="manage-group" aria-labelledby="tags-active-title">
        <h2 id="tags-active-title" className="list-kicker">Метки</h2>
        {view.active.length === 0 ? <p className="field-hint">Меток пока нет. Добавьте первую здесь или прямо при записи операции — кнопкой «+ метка».</p> : (
          <ul className="list-card manage-list">{view.active.map(row)}</ul>
        )}
      </section>

      {view.archived.length === 0 ? null : (
        <section className="manage-group" aria-labelledby="tags-archived-title">
          <h2 id="tags-archived-title" className="list-kicker">В архиве</h2>
          <p className="field-hint">Архивная метка не предлагается при записи, но остаётся на своих операциях.</p>
          <ul className="list-card manage-list">{view.archived.map(row)}</ul>
        </section>
      )}

      {removing === null ? null : (
        <ConfirmDialog
          title={`Удалить метку «${removing.tag.name}»?`}
          description="Метка не стоит ни на одной операции, и удаление ничего в бюджете не изменит. Вернуть её будет нельзя — только завести заново."
          cancelLabel="Оставить"
          confirmLabel="Удалить метку"
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            // Строки больше нет: фокус — на заголовок списка, где она стояла.
            void rowWrite(target.tag.id, (state) => deleteTag(state, target.tag.id), `Метка «${target.tag.name}» удалена.`, target.tag.active ? "tags-active-title" : "tags-archived-title");
          }}
        />
      )}
    </div>
  );
}
