import { useEffect, useMemo, useRef, useState } from "react";
import {
  calculateAnnualPlan,
  calculateBudget,
  makePlanningSeed,
  type AnnualCommitment,
  type BudgetState,
  type Member,
  type ScheduledExpense,
  type Transaction,
} from "@family-budget/domain";
import {
  requestStorageHealth,
  type StorageHealth,
} from "@family-budget/storage";
import { BackButton } from "./components/BackButton";
import { Icon, IconSprite, type IconName } from "./components/Icon";
import { Money } from "./components/Money";
import { categoryVisual } from "./category-visual";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { DashboardScreen } from "./features/dashboard";
import { DataManagementScreen, downloadTextFile, prepareJsonDownload } from "./features/data-management";
import {
  FamilyScreen,
  MEMBER_FILTER_ALL,
  filterTransactionsByMember,
  memberFilterOptions,
  membersById,
  resolveSyncServerUrl,
  syncAlarm,
  syncIndicatorPresentation,
  transactionAuthorLabel,
  useFamily,
  type BudgetJournalWrite,
  type MemberFilter,
} from "./features/family";
import { OperationsScreen } from "./features/operations";
import { PlanningScreen } from "./features/planning";
import { Onboarding } from "./onboarding/Onboarding";
import { persistCompletedOnboarding } from "./onboarding/model";
import { createBudgetBackup, prepareBudgetState, restoreBudgetBackup } from "./backup";
import { formatMoney, moneyScale } from "./money";
import { createBudgetRepository } from "./storage-repository";

export type Screen = "today" | "year" | "planning" | "operations" | "more" | "family";
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

type BudgetSaveResult =
  | { readonly status: "saved"; readonly value: unknown; readonly revision: string }
  | {
      readonly status: "conflict";
      readonly current: { readonly value: unknown; readonly revision: string } | null;
    };

interface AppBudgetSaveOptions {
  readonly repository: {
    loadVersioned(): Promise<{ readonly value: BudgetState; readonly revision: string } | null>;
    saveIfRevision(expectedRevision: string | null, state: BudgetState): Promise<BudgetSaveResult>;
  };
  readonly getCurrent: () => BudgetState;
  readonly getRevision: () => string | null;
  readonly setRevision: (revision: string) => void;
  readonly publish: (state: BudgetState, revision: string) => void;
  /**
   * Запись через журнал семьи, когда она есть.
   *
   * Читается на каждом сохранении, а не один раз при сборке: семья создаётся и покидается посреди
   * сессии, и координатор, запомнивший ответ, писал бы мимо журнала до перезагрузки. `null` —
   * «журнала нет», и тогда путь ниже ровно тот, каким он был до синхронизации: те же чтения, та же
   * проверка ревизии, то же сообщение о конфликте.
   */
  readonly journalWrite?: () => BudgetJournalWrite | null;
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

          const previous = options.getCurrent();
          const candidate = prepareBudgetState(change(previous));
          const journal = options.journalWrite?.() ?? null;
          const saved =
            (journal === null
              ? null
              : await journal({ expectedRevision, previous, next: candidate })) ??
            (await options.repository.saveIfRevision(expectedRevision, candidate));
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
  if (transaction.kind === "expense" || transaction.kind === "refund") return transaction.categoryId;
  // Доход тоже бывает с категорией, и тогда строка называет её: «Зарплата», а не «Доход».
  return transaction.kind === "income" ? transaction.categoryId ?? null : null;
}

