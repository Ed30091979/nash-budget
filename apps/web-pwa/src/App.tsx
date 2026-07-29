import { useEffect, useMemo, useRef, useState } from "react";
import {
  calculateAnnualPlan,
  calculateBudget,
  makePlanningSeed,
  type AnnualCommitment,
  type BudgetState,
  type ScheduledExpense,
  type Transaction,
} from "@family-budget/domain";
import {
  requestStorageHealth,
  type StorageHealth,
} from "@family-budget/storage";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { DashboardScreen, OperationsSearch } from "./features/dashboard";
import { DataManagementScreen } from "./features/data-management";
import { OperationsScreen } from "./features/operations";
import { PlanningScreen } from "./features/planning";
import { Onboarding } from "./onboarding/Onboarding";
import { persistCompletedOnboarding } from "./onboarding/model";
import { createBudgetBackup, prepareBudgetState, restoreBudgetBackup } from "./backup";
import { formatMoney } from "./money";
import { createBudgetRepository } from "./storage-repository";

export type Screen = "today" | "year" | "planning" | "operations" | "more";
type LoadState = "loading" | "empty" | "ready" | "error";

const monthLong = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
const dateShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const calendarMonths = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
export const DISCARD_DRAFT_CONFIRMATION = "Несохранённый черновик будет удалён. Перейти в другой раздел?";

const statusLabels: Record<string, string> = {
  no_plan: "Без лимита",
  normal: "В норме",
  near_limit: "Почти лимит",
  exhausted: "Лимит исчерпан",
  over_limit: "Перелимит",
  funded: "Сумма собрана",
  on_track: "По плану",
  due_soon: "Скоро платёж",
  overdue: "Срок прошёл",
};

const transactionLabels: Record<Transaction["kind"], string> = {
  income: "Доход",
  expense: "Расход",
  refund: "Возврат",
  transfer: "Перевод",
  goal_contribution: "Взнос в цель",
};

interface AppBudgetSaveOptions {
  readonly repository: {
    loadVersioned(): Promise<{ readonly value: BudgetState; readonly revision: string } | null>;
    saveIfRevision(expectedRevision: string | null, state: BudgetState): Promise<
      | { readonly status: "saved"; readonly value: BudgetState; readonly revision: string }
      | { readonly status: "conflict"; readonly current: { readonly value: BudgetState; readonly revision: string } | null }
    >;
  };
  readonly getCurrent: () => BudgetState;
  readonly getRevision: () => string | null;
  readonly setRevision: (revision: string) => void;
  readonly publish: (state: BudgetState, revision: string) => void;
}

export const BUDGET_WRITE_CONFLICT_MESSAGE = "Бюджет уже изменён в другой вкладке. Показана сохранённая версия; повторите изменение.";
export const MAIN_CONTENT_ID = "main-content";

interface CapacitorRuntimeContract {
  readonly isNativePlatform?: () => boolean;
}

interface NetworkStatusPresentation {
  readonly text: "в сети" | "офлайн" | "локально на устройстве";
  readonly ariaLabel: string;
  readonly className: string;
}

export function isCapacitorNativeRuntime(scope: unknown = globalThis): boolean {
  if (!scope || (typeof scope !== "object" && typeof scope !== "function")) return false;
  const runtime = (scope as { readonly Capacitor?: unknown }).Capacitor;
  if (!runtime || (typeof runtime !== "object" && typeof runtime !== "function")) return false;
  const contract = runtime as CapacitorRuntimeContract;
  if (typeof contract.isNativePlatform !== "function") return false;
  try {
    return contract.isNativePlatform.call(runtime) === true;
  } catch {
    return false;
  }
}

export function networkStatusPresentation(nativeRuntime: boolean, online: boolean): NetworkStatusPresentation {
  if (nativeRuntime) {
    return {
      text: "локально на устройстве",
      ariaLabel: "Состояние сети: локально на устройстве",
      className: "network-badge",
    };
  }
  const text = online ? "в сети" : "офлайн";
  return {
    text,
    ariaLabel: `Состояние сети: ${text}`,
    className: `network-badge${online ? "" : " offline"}`,
  };
}

