import { describe, expect, it, vi } from "vitest";
import {
  createUpdatePromptActions,
  createUpdateRequestGate,
  type UpdatePhase,
} from "./update-policy";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("controlled PWA update policy", () => {
  it("calls the prompt-mode updater with reload enabled only after the explicit update action", async () => {
    const updateServiceWorker = vi.fn(async (_reloadPage: true) => undefined);
    const phases: UpdatePhase[] = [];
    const requestUpdate = createUpdateRequestGate(updateServiceWorker, (phase) => phases.push(phase));
    const actions = createUpdatePromptActions({
      clearNeedRefresh: vi.fn(),
      clearOfflineReady: vi.fn(),
      clearRegistrationError: vi.fn(),
      requestUpdate,
    });

    expect(updateServiceWorker).not.toHaveBeenCalled();
    await actions.update();

    expect(updateServiceWorker).toHaveBeenCalledTimes(1);
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
    expect(phases).toEqual(["updating", "reloading"]);
  });

  it("coalesces rapid update clicks into one service-worker request", async () => {
    const pending = deferred();
    const updateServiceWorker = vi.fn(() => pending.promise);
    const phases: UpdatePhase[] = [];
    const requestUpdate = createUpdateRequestGate(updateServiceWorker, (phase) => phases.push(phase));

    const first = requestUpdate();
    const second = requestUpdate();
    const third = requestUpdate();

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(updateServiceWorker).not.toHaveBeenCalled();
    pending.resolve();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      "reloading",
      "reloading",
      "reloading",
    ]);
    expect(updateServiceWorker).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(["updating", "reloading"]);
  });

  it("returns a safe failed state without exposing the updater error and permits a retry", async () => {
    const updateServiceWorker = vi
      .fn<(reloadPage: true) => Promise<void>>()
      .mockRejectedValueOnce(new Error("private registration and device details"))
      .mockResolvedValueOnce(undefined);
    const phases: UpdatePhase[] = [];
    const requestUpdate = createUpdateRequestGate(updateServiceWorker, (phase) => phases.push(phase));

    await expect(requestUpdate()).resolves.toBe("failed");
    await expect(requestUpdate()).resolves.toBe("reloading");

    expect(updateServiceWorker).toHaveBeenCalledTimes(2);
    expect(phases).toEqual(["updating", "failed", "updating", "reloading"]);
    expect(JSON.stringify(phases)).not.toContain("private registration");
  });

  it("Later only dismisses the prompt and preserves unsaved form state", () => {
    const unsavedForm = {
      amount: "15750",
      category: "Обучение детей",
      note: "Не сохранено",
    };
    const snapshot = structuredClone(unsavedForm);
    const clearNeedRefresh = vi.fn();
    const updateServiceWorker = vi.fn(async (_reloadPage: true) => undefined);
    const actions = createUpdatePromptActions({
      clearNeedRefresh,
      clearOfflineReady: vi.fn(),
      clearRegistrationError: vi.fn(),
      requestUpdate: createUpdateRequestGate(updateServiceWorker, vi.fn()),
    });

    actions.later();

    expect(clearNeedRefresh).toHaveBeenCalledTimes(1);
    expect(updateServiceWorker).not.toHaveBeenCalled();
    expect(unsavedForm).toEqual(snapshot);
  });
});
