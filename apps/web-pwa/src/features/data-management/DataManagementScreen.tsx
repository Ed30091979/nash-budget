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
import { Icon } from "../../components/Icon";
import { BudgetWriteRefusal } from "../../write-refusal";
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
  /** Копию эта сборка не восстановит — и почему; `null` или нет поля, когда восстановит. */
  readonly restoreWarning?: string | null;
}

export interface DataManagementScreenProps {
  readonly budget: BudgetState;
  readonly lastSuccessfulBackup: string | null;
  /** iPhone в Safari без установки: строка с подсказкой стоит среди данных, а не отдельной плашкой. */
  readonly showIosInstall?: boolean;
  readonly onCreateBackup: () => Promise<CreatedBackup>;
  readonly onRecordSuccessfulBackup: (createdAt: string) => Promise<void>;
  readonly onRestoreBackup: (file: RecoveryFile) => Promise<void>;
  readonly onPersistClear: () => Promise<void>;
  readonly onPublishEmpty: () => void;
  /** Дверь в импорт выписки; без неё строки нет — экран, вставленный без навигации, вести некуда. */
  readonly onImportStatement?: () => void;
}

const SAFE_ERRORS = {
  backup: "Не удалось создать резервную копию. Данные не изменены.",
  csv: "Не удалось подготовить таблицу операций. Данные не изменены.",
  restore: "Не удалось восстановить данные. Текущий бюджет не изменён.",
  clear: "Не удалось удалить данные. Текущий бюджет сохранён.",
} as const;

/** «4 операции» — число тянет существительное за собой. */
function operationsWord(count: number): string {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return `${count} операций`;
  if (last === 1) return `${count} операция`;
  if (last >= 2 && last <= 4) return `${count} операции`;
  return `${count} операций`;
}

/**
 * Данные: копия, таблица, восстановление, удаление — строками списка.
 *
 * Приложение офлайн-первое, и сервер копией не является: при утрате всех устройств данные не
 * восстановить. Поэтому «Сделать копию» — первая строка списка, а не кнопка в четвёртой карточке
 * после трёх абзацев. Абзацы никуда не делись: они свёрнуты в строку факта «Где хранятся файлы»,
 * и на них по-прежнему ссылаются описания действий (`aria-describedby`) — читающий с экрана
 * услышит предупреждение до нажатия, а глаз увидит его по требованию.
 */