export function focusRouteHeading(root: ParentNode | null): boolean {
  const heading = root?.querySelector<HTMLElement>("h1");
  if (!heading) return false;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
  return true;
}

export function shouldChangeScreen(
  current: Screen,
  destination: Screen,
  hasUnsavedDraft: boolean,
  confirmDiscard: () => boolean,
): boolean {
  if (current === destination) return false;
  return !hasUnsavedDraft || confirmDiscard();
}

export function protectUnsavedDraftOnUnload(event: BeforeUnloadEvent, hasUnsavedDraft: boolean): void {
  if (!hasUnsavedDraft) return;
  event.preventDefault();
  event.returnValue = "";
}

function SkipLink() {
  return <a className="skip-link" href={`#${MAIN_CONTENT_ID}`}>К основному содержимому</a>;
}

function writeConflict(): Error {
  return new Error(BUDGET_WRITE_CONFLICT_MESSAGE);
}

function sameBudget(left: BudgetState, right: BudgetState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Every post-onboarding mutation is serialized, CAS-saved, and only then shown. */
export function createAppBudgetSaveCoordinator(options: AppBudgetSaveOptions) {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    get locked() { return pending > 0; },
    async apply(change: (current: BudgetState) => BudgetState): Promise<BudgetState> {
      pending += 1;
      let resolveResult!: (state: BudgetState) => void;
      let rejectResult!: (reason: unknown) => void;
      const result = new Promise<BudgetState>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      tail = tail.catch(() => undefined).then(async () => {
        try {
          let expectedRevision = options.getRevision();
          if (expectedRevision === null) {
            const snapshot = await options.repository.loadVersioned();
            if (!snapshot) throw writeConflict();
            const winner = prepareBudgetState(snapshot.value);
            if (!sameBudget(options.getCurrent(), winner)) {
              options.publish(winner, snapshot.revision);
              throw writeConflict();
            }
            expectedRevision = snapshot.revision;
            options.setRevision(snapshot.revision);
          }

          const candidate = prepareBudgetState(change(options.getCurrent()));
          const saved = await options.repository.saveIfRevision(expectedRevision, candidate);
          if (saved.status === "conflict") {
            if (saved.current) {
              const winner = prepareBudgetState(saved.current.value);
              options.publish(winner, saved.current.revision);
            }
            throw writeConflict();
          }

          const stored = prepareBudgetState(saved.value);
          options.publish(stored, saved.revision);
          resolveResult(stored);
        } catch (error) {
          rejectResult(error);
        } finally {
          pending -= 1;
        }
      });
      return result;
    },
  };
}

function formatDate(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : dateShort.format(date);
}

function formatMonth(value: string): string {
  const date = new Date(`${value}-01T00:00:00.000Z`);
  return monthLong.format(date).replace(" г.", "");
}

function transactionCategoryId(transaction: Transaction): string | null {
  return transaction.kind === "expense" || transaction.kind === "refund" ? transaction.categoryId : null;
}

function transactionSign(transaction: Transaction): string {
  if (transaction.kind === "income" || transaction.kind === "refund") return "+";
  if (transaction.kind === "transfer" || transaction.kind === "goal_contribution") return "↔";
  return "−";
}

function storageText(health: StorageHealth | null): string {
  if (!health) return "Проверяем локальное хранилище…";
  if (health.quota === null || health.usage === null) {
    return health.persisted ? "Постоянное локальное хранение разрешено." : "Хранилище браузера работает в обычном режиме.";
  }
  return `${(health.usage / 1024 / 1024).toFixed(1)} МБ из ${(health.quota / 1024 / 1024).toFixed(0)} МБ`;
}

