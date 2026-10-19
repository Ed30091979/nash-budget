import { useEffect, useState, type ReactNode } from "react";
import type { BudgetState, CategoryType, Transaction } from "@family-budget/domain";
import type { StorageHealth } from "@family-budget/storage";
import { BackButton } from "../components/BackButton";
import { createBudgetBackup, describeBackupRepairs, restoreBudgetBackup, type BackupRepair } from "../backup";
import { downloadTextFile, prepareJsonDownload } from "../features/data-management";
import { CoachMark } from "../features/onboarding-questions/CoachMark";
import { HintCards } from "../features/onboarding-questions/HintCards";
import { coachCategoryId, coachDone, coachVisible, finishCoach } from "../features/onboarding-questions/hints-model";
import { firstRunStore, type HintId } from "../features/onboarding-questions/memory";
import { QuestionHost, useFirstRun } from "../features/onboarding-questions/QuestionHost";
import { nextQuestion } from "../features/onboarding-questions/questions-model";
import type { FamilyController } from "../features/family";
import type { ImportMemory } from "../features/import";
import { ImportScreen } from "../features/import";
import { sheetOpeningOf, type SheetOpening } from "../features/entry/sheet-address";
import { HistoryScreen, type HistoryMembers } from "../features/operations";
import { AddCategorySheet } from "../features/overview/AddCategorySheet";
import { currentMonth, defaultAccountOf } from "../features/overview/overview-model";
import { OverviewScreen } from "../features/overview/OverviewScreen";
import { PlanningScreen } from "../features/planning";
import { accountsNote, categoriesNote, debtsNote, goalsNote, MoreScreen, monthNote, recurringNote, tagsNote } from "../features/more/MoreScreen";
import { PlaceholderScreen } from "../features/placeholders/PlaceholderScreen";
import { TagsScreen } from "../features/tags/TagsScreen";
import { CategoriesScreen } from "../features/categories/CategoriesScreen";
import { CategoryScreen } from "../features/categories/CategoryScreen";
import { AccountScreen } from "../features/accounts/AccountScreen";
import { AccountsScreen } from "../features/accounts/AccountsScreen";
import { RatesScreen } from "../features/rates/RatesScreen";
import { ratesNote } from "../features/rates/rates-model";
import { YearScreen, type AnnualPlan } from "../features/plan-year/YearScreen";
import { ReportsScreen, type BudgetMetrics } from "../features/reports/ReportsScreen";
import type { Route } from "../navigation/routes";
import { plural } from "../plural";
import type { PeriodClock } from "../reach";
import type { BudgetWriter } from "../write/useBudgetWrite";

/**
 * Всё, что маршрутам нужно от оболочки: бюджет и его производные, единственный путь записи и
 * переход между экранами. Оболочка собирает это один раз на отрисовку; маршрут сам ничего не
 * хранит и в хранилище не ходит.
 */
export interface AppRouteContext {
  readonly budget: BudgetState;
  /** День семьи по её календарю (`localToday`): один на все экраны и на лист ввода. */
  readonly today: string;
  readonly plan: AnnualPlan;
  readonly metrics: BudgetMetrics;
  readonly clock: PeriodClock;
  readonly paydays: readonly number[];
  readonly categoryById: Map<string, BudgetState["categories"][number]>;
  /** «Кто записал» в «Операциях»: участники семьи и выбранный фильтр (память сессии). */
  readonly members: HistoryMembers;
  readonly monthToOpen: string | null;
  readonly openingMonth: boolean;
  readonly openMonth: (month: string) => Promise<void>;
  readonly familyNewsText: readonly string[];
  /** Переход по правилам истории (§2.1): вкладка, подэкран, запись. Черновик спрашивается. */
  readonly navigate: (route: Route) => void;
  /** Кнопка «назад» экрана: к родителю маршрута. */
  readonly back: () => void;
  /** Тот же экран в другом виде (список расходов или доходов): запись истории заменяется, а не копится. */
  readonly replace: (route: Route) => void;
  /** Лист ввода поверх экрана, на котором стоишь: с плиток, с «+», из «Операций» (`sheet-address.ts`). */
  readonly openSheet: (opening: SheetOpening) => void;
  readonly openEdit: (transaction: Transaction) => void;
  /** Единственный путь записи (§2.3): координатор, отказы и неудачи, которых некому показать. */
  readonly write: BudgetWriter;
  readonly budgetRef: { readonly current: BudgetState | null };
  readonly storageHealth: StorageHealth | null;
  readonly isIos: boolean;
  readonly isStandalone: boolean;
  readonly lastSuccessfulBackup: string | null;
  readonly recordBackup: (createdAt: string) => Promise<void>;
  readonly setMessage: (message: string | null) => void;
  readonly persistClear: () => Promise<void>;
  readonly publishEmpty: () => void;
  readonly importMemory: ImportMemory;
  readonly family: FamilyController;
  readonly familyScreen: (onBack: () => void) => ReactNode;
  readonly syncIndicator: { readonly text: string; readonly className: string; readonly ariaLabel: string };
}