export function DataManagementScreen({
  budget,
  lastSuccessfulBackup,
  showIosInstall = false,
  onCreateBackup,
  onRecordSuccessfulBackup,
  onRestoreBackup,
  onPersistClear,
  onPublishEmpty,
  onImportStatement,
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
          async () => {
            await downloadTextFile(prepareJsonDownload(result.text));
          },
          onRecordSuccessfulBackup,
        );
        setLastBackupAt(createdAt);
        // Копия за пределом восстановления записана целиком, и сказать это надо сейчас, а не при
        // попытке восстановить её.
        dispatch({
          type: "succeed",
          message: result.restoreWarning ? `Резервная копия JSON скачана. ${result.restoreWarning}` : "Резервная копия JSON скачана.",
        });
      } catch {
        dispatch({ type: "fail", message: SAFE_ERRORS.backup });
      }
    });
  };

  const runCsv = () => {
    void gate.current.run(async () => {
      dispatch({ type: "start", activity: "csv" });
      try {
        await downloadTextFile(prepareOperationsCsvDownload(budget));
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
      } catch (error) {
        // Восстановление — такая же запись бюджета, как любая другая, и пока записи недоступны,
        // человек узнаёт почему, а не «не удалось».
        dispatch({ type: "fail", message: error instanceof BudgetWriteRefusal ? error.userMessage : SAFE_ERRORS.restore });
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
    <section className="data-management list-group" aria-labelledby="data-management-title" aria-busy={busy}>
      <h2 id="data-management-title" className="list-kicker">Данные</h2>
      <ul className="list-card">
        <li>
          <button className="list-row" type="button" disabled={busy} aria-describedby="json-backup-notice" onClick={runBackup}>
            <span className="list-icon"><Icon name="download" size={24} /></span>
            <span className="list-copy">
              <strong>{state.activity === "backup" ? "Готовим копию…" : "Сделать резервную копию"}</strong>
              <small>Последняя успешная копия: {formatLastBackupDate(lastBackupAt)}</small>
            </span>
            <Icon name="chevron-right" size={24} className="row-chevron" />
          </button>
        </li>
        {onImportStatement ? <li>
          {/* Выписка — второй строкой, сразу после копии: копию делают ради сохранности, выписку
              грузят каждый месяц. Разбор на устройстве, и это сказано уже здесь. */}
          <button className="list-row" type="button" disabled={busy} onClick={onImportStatement}>
            <span className="list-icon"><Icon name="receipt-text" size={24} /></span>
            <span className="list-copy">
              <strong>Загрузить выписку банка</strong>
              <small>CSV из Т-Банка · разбор на этом устройстве, файл никуда не уходит</small>
            </span>
            <Icon name="chevron-right" size={24} className="row-chevron" />
          </button>
        </li> : null}
        <li>
          <button className="list-row" type="button" disabled={busy} aria-describedby="csv-export-notice" onClick={runCsv}>
            <span className="list-icon"><Icon name="table" size={24} /></span>
            <span className="list-copy">
              <strong>{state.activity === "csv" ? "Готовим таблицу…" : "Таблица операций CSV"}</strong>
              <small><strong>{operationsWord(budget.transactions.length)}</strong> · для Excel, не резервная копия</small>
              <span className="visually-hidden">{HUMAN_READABLE_CSV_NOTICE}</span>
            </span>
            <Icon name="chevron-right" size={24} className="row-chevron" />
          </button>
        </li>
        <li>
          <label className="file-button list-row" htmlFor="backup-file">
            <span className="list-icon"><Icon name="upload" size={24} /></span>
            <span className="list-copy">
              <strong>{state.activity === "restore" ? "Проверяем копию…" : "Восстановить из копии"}</strong>
              <small>Файл JSON до 5 МБ · заменит данные на этом устройстве</small>
            </span>
            <Icon name="chevron-right" size={24} className="row-chevron" />
            <input
              id="backup-file"
              type="file"
              accept=".json,application/json"
              aria-describedby="json-restore-notice"
              disabled={busy}
              onChange={restore}
            />
          </label>
        </li>
        {showIosInstall ? <li>
          <div className="list-row static">
            <span className="list-icon"><Icon name="smartphone" size={24} /></span>
            <span className="list-copy">
              <strong>Установить на iPhone</strong>
              <small>В Safari нажмите «Поделиться» → «На экран Домой». После первого запуска план доступен без сети.</small>
            </span>
          </div>
        </li> : null}
        <li><details className="list-fact">
          <summary><span className="list-icon"><Icon name="shield" size={24} /></span><span className="list-copy"><strong>Где хранятся файлы</strong><small>Место выбираете вы; файлы не зашифрованы</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></summary>
          <p>
            Приложение само не загружает файлы ни на свой сервер, ни на сторонние серверы.
            Место сохранения выбираете вы. Если выбрать облачную папку, незашифрованный файл
            может синхронизироваться с облаком.
          </p>
          <p id="json-backup-notice" role="note">JSON не зашифрован и читается как обычный текст. Храните файл в безопасном месте.</p>
          <p id="csv-export-notice" role="note">CSV не зашифрован и читается как обычный текст. Это таблица для Excel, а не резервная копия: импорт CSV не поддерживается.</p>
          <p id="json-restore-notice" role="note">Выбирайте только свою доверенную JSON-копию размером не больше 5 МБ. Восстановление заменит текущие локальные данные.</p>
        </details></li>
      </ul>

      {state.message ? <p role="status" aria-live="polite">{state.message}</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}

      <ul className="list-card list-danger">
        <li>
          <button
            ref={clearTriggerRef}
            type="button"
            className="list-row danger"
            disabled={busy}
            onClick={() => dispatch({ type: "open-clear" })}
          >
            <span className="list-icon"><Icon name="trash-2" size={24} /></span>
            <span className="list-copy">
              <strong>Удалить данные с этого устройства</strong>
              <small>Откроется первый запуск. Перед этим сделайте копию.</small>
            </span>
          </button>
        </li>
      </ul>

      {state.clearConfirmationOpen
        ? typeof document === "undefined"
          ? clearConfirmation
          : createPortal(clearConfirmation, document.body)
        : null}
    </section>
  );
}