export default function App() {
  const repository = useMemo(() => createBudgetRepository(), []);
  const nativeRuntime = useMemo(() => isCapacitorNativeRuntime(), []);
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const budgetRef = useRef<BudgetState | null>(null);
  const revisionRef = useRef<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [screen, setScreen] = useState<Screen>("today");
  const [online, setOnline] = useState(navigator.onLine);
  const [storageHealth, setStorageHealth] = useState<StorageHealth | null>(null);
  const [lastSuccessfulBackup, setLastSuccessfulBackup] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [operationDraftDirty, setOperationDraftDirty] = useState(false);
  const [planningDraftDirty, setPlanningDraftDirty] = useState(false);
  const previousScreenRef = useRef<Screen>(screen);
  const hasUnsavedDraft = operationDraftDirty || planningDraftDirty;
  budgetRef.current = budget;

  const budgetSave = useMemo(() => createAppBudgetSaveCoordinator({
    repository,
    getCurrent: () => {
      if (!budgetRef.current) throw new Error("Budget is not ready.");
      return budgetRef.current;
    },
    getRevision: () => revisionRef.current,
    setRevision: (revision) => { revisionRef.current = revision; },
    publish: (next, revision) => {
      budgetRef.current = next;
      revisionRef.current = revision;
      setBudget(next);
    },
  }), [repository]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!cancelled) setLoadState("loading");
      try {
        const stored = await repository.loadVersioned();
        if (!cancelled) {
          if (stored) {
            const prepared = prepareBudgetState(stored.value);
            budgetRef.current = prepared;
            revisionRef.current = stored.revision;
            setBudget(prepared);
            setLoadState("ready");
          } else {
            budgetRef.current = null;
            revisionRef.current = null;
            setBudget(null);
            setLoadState("empty");
          }
        }
      } catch {
        if (!cancelled) {
          budgetRef.current = null;
          revisionRef.current = null;
          setBudget(null);
          setLoadState("error");
        }
      }
      try {
        const createdAt = await repository.getLastSuccessfulBackup();
        if (!cancelled) setLastSuccessfulBackup(createdAt);
      } catch {
        if (!cancelled) setLastSuccessfulBackup(null);
      }
      try {
        const health = await requestStorageHealth();
        if (!cancelled) setStorageHealth(health);
      } catch {
        if (!cancelled) setStorageHealth({ persisted: false, usage: null, quota: null });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [loadAttempt, repository]);

  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    return () => {
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", disconnected);
    };
  }, []);

  useEffect(() => {
    if (!hasUnsavedDraft) return;
    const beforeUnload = (event: BeforeUnloadEvent) => protectUnsavedDraftOnUnload(event, true);
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [hasUnsavedDraft]);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    if (previousScreenRef.current === screen) return;
    previousScreenRef.current = screen;
    focusRouteHeading(document.getElementById(MAIN_CONTENT_ID));
  }, [screen]);

  const metrics = useMemo(() => budget ? calculateBudget(budget) : null, [budget]);
  const plan = useMemo(() => {
    if (!budget) return null;
    const active = budget.budgets.find((item) => item.id === budget.activeBudgetId);
    return calculateAnnualPlan(budget, active?.startDate.slice(0, 7), 24);
  }, [budget]);
  const categoryById = useMemo(
    () => new Map(budget?.categories.map((category) => [category.id, category]) ?? []),
    [budget],
  );

  const publishInitialBudget = (next: BudgetState) => {
    budgetRef.current = next;
    revisionRef.current = null;
    setBudget(next);
    setLoadState("ready");
  };

  const completeOnboarding = async (next: BudgetState) => {
    const result = await persistCompletedOnboarding(repository, prepareBudgetState(next), prepareBudgetState, publishInitialBudget);
    if (result.status === "existing") {
      setMessage("Бюджет уже создан в другой вкладке. Открыли сохранённую там версию; введённые здесь данные её не перезаписали.");
    }
  };

  const loadDemo = async () => {
    const result = await persistCompletedOnboarding(repository, makePlanningSeed(), prepareBudgetState, publishInitialBudget);
    if (result.status === "existing") {
      setMessage("Бюджет уже создан в другой вкладке. Демо не перезаписало сохранённую там версию.");
    }
  };

  if (loadState === "loading") return <><SkipLink /><main id={MAIN_CONTENT_ID} tabIndex={-1} className="loading-state" aria-busy="true"><p>Открываем семейный план…</p></main></>;
  if (loadState === "error") return <><SkipLink /><main id={MAIN_CONTENT_ID} tabIndex={-1} className="loading-state storage-error-state"><section role="alert"><h1>Не удалось открыть локальные данные</h1><p>Мы не подставили демо и не создали новый бюджет. Проверьте, разрешено ли хранение данных для этого сайта.</p><button className="primary-button" type="button" onClick={() => setLoadAttempt((value) => value + 1)}>Повторить</button></section></main></>;
  if (loadState === "empty") return <div className="onboarding-route"><SkipLink /><div id={MAIN_CONTENT_ID} tabIndex={-1}><Onboarding onComplete={completeOnboarding} onDemo={loadDemo} /></div></div>;
  if (!budget || !metrics || !plan) return <><SkipLink /><main id={MAIN_CONTENT_ID} tabIndex={-1} className="loading-state" role="alert"><p>Бюджет не удалось подготовить к показу.</p></main></>;

  const activeBudget = budget.budgets.find((item) => item.id === budget.activeBudgetId)!;
  const flexibleIds = new Set(activeBudget.lines.filter((line) => line.active !== false).map((line) => line.categoryId));
  const activeExpenseCategories = budget.categories.filter((category) => category.active && category.type === "expense");
  const flexibleRows = activeExpenseCategories
    .filter((category) => category.active && flexibleIds.has(category.id))
    .map((category) => ({ category, metric: metrics.categoryMetrics[category.id] }))
    .filter((row) => row.metric);
  const flexibleSpentMinor = flexibleRows.reduce((total, row) => total + (row.metric?.actualMinor ?? 0), 0);
  const safeToSpendMinor = plan.currentMonth.flexiblePlanMinor - flexibleSpentMinor;
  const recentTransactions = [...budget.transactions]
    .filter((transaction) => transaction.status === "posted")
    .sort((left, right) => right.occurredOn.localeCompare(left.occurredOn))
    .slice(0, 5);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const networkStatus = networkStatusPresentation(nativeRuntime, online);
  const navigate = (destination: Screen) => {
    if (shouldChangeScreen(
      screen,
      destination,
      hasUnsavedDraft,
      () => window.confirm(DISCARD_DRAFT_CONFIRMATION),
    )) {
      setScreen(destination);
    }
  };

  return (
    <div className="app-shell">
      <SkipLink />
      <header className="app-header">
        <div className="brand"><span className="brand-mark">₽</span><div><strong>Семейный план</strong><small>видим месяц и будущее</small></div></div>
        <span className={networkStatus.className} role="status" aria-label={networkStatus.ariaLabel}>{networkStatus.text}</span>
      </header>

      <nav className="bottom-nav" aria-label="Основные разделы">
        <NavButton active={screen === "today"} icon="⌂" label="Сегодня" onClick={() => navigate("today")} />
        <NavButton active={screen === "year" || screen === "planning"} icon="▦" label="Год" onClick={() => navigate("year")} />
        <NavButton active={screen === "operations"} icon="＋" label="Записать" onClick={() => navigate("operations")} />
        <NavButton active={screen === "more"} icon="•••" label="Ещё" onClick={() => navigate("more")} />
      </nav>

      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="content" data-layout-contract="no-action-overflow">
        <div className="route-screen" data-screen={screen}>
          {screen === "today" ? <TodayScreen budget={budget} plan={plan} flexibleRows={flexibleRows} safeToSpendMinor={safeToSpendMinor} recentTransactions={recentTransactions} categoryById={categoryById} onAdd={() => navigate("operations")} onYear={() => navigate("year")} /> : null}
          {screen === "year" ? <YearScreen budget={budget} plan={plan} onPlanning={() => navigate("planning")} categoryById={categoryById} /> : null}
          {screen === "planning" ? <><div className="planning-toolbar"><button className="secondary-button" type="button" onClick={() => navigate("year")}>← К горизонту</button></div><PlanningScreen budget={budget} onChange={(change) => budgetSave.apply(change)} onDirtyChange={setPlanningDraftDirty} /></> : null}
          {screen === "operations" ? <><OperationsScreen budget={budget} onChange={(change) => budgetSave.apply(change)} onDirtyChange={setOperationDraftDirty} /><div className="section-card operations-search"><OperationsSearch budget={budget} /></div></> : null}
          {screen === "more" ? <MoreScreen
            budget={budget}
            storageHealth={storageHealth}
            showIosInstall={isIos && !isStandalone}
            lastSuccessfulBackup={lastSuccessfulBackup}
            onCreateBackup={async () => createBudgetBackup(
              budgetRef.current ?? budget,
              async () => undefined,
            )}
            onRecordSuccessfulBackup={async (createdAt) => {
              await repository.setLastSuccessfulBackup(createdAt);
              setLastSuccessfulBackup(createdAt);
            }}
            onRestoreBackup={async (file) => {
              await restoreBudgetBackup(
                file,
                (restored) => budgetSave.apply(() => restored).then(() => undefined),
                () => undefined,
              );
            }}
            onPersistClear={() => repository.clear()}
            onPublishEmpty={() => {
              budgetRef.current = null;
              revisionRef.current = null;
              setBudget(null);
              setLastSuccessfulBackup(null);
              setLoadState("empty");
            }}
          /> : null}
        </div>
      </main>

      {message ? <aside className="message-toast" role="status"><p>{message}</p><button className="primary-button" type="button" onClick={() => setMessage(null)}>Закрыть</button></aside> : null}
      <UpdatePrompt hasUnsavedChanges={operationDraftDirty || planningDraftDirty} />
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: string; label: string; onClick: () => void }) {
  return <button className={`nav-button${active ? " active" : ""}`} type="button" onClick={onClick} aria-current={active ? "page" : undefined}><b aria-hidden="true">{icon}</b><span>{label}</span></button>;
}

