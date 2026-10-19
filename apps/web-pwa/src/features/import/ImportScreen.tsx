import { type ChangeEvent, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type BudgetState, type CategoryType } from "@family-budget/domain";
import { BackButton } from "../../components/BackButton";
import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import { categoryVisual } from "../../category-visual";
import { formatMoney } from "../../money";
import { groupedCategoryOptions } from "../operations/category-picker";
import { toOperationsErrorView } from "../operations/model";
import { classifyStatement, type ClassificationTier, type ClassifiedStatement, type MerchantMemoryEntry } from "./classify";
import { MAX_STATEMENT_BYTES, StatementParseError } from "./csv";
import { createImportMemory, type ImportMemory } from "./memory";
import { applyImportPlan, buildImportPlan, undoImport, type Assignment, type ImportChoices, type ImportPlan } from "./plan";
import { parseStatement, type ParsedStatement } from "./statement";
import { plural } from "../../plural";
import { createDraftSaving, useDraftGuard } from "../../navigation/draft-guard";

/**
 * Экран «Выписка банка»: файл → предпросмотр → бюджет, с отменой.
 *
 * Разбор идёт целиком на устройстве, и это сказано на экране в момент выбора файла, а не в
 * политике мелким шрифтом. Сам файл не хранится: байты живут ровно до конца разбора, дальше в
 * состоянии экрана лежат только операции. Ничего не попадает в бюджет, пока человек не увидел,
 * что получится, и не нажал «Добавить»; а добавленное отменяется одной кнопкой — тем же
 * координатором записи, что и ручной ввод, поэтому и импорт, и его отмена уезжают в журнал семьи
 * как обычные правки.
 */
export interface ImportScreenProps {
  readonly budget: BudgetState;
  readonly onChange: (change: (current: BudgetState) => BudgetState) => Promise<unknown>;
  readonly onBack: () => void;
  /** Память назначений; без неё экран спрашивает про каждого незнакомого продавца каждый раз. */
  readonly memory?: ImportMemory;
  /** Начальная стадия — для проверок, которые рисуют предпросмотр без файла. */
  readonly initialStage?: ImportStage;
  readonly now?: () => Date;
}

export interface ReviewStage {
  readonly kind: "review";
  readonly parsed: ParsedStatement;
  readonly classified: ClassifiedStatement;
  readonly choices: ImportChoices;
}

export interface DoneStage {
  readonly kind: "done";
  readonly ids: readonly string[];
  readonly count: number;
  readonly expenseMinor: number;
  readonly incomeMinor: number;
  readonly transferMinor: number;
}

export type ImportStage =
  | { readonly kind: "pick"; readonly notice: string | null }
  | ReviewStage
  | DoneStage;

export const IMPORT_TITLE_ID = "import-title";
export const IMPORT_FILE_INPUT_ID = "statement-file";
export const IMPORT_ERROR_ID = "import-error";

/** Обещание приватности — то, что человек читает, выбирая файл. Коротко и без божбы. */
export const IMPORT_PRIVACY_TITLE = "Файл читается на этом устройстве";
export const IMPORT_PRIVACY_TEXT = "Он никуда не отправляется и не сохраняется. После разбора остаются только операции, которые вы подтвердите, — они попадут в бюджет так же, как записанные вручную.";

const SKIP_VALUE = "#skip";
const NO_CATEGORY_VALUE = "#none";

const dateLong = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const dateShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

function formatDay(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : dateLong.format(date).replace(/ /gu, "\u00a0");
}

function formatDateShort(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : dateShort.format(date).replace(".", "");
}

/** «с 1 по 25 августа» либо «с 28 июля по 25 августа»: месяц называется один раз, если он один. */
export function periodWords(period: { readonly from: string; readonly to: string } | null): string {
  if (period === null) return "";
  if (period.from === period.to) return formatDay(period.from);
  if (period.from.slice(0, 7) === period.to.slice(0, 7)) {
    return `с ${Number(period.from.slice(8, 10))} по ${formatDay(period.to)}`;
  }
  return `с ${formatDay(period.from)} по ${formatDay(period.to)}`;
}