// §6: вид операции показывает глиф из спрайта, а не знак «+/−» текстом. Смысл дублирован
// подписью строки и суммой со знаком, поэтому сама иконка декоративная.
const transactionIcons: Record<Transaction["kind"], IconName> = {
  income: "arrow-down-left",
  expense: "arrow-up-right",
  refund: "rotate-ccw",
  transfer: "arrow-left-right",
  goal_contribution: "target",
};

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
  // Section 9: the address is configuration and is absent by default, so the whole family layer
  // below is inert in a build that was not given one — no request, no queue, no schema bump.
  const syncServerUrl = useMemo(
    () => resolveSyncServerUrl(import.meta.env as unknown as Readonly<Record<string, unknown>>),
    [],
  );
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
  const [memberFilter, setMemberFilter] = useState<MemberFilter>(MEMBER_FILTER_ALL);
  const previousScreenRef = useRef<Screen>(screen);
  const hasUnsavedDraft = operationDraftDirty || planningDraftDirty;
  budgetRef.current = budget;
  // Экран семьи собирается ниже, а координатор записи — выше него: путь записи через журнал
  // кладётся сюда и читается на каждом сохранении, поэтому семья, созданная посреди сессии,
  // начинает вести журнал сразу, без перезагрузки.
  const journalWriteRef = useRef<BudgetJournalWrite | null>(null);

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
    journalWrite: () => journalWriteRef.current,
  }), [repository]);

  const family = useFamily(repository, syncServerUrl, {
    // 2.2 keeps names off the server, so the participant is written into the local budget instead.
    // It is an ordinary budget change and goes through the same compare-and-set as every other.
    registerLocalMember: async (member) => {
      if (!budgetRef.current) return;
      await budgetSave.apply((state) => ({
        ...state,
        members: [...(state.members ?? []).filter((item) => item.id !== member.id), member],
      }));
    },
    // Чужие операции уже записаны в документ одной транзакцией с курсором; здесь они попадают на
    // экран. Пока идёт собственная запись, показ откладывается: её сравнение ревизии — источник
    // истины, и подменять состояние у неё под руками нельзя.
    publishRemoteBudget: (value, revision) => {
      // Обновляется тот бюджет, который экран показывает. Показывать нечего — значит и обновлять
      // нечего: приложение без бюджета стоит на онбординге, и подменять его состоянием из журнала
      // означало бы онбординг поверх готового бюджета.
      if (budgetRef.current === null || budgetSave.locked) return;
      try {
        const next = prepareBudgetState(value);
        budgetRef.current = next;
        revisionRef.current = revision;
        setBudget(next);
      } catch {
        // Пришедшее состояние не собирается в показуемый бюджет — экран остаётся на прежнем.
      }
    },
  });
  journalWriteRef.current = family.writeBudget;

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
  const memberById = useMemo(() => (budget ? membersById(budget) : new Map()), [budget]);

  const recordBackup = async (createdAt: string) => {
    await repository.setLastSuccessfulBackup(createdAt);
    setLastSuccessfulBackup(createdAt);
  };

  // Экран семьи предлагает копию там же, где предупреждает о смене бюджета, поэтому путь один и
  // тот же — включая отметку о дате: копия, сделанная перед вступлением, обязана считаться
  // последней и на экране «Данные».
  const createBackup = async () => {
    const source = budgetRef.current;
    if (source === null) throw new Error("Budget is not ready.");
    const backup = await createBudgetBackup(source, async () => undefined);
    await downloadTextFile(prepareJsonDownload(backup.text));
    await recordBackup(backup.createdAt);
  };

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

  if (loadState === "loading") return <><SkipLink /><main id={MAIN_CONTENT_ID} tabIndex={-1} className="loading-state" aria-busy="true"><p>Открываем семейный план…</p></main><UpdatePrompt /></>;
  if (loadState === "error") return <><SkipLink /><main id={MAIN_CONTENT_ID} tabIndex={-1} className="loading-state storage-error-state"><section role="alert"><h1>Не удалось открыть локальные данные</h1><p>Мы не подставили демо и не создали новый бюджет. Проверьте, разрешено ли хранение данных для этого сайта.</p><button className="primary-button" type="button" onClick={() => setLoadAttempt((value) => value + 1)}>Повторить</button></section></main><UpdatePrompt /></>;
  if (loadState === "empty") return <div className="onboarding-route"><IconSprite /><SkipLink /><div id={MAIN_CONTENT_ID} tabIndex={-1}><Onboarding onComplete={completeOnboarding} onDemo={loadDemo} /></div><UpdatePrompt /></div>;
  if (!budget || !metrics || !plan) return <><SkipLink /><main id={MAIN_CONTENT_ID} tabIndex={-1} className="loading-state" role="alert"><p>Бюджет не удалось подготовить к показу.</p></main><UpdatePrompt /></>;

  const activeBudget = budget.budgets.find((item) => item.id === budget.activeBudgetId)!;
  const flexibleIds = new Set(activeBudget.lines.filter((line) => line.active !== false).map((line) => line.categoryId));
  const activeExpenseCategories = budget.categories.filter((category) => category.active && category.type === "expense");
  const flexibleRows = activeExpenseCategories
    .filter((category) => category.active && flexibleIds.has(category.id))
    .map((category) => ({ category, metric: metrics.categoryMetrics[category.id] }))
    .filter((row) => row.metric);
  const flexibleSpentMinor = flexibleRows.reduce((total, row) => total + (row.metric?.actualMinor ?? 0), 0);
  const safeToSpendMinor = plan.currentMonth.flexiblePlanMinor - flexibleSpentMinor;
  const postedTransactions = [...budget.transactions]
    .filter((transaction) => transaction.status === "posted")
    .sort((left, right) => right.occurredOn.localeCompare(left.occurredOn));
  const recentTransactions = filterTransactionsByMember(postedTransactions, memberFilter).slice(0, 5);
  const memberOptions = memberFilterOptions(budget);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const networkStatus = networkStatusPresentation(nativeRuntime, online);
  const syncIndicator = syncIndicatorPresentation(family.status, family.syncRound);
  // 3.4 and 5.4.1: the one loud signal of this system. It is not a toast, it has no close button
  // and no timer, and it follows the person onto whichever screen they are on — the family screen
  // renders its own copy, so this one steps aside there.
  const keyAlarm = syncAlarm(family.status?.stop ?? null);
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
      <IconSprite />
      <SkipLink />
      <header className="app-header">
        <div className="brand"><span className="brand-mark"><Icon name="piggy-bank" size={24} /></span><div><strong>Наш бюджет</strong><small>видим месяц и будущее</small></div></div>
        <div className="header-badges">
          <span className={networkStatus.className} role="status" aria-label={networkStatus.ariaLabel}>{networkStatus.text}</span>
          {/* Без входа шапка остаётся ровно такой, какой была: «локально» живёт на экране «Семья»
              и на карточке перехода в «Ещё», а второй пилюли в шапке у локального пользователя
              не появляется вовсе. */}
          {syncIndicator.state === "local" ? null : <span className={syncIndicator.className} role="status" aria-label={syncIndicator.ariaLabel}>{syncIndicator.text}</span>}
        </div>
      </header>

      <nav className="bottom-nav" aria-label="Основные разделы">
        <NavButton active={screen === "today"} icon="today" label="Сегодня" onClick={() => navigate("today")} />
        <NavButton active={screen === "year" || screen === "planning"} icon="year" label="Год" onClick={() => navigate("year")} />
        <NavButton active={screen === "operations"} icon="operations" label="Записать" onClick={() => navigate("operations")} />
        <NavButton active={screen === "more" || screen === "family"} icon="more" label="Ещё" onClick={() => navigate("more")} />
      </nav>

      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="content" data-layout-contract="no-action-overflow">
        <div className="route-screen" data-screen={screen}>
          {keyAlarm && screen !== "family" ? (
            <section className="key-alarm" role="alert" aria-labelledby="app-key-alarm-title">
              <span className="key-alarm-mark"><Icon name="triangle-alert" size={24} /></span>
              <div>
                <h2 id="app-key-alarm-title">{keyAlarm.title}</h2>
                <p>{keyAlarm.body}</p>
                <button className="primary-button" type="button" onClick={() => navigate("family")}>{keyAlarm.actionLabel}</button>
              </div>
            </section>
          ) : null}
          {screen === "today" ? <TodayScreen budget={budget} plan={plan} flexibleRows={flexibleRows} safeToSpendMinor={safeToSpendMinor} recentTransactions={recentTransactions} categoryById={categoryById} memberById={memberById} memberOptions={memberOptions} memberFilter={memberFilter} onMemberFilterChange={setMemberFilter} onAdd={() => navigate("operations")} onYear={() => navigate("year")} /> : null}
          {screen === "year" ? <YearScreen budget={budget} plan={plan} onPlanning={() => navigate("planning")} categoryById={categoryById} /> : null}
          {screen === "planning" ? <><div className="planning-toolbar"><BackButton label="К горизонту" onClick={() => navigate("year")} /></div><PlanningScreen budget={budget} onChange={(change) => budgetSave.apply(change)} onDirtyChange={setPlanningDraftDirty} /></> : null}
          {screen === "operations" ? <OperationsScreen budget={budget} onChange={(change) => budgetSave.apply(change)} onDirtyChange={setOperationDraftDirty} /> : null}
          {screen === "more" ? <MoreScreen
            budget={budget}
            storageHealth={storageHealth}
            showIosInstall={isIos && !isStandalone}
            lastSuccessfulBackup={lastSuccessfulBackup}
            onCreateBackup={async () => createBudgetBackup(
              budgetRef.current ?? budget,
              async () => undefined,
            )}
            onRecordSuccessfulBackup={recordBackup}
            onRestoreBackup={async (file) => {
              let clearedLabels = 0;
              await restoreBudgetBackup(
                file,
                (restored) => budgetSave.apply(() => restored).then(() => undefined),
                () => undefined,
                () => { clearedLabels += 1; },
              );
              if (clearedLabels > 0) {
                setMessage(`Снято меток участника: ${clearedLabels}. Такого участника в копии нет; сами операции и все суммы восстановлены без изменений.`);
              }
            }}
            onPersistClear={() => repository.clear()}
            onPublishEmpty={() => {
              budgetRef.current = null;
              revisionRef.current = null;
              setBudget(null);
              setLastSuccessfulBackup(null);
              setLoadState("empty");
            }}
            onFamily={() => navigate("family")}
            syncIndicator={syncIndicator}
          /> : null}
          {screen === "family" ? <FamilyScreen
            serverUrl={family.serverUrl}
            session={family.session}
            membership={family.membership}
            members={family.members}
            devices={family.devices}
            ownFingerprint={family.ownFingerprint}
            pinOf={family.pinOf}
            offeredFingerprintOf={family.offeredFingerprintOf}
            memberNameOf={(memberId) => memberById.get(memberId)?.name ?? null}
            localBudget={budget}
            lastBackupAt={lastSuccessfulBackup}
            onCreateBackup={createBackup}
            invite={family.invite}
            status={family.status}
            syncRound={family.syncRound}
            integrity={family.integrity}
            now={Date.now()}
            busy={family.busy}
            message={family.message}
            error={family.error}
            awaitingLoginCode={family.awaitingLoginCode}
            actions={family.actions}
            onBack={() => navigate("more")}
          /> : null}
        </div>
      </main>

      {message ? <aside className="message-toast" role="status"><p>{message}</p><button className="primary-button" type="button" onClick={() => setMessage(null)}>Закрыть</button></aside> : null}
      <UpdatePrompt hasUnsavedChanges={operationDraftDirty || planningDraftDirty} />
    </div>
  );
}

