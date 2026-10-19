/// <reference types="node" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * What release 1.0.0 wrote to disk, frozen byte for byte.
 *
 * Every file under `frozen/1.0.0/` was produced once, by the 1.0.0 code itself, and is never
 * regenerated: a backup the family saved, the IndexedDB record the app keeps its budget in, and
 * the journal a device seeds a family with. A later version promises to open each of them without
 * a single edit, and a test can only hold it to that promise against bytes the later version did
 * not write. Regenerating a file "because the format changed" would turn the check into a
 * comparison of the new code with itself.
 *
 * So each file carries its SHA-256 here, and reading it verifies the pin. Changing a file means
 * changing its pin in the same commit, in plain sight.
 *
 * - `g-002.*` — canonical G-002 (`toDomainBudgetState(G002)`), members included.
 * - `planning-seed.*` — `makePlanningSeed()`, a state written before members existed.
 * - `*.backup.json` — `createBudgetBackup(state, …, { createdAt: "2026-10-18T09:00:00.000Z" })`.
 * - `*.indexeddb.json` — the raw `documents` record after `saveIfRevision(null, state)`.
 * - `g-002.journal-drafts.json` — `budgetJournalDrafts(null, G-002)`.
 * - `g-002.journal.jsonl` — those drafts stamped from device `0000000a-…-000000000001`, clock 0,
 *   opIds `00000000-0000-4000-8000-00000000000N`, one `encodeOperation` per line.
 */
export const FROZEN_1_0_0 = {
  g002Backup: {
    file: "g-002.backup.json",
    sha256: "520004e9bd097c02fd8f9e76aa9e1fd9995a1d038c066ae0f560ea6cb963da66",
  },
  planningSeedBackup: {
    file: "planning-seed.backup.json",
    sha256: "d4cd4add0dafb554d2466b939721e688a69e0b057207e59ad49e5549a1f754b5",
  },
  g002IndexedDb: {
    file: "g-002.indexeddb.json",
    sha256: "98e457551ab57d319ca299e09dc11a2c8c21e3a55f7cec5ba5c67d5a25f18326",
  },
  planningSeedIndexedDb: {
    file: "planning-seed.indexeddb.json",
    sha256: "7a2465457494214883f62d6b01fc7bdc046feb90b1cbf499bde536d9342c50e1",
  },
  g002JournalDrafts: {
    file: "g-002.journal-drafts.json",
    sha256: "2e3201e3c0e867ce03592851767af71f81504faf6ab740b4aa2edf03daaff46d",
  },
  g002Journal: {
    file: "g-002.journal.jsonl",
    sha256: "9ff8051141d90a0b6519ca3cb13faab09b5fda2c00c19df80489e843a5cb7231",
  },
} as const;

export type FrozenArtifact = keyof typeof FROZEN_1_0_0;

const FROZEN_DIRECTORY = new URL("../frozen/1.0.0/", import.meta.url);

/** Reads one frozen artifact as text and refuses it when its bytes no longer match the pin. */
export function readFrozenArtifact(name: FrozenArtifact): string {
  const artifact = FROZEN_1_0_0[name];
  const bytes = readFileSync(new URL(artifact.file, FROZEN_DIRECTORY));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) {
    throw new Error(`frozen artifact ${artifact.file} no longer matches its pinned SHA-256 (${digest})`);
  }
  return bytes.toString("utf8");
}