const OPERATIONS: readonly [string, string, string] = ["операция", "операции", "операций"];

const tierWords: Record<ClassificationTier, string> = {
  bank: "категория банка",
  merchant: "по названию",
  memory: "как вы назначали",
};

interface MerchantGroup {
  readonly key: string;
  readonly title: string;
  readonly direction: "in" | "out";
  readonly count: number;
  readonly amountMinor: number;
  readonly days: readonly string[];
}

/** Незнакомые продавцы — по одному на ключ: назначение применяется ко всем строкам сразу. */
export function unknownMerchantGroups(classified: ClassifiedStatement): readonly MerchantGroup[] {
  const groups = new Map<string, { title: string; direction: "in" | "out"; count: number; amountMinor: number; days: Set<string> }>();
  for (const row of classified.rows) {
    if (row.placement.kind !== "unknown") continue;
    const key = row.merchantKey || `#${row.operation.line}`;
    const group = groups.get(key) ?? { title: row.operation.description || "Без описания", direction: row.operation.direction, count: 0, amountMinor: 0, days: new Set<string>() };
    group.count += 1;
    group.amountMinor += row.operation.amountMinor;
    group.days.add(row.operation.occurredOn);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, title: group.title, direction: group.direction, count: group.count, amountMinor: group.amountMinor, days: [...group.days].sort() }))
    .sort((left, right) => right.amountMinor - left.amountMinor);
}

function assignmentValue(assignment: Assignment | undefined): string {
  if (assignment === undefined) return "";
  if (assignment.kind === "skip") return SKIP_VALUE;
  if (assignment.kind === "no-category") return NO_CATEGORY_VALUE;
  return assignment.categoryId;
}

function assignmentFrom(value: string): Assignment | undefined {
  if (value === "") return undefined;
  if (value === SKIP_VALUE) return { kind: "skip" };
  if (value === NO_CATEGORY_VALUE) return { kind: "no-category" };
  return { kind: "category", categoryId: value };
}

function defaultChoices(budget: BudgetState): ImportChoices {
  return {
    accountId: budget.accounts.find((account) => account.active)?.id ?? "",
    transferAccountId: null,
    assignments: {},
    includeDuplicates: false,
  };
}