// Нижняя навигация берёт глифы из того же спрайта, что и остальной интерфейс: один набор,
// одна толщина штриха, одна канва. Подпись под иконкой несёт смысл, иконка — декоративная.
const navIcons = {
  today: "house",
  year: "calendar",
  operations: "circle-plus",
  more: "ellipsis",
} as const satisfies Record<string, IconName>;

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: keyof typeof navIcons; label: string; onClick: () => void }) {
  return <button className={`nav-button${active ? " active" : ""}`} type="button" onClick={onClick} aria-current={active ? "page" : undefined}><span className="nav-icon"><Icon name={navIcons[icon]} size={24} /></span><span>{label}</span></button>;
}

type AnnualPlan = ReturnType<typeof calculateAnnualPlan>;
type BudgetMetrics = ReturnType<typeof calculateBudget>;
type CategoryRow = { category: BudgetState["categories"][number]; metric: BudgetMetrics["categoryMetrics"][string] | undefined };

function TodayScreen({ budget, plan, flexibleRows, safeToSpendMinor, recentTransactions, categoryById, memberById, memberOptions, memberFilter, onMemberFilterChange, onAdd, onYear }: { budget: BudgetState; plan: AnnualPlan; flexibleRows: CategoryRow[]; safeToSpendMinor: number; recentTransactions: Transaction[]; categoryById: Map<string, BudgetState["categories"][number]>; memberById: ReadonlyMap<string, Member>; memberOptions: readonly { readonly value: MemberFilter; readonly label: string }[]; memberFilter: MemberFilter; onMemberFilterChange: (value: MemberFilter) => void; onAdd: () => void; onYear: () => void }) {
  const overLimit = flexibleRows.filter((row) => row.metric?.status === "over_limit");
  const nextId = plan.upcomingCommitmentIds[0];
  const next = budget.annualCommitments.find((item) => item.id === nextId);
  const nextMetrics = next ? plan.commitments[next.id] : undefined;
  const safeToSpend = formatMoney(safeToSpendMinor);
  return <>
    <h1 className="visually-hidden">Сегодня: семейный бюджет</h1>
    <div className="eyebrow">{formatMonth(plan.startMonth)}</div>
    <section className={`hero-card${safeToSpendMinor < 0 ? " danger" : ""}`}>
      <span>Можно на повседневные расходы</span>
      <strong data-money-scale={moneyScale(safeToSpend)}><Money value={safeToSpendMinor} /></strong>
      <p>Остаток лимитов после уже записанных покупок. Обязательные платежи и накопления учтены отдельно.</p>
      <button className="hero-button" type="button" onClick={onAdd}><Icon name="plus" size={20} />Записать покупку</button>
    </section>

    {overLimit.length ? <div className="limit-alert danger" role="alert"><b>Перелимит</b><span>{overLimit.map((row, index) => <span key={row.category.id}>{index > 0 ? " · " : ""}{row.category.name}: <Money value={row.metric?.overMinor ?? 0} sign="+" /></span>)}</span></div> : null}

    <div className="quick-grid">
      <QuickCard icon="repeat" label="Платежи месяца" value={plan.currentMonth.scheduledExpenseMinor} />
      <QuickCard icon="calendar-clock" label="Отложить к срокам" value={plan.currentMonth.annualReserveMinor} />
      <QuickCard icon="wallet" label="Не распределено" value={plan.currentMonth.spendableAfterPlanMinor} />
    </div>

    {next ? <section className="next-card">
      <div><span className="card-kicker">Ближайший крупный платёж</span><h2>{next.name}</h2><p>{formatDate(next.dueDate)} · <Money value={next.amountMinor} /></p></div>
      <div className="reserve-pill"><span>Откладывать</span><b><Money value={nextMetrics?.monthlyReserveMinor ?? 0} />/мес</b></div>
    </section> : null}

    <section className="section-card">
      <SectionTitle title="Повседневные лимиты" note="Мелкие покупки этого месяца" />
      <CategoryList rows={flexibleRows} />
    </section>

    <button className="year-preview" type="button" onClick={onYear}><span className="row-mark"><Icon name="calendar" size={24} /></span><span className="row-copy"><b>Посмотреть 12–24 месяца</b><small>Сезонные расходы, обучение, лагерь, страховка и дом</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></button>

    <section className="section-card">
      <SectionTitle title="Последние записи" note="Фактические операции" />
      {memberOptions.length > 2 ? <div className="field member-filter">
        <label htmlFor="history-member-filter">Кто записал</label>
        <select id="history-member-filter" value={memberFilter} onChange={(event) => onMemberFilterChange(event.target.value as MemberFilter)}>
          {memberOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div> : null}
      <TransactionList transactions={recentTransactions} categoryById={categoryById} memberById={memberById} showAuthor={memberOptions.length > 2} />
    </section>
  </>;
}

function QuickCard({ icon, label, value }: { icon: IconName; label: string; value: number }) {
  return <article className="quick-card"><span className="quick-icon"><Icon name={icon} size={20} /></span><span className="quick-label">{label}</span><strong><Money value={value} /></strong></article>;
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
  return <article className="plan-row"><span className="plan-icon"><Icon name="calendar-clock" size={24} /></span><div><strong>{item.name}</strong><small>{category} · {item.recurrence === "annual" ? "каждый год" : "один раз"} · {formatDate(item.dueDate)}</small><span className={`status-chip ${metrics?.status}`}>{statusLabels[metrics?.status ?? ""] ?? ""}</span></div><p><b><Money value={item.amountMinor} /></b><span><Money value={metrics?.monthlyReserveMinor ?? 0} />/мес</span></p></article>;
}

function ScheduleRow({ item, category }: { item: ScheduledExpense; category?: string }) {
  const schedule = item.mode === "monthly" ? "каждый месяц" : item.months?.map((month) => calendarMonths[month - 1]).join(", ");
  return <article className="plan-row"><span className="plan-icon"><Icon name="repeat" size={24} /></span><div><strong>{item.name}</strong><small>{category} · {schedule} · до {item.dueDay}-го</small></div><p><b><Money value={item.amountMinor} /></b><span>за месяц</span></p></article>;
}

function SectionTitle({ title, note, icon }: { title: string; note: string; icon?: IconName }) {
  return <div className="section-title"><div><h2>{icon ? <Icon name={icon} size={20} /> : null}{title}</h2><p>{note}</p></div></div>;
}

function CategoryList({ rows }: { rows: CategoryRow[] }) {
  return <ul className="category-list">{rows.map(({ category, metric }) => {
    if (!metric) return null;
    const percent = (metric.execution ?? 0) * 100;
    const progress = Math.min(Math.max(percent, 0), 100);
    const visual = categoryVisual(category);
    return <li key={category.id}>
      <span className={`category-tile tone-${visual.tone}`}><Icon name={visual.icon} size={24} /></span>
      <div className="category-body">
        <div className="category-head"><strong>{category.name}</strong><span className={`status-chip ${metric.status}`}>{statusLabels[metric.status]}</span></div>
        <progress className={`progress-track ${metric.status}`} max={100} value={progress} aria-label={`${category.name}: ${Math.round(progress)}% лимита`} />
        <div className="category-values"><span>Потрачено <b><Money value={metric.actualMinor} /></b></span><span>Осталось <b><Money value={metric.remainingMinor} /></b></span></div>
      </div>
    </li>;
  })}</ul>;
}

function TransactionList({ transactions, categoryById, memberById, showAuthor }: { transactions: Transaction[]; categoryById: Map<string, BudgetState["categories"][number]>; memberById: ReadonlyMap<string, Member>; showAuthor: boolean }) {
  if (!transactions.length) return <p className="empty-state"><span className="empty-state-mark"><Icon name="inbox" size={32} /></span>Здесь появятся операции.</p>;
  return <ul className="transaction-list">{transactions.map((transaction) => {
    const categoryId = transactionCategoryId(transaction);
    const category = categoryId === null ? undefined : categoryById.get(categoryId);
    const visual = category ? categoryVisual(category) : null;
    return <li className={`transaction-row ${transaction.kind}`} key={transaction.id}>
      <span className={`transaction-icon ${visual ? `tone-${visual.tone}` : "tone-neutral"}`}><Icon name={visual ? visual.icon : transactionIcons[transaction.kind]} size={24} /></span>
      <span className="transaction-copy">
        <strong>{category ? category.name : transactionLabels[transaction.kind]}</strong>
        <small>{formatDate(transaction.occurredOn)} · {transactionLabels[transaction.kind]}{showAuthor ? ` · ${transactionAuthorLabel(memberById, transaction.memberId)}` : ""}</small>
      </span>
      <b><Money value={transaction.amountMinor} sign={transactionSign(transaction.kind)} /></b>
    </li>;
  })}</ul>;
}

/** Направление операции в строке. Сумма хранится положительной, знак принадлежит строке. */
function transactionSign(kind: Transaction["kind"]): "+" | "−" | undefined {
  if (kind === "income" || kind === "refund") return "+";
  return kind === "expense" ? "−" : undefined;
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
  onFamily: () => void;
  syncIndicator: { readonly text: string; readonly className: string; readonly ariaLabel: string };
}) {
  return <>
    <div className="screen-heading"><div><span className="card-kicker">Приложение</span><h1>Данные и установка</h1><p>Бюджет работает локально и без регистрации.</p></div></div>
    {props.showIosInstall ? <div className="install-note"><strong><Icon name="smartphone" size={20} />Установите на iPhone</strong><p>В Safari нажмите «Поделиться» → «На экран Домой». После первого запуска план доступен без сети.</p></div> : null}
    <div className="storage-context" role="status"><strong><Icon name="hard-drive" size={20} />Локальное хранилище</strong><span>{storageText(props.storageHealth)}</span></div>
    <DataManagementScreen
      budget={props.budget}
      lastSuccessfulBackup={props.lastSuccessfulBackup}
      onCreateBackup={props.onCreateBackup}
      onRecordSuccessfulBackup={props.onRecordSuccessfulBackup}
      onRestoreBackup={props.onRestoreBackup}
      onPersistClear={props.onPersistClear}
      onPublishEmpty={props.onPublishEmpty}
    />
    <button className="year-preview" type="button" onClick={props.onFamily}><span className="row-mark"><Icon name="users" size={24} /></span><span className="row-copy"><b>Семья и синхронизация</b><small>Участники, приглашение, отпечатки ключей. Без входа приложение работает как сейчас.</small><span className={props.syncIndicator.className} aria-label={props.syncIndicator.ariaLabel}>{props.syncIndicator.text}</span></span><Icon name="chevron-right" size={24} className="row-chevron" /></button>
    <section className="section-card"><SectionTitle title="Конфиденциальность" note="Данные остаются в этом браузере, пока вы не вошли" icon="shield" /><p className="body-copy">Нет рекламы и аналитики. Семейная синхронизация необязательна: пока вы не вошли, приложение не обращается к сети и ничего не отправляет.</p></section>
  </>;
}
