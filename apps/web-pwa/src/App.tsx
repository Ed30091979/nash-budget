import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  calculateAnnualPlan,
  calculateBudget,
  carryBudgetForward,
  findBudgetForMonth,
  monthAfterPeriod,
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
import { observeLayoutSpace } from "./layout-space";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { DashboardScreen, monthsSpan, nextScheduledDate } from "./features/dashboard";
import { DataManagementScreen, downloadTextFile, prepareJsonDownload } from "./features/data-management";
import {
  FamilyScreen,
  MEMBER_FILTER_ALL,
  familyNewsLines,
  familyNewsSince,
  filterTransactionsByMember,
  memberFilterOptions,
  membersById,
  resolveSyncServerUrl,
  syncAlarm,
  syncIndicatorPresentation,
  transactionAuthorLabel,
  transactionIds,
  useFamily,
  type BudgetJournalWrite,
  type MemberFilter,
  type OwnAuthor,
} from "./features/family";
import { createImportMemory, ImportScreen } from "./features/import";
import { OperationsScreen } from "./features/operations";
import { HistoryScreen, operationsCount, TotalsFact, type EditRequest } from "./features/operations";
import { PlanningScreen } from "./features/planning";
import { Onboarding } from "./onboarding/Onboarding";
import { persistCompletedOnboarding } from "./onboarding/model";
import { buildDemoBudgetState } from "./onboarding/demo";
import { createBudgetBackup, describeBackupRepairs, prepareBudgetState, restoreBudgetBackup, type BackupRepair } from "./backup";
import { formatMoney, moneyScale } from "./money";
import { plural } from "./plural";
import {
  localToday,
  paydayDays,
  periodClock,
  reach,
  reachWord,
  runsOutOn,
  type PaydayHorizon,
  type PeriodClock,
  type Reach,
  type ReachState,
} from "./reach";
import { createBudgetRepository } from "./storage-repository";

export type Screen = "today" | "year" | "planning" | "operations" | "more" | "family" | "import" | "history";
type LoadState = "loading" | "empty" | "ready" | "error";

const monthLong = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
const monthOnly = new Intl.DateTimeFormat("ru-RU", { month: "long", timeZone: "UTC" });
const dateShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
/** «20 июля» — так дату называют вслух; сокращение «20 июл.» годится списку, но не линейке. */
const dateLong = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
export const DISCARD_DRAFT_CONFIRMATION = "Несохранённый черновик будет удалён. Перейти в другой раздел?";

/**
 * §6: состояние всегда несут слово и глиф вместе, цвет — третьим. Глиф объявлен рядом со словом
 * ровно поэтому: чип без глифа был на «Сегодня» и был с глифом на «Записать», то есть правило
 * держалось на памяти автора, а не на коде.
 */
const statusIcons: Record<string, IconName> = {
  no_plan: "circle-dashed",
  normal: "circle-check",
  near_limit: "triangle-alert",
  exhausted: "triangle-alert",
  over_limit: "circle-alert",
  funded: "circle-check",
  on_track: "circle-check",
  due_soon: "triangle-alert",
  overdue: "circle-alert",
};

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

