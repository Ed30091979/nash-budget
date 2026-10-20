import { useMemo, useState } from "react";
import {
  archiveTag,
  createTag,
  deleteTag,
  findTagByName,
  renameTag,
  restoreTag,
  TAG_NAME_MAX_LENGTH,
  type BudgetState,
  type Tag,
} from "@family-budget/domain";
import { TitleBar, TitleBarAction } from "../../components/TitleBar";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { FormSheet } from "../../components/FormSheet";
import { TagsIllustration } from "../../components/illustrations/TagsIllustration";
import { useFocusAfterRender } from "../../components/focus-after-render";
import { Icon } from "../../components/Icon";
import { useFormDraft } from "../../navigation/draft-guard";
import { softHyphenate } from "../../hyphenation";
import { plainInputValue } from "../../plain-text";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { archivedNamesake, deleteRefusal, tagCountWords, tagErrorText, tagsView, type TagRow } from "./tags-model";

export interface TagsScreenProps {
  readonly budget: BudgetState;
  readonly write: BudgetWriter;
  readonly onBack: () => void;
}

/** `id` строки и кнопок листа — по идентификатору метки: фокус следует за меткой между списками. */
const rowId = (tagId: string) => `tag-row-${tagId}`;
const renameId = (tagId: string) => `tag-rename-${tagId}`;
const archiveId = (tagId: string) => `tag-archive-${tagId}`;
const restoreId = (tagId: string) => `tag-restore-${tagId}`;
const deleteId = (tagId: string) => `tag-delete-${tagId}`;
const ADD_ID = "tags-add";
const CREATE_ID = "tags-create";
const NEW_NAME_ID = "tag-new-name";
const EMPTY_NAME_TEXT = "Введите название.";

/** Быстрые метки пустого состояния (14): одним касанием, без набора. */
export const QUICK_TAGS: readonly string[] = ["отпуск", "дача", "ремонт", "подарки"];

/** Доступное имя строки: имя, число операций и что сделает касание. */
export function tagRowLabel(row: TagRow): string {
  return `${row.tag.name}: ${tagCountWords(row.count)}. Изменить`;
}

/** Какой лист открыт: «Новая метка» (и откуда — туда вернуть фокус) или метка для правки. */
type TagSheetState =
  | { readonly kind: "new"; readonly opener: string }
  | { readonly kind: "edit"; readonly tagId: string };

/**
 * «Метки» (дизайн 5.0, макет 14). Пусто — иллюстрация, «Создать метку» и быстрые метки (R2). С
 * метками — белая карточка строк: «#», имя, число операций, шеврон; ниже — архив. «+» в строке
 * заголовка открывает лист «Новая метка»; касание строки — лист «Метка»: переименование, архив и
 * удаление. Переименование — листом, а не полем на месте строки: та же анатомия, что у счёта и
 * категории, и строке списка не нужно трёх кнопок. Удаляется только метка без операций и без
 * правил: на используемую «Удалить» сразу отвечает словами домена и предлагает архив (D-034); на
 * неиспользуемую — вопрос приложения. Набранное в листе — черновик экрана: уход спрашивает реестр,
 * а крестик и Esc — свой вопрос.
 */
