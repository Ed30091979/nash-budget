import { describe, expect, it } from "vitest";

import { G002, toDomainBudgetState } from "../src/index.js";
import { FROZEN_1_0_0, readFrozenArtifact, type FrozenArtifact } from "../src/frozen.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("frozen 1.0.0 artifacts", () => {
  it("still match the bytes 1.0.0 wrote", () => {
    for (const name of Object.keys(FROZEN_1_0_0) as FrozenArtifact[]) {
      expect(() => readFrozenArtifact(name), name).not.toThrow();
    }
  });

  it("are the envelope 1.0.0 wrote: format 2, payload schema 1, a SHA-256 of the payload", () => {
    for (const name of ["g002Backup", "planningSeedBackup"] as const) {
      const envelope = JSON.parse(readFrozenArtifact(name)) as Record<string, unknown>;
      expect(Object.keys(envelope)).toEqual([
        "app",
        "appVersion",
        "formatVersion",
        "schemaVersion",
        "createdAt",
        "integrity",
        "payload",
      ]);
      expect(envelope).toMatchObject({
        app: "family-budget",
        appVersion: "0.1.0",
        formatVersion: 2,
        schemaVersion: 1,
        createdAt: "2026-10-18T09:00:00.000Z",
        integrity: { algorithm: "sha256" },
      });
    }
  });

  it("are the IndexedDB record 1.0.0 wrote: document schema 2 and a v4 revision", () => {
    for (const name of ["g002IndexedDb", "planningSeedIndexedDb"] as const) {
      const record = JSON.parse(readFrozenArtifact(name)) as Record<string, unknown>;
      expect(Object.keys(record)).toEqual(["key", "schemaVersion", "updatedAt", "revision", "value"]);
      expect(record.key).toBe("active-budget");
      expect(record.schemaVersion).toBe(2);
      expect(record.revision).toMatch(UUID_V4);
    }
  });

  it("carry canonical G-002 exactly, members and the unlabelled expense included", () => {
    const backup = JSON.parse(readFrozenArtifact("g002Backup")) as { payload: unknown };
    const record = JSON.parse(readFrozenArtifact("g002IndexedDb")) as { value: unknown };
    const state = toDomainBudgetState(G002);

    expect(backup.payload).toEqual(state);
    expect(record.value).toEqual(state);
    expect(JSON.stringify(backup.payload)).toBe(JSON.stringify(state));
    expect(JSON.stringify(record.value)).toBe(JSON.stringify(state));
  });

  it("hold one encoded operation per line, stamped one after another", () => {
    const lines = readFrozenArtifact("g002Journal").split("\n");
    const drafts = JSON.parse(readFrozenArtifact("g002JournalDrafts")) as readonly unknown[];

    expect(lines).toHaveLength(drafts.length);
    lines.forEach((line, index) => {
      const operation = JSON.parse(line) as { lamport: number; opId: string };
      expect(operation.lamport).toBe(index + 1);
      expect(operation.opId).toBe(`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    });
  });
});
