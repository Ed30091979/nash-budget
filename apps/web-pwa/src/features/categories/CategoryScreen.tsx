import { useEffect, useRef, useState } from "react";
import type { BudgetState, Category, CategoryGroup } from "@family-budget/domain";
import { categoryVisual, type CategoryTone } from "../../category-visual";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { FormSheet } from "../../components/FormSheet";
import { useFocusAfterRender } from "../../components/focus-after-render";
import { Icon } from "../../components/Icon";
import { CATEGORY_ICON_CHOICES, IconPicker } from "../../components/IconPicker";
import { useBaseCurrency } from "../../components/Money";
import { OptionCards } from "../../components/OptionCards";
import { TileSquare } from "../../components/tiles/Tile";
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
  categoryPreviewWords,
  categorySave,
  nextMonthWord,
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
}

/**
 * Разделы листа категории (дизайн 5.0, макет 13) без состояния: образец — квадрат с набранными
 * именем, значком и тоном и «22 000 из 30 000 ₽ в октябре»; название; лимит месяца плана с одной
 * строкой подсказки (у активной категории расходов); цвет со словами; значки; группа карточками 2×2
 * (у расходов).
 */
export function CategoryFormView({ budget, category, draft, error, busy, onPatch }: CategoryFormViewProps) {
  const currency = useBaseCurrency();
  const expense = category.type === "expense";
  const groups = groupChoicesFor(category.type);
  const derived = categoryVisual({ name: draft.name.trim() === "" ? category.name : draft.name, type: category.type, group: draft.group });
  const tone: CategoryTone = draft.tone ?? derived.tone;
  const icon = draft.icon ?? derived.icon;
  const month = planMonthWord(budget);
  const next = nextMonthWord(budget);
  const name = draft.name.trim() === "" ? category.name : draft.name;
  const fieldError = (field: CategoryFormError["field"]) => (error?.field === field ? error.message : null);
  const describedBy = (field: CategoryFormError["field"], hint?: string) => {
    const ids = [hint, fieldError(field) === null ? undefined : `${FIELD_IDS[field]}-error`].filter(Boolean).join(" ");
    return ids === "" ? undefined : ids;
  };
  return (
    <>
      {/* Образец: имя для глаза — с мягкими переносами и скрыто от диктора, для слуха — целое. */}
      <div className="card dir-preview">
        <TileSquare icon={icon} tone={tone} />
        <span className="dir-preview-copy">
          <span className="dir-preview-name" aria-hidden="true"><bdi dir="auto">{softHyphenate(name)}</bdi></span>
          <span className="sr-only"><bdi dir="auto">{name.trim()}</bdi>: </span>
          <span className="dir-preview-note">{categoryPreviewWords(budget, category, currency)}</span>
        </span>
      </div>
      <div className="field dir-field">
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
      {expense && category.active && month !== null ? (
        <div className="field dir-field">
          <label htmlFor="category-limit">Лимит на {month}<span className="sr-only">, {currencySign(currency)} — не обязательно</span></label>
          <span className="dir-money-field">
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
            <span className="dir-money-sign" aria-hidden="true">{currencySign(currency)}</span>
          </span>
          <p className="field-hint" id="category-limit-hint">Пусто — без лимита.{next === null ? "" : ` Лимит перейдёт и на ${next}.`}</p>
          <FieldError id="category-limit" message={fieldError("limit")} />
        </div>
      ) : null}
      <div id="category-tone" className="dir-field">
        <TonePicker legend="Цвет" value={draft.tone} fallback={derived.tone} disabled={busy} onChange={(nextTone) => onPatch({ tone: nextTone })} />
      </div>
      <div id="category-icon" className="dir-field">
        <IconPicker legend="Значок" icons={CATEGORY_ICON_CHOICES} value={draft.icon} fallback={derived.icon} tone={tone} disabled={busy} onChange={(nextIcon) => onPatch({ icon: nextIcon })} />
      </div>
      {groups.length > 1 ? <>
        <OptionCards
          id="category-group"
          legend="Группа"
          options={groups.map((group) => ({ value: group.key, label: group.title, id: `category-group-${group.key}` }))}
          value={draft.group}
          disabled={busy}
          describedBy={describedBy("group")}
          onChange={(group: CategoryGroup) => onPatch({ group })}
        />
        <FieldError id="category-group" message={fieldError("group")} />
      </> : null}
    </>
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
  /** Крестик и Esc — к своему списку, расходов или доходов: родитель маршрута, вид списка — в адресе. */
  readonly onBack: () => void;
  readonly onDone: (message: string) => void;
}

const CATEGORY_ARCHIVE_ID = "category-archive";
const CATEGORY_RESTORE_ID = "category-restore";

/**
 * Лист категории или источника дохода (дизайн 5.0, макет 13) — маршрут
 * `#/more/categories/<UUID>?type=…` поверх своего списка. Черновик — в реестре экрана; «Сохранить» —
 * одна запись имени, оформления, группы и лимита (лимит — переходами плана). Архив — отдельная
 * запись сразу, с вопросом: категория уходит с «Обзора», её операции остаются, лимит открытых
 * месяцев снимается, закрытые месяцы не меняются. Порядок в группе — режимом в списке.
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
  // После архива и возврата — на кнопку, вставшую на место нажатой (ревью 2c, MEDIUM-3).
  const focusAfterRender = useFocusAfterRender();
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
      onDone(income ? `Источник дохода «${name}» сохранён.` : `Категория «${name}» сохранена.`);
    }, (cause: unknown) => {
      saving.fail(ticket);
      setBusy(false);
      fail(categoryFormError(cause));
    });
  };
  const sideWrite = async (change: (state: BudgetState) => BudgetState, done: string, then?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await write.run(change);
      setNotice(done);
      if (then !== undefined) focusAfterRender(then);
    } catch (cause) {
      fail(categoryFormError(cause));
    } finally {
      setBusy(false);
    }
  };
  const what = income ? "источник дохода" : "категорию";

  return (
    <FormSheet
      id="category-sheet"
      titleLevel={1}
      title={income ? "Источник дохода" : "Категория"}
      onClose={onBack}
      busy={busy}
      onSubmit={submit}
      describedBy={error?.field === "form" ? CATEGORY_FORM_ERROR_ID : undefined}
      footer={<>
        {error?.field === "form" ? <p className="field-error" id={CATEGORY_FORM_ERROR_ID} role="alert" tabIndex={-1}>{error.message}</p> : null}
        <button className="primary-button wide dir-save" type="submit" disabled={busy} aria-busy={busy}>Сохранить</button>
      </>}
    >
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
      />
      <section className="dir-archive" aria-label="Архив">
        {category.active ? <>
          <button id={CATEGORY_ARCHIVE_ID} className="quiet-button dir-danger" type="button" aria-disabled={busy || undefined} onClick={() => { if (!busy) setAsking(true); }}>
            <span className="icon-label"><Icon name="archive" size={24} />Убрать в архив</span>
          </button>
          <p className="field-hint">Удалить {what} нельзя: прошлые месяцы ссылаются на {income ? "него" : "неё"}. В архиве {income ? "он" : "она"} уходит с «Обзора» и из выбора при записи, а операции остаются в «Операциях» и отчётах.</p>
        </> : <>
          <button id={CATEGORY_RESTORE_ID} className="secondary-button" type="button" aria-disabled={busy || undefined} onClick={() => void sideWrite((state) => restoreCategory(state, category.id), `«${category.name}» снова на «Обзоре» и в выборе.`, CATEGORY_ARCHIVE_ID)}>
            Вернуть из архива
          </button>
          <p className="field-hint">{income ? "Источник" : "Категория"} в архиве: на «Обзоре» и в выборе при записи {income ? "его" : "её"} нет, операции — на месте.</p>
        </>}
      </section>
      <p className="sheet-status" role="status">{notice}</p>
      {asking ? (
        <ConfirmDialog
          title={`Убрать «${category.name}» в архив?`}
          description={categoryArchiveText(budget, category)}
          cancelLabel="Оставить"
          confirmLabel="Убрать в архив"
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void sideWrite((state) => archiveCategoryWithLimits(state, category.id), `«${category.name}» в архиве. Операции на месте.`, CATEGORY_RESTORE_ID);
          }}
        />
      ) : null}
    </FormSheet>
  );
}
