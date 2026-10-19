import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  calculateAnnualPlan,
  calculateBudget,
  carryBudgetForward,
  findBudgetForMonth,
  monthAfterPeriod,
  type BudgetState,
} from "@family-budget/domain";
import {
  requestStorageHealth,
  type StorageHealth,
} from "@family-budget/storage";
import { Icon, IconSprite, type IconName } from "../components/Icon";
import { observeLayoutSpace } from "../layout-space";
import { UpdatePrompt } from "../components/UpdatePrompt";
import { downloadTextFile, prepareJsonDownload } from "../features/data-management";
import {
  documentHoldNotice,
  FamilyHoldScreen,
  holdWriteRefusal,
  familyDocumentNotice,
  FamilyScreen,
  MEMBER_FILTER_ALL,
  showsFamilyHoldScreen,
  familyNewsLines,
  familyNewsSince,
  filterTransactionsByMember,
  memberFilterOptions,
  membersById,
  resolveSyncServerUrl,
  syncAlarm,
  syncIndicatorPresentation,
  transactionIds,
  useFamily,
  type BudgetJournalWrite,
  type MemberFilter,
  type OwnAuthor,
} from "../features/family";
import { createImportMemory } from "../features/import";
import { type EditRequest } from "../features/operations";
import { Onboarding } from "../onboarding/Onboarding";
import { persistCompletedOnboarding } from "../onboarding/model";
import { buildDemoBudgetState } from "../onboarding/demo";
import { createBudgetBackup, prepareBudgetState } from "../backup";
import { monthNominative } from "../date-words";
import {
  localToday,
  paydayDays,
  periodClock,
} from "../reach";
import { createBudgetRepository } from "../storage-repository";
import { WRITE_REFUSAL_TEXT } from "../write-refusal";
import { createAppBudgetSaveCoordinator } from "./budget-store";
import { RouteView, type AppRouteContext, type Screen } from "./routes";

export type { Screen } from "./routes";

type LoadState = "loading" | "empty" | "ready" | "error";

export const DISCARD_DRAFT_CONFIRMATION = "Несохранённый черновик будет удалён. Перейти в другой раздел?";

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

/** Бюджета на устройстве нет — «Семье» нечего предупреждать о его замене. */
const NO_LOCAL_BUDGET = { transactions: [] } as const;

