import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { formatMinor, type BudgetState } from "@family-budget/domain";
import {
  archiveFlexibleLine,
  createCommitment,
  createFlexibleLine,
  createSchedule,
  editCommitment,
  editFlexibleLine,
  editSchedule,
  planningError,
  reactivateFlexibleLine,
  setCommitmentActive,
  setScheduleActive,
  type CommitmentDraft,
  type FlexibleDraft,
  type ScheduleDraft,
} from "./model";
import {
  changeRestoreDraft,
  createSubmissionGate,
  failRestoreDraft,
  INITIAL_PLANNING_FORM_STATE,
  nextEditingId,
  planningFormReducer,
  resolveErrorTarget,
  restoreControlId,
  type RestoreDraftState,
} from "./form-state";

interface PlanningScreenProps {
  readonly budget: BudgetState;
  readonly onChange: (change: (current: BudgetState) => BudgetState) => Promise<unknown>;
  readonly onDirtyChange?: (dirty: boolean) => void;
}

type PlanningEditor = "commitment" | "schedule" | "flexible";
type EditorDirtyReporter = (dirty: boolean) => void;

export interface PlanningDraftDirtyState {
  readonly commitment: boolean;
  readonly schedule: boolean;
  readonly flexible: boolean;
}

export function hasUnsavedPlanningDrafts(state: PlanningDraftDirtyState): boolean {
  return state.commitment || state.schedule || state.flexible;
}

export function isPlanningEditorDirty<T extends object>(
  draft: T,
  pristine: T,
  editingId: string | null,
): boolean {
  return editingId !== null || JSON.stringify(draft) !== JSON.stringify(pristine);
}

export function hasChangedRestoreDrafts(
  restoreDrafts: Readonly<Record<string, RestoreDraftState>>,
  baselineAmounts: ReadonlyMap<string, string>,
): boolean {
  return Object.entries(restoreDrafts).some(([categoryId, draft]) => {
    const baseline = baselineAmounts.get(categoryId);
    return baseline !== undefined && draft.amount !== baseline;
  });
}

const monthNames = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];

function rubles(minor: number): string {
  return formatMinor(minor, { exponent: 2 });
}

function moneyInput(minor: number): string {
  const rubles = Math.floor(minor / 100);
  const kopecks = String(minor % 100).padStart(2, "0");
  return kopecks === "00" ? String(rubles) : `${rubles}.${kopecks}`;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <span className="field-error" id={`${id}-error`}>{message}</span> : null;
}

function a11y(id: string, field: string | null, message: string | null, logicalField = id) {
  return {
    "aria-invalid": field === logicalField ? true as const : undefined,
    "aria-describedby": field === logicalField && message ? `${id}-error` : undefined,
  };
}

function useSave(onChange: PlanningScreenProps["onChange"], formPrefix: string, visibleFields: readonly string[]) {
  const [state, dispatch] = useReducer(planningFormReducer, INITIAL_PLANNING_FORM_STATE);
  const gate = useRef(createSubmissionGate());
  const run = async (change: (current: BudgetState) => BudgetState, done?: () => void) => {
    await gate.current.run(async () => {
      dispatch({ type: "submit" });
      try {
        await onChange(change);
        done?.();
        dispatch({ type: "success" });
      } catch (error) {
        const target = resolveErrorTarget(formPrefix, planningError(error), visibleFields);
        dispatch({ type: "failure", error: { field: target.field, message: target.message } });
        window.setTimeout(() => document.getElementById(target.id)?.focus(), 0);
      }
    });
  };
  return { ...state, run, clear: () => dispatch({ type: "change" }) };
}

function useDirtyReporter(onDirtyChange: EditorDirtyReporter, dirty: boolean) {
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => {
    onDirtyChange(false);
  }, [onDirtyChange]);
}

interface PlanningEditorProps extends Omit<PlanningScreenProps, "onDirtyChange"> {
  readonly onDirtyChange: EditorDirtyReporter;
}

