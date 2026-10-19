import { readFileSync } from "node:fs";
import { serializeBackup } from "@family-budget/storage";
import { prepareBudgetState } from "../src/backup";

export const G002_BACKUP_CREATED_AT = "2026-07-17T14:16:06.000Z";

const canonicalFixture = JSON.parse(
  readFileSync(
    new URL("../../../contracts/fixtures/g-002.json", import.meta.url),
    "utf8",
  ),
) as { readonly fixtureId: string; readonly state: unknown };

if (canonicalFixture.fixtureId !== "G-002") {
  throw new Error("The canonical E2E fixture must be G-002.");
}

const canonicalState = prepareBudgetState(canonicalFixture.state);

export const G002_INITIAL_OPERATION_COUNT = canonicalState.transactions.length;

export function makeG002BackupBuffer(): Buffer {
  return Buffer.from(
    serializeBackup(canonicalState, { createdAt: G002_BACKUP_CREATED_AT }),
    "utf8",
  );
}

/**
 * G-002 whose operations carry identifiers in upper case — as a backup or a journal written by
 * another implementation may (both accept a UUID in either case). The app must open them by the
 * lower-case address and must not rewrite them (review of 2a, finding 4).
 */
export const G002_UPPER_CASE_IDS = canonicalState.transactions.map(
  (_transaction, index) => `7F1D2C3B-4A5E-4F60-8A7B-9C0D1E2F3A${String(index).padStart(2, "0")}`,
);

export function makeG002UpperCaseIdsBackupBuffer(): Buffer {
  const state = {
    ...canonicalState,
    transactions: canonicalState.transactions.map((transaction, index) => ({
      ...transaction,
      id: G002_UPPER_CASE_IDS[index] ?? transaction.id,
    })),
  };
  return Buffer.from(serializeBackup(state, { createdAt: G002_BACKUP_CREATED_AT }), "utf8");
}
