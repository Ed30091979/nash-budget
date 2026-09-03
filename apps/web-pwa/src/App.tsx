import { useEffect, useMemo, useRef, useState } from "react";
import {
  calculateAnnualPlan,
  calculateBudget,
  type BudgetState,
  type Member,
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
import { DashboardScreen, nextScheduledDate } from "./features/dashboard";
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
import { buildDemoBudgetState } from "./onboarding/demo";
import { createBudgetBackup, prepareBudgetState, restoreBudgetBackup } from "./backup";
import { formatMoney, moneyScale } from "./money";
import { limitBar, localToday, percentStep, periodProgress } from "./limit-pace";
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
/**
 * Порог индикатора загрузки, §6 исследования, пункт 30 (NN/g): меньше секунды — индикатор не нужен
 * вообще. Офлайн-первое приложение читает бюджет из локального хранилища и почти всегда
 * укладывается в первый кадр; плашка «открываем» в этом случае успевала только мигнуть.
 */
export const SLOW_LOAD_THRESHOLD_MS = 1000;

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
  const [slowLoad, setSlowLoad] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [headerScrolled, setHeaderScrolled] = useState(false);
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

  // §6 исследования, пункт 30: порог индикатора — секунда. Локальное чтение в неё укладывается,
  // и слово «открываем» появляется только тогда, когда чтение в неё не уложилось.
  useEffect(() => {
    if (loadState !== "loading") {
      setSlowLoad(false);
      return;
    }
    const timeout = window.setTimeout(() => setSlowLoad(true), SLOW_LOAD_THRESHOLD_MS);
    return () => window.clearTimeout(timeout);
  }, [loadState, loadAttempt]);

  // §3 исследования, упрощённый scroll edge: шапка прозрачна в нуле прокрутки и получает фон с
  // границей, как только под неё что-то поехало. Состояние переключается один раз на переходе
  // через ноль, а не на каждом пикселе: пересчитывать разметку на каждый кадр прокрутки незачем.
  useEffect(() => {
    const update = () => setHeaderScrolled(window.scrollY > 0);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

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
    const result = await persistCompletedOnboarding(repository, buildDemoBudgetState(), prepareBudgetState, publishInitialBudget);
    if (result.status === "existing") {
      setMessage("Бюджет уже создан в другой вкладке. Демо не перезаписало сохранённую там версию.");
    }
  };

  // §6 исследования, пункт 30: до секунды индикатор не нужен вообще, а пульсирующие скелетоны
  // «отвлекают, раздражают и создают проблемы доступности». Приложение офлайн-первое, и чтение
  // локального хранилища укладывается в первый кадр: пока порог не перейдён, экран молчит, но
  // `aria-busy` уже говорит читающему с экрана, что здесь ещё не готово. Слово появляется только
  // тогда, когда ждать действительно пришлось, — и тогда оно уже не мельтешение, а объяснение.
  if (loadState === "loading") return <><SkipLink /><main id={MAIN_CONTENT_ID} tabIndex={-1} className="loading-state" aria-busy="true">{slowLoad ? <p>Открываем семейный план…</p> : null}</main><UpdatePrompt /></>;
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
  // §4 исследования: маркер темпа месяца. Доля периода общая для всех строк лимитов — период
  // задан самим бюджетом, а «сегодня» берётся по календарю семьи, а не по UTC.
  const monthPace = periodProgress(activeBudget.startDate, activeBudget.endDate, localToday(new Date()));
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
      <header className="app-header" data-scrolled={headerScrolled ? "true" : undefined}>
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
          {screen === "today" ? <TodayScreen budget={budget} plan={plan} flexibleRows={flexibleRows} safeToSpendMinor={safeToSpendMinor} monthPace={monthPace} recentTransactions={recentTransactions} categoryById={categoryById} memberById={memberById} memberOptions={memberOptions} memberFilter={memberFilter} onMemberFilterChange={setMemberFilter} hasRecords={postedTransactions.length > 0} onAdd={() => navigate("operations")} onYear={() => navigate("year")} onPlanning={() => navigate("planning")} /> : null}
          {screen === "year" ? <YearScreen budget={budget} plan={plan} onPlanning={() => navigate("planning")} categoryById={categoryById} /> : null}
          {screen === "planning" ? <><div className="planning-toolbar"><BackButton label="К горизонту" onClick={() => navigate("year")} /></div><PlanningScreen budget={budget} onChange={(change) => budgetSave.apply(change)} onDirtyChange={setPlanningDraftDirty} /></> : null}
          {screen === "operations" ? <OperationsScreen budget={budget} onChange={(change) => budgetSave.apply(change)} onDirtyChange={setOperationDraftDirty} onPlanning={() => navigate("planning")} /> : null}
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
            bindVerdictOf={family.bindVerdictOf}
            offeredFingerprintOf={family.offeredFingerprintOf}
            memberNameOf={(memberId) => memberById.get(memberId)?.name ?? null}
            localBudget={budget}
            lastBackupAt={lastSuccessfulBackup}
            onCreateBackup={createBackup}
            invite={family.invite}
            status={family.status}
            syncRound={family.syncRound}
            integrity={family.integrity}
            rotation={family.rotation}
            epochAlarm={family.epochAlarm}
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

function TodayScreen({ budget, plan, flexibleRows, safeToSpendMinor, monthPace, recentTransactions, categoryById, memberById, memberOptions, memberFilter, onMemberFilterChange, hasRecords, onAdd, onYear, onPlanning }: { budget: BudgetState; plan: AnnualPlan; flexibleRows: CategoryRow[]; safeToSpendMinor: number; monthPace: number; recentTransactions: Transaction[]; categoryById: Map<string, BudgetState["categories"][number]>; memberById: ReadonlyMap<string, Member>; memberOptions: readonly { readonly value: MemberFilter; readonly label: string }[]; memberFilter: MemberFilter; onMemberFilterChange: (value: MemberFilter) => void; hasRecords: boolean; onAdd: () => void; onYear: () => void; onPlanning: () => void }) {
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
      <p>Платежи и накопления учтены отдельно.</p>
      <button className="hero-button" type="button" onClick={onAdd}><Icon name="plus" size={20} />Записать покупку</button>
    </section>

    {overLimit.length ? <div className="limit-alert danger" role="alert"><b>Перелимит</b><span>{overLimit.map((row, index) => <span key={row.category.id}>{index > 0 ? " · " : ""}{row.category.name}: <Money value={row.metric?.overMinor ?? 0} sign="+" /></span>)}</span></div> : null}

    <dl className="month-split">
      <SplitRow icon="repeat" label="Платежи месяца" value={plan.currentMonth.scheduledExpenseMinor} />
      <SplitRow icon="calendar-clock" label="Отложить к срокам" value={plan.currentMonth.annualReserveMinor} />
      <SplitRow icon="wallet" label="Не распределено" value={plan.currentMonth.spendableAfterPlanMinor} />
    </dl>

    {next ? <section className="next-card">
      <div><span className="card-kicker">Ближайший крупный платёж</span><h2>{next.name}</h2><p>{formatDate(next.dueDate)} · <Money value={next.amountMinor} /></p></div>
      <div className="reserve-pill"><span>Откладывать</span><b><Money value={nextMetrics?.monthlyReserveMinor ?? 0} />/мес</b></div>
    </section> : null}

    <section className="section-card">
      <SectionTitle title="Повседневные лимиты" note="Мелкие покупки этого месяца" />
      <CategoryList rows={flexibleRows} pace={monthPace} onPlanning={onPlanning} />
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
      <TransactionList transactions={recentTransactions} categoryById={categoryById} memberById={memberById} showAuthor={memberOptions.length > 2} onAdd={onAdd} hiddenByMemberFilter={hasRecords && memberFilter !== MEMBER_FILTER_ALL} onShowEveryone={() => onMemberFilterChange(MEMBER_FILTER_ALL)} />
    </section>
  </>;
}

/**
 * Строка разбора месяца: подпись слева, сумма справа столбцом (§7.4).
 *
 * Числа здесь поддерживают герой-число, а не спорят с ним: тот же кегль, что у обычного текста,
 * начертание 600 против 700 у героя и приглушённая подпись (§1 и §2 исследования).
 */
function SplitRow({ icon, label, value }: { icon: IconName; label: string; value: number }) {
  return <div><dt><Icon name={icon} size={20} />{label}</dt><dd><Money value={value} /></dd></div>;
}

/**
 * «Год»: горизонт и платежи, которые его создают.
 *
 * Списков платежей здесь было три: «Ближайшие активные платежи» на самом горизонте, «Крупные и
 * ежегодные» и «Расходы по расписанию» под ним. Первый строился из двух последних, то есть каждый
 * платёж экран называл дважды. Остался один список, упорядоченный по дате ближайшего платежа: у
 * крупного это его срок, у регулярного — ближайшее вхождение в календарь.
 */
function YearScreen({ budget, plan, onPlanning, categoryById }: { budget: BudgetState; plan: AnnualPlan; onPlanning: () => void; categoryById: Map<string, BudgetState["categories"][number]> }) {
  const payments = planPaymentRows(budget, plan, categoryById);
  return <>
    <DashboardScreen budget={budget} onPlanning={onPlanning} />

    <section className="section-card">
      <SectionTitle title="Платежи и крупные траты" note="Регулярные платим каждый месяц, крупные копим заранее" />
      {payments.length ? <div className="plan-list">{payments.map((row) => <PlanRow key={row.key} row={row} />)}</div> : <div className="empty-state">
        <span className="empty-state-mark"><Icon name="calendar-clock" size={32} /></span>
        <h3>Платежей в плане нет</h3>
        <p>Сюда попадает всё, что платят по расписанию или копят заранее: аренда, страховка, обучение, шины, отпуск. Горизонт держится на них — без них он равен доходу.</p>
        <button className="primary-button" type="button" onClick={onPlanning}>Добавить платёж в план</button>
      </div>}
    </section>

    {/* Правило резерва объясняется один раз и по требованию: это справка, а не содержимое экрана. */}
    <details className="section-card collapsible-card">
      <summary><span>Как это считается</span><Icon name="chevron-right" size={24} className="row-chevron" /></summary>
      <p className="body-copy">Крупный платёж показывается в месяце оплаты, но не вычитается второй раз: до срока приложение ежемесячно резервирует нужную сумму.</p>
    </details>
  </>;
}

interface PlanPaymentRow {
  readonly key: string;
  readonly icon: IconName;
  readonly name: string;
  /** «Продукты · каждый год · 15 янв» — одна строка вместо трёх подписей. */
  readonly note: string;
  readonly amountMinor: number;
  /** Сколько откладывать в месяц; `null` — регулярный платёж, его не копят. */
  readonly reserveMinor: number | null;
  readonly status: string | null;
  /** Дата ближайшего платежа: по ней список и упорядочен. */
  readonly dueDate: string;
}

function planPaymentRows(
  budget: BudgetState,
  plan: AnnualPlan,
  categoryById: Map<string, BudgetState["categories"][number]>,
): readonly PlanPaymentRow[] {
  const commitments: PlanPaymentRow[] = budget.annualCommitments
    .filter((item) => item.active)
    .map((item) => ({
      key: `commitment-${item.id}`,
      icon: "calendar-clock",
      name: item.name,
      note: [categoryById.get(item.categoryId)?.name, item.recurrence === "annual" ? "каждый год" : "один раз", formatDate(item.dueDate)]
        .filter((part) => part).join(" · "),
      amountMinor: item.amountMinor,
      reserveMinor: plan.commitments[item.id]?.monthlyReserveMinor ?? 0,
      status: plan.commitments[item.id]?.status ?? null,
      dueDate: item.dueDate,
    }));

  const schedules: PlanPaymentRow[] = budget.scheduledExpenses
    .filter((item) => item.active)
    .map((item) => {
      const dueDate = nextScheduledDate(item, plan.startMonth);
      return {
        key: `schedule-${item.id}`,
        icon: "repeat" as IconName,
        name: item.name,
        note: [categoryById.get(item.categoryId)?.name, scheduleWords(item), `до ${item.dueDay}-го`]
          .filter((part) => part).join(" · "),
        amountMinor: item.amountMinor,
        reserveMinor: null,
        status: null,
        // Расписание без ближайшего вхождения календарь уже прошёл: такая строка идёт в конец.
        dueDate: dueDate ?? "9999-12-31",
      };
    });

  return [...commitments, ...schedules].sort(
    (left, right) => left.dueDate.localeCompare(right.dueDate) || left.name.localeCompare(right.name, "ru-RU"),
  );
}

/**
 * Когда платят регулярный расход — одной строкой.
 *
 * Девять трёхбуквенных сокращений подряд («янв, фев, мар, апр, май, сен, окт, ноя, дек») занимали
 * две строки и всё равно читались как шум: сколько месяцев в году платят — вот что человек хочет
 * знать в списке. Полный набор месяцев остаётся там, где его выбирают, — в плане.
 */
function scheduleWords(item: BudgetState["scheduledExpenses"][number]): string {
  if (item.mode === "monthly") return "каждый месяц";
  const months = item.months ?? [];
  if (months.length === 0) return "месяцы не выбраны";
  if (months.length > 4) return `${months.length} месяцев в году`;
  return months.map((month) => calendarMonths[month - 1]).join(", ");
}

function PlanRow({ row }: { row: PlanPaymentRow }) {
  return <article className="plan-row">
    <span className="plan-icon"><Icon name={row.icon} size={24} /></span>
    <div>
      <strong>{row.name}</strong>
      <small>{row.note}</small>
      {row.status ? <span className={`status-chip ${row.status}`}>{statusLabels[row.status] ?? ""}</span> : null}
    </div>
    <p>
      <b><Money value={row.amountMinor} /></b>
      {row.reserveMinor === null ? null : <span><Money value={row.reserveMinor} />/мес в резерв</span>}
    </p>
  </article>;
}

function SectionTitle({ title, note, icon }: { title: string; note: string; icon?: IconName }) {
  return <div className="section-title"><div><h2>{icon ? <Icon name={icon} size={20} /> : null}{title}</h2><p>{note}</p></div></div>;
}

/**
 * Список лимитов месяца.
 *
 * Полоса каждой строки несёт две величины сразу: сколько лимита потрачено и сколько месяца
 * прошло (§4 исследования). Темп у всех строк один — он объявлен на самом списке, и переменная
 * достаётся полосам по наследству.
 */
function CategoryList({ rows, pace, onPlanning }: { rows: CategoryRow[]; pace: number; onPlanning: () => void }) {
  // Пустой список — не пустая разметка: §6 исследования требует назвать состояние, объяснить его
  // и дать дорогу дальше. Раньше здесь оставалась пустая карточка без единого слова.
  if (!rows.length) return <div className="empty-state">
    <span className="empty-state-mark"><Icon name="target" size={32} /></span>
    <h3>Лимитов на этот месяц нет</h3>
    <p>Лимит — сумма на месяц по одной статье: продукты, транспорт, развлечения. Пока его нет, приложение не может сказать, сколько по ней осталось.</p>
    <button className="primary-button" type="button" onClick={onPlanning}>Задать лимиты в плане</button>
  </div>;
  return <ul className="category-list" data-pace={percentStep(pace)}>{rows.map(({ category, metric }) => {
    if (!metric) return null;
    const visual = categoryVisual(category);
    const bar = limitBar({ name: category.name, execution: metric.execution, overLimit: metric.status === "over_limit", pace });
    return <li key={category.id}>
      <span className={`category-tile tone-${visual.tone}`}><Icon name={visual.icon} size={24} /></span>
      <div className="category-body">
        <div className="category-head"><strong>{category.name}</strong><span className={`status-chip ${metric.status}`}>{statusLabels[metric.status]}</span></div>
        <span className={bar.className} data-spent={bar.spent} role="img" aria-label={bar.label} />
        <div className="category-values"><span>Потрачено <b><Money value={metric.actualMinor} /></b></span><span>Осталось <b><Money value={metric.remainingMinor} /></b></span></div>
        {bar.note ? <p className="limit-pace">{bar.note}</p> : null}
      </div>
    </li>;
  })}</ul>;
}

function TransactionList({ transactions, categoryById, memberById, showAuthor, onAdd, hiddenByMemberFilter = false, onShowEveryone }: { transactions: Transaction[]; categoryById: Map<string, BudgetState["categories"][number]>; memberById: ReadonlyMap<string, Member>; showAuthor: boolean; onAdd?: () => void; hiddenByMemberFilter?: boolean; onShowEveryone?: () => void }) {
  // §6 исследования, пункт 29: пустое состояние обязано сообщить состояние системы, объяснить,
  // что сюда попадает, и дать прямой путь к задаче. «Здесь появятся операции» отвечало только на
  // первый вопрос, и человек, только что создавший бюджет, оставался с ним один на один.
  //
  // И оно же врало: список фильтруется по участнику, и у участника без записей эта строка
  // утверждала, что операций не появилось вовсе, — при полном бюджете рядом. Пустой список и
  // список, опустевший от фильтра, — разные состояния системы, и называются они по-разному.
  if (!transactions.length) return <div className="empty-state">
    <span className="empty-state-mark"><Icon name="inbox" size={32} /></span>
    {hiddenByMemberFilter ? <>
      <h3>У выбранного участника записей нет</h3>
      <p>Фильтр показывает операции одного человека. Записи остальных на месте — они вернутся, как только фильтр снят.</p>
      {onShowEveryone ? <button className="primary-button" type="button" onClick={onShowEveryone}>Показать записи всех</button> : null}
    </> : <>
      <h3>Записей пока нет</h3>
      <p>Здесь будут пять последних покупок, доходов и переводов — в том порядке, в каком они случились.</p>
      {onAdd ? <button className="primary-button" type="button" onClick={onAdd}>Записать первую операцию</button> : null}
    </>}
  </div>;
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