type AnnualPlan = ReturnType<typeof calculateAnnualPlan>;
type BudgetMetrics = ReturnType<typeof calculateBudget>;
type CategoryRow = { category: BudgetState["categories"][number]; metric: BudgetMetrics["categoryMetrics"][string] | undefined };

function TodayScreen({ budget, plan, flexibleRows, safeToSpendMinor, recentTransactions, categoryById, onAdd, onYear }: { budget: BudgetState; plan: AnnualPlan; flexibleRows: CategoryRow[]; safeToSpendMinor: number; recentTransactions: Transaction[]; categoryById: Map<string, BudgetState["categories"][number]>; onAdd: () => void; onYear: () => void }) {
  const overLimit = flexibleRows.filter((row) => row.metric?.status === "over_limit");
  const nextId = plan.upcomingCommitmentIds[0];
  const next = budget.annualCommitments.find((item) => item.id === nextId);
  const nextMetrics = next ? plan.commitments[next.id] : undefined;
  return <>
    <h1 className="visually-hidden">Сегодня: семейный бюджет</h1>
    <div className="eyebrow">{formatMonth(plan.startMonth)}</div>
    <section className={`hero-card${safeToSpendMinor < 0 ? " danger" : ""}`}>
      <span>Можно на повседневные расходы</span>
      <strong>{formatMoney(safeToSpendMinor)}</strong>
      <p>Остаток лимитов после уже записанных покупок. Обязательные платежи и накопления учтены отдельно.</p>
      <button className="hero-button" type="button" onClick={onAdd}>+ Записать покупку</button>
    </section>

    {overLimit.length ? <div className="limit-alert danger" role="alert"><b>Перелимит</b><span>{overLimit.map((row) => `${row.category.name}: +${formatMoney(row.metric?.overMinor ?? 0)}`).join(" · ")}</span></div> : null}

    <div className="quick-grid">
      <QuickCard icon="↻" label="Платежи месяца" value={formatMoney(plan.currentMonth.scheduledExpenseMinor)} />
      <QuickCard icon="◎" label="Отложить к срокам" value={formatMoney(plan.currentMonth.annualReserveMinor)} />
      <QuickCard icon="◌" label="Не распределено" value={formatMoney(plan.currentMonth.spendableAfterPlanMinor)} />
    </div>

    {next ? <section className="next-card">
      <div><span className="card-kicker">Ближайший крупный платёж</span><h2>{next.name}</h2><p>{formatDate(next.dueDate)} · {formatMoney(next.amountMinor)}</p></div>
      <div className="reserve-pill"><span>Откладывать</span><b>{formatMoney(nextMetrics?.monthlyReserveMinor ?? 0)}/мес</b></div>
    </section> : null}

    <section className="section-card">
      <SectionTitle title="Повседневные лимиты" note="Мелкие покупки этого месяца" />
      <CategoryList rows={flexibleRows} />
    </section>

    <button className="year-preview" type="button" onClick={onYear}><span><b>Посмотреть 12–24 месяца</b><small>Сезонные расходы, обучение, лагерь, страховка и дом</small></span><strong>→</strong></button>

    <section className="section-card"><SectionTitle title="Последние записи" note="Фактические операции" /><TransactionList transactions={recentTransactions} categoryById={categoryById} /></section>
  </>;
}

function QuickCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return <article className="quick-card"><i aria-hidden="true">{icon}</i><span>{label}</span><strong>{value}</strong></article>;
}

function YearScreen({ budget, plan, onPlanning, categoryById }: { budget: BudgetState; plan: AnnualPlan; onPlanning: () => void; categoryById: Map<string, BudgetState["categories"][number]> }) {
  return <>
    <div className="dashboard-toolbar"><button className="primary-button planning-entry" type="button" onClick={onPlanning}>Настроить план</button></div>
    <DashboardScreen budget={budget} />

    <section className="section-card"><SectionTitle title="Крупные и ежегодные" note="Копим заранее, платим из резерва" /><div className="plan-list">{budget.annualCommitments.filter((item) => item.active).map((item) => <CommitmentRow key={item.id} item={item} metrics={plan.commitments[item.id]} category={categoryById.get(item.categoryId)?.name} />)}</div></section>
    <section className="section-card"><SectionTitle title="Расходы по расписанию" note="Каждый месяц или только в выбранные месяцы" /><div className="plan-list">{budget.scheduledExpenses.filter((item) => item.active).map((item) => <ScheduleRow key={item.id} item={item} category={categoryById.get(item.categoryId)?.name} />)}</div></section>
    <section className="explain-card"><b>Как это считается</b><p>Крупный платёж показывается в месяце оплаты, но не вычитается второй раз: до срока приложение ежемесячно резервирует нужную сумму.</p></section>
  </>;
}

