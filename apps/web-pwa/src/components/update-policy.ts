export type UpdatePhase = "idle" | "updating" | "reloading" | "failed";
export type UpdateAttempt = "reloading" | "failed";

type UpdateServiceWorker = (reloadPage: true) => Promise<void>;

export function createUpdateRequestGate(
  updateServiceWorker: UpdateServiceWorker,
  onPhaseChange: (phase: UpdatePhase) => void,
): () => Promise<UpdateAttempt> {
  let inFlight: Promise<UpdateAttempt> | null = null;

  return () => {
    if (inFlight) {
      return inFlight;
    }

    onPhaseChange("updating");
    const attempt = Promise.resolve()
      .then(() => updateServiceWorker(true))
      .then(() => {
        onPhaseChange("reloading");
        return "reloading" as const;
      })
      .catch(() => {
        onPhaseChange("failed");
        return "failed" as const;
      })
      .finally(() => {
        inFlight = null;
      });

    inFlight = attempt;
    return attempt;
  };
}

interface UpdatePromptActionOptions {
  clearNeedRefresh: () => void;
  clearOfflineReady: () => void;
  clearRegistrationError: () => void;
  requestUpdate: () => Promise<UpdateAttempt>;
}

export function createUpdatePromptActions(options: UpdatePromptActionOptions) {
  return {
    update: options.requestUpdate,
    later: options.clearNeedRefresh,
    dismissOfflineReady: options.clearOfflineReady,
    dismissRegistrationError: options.clearRegistrationError,
  };
}

/**
 * Тихий момент — и почему обновление ждёт именно его.
 *
 * Новая версия приезжает не тогда, когда её собрали, а тогда, когда её применили. Установленное
 * на экран «Домой» приложение не делает переходов: iOS не перезагружает страницу при возврате из
 * фона, поэтому браузер не спрашивает про новый `sw.js` неделями, а спросив — оставляет нового
 * работника ждать (`skipWaiting: false`), и обмен происходит только по нажатию. Так починки
 * последними получали те, кто поставил ярлык.
 *
 * Отсюда две обязанности, и обе — здесь. Первая: **спрашивать про обновление самим** — при
 * запуске (`track`) и при каждом возвращении из фона (`visibilitychange`, `pageshow`). Вторая:
 * **применять его молча, когда терять нечего**, — и только в тот момент, когда человек ничем не
 * занят.
 *
 * Тихим считается запуск и возвращение из фона — до первого касания. Это не осторожность ради
 * осторожности: применение обновления перезагружает страницу, и перезагрузка посреди работы
 * перестроила бы экран под руками — сбила бы прокрутку, закрыла бы лист, увела бы фокус с поля.
 * Сразу после запуска и сразу после возврата из фона терять нечего: человек ещё ничего не начал,
 * а перезапуск в этот момент неотличим от обычного открытия приложения. Первое `pointerdown` или
 * `keydown` тишину заканчивает — до следующего возвращения из фона.
 *
 * Непустой черновик отменяет молчание при любом моменте: сохранить успеет только человек, и
 * поведение остаётся прежним — плашка, вопрос, «Позже».
 */
export interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Регистрация сервис-воркера — ровно то её умение, которое здесь нужно. */
export interface UpdatableRegistration {
  update: () => unknown;
}

/** Не чаще одной проверки за полминуты: возврат из фона и `pageshow` умеют прийти вдвоём. */
export const MINIMUM_UPDATE_CHECK_INTERVAL_MS = 30_000;

export interface AutomaticUpdateOptions {
  /** Применить обновление — тем же путём, что и кнопка «Обновить сейчас». */
  readonly apply: () => void;
  /** Есть ли прямо сейчас несохранённый ввод. */
  readonly hasUnsavedChanges: () => boolean;
  /** Виден ли документ: возвращение из фона — это переход в «видимо». */
  readonly isVisible: () => boolean;
  readonly now: () => number;
  readonly minimumCheckInterval?: number;
}

export interface AutomaticUpdateTargets {
  /** Документ: `visibilitychange` и первое касание. */
  readonly page?: EventTargetLike;
  /** Окно: `pageshow` — возврат страницы, восстановленной из кеша переходов. */
  readonly frame?: EventTargetLike;
}

export interface AutomaticUpdates {
  /** Регистрация появилась. Заодно — проверка обновления при запуске. */
  readonly track: (registration: UpdatableRegistration | undefined) => void;
  /** Новая версия ждёт. `true` — её применяют молча, и спрашивать не о чем. */
  readonly updateWaiting: () => boolean;
  /** Молчаливая попытка не удалась: версия по-прежнему ждёт, и теперь о ней спрашивают. */
  readonly applyFailed: () => void;
  /** Подписка на возвращение из фона и на первое касание; возвращает отписку. */
  readonly watch: (targets: AutomaticUpdateTargets) => () => void;
}

export function createAutomaticUpdates(options: AutomaticUpdateOptions): AutomaticUpdates {
  const minimumInterval = options.minimumCheckInterval ?? MINIMUM_UPDATE_CHECK_INTERVAL_MS;
  let registration: UpdatableRegistration | undefined;
  let lastCheckAt: number | null = null;
  // Запуск — тихий момент по определению: до первого касания приложение ничем не занято.
  let quiet = true;
  let waiting = false;
  let applying = false;

  const check = () => {
    if (registration === undefined) return;
    const at = options.now();
    if (lastCheckAt !== null && at - lastCheckAt < minimumInterval) return;
    lastCheckAt = at;
    // Отсутствие сети — это не событие приложения: проверка просто не состоялась, и следующее
    // возвращение из фона спросит снова.
    try {
      void Promise.resolve(registration.update()).catch(() => undefined);
    } catch {
      /* сказать человеку нечего */
    }
  };

  const applyIfSafe = (): boolean => {
    if (!waiting || applying || !quiet || options.hasUnsavedChanges()) return false;
    applying = true;
    options.apply();
    return true;
  };

  const resume = () => {
    if (!options.isVisible()) return;
    quiet = true;
    check();
    applyIfSafe();
  };

  return {
    track(next) {
      registration = next;
      check();
    },
    updateWaiting() {
      waiting = true;
      return applyIfSafe();
    },
    applyFailed() {
      applying = false;
    },
    watch({ page, frame }) {
      const onResume = () => resume();
      const onBusy = () => {
        quiet = false;
      };
      page?.addEventListener("visibilitychange", onResume);
      page?.addEventListener("pointerdown", onBusy);
      page?.addEventListener("keydown", onBusy);
      frame?.addEventListener("pageshow", onResume);
      return () => {
        page?.removeEventListener("visibilitychange", onResume);
        page?.removeEventListener("pointerdown", onBusy);
        page?.removeEventListener("keydown", onBusy);
        frame?.removeEventListener("pageshow", onResume);
      };
    },
  };
}
