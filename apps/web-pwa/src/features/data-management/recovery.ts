export type RecoveryActivity = "idle" | "backup" | "csv" | "restore" | "clear";

export interface RecoveryState {
  readonly activity: RecoveryActivity;
  readonly clearConfirmationOpen: boolean;
  readonly message: string | null;
  readonly error: string | null;
}

export type RecoveryAction =
  | { readonly type: "start"; readonly activity: Exclude<RecoveryActivity, "idle"> }
  | { readonly type: "succeed"; readonly message: string }
  | { readonly type: "fail"; readonly message: string }
  | { readonly type: "open-clear" }
  | { readonly type: "cancel-clear" };

export const initialRecoveryState: RecoveryState = {
  activity: "idle",
  clearConfirmationOpen: false,
  message: null,
  error: null,
};

export function recoveryReducer(state: RecoveryState, action: RecoveryAction): RecoveryState {
  switch (action.type) {
    case "start":
      return { ...state, activity: action.activity, message: null, error: null };
    case "succeed":
      return {
        activity: "idle",
        clearConfirmationOpen: false,
        message: action.message,
        error: null,
      };
    case "fail":
      return {
        ...state,
        activity: "idle",
        message: null,
        error: action.message,
      };
    case "open-clear":
      return { ...state, clearConfirmationOpen: true, message: null, error: null };
    case "cancel-clear":
      return { ...state, clearConfirmationOpen: false, error: null };
  }
}

export interface RecoveryActionGate {
  run<T>(action: () => Promise<T>): Promise<T | undefined>;
  readonly locked: boolean;
}

/** Acquires synchronously, before the first await, so rapid double clicks share no work. */
export function createRecoveryActionGate(): RecoveryActionGate {
  let locked = false;
  return {
    get locked() {
      return locked;
    },
    async run<T>(action: () => Promise<T>): Promise<T | undefined> {
      if (locked) return undefined;
      locked = true;
      try {
        return await action();
      } finally {
        locked = false;
      }
    },
  };
}

export async function persistThenPublishEmpty(
  persistClear: () => Promise<void>,
  publishEmpty: () => void,
): Promise<void> {
  await persistClear();
  publishEmpty();
}

interface PreparedSuccessfulBackup {
  readonly createdAt: string;
}

/**
 * A backup is successful only after the browser accepted the download action
 * and its timestamp was persisted. Callers may publish UI success afterwards.
 */
export async function downloadThenRecordSuccessfulBackup(
  backup: PreparedSuccessfulBackup,
  download: () => void,
  recordSuccessfulBackup: (createdAt: string) => Promise<void>,
): Promise<string> {
  download();
  await recordSuccessfulBackup(backup.createdAt);
  return backup.createdAt;
}
