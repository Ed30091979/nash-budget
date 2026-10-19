import { useEffect, useRef, useState, type FormEvent } from "react";
import { moveCategory, type BudgetState, type Category, type CategoryGroup } from "@family-budget/domain";
import { categoryVisual, type CategoryTone } from "../../category-visual";
import { BackButton } from "../../components/BackButton";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { CATEGORY_ICON_CHOICES, IconPicker } from "../../components/IconPicker";
import { useBaseCurrency } from "../../components/Money";
import { ReorderControls, type ReorderDirection } from "../../components/ReorderControls";
import { TonePicker } from "../../components/TonePicker";
import { softHyphenate } from "../../hyphenation";
import { useFormDraft } from "../../navigation/draft-guard";
import { plainInputValue } from "../../plain-text";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { groupChoicesFor } from "../operations/category-picker";
import { currencySign } from "../rates/RateQuickSheet";
import {
  archiveCategoryWithLimits,
  categoryArchiveText,
  CATEGORY_NAME_MAX_LENGTH,
  categoryDraftDiffers,
  categoryDraftOf,
  categoryFormError,
  categoryPosition,
  categorySave,
  planMonthWord,
  restoreCategory,
  type CategoryFormDraft,
  type CategoryFormError,
} from "./category-model";

export const CATEGORY_FORM_ERROR_ID = "category-form-error";

const FIELD_IDS: Readonly<Record<CategoryFormError["field"], string>> = {
  name: "category-name",
  group: "category-group",
  icon: "category-icon",
  tone: "category-tone",
  limit: "category-limit",
  form: CATEGORY_FORM_ERROR_ID,
};

export interface CategoryFormViewProps {
  readonly budget: BudgetState;
  readonly category: Category;
  readonly draft: CategoryFormDraft;
  readonly error: CategoryFormError | null;
  readonly busy: boolean;
  readonly onPatch: (patch: Partial<CategoryFormDraft>) => void;
  readonly onSubmit: () => void;
}

/**
 * Форма категории без состояния: название, группа (у расходов), лимит месяца плана (у активной
 * категории расходов), цвет и иконка. Плитка над формой показывает, какой категория станет на
 * «Обзоре», — с набранным именем, иконкой и тоном.
 */