function CommitmentRow({ item, metrics, category }: { item: AnnualCommitment; metrics: AnnualPlan["commitments"][string] | undefined; category?: string }) {
  return <article className="plan-row"><span className="plan-icon">◎</span><div><strong>{item.name}</strong><small>{category} · {item.recurrence === "annual" ? "каждый год" : "один раз"} · {formatDate(item.dueDate)}</small><span className={`status-chip ${metrics?.status}`}>{statusLabels[metrics?.status ?? ""] ?? ""}</span></div><p><b>{formatMoney(item.amountMinor)}</b><span>{formatMoney(metrics?.monthlyReserveMinor ?? 0)}/мес</span></p></article>;
}

function ScheduleRow({ item, category }: { item: ScheduledExpense; category?: string }) {
  const schedule = item.mode === "monthly" ? "каждый месяц" : item.months?.map((month) => calendarMonths[month - 1]).join(", ");
  return <article className="plan-row"><span className="plan-icon">↻</span><div><strong>{item.name}</strong><small>{category} · {schedule} · до {item.dueDay}-го</small></div><p><b>{formatMoney(item.amountMinor)}</b><span>за месяц</span></p></article>;
}

function SectionTitle({ title, note }: { title: string; note: string }) {
  return <div className="section-title"><div><h2>{title}</h2><p>{note}</p></div></div>;
}

