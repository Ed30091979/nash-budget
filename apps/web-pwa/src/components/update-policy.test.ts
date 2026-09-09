import { describe, expect, it, vi } from "vitest";
import {
  MINIMUM_UPDATE_CHECK_INTERVAL_MS,
  createAutomaticUpdates,
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

/**
 * Молчаливое обновление в тихий момент.
 *
 * Дефект, который здесь закрыт: приложение с ярлыка на экране «Домой» не делает переходов, новый
 * работник вставал в ожидание и никогда не брал управление сам, а предложение обновиться нужно
 * было принять внутри той самой установки. Верные пользователи получали починки последними.
 */
class FakeTarget {
  readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const forType = this.listeners.get(type) ?? new Set<() => void>();
    forType.add(listener);
    this.listeners.set(type, forType);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  get attached(): number {
    return [...this.listeners.values()].reduce((total, forType) => total + forType.size, 0);
  }
}

function automaticUpdates(
  overrides: {
    hasUnsavedChanges?: () => boolean;
    isVisible?: () => boolean;
    now?: () => number;
  } = {},
) {
  const page = new FakeTarget();
  const frame = new FakeTarget();
  const apply = vi.fn();
  const update = vi.fn(() => Promise.resolve());
  const updates = createAutomaticUpdates({
    apply,
    hasUnsavedChanges: overrides.hasUnsavedChanges ?? (() => false),
    isVisible: overrides.isVisible ?? (() => true),
    now: overrides.now ?? (() => 0),
  });
  const stop = updates.watch({ page, frame });
  return { apply, frame, page, stop, update, updates };
}

describe("обновление без вопроса, когда терять нечего", () => {
  it("применяет новую версию сама при пустом черновике и нетронутом экране", () => {
    const { apply, updates } = automaticUpdates();

    expect(updates.updateWaiting()).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("не применяет её, пока в форме есть несохранённый ввод", () => {
    let unsaved = true;
    const { apply, updates } = automaticUpdates({ hasUnsavedChanges: () => unsaved });

    expect(updates.updateWaiting()).toBe(false);
    expect(apply).not.toHaveBeenCalled();

    // Черновик очищен, но человек в этот момент работает: молчаливое применение перестроило бы
    // экран под руками. Оно дождётся следующего возвращения из фона.
    unsaved = false;
    expect(apply).not.toHaveBeenCalled();
  });

  it("не перезапускает приложение под руками: после первого касания — только по кнопке", () => {
    const { apply, page, updates } = automaticUpdates();

    page.emit("pointerdown");
    expect(updates.updateWaiting()).toBe(false);
    expect(apply).not.toHaveBeenCalled();

    page.emit("keydown");
    expect(apply).not.toHaveBeenCalled();
  });

  it("применяет отложенную версию, когда человек вернулся из фона", () => {
    const { apply, page, updates } = automaticUpdates();

    page.emit("keydown");
    expect(updates.updateWaiting()).toBe(false);

    page.emit("visibilitychange");

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("держит вопрос там, где есть что терять, даже при возвращении из фона", () => {
    const { apply, page, updates } = automaticUpdates({ hasUnsavedChanges: () => true });

    updates.updateWaiting();
    page.emit("pointerdown");
    page.emit("visibilitychange");
    page.emit("pageshow");

    expect(apply).not.toHaveBeenCalled();
  });

  it("применяет версию один раз, а после неудачи возвращается к вопросу", () => {
    const { apply, page, updates } = automaticUpdates();

    expect(updates.updateWaiting()).toBe(true);
    page.emit("visibilitychange");
    expect(apply).toHaveBeenCalledTimes(1);

    updates.applyFailed();
    page.emit("visibilitychange");

    expect(apply).toHaveBeenCalledTimes(2);
  });
});

describe("проверка обновления при запуске и при возвращении из фона", () => {
  it("спрашивает регистрацию при запуске и на каждом возвращении из фона", () => {
    let clock = 0;
    const registration = { update: vi.fn(() => Promise.resolve()) };
    const { frame, page, updates } = automaticUpdates({ now: () => clock });

    // Запуск: регистрация только появилась — и её сразу спрашивают о новой версии.
    updates.track(registration);
    expect(registration.update).toHaveBeenCalledTimes(1);

    // Свёрнутое приложение iOS не перезагружает: без этого обращения новый `sw.js` не запрашивается
    // неделями, потому что ни одного перехода не происходит.
    clock += MINIMUM_UPDATE_CHECK_INTERVAL_MS;
    page.emit("visibilitychange");
    expect(registration.update).toHaveBeenCalledTimes(2);

    // Страница, восстановленная из кеша переходов, приходит `pageshow` и вовсе без перехода.
    clock += MINIMUM_UPDATE_CHECK_INTERVAL_MS;
    frame.emit("pageshow");
    expect(registration.update).toHaveBeenCalledTimes(3);
  });

  it("не спрашивает чаще раза в полминуты и не спрашивает, пока приложение скрыто", () => {
    let clock = 0;
    let visible = true;
    const registration = { update: vi.fn(() => Promise.resolve()) };
    const { frame, page, updates } = automaticUpdates({
      isVisible: () => visible,
      now: () => clock,
    });

    updates.track(registration);
    expect(registration.update).toHaveBeenCalledTimes(1);

    clock += MINIMUM_UPDATE_CHECK_INTERVAL_MS - 1;
    page.emit("visibilitychange");
    frame.emit("pageshow");
    expect(registration.update).toHaveBeenCalledTimes(1);

    // Уход в фон — это тот же `visibilitychange`, и спрашивать в нём не о чем.
    visible = false;
    clock += MINIMUM_UPDATE_CHECK_INTERVAL_MS;
    page.emit("visibilitychange");
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("молчит, когда сети нет: отказ проверки — не событие приложения", async () => {
    const registration = {
      update: vi.fn(() => Promise.reject(new Error("Failed to fetch"))),
    };
    const { updates } = automaticUpdates();

    expect(() => updates.track(registration)).not.toThrow();
    await Promise.resolve();
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("снимает все подписки, когда рама размонтирована", () => {
    const { frame, page, stop } = automaticUpdates();

    expect(page.attached + frame.attached).toBe(4);
    stop();
    expect(page.attached + frame.attached).toBe(0);
  });
});