export function CategoryFormView({ budget, category, draft, error, busy, onPatch, onSubmit }: CategoryFormViewProps) {
  const currency = useBaseCurrency();
  const expense = category.type === "expense";
  const groups = groupChoicesFor(category.type);
  const derived = categoryVisual({ name: draft.name.trim() === "" ? category.name : draft.name, type: category.type, group: draft.group });
  const tone: CategoryTone = draft.tone ?? derived.tone;
  const icon = draft.icon ?? derived.icon;
  const month = planMonthWord(budget);
  const fieldError = (field: CategoryFormError["field"]) => (error?.field === field ? error.message : null);
  const describedBy = (field: CategoryFormError["field"], hint?: string) => {
    const ids = [hint, fieldError(field) === null ? undefined : `${FIELD_IDS[field]}-error`].filter(Boolean).join(" ");
    return ids === "" ? undefined : ids;
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form className="manage-form" onSubmit={submit} noValidate aria-describedby={error?.field === "form" ? CATEGORY_FORM_ERROR_ID : undefined}>
      <div className={`tile ${expense ? "tile-expense" : "tile-income"} tone-${expense ? tone : "lilac"} manage-preview`} aria-hidden="true">
        <span className="tile-top"><span className="tile-glyph"><Icon name={icon} size={20} /></span></span>
        <span className="tile-name"><bdi dir="auto">{softHyphenate(draft.name.trim() === "" ? category.name : draft.name)}</bdi></span>
      </div>
      <div className="field">
        <label htmlFor="category-name">Название</label>
        <input
          id="category-name"
          dir="auto"
          autoComplete="off"
          maxLength={CATEGORY_NAME_MAX_LENGTH}
          value={draft.name}
          disabled={busy}
          aria-invalid={fieldError("name") === null ? undefined : true}
          aria-describedby={describedBy("name")}
          onChange={(event) => onPatch({ name: plainInputValue(event.currentTarget) })}
        />
        <FieldError id="category-name" message={fieldError("name")} />
      </div>
      {groups.length > 1 ? (
        <div className="field">
          <label htmlFor="category-group">Группа</label>
          <select id="category-group" value={draft.group} disabled={busy} aria-describedby={describedBy("group")} onChange={(event) => onPatch({ group: event.target.value as CategoryGroup })}>
            {groups.map((group) => <option key={group.key} value={group.key}>{group.title}</option>)}
          </select>
          <FieldError id="category-group" message={fieldError("group")} />
        </div>
      ) : null}
      {expense && category.active && month !== null ? (
        <div className="field">
          <label htmlFor="category-limit">Лимит на {month}, {currencySign(currency)} — не обязательно</label>
          <input
            id="category-limit"
            inputMode="decimal"
            autoComplete="off"
            maxLength={24}
            placeholder="Без лимита"
            value={draft.limit}
            disabled={busy}
            aria-invalid={fieldError("limit") === null ? undefined : true}
            aria-describedby={describedBy("limit", "category-limit-hint")}
            onChange={(event) => onPatch({ limit: event.target.value })}
          />
          <p className="field-hint" id="category-limit-hint">Пусто — без лимита. Лимит стоит в плане месяца и переносится в следующий, когда его откроете.</p>
          <FieldError id="category-limit" message={fieldError("limit")} />
        </div>
      ) : null}
      <div id="category-tone">
        <TonePicker legend="Цвет" value={draft.tone} fallback={derived.tone} disabled={busy} onChange={(next) => onPatch({ tone: next })} />
      </div>
      <div id="category-icon">
        <IconPicker legend="Иконка" icons={CATEGORY_ICON_CHOICES} value={draft.icon} fallback={derived.icon} tone={tone} disabled={busy} onChange={(next) => onPatch({ icon: next })} />
      </div>
      {error?.field === "form" ? <p className="field-error" id={CATEGORY_FORM_ERROR_ID} role="alert" tabIndex={-1}>{error.message}</p> : null}
      <button className="primary-button wide" type="submit" disabled={busy} aria-busy={busy}>Сохранить</button>
    </form>
  );
}

function FieldError({ id, message }: { readonly id: string; readonly message: string | null }) {
  if (message === null) return null;
  return <p className="field-error" id={`${id}-error`} role="alert">{message}</p>;
}

export interface CategoryScreenProps {
  readonly budget: BudgetState;
  readonly categoryId: string;
  readonly write: BudgetWriter;
  /** К своему списку: расходы или доходы — по виду категории. */
  readonly onBack: (type: Category["type"]) => void;
  readonly onDone: (message: string, type: Category["type"]) => void;
}

/**
 * Категория или источник дохода, открытые для правки (`#/more/categories/<UUID>`). Черновик —
 * в реестре экрана; «Сохранить» — одна запись имени, оформления и лимита. Порядок в группе и архив —
 * отдельные записи сразу; архив спрашивает: категория уходит с «Обзора», а её операции остаются.
 */
