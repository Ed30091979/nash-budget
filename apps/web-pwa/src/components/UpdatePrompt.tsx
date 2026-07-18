import { useRegisterSW } from "virtual:pwa-register/react";

export function UpdatePrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      console.error("Service worker registration failed", error);
    },
  });

  if (!offlineReady && !needRefresh) {
    return null;
  }

  return (
    <aside className="update-toast" role="status" aria-live="polite">
      <p>
        {needRefresh
          ? "Доступна новая версия. Обновим после вашего подтверждения."
          : "Приложение готово работать без интернета."}
      </p>
      {needRefresh ? (
        <button className="primary-button" type="button" onClick={() => void updateServiceWorker(true)}>
          Обновить сейчас
        </button>
      ) : (
        <button className="primary-button" type="button" onClick={() => setOfflineReady(false)}>
          Понятно
        </button>
      )}
      {needRefresh ? (
        <button className="quiet-button" type="button" onClick={() => setNeedRefresh(false)}>
          Позже
        </button>
      ) : null}
    </aside>
  );
}
