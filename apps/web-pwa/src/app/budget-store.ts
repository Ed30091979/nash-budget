import type { BudgetState } from "@family-budget/domain";
import { prepareBudgetState } from "../backup";
import type { BudgetJournalWrite } from "../features/family";

/**
 * Запись бюджета после онбординга: один координатор на всё приложение.
 *
 * Перенесён из `App.tsx` без изменения поведения: сериализация через хвост обещаний, сравнение
 * ревизии (CAS) с публикацией победителя при конфликте и запись через журнал семьи, когда он есть.
 * Каждый экран, который меняет бюджет, пишет через него — своего пути в хранилище ни у кого нет.
 */
export type BudgetSaveResult =
  | { readonly status: "saved"; readonly value: unknown; readonly revision: string }
  | {
      readonly status: "conflict";
      readonly current: { readonly value: unknown; readonly revision: string } | null;
    };

export interface AppBudgetSaveOptions {
  readonly repository: {
    loadVersioned(): Promise<{ readonly value: BudgetState; readonly revision: string } | null>;
    saveIfRevision(expectedRevision: string | null, state: BudgetState): Promise<BudgetSaveResult>;
  };
  readonly getCurrent: () => BudgetState;
  readonly getRevision: () => string | null;
  readonly setRevision: (revision: string) => void;
  readonly publish: (state: BudgetState, revision: string) => void;
  /**
   * Запись через журнал семьи, когда она есть.
   *
   * Читается на каждом сохранении, а не один раз при сборке: семья создаётся и покидается посреди
   * сессии, и координатор, запомнивший ответ, писал бы мимо журнала до перезагрузки. `null` —
   * «журнала нет», и тогда путь ниже ровно тот, каким он был до синхронизации: те же чтения, та же
   * проверка ревизии, то же сообщение о конфликте.
   */
  readonly journalWrite?: () => BudgetJournalWrite | null;
}

export const BUDGET_WRITE_CONFLICT_MESSAGE = "Бюджет уже изменён в другой вкладке. Показана сохранённая версия; повторите изменение.";

function writeConflict(): Error {
  return new Error(BUDGET_WRITE_CONFLICT_MESSAGE);
}

function sameBudget(left: BudgetState, right: BudgetState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Every post-onboarding mutation is serialized, CAS-saved, and only then shown. */
export function createAppBudgetSaveCoordinator(options: AppBudgetSaveOptions) {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    get locked() { return pending > 0; },
    async apply(change: (current: BudgetState) => BudgetState): Promise<BudgetState> {
      pending += 1;
      let resolveResult!: (state: BudgetState) => void;
      let rejectResult!: (reason: unknown) => void;
      const result = new Promise<BudgetState>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      tail = tail.catch(() => undefined).then(async () => {
        try {
          let expectedRevision = options.getRevision();
          if (expectedRevision === null) {
            const snapshot = await options.repository.loadVersioned();
            if (!snapshot) throw writeConflict();
            const winner = prepareBudgetState(snapshot.value);
            if (!sameBudget(options.getCurrent(), winner)) {
              options.publish(winner, snapshot.revision);
              throw writeConflict();
            }
            expectedRevision = snapshot.revision;
            options.setRevision(snapshot.revision);
          }

          const previous = options.getCurrent();
          const candidate = prepareBudgetState(change(previous));
          const journal = options.journalWrite?.() ?? null;
          const saved =
            (journal === null
              ? null
              : await journal({ expectedRevision, previous, next: candidate })) ??
            (await options.repository.saveIfRevision(expectedRevision, candidate));
          if (saved.status === "conflict") {
            if (saved.current) {
              const winner = prepareBudgetState(saved.current.value);
              options.publish(winner, saved.current.revision);
            }
            throw writeConflict();
          }

          const stored = prepareBudgetState(saved.value);
          options.publish(stored, saved.revision);
          resolveResult(stored);
        } catch (error) {
          rejectResult(error);
        } finally {
          pending -= 1;
        }
      });
      return result;
    },
  };
}

export type AppBudgetSaveCoordinator = ReturnType<typeof createAppBudgetSaveCoordinator>;