export function CategoryScreen({ budget, categoryId, write, onBack, onDone }: CategoryScreenProps) {
  const category = budget.categories.find((item) => item.id.toLowerCase() === categoryId.toLowerCase()) ?? null;
  const [pristine] = useState<CategoryFormDraft | null>(() => (category === null ? null : categoryDraftOf(budget, category)));
  const [draft, setDraft] = useState<CategoryFormDraft | null>(pristine);
  const [error, setError] = useState<CategoryFormError | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [asking, setAsking] = useState(false);
  const dirty = draft !== null && pristine !== null && categoryDraftDiffers(draft, pristine);
  const saving = useFormDraft({
    label: category === null ? "категория" : `правка категории «${category.name}»`,
    dirty,
    discard: () => setDraft(pristine),
  });
  const focusError = useRef<string | null>(null);
  useEffect(() => {
    if (focusError.current === null) return;
    document.getElementById(focusError.current)?.focus();
    focusError.current = null;
  });

  if (category === null || draft === null || pristine === null) return null;
  const income = category.type === "income";
  const fail = (next: CategoryFormError) => {
    setError(next);
    focusError.current = FIELD_IDS[next.field];
  };
  const submit = () => {
    if (busy) return;
    const ticket = saving.begin();
    setBusy(true);
    setError(null);
    const name = draft.name.trim();
    write.run(categorySave(category, draft, pristine)).then(() => {
      saving.succeed(ticket);
      setBusy(false);
      onDone(income ? `Источник дохода «${name}» сохранён.` : `Категория «${name}» сохранена.`, category.type);
    }, (cause: unknown) => {
      saving.fail(ticket);
      setBusy(false);
      fail(categoryFormError(cause));
    });
  };
  const sideWrite = async (change: (state: BudgetState) => BudgetState, done: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await write.run(change);
      setNotice(done);
    } catch (cause) {
      fail(categoryFormError(cause));
    } finally {
      setBusy(false);
    }
  };
  const { position, count } = categoryPosition(budget, category);
  const move = (direction: ReorderDirection) => sideWrite(
    (state) => moveCategory(state, category.id, direction),
    `Теперь «${category.name}» — ${direction === "up" ? position - 1 : position + 1}-я из ${count} в группе.`,
  );
  const what = income ? "источник дохода" : "категорию";

  return (
    <div className="manage-screen category-screen">
      <div className="planning-toolbar"><BackButton label={income ? "К источникам дохода" : "К категориям"} onClick={() => onBack(category.type)} /></div>
      <header className="manage-head">
        <h1><bdi dir="auto">{category.name}</bdi></h1>
        <p>{income ? "Источник дохода" : "Категория расходов"}{category.active ? "" : " · в архиве"}</p>
      </header>
      <p className="manage-status" role="status">{notice}</p>
      <CategoryFormView
        budget={budget}
        category={category}
        draft={draft}
        error={error}
        busy={busy}
        onPatch={(patch) => {
          setDraft((current) => (current === null ? current : { ...current, ...patch }));
          if (error !== null && error.field !== "form") setError(null);
        }}
        onSubmit={submit}
      />
      {category.active ? (
        <section className="manage-group" aria-labelledby="category-order-title">
          <h2 id="category-order-title" className="list-kicker">Место в группе</h2>
          <p className="field-hint">{position}-я из {count} — в этом порядке плитки стоят на «Обзоре» и в выборе при записи.</p>
          <ReorderControls id={`category-${category.id}`} name={category.name} position={position} count={count} busy={busy} onMove={move} />
        </section>
      ) : null}
      <section className="manage-group" aria-labelledby="category-archive-title">
        <h2 id="category-archive-title" className="list-kicker">Архив</h2>
        {category.active ? <>
          <p className="field-hint">Удалить {what} нельзя: прошлые месяцы ссылаются на неё. В архиве она уходит с «Обзора» и из выбора при записи, а её операции остаются в «Операциях» и отчётах.</p>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => setAsking(true)}>
            <span className="icon-label"><Icon name="archive" size={20} />Убрать в архив</span>
          </button>
        </> : <>
          <p className="field-hint">{income ? "Источник" : "Категория"} в архиве: на «Обзоре» и в выборе при записи {income ? "его" : "её"} нет, операции — на месте.</p>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void sideWrite((state) => restoreCategory(state, category.id), `«${category.name}» снова на «Обзоре» и в выборе.`)}>
            Вернуть из архива
          </button>
        </>}
      </section>
      {asking ? (
        <ConfirmDialog
          title={`Убрать «${category.name}» в архив?`}
          description={categoryArchiveText(budget, category)}
          cancelLabel="Оставить"
          confirmLabel="Убрать в архив"
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void sideWrite((state) => archiveCategoryWithLimits(state, category.id), `«${category.name}» в архиве. Операции на месте.`);
          }}
        />
      ) : null}
    </div>
  );
}
