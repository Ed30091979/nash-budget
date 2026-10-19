import type { ReactNode } from "react";
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
import { TodayScreen, type AnnualPlan, type BudgetMetrics, type CategoryRow } from "../features/today/TodayScreen";
import { plural } from "../plural";
import type { PeriodClock } from "../reach";
import type { AppBudgetSaveCoordinator } from "./budget-store";

export type Screen = "today" | "year" | "planning" | "operations" | "more" | "family" | "import" | "history";

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
  readonly navigate: (destination: Screen) => void;
  readonly budgetSave: AppBudgetSaveCoordinator;
  readonly budgetRef: { readonly current: BudgetState | null };
  readonly editRequest: EditRequest | null;
  readonly setEditRequest: (request: EditRequest | null) => void;
  readonly setOperationDraftDirty: (dirty: boolean) => void;
  readonly setPlanningDraftDirty: (dirty: boolean) => void;
  readonly setImportDraftDirty: (dirty: boolean) => void;
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

/** Экран маршрута. Плашки задержки и тревоги ключа стоят над ним и принадлежат оболочке. */
export function RouteView({ screen, app }: { readonly screen: Screen; readonly app: AppRouteContext }) {
  const {
    budget, plan, metrics, clock, paydays, flexibleRows, safeToSpendMinor, flexibleSpentMinor, postedTransactions,
    recentTransactions, categoryById, memberById, memberOptions, memberFilter, setMemberFilter, monthToOpen,
    openingMonth, openMonth, familyNewsText, navigate, budgetSave, budgetRef, editRequest, setEditRequest,
    setOperationDraftDirty, setPlanningDraftDirty, setImportDraftDirty, storageHealth, isIos, isStandalone,
    lastSuccessfulBackup, recordBackup, setMessage, persistClear, publishEmpty, importMemory, family, familyScreen,
    syncIndicator,
  } = app;
  return <>
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
            onPersistClear={persistClear}
            onPublishEmpty={publishEmpty}
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
          {screen === "family" ? familyScreen(() => navigate("more")) : null}
  </>;
}
