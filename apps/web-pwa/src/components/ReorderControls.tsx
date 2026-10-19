import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";
import { softHyphenate } from "../hyphenation";
import { Icon } from "./Icon";

/**
 * Порядок кнопками «Выше / Ниже» — дубль перетаскивания и единственный путь касанием (§9). Каждое
 * нажатие — одна запись: меняются местами два соседа (`moveAccount`, `moveCategory`).
 *
 * На краю кнопка не выключается, а говорит «нет»: `aria-disabled` оставляет её в фокусе, иначе
 * фокус после «Выше» на первое место ушёл бы в никуда. После перестановки строка уезжает на новое
 * место, и фокус возвращается на ту же кнопку той же записи — её `id` следует за записью.
 *
 * Дизайн 5.0: кнопки живут в отдельном режиме «Изменить порядок» (`ReorderList`), а не у каждой
 * строки списка; там они — стрелки 48 (`compact`), с теми же именами и тем же поведением.
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
  /** Стрелки вместо слов — в строке режима «Изменить порядок». */
  readonly compact?: boolean;
  readonly onMove: (direction: ReorderDirection) => Promise<unknown> | void;
}

export function reorderButtonId(id: string, direction: ReorderDirection): string {
  return `${id}-${direction}`;
}

export function ReorderControls({ id, name, position, count, busy, compact = false, onMove }: ReorderControlsProps) {
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
  const buttonClass = compact ? "icon-button reorder-step" : "secondary-button";
  return (
    <div className="reorder" role="group" aria-label={`Место в списке: ${position} из ${count}`}>
      <button
        id={reorderButtonId(id, "up")}
        className={buttonClass}
        type="button"
        aria-label={`${name} — выше`}
        aria-disabled={top || busy ? true : undefined}
        onClick={() => move("up", top)}
      >
        {compact ? <Icon name="arrow-up" size={24} /> : "Выше"}
      </button>
      <button
        id={reorderButtonId(id, "down")}
        className={buttonClass}
        type="button"
        aria-label={`${name} — ниже`}
        aria-disabled={bottom || busy ? true : undefined}
        onClick={() => move("down", bottom)}
      >
        {compact ? <Icon name="arrow-down" size={24} /> : "Ниже"}
      </button>
    </div>
  );
}

/**
 * Куда встанет перетаскиваемая запись: сколько остальных строк выше указателя. Середина строки —
 * порог: указатель ниже середины соседа ставит запись под него. Место — с нуля, среди списка без
 * перетаскиваемой строки, поэтому от 0 до `длина − 1`.
 */
export function dropIndex(rows: readonly { readonly top: number; readonly height: number }[], from: number, pointerY: number): number {
  let to = 0;
  rows.forEach((row, index) => {
    if (index !== from && pointerY > row.top + row.height / 2) to += 1;
  });
  return to;
}

/**
 * Перестановка записи с места `from` на место `to` — шагами соседей, как кнопки: одна запись
 * бюджета на всё перетаскивание, а порядок в данных меняет только то, что домен умеет менять.
 */
export function stepsBetween(from: number, to: number): readonly ReorderDirection[] {
  return Array.from({ length: Math.abs(to - from) }, () => (to < from ? "up" : "down"));
}

export interface ReorderItem {
  /** Идентификатор записи: по нему строятся `id` кнопок, и фокус следует за записью. */
  readonly id: string;
  readonly name: string;
  /** Подложка глифа — та же, что у строки списка. */
  readonly plate: ReactNode;
  readonly caption?: ReactNode;
}

export interface ReorderListProps {
  /** Основа `id` кнопок: `${idPrefix}-${item.id}-up`. */
  readonly idPrefix: string;
  /** Имя списка для слуха: «Порядок счетов». */
  readonly label: string;
  readonly items: readonly ReorderItem[];
  readonly busy?: boolean;
  /** Кнопка «выше» или «ниже»: запись меняется местами с соседом. */
  readonly onMove: (id: string, direction: ReorderDirection) => Promise<unknown> | void;
  /** Перетаскивание мышью: запись встаёт на место `to` (с нуля). */
  readonly onMoveTo: (id: string, to: number) => Promise<unknown> | void;
}