function SkipLink() {
  return <a className="skip-link" href={`#${MAIN_CONTENT_ID}`}>К основному содержимому</a>;
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
  const loadStateRef = useRef<LoadState>(loadState);
  loadStateRef.current = loadState;
  // «Семья» поверх экрана задержки: на нём нет навигации, а выйти из семьи или проверить вход надо.
  const [holdFamilyOpen, setHoldFamilyOpen] = useState(false);
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
  // Семья ли сейчас на устройстве — для приёма документа на экране ожидания (см. publishRemoteBudget).
  const inFamilyRef = useRef(false);

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
      // Обновляется тот бюджет, который экран показывает. Без бюджета приложение стоит на онбординге
      // — подменять его состоянием из журнала означало бы онбординг поверх готового бюджета, — или,
      // в семье, на экране ожидания (`FamilyHoldScreen`), и тогда пришедший документ семьи и есть
      // то, чего он ждал.
      if (budgetSave.locked) return;
      const waiting = budgetRef.current === null && loadStateRef.current === "empty" && inFamilyRef.current;
      if (budgetRef.current === null && !waiting) return;
      try {
        const next = prepareBudgetState(value);
        budgetRef.current = next;
        revisionRef.current = revision;
        setBudget(next);
        if (waiting) {
          setSeenTransactionIds(transactionIds(next));
          setLoadState("ready");
        }
      } catch {
        // Пришедшее состояние не собирается в показуемый бюджет — экран остаётся на прежнем.
      }
    },
  });
  journalWriteRef.current = family.writeBudget;
  inFamilyRef.current = family.inFamily;

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
  const familyNewsText = useMemo(
    () => familyNewsLines(familyNews, memberById, budget ?? {}),
    [familyNews, memberById, budget],
  );
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
    // Копия, которую эта версия не восстановит, последней успешной не становится, и человек узнаёт
    // об этом сразу.
    if (backup.restoreWarning !== null) {
      setMessage(`Резервная копия JSON скачана. ${backup.restoreWarning}`);
      return;
    }
    await recordBackup(backup.createdAt);
  };

  /** «Семья» — и в оболочке, и поверх экрана ожидания, где бюджета на устройстве может не быть. */
  const familyScreen = (onBack: () => void) => (
    <FamilyScreen
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
      localBudget={budget ?? NO_LOCAL_BUDGET}
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
      onBack={onBack}
    />
  );

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
  // Второе ревью, LOW-5 и MEDIUM-3: в семье без документа семьи — нет документа вовсе или на
  // устройстве всё ещё бюджет, который был до вступления, — на месте бюджета стоит экран ожидания,
  // а не онбординг и не прежний бюджет, выданный за семейный.
  if (showsFamilyHoldScreen(family.inFamily, loadState !== "empty", family.status)) {
    return (
      <AppFrame className="loading-route" hasUnsavedChanges={false} messageShown={false}>
        <IconSprite />
        <SkipLink />
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className={holdFamilyOpen ? "content" : "loading-state storage-error-state"}>
          {holdFamilyOpen
            ? familyScreen(() => setHoldFamilyOpen(false))
            : <FamilyHoldScreen
                notice={familyDocumentNotice(family.status?.hold ?? null)}
                hasLocalBudget={budget !== null}
                onBackup={createBackup}
                onFamily={() => setHoldFamilyOpen(true)}
              />}
        </main>
      </AppFrame>
    );
  }
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
  const hold = family.inFamily ? family.status?.hold ?? null : null;
  const holdNotice = documentHoldNotice(hold);
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

  const persistClear = async () => {
    await repository.clear();
    // Ключи памяти — названия продавцов из выписок семьи; они уходят вместе с бюджетом.
    await importMemory.clear().catch(() => undefined);
  };
  const publishEmpty = () => {
    budgetRef.current = null;
    revisionRef.current = null;
    setBudget(null);
    setSeenTransactionIds(null);
    setLastSuccessfulBackup(null);
    setLoadState("empty");
  };
  const routeContext: AppRouteContext = {
    budget, plan, metrics, clock, paydays, flexibleRows, safeToSpendMinor, flexibleSpentMinor, postedTransactions,
    recentTransactions, categoryById, memberById, memberOptions, memberFilter, setMemberFilter, monthToOpen,
    openingMonth, openMonth, familyNewsText, navigate, budgetSave, budgetRef, editRequest, setEditRequest,
    setOperationDraftDirty, setPlanningDraftDirty, setImportDraftDirty, storageHealth, isIos, isStandalone,
    lastSuccessfulBackup, recordBackup, setMessage, persistClear, publishEmpty, importMemory, family, familyScreen,
    syncIndicator,
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
          {/* Второе ревью: пока документ задержан, устройство только читает, и человек узнаёт об этом
              до того, как запись откажет, на любом экране, кроме «Семьи», где задержка названа сама. */}
          {hold !== null && holdNotice !== null && screen !== "family" ? (
            <section className="key-alarm family-hold-banner" role="alert" aria-labelledby="app-hold-title">
              <span className="key-alarm-mark"><Icon name="triangle-alert" size={24} /></span>
              <div>
                <h2 id="app-hold-title">{holdNotice.title}</h2>
                <p>{WRITE_REFUSAL_TEXT[holdWriteRefusal(hold)]}</p>
                <button className="primary-button" type="button" onClick={() => navigate("family")}>Подробнее</button>
              </div>
            </section>
          ) : null}
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
          <RouteView screen={screen} app={routeContext} />
        </div>
      </main>

      {message ? <aside className="message-toast" role="status"><p>{message}</p><button className="primary-button" type="button" onClick={() => setMessage(null)}>Закрыть</button></aside> : null}
    </AppFrame>
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
