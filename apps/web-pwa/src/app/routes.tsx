import { useMemo, type ReactNode } from "react";
import type { BudgetState, Member, Transaction } from "@family-budget/domain";
import type { StorageHealth } from "@family-budget/storage";
import { BackButton } from "../components/BackButton";
import { createBudgetBackup, describeBackupRepairs, restoreBudgetBackup, type BackupRepair } from "../backup";
import type { FamilyController, MemberFilter } from "../features/family";
import type { ImportMemory } from "../features/import";
import { ImportScreen } from "../features/import";
import { HistoryScreen, OperationsScreen, type EditRequest } from "../features/operations";
import { PlanningScreen } from "../features/planning";
import { MoreScreen, monthNote } from "../features/more/MoreScreen";
import { YearScreen } from "../features/plan-year/YearScreen";
import { ReportsScreen } from "../features/reports/ReportsScreen";
import { TodayScreen, type AnnualPlan, type BudgetMetrics, type CategoryRow } from "../features/today/TodayScreen";
import type { NavigateOptions } from "../navigation/router";
import type { Route } from "../navigation/routes";
import { plural } from "../plural";
import type { PeriodClock } from "../reach";
import type { AppBudgetSaveCoordinator } from "./budget-store";

/**
 * Всё, что маршрутам нужно от оболочки: бюджет и его производные, единственный путь записи и
 * переход между экранами. Оболочка собирает это один раз на отрисовку; маршрут сам ничего не
 * хранит и в хранилище не ходит.
 */
export interface AppRouteContext {
  readonly budget: BudgetState;
  readonly plan: AnnualPlan;
  readonly metrics: BudgetMetrics;
  readonly clock: PeriodClock;
  readonly paydays: readonly number[];
  readonly flexibleRows: CategoryRow[];
  readonly safeToSpendMinor: number;
  readonly flexibleSpentMinor: number;
  readonly postedTransactions: readonly Transaction[];
  readonly recentTransactions: Transaction[];
  readonly categoryById: Map<string, BudgetState["categories"][number]>;
  readonly memberById: ReadonlyMap<string, Member>;
  readonly memberOptions: readonly { readonly value: MemberFilter; readonly label: string }[];
  readonly memberFilter: MemberFilter;
  readonly setMemberFilter: (value: MemberFilter) => void;
  readonly monthToOpen: string | null;
  readonly openingMonth: boolean;
  readonly openMonth: (month: string) => Promise<void>;
  readonly familyNewsText: readonly string[];
  /** Переход по правилам истории (§2.1): вкладка, подэкран, запись. Черновик спрашивается. */
  readonly navigate: (route: Route) => void;
  /** Кнопка «назад» экрана: к родителю маршрута. */
  readonly back: () => void;
  /** Переход без вопроса о черновике — адрес догоняет то, что уже случилось на экране. */
  readonly redirect: (route: Route, options?: NavigateOptions) => void;
  readonly budgetSave: AppBudgetSaveCoordinator;
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
 * Экран маршрута. Плашки задержки и тревоги ключа стоят над ним и принадлежат оболочке.
 *
 * Временная раскладка 2a (план волны 2, §4): «Обзор» — прежний «Сегодня», «Операции» — прежняя
 * «Вся история», «+» — прежний экран записи, «Отчёты» — итоги и расходы по категориям, «Ещё» —
 * прежний список с планом месяца и планом на год.
 */
export function RouteView({ route, app }: { readonly route: Route; readonly app: AppRouteContext }) {
  const {
    budget, plan, metrics, clock, paydays, flexibleRows, safeToSpendMinor, flexibleSpentMinor, postedTransactions,
    recentTransactions, categoryById, memberById, memberOptions, memberFilter, setMemberFilter, monthToOpen,
    openingMonth, openMonth, familyNewsText, navigate, back, redirect, budgetSave, budgetRef, storageHealth, isIos,
    isStandalone, lastSuccessfulBackup, recordBackup, setMessage, persistClear, publishEmpty, importMemory, family,
    familyScreen, syncIndicator,
  } = app;
  // Правка операции живёт в адресе (`#/new?edit=<id>`): просьба экрану записи — одна на адрес.
  const editId = route.name === "entry" ? route.edit ?? null : null;
  const editRequest = useMemo<EditRequest | null>(() => editId === null ? null : { id: editId, nonce: 0 }, [editId]);
  return <>
          {route.name === "overview" ? <TodayScreen budget={budget} plan={plan} flexibleRows={flexibleRows} safeToSpendMinor={safeToSpendMinor} flexibleSpentMinor={flexibleSpentMinor} clock={clock} recentTransactions={recentTransactions} categoryById={categoryById} memberById={memberById} memberOptions={memberOptions} memberFilter={memberFilter} onMemberFilterChange={setMemberFilter} hasRecords={postedTransactions.length > 0} monthToOpen={monthToOpen} openingMonth={openingMonth} onOpenMonth={(month) => void openMonth(month)} onAdd={() => navigate({ name: "entry" })} onYear={() => navigate({ name: "plan-year" })} onPlanning={() => navigate({ name: "plan-month" })} onImport={() => navigate({ name: "import" })} familyNews={familyNewsText} /> : null}
          {/* «Операции» — вкладка: строка открывает операцию в форме записи, и адрес это называет. */}
          {route.name === "operations" ? <HistoryScreen budget={budget} onEdit={(transaction) => navigate({ name: "entry", edit: transaction.id })} onAdd={() => navigate({ name: "entry" })} /> : null}
          {route.name === "entry" ? <OperationsScreen budget={budget} clock={clock} onChange={(change) => budgetSave.apply(change)} onPlanning={() => navigate({ name: "plan-month" })} editRequest={editRequest} onEditFinished={() => redirect({ name: "entry" }, { replace: true })} /> : null}
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
                (restored) => budgetSave.apply(() => restored).then(() => undefined),
                () => undefined,
                (repair) => { repairs.push(repair); },
              );
              // Каждый вид ремонта называется своими словами: снятая метка — не снятый участник.
              const notice = describeBackupRepairs(repairs);
              if (notice !== null) setMessage(notice);
            }}
            onPersistClear={persistClear}
            onPublishEmpty={publishEmpty}
            onFamily={() => navigate({ name: "family" })}
            onPlanMonth={() => navigate({ name: "plan-month" })}
            onPlanYear={() => navigate({ name: "plan-year" })}
            onImportStatement={() => navigate({ name: "import" })}
            familyNote={family.membership === null
              ? "Без входа приложение работает как сейчас"
              : `${plural(Math.max(1, family.members.length), ["участник", "участника", "участников"])} · приглашение, отпечатки ключей`}
            monthNote={monthNote(budget, paydays)}
            syncIndicator={syncIndicator}
          /> : null}
          {route.name === "plan-month" ? <><MoreBackButton onBack={back} /><PlanningScreen budget={budget} onChange={(change) => budgetSave.apply(change)} /></> : null}
          {route.name === "plan-year" ? <><MoreBackButton onBack={back} /><YearScreen budget={budget} plan={plan} paydays={paydays} onPlanning={() => navigate({ name: "plan-month" })} categoryById={categoryById} /></> : null}
          {route.name === "import" ? <ImportScreen budget={budget} memory={importMemory} onChange={(change) => budgetSave.apply(change)} onBack={back} /> : null}
          {route.name === "family" ? familyScreen(back) : null}
  </>;
}
