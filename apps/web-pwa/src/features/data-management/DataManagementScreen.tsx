import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type BudgetState } from "@family-budget/domain";
import {
  activateDialogEnvironment,
  handleDialogKeyboard,
} from "./dialog-accessibility";
import { downloadTextFile } from "./download";
import {
  DataManagementError,
  HUMAN_READABLE_CSV_NOTICE,
  formatLastBackupDate,
  prepareJsonDownload,
  prepareOperationsCsvDownload,
  type RecoveryFile,
  validateRecoveryFile,
} from "./model";
import {
  createRecoveryActionGate,
  downloadThenRecordSuccessfulBackup,
  initialRecoveryState,
  persistThenPublishEmpty,
  recoveryReducer,
} from "./recovery";

export interface CreatedBackup {
  readonly text: string;
  readonly createdAt: string;
}

export interface DataManagementScreenProps {
  readonly budget: BudgetState;
  readonly lastSuccessfulBackup: string | null;
  readonly onCreateBackup: () => Promise<CreatedBackup>;
  readonly onRecordSuccessfulBackup: (createdAt: string) => Promise<void>;
  readonly onRestoreBackup: (file: RecoveryFile) => Promise<void>;
  readonly onPersistClear: () => Promise<void>;
  readonly onPublishEmpty: () => void;
}

const SAFE_ERRORS = {
  backup: "Не удалось создать резервную копию. Данные не изменены.",
  csv: "Не удалось подготовить таблицу операций. Данные не изменены.",
  restore: "Не удалось восстановить данные. Текущий бюджет не изменён.",
  clear: "Не удалось удалить данные. Текущий бюджет сохранён.",
} as const;

