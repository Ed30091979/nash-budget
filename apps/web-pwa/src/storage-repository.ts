import { type BudgetState } from "@family-budget/domain";
import {
  IndexedDbBudgetRepository,
  type RepositoryOptions,
} from "@family-budget/storage";
import { prepareBudgetState } from "./backup";

export type BudgetRepositoryOptions = Pick<RepositoryOptions<BudgetState>, "databaseName">;

/** The production repository always validates and normalizes v1 values inside versionchange. */
export function createBudgetRepository(
  options: BudgetRepositoryOptions = {},
): IndexedDbBudgetRepository<BudgetState> {
  return new IndexedDbBudgetRepository<BudgetState>({
    ...options,
    migrateV1Value: (value) => prepareBudgetState(value),
  });
}
