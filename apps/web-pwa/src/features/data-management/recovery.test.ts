import { describe, expect, it, vi } from "vitest";
import {
  createRecoveryActionGate,
  downloadThenRecordSuccessfulBackup,
  initialRecoveryState,
  persistThenPublishEmpty,
  recoveryReducer,
} from "./recovery";

describe("recovery state machine", () => {
  it("keeps clear confirmation and safe error after failed deletion", () => {
    const opened = recoveryReducer(initialRecoveryState, { type: "open-clear" });
    const clearing = recoveryReducer(opened, { type: "start", activity: "clear" });
    const failed = recoveryReducer(clearing, { type: "fail", message: "Текущий бюджет сохранён." });

    expect(failed).toEqual({
      activity: "idle",
      clearConfirmationOpen: true,
      message: null,
      error: "Текущий бюджет сохранён.",
    });
  });

  it("publishes empty state only after persisted clear succeeds", async () => {
    const order: string[] = [];
    await persistThenPublishEmpty(
      async () => { order.push("persist"); },
      () => { order.push("publish"); },
    );
    expect(order).toEqual(["persist", "publish"]);

    const publish = vi.fn();
    await expect(persistThenPublishEmpty(
      async () => { throw new Error("private database failure"); },
      publish,
    )).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  it("closes the dialog only after success", () => {
    const opened = recoveryReducer(initialRecoveryState, { type: "open-clear" });
    const succeeded = recoveryReducer(
      recoveryReducer(opened, { type: "start", activity: "clear" }),
      { type: "succeed", message: "Локальные данные удалены." },
    );
    expect(succeeded.clearConfirmationOpen).toBe(false);
    expect(succeeded.message).toBe("Локальные данные удалены.");
  });
});

describe("successful backup orchestration", () => {
  const backup = { createdAt: "2026-07-24T09:10:11.000Z" };

  it("downloads before persisting the exact successful timestamp", async () => {
    const order: string[] = [];
    const record = vi.fn(async (createdAt: string) => {
      order.push(`record:${createdAt}`);
    });

    await expect(downloadThenRecordSuccessfulBackup(
      backup,
      () => { order.push("download"); },
      record,
    )).resolves.toBe(backup.createdAt);

    expect(order).toEqual(["download", `record:${backup.createdAt}`]);
    expect(record).toHaveBeenCalledWith(backup.createdAt);
  });

  it("does not record metadata when the browser download throws", async () => {
    const record = vi.fn(async () => undefined);

    await expect(downloadThenRecordSuccessfulBackup(
      backup,
      () => { throw new Error("object URL, append or click failed"); },
      record,
    )).rejects.toThrow();

    expect(record).not.toHaveBeenCalled();
  });

  it("does not report completion when metadata persistence fails", async () => {
    const download = vi.fn();

    await expect(downloadThenRecordSuccessfulBackup(
      backup,
      download,
      async () => { throw new Error("private database detail"); },
    )).rejects.toThrow();

    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe("synchronous recovery gate", () => {
  it("drops a double click before the first async action completes", async () => {
    const gate = createRecoveryActionGate();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const firstAction = vi.fn(async () => pending);
    const secondAction = vi.fn(async () => "unexpected");

    const first = gate.run(firstAction);
    const second = gate.run(secondAction);

    expect(gate.locked).toBe(true);
    expect(firstAction).toHaveBeenCalledTimes(1);
    expect(secondAction).not.toHaveBeenCalled();
    await expect(second).resolves.toBeUndefined();
    release();
    await first;
    expect(gate.locked).toBe(false);
  });
});