export function DataManagementScreen({
  budget,
  lastSuccessfulBackup,
  onCreateBackup,
  onRecordSuccessfulBackup,
  onRestoreBackup,
  onPersistClear,
  onPublishEmpty,
}: DataManagementScreenProps) {
  const [state, dispatch] = useReducer(recoveryReducer, initialRecoveryState);
  const [lastBackupAt, setLastBackupAt] = useState(lastSuccessfulBackup);
  const gate = useRef(createRecoveryActionGate());
  const clearTriggerRef = useRef<HTMLButtonElement>(null);
  const cancelClearRef = useRef<HTMLButtonElement>(null);
  const clearDialogRef = useRef<HTMLElement>(null);
  const restoreDialogEnvironmentRef = useRef<(() => void) | null>(null);

  useEffect(() => setLastBackupAt(lastSuccessfulBackup), [lastSuccessfulBackup]);
  useEffect(() => {
    if (!state.clearConfirmationOpen) return;
    const root = document.getElementById("root");
    restoreDialogEnvironmentRef.current = activateDialogEnvironment(
      root,
      cancelClearRef.current,
      clearTriggerRef.current,
    );
    return () => {
      restoreDialogEnvironmentRef.current?.();
      restoreDialogEnvironmentRef.current = null;
    };
  }, [state.clearConfirmationOpen]);

  const runBackup = () => {
    void gate.current.run(async () => {
      dispatch({ type: "start", activity: "backup" });
      try {
        const result = await onCreateBackup();
        const createdAt = await downloadThenRecordSuccessfulBackup(
          result,
          () => downloadTextFile(prepareJsonDownload(result.text)),
          onRecordSuccessfulBackup,
        );
        setLastBackupAt(createdAt);
        dispatch({ type: "succeed", message: "Резервная копия JSON скачана." });
      } catch {
        dispatch({ type: "fail", message: SAFE_ERRORS.backup });
      }
    });
  };

  const runCsv = () => {
    void gate.current.run(async () => {
      dispatch({ type: "start", activity: "csv" });
      try {
        downloadTextFile(prepareOperationsCsvDownload(budget));
        dispatch({ type: "succeed", message: "Таблица операций CSV скачана." });
      } catch {
        dispatch({ type: "fail", message: SAFE_ERRORS.csv });
      }
    });
  };

  const restore = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void gate.current.run(async () => {
      dispatch({ type: "start", activity: "restore" });
      try {
        validateRecoveryFile(file);
      } catch (error) {
        dispatch({
          type: "fail",
          message: error instanceof DataManagementError
            ? error.userMessage
            : SAFE_ERRORS.restore,
        });
        return;
      }
      try {
        await onRestoreBackup(file);
        dispatch({ type: "succeed", message: "Резервная копия восстановлена." });
      } catch {
        dispatch({ type: "fail", message: SAFE_ERRORS.restore });
      }
    });
  };

  const clear = () => {
    void gate.current.run(async () => {
      dispatch({ type: "start", activity: "clear" });
      try {
        await persistThenPublishEmpty(onPersistClear, () => {
          restoreDialogEnvironmentRef.current?.();
          restoreDialogEnvironmentRef.current = null;
          onPublishEmpty();
        });
        dispatch({ type: "succeed", message: "Локальные данные удалены." });
      } catch {
        dispatch({ type: "fail", message: SAFE_ERRORS.clear });
      }
    });
  };

  const busy = state.activity !== "idle";
  const clearConfirmation = (
    <div className="confirmation-backdrop" role="presentation">
      <section
        ref={clearDialogRef}
        className="confirmation-dialog"
        role="alertdialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="clear-data-title"
        aria-describedby="clear-data-description"
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          if (!clearDialogRef.current) return;
          handleDialogKeyboard(
            event,
            clearDialogRef.current,
            !busy,
            () => dispatch({ type: "cancel-clear" }),
          );
        }}
      >
        <h3 id="clear-data-title">Удалить весь семейный бюджет с устройства?</h3>
        <p id="clear-data-description">Операции, планы и настройки будут удалены. Отменить действие без JSON-копии нельзя.</p>
        <div className="dialog-actions">
          <button ref={cancelClearRef} type="button" disabled={busy} onClick={() => dispatch({ type: "cancel-clear" })}>Отмена</button>
          <button type="button" className="danger-button" disabled={busy} onClick={clear}>
            {state.activity === "clear" ? "Удаляем…" : "Удалить все данные"}
          </button>
        </div>
      </section>
    </div>
  );

  return (
    <section className="data-management" aria-labelledby="data-management-title">
      <header>
        <p className="eyebrow">Данные и восстановление</p>
        <h2 id="data-management-title">Выгрузка и резервная копия</h2>
        <p>Все файлы создаются на этом устройстве. В облако они не отправляются.</p>
      </header>

      <div className="data-management-grid">
        <article className="data-management-card">
          <h3>Резервная копия JSON</h3>
          <p>Последняя успешная копия: <strong>{formatLastBackupDate(lastBackupAt)}</strong>.</p>
          <p role="note">JSON не зашифрован и читается как обычный текст. Храните файл в безопасном месте.</p>
          <button type="button" disabled={busy} onClick={runBackup}>
            {state.activity === "backup" ? "Готовим копию…" : "Скачать резервную копию"}
          </button>
        </article>

        <article className="data-management-card">
          <h3>Таблица операций CSV</h3>
          <p>В выгрузке: <strong>{budget.transactions.length}</strong> операций.</p>
          <p role="note">CSV не зашифрован и читается как обычный текст. Это таблица для Excel, а не резервная копия: импорт CSV не поддерживается.</p>
          <span className="visually-hidden">{HUMAN_READABLE_CSV_NOTICE}</span>
          <button type="button" disabled={busy} onClick={runCsv}>
            {state.activity === "csv" ? "Готовим таблицу…" : "Скачать таблицу CSV"}
          </button>
        </article>

        <article className="data-management-card">
          <h3>Восстановить из JSON</h3>
          <p role="note">Выбирайте только свою доверенную JSON-копию размером не больше 5 МБ. Восстановление заменит текущие локальные данные.</p>
          <label className="file-button">
            <span>{state.activity === "restore" ? "Проверяем копию…" : "Выбрать резервную копию JSON"}</span>
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={restore}
            />
          </label>
        </article>

        <article className="data-management-card danger-zone">
          <h3>Удалить локальные данные</h3>
          <p>После удаления откроется первый запуск. Перед этим скачайте резервную копию.</p>
          <button
            ref={clearTriggerRef}
            type="button"
            className="danger-button"
            disabled={busy}
            onClick={() => dispatch({ type: "open-clear" })}
          >
            Перейти к удалению
          </button>
        </article>
      </div>

      {state.message ? <p role="status">{state.message}</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}

      {state.clearConfirmationOpen
        ? typeof document === "undefined"
          ? clearConfirmation
          : createPortal(clearConfirmation, document.body)
        : null}
    </section>
  );
}
