import { useRef } from "react";

/**
 * Порядок кнопками «Выше / Ниже» — вместо перетаскивания (§9: перетаскивание всегда дублируется
 * касанием, а здесь касание — единственный путь). Каждое нажатие — одна запись: меняются местами
 * два соседа (`moveAccount`, `moveCategory`).
 *
 * На краю кнопка не выключается, а говорит «нет»: `aria-disabled` оставляет её в фокусе, иначе
 * фокус после «Выше» на первое место ушёл бы в никуда. После перестановки строка уезжает на новое
 * место, и фокус возвращается на ту же кнопку той же записи — её `id` следует за записью.
 */
export type ReorderDirection = "up" | "down";

export interface ReorderControlsProps {
  /** Основа `id` кнопок — по идентификатору записи, а не по месту в списке. */
  readonly id: string;
  /** Название записи — для доступного имени: «Карта — выше». */
  readonly name: string;
  /** Место в списке, с единицы, и длина списка: «2-й из 4». */
  readonly position: number;
  readonly count: number;
  readonly busy?: boolean;
  readonly onMove: (direction: ReorderDirection) => Promise<unknown> | void;
}

export function reorderButtonId(id: string, direction: ReorderDirection): string {
  return `${id}-${direction}`;
}

export function ReorderControls({ id, name, position, count, busy, onMove }: ReorderControlsProps) {
  const running = useRef(false);
  const move = (direction: ReorderDirection, blocked: boolean) => {
    if (blocked || busy || running.current) return;
    running.current = true;
    void Promise.resolve(onMove(direction)).catch(() => undefined).finally(() => {
      running.current = false;
      // Строка уже на новом месте: фокус — на ту же кнопку той же записи.
      requestAnimationFrame(() => document.getElementById(reorderButtonId(id, direction))?.focus({ preventScroll: false }));
    });
  };
  const top = position <= 1;
  const bottom = position >= count;
  return (
    <div className="reorder" role="group" aria-label={`Место в списке: ${position} из ${count}`}>
      <button
        id={reorderButtonId(id, "up")}
        className="secondary-button"
        type="button"
        aria-label={`${name} — выше`}
        aria-disabled={top || busy ? true : undefined}
        onClick={() => move("up", top)}
      >
        Выше
      </button>
      <button
        id={reorderButtonId(id, "down")}
        className="secondary-button"
        type="button"
        aria-label={`${name} — ниже`}
        aria-disabled={bottom || busy ? true : undefined}
        onClick={() => move("down", bottom)}
      >
        Ниже
      </button>
    </div>
  );
}
