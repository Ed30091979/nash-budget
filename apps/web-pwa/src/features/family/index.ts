export { FamilyScreen, type ActiveInvite, type FamilyActions, type FamilyScreenProps } from "./FamilyScreen";
export { FamilyHoldScreen } from "./FamilyHoldScreen";
/**
 * Наружу — то, чем пользуется приложение, и ничего больше.
 *
 * Отсюда торчали ещё пять функций (`createBudgetJournalWriter`, `startVisibilityAwarePolling`,
 * `transportWithTokenRefresh`, `budgetJournalDrafts`, `isSyncActive`) и типы, описывающие только
 * их. Ни одного обращения к ним снаружи фичи нет: свои же тесты берут их из соседних модулей
 * напрямую. Публичная поверхность, которой никто не пользуется, — это обещание совместимости,
 * которого никто не просил.
 */
export { useFamily, type BudgetJournalWrite, type FamilyController } from "./controller";
export * from "./model";
export {
  familyNewsLines,
  familyNewsSince,
  transactionIds,
  type OwnAuthor,
  type TransactionAuthor,
} from "./news";
export { resolveSyncServerUrl, type FamilyRole, type FamilySession } from "./session";