/** Кнопка «назад» подэкрана «Ещё»: в iOS-standalone другой нет. */
function MoreBackButton({ onBack }: { readonly onBack: () => void }) {
  return <div className="planning-toolbar"><BackButton label="К разделу «Ещё»" onClick={onBack} /></div>;
}

/**
 * «Обзор»: месяц из адреса (без него — текущий), плитки и «+» в рядах. «+» в ряду открывает лист
 * «Своя категория» прямо над плитками; тёзка, которая уже есть, открывает лист ввода в неё.
 */
function OverviewRoute({ app, month, sheetOpen }: { readonly app: AppRouteContext; readonly month: string | undefined; readonly sheetOpen: boolean }) {
  const { budget, today, plan, clock, monthToOpen, openingMonth, openMonth, familyNewsText, navigate, openSheet, write, setMessage } = app;
  const [adding, setAdding] = useState<CategoryType | null>(null);
  const thisMonth = currentMonth(today);
  // Первый запуск (R2, DIRECTION §e): вопросы листами, подсказка на первую трату и карточки в конце.
  // Ждут, пока поверх «Обзора» лист, показан другой месяц или документ семьи задержан (только чтение).
  const firstRun = useFirstRun();
  const held = app.family.inFamily && (app.family.status?.hold ?? null) !== null;
  const blocked = adding !== null || sheetOpen || (month ?? thisMonth) !== thisMonth || held;
  const questionPending = firstRun !== null && nextQuestion(firstRun, today) !== null;
  const coachTarget = coachCategoryId(budget);
  const showCoach = !blocked && coachTarget !== null && coachVisible(firstRun, budget, questionPending);
  // Первая запись — любой: с плитки, с «+», из выписки — снимает подсказку навсегда.
  useEffect(() => {
    if (coachDone(firstRun, budget)) void firstRunStore().update(finishCoach);
  }, [firstRun, budget]);
  const hintAction = async (id: HintId) => {
    switch (id) {
      case "opening-balance": {
        const account = defaultAccountOf(budget);
        navigate(account === null ? { name: "accounts" } : { name: "account", id: account.id });
        return;
      }
      case "backup":
        try {
          const backup = await createBudgetBackup(app.budgetRef.current ?? budget, async () => undefined);
          await downloadTextFile(prepareJsonDownload(backup.text));
          if (backup.restoreWarning !== null) {
            setMessage(`Резервная копия JSON скачана. ${backup.restoreWarning}`);
            return;
          }
          await app.recordBackup(backup.createdAt);
          setMessage("Резервная копия JSON скачана.");
        } catch {
          setMessage("Не удалось сделать копию. Попробуйте ещё раз в «Ещё» → «Данные».");
        }
        return;
      case "import":
        navigate({ name: "import" });
        return;
      case "goal":
        navigate({ name: "goals" });
        return;
      case "family":
        navigate({ name: "family" });
        return;
    }
  };
  const choose = (type: CategoryType, categoryId: string) => {
    setAdding(null);
    if (type === "expense") {
      openSheet(sheetOpeningOf({ kind: "expense", accountId: null, categoryId }));
      return;
    }
    const account = defaultAccountOf(budget);
    if (account !== null) openSheet(sheetOpeningOf({ kind: "income", categoryId, accountId: account.id }));
  };
  return <>
    <OverviewScreen
      budget={budget}
      today={today}
      month={month ?? thisMonth}
      // Текущий месяц — сам «Обзор», без ключа: «Назад» с другого месяца возвращает к нему.
      onMonth={(next) => navigate(next === thisMonth ? { name: "overview" } : { name: "overview", month: next })}
      clock={clock}
      flexiblePlanMinor={plan.currentMonth.flexiblePlanMinor}
      familyNews={familyNewsText}
      monthToOpen={monthToOpen}
      openingMonth={openingMonth}
      onOpenMonth={(month) => void openMonth(month)}
      onOpenSheet={(request) => openSheet(sheetOpeningOf(request))}
      onAddCategory={setAdding}
      onPlan={() => navigate({ name: "plan-month" })}
      onEdit={(row) => navigate(row === "accounts" ? { name: "accounts" } : { name: "categories", type: row === "incomes" ? "income" : "expense" })}
      coach={showCoach ? <CoachMark target={`category:${coachTarget}`} onDismiss={() => void firstRunStore().update(finishCoach)} /> : null}
      hints={<HintCards budget={budget} today={today} lastSuccessfulBackup={app.lastSuccessfulBackup} inFamily={app.family.inFamily} onAction={hintAction} />}
    />
    <QuestionHost budget={budget} today={today} write={write} blocked={blocked} onAddAccount={() => navigate({ name: "account-new", type: "savings" })} />
    {adding !== null ? (
      <AddCategorySheet
        budget={budget}
        type={adding}
        onChange={(change) => write.run(change)}
        onDone={(_categoryId, name) => {
          setAdding(null);
          setMessage(adding === "expense" ? `Категория «${name}» добавлена.` : `Источник дохода «${name}» добавлен.`);
        }}
        onChoose={(categoryId) => choose(adding, categoryId)}
        onClose={() => setAdding(null)}
      />
    ) : null}
  </>;
}

