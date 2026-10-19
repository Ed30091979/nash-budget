import { useMemo, useState } from "react";
import type { BudgetState } from "@family-budget/domain";
import { BUDGET_WRITE_CONFLICT_MESSAGE } from "../app/budget-store";
import { BudgetWriteRefusal } from "../write-refusal";

/** Правка бюджета: из текущего состояния — следующее. Строится только из документа (c6afe5c). */
export type BudgetChange = (current: BudgetState) => BudgetState;

export interface BudgetWriteOptions {
  /**
   * Молчаливая запись — та, которую человек не начинал (участник этого устройства, записанный
   * синхронизацией): её неудача не объявляется, она повторится сама на следующем круге.
   */
  readonly silent?: boolean;
  /**
   * Неудачу показывает тот, кто начал запись, своими словами и со своим выходом: лист ввода
   * закрывается в момент нажатия, и «Не записано: … [Вернуться к черновику]» говорит оболочка через
   * его черновик. Общая тревога о неудаче, которой некому показать, тогда была бы второй.
   */
  readonly ownsFailure?: boolean;
}

/** Единственный путь, которым экраны и оболочка пишут бюджет (план волны 2, §2.3). */
export interface BudgetWriter {
  run(change: BudgetChange, options?: BudgetWriteOptions): Promise<BudgetState>;
}

/** Неудача записи, которую экран, начавший её, уже не покажет: человек ушёл с него в полёте. */
export interface UnseenWriteFailure {
  readonly message: string;
  /** Отказ задержки семьи (`BudgetWriteRefusal`), а не сбой. */
  readonly refusal: boolean;
}

/**
 * Слова о неудачной записи: отказ — своими словами (`WRITE_REFUSAL_TEXT`), конфликт с другой
 * вкладкой — своими, всё прочее — общей фразой. Текст произвольной ошибки на экран не попадает.
 */
export function writeFailureText(error: unknown): string {
  if (error instanceof BudgetWriteRefusal) return error.userMessage;
  if (error instanceof Error && error.message === BUDGET_WRITE_CONFLICT_MESSAGE) return BUDGET_WRITE_CONFLICT_MESSAGE;
  return "Изменение не сохранилось. Повторите его.";
}

export interface BudgetWriterOptions {
  readonly coordinator: { apply(change: BudgetChange): Promise<BudgetState> };
  /**
   * Где сейчас человек — меняется на каждом переходе. Запись, начатая в одном месте и не
   * удавшаяся в другом, некому показать: экран, который её начал, уже снят.
   */
  readonly place: () => string;
  readonly onUnseenFailure: (failure: UnseenWriteFailure) => void;
}

/**
 * Запись через координатор (сериализация, CAS, журнал семьи — `app/budget-store.ts`). Ошибка
 * всегда возвращается вызывающему: форма показывает её у себя и сохраняет черновик. Если же
 * человек успел уйти с экрана, пока запись летела (с ca7edd7 уход в полёте не спрашивается), об
 * отказе говорит оболочка — иначе неудача прошла бы молча, а человек считал бы покупку записанной.
 */
export function createBudgetWriter(options: BudgetWriterOptions): BudgetWriter {
  return {
    async run(change, runOptions = {}) {
      const startedAt = options.place();
      try {
        return await options.coordinator.apply(change);
      } catch (error) {
        if (runOptions.silent !== true && runOptions.ownsFailure !== true && options.place() !== startedAt) {
          options.onUnseenFailure({ message: writeFailureText(error), refusal: error instanceof BudgetWriteRefusal });
        }
        throw error;
      }
    },
  };
}

/**
 * Писатель оболочки и неудача, которую некому было показать, — для `WriteRefusalNotice`.
 * `place` обязан быть стабильным (он читает роутер, а не состояние отрисовки).
 */
export function useBudgetWrite(coordinator: BudgetWriterOptions["coordinator"], place: () => string) {
  const [unseenFailure, setUnseenFailure] = useState<UnseenWriteFailure | null>(null);
  const write = useMemo(
    () => createBudgetWriter({ coordinator, place, onUnseenFailure: setUnseenFailure }),
    [coordinator, place],
  );
  return { write, unseenFailure, dismissUnseenFailure: () => setUnseenFailure(null) };
}