interface DragState {
  readonly id: string;
  readonly from: number;
  readonly startY: number;
  readonly pointerId: number;
  readonly row: HTMLElement;
  readonly rows: readonly HTMLElement[];
  readonly rects: readonly { readonly top: number; readonly height: number }[];
  to: number;
}

/**
 * Режим «Изменить порядок» (дизайн 5.0, §6 «Порядок»): строки списка с ручкой слева и стрелками
 * «выше / ниже» справа. Касание и клавиатура — стрелки (`ReorderControls`); мышь — ещё и ручка:
 * перетаскивание включается только при точном указателе (`pointer: fine`) и только дублирует
 * кнопки — строка встаёт на место, а запись та же, что сделали бы нажатия.
 *
 * Сдвиг строки под указателем — свойство `--drag-y`, которое ставит CSSOM: CSP запрещает атрибут
 * `style`, но не `style.setProperty`. Esc во время перетаскивания возвращает всё как было.
 */
export function ReorderList({ idPrefix, label, items, busy, onMove, onMoveTo }: ReorderListProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const drag = useRef<DragState | null>(null);

  const clearMarks = (state: DragState) => {
    state.row.classList.remove("dragging");
    state.row.style.removeProperty("--drag-y");
    for (const row of state.rows) row.removeAttribute("data-drop");
    listRef.current?.classList.remove("reordering");
  };
  const cancel = () => {
    const state = drag.current;
    if (state === null) return;
    drag.current = null;
    clearMarks(state);
  };
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && drag.current !== null) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      cancel();
    };
  }, []);

  const markDrop = (state: DragState) => {
    const others = state.rows.filter((row) => row !== state.row);
    for (const row of state.rows) row.removeAttribute("data-drop");
    if (state.to === state.from) return;
    if (state.to < others.length) others[state.to]?.setAttribute("data-drop", "before");
    else others.at(-1)?.setAttribute("data-drop", "after");
  };
  const onPointerDown = (event: PointerEvent<HTMLSpanElement>, id: string, from: number) => {
    if (busy || event.button !== 0 || event.pointerType === "touch") return;
    if (typeof window.matchMedia === "function" && !window.matchMedia("(pointer: fine)").matches) return;
    const row = event.currentTarget.closest("li");
    const list = listRef.current;
    if (row === null || list === null) return;
    const rows = Array.from(list.children) as HTMLElement[];
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id,
      from,
      to: from,
      startY: event.clientY,
      pointerId: event.pointerId,
      row,
      rows,
      rects: rows.map((item) => {
        const rect = item.getBoundingClientRect();
        return { top: rect.top, height: rect.height };
      }),
    };
    row.classList.add("dragging");
    list.classList.add("reordering");
  };
  const onPointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const state = drag.current;
    if (state === null || event.pointerId !== state.pointerId) return;
    state.row.style.setProperty("--drag-y", `${Math.round(event.clientY - state.startY)}px`);
    const to = dropIndex(state.rects, state.from, event.clientY);
    if (to !== state.to) {
      state.to = to;
      markDrop(state);
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLSpanElement>) => {
    const state = drag.current;
    if (state === null || event.pointerId !== state.pointerId) return;
    drag.current = null;
    clearMarks(state);
    if (state.to !== state.from) void Promise.resolve(onMoveTo(state.id, state.to)).catch(() => undefined);
  };

  return (
    <ol ref={listRef} className="card dir-card reorder-list" aria-label={label}>
      {items.map((item, index) => (
        <li key={item.id} className="dir-row reorder-row">
          <span
            className="reorder-grip"
            aria-hidden="true"
            onPointerDown={(event) => onPointerDown(event, item.id, index)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={cancel}
          >
            <Icon name="grip-vertical" size={24} />
          </span>
          {item.plate}
          <span className="dir-copy">
            {/* Имя с мягкими переносами — для глаза; для слуха — целое (в доступном имени перенос — шум). */}
            <strong aria-hidden="true"><bdi dir="auto">{softHyphenate(item.name)}</bdi></strong>
            <span className="sr-only">{item.name}</span>
            {item.caption === undefined ? null : <small>{item.caption}</small>}
          </span>
          <ReorderControls id={`${idPrefix}-${item.id}`} name={item.name} position={index + 1} count={items.length} busy={busy} compact onMove={(direction) => onMove(item.id, direction)} />
        </li>
      ))}
    </ol>
  );
}
