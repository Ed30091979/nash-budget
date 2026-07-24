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