/** «5-го и 20-го» — даты выплат, выведенные из доходов, одной строкой; пусто — выводить не из чего. */
export function paydayWords(days: readonly number[]): string {
  if (days.length === 0) return "";
  const named = days.map((day) => `${day}-го`);
  return named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} и ${named[named.length - 1]}`;
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

/**
 * «9 июля» — дата, названная словом.
 *
 * Пробел внутри даты неразрывный: число и месяц — одна величина, и разрывать их переносом
 * нельзя. Это то же правило, что и у суммы (§7), только запрет живёт в самой строке, а не в
 * стилях: запрет в стилях не даёт подписи перенестись там, где перенестись ей надо.
 */
function formatDay(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : dateLong.format(date).replace(/ /gu, "\u00a0");
}

/** «июля» — месяц в родительном падеже, отрезанный от «31 июля»: склонять руками нечего. */
function monthGenitive(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const parts = dateLong.format(date).split(" ");
  return parts[parts.length - 1] ?? value;
}

/**
 * «сентябрь» — месяц назван словом, строчными: «Открыть сентябрь».
 *
 * У названий месяцев винительный падеж совпадает с именительным, поэтому одна форма работает и
 * подлежащим, и дополнением, и склонять здесь нечего.
 */
function monthName(month: string): string {
  return monthOnly.format(new Date(`${month}-01T00:00:00.000Z`));
}

/** «Июль» — тот же месяц с прописной, как начало фразы. */
function monthNominative(month: string): string {
  const word = monthName(month);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Как называется край линейки: «до 20 июля», когда дата выведена из доходов, и «до конца июля»,
 * когда выводить было не из чего. Второе — не запасной путь, а обычный: у нового пользователя
 * истории доходов нет вовсе, и придумывать ему аванс приложение не станет.
 */
function paydayLabel(payday: PaydayHorizon): string {
  return payday.source === "income" ? formatDay(payday.date) : `конца ${monthGenitive(payday.date)}`;
}

/**
 * Подпись под насечкой.
 *
 * У выведенной даты слово нужно: без него «20 июля» — просто число в середине полосы. У
 * календарного края оно лишнее: последнее число месяца само себя объясняет, а голос под линейкой
 * в ту же секунду говорит «Хватает до конца сентября». Лишнее слово там стоило второй строки.
 */
function paydayLegend(payday: PaydayHorizon): string {
  return payday.source === "income" ? `${formatDay(payday.date)} · выплата` : formatDay(payday.date);
}

/** Средний расход в день — величина показа, а не хранения: до рубля, без копеек. */
function perDayMinor(line: Reach): number | null {
  return line.perDayMinor === null ? null : Math.round(line.perDayMinor / 100) * 100;
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

/**
 * Рама, общая для всех маршрутов: содержимое маршрута и под ним плашка сервис-воркера.
 *
 * Плашка монтируется один раз на всё время жизни приложения — она всегда второй ребёнок одного и
 * того же корневого `div`, — поэтому её состояние переживает смену маршрута. Иначе признак «готово
 * к работе офлайн», который срабатывает один раз за установку, ловил тот экземпляр, что стоял на
 * онбординге, и молча пропадал в ту секунду, когда человек нажимал «Создать бюджет»: сообщение,
 * которое никто не закрывал, исчезало само.
 *
 * Плашка одна на все маршруты и одна на экране: пока стоит сообщение приложения, плашка
 * обновления прячется. Две плашки с одним и тем же прилипанием к низу вставали друг на друга, и
 * верхняя накрывала кнопку «Закрыть» нижней.
 */
function AppFrame({ className, hasUnsavedChanges, messageShown, children }: { className: string; hasUnsavedChanges: boolean; messageShown: boolean; children: ReactNode }) {
  return <div className={className}>{children}<UpdatePrompt hasUnsavedChanges={hasUnsavedChanges} suppressed={messageShown} /></div>;
}

export default function App() {
  const repository = useMemo(() => createBudgetRepository(), []);
  // Память назначений импорта: локальная запись на этом устройстве, стирается вместе с данными.
  const importMemory = useMemo(() => createImportMemory(), []);
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
  const [storageHealth, setStorageHealth] = useState<StorageHealth | null>(null);
  const [lastSuccessfulBackup, setLastSuccessfulBackup] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [openingMonth, setOpeningMonth] = useState(false);
  const [operationDraftDirty, setOperationDraftDirty] = useState(false);
  const [planningDraftDirty, setPlanningDraftDirty] = useState(false);
  const [importDraftDirty, setImportDraftDirty] = useState(false);
  // Просьба открыть операцию из истории на «Ещё» в форме «Записать»; экран записи её гасит.
  const [editRequest, setEditRequest] = useState<EditRequest | null>(null);
  const [memberFilter, setMemberFilter] = useState<MemberFilter>(MEMBER_FILTER_ALL);
  // §6 «Семейная новость»: что человек уже видел — идентификаторы операций бюджета на момент
  // открытия и на момент, когда новость стояла на экране. Не хранилище, а память сессии: на
  // следующем открытии «прошлый раз» — это бюджет, прочитанный с диска, а в него приём уже
  // записал всё, что пришло, одной транзакцией с курсором.
  const [seenTransactionIds, setSeenTransactionIds] = useState<ReadonlySet<string> | null>(null);
  const previousScreenRef = useRef<Screen>(screen);
  // Место под шапку и навигацию снимается с разметки, а не берётся из числа: панель растёт с
  // системным шрифтом, и полоса записи обязана стоять на настоящей панели (`layout-space.ts`).
  // Оболочка появляется вместе с готовым бюджетом, поэтому наблюдение привязано к состоянию
  // загрузки: до него рефы пусты, и мерить нечего.
  const headerRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const header = headerRef.current;
    const nav = navRef.current;
    if (!header || !nav) return undefined;
    return observeLayoutSpace(document.documentElement, header, nav);
  }, [loadState]);
  const hasUnsavedDraft = operationDraftDirty || planningDraftDirty || importDraftDirty;
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
            setSeenTransactionIds(transactionIds(prepared));
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

  // §6 «Семейная новость»: чужие записи, которых не было в прошлый раз. Своё — участник этого
  // устройства из сессии; без сессии (синхронизация не настроена или входа нет) новость не
  // считается вовсе, и это первая проверка, а не следствие пустой карты авторов. Герой-число от
  // неё не зависит: новость выводится из состояния, которое приходит позже него, и стоит под ним.
  const ownDeviceId = family.session?.deviceId ?? null;
  const ownMemberId = family.session?.memberId ?? null;
  const familyNews = useMemo(() => {
    if (budget === null || seenTransactionIds === null || ownDeviceId === null) return [];
    const own: OwnAuthor = { deviceId: ownDeviceId, memberId: ownMemberId };
    return familyNewsSince(seenTransactionIds, budget, family.transactionAuthors, own);
  }, [budget, seenTransactionIds, family.transactionAuthors, ownDeviceId, ownMemberId]);
  const familyNewsText = useMemo(() => familyNewsLines(familyNews, memberById), [familyNews, memberById]);
  // Новость увидена, когда человек ушёл с «Сегодня» или свернул приложение, пока она там стояла:
  // «прошлый раз» становится нынешним состоянием, и за тем же она не возвращается.
  const newsOnScreen = screen === "today" && familyNews.length > 0;
  const markNewsSeen = () => {
    const current = budgetRef.current;
    if (current !== null) setSeenTransactionIds(transactionIds(current));
  };
  useEffect(() => {
    if (!newsOnScreen) return undefined;
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      const current = budgetRef.current;
      if (current !== null) setSeenTransactionIds(transactionIds(current));
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [newsOnScreen]);

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
    setSeenTransactionIds(transactionIds(next));
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
  if (loadState === "loading") return <AppFrame className="loading-route" hasUnsavedChanges={false} messageShown={false}><SkipLink /><main id={MAIN_CONTENT_ID} tabIndex={-1} className="loading-state" aria-busy="true">{slowLoad ? <p>Открываем семейный план…</p> : null}</main></AppFrame>;
  if (loadState === "error") return <AppFrame className="loading-route" hasUnsavedChanges={false} messageShown={false}><SkipLink /><main id={MAIN_CONTENT_ID} tabIndex={-1} className="loading-state storage-error-state"><section role="alert"><h1>Не удалось открыть локальные данные</h1><p>Мы не подставили демо и не создали новый бюджет. Проверьте, разрешено ли хранение данных для этого сайта.</p><button className="primary-button" type="button" onClick={() => setLoadAttempt((value) => value + 1)}>Повторить</button></section></main></AppFrame>;
  if (loadState === "empty") return <AppFrame className="onboarding-route" hasUnsavedChanges={false} messageShown={false}><IconSprite /><SkipLink /><div id={MAIN_CONTENT_ID} tabIndex={-1}><Onboarding onComplete={completeOnboarding} onDemo={loadDemo} /></div></AppFrame>;
  if (!budget || !metrics || !plan) return <AppFrame className="loading-route" hasUnsavedChanges={false} messageShown={false}><SkipLink /><main id={MAIN_CONTENT_ID} tabIndex={-1} className="loading-state" role="alert"><p>Бюджет не удалось подготовить к показу.</p></main></AppFrame>;

  const activeBudget = budget.budgets.find((item) => item.id === budget.activeBudgetId)!;
  const flexibleIds = new Set(activeBudget.lines.filter((line) => line.active !== false).map((line) => line.categoryId));
  const activeExpenseCategories = budget.categories.filter((category) => category.active && category.type === "expense");
  const flexibleRows = activeExpenseCategories
    .filter((category) => category.active && flexibleIds.has(category.id))
    .map((category) => ({ category, metric: metrics.categoryMetrics[category.id] }))
    .filter((row) => row.metric);
  const flexibleSpentMinor = flexibleRows.reduce((total, row) => total + (row.metric?.actualMinor ?? 0), 0);
  const safeToSpendMinor = plan.currentMonth.flexiblePlanMinor - flexibleSpentMinor;
  // §6, часы периода. «Сегодня» берётся по календарю семьи, а не по UTC: последний день месяца в
  // UTC уже первый день следующего, и насечка прыгнула бы в начало полосы. Дата следующей выплаты
  // выводится из дат уже записанных доходов — в слое представления, как иконки и тона категорий.
  // Часы одни на все экраны: «Сегодня», «Записать» и «Год» считают от одного и того же дня.
  const today = localToday(new Date());
  const incomeDates = budget.transactions
    .filter((transaction) => transaction.status === "posted" && transaction.kind === "income")
    .map((transaction) => transaction.occurredOn);
  const clock = periodClock(activeBudget, incomeDates, today);
  const paydays = paydayDays(incomeDates, today);
  // §6, выход из закрытого месяца. Пока месяц плана идёт, предлагать нечего; когда он кончился —
  // предлагается ровно один месяц, тот, в котором семья сейчас живёт и тратит.
  const monthToOpen = clock.position === "after" ? monthAfterPeriod(activeBudget, today) : null;
  /**
   * Открытие месяца — обычная правка состояния, и идёт она тем же путём, что и всякая другая:
   * через координатор записи, а значит — через журнал семьи, если она есть. Никакого своего пути
   * у неё нет и быть не должно: второе устройство узнаёт про новый месяц оттуда же, откуда узнаёт
   * про каждую покупку.
   */
  const openMonth = async (month: string) => {
    if (openingMonth) return;
    setOpeningMonth(true);
    try {
      const opened = findBudgetForMonth(budget, month) === undefined;
      await budgetSave.apply((state) => carryBudgetForward(state, month).state);
      setMessage(opened
        ? `${monthNominative(month)} открыт: лимиты перенесены, остатки конвертов легли в них сверху. Всё это можно поправить в плане.`
        : `${monthNominative(month)} уже был в плане — открыли его.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось открыть месяц.");
    } finally {
      setOpeningMonth(false);
    }
  };
  const postedTransactions = [...budget.transactions]
    .filter((transaction) => transaction.status === "posted")
    .sort((left, right) => right.occurredOn.localeCompare(left.occurredOn));
  const recentTransactions = filterTransactionsByMember(postedTransactions, memberFilter).slice(0, 5);
  const memberOptions = memberFilterOptions(budget);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
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
      if (newsOnScreen) markNewsSeen();
      setScreen(destination);
    }
  };

  return (
    <AppFrame className="app-shell" hasUnsavedChanges={hasUnsavedDraft} messageShown={message !== null}>
      <IconSprite />
      <SkipLink />
      <header ref={headerRef} className="app-header" data-scrolled={headerScrolled ? "true" : undefined}>
        {/* Шапка называет план и больше ничего. Слоган «видим месяц и будущее» продавал продукт
            тому, кто его уже открыл, и делал это на каждом экране за 70 pt высоты. */}
        <div className="brand"><span className="brand-mark"><Icon name="piggy-bank" size={20} /></span><strong>Наш бюджет</strong></div>
        {/* Состояние синхронизации — единственное, что шапке есть сказать о сети, и только когда
            семья вошла. Без входа приложение к сети не обращается вовсе, и пилюля «в сети» была
            бы сведением ни о чём: она называла бы состояние, которым продукт не занят. */}
        {syncIndicator.state === "local" ? null : <div className="header-badges"><span className={syncIndicator.className} role="status" aria-label={syncIndicator.ariaLabel}>{syncIndicator.text}</span></div>}
      </header>

      <nav ref={navRef} className="bottom-nav" aria-label="Основные разделы">
        <NavButton active={screen === "today"} icon="today" label="Сегодня" onClick={() => navigate("today")} />
        <NavButton active={screen === "year" || screen === "planning"} icon="year" label="Год" onClick={() => navigate("year")} />
        <NavButton active={screen === "operations"} icon="operations" label="Записать" onClick={() => navigate("operations")} />
        <NavButton active={screen === "more" || screen === "family" || screen === "import" || screen === "history"} icon="more" label="Ещё" onClick={() => navigate("more")} />
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
          {screen === "today" ? <TodayScreen budget={budget} plan={plan} flexibleRows={flexibleRows} safeToSpendMinor={safeToSpendMinor} flexibleSpentMinor={flexibleSpentMinor} clock={clock} recentTransactions={recentTransactions} categoryById={categoryById} memberById={memberById} memberOptions={memberOptions} memberFilter={memberFilter} onMemberFilterChange={setMemberFilter} hasRecords={postedTransactions.length > 0} monthToOpen={monthToOpen} openingMonth={openingMonth} onOpenMonth={(month) => void openMonth(month)} onAdd={() => navigate("operations")} onYear={() => navigate("year")} onPlanning={() => navigate("planning")} onImport={() => navigate("import")} familyNews={familyNewsText} /> : null}
          {screen === "year" ? <YearScreen budget={budget} plan={plan} paydays={paydays} onPlanning={() => navigate("planning")} categoryById={categoryById} /> : null}
          {screen === "planning" ? <><div className="planning-toolbar"><BackButton label="К горизонту" onClick={() => navigate("year")} /></div><PlanningScreen budget={budget} onChange={(change) => budgetSave.apply(change)} onDirtyChange={setPlanningDraftDirty} /></> : null}
          {screen === "operations" ? <OperationsScreen budget={budget} clock={clock} onChange={(change) => budgetSave.apply(change)} onDirtyChange={setOperationDraftDirty} onPlanning={() => navigate("planning")} editRequest={editRequest} onEditRequestHandled={() => setEditRequest(null)} /> : null}
          {screen === "more" ? <MoreScreen
            budget={budget}
            metrics={metrics}
            storageHealth={storageHealth}
            showIosInstall={isIos && !isStandalone}
            lastSuccessfulBackup={lastSuccessfulBackup}
            onCreateBackup={async () => createBudgetBackup(
              budgetRef.current ?? budget,
              async () => undefined,
            )}
            onRecordSuccessfulBackup={recordBackup}
            onRestoreBackup={async (file) => {
              const repairs: BackupRepair[] = [];
              await restoreBudgetBackup(
                file,
                (restored) => budgetSave.apply(() => restored).then(() => undefined),
                () => undefined,
                (repair) => { repairs.push(repair); },
              );
              // Каждый вид ремонта называется своими словами: снятая метка — не снятый участник.
              const notice = describeBackupRepairs(repairs);
              if (notice !== null) setMessage(notice);
            }}
            onPersistClear={async () => {
              await repository.clear();
              // Ключи памяти — названия продавцов из выписок семьи; они уходят вместе с бюджетом.
              await importMemory.clear().catch(() => undefined);
            }}
            onPublishEmpty={() => {
              budgetRef.current = null;
              revisionRef.current = null;
              setBudget(null);
              setSeenTransactionIds(null);
              setLastSuccessfulBackup(null);
              setLoadState("empty");
            }}
            onFamily={() => navigate("family")}
            onPlanning={() => navigate("planning")}
            onHistory={() => navigate("history")}
            onImportStatement={() => navigate("import")}
            familyNote={family.membership === null
              ? "Без входа приложение работает как сейчас"
              : `${plural(Math.max(1, family.members.length), ["участник", "участника", "участников"])} · приглашение, отпечатки ключей`}
            monthNote={monthNote(budget, paydays)}
            syncIndicator={syncIndicator}
          /> : null}
          {/* Вся история — маршрут внутри «Ещё»; строка истории открывает операцию в форме записи. */}
          {screen === "history" ? <HistoryScreen budget={budget} onEdit={(transaction) => { setEditRequest({ id: transaction.id, nonce: Date.now() }); navigate("operations"); }} onAdd={() => navigate("operations")} onBack={() => navigate("more")} /> : null}
          {screen === "import" ? <ImportScreen budget={budget} memory={importMemory} onChange={(change) => budgetSave.apply(change)} onDirtyChange={setImportDraftDirty} onBack={() => navigate("more")} /> : null}
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
    </AppFrame>
  );
}

