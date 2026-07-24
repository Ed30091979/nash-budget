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