function ActiveReferenceFields({ prefix, budget, categoryId, accountId, onCategory, onAccount, errorField, errorMessage }: {
  prefix: string;
  budget: BudgetState;
  categoryId: string;
  accountId: string;
  onCategory: (value: string) => void;
  onAccount: (value: string) => void;
  errorField: string | null;
  errorMessage: string | null;
}) {
  const categories = budget.categories.filter((item) => item.active && item.type === "expense");
  const accounts = budget.accounts.filter((item) => item.active);
  return <>
    <div className="field">
      <label htmlFor={`${prefix}-categoryId`}>Категория расходов</label>
      <select id={`${prefix}-categoryId`} value={categoryId} onChange={(event) => onCategory(event.target.value)} {...a11y(`${prefix}-categoryId`, errorField, errorMessage, "categoryId")}>
        <option value="">Выберите категорию</option>
        {categories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select>
      <FieldError id={`${prefix}-categoryId`} message={errorField === "categoryId" ? errorMessage ?? undefined : undefined} />
    </div>
    <div className="field">
      <label htmlFor={`${prefix}-accountId`}>Счёт оплаты</label>
      <select id={`${prefix}-accountId`} value={accountId} onChange={(event) => onAccount(event.target.value)} {...a11y(`${prefix}-accountId`, errorField, errorMessage, "accountId")}>
        <option value="">Выберите счёт</option>
        {accounts.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select>
      <FieldError id={`${prefix}-accountId`} message={errorField === "accountId" ? errorMessage ?? undefined : undefined} />
    </div>
  </>;
}

function commitmentDefaults(budget: BudgetState): CommitmentDraft {
  return {
    name: "", categoryId: budget.categories.find((item) => item.active && item.type === "expense")?.id ?? "",
    accountId: budget.accounts.find((item) => item.active)?.id ?? "", dueDate: "", amount: "", reserved: "0", recurrence: "annual",
  };
}

function CommitmentsEditor({ budget, onChange, onDirtyChange }: PlanningEditorProps) {
  const pristine = useMemo(() => commitmentDefaults(budget), [budget]);
  const [draft, setDraft] = useState<CommitmentDraft>(() => commitmentDefaults(budget));
  const [editingId, setEditingId] = useState<string | null>(null);
  const save = useSave(onChange, "commitment", ["name", "categoryId", "accountId", "dueDate", "amount", "reserved"]);
  useDirtyReporter(onDirtyChange, isPlanningEditorDirty(draft, pristine, editingId));
  const patch = <K extends keyof CommitmentDraft>(key: K, value: CommitmentDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    save.clear();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save.run(
      (state) => editingId ? editCommitment(state, editingId, draft) : createCommitment(state, draft),
      () => { setDraft(commitmentDefaults(budget)); setEditingId((current) => nextEditingId(current, { type: "saved" })); },
    );
  };
  const edit = (id: string) => {
    const item = budget.annualCommitments.find((candidate) => candidate.id === id);
    if (!item) return;
    setEditingId((current) => nextEditingId(current, { type: "edit", id }));
    save.clear();
    setDraft({ name: item.name, categoryId: item.categoryId, accountId: item.accountId, dueDate: item.dueDate, amount: moneyInput(item.amountMinor), reserved: moneyInput(item.reservedMinor), recurrence: item.recurrence });
  };
  return <section className="section-card" aria-labelledby="commitments-title">
    <h2 id="commitments-title">Ежегодные и разовые платежи</h2>
    <p>Страховка, дом, лагерь и другие крупные суммы с резервом к сроку.</p>
    <form onSubmit={submit} noValidate aria-busy={save.busy}>
      <fieldset disabled={save.busy}>
        <legend>{editingId ? "Редактировать крупный платёж" : "Добавить крупный платёж"}</legend>
        <div className="field"><label htmlFor="commitment-name">Название</label><input id="commitment-name" maxLength={80} value={draft.name} onChange={(event) => patch("name", event.target.value)} {...a11y("commitment-name", save.errorField, save.errorMessage, "name")} /><FieldError id="commitment-name" message={save.errorField === "name" ? save.errorMessage ?? undefined : undefined} /></div>
        <ActiveReferenceFields prefix="commitment" budget={budget} categoryId={draft.categoryId} accountId={draft.accountId} onCategory={(value) => patch("categoryId", value)} onAccount={(value) => patch("accountId", value)} errorField={save.errorField} errorMessage={save.errorMessage} />
        <div className="field"><label htmlFor="commitment-dueDate">Дата платежа</label><input id="commitment-dueDate" type="date" value={draft.dueDate} onChange={(event) => patch("dueDate", event.target.value)} {...a11y("commitment-dueDate", save.errorField, save.errorMessage, "dueDate")} /><FieldError id="commitment-dueDate" message={save.errorField === "dueDate" ? save.errorMessage ?? undefined : undefined} /></div>
        <div className="field"><label htmlFor="commitment-amount">Сумма, ₽</label><input id="commitment-amount" inputMode="decimal" maxLength={24} value={draft.amount} onChange={(event) => patch("amount", event.target.value)} {...a11y("commitment-amount", save.errorField, save.errorMessage, "amount")} /><FieldError id="commitment-amount" message={save.errorField === "amount" ? save.errorMessage ?? undefined : undefined} /></div>
        <div className="field"><label htmlFor="commitment-reserved">Сейчас отложено и не потрачено, ₽</label><input id="commitment-reserved" inputMode="decimal" maxLength={24} value={draft.reserved} onChange={(event) => patch("reserved", event.target.value)} {...a11y("commitment-reserved", save.errorField, save.errorMessage, "reserved")} /><small>Эта сумма сохраняется между годовщинами, пока вы не измените её вручную.</small><FieldError id="commitment-reserved" message={save.errorField === "reserved" ? save.errorMessage ?? undefined : undefined} /></div>
        <div className="field"><label htmlFor="commitment-recurrence">Повтор</label><select id="commitment-recurrence" value={draft.recurrence} onChange={(event) => patch("recurrence", event.target.value as CommitmentDraft["recurrence"])}><option value="annual">Каждый год</option><option value="one_time">Один раз</option></select></div>
        {save.errorField === "form" ? <p className="field-error" id="commitment-form" tabIndex={-1} role="alert">{save.errorMessage}</p> : null}
        <button className="primary-button" type="submit" aria-label={editingId ? "Сохранить крупный платёж" : "Добавить крупный платёж"}>{editingId ? "Сохранить" : "Добавить"}</button>
        {editingId ? <button className="secondary-button" type="button" aria-label="Отменить редактирование крупного платежа" onClick={() => { setEditingId((current) => nextEditingId(current, { type: "cancel" })); setDraft(commitmentDefaults(budget)); save.clear(); }}>Отмена</button> : null}
      </fieldset>
    </form>
    <ul className="planning-edit-list">
      {budget.annualCommitments.map((item) => <li key={item.id}><div><strong>{item.name}</strong><span>{rubles(item.amountMinor)} · {item.recurrence === "annual" ? `первая дата цикла ${item.dueDate} · ежегодно` : `дата ${item.dueDate} · один раз`}{item.active ? "" : " · в архиве"}</span></div><button className="secondary-button" type="button" aria-label={`Изменить крупный платёж «${item.name}»`} onClick={() => edit(item.id)}>Изменить</button><button className="text-button" type="button" aria-label={`${item.active ? "Архивировать" : "Вернуть"} крупный платёж «${item.name}»`} onClick={() => void save.run((state) => setCommitmentActive(state, item.id, !item.active))}>{item.active ? "В архив" : "Вернуть"}</button></li>)}
    </ul>
  </section>;
}

function scheduleDefaults(budget: BudgetState): ScheduleDraft {
  return { name: "", categoryId: budget.categories.find((item) => item.active && item.type === "expense")?.id ?? "", accountId: budget.accounts.find((item) => item.active)?.id ?? "", amount: "", dueDay: "1", mode: "monthly", months: [] };
}

function SchedulesEditor({ budget, onChange, onDirtyChange }: PlanningEditorProps) {
  const pristine = useMemo(() => scheduleDefaults(budget), [budget]);
  const [draft, setDraft] = useState<ScheduleDraft>(() => scheduleDefaults(budget));
  const [editingId, setEditingId] = useState<string | null>(null);
  const save = useSave(onChange, "schedule", ["name", "categoryId", "accountId", "amount", "dueDay", "months"]);
  useDirtyReporter(onDirtyChange, isPlanningEditorDirty(draft, pristine, editingId));
  const patch = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    save.clear();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save.run((state) => editingId ? editSchedule(state, editingId, draft) : createSchedule(state, draft), () => { setEditingId((current) => nextEditingId(current, { type: "saved" })); setDraft(scheduleDefaults(budget)); });
  };
  const edit = (id: string) => {
    const item = budget.scheduledExpenses.find((candidate) => candidate.id === id);
    if (!item) return;
    setEditingId((current) => nextEditingId(current, { type: "edit", id }));
    save.clear();
    setDraft({ name: item.name, categoryId: item.categoryId, accountId: item.accountId, amount: moneyInput(item.amountMinor), dueDay: String(item.dueDay), mode: item.mode, months: item.months ?? [] });
  };
  const toggleMonth = (month: number) => patch("months", draft.months.includes(month) ? draft.months.filter((item) => item !== month) : [...draft.months, month]);
  return <section className="section-card" aria-labelledby="schedules-title">
    <h2 id="schedules-title">Ежемесячные и сезонные платежи</h2>
    <p>Обучение может идти с сентября по май, а категория «Дети» остаётся обычной категорией.</p>
    <form onSubmit={submit} noValidate aria-busy={save.busy}>
      <fieldset disabled={save.busy}>
        <legend>{editingId ? "Редактировать расписание" : "Добавить расписание"}</legend>
        <div className="field"><label htmlFor="schedule-name">Название</label><input id="schedule-name" maxLength={80} value={draft.name} onChange={(event) => patch("name", event.target.value)} {...a11y("schedule-name", save.errorField, save.errorMessage, "name")} /><FieldError id="schedule-name" message={save.errorField === "name" ? save.errorMessage ?? undefined : undefined} /></div>
        <ActiveReferenceFields prefix="schedule" budget={budget} categoryId={draft.categoryId} accountId={draft.accountId} onCategory={(value) => patch("categoryId", value)} onAccount={(value) => patch("accountId", value)} errorField={save.errorField} errorMessage={save.errorMessage} />
        <div className="field"><label htmlFor="schedule-amount">Сумма, ₽</label><input id="schedule-amount" inputMode="decimal" maxLength={24} value={draft.amount} onChange={(event) => patch("amount", event.target.value)} {...a11y("schedule-amount", save.errorField, save.errorMessage, "amount")} /><FieldError id="schedule-amount" message={save.errorField === "amount" ? save.errorMessage ?? undefined : undefined} /></div>
        <div className="field"><label htmlFor="schedule-dueDay">День оплаты</label><input id="schedule-dueDay" inputMode="numeric" maxLength={2} value={draft.dueDay} onChange={(event) => patch("dueDay", event.target.value)} {...a11y("schedule-dueDay", save.errorField, save.errorMessage, "dueDay")} /><small>29, 30 или 31 в коротком месяце становятся последним днём месяца.</small><FieldError id="schedule-dueDay" message={save.errorField === "dueDay" ? save.errorMessage ?? undefined : undefined} /></div>
        <div className="field"><label htmlFor="schedule-mode">Частота</label><select id="schedule-mode" value={draft.mode} onChange={(event) => patch("mode", event.target.value as ScheduleDraft["mode"])}><option value="monthly">Каждый месяц</option><option value="selected_months">Только выбранные месяцы</option></select></div>
        {draft.mode === "selected_months" ? <fieldset id="schedule-months" tabIndex={-1} aria-describedby={save.errorField === "months" ? "schedule-months-error" : undefined}><legend>Месяцы оплаты</legend><div className="month-checkboxes">{monthNames.map((label, index) => { const month = index + 1; return <label key={month}><input type="checkbox" checked={draft.months.includes(month)} onChange={() => toggleMonth(month)} />{label}</label>; })}</div><FieldError id="schedule-months" message={save.errorField === "months" ? save.errorMessage ?? undefined : undefined} /></fieldset> : null}
        {save.errorField === "form" ? <p className="field-error" id="schedule-form" tabIndex={-1} role="alert">{save.errorMessage}</p> : null}
        <button className="primary-button" type="submit" aria-label={editingId ? "Сохранить расписание" : "Добавить расписание"}>{editingId ? "Сохранить" : "Добавить"}</button>
        {editingId ? <button className="secondary-button" type="button" aria-label="Отменить редактирование расписания" onClick={() => { setEditingId((current) => nextEditingId(current, { type: "cancel" })); setDraft(scheduleDefaults(budget)); save.clear(); }}>Отмена</button> : null}
      </fieldset>
    </form>
    <ul className="planning-edit-list">{budget.scheduledExpenses.map((item) => <li key={item.id}><div><strong>{item.name}</strong><span>{rubles(item.amountMinor)} · день {item.dueDay} · {item.mode === "monthly" ? "ежемесячно" : item.months?.map((month) => monthNames[month - 1]).join(", ")}{item.active ? "" : " · в архиве"}</span></div><button className="secondary-button" type="button" aria-label={`Изменить расписание «${item.name}»`} onClick={() => edit(item.id)}>Изменить</button><button className="text-button" type="button" aria-label={`${item.active ? "Архивировать" : "Вернуть"} расписание «${item.name}»`} onClick={() => void save.run((state) => setScheduleActive(state, item.id, !item.active))}>{item.active ? "В архив" : "Вернуть"}</button></li>)}</ul>
  </section>;
}

function FlexibleEditor({ budget, onChange, onDirtyChange }: PlanningEditorProps) {
  const active = budget.budgets.find((item) => item.id === budget.activeBudgetId);
  const [draft, setDraft] = useState<FlexibleDraft>({ name: "", amount: "" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [restoreDrafts, setRestoreDrafts] = useState<Readonly<Record<string, RestoreDraftState>>>({});
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const restoreGate = useRef(createSubmissionGate());
  const save = useSave(onChange, "flexible", ["name", "amount"]);
  const categories = useMemo(() => new Map(budget.categories.map((item) => [item.id, item])), [budget.categories]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save.run((state) => editingId ? editFlexibleLine(state, editingId, draft) : createFlexibleLine(state, draft), () => { setEditingId((current) => nextEditingId(current, { type: "saved" })); setDraft({ name: "", amount: "" }); });
  };
  const edit = (lineId: string) => {
    const line = active?.lines.find((item) => item.id === lineId);
    const category = line ? categories.get(line.categoryId) : undefined;
    if (!line || !category) return;
    setEditingId((current) => nextEditingId(current, { type: "edit", id: lineId }));
    save.clear();
    setDraft({ name: category.name, amount: moneyInput(line.plannedMinor) });
  };
  const activeLines = active?.lines.filter((line) => line.active !== false) ?? [];
  const archivedLines = active?.lines.filter((line) => line.active === false) ?? [];
  const restoreBaselines = useMemo(
    () => new Map(archivedLines.map((line) => [line.categoryId, moneyInput(line.plannedMinor)])),
    [archivedLines],
  );
  useDirtyReporter(
    onDirtyChange,
    isPlanningEditorDirty(draft, { name: "", amount: "" }, editingId) ||
      hasChangedRestoreDrafts(restoreDrafts, restoreBaselines),
  );
  const restore = async (lineId: string, categoryId: string, categoryName: string, originalAmount: string) => {
    const controlId = restoreControlId(categoryId);
    const amount = restoreDrafts[categoryId]?.amount ?? originalAmount;
    await restoreGate.current.run(async () => {
      setRestoringId(categoryId);
      try {
        await onChange((state) => reactivateFlexibleLine(
          editFlexibleLine(state, lineId, { name: categoryName, amount }),
          lineId,
        ));
      } catch (error) {
        const failure = planningError(error);
        setRestoreDrafts((current) => failRestoreDraft(current, categoryId, amount, failure.message));
        window.setTimeout(() => document.getElementById(controlId)?.focus(), 0);
      } finally {
        setRestoringId(null);
      }
    });
  };
  return <section className="section-card" aria-labelledby="flexible-title">
    <h2 id="flexible-title">Повседневные лимиты</h2><p>Мелкие покупки: продукты, транспорт, дети и дом. Архив сохраняет категорию для истории.</p>
    <form onSubmit={submit} noValidate aria-busy={save.busy}><fieldset disabled={save.busy}><legend>{editingId ? "Редактировать лимит" : "Добавить лимит"}</legend><div className="field"><label htmlFor="flexible-name">Название</label><input id="flexible-name" maxLength={80} value={draft.name} onChange={(event) => { setDraft((current) => ({ ...current, name: event.target.value })); save.clear(); }} {...a11y("flexible-name", save.errorField, save.errorMessage, "name")} /><FieldError id="flexible-name" message={save.errorField === "name" ? save.errorMessage ?? undefined : undefined} /></div><div className="field"><label htmlFor="flexible-amount">Лимит в месяц, ₽</label><input id="flexible-amount" inputMode="decimal" maxLength={24} value={draft.amount} onChange={(event) => { setDraft((current) => ({ ...current, amount: event.target.value })); save.clear(); }} {...a11y("flexible-amount", save.errorField, save.errorMessage, "amount")} /><FieldError id="flexible-amount" message={save.errorField === "amount" ? save.errorMessage ?? undefined : undefined} /></div>{save.errorField === "form" ? <p className="field-error" id="flexible-form" tabIndex={-1} role="alert">{save.errorMessage}</p> : null}<button className="primary-button" type="submit" aria-label={editingId ? "Сохранить повседневный лимит" : "Добавить повседневный лимит"}>{editingId ? "Сохранить" : "Добавить"}</button>{editingId ? <button className="secondary-button" type="button" aria-label="Отменить редактирование повседневного лимита" onClick={() => { setEditingId((current) => nextEditingId(current, { type: "cancel" })); setDraft({ name: "", amount: "" }); save.clear(); }}>Отмена</button> : null}</fieldset></form>
    <ul className="planning-edit-list">{activeLines.map((line) => { const name = categories.get(line.categoryId)?.name ?? "Категория"; return <li key={line.id}><div><strong>{name}</strong><span>{rubles(line.plannedMinor)} в месяц</span></div><button className="secondary-button" type="button" aria-label={`Изменить повседневный лимит «${name}»`} onClick={() => edit(line.id)}>Изменить</button><button className="text-button" type="button" aria-label={`Архивировать повседневный лимит «${name}»`} onClick={() => void save.run((state) => archiveFlexibleLine(state, line.id))}>В архив</button></li>; })}</ul>
    {archivedLines.length ? <div><h3>Архив повседневных лимитов</h3><ul className="planning-edit-list">{archivedLines.map((line) => {
      const category = categories.get(line.categoryId);
      if (!category) return null;
      const controlId = restoreControlId(category.id);
      const draft = restoreDrafts[category.id] ?? { amount: moneyInput(line.plannedMinor), error: null };
      return <li key={line.id}><strong>{category.name}</strong><div className="field"><label htmlFor={controlId}>Лимит «{category.name}» при возврате, ₽</label><input id={controlId} inputMode="decimal" maxLength={24} value={draft.amount} aria-invalid={draft.error ? true : undefined} aria-describedby={draft.error ? `${controlId}-error` : undefined} onChange={(event) => setRestoreDrafts((current) => changeRestoreDraft(current, category.id, event.target.value))} /><FieldError id={controlId} message={draft.error ?? undefined} /></div><button className="secondary-button" type="button" aria-label={`Вернуть повседневный лимит «${category.name}»`} disabled={restoringId === category.id} onClick={() => void restore(line.id, category.id, category.name, moneyInput(line.plannedMinor))}>Вернуть лимит</button></li>;
    })}</ul></div> : null}
  </section>;
}

export function PlanningScreen({ onDirtyChange, ...props }: PlanningScreenProps) {
  const dirtyState = useRef<PlanningDraftDirtyState>({
    commitment: false,
    schedule: false,
    flexible: false,
  });
  const overallDirty = useRef(false);
  const reportDirty = useCallback((editor: PlanningEditor, dirty: boolean) => {
    if (dirtyState.current[editor] === dirty) return;
    dirtyState.current = { ...dirtyState.current, [editor]: dirty };
    const nextOverall = hasUnsavedPlanningDrafts(dirtyState.current);
    if (nextOverall === overallDirty.current) return;
    overallDirty.current = nextOverall;
    onDirtyChange?.(nextOverall);
  }, [onDirtyChange]);
  const reportCommitmentDirty = useCallback(
    (dirty: boolean) => reportDirty("commitment", dirty),
    [reportDirty],
  );
  const reportScheduleDirty = useCallback(
    (dirty: boolean) => reportDirty("schedule", dirty),
    [reportDirty],
  );
  const reportFlexibleDirty = useCallback(
    (dirty: boolean) => reportDirty("flexible", dirty),
    [reportDirty],
  );

  useEffect(() => () => {
    dirtyState.current = { commitment: false, schedule: false, flexible: false };
    overallDirty.current = false;
    onDirtyChange?.(false);
  }, [onDirtyChange]);

  return <div className="planning-screen">
    <header className="screen-heading"><div><span className="card-kicker">Настройки горизонта</span><h1>Плановые расходы</h1><p>Четыре слоя хранятся отдельно и сразу пересчитывают 12–24 месяца.</p></div></header>
    <CommitmentsEditor {...props} onDirtyChange={reportCommitmentDirty} />
    <SchedulesEditor {...props} onDirtyChange={reportScheduleDirty} />
    <FlexibleEditor {...props} onDirtyChange={reportFlexibleDirty} />
  </div>;
}