/**
 * Строка «Наш месяц» на «Ещё»: строй месяца одной строкой — выплаты, конверты, платежи.
 *
 * Те же числа, на которых стоят «Сегодня» и «Год», названные коротко: не второй экран плана, а
 * дверь в него с табличкой, по которой видно, что за ней.
 */
export function monthNote(budget: BudgetState, paydays: readonly number[]): string {
  const active = budget.budgets.find((item) => item.id === budget.activeBudgetId);
  const lines = (active?.lines ?? []).filter((line) => line.active !== false);
  const envelopesMinor = lines.reduce((total, line) => total + line.plannedMinor, 0);
  const payments = budget.scheduledExpenses.filter((item) => item.active).length
    + budget.annualCommitments.filter((item) => item.active).length;
  const parts = [
    paydays.length ? `выплаты ${paydayWords(paydays)}` : "даты выплат — из доходов",
    lines.length ? `${plural(lines.length, ["конверт", "конверта", "конвертов"])} на ${formatMoney(envelopesMinor)}` : "конвертов нет",
    payments ? plural(payments, ["платёж", "платежа", "платежей"]) : "платежей нет",
  ];
  return parts.join(" · ");
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

/**
 * «Сегодня»: одно огромное число и один голос под ним.
 *
 * Голос отвечает на тот вопрос, с которым приложение открывают, — хватит ли до выплаты, — и
 * важное внутри него отмечено весом, а не размером. Восемь ступеней кегля были восемью уровнями,
 * которые приходилось различать; различать больше нечего.
 *
 * Экран говорит про один месяц — месяц плана. Пока сегодняшний день лежит внутри него, число и
 * линейка — про одно и то же: остаток месяца и на сколько дней вперёд он дотягивает. Когда месяц
 * закрыт (или ещё не начался), линейки нет вовсе: прогноз «хватает до конца сентября» рядом с
 * остатком июля был арифметически бессвязен, и честнее сказать словами, что показан закрытый
 * месяц и почему у него нет прогноза.
 */
export function TodayScreen({ budget, plan, flexibleRows, safeToSpendMinor, flexibleSpentMinor, clock, recentTransactions, categoryById, memberById, memberOptions, memberFilter, onMemberFilterChange, hasRecords, monthToOpen, openingMonth, onOpenMonth, onAdd, onYear, onPlanning, onImport, familyNews }: { budget: BudgetState; plan: AnnualPlan; flexibleRows: CategoryRow[]; safeToSpendMinor: number; flexibleSpentMinor: number; clock: PeriodClock; recentTransactions: Transaction[]; categoryById: Map<string, BudgetState["categories"][number]>; memberById: ReadonlyMap<string, Member>; memberOptions: readonly { readonly value: MemberFilter; readonly label: string }[]; memberFilter: MemberFilter; onMemberFilterChange: (value: MemberFilter) => void; hasRecords: boolean; monthToOpen: string | null; openingMonth?: boolean; onOpenMonth?: (month: string) => void; onAdd: () => void; onYear: () => void; onPlanning: () => void; onImport?: () => void; familyNews: readonly string[] }) {
  const overLimit = flexibleRows.filter((row) => row.metric?.status === "over_limit");
  const nextId = plan.upcomingCommitmentIds[0];
  const next = budget.annualCommitments.find((item) => item.id === nextId);
  const nextMetrics = next ? plan.commitments[next.id] : undefined;
  const safeToSpend = formatMoney(safeToSpendMinor);
  const { today, payday, elapsedDays } = clock;
  const line = reach({
    remainingMinor: safeToSpendMinor,
    spentMinor: flexibleSpentMinor,
    elapsedDays,
    daysAhead: payday.daysAhead,
  });
  const rate = perDayMinor(line);
  const until = paydayLabel(payday);
  // Прогноз округляется до рубля: копейки в «останется 5 000 ₽» — точность, которой у прогноза
  // нет, и она сразу выдаёт в нём арифметику вместо ответа.
  const leftAtPayday = line.perDayMinor === null
    ? safeToSpendMinor
    : Math.round((safeToSpendMinor - line.perDayMinor * payday.daysAhead) / 100) * 100;
  const needPerDay = payday.daysAhead > 0 ? Math.round(safeToSpendMinor / payday.daysAhead / 100) * 100 : 0;
  const monthWord = monthOnly.format(new Date(`${plan.startMonth}-01T00:00:00.000Z`));
  const monthOf = monthGenitive(`${plan.startMonth}-15`);
  return <>
    <h1 className="visually-hidden">Сегодня: семейный бюджет</h1>
    <section className={`hero-card${line.state === "out" && clock.inPeriod ? " danger" : ""}`}>
      {/* Эйбрау называет месяц, к которому относятся числа, и больше ничего. Числа дня здесь
          не было: его человек видит в строке состояния телефона, а положение внутри месяца
          показывает линейка под суммой. Слово «сегодня» вдобавок повторяло имя вкладки, на
          которой человек стоит. Приписка появляется только когда месяц не идёт — тогда ей есть
          что сообщить. */}
      <p className="eyebrow">{monthWord}{clock.inPeriod ? "" : clock.position === "after" ? " · закрыт" : " · ещё не начался"}</p>
      <span>{clock.inPeriod ? "Можно на повседневные расходы" : `Осталось от повседневных лимитов ${monthOf}`}</span>
      <strong data-money-scale={moneyScale(safeToSpend)}><Money value={safeToSpendMinor} breakDigits /></strong>
      {clock.inPeriod ? <>
        <span className={`limit-bar hero-reach ${line.state}`} data-spent={line.fill} role="img" aria-label={`Линейка до выплаты: ${reachAnnouncement(line, payday, today)}`} />
        {/* Слева сегодня, у самой насечки — дата края, за ней — запас. Дату сегодняшнего дня
            подпись не повторяет: её уже сказал эйбрау над числом. */}
        <p className="reach-legend">
          <span><span>сегодня</span><b>{paydayLegend(payday)}</b></span>
          <span>{line.surplusDays > 0 ? "запас" : ""}</span>
        </p>
        {line.state === "out"
          ? <p><b>Повседневные лимиты исчерпаны.</b> До {until} ещё {payday.daysAhead} дн. Платежи и накопления учтены отдельно и на них это не влияет.</p>
          : rate === null
            ? <p><b>Хватает до {until}.</b> По повседневным лимитам в этом месяце пока ничего не записано.</p>
            : line.state === "reaches"
              ? <p><b>Хватает до {until}.</b> Тратим <Money value={rate} /> в день — к этому дню останется <Money value={Math.max(0, leftAtPayday)} />.</p>
              : <p><b>Хватает до {formatDay(runsOutOn(today, line.daysCovered) ?? payday.date)}, а до {until} не дотягивает.</b> Тратим <Money value={rate} /> в день; чтобы дотянуть — <Money value={needPerDay} /> в день.</p>}
      </> : <>
        <p>
          <b>{monthNominative(plan.startMonth)} {clock.position === "after" ? "закончился" : "ещё не начался"}.</b> Сегодня {formatDay(today)}, а показан месяц плана: линейка до выплаты считает только внутри своего месяца, и прогноза у него нет. Покупка, записанная сегодняшним числом, в эти конверты не попадёт.
        </p>
        {/* Выход из закрытого месяца. Экран, который называет тупик и ничего не предлагает, —
            это половина ответа: месяц плана кончился, а нового взять неоткуда, и каждая покупка
            уходит мимо конвертов. Открывает месяц человек и только человек: за его спиной это
            не случается, потому что перенос — это его деньги и его план, и приложение обязано
            сначала сказать, что именно оно перенесёт. */}
        {monthToOpen && onOpenMonth ? <>
          <p>Открыть {monthName(monthToOpen)} — значит перенести в него те же лимиты и положить сверху остатки конвертов {monthOf}. {monthNominative(plan.startMonth)} останется в истории со своими числами.</p>
          <button className="primary-button" type="button" disabled={openingMonth} aria-busy={openingMonth} onClick={() => onOpenMonth(monthToOpen)}><span className="icon-label"><Icon name="calendar-clock" size={20} />Открыть {monthName(monthToOpen)}</span></button>
        </> : null}
      </>}
      <button className={monthToOpen && onOpenMonth && !clock.inPeriod ? "secondary-button" : "primary-button"} type="button" onClick={onAdd}><span className="icon-label"><Icon name="plus" size={20} />Записать покупку</span></button>
    </section>

    {/* §6 Семейная новость: единственный заслуженный момент на входе — первое открытие после
        того, как второй участник что-то записал. Стоит под героем и никогда над ним: герой
        не ждёт её и не двигается из-за неё. В потоке, ничего не накрывает. Итог по видам и
        суммам, а не строки операций — те и так стоят в «Последних записях». */}
    {familyNews.length > 0 ? <div className="family-news" role="status">
      <span className="family-news-mark"><Icon name="users" size={24} /></span>
      <div>
        {familyNews.map((line) => <strong key={line}>{line}</strong>)}
        <small>Новое с прошлого раза</small>
      </div>
    </div> : null}

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
      <SectionTitle title="Повседневные лимиты" note={clock.inPeriod ? `Та же линейка: дотянет ли конверт до ${until}` : `Итог ${monthOf}: что осталось в конвертах`} />
      <CategoryList rows={flexibleRows} clock={clock} onPlanning={onPlanning} />
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

    {/* Холодный старт: пока записей нет, вторая дверь — выписка банка. Она стоит после пустого
        состояния, а не внутри него: основное действие там одно, ручная запись, и порядок «сначала
        руками, потом банк» — тот, что повышает доверие (§6 исследования, пункт 31). Постоянный дом
        импорта — «Ещё → Данные»; здесь только дверь для того, у кого история ещё пуста. */}
    {!hasRecords && onImport ? <button className="year-preview" type="button" onClick={onImport}><span className="row-mark"><Icon name="receipt-text" size={24} /></span><span className="row-copy"><b>Загрузить выписку банка</b><small>CSV из Т-Банка. Файл читается на этом устройстве и никуда не уходит</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></button> : null}
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
 * Верхнюю часть — вывод, строй месяца и лестницу месяцев — рисует `DashboardScreen`. Ниже стоит
 * один список платежей, и упорядочен он по числу месяца, а не по названию: число — то, по чему
 * семья помнит свои платежи («пятого — аренда, пятнадцатого — ЖКХ»). Крупные и разовые платежи
 * идут своими группами: их копят помесячно, а не платят каждый месяц.
 */
function YearScreen({ budget, plan, paydays, onPlanning, categoryById }: { budget: BudgetState; plan: AnnualPlan; paydays: readonly number[]; onPlanning: () => void; categoryById: Map<string, BudgetState["categories"][number]> }) {
  const groups = paymentGroups(budget, plan, categoryById);
  return <>
    <DashboardScreen budget={budget} paydays={paydays} onPlanning={onPlanning} />

    <section className="section-card" aria-labelledby="payments-by-day-title">
      <SectionTitle id="payments-by-day-title" title="Платежи по числам" note="Число месяца — то, по чему семья помнит свои платежи" />
      {groups.length ? groups.map((group) => <div className="pay-group" key={group.title}>
        <h3>{group.title}</h3>
        {group.rows.map((row) => <PayRow key={row.key} row={row} />)}
      </div>) : <div className="empty-state">
        <span className="empty-state-mark"><Icon name="calendar-clock" size={32} /></span>
        <h3>Платежей в плане нет</h3>
        <p>Сюда попадает всё, что платят по расписанию или копят заранее: аренда, страховка, обучение, шины, отпуск. Горизонт держится на них — без них он равен доходу.</p>
        <button className="primary-button" type="button" onClick={onPlanning}>Добавить платёж в план</button>
      </div>}
    </section>

    {/* Правило резерва объясняется один раз и по требованию: это справка, а не содержимое экрана. */}
    <details className="section-card collapsible-card">
      <summary><span>Как это считается</span><Icon name="chevron-right" size={24} className="row-chevron" /></summary>
      <p className="body-copy">Крупный платёж показывается в месяце оплаты, но не вычитается второй раз: до срока приложение ежемесячно резервирует нужную сумму. Полоса месяца — что остаётся от дохода после платежей, резервов и взносов в цели; насечка на ней — конверты повседневных лимитов, и всё за насечкой свободно.</p>
    </details>
  </>;
}

interface PayRowData {
  readonly key: string;
  /** Число крупно: «5» и рядом «-го», либо «15» и «янв». */
  readonly day: string;
  readonly daySuffix: string;
  readonly name: string;
  /** «Жильё · сентябрь — май» — одна строка вместо трёх подписей. */
  readonly note: string;
  readonly amountMinor: number;
  /** Сколько откладывать в месяц; `null` — регулярный платёж, его не копят. */
  readonly reserveMinor: number | null;
  /** Состояние резерва, когда оно стоит того, чтобы его назвать: «по плану» — молчание. */
  readonly status: string | null;
  /** Дата ближайшего платежа: по ней строки упорядочены внутри группы. */
  readonly sortKey: string;
}

interface PayGroup {
  readonly title: string;
  readonly rows: readonly PayRowData[];
}

const dayMonthShort = new Intl.DateTimeFormat("ru-RU", { month: "short" });

/** «янв» — месяц срока крупного платежа без точки: «15 янв», а не «15 янв.». */
function monthShortOf(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? date.slice(5, 7) : dayMonthShort.format(parsed).replace(".", "");
}

export function paymentGroups(
  budget: BudgetState,
  plan: AnnualPlan,
  categoryById: Map<string, BudgetState["categories"][number]>,
): readonly PayGroup[] {
  const byDay = (left: PayRowData, right: PayRowData) => left.sortKey.localeCompare(right.sortKey) || left.name.localeCompare(right.name, "ru-RU");
  const schedules = budget.scheduledExpenses.filter((item) => item.active);
  const monthly = schedules.filter((item) => item.mode === "monthly").map((item): PayRowData => ({
    key: `schedule-${item.id}`,
    day: String(item.dueDay),
    daySuffix: "-го",
    name: item.name,
    note: categoryById.get(item.categoryId)?.name ?? "",
    amountMinor: item.amountMinor,
    reserveMinor: null,
    status: null,
    sortKey: String(item.dueDay).padStart(2, "0"),
  })).sort(byDay);
  const seasonal = schedules.filter((item) => item.mode !== "monthly").map((item): PayRowData => ({
    key: `schedule-${item.id}`,
    day: String(item.dueDay),
    daySuffix: "-го",
    name: item.name,
    note: [categoryById.get(item.categoryId)?.name, monthsSpan(item.months ?? [])].filter((part) => part).join(" · "),
    amountMinor: item.amountMinor,
    reserveMinor: null,
    status: null,
    // Внутри группы — по числу месяца; расписание, чьи месяцы кончились, идёт в конец.
    sortKey: `${nextScheduledDate(item, plan.startMonth) === null ? "z" : "a"}${String(item.dueDay).padStart(2, "0")}`,
  })).sort(byDay);
  const commitment = (item: BudgetState["annualCommitments"][number]): PayRowData => {
    const status = plan.commitments[item.id]?.status ?? null;
    return {
      key: `commitment-${item.id}`,
      day: String(Number(item.dueDate.slice(8, 10))),
      daySuffix: ` ${monthShortOf(item.dueDate)}`,
      name: item.name,
      note: categoryById.get(item.categoryId)?.name ?? "",
      amountMinor: item.amountMinor,
      reserveMinor: plan.commitments[item.id]?.monthlyReserveMinor ?? 0,
      status: status === "on_track" ? null : status,
      sortKey: item.dueDate,
    };
  };
  const commitments = budget.annualCommitments.filter((item) => item.active);
  const annual = commitments.filter((item) => item.recurrence === "annual").map(commitment).sort(byDay);
  const once = commitments.filter((item) => item.recurrence !== "annual").map(commitment).sort(byDay);
  return [
    { title: "Каждый месяц", rows: monthly },
    { title: "По расписанию", rows: seasonal },
    { title: "Раз в год — откладываем помесячно", rows: annual },
    { title: "Один раз", rows: once },
  ].filter((group) => group.rows.length > 0);
}

function PayRow({ row }: { row: PayRowData }) {
  return <article className="pay-row">
    <span className="pay-day"><b>{row.day}</b><small>{row.daySuffix}</small></span>
    <div className="pay-copy">
      <strong>{row.name}</strong>
      {row.note ? <small>{row.note}</small> : null}
      {row.status ? <span className={`status-chip ${row.status}`}><Icon name={statusIcons[row.status] ?? "circle-dashed"} size={20} />{statusLabels[row.status] ?? ""}</span> : null}
    </div>
    <p className="pay-amount">
      <b><Money value={row.amountMinor} /></b>
      {row.reserveMinor === null ? null : <span><Money value={row.reserveMinor} /> в месяц</span>}
    </p>
  </article>;
}

function SectionTitle({ id, title, note, icon }: { id?: string; title: string; note: string; icon?: IconName }) {
  return <div className="section-title"><div><h2 id={id}>{icon ? <Icon name={icon} size={20} /> : null}{title}</h2><p>{note}</p></div></div>;
}

/** Глиф состояния линейки: слово и глиф вместе, цвет — третьим (§6). */
const reachIcons: Record<ReachState, IconName> = {
  reaches: "circle-check",
  short: "triangle-alert",
  out: "circle-alert",
};

/**
 * Состояние линейки словами — для читающих с экрана и для проверок.
 *
 * Цвет заливки здесь ничего не решает: та же мысль сказана словом чипа, положением заливки
 * относительно насечки и вот этой строкой. Дальтонизм — у восьми процентов мужчин.
 */
function reachAnnouncement(line: Reach, payday: PaydayHorizon, today: string): string {
  const edge = payday.source === "income"
    ? `выплаты ${formatDay(payday.date)}`
    : `конца месяца, ${formatDay(payday.date)}`;
  if (line.state === "out") return `денег не осталось, до ${edge} ещё ${payday.daysAhead} дн.`;
  const out = runsOutOn(today, line.daysCovered);
  if (line.state === "reaches") {
    return out === null
      ? `трат ещё не было, до ${edge} денег хватает`
      : `хватает до ${formatDay(out)}, то есть дальше ${edge}`;
  }
  return `хватает до ${out === null ? "неизвестного дня" : formatDay(out)}, а это раньше ${edge}`;
}

/**
 * Список лимитов месяца в грамматике той же линейки.
 *
 * Насечка у всех строк стоит на одной доле полосы, поэтому сквозь карточку проходит одна
 * вертикаль, и видно, какие конверты её не пересекают. Полоса «сколько процентов лимита
 * израсходовано» отвечала на вопрос, которого семья не задаёт.
 *
 * У закрытого месяца линейки нет: прогноз «до 20 июля» из сентября — не прогноз. Строка тогда
 * называет итог словами и числами: сколько осталось, сколько ушло из лимита.
 */
function CategoryList({ rows, clock, onPlanning }: { rows: CategoryRow[]; clock: PeriodClock; onPlanning: () => void }) {
  // Пустой список — не пустая разметка: §6 исследования требует назвать состояние, объяснить его
  // и дать дорогу дальше. Раньше здесь оставалась пустая карточка без единого слова.
  if (!rows.length) return <div className="empty-state">
    <span className="empty-state-mark"><Icon name="target" size={32} /></span>
    <h3>Лимитов на этот месяц нет</h3>
    <p>Лимит — сумма на месяц по одной статье: продукты, транспорт, развлечения. Пока его нет, приложение не может сказать, сколько по ней осталось.</p>
    <button className="primary-button" type="button" onClick={onPlanning}>Задать лимиты в плане</button>
  </div>;
  const { today, payday, elapsedDays } = clock;
  return <ul className={`category-list${clock.inPeriod ? "" : " closed"}`}>{rows.map(({ category, metric }) => {
    if (!metric) return null;
    const visual = categoryVisual(category);
    const line = reach({
      remainingMinor: metric.remainingMinor,
      spentMinor: metric.actualMinor,
      elapsedDays,
      daysAhead: payday.daysAhead,
      overLimit: metric.status === "over_limit",
    });
    const rate = perDayMinor(line);
    const out = runsOutOn(today, line.daysCovered);
    const overMinor = metric.overMinor ?? 0;
    // Факт и путь: нехватка не называется без числа, которым её закрывают. «До 12-го» — факт,
    // «чтобы дотянуть — 400 ₽ в день» — путь; строка без второго была бы упрёком без ответа.
    const needPerDay = payday.daysAhead > 0 ? Math.round(Math.max(0, metric.remainingMinor) / payday.daysAhead / 100) * 100 : 0;
    // Закрытый месяц: слово итога вместо слова прогноза. «Хватило» — конверт дожил до конца
    // месяца с остатком; «Конверт пуст» и «Перелимит» — факты, они не меняются.
    const chipState: ReachState = line.state === "out" ? "out" : clock.inPeriod ? line.state : "reaches";
    const chipWord = line.state === "out" && overMinor > 0
      ? <>Перелимит <Money value={overMinor} /></>
      : clock.inPeriod ? reachWord(line.state) : line.state === "out" ? reachWord("out") : "Хватило";
    return <li key={category.id}>
      <div className="category-head">
        <span className={`category-tile tone-${visual.tone}`}><Icon name={visual.icon} size={24} /></span>
        <strong>{category.name}</strong>
        <span className={`status-chip ${chipState}`}>
          <Icon name={reachIcons[chipState]} size={20} />
          {chipWord}
        </span>
      </div>
      {clock.inPeriod ? <span className={`limit-bar ${line.state}`} data-spent={line.fill} role="img" aria-label={`${category.name}: ${reachAnnouncement(line, payday, today)}`} /> : null}
      <div className="category-values">
        {clock.inPeriod ? <>
          <span><b><Money value={Math.max(0, metric.remainingMinor)} /></b>{rate === null ? "" : <> · <Money value={rate} /> в день</>}</span>
          {line.state === "out"
            ? <span className="out">{overMinor > 0 ? "потрачено сверх лимита" : "конверт пуст"}</span>
            : line.state === "short" && out !== null
              ? <span className="short">до {formatDay(out)} · чтобы дотянуть — <Money value={needPerDay} /> в день</span>
              : <span>{out === null ? "трат не было" : `до ${formatDay(out)}`}</span>}
        </> : <>
          <span><b><Money value={Math.max(0, metric.remainingMinor)} /></b> осталось</span>
          <span className={line.state === "out" ? "out" : undefined}>ушло <Money value={metric.actualMinor} /> из <Money value={metric.availableMinor} /></span>
        </>}
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
    const kindLabel = transactionLabels[transaction.kind];
    const title = category ? category.name : kindLabel;
    // «Доход · 1 июл. · Доход» — вид операции, названный дважды подряд, потому что у дохода без
    // категории названием строки становится он сам. Подпись повторяет название только тогда,
    // когда ей есть что добавить.
    const note = [formatDate(transaction.occurredOn)];
    if (category) note.push(kindLabel);
    if (showAuthor) note.push(transactionAuthorLabel(memberById, transaction.memberId));
    return <li className={`transaction-row ${transaction.kind}`} key={transaction.id}>
      <span className={`transaction-icon ${visual ? `tone-${visual.tone}` : "tone-neutral"}`}><Icon name={visual ? visual.icon : transactionIcons[transaction.kind]} size={24} /></span>
      <span className="transaction-copy">
        <strong>{title}</strong>
        <small>{note.join(" · ")}</small>
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

/**
 * «Ещё» — список: семья, план, данные, приложение.
 *
 * Экран не упразднён нарочно. Приложение офлайн-первое, сервер копией не является, и при утрате
 * всех устройств данные не восстановить, — поэтому «Сделать копию» обязано находиться с одного
 * взгляда, а не за дверью. Юридические абзацы при этом свёрнуты в строку факта: их читают один
 * раз, а копию делают каждый месяц.
 */
function MoreScreen(props: {
  budget: BudgetState;
  metrics: BudgetMetrics;
  storageHealth: StorageHealth | null;
  showIosInstall: boolean;
  lastSuccessfulBackup: string | null;
  onCreateBackup: () => Promise<{ readonly text: string; readonly createdAt: string }>;
  onRecordSuccessfulBackup: Parameters<typeof DataManagementScreen>[0]["onRecordSuccessfulBackup"];
  onRestoreBackup: Parameters<typeof DataManagementScreen>[0]["onRestoreBackup"];
  onPersistClear: () => Promise<void>;
  onPublishEmpty: () => void;
  onFamily: () => void;
  onPlanning: () => void;
  onHistory: () => void;
  onImportStatement: () => void;
  familyNote: string;
  monthNote: string;
  syncIndicator: { readonly text: string; readonly className: string; readonly ariaLabel: string };
}) {
  return <>
    <h1 className="visually-hidden">Ещё: семья, план и данные</h1>
    <section className="list-group" aria-labelledby="more-family-title">
      <h2 id="more-family-title" className="list-kicker">Семья</h2>
      <ul className="list-card">
        <li><button className="list-row" type="button" onClick={props.onFamily}><span className="list-icon"><Icon name="users" size={24} /></span><span className="list-copy"><strong>Семья и синхронизация</strong><small>{props.familyNote}</small><span className={props.syncIndicator.className} aria-label={props.syncIndicator.ariaLabel}>{props.syncIndicator.text}</span></span><Icon name="chevron-right" size={24} className="row-chevron" /></button></li>
      </ul>
    </section>

    <section className="list-group" aria-labelledby="more-plan-title">
      <h2 id="more-plan-title" className="list-kicker">План</h2>
      <ul className="list-card">
        {/* Строй месяца одной строкой: то, на чём стоят «Сегодня» и «Год», и дверь туда, где это правят. */}
        <li><button className="list-row" type="button" onClick={props.onPlanning}><span className="list-icon"><Icon name="calendar" size={24} /></span><span className="list-copy"><strong>Наш месяц</strong><small>{props.monthNote}</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></button></li>
      </ul>
    </section>

    {/* Записи: история с поиском — дверью, итоги — строкой факта. С экрана записи они уехали:
        он отвечает на «можем ли мы себе это позволить» до траты, а не на «что уже записано». */}
    <section className="list-group" aria-labelledby="more-records-title">
      <h2 id="more-records-title" className="list-kicker">Записи</h2>
      <ul className="list-card">
        <li><button className="list-row" type="button" onClick={props.onHistory}><span className="list-icon"><Icon name="history" size={24} /></span><span className="list-copy"><strong>Вся история</strong><small>{operationsCount(props.budget.transactions.length)} · поиск по категории, счёту и сумме</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></button></li>
        <li><TotalsFact budget={props.budget} metrics={props.metrics} /></li>
      </ul>
    </section>

    <DataManagementScreen
      budget={props.budget}
      lastSuccessfulBackup={props.lastSuccessfulBackup}
      showIosInstall={props.showIosInstall}
      onCreateBackup={props.onCreateBackup}
      onRecordSuccessfulBackup={props.onRecordSuccessfulBackup}
      onRestoreBackup={props.onRestoreBackup}
      onPersistClear={props.onPersistClear}
      onPublishEmpty={props.onPublishEmpty}
      onImportStatement={props.onImportStatement}
    />

    <section className="list-group" aria-labelledby="more-about-title">
      <h2 id="more-about-title" className="list-kicker">О приложении</h2>
      <ul className="list-card">
        <li><details className="list-fact">
          <summary><span className="list-icon"><Icon name="shield" size={24} /></span><span className="list-copy"><strong>Как хранятся данные</strong><small>На этом устройстве; в сеть — только после входа</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></summary>
          <p>Нет рекламы и аналитики. Семейная синхронизация необязательна: пока вы не вошли, приложение не обращается к сети и ничего не отправляет. Сервер семьи не хранит имена и не является резервной копией — при утрате всех устройств данные не восстановить, поэтому копию делайте сами.</p>
        </details></li>
        <li><div className="list-row static" role="status"><span className="list-icon"><Icon name="hard-drive" size={24} /></span><span className="list-copy"><strong>Локальное хранилище</strong><small>{storageText(props.storageHealth)}</small></span></div></li>
      </ul>
    </section>
  </>;
}