/**
 * Экран маршрута. Плашки задержки и тревоги ключа стоят над ним и принадлежат оболочке, лист ввода
 * — поверх него (`EntrySheetHost` в оболочке).
 *
 * Раскладка 2b (план волны 2, §4): «Обзор» — месяц и плитки, «Операции» — прежняя «Вся история»
 * до подволны 2d, «+» — лист ввода поверх вкладки, «Отчёты» — итоги и расходы по категориям,
 * «Ещё» — прежний список с планом месяца и планом на год.
 */
export function RouteView({ route, app }: { readonly route: Route; readonly app: AppRouteContext }) {
  const {
    budget, plan, metrics, paydays, categoryById, members, navigate, back, openSheet, openEdit, write, budgetRef, storageHealth, isIos,
    isStandalone, lastSuccessfulBackup, recordBackup, setMessage, persistClear, publishEmpty, importMemory, family,
    familyScreen, syncIndicator,
  } = app;
  return <>
          {route.name === "overview" ? <OverviewRoute app={app} month={route.month} sheetOpen={route.sheet !== undefined} /> : null}
          {/* «Операции» — вкладка: строка открывает операцию в листе ввода, и адрес это называет. */}
          {route.name === "operations" ? <HistoryScreen budget={budget} members={members} onEdit={openEdit} onAdd={() => openSheet({})} /> : null}
          {route.name === "reports" ? <ReportsScreen budget={budget} metrics={metrics} /> : null}
          {route.name === "more" ? <MoreScreen
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
              const repairs: BackupRepair[] = [];
              await restoreBudgetBackup(
                file,
                (restored) => write.run(() => restored).then(() => undefined),
                () => undefined,
                (repair) => { repairs.push(repair); },
              );
              // Каждый вид ремонта называется своими словами: снятая метка — не снятый участник.
              const notice = describeBackupRepairs(repairs);
              if (notice !== null) setMessage(notice);
            }}
            onPersistClear={async () => {
              await persistClear();
              // Память первого запуска — тоже данные этого устройства: уходит вместе с бюджетом.
              await firstRunStore().clear();
            }}
            onPublishEmpty={publishEmpty}
            onFamily={() => navigate({ name: "family" })}
            onPlanMonth={() => navigate({ name: "plan-month" })}
            onPlanYear={() => navigate({ name: "plan-year" })}
            onImportStatement={() => navigate({ name: "import" })}
            onAccounts={() => navigate({ name: "accounts" })}
            accountsNote={accountsNote(budget)}
            onCategories={() => navigate({ name: "categories", type: "expense" })}
            categoriesNote={categoriesNote(budget)}
            onTags={() => navigate({ name: "tags" })}
            tagsNote={tagsNote(budget)}
            onDebts={() => navigate({ name: "debts" })}
            debtsNote={debtsNote(budget)}
            onGoals={() => navigate({ name: "goals" })}
            goalsNote={goalsNote(budget)}
            onRecurring={() => navigate({ name: "recurring" })}
            recurringNote={recurringNote(budget)}
            onRates={() => navigate({ name: "rates" })}
            ratesNote={ratesNote(budget, app.today)}
            familyNote={family.membership === null
              ? "Без входа приложение работает как сейчас"
              : `${plural(Math.max(1, family.members.length), ["участник", "участника", "участников"])} · приглашение, отпечатки ключей`}
            monthNote={monthNote(budget, paydays)}
            syncIndicator={syncIndicator}
          /> : null}
          {route.name === "plan-month" ? <><MoreBackButton onBack={back} /><PlanningScreen budget={budget} onChange={(change) => write.run(change)} /></> : null}
          {route.name === "plan-year" ? <><MoreBackButton onBack={back} /><YearScreen budget={budget} plan={plan} paydays={paydays} onPlanning={() => navigate({ name: "plan-month" })} categoryById={categoryById} /></> : null}
          {route.name === "import" ? <ImportScreen budget={budget} memory={importMemory} onChange={(change) => write.run(change)} onBack={back} /> : null}
          {route.name === "family" ? familyScreen(back) : null}
          {/* Справочники «Учёта» (подволна 2c). Запись — по UUID из адреса; имени в адресе нет. */}
          {route.name === "accounts" ? <AccountsScreen budget={budget} today={app.today} write={write} onBack={back} onOpen={(id) => navigate({ name: "account", id })} onCreate={() => navigate({ name: "account-new" })} /> : null}
          {route.name === "categories" ? (
            <CategoriesScreen
              budget={budget}
              type={route.type ?? "expense"}
              write={write}
              onBack={back}
              // Вид списка — тот же экран: смена вида заменяет запись истории, а не копит их.
              onType={(type) => app.replace({ name: "categories", type })}
              onOpen={(id) => navigate({ name: "category", id, type: route.type ?? "expense" })}
              onMessage={setMessage}
            />
          ) : null}
          {route.name === "category" ? (
            <CategoryScreen
              key={route.id}
              budget={budget}
              categoryId={route.id}
              write={write}
              // К своему списку — родителю маршрута: вид списка записан в адресе категории, и
              // запись истории под формой — этот список (ревью 2c, MEDIUM-1).
              onBack={back}
              onDone={(message) => { setMessage(message); back(); }}
            />
          ) : null}
          {route.name === "tags" ? <TagsScreen budget={budget} write={write} onBack={back} /> : null}
          {/* Заглушки до подволны 2e: пустое состояние той же анатомии, что у меток (R2). */}
          {route.name === "debts" || route.name === "goals" || route.name === "recurring" ? <PlaceholderScreen budget={budget} kind={route.name} onBack={back} /> : null}
          {route.name === "rates" ? <RatesScreen budget={budget} today={app.today} write={write} onBack={back} /> : null}
          {route.name === "account" || route.name === "account-new" ? (
            <AccountScreen
              key={route.name === "account" ? route.id : "new"}
              budget={budget}
              today={app.today}
              accountId={route.name === "account" ? route.id : null}
              {...(route.name === "account-new" && route.type !== undefined ? { initialType: route.type } : {})}
              write={write}
              onBack={back}
              // Форма с видом из адреса открыта вопросом первого запуска «Есть ещё места…» с «Обзора»:
              // заведённый счёт возвращает туда, где ждёт следующий вопрос (роутер вернётся по истории).
              onDone={(message) => { setMessage(message); if (route.name === "account-new" && route.type !== undefined) navigate({ name: "overview" }); else back(); }}
            />
          ) : null}
  </>;
}
