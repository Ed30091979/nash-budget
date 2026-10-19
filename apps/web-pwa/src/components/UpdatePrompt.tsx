import { useEffect, useMemo, useRef, useState } from "react";
import { useUnsavedDrafts, type DraftRegistry } from "../navigation/draft-guard";
import { useRegisterSW } from "virtual:pwa-register/react";
import {
  createAutomaticUpdates,
  createUpdatePromptActions,
  createUpdateRequestGate,
  type UpdatePhase,
} from "./update-policy";

interface UpdatePromptViewProps {
  /**
   * Плашка уступает место сообщению приложения: на экране одна плашка, а не две друг на друге.
   * Состояние при этом не теряется — спрятанное сообщение об обновлении возвращается, как только
   * сообщение приложения закрыто или погасло.
   */
  hidden?: boolean;
  offlineReady: boolean;
  needRefresh: boolean;
  registrationFailed: boolean;
  updatePhase: UpdatePhase;
  updateBlocked: boolean;
  onUpdate: () => void;
  onLater: () => void;
  onDismissOfflineReady: () => void;
  onDismissRegistrationError: () => void;
}

export function UpdatePromptView({
  hidden = false,
  offlineReady,
  needRefresh,
  registrationFailed,
  updatePhase,
  updateBlocked,
  onUpdate,
  onLater,
  onDismissOfflineReady,
  onDismissRegistrationError,
}: UpdatePromptViewProps) {
  if (hidden || (!offlineReady && !needRefresh && !registrationFailed)) {
    return null;
  }

  const updateInProgress = updatePhase === "updating" || updatePhase === "reloading";
  const updateFailed = needRefresh && updatePhase === "failed";
  const message = needRefresh
    ? updateBlocked
      ? "Сначала сохраните изменения или очистите черновик. Обновление не применено."
      : updatePhase === "reloading"
      ? "Обновление установлено. Перезапускаем приложение…"
      : "Доступна новая версия. Обновление начнётся только после вашего подтверждения."
    : offlineReady
      ? "Приложение готово работать без интернета."
      : "Не удалось включить офлайн-режим. Приложение продолжит работать в браузере.";

  return (
    <aside
      className="update-toast"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={updateInProgress}
    >
      <p>{message}</p>
      {updateFailed ? (
        <p id="update-error" role="alert">
          Не удалось обновить приложение. Попробуйте ещё раз.
        </p>
      ) : null}
      {updateBlocked ? (
        <p id="update-blocked" role="alert">
          Несохранённый ввод останется в форме до сохранения или очистки.
        </p>
      ) : null}
      {needRefresh ? (
        <>
          <button
            className="primary-button"
            type="button"
            disabled={updateInProgress}
            aria-busy={updateInProgress}
            aria-describedby={updateFailed ? "update-error" : updateBlocked ? "update-blocked" : undefined}
            onClick={onUpdate}
          >
            {updatePhase === "updating"
              ? "Обновляем…"
              : updatePhase === "reloading"
                ? "Перезапускаем…"
                : updateFailed
                  ? "Повторить обновление"
                  : "Обновить сейчас"}
          </button>
          <button
            className="quiet-button"
            type="button"
            disabled={updateInProgress}
            onClick={onLater}
          >
            Позже
          </button>
        </>
      ) : (
        <button
          className="primary-button"
          type="button"
          onClick={offlineReady ? onDismissOfflineReady : onDismissRegistrationError}
        >
          Понятно
        </button>
      )}
    </aside>
  );
}

/**
 * Плашка обновления — и молчаливое обновление, которому плашка не нужна.
 *
 * Вопрос остаётся ровно там, где есть что терять: непустой черновик отменяет молчание, и человек
 * видит прежнюю плашку с «Позже». Когда терять нечего и приложение ничем не занято — запуск или
 * возвращение из фона, до первого касания, — новая версия применяется сама, и плашка на эту
 * секунду не показывается: нажимать в ней нечего. Не удалась — плашка возвращается обычным
 * предложением, а не жалобой на действие, которого человек не совершал.
 */
export function UpdatePrompt({ drafts, suppressed = false }: { readonly drafts: DraftRegistry; readonly suppressed?: boolean }) {
  const [registrationFailed, setRegistrationFailed] = useState(false);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>("idle");
  const [updateBlocked, setUpdateBlocked] = useState(false);
  const [applyingSilently, setApplyingSilently] = useState(false);
  // Черновики — из того же реестра, что спрашивают переход и `beforeunload`: для показа плашки —
  // снимок с перерисовкой, для решения о молчаливом обмене — ответ в самый момент решения.
  const hasUnsavedChanges = useUnsavedDrafts(drafts);
  const pendingSilentApply = useRef(false);
  const applySilently = useRef<() => void>(() => {
    pendingSilentApply.current = true;
  });
  const [updates] = useState(() =>
    createAutomaticUpdates({
      apply: () => applySilently.current(),
      hasUnsavedChanges: () => drafts.hasUnsavedDrafts("unload"),
      isVisible: () =>
        typeof document === "undefined" || document.visibilityState === "visible",
      now: () => Date.now(),
    }),
  );
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError() {
      setRegistrationFailed(true);
    },
    onRegisteredSW(_scriptUrl, registration) {
      updates.track(registration);
    },
    onNeedRefresh() {
      updates.updateWaiting();
    },
  });

  const requestUpdate = useMemo(
    () => createUpdateRequestGate(updateServiceWorker, setUpdatePhase),
    [updateServiceWorker],
  );
  const actions = useMemo(
    () =>
      createUpdatePromptActions({
        clearNeedRefresh: () => setNeedRefresh(false),
        clearOfflineReady: () => setOfflineReady(false),
        clearRegistrationError: () => setRegistrationFailed(false),
        requestUpdate,
      }),
    [requestUpdate, setNeedRefresh, setOfflineReady],
  );

  useEffect(() => {
    applySilently.current = () => {
      setApplyingSilently(true);
      void requestUpdate().then((attempt) => {
        if (attempt !== "failed") return;
        // Молчаливая попытка не удалась — версия по-прежнему ждёт. Человеку показывают обычное
        // предложение обновиться, а не ошибку действия, которого он не совершал.
        updates.applyFailed();
        setApplyingSilently(false);
        setUpdatePhase("idle");
      });
    };
    if (!pendingSilentApply.current) return;
    pendingSilentApply.current = false;
    applySilently.current();
  }, [requestUpdate, updates]);

  useEffect(
    () =>
      updates.watch({
        page: typeof document === "undefined" ? undefined : document,
        frame: typeof window === "undefined" ? undefined : window,
      }),
    [updates],
  );

  useEffect(() => {
    if (!hasUnsavedChanges) setUpdateBlocked(false);
  }, [hasUnsavedChanges]);

  const update = () => {
    if (drafts.hasUnsavedDrafts("unload")) {
      setUpdateBlocked(true);
      return;
    }
    setUpdateBlocked(false);
    void actions.update();
  };

  return (
    <UpdatePromptView
      hidden={suppressed || applyingSilently}
      offlineReady={offlineReady}
      needRefresh={needRefresh}
      registrationFailed={registrationFailed}
      updatePhase={updatePhase}
      updateBlocked={updateBlocked && hasUnsavedChanges}
      onUpdate={update}
      onLater={actions.later}
      onDismissOfflineReady={actions.dismissOfflineReady}
      onDismissRegistrationError={actions.dismissRegistrationError}
    />
  );
}