function CategoryList({ rows }: { rows: CategoryRow[] }) {
  return <ul className="category-list">{rows.map(({ category, metric }) => {
    if (!metric) return null;
    const percent = (metric.execution ?? 0) * 100;
    const progress = Math.min(Math.max(percent, 0), 100);
    return <li key={category.id}><div className="category-head"><strong>{category.name}</strong><span className={`status-chip ${metric.status}`}>{statusLabels[metric.status]}</span></div><progress className={`progress-track ${metric.status}`} max={100} value={progress} aria-label={`${category.name}: ${Math.round(progress)}% лимита`} /><div className="category-values"><span>Потрачено <b>{formatMoney(metric.actualMinor)}</b></span><span>Осталось <b>{formatMoney(metric.remainingMinor)}</b></span></div></li>;
  })}</ul>;
}

function TransactionList({ transactions, categoryById }: { transactions: Transaction[]; categoryById: Map<string, BudgetState["categories"][number]> }) {
  if (!transactions.length) return <p className="empty-state">Здесь появятся операции.</p>;
  return <ul className="transaction-list">{transactions.map((transaction) => { const categoryId = transactionCategoryId(transaction); return <li className={`transaction-row ${transaction.kind}`} key={transaction.id}><span className="transaction-icon">{transactionSign(transaction)}</span><span className="transaction-copy"><strong>{categoryId ? categoryById.get(categoryId)?.name : transactionLabels[transaction.kind]}</strong><small>{formatDate(transaction.occurredOn)} · {transactionLabels[transaction.kind]}</small></span><b>{transaction.kind === "income" || transaction.kind === "refund" ? "+" : transaction.kind === "expense" ? "−" : ""}{formatMoney(transaction.amountMinor)}</b></li>; })}</ul>;
}

function MoreScreen(props: {
  budget: BudgetState;
  storageHealth: StorageHealth | null;
  showIosInstall: boolean;
  lastSuccessfulBackup: string | null;
  onCreateBackup: () => Promise<{ readonly text: string; readonly createdAt: string }>;
  onRecordSuccessfulBackup: Parameters<typeof DataManagementScreen>[0]["onRecordSuccessfulBackup"];
  onRestoreBackup: Parameters<typeof DataManagementScreen>[0]["onRestoreBackup"];
  onPersistClear: () => Promise<void>;
  onPublishEmpty: () => void;
}) {
  return <>
    <div className="screen-heading"><div><span className="card-kicker">Приложение</span><h1>Данные и установка</h1><p>Бюджет работает локально и без регистрации.</p></div></div>
    {props.showIosInstall ? <div className="install-note"><strong>Установите на iPhone</strong><p>В Safari нажмите «Поделиться» → «На экран Домой». После первого запуска план доступен без сети.</p></div> : null}
    <div className="storage-context" role="status"><strong>Локальное хранилище</strong><span>{storageText(props.storageHealth)}</span></div>
    <DataManagementScreen
      budget={props.budget}
      lastSuccessfulBackup={props.lastSuccessfulBackup}
      onCreateBackup={props.onCreateBackup}
      onRecordSuccessfulBackup={props.onRecordSuccessfulBackup}
      onRestoreBackup={props.onRestoreBackup}
      onPersistClear={props.onPersistClear}
      onPublishEmpty={props.onPublishEmpty}
    />
    <section className="section-card"><SectionTitle title="Конфиденциальность MVP" note="Данные остаются в этом браузере" /><p className="body-copy">Нет регистрации, рекламы и аналитики. Облачную семейную синхронизацию добавим отдельным безопасным этапом.</p></section>
  </>;
}