export function TagsScreen({ budget, write, onBack }: TagsScreenProps) {
  const view = useMemo(() => tagsView(budget), [budget]);
  const [sheet, setSheet] = useState<TagSheetState | null>(null);
  const [name, setName] = useState("");
  const [editName, setEditName] = useState("");
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetStatus, setSheetStatus] = useState("");
  const [discarding, setDiscarding] = useState(false);
  const [removing, setRemoving] = useState<TagRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const empty = view.active.length === 0 && view.archived.length === 0;
  // Фокус после действия — на том, что его продолжает (ревью 2c, MEDIUM-3). Кнопки во время записи
  // не выключаются, а говорят `aria-disabled`: выключенная теряет фокус.
  const focusAfterRender = useFocusAfterRender();

  const all = [...view.active, ...view.archived];
  const editing = sheet?.kind === "edit" ? all.find((row) => row.tag.id === sheet.tagId) ?? null : null;
  const newDirty = sheet?.kind === "new" && name.trim() !== "";
  const editDirty = editing !== null && editName.trim() !== editing.tag.name;
  const creating = useFormDraft({ label: "новая метка", dirty: newDirty, discard: () => setName("") });
  const renaming = useFormDraft({
    label: editing === null ? "новое имя метки" : `новое имя метки «${editing.tag.name}»`,
    dirty: editDirty,
    discard: () => setEditName(editing?.tag.name ?? ""),
  });
  const namesake = sheet?.kind === "new" ? archivedNamesake(budget, name) : null;

  const openNew = (opener: string) => {
    if (busy) return;
    setName("");
    setSheetError(null);
    setSheetStatus("");
    setSheet({ kind: "new", opener });
  };
  const openEdit = (tag: Tag) => {
    if (busy) return;
    setEditName(tag.name);
    setSheetError(null);
    setSheetStatus("");
    setSheet({ kind: "edit", tagId: tag.id });
  };
  /** Лист закрыт: фокус — туда, откуда его открыли, или на строку метки. */
  const closeSheet = (focus?: string) => {
    const back = focus ?? (sheet?.kind === "new" ? sheet.opener : sheet?.kind === "edit" ? rowId(sheet.tagId) : undefined);
    setSheet(null);
    setDiscarding(false);
    setSheetError(null);
    if (back !== undefined) focusAfterRender(back);
  };
  const askClose = () => {
    if (busy) return;
    if (newDirty || editDirty) setDiscarding(true);
    else closeSheet();
  };

  /** Запись из листа: отказ — в листе, удача — в его строке состояния и фокус на `then`. */
  const sheetWrite = async (change: (state: BudgetState) => BudgetState, done: string, then?: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setSheetError(null);
    try {
      await write.run(change);
      setSheetStatus(done);
      if (then !== undefined) focusAfterRender(then);
      return true;
    } catch (cause) {
      setSheetError(tagErrorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (busy) return;
    // Пустое имя — отказ у поля, а не тишина; фокус остаётся в поле (ревью R3, LOW-7).
    if (name.trim() === "") {
      setSheetError(EMPTY_NAME_TEXT);
      focusAfterRender(NEW_NAME_ID);
      return;
    }
    const typed = name.trim();
    const ticket = creating.begin();
    setBusy(true);
    setSheetError(null);
    try {
      const next = await write.run((state) => createTag(state, name).state);
      creating.succeed(ticket);
      setName("");
      setStatus(`Метка «${typed}» добавлена.`);
      const created = findTagByName(next, typed);
      closeSheet(created === undefined ? undefined : rowId(created.id));
    } catch (cause) {
      creating.fail(ticket);
      setSheetError(tagErrorText(cause));
    } finally {
      setBusy(false);
    }
  };
  /** Быстрая метка: запись сразу, фокус — на строку новой метки. */
  const createQuick = async (label: string) => {
    if (busy) return;
    setBusy(true);
    setSheetError(null);
    try {
      const next = await write.run((state) => createTag(state, label).state);
      setStatus(`Метка «${label}» добавлена.`);
      const created = findTagByName(next, label);
      if (created !== undefined) focusAfterRender(rowId(created.id));
    } catch (cause) {
      setStatus(tagErrorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const restoreNamesake = async (tag: Tag) => {
    if (busy) return;
    setBusy(true);
    setSheetError(null);
    try {
      await write.run((state) => restoreTag(state, tag.id));
      setName("");
      setStatus(`Метка «${tag.name}» снова в выборе.`);
      closeSheet(rowId(tag.id));
    } catch (cause) {
      setSheetError(tagErrorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const rename = async () => {
    if (editing === null || busy) return;
    const { tag } = editing;
    if (editName.trim() === tag.name) {
      closeSheet();
      return;
    }
    const ticket = renaming.begin();
    setBusy(true);
    setSheetError(null);
    try {
      await write.run((state) => renameTag(state, tag.id, editName));
      renaming.succeed(ticket);
      setStatus(`Метка «${tag.name}» теперь «${editName.trim()}».`);
      closeSheet(rowId(tag.id));
    } catch (cause) {
      renaming.fail(ticket);
      setSheetError(tagErrorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const askDelete = (row: TagRow) => {
    if (busy) return;
    const refusal = deleteRefusal(budget, row.tag.id);
    if (refusal !== null) {
      setSheetError(refusal);
      return;
    }
    setSheetError(null);
    setRemoving(row);
  };
  /** Строки больше нет: фокус — на соседнюю строку того же списка, иначе на его заголовок. */
  const afterDelete = (row: TagRow): string => {
    const list = row.tag.active ? view.active : view.archived;
    const at = list.findIndex((item) => item.tag.id === row.tag.id);
    const neighbour = list[at + 1] ?? list[at - 1];
    if (neighbour !== undefined) return rowId(neighbour.tag.id);
    if (all.length === 1) return CREATE_ID;
    return row.tag.active ? "tags-archived-title" : "tags-active-title";
  };

  const tagRow = (item: TagRow) => (
    <li key={item.tag.id}>
      <button id={rowId(item.tag.id)} className="dir-row" type="button" aria-label={tagRowLabel(item)} onClick={() => openEdit(item.tag)}>
        <span className="icon-plate dir-plate tone-peach" aria-hidden="true"><Icon name="hash" size={24} /></span>
        <span className="dir-copy" aria-hidden="true"><strong><bdi dir="auto">{softHyphenate(item.tag.name)}</bdi></strong><small>{tagCountWords(item.count)}</small></span>
        <Icon name="chevron-right" size={24} className="row-chevron" />
      </button>
    </li>
  );

  return (
    <div className="manage-screen dir-screen tags-screen">
      {/* «+» в строке заголовка (макет 14): лист «Новая метка» — и из пустого состояния, и над списком. */}
      <TitleBar back={{ label: "Ещё", onClick: onBack }} title="Метки" action={<TitleBarAction id={ADD_ID} icon="plus" label="Новая метка" onClick={() => openNew(ADD_ID)} />} />

      {empty ? (
        <EmptyState
          illustration={<TagsIllustration />}
          title="Меток пока нет"
          text="Метка собирает траты из разных категорий: например, всё на дачу или на отпуск."
          action={{ id: CREATE_ID, label: "Создать метку", onClick: () => openNew(CREATE_ID) }}
          quick={{
            label: "Или одним касанием:",
            busy,
            items: QUICK_TAGS.map((label) => ({ key: label, label, name: `Создать метку «${label}»`, onClick: () => void createQuick(label) })),
          }}
        />
      ) : null}
      <p className="manage-status" role="status">{status}</p>

      {empty ? null : <>
        <section className="dir-group" aria-labelledby="tags-active-title">
          <h2 id="tags-active-title" className="sr-only">Активные метки</h2>
          {view.active.length === 0 ? <p className="field-hint dir-hint">Активных меток нет. Новую добавьте «+» или прямо при записи операции — «+ метка».</p> : (
            <ul className="card dir-card">{view.active.map(tagRow)}</ul>
          )}
        </section>
        {view.archived.length === 0 ? null : (
          <section className="dir-group" aria-labelledby="tags-archived-title">
            <h2 id="tags-archived-title" className="dir-kicker">В архиве</h2>
            <ul className="card dir-card">{view.archived.map(tagRow)}</ul>
          </section>
        )}
      </>}

      {sheet?.kind === "new" ? (
        <FormSheet
          id="tag-sheet"
          title="Новая метка"
          onClose={askClose}
          busy={busy}
          onSubmit={() => void create()}
          initialFocus={NEW_NAME_ID}
          footer={<button className="primary-button wide dir-save" type="submit" aria-disabled={busy || undefined} aria-busy={busy}>Сохранить</button>}
        >
          <div className="field dir-field">
            <label htmlFor={NEW_NAME_ID}>Название</label>
            <input id={NEW_NAME_ID} dir="auto" autoComplete="off" maxLength={TAG_NAME_MAX_LENGTH} placeholder="Например, отпуск" value={name} readOnly={busy} aria-invalid={sheetError === null ? undefined : true} aria-describedby={sheetError === null ? (namesake === null ? undefined : "tag-new-hint") : "tag-sheet-error"} onChange={(event) => { setName(plainInputValue(event.currentTarget)); setSheetError(null); }} />
          </div>
          {namesake === null ? null : (
            <div className="sheet-hint manage-hint" id="tag-new-hint" role="status">
              <span>Метка «<bdi dir="auto">{namesake.name}</bdi>» уже была — сейчас в архиве. Вернуть её, а не заводить вторую?</span>
              <button className="secondary-button" type="button" aria-disabled={busy || undefined} aria-label={`Вернуть метку «${namesake.name}» из архива`} onClick={() => void restoreNamesake(namesake)}>Вернуть из архива</button>
            </div>
          )}
          {sheetError === null ? null : <p className="field-error" id="tag-sheet-error" role="alert">{sheetError}</p>}
        </FormSheet>
      ) : null}

      {editing !== null ? (
        <FormSheet
          id="tag-sheet"
          title="Метка"
          onClose={askClose}
          busy={busy}
          onSubmit={() => void rename()}
          initialFocus={renameId(editing.tag.id)}
          footer={<button className="primary-button wide dir-save" type="submit" aria-disabled={busy || undefined} aria-busy={busy}>Сохранить</button>}
        >
          <div className="card dir-preview" aria-hidden="true">
            <span className="tile-square tone-peach"><Icon name="hash" size={24} /></span>
            <span className="dir-preview-copy">
              <span className="dir-preview-name"><bdi dir="auto">{softHyphenate(editName.trim() === "" ? editing.tag.name : editName)}</bdi></span>
              <span className="dir-preview-note">{tagCountWords(editing.count)}{editing.tag.active ? "" : " · в архиве"}</span>
            </span>
          </div>
          <div className="field dir-field">
            <label htmlFor={renameId(editing.tag.id)}>Название</label>
            <input id={renameId(editing.tag.id)} dir="auto" autoComplete="off" maxLength={TAG_NAME_MAX_LENGTH} value={editName} readOnly={busy} aria-invalid={sheetError === null ? undefined : true} aria-describedby={sheetError === null ? undefined : "tag-sheet-error"} onChange={(event) => { setEditName(plainInputValue(event.currentTarget)); setSheetError(null); }} />
          </div>
          <section className="dir-archive" aria-label="Архив и удаление">
            {editing.tag.active ? (
              <button id={archiveId(editing.tag.id)} className="quiet-button" type="button" aria-disabled={busy || undefined} aria-label={`Убрать метку «${editing.tag.name}» в архив`} onClick={() => void sheetWrite((state) => archiveTag(state, editing.tag.id), `Метка «${editing.tag.name}» в архиве; на операциях она осталась.`, restoreId(editing.tag.id))}>
                <span className="icon-label"><Icon name="archive" size={24} />Убрать в архив</span>
              </button>
            ) : (
              <button id={restoreId(editing.tag.id)} className="secondary-button" type="button" aria-disabled={busy || undefined} aria-label={`Вернуть метку «${editing.tag.name}» из архива`} onClick={() => void sheetWrite((state) => restoreTag(state, editing.tag.id), `Метка «${editing.tag.name}» снова в выборе.`, archiveId(editing.tag.id))}>
                Вернуть из архива
              </button>
            )}
            <button id={deleteId(editing.tag.id)} className="quiet-button dir-danger" type="button" aria-disabled={busy || undefined} aria-label={`Удалить метку «${editing.tag.name}»`} onClick={() => askDelete(editing)}>
              <span className="icon-label"><Icon name="trash-2" size={24} />Удалить метку</span>
            </button>
            {sheetError === null ? null : <p className="field-error tag-notice" id="tag-sheet-error" role="alert">{sheetError}</p>}
          </section>
          <p className="sheet-status" role="status">{sheetStatus}</p>
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
                const then = afterDelete(target);
                void (async () => {
                  if (busy) return;
                  setBusy(true);
                  try {
                    await write.run((state) => deleteTag(state, target.tag.id));
                    setStatus(`Метка «${target.tag.name}» удалена.`);
                    closeSheet(then);
                  } catch (cause) {
                    setSheetError(tagErrorText(cause));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            />
          )}
        </FormSheet>
      ) : null}

      {discarding ? (
        <ConfirmDialog
          title="Не сохранять метку?"
          description={sheet?.kind === "new" ? "Набранное имя новой метки не сохранится." : "Новое имя метки не сохранится — останется прежнее."}
          cancelLabel="Продолжить ввод"
          confirmLabel="Не сохранять"
          onCancel={() => setDiscarding(false)}
          onConfirm={() => {
            setName("");
            closeSheet();
          }}
        />
      ) : null}
    </div>
  );
}