export function ImportScreen({ budget, onChange, onBack, memory, initialStage, now = () => new Date() }: ImportScreenProps) {
  const [stage, setStage] = useState<ImportStage>(initialStage ?? { kind: "pick", notice: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const store = useMemo(() => memory ?? createImportMemory(), [memory]);
  const dirty = stage.kind === "review";
  // Предпросмотр с выбранными назначениями — черновик: уход с экрана его теряет. «Добавить»
  // переводит его в «записывается» до первого `await`; неудача возвращает, удача сменяет стадию —
  // и защёлка отпускает, как только нарисована стадия без предпросмотра.
  const [saving] = useState(createDraftSaving);
  useLayoutEffect(() => {
    saving.settle(dirty);
  });
  useDraftGuard({
    label: "выписка, ещё не добавленная в бюджет",
    isDirty: () => dirty && !saving.saving,
    discard: () => setStage({ kind: "pick", notice: null }),
  });
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: false });
  }, [stage.kind]);

  const plan = useMemo<ImportPlan | null>(
    () => (stage.kind === "review" ? buildImportPlan(stage.classified.rows, budget, stage.choices, now()) : null),
    [budget, now, stage],
  );

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Поле очищается сразу: ссылка на файл не живёт дольше этого обработчика.
    event.target.value = "";
    if (!file || busy) return;
    setError(null);
    if (file.size > MAX_STATEMENT_BYTES) {
      setError("Файл больше 5 МБ. Выгрузите период покороче.");
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseStatement(bytes);
      if (parsed.operations.length === 0) {
        setError("В файле нет ни одной проведённой операции в рублях.");
        return;
      }
      let entries: readonly MerchantMemoryEntry[] = [];
      try {
        entries = await store.load();
      } catch {
        // Память недоступна — импорт работает, только спрашивает про всех незнакомых.
      }
      const classified = classifyStatement(parsed.operations, budget, entries);
      setStage({ kind: "review", parsed, classified, choices: defaultChoices(budget) });
    } catch (cause) {
      setError(cause instanceof StatementParseError ? cause.userMessage : "Не удалось прочитать файл как выписку. Данные не изменены.");
    } finally {
      setBusy(false);
    }
  };

  const patchChoices = (patch: Partial<ImportChoices>) => {
    setStage((current) => (current.kind === "review" ? { ...current, choices: { ...current.choices, ...patch } } : current));
    setError(null);
  };
  const assign = (key: string, value: string) => {
    setStage((current) => {
      if (current.kind !== "review") return current;
      const assignments = { ...current.choices.assignments };
      const assignment = assignmentFrom(value);
      if (assignment === undefined) delete assignments[key];
      else assignments[key] = assignment;
      return { ...current, choices: { ...current.choices, assignments } };
    });
    setError(null);
  };
  const forget = () => {
    setStage({ kind: "pick", notice: null });
    setError(null);
  };

  const confirm = async () => {
    if (stage.kind !== "review" || plan === null || busy || plan.drafts.length === 0) return;
    const ticket = saving.begin();
    setBusy(true);
    setError(null);
    let ids: readonly string[] = [];
    try {
      await onChange((current) => {
        const applied = applyImportPlan(current, plan.drafts);
        ids = applied.ids;
        return applied.state;
      });
      saving.succeed(ticket);
      try {
        await store.remember(plan.memoryUpdates);
      } catch {
        // Не запомнилось — операции уже в бюджете, и это главное; спросят ещё раз.
      }
      setStage({
        kind: "done",
        ids,
        count: plan.counts.included,
        expenseMinor: plan.totals.expenseMinor,
        incomeMinor: plan.totals.incomeMinor,
        transferMinor: plan.totals.transferMinor,
      });
    } catch (cause) {
      saving.fail(ticket);
      setError(toOperationsErrorView(cause).message);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (stage.kind !== "done" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ids = stage.ids;
      await onChange((current) => undoImport(current, ids));
      setStage({ kind: "pick", notice: `Импорт отменён: ${plural(ids.length, OPERATIONS)} удалены из бюджета.` });
    } catch (cause) {
      setError(toOperationsErrorView(cause).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="import-screen" aria-busy={busy}>
      <div className="planning-toolbar">
        <BackButton label={stage.kind === "review" ? "Другой файл" : "К разделу «Ещё»"} onClick={stage.kind === "review" ? forget : onBack} />
      </div>
      {stage.kind === "pick" ? <PickStage busy={busy} error={error} notice={stage.notice} titleRef={titleRef} onPick={(event) => void pick(event)} /> : null}
      {stage.kind === "review" && plan !== null ? (
        <ReviewStage budget={budget} stage={stage} plan={plan} busy={busy} error={error} titleRef={titleRef} onChoices={patchChoices} onAssign={assign} onConfirm={() => void confirm()} onForget={forget} />
      ) : null}
      {stage.kind === "done" ? <DoneStage stage={stage} busy={busy} error={error} titleRef={titleRef} onUndo={() => void undo()} onAnother={forget} onBack={onBack} /> : null}
    </div>
  );
}

interface StageProps {
  readonly busy: boolean;
  readonly error: string | null;
  readonly titleRef: RefObject<HTMLHeadingElement | null>;
}

function ErrorLine({ message }: { readonly message: string | null }) {
  return message ? <p className="field-error" id={IMPORT_ERROR_ID} role="alert">{message}</p> : null;
}

/**
 * Выбор файла. Обещание приватности стоит здесь плашкой — там, где палец выбирает файл, — а не
 * в свёрнутой строке политики: выписка — самое чувствительное, что человек может дать приложению.
 */
export function PickStage({ busy, error, notice, titleRef, onPick }: StageProps & { readonly notice: string | null; readonly onPick: (event: ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <section className="section-card import-card" aria-labelledby={IMPORT_TITLE_ID}>
      <span className="card-kicker">Данные</span>
      <h1 id={IMPORT_TITLE_ID} ref={titleRef} tabIndex={-1}>Выписка банка</h1>
      <p className="body-copy">Выгрузите операции из Т-Банка в CSV и выберите файл. Приложение разберёт его на покупки, доходы и переводы и разложит по вашим категориям; незнакомое покажет списком и спросит.</p>
      <div className="import-privacy" role="note">
        <span className="import-privacy-mark" aria-hidden="true"><Icon name="shield" size={24} /></span>
        <div>
          <strong>{IMPORT_PRIVACY_TITLE}</strong>
          <p>{IMPORT_PRIVACY_TEXT}</p>
        </div>
      </div>
      {notice ? <p className="field-hint" role="status">{notice}</p> : null}
      <label className="file-button primary-button wide" htmlFor={IMPORT_FILE_INPUT_ID}>
        <span className="icon-label"><Icon name="upload" size={20} />{busy ? "Разбираем…" : "Выбрать файл выписки"}</span>
        <input id={IMPORT_FILE_INPUT_ID} type="file" accept=".csv,text/csv,text/plain" disabled={busy} aria-describedby={error ? IMPORT_ERROR_ID : undefined} onChange={onPick} />
      </label>
      <ErrorLine message={error} />
      <details className="row-disclosure">
        <summary>Как выгрузить из Т-Банка</summary>
        <ol>
          <li>В приложении или на сайте банка откройте счёт и историю операций.</li>
          <li>Нажмите «Выгрузка операций» и выберите формат CSV.</li>
          <li>Сохраните файл и выберите его здесь. Кодировку и разделитель приложение определит само.</li>
        </ol>
        <p className="field-hint">Отменённые операции, нулевые суммы и покупки в чужой валюте без рублёвой суммы пропускаются и считаются отдельно.</p>
      </details>
    </section>
  );
}

function SummaryRow({ label, count, minor, note, tone }: { readonly label: string; readonly count: number; readonly minor?: number; readonly note?: string; readonly tone?: "muted" | "short" }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={tone}>
        {plural(count, OPERATIONS)}{minor === undefined ? "" : <> · <Money value={minor} /></>}
        {note ? <small>{note}</small> : null}
      </dd>
    </div>
  );
}

/**
 * Предпросмотр: что получится, до того как это попадёт в бюджет. Сначала числа — разобрано,
 * покупки, приходы, переводы себе, пропущенное; потом незнакомые продавцы с выбором категории;
 * потом узнанное — свёрнутым списком. Кнопка добавления называет число операций словами.
 */
export function ReviewStage({ budget, stage, plan, busy, error, titleRef, onChoices, onAssign, onConfirm, onForget }: StageProps & {
  readonly budget: BudgetState;
  readonly stage: ReviewStage;
  readonly plan: ImportPlan;
  readonly onChoices: (patch: Partial<ImportChoices>) => void;
  readonly onAssign: (key: string, value: string) => void;
  readonly onConfirm: () => void;
  readonly onForget: () => void;
}) {
  const { parsed, classified, choices } = stage;
  const { counts, totals } = plan;
  const accounts = budget.accounts.filter((account) => account.active);
  const otherAccounts = accounts.filter((account) => account.id !== choices.accountId);
  const groups = unknownMerchantGroups(classified);
  const categoryById = new Map(budget.categories.map((category) => [category.id, category]));
  const known = plan.rows.filter((item) => item.reason === "included" && item.row.placement.kind !== "self-transfer");
  const selfTransfers = plan.rows.filter((item) => item.row.placement.kind === "self-transfer");
  const skippedTotal = parsed.skipped.failed + parsed.skipped.foreignCurrency + parsed.skipped.zeroAmount + parsed.skipped.unreadable;
  const skippedNote = [
    parsed.skipped.failed ? `отменённые ${parsed.skipped.failed}` : "",
    parsed.skipped.zeroAmount ? `нулевые ${parsed.skipped.zeroAmount}` : "",
    parsed.skipped.foreignCurrency ? `в другой валюте ${parsed.skipped.foreignCurrency}` : "",
    parsed.skipped.unreadable ? `нечитаемые ${parsed.skipped.unreadable}` : "",
  ].filter((part) => part).join(" · ");
  const period = periodWords(parsed.period);
  const activeBudget = budget.budgets.find((item) => item.id === budget.activeBudgetId);
  const monthWord = activeBudget ? formatDay(activeBudget.startDate).split(" ")[1] ?? "" : "";
  const submitLabel = counts.included === 0 ? "Добавить нечего" : `Добавить ${plural(counts.included, OPERATIONS)} в бюджет`;
  const optionsFor = (type: CategoryType) => groupedCategoryOptions(budget, type);

  return <>
    <section className="section-card import-card" aria-labelledby={IMPORT_TITLE_ID}>
      <span className="card-kicker">Выписка{period ? ` · ${period}` : ""}</span>
      <h1 id={IMPORT_TITLE_ID} ref={titleRef} tabIndex={-1}>Разобрано: {plural(classified.summary.total, OPERATIONS)}</h1>
      <p className="body-copy">Файл прочитан на устройстве и уже забыт — дальше только эти операции. В бюджет они попадут, когда вы нажмёте кнопку внизу; до этого ничего не меняется.</p>
      <dl className="import-summary">
        <SummaryRow label="Покупки" count={counts.expenses} minor={totals.expenseMinor} />
        <SummaryRow label="Приходы" count={counts.incomes} minor={totals.incomeMinor} />
        {counts.transfers > 0 ? <SummaryRow label="Переводы между своими" count={counts.transfers} minor={totals.transferMinor} note="переводом между счетами, не тратой" /> : null}
        {counts.selfTransfersExcluded > 0 ? <SummaryRow label="Переводы себе" count={counts.selfTransfersExcluded} minor={totals.selfTransferExcludedMinor} note="не трата и не доход — в бюджет не идут" tone="muted" /> : null}
        {counts.unassigned > 0 ? <SummaryRow label="Без категории" count={counts.unassigned} note="ждут назначения ниже; без него не добавятся" tone="short" /> : null}
        {counts.skipped > 0 ? <SummaryRow label="Пропущено вами" count={counts.skipped} tone="muted" /> : null}
        {counts.duplicateCandidates > 0 ? <SummaryRow label="Похожи на уже записанные" count={counts.duplicateCandidates} note={choices.includeDuplicates ? "та же дата, сумма и счёт — будут добавлены ещё раз" : "та же дата, сумма и счёт — не добавляются"} tone={choices.includeDuplicates ? "short" : "muted"} /> : null}
        {counts.outsidePeriod > 0 && monthWord ? <SummaryRow label={`Вне ${monthWord}, месяца плана`} count={counts.outsidePeriod} note="попадут в историю, конверты не изменят" tone="muted" /> : null}
        {skippedTotal > 0 ? <SummaryRow label="Пропущено при разборе" count={skippedTotal} note={skippedNote} tone="muted" /> : null}
      </dl>
      <div className="import-choices">
        {accounts.length > 1 ? <div className="field">
          <label htmlFor="import-account">Счёт выписки</label>
          <select id="import-account" value={choices.accountId} disabled={busy} onChange={(event) => onChoices({ accountId: event.target.value, transferAccountId: choices.transferAccountId === event.target.value ? null : choices.transferAccountId })}>
            {accounts.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}
          </select>
        </div> : null}
        {classified.summary.selfTransfer > 0 && otherAccounts.length > 0 ? <div className="field">
          <label htmlFor="import-transfer-account">Переводы между своими счетами</label>
          <select id="import-transfer-account" value={choices.transferAccountId ?? ""} disabled={busy} onChange={(event) => onChoices({ transferAccountId: event.target.value === "" ? null : event.target.value })}>
            <option value="">Не добавлять</option>
            {otherAccounts.map((account) => <option value={account.id} key={account.id}>Считать переводами на «{account.name}»</option>)}
          </select>
          <small>Переводы себе — не траты. Если второй счёт ведётся здесь, их можно записать переводами между счетами.</small>
        </div> : null}
        {/* Переключатель живёт, пока есть похожие строки, — и после включения тоже: иначе его нельзя выключить. */}
        {counts.duplicateCandidates > 0 ? <label className="field-hint"><input type="checkbox" checked={choices.includeDuplicates} disabled={busy} onChange={(event) => onChoices({ includeDuplicates: event.target.checked })} /> Всё же добавить похожие на уже записанные</label> : null}
      </div>
    </section>

    {groups.length > 0 ? <section className="section-card" aria-labelledby="import-unknown-title">
      <div className="section-title"><div><h2 id="import-unknown-title">Не узнали: {plural(groups.length, ["продавец", "продавца", "продавцов"])}</h2><p>Назначьте категорию — она применится ко всем операциям этого продавца и запомнится на следующий раз. Без категории операция в бюджет не попадёт.</p></div></div>
      <ul className="import-merchants">
        {groups.map((group, index) => {
          const id = `import-merchant-${index}`;
          const type: CategoryType = group.direction === "out" ? "expense" : "income";
          const days = group.days.length === 1 ? formatDay(group.days[0]!) : `${group.days.length === 2 ? `${formatDay(group.days[0]!)} и ${formatDay(group.days[1]!)}` : `${formatDay(group.days[0]!)} — ${formatDay(group.days[group.days.length - 1]!)}`}`;
          return <li className="import-merchant" key={group.key}>
            <div className="field">
              <label htmlFor={id}>
                <strong>{group.title}</strong>
                <small>{plural(group.count, OPERATIONS)} · {group.direction === "out" ? "списание" : "зачисление"} <Money value={group.amountMinor} /> · {days}</small>
              </label>
              <select id={id} value={assignmentValue(choices.assignments[group.key])} disabled={busy} onChange={(event) => onAssign(group.key, event.target.value)}>
                <option value="">Выберите категорию</option>
                {optionsFor(type).map((optionGroup) => <optgroup label={optionGroup.title} key={optionGroup.key}>
                  {optionGroup.options.map((option) => <option value={option.id} key={option.id}>{option.name}</option>)}
                </optgroup>)}
                {type === "income" ? <option value={NO_CATEGORY_VALUE}>Доход без категории</option> : null}
                <option value={SKIP_VALUE}>Пропустить — не добавлять</option>
              </select>
            </div>
          </li>;
        })}
      </ul>
    </section> : null}

    <details className="section-card collapsible-card" open={groups.length === 0 || undefined}>
      <summary><span>Узнали: {plural(known.length, OPERATIONS)}</span><Icon name="chevron-right" size={24} className="row-chevron" /></summary>
      {known.length ? <ul className="transaction-list">{known.map(({ row, draft }) => {
        const categoryId = draft?.kind === "expense" || draft?.kind === "income" ? draft.categoryId : "";
        const category = categoryId ? categoryById.get(categoryId) : undefined;
        const visual = category ? categoryVisual(category) : null;
        const via = row.placement.kind === "expense" || row.placement.kind === "income" ? tierWords[row.placement.via] : "";
        const kind = draft?.kind ?? "expense";
        return <li className={`transaction-row ${kind}`} key={row.operation.line}>
          <span className={`transaction-icon ${visual ? `tone-${visual.tone}` : "tone-neutral"}`}><Icon name={visual ? visual.icon : kind === "income" ? "arrow-down-left" : "arrow-up-right"} size={24} /></span>
          <span className="transaction-copy">
            <strong>{category ? category.name : kind === "income" ? "Доход без категории" : "Расход"}</strong>
            <small>{formatDateShort(row.operation.occurredOn)} · {row.operation.description || "без описания"}{via ? ` · ${via}` : ""}</small>
          </span>
          <b><Money value={row.operation.amountMinor} sign={kind === "income" ? "+" : "−"} /></b>
        </li>;
      })}</ul> : <p className="field-hint">Ни одной операции не узнали — всё ждёт назначения выше.</p>}
    </details>

    {selfTransfers.length > 0 ? <details className="section-card collapsible-card">
      <summary><span>Переводы себе: {plural(selfTransfers.length, OPERATIONS)}</span><Icon name="chevron-right" size={24} className="row-chevron" /></summary>
      <p className="field-hint">Деньги перешли между вашими же счетами. Это не трата и не доход, и в картину месяца они не попадают.</p>
      <ul className="transaction-list">{selfTransfers.map(({ row, draft }) => <li className="transaction-row transfer" key={row.operation.line}>
        <span className="transaction-icon tone-neutral"><Icon name="arrow-left-right" size={24} /></span>
        <span className="transaction-copy"><strong>{draft ? "Перевод между счетами" : "Перевод себе"}</strong><small>{formatDateShort(row.operation.occurredOn)} · {row.operation.description}{draft ? "" : " · не добавляется"}</small></span>
        <b><Money value={row.operation.amountMinor} /></b>
      </li>)}</ul>
    </details> : null}

    <div className="record-action">
      <button className="primary-button wide" type="button" disabled={busy || counts.included === 0} aria-busy={busy} onClick={onConfirm}>{busy ? "Записываем…" : submitLabel}</button>
      {counts.unassigned > 0 ? <p className="field-hint" role="status">{plural(counts.unassigned, OPERATIONS)} без категории не будут добавлены.</p> : null}
      <ErrorLine message={error} />
      <button className="secondary-button wide" type="button" disabled={busy} onClick={onForget}>Отменить и забыть файл</button>
    </div>
  </>;
}

/**
 * Квитанция импорта — и выход из него. Отмена удаляет ровно добавленные операции одним изменением;
 * то же место предлагает следующую выписку и дорогу назад.
 */
export function DoneStage({ stage, busy, error, titleRef, onUndo, onAnother, onBack }: StageProps & {
  readonly stage: DoneStage;
  readonly onUndo: () => void;
  readonly onAnother: () => void;
  readonly onBack: () => void;
}) {
  const parts = [
    stage.expenseMinor > 0 ? `покупки ${formatMoney(stage.expenseMinor)}` : "",
    stage.incomeMinor > 0 ? `приходы ${formatMoney(stage.incomeMinor)}` : "",
    stage.transferMinor > 0 ? `переводы ${formatMoney(stage.transferMinor)}` : "",
  ].filter((part) => part).join(" · ");
  return (
    <section className="section-card import-card import-done" aria-labelledby={IMPORT_TITLE_ID}>
      <span className="card-kicker">Выписка</span>
      <h1 id={IMPORT_TITLE_ID} ref={titleRef} tabIndex={-1}>Добавлено: {plural(stage.count, OPERATIONS)}</h1>
      <div className="save-receipt" role="status">
        <span className="save-receipt-mark" aria-hidden="true"><Icon name="circle-check" size={24} /></span>
        <div className="save-receipt-copy">
          <strong>Записано в бюджет</strong>
          {parts ? <small>{parts}</small> : null}
        </div>
      </div>
      <p className="body-copy">Операции стоят в истории и в конвертах месяца как записанные вручную: их можно править и удалять по одной на экране «Записать». А можно отменить весь импорт разом.</p>
      <ErrorLine message={error} />
      <button className="secondary-button danger-button wide" type="button" disabled={busy} aria-busy={busy} onClick={onUndo}>{busy ? "Отменяем…" : `Отменить импорт — удалить ${plural(stage.count, OPERATIONS)}`}</button>
      <button className="primary-button wide" type="button" disabled={busy} onClick={onAnother}>Загрузить ещё одну выписку</button>
      <button className="secondary-button wide" type="button" disabled={busy} onClick={onBack}>Готово</button>
    </section>
  );
}
