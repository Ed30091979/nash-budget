import { useEffect, useMemo, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import {
  createUpdatePromptActions,
  createUpdateRequestGate,
  type UpdatePhase,
} from "./update-policy";

interface UpdatePromptViewProps {
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
  if (!offlineReady && !needRefresh && !registrationFailed) {
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

export function UpdatePrompt({ hasUnsavedChanges = false }: { readonly hasUnsavedChanges?: boolean }) {
  const [registrationFailed, setRegistrationFailed] = useState(false);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>("idle");
  const [updateBlocked, setUpdateBlocked] = useState(false);
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError() {
      setRegistrationFailed(true);
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
    if (!hasUnsavedChanges) setUpdateBlocked(false);
  }, [hasUnsavedChanges]);

  const update = () => {
    if (hasUnsavedChanges) {
      setUpdateBlocked(true);
      return;
    }
    setUpdateBlocked(false);
    void actions.update();
  };

  return (
    <UpdatePromptView
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
