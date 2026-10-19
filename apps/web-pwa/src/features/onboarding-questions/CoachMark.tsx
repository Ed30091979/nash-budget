import { useLayoutEffect, useRef, useState } from "react";

export const COACH_TEXT = "Коснитесь категории, чтобы записать расход";

export interface CoachMarkProps {
  /** Ключ плитки, на которую смотрит подсказка (`data-tile`, тот же, что у автомата касаний). */
  readonly target: string;
  /** «Понятно»: подсказка закрыта навсегда, на этом устройстве. */
  readonly onDismiss: () => void;
}

/** Отступ кольца от квадрата плитки и зазор между плиткой и пузырём. */
const RING_OUTSET = 6;
const BUBBLE_GAP = 14;
const EDGE = 16;

/** Плитка подсказки в документе: ключ — из закрытого набора (`category:<UUID>`), но экранируется всё равно. */
function findTile(target: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tile="${CSS.escape(target)}"]`);
}

/**
 * Подсказка на первую трату (05): кольцо на «Продуктах» и пузырь «Коснитесь категории, чтобы
 * записать расход».
 *
 * Пропадает после первой записи или по «Понятно» и никогда — по времени (DIRECTION §b, WCAG 2.2.1).
 * Фокус не держит: это не диалог, а пометка, — Tab идёт по экрану как обычно, а «Понятно» стоит в
 * обходе сразу за плитками. Читающему с экрана текст говорится вежливо, один раз (`role="status"`
 * заполняется после первого кадра, когда пузырь встал на место).
 *
 * Кольцо и пузырь меряются от плитки, а не вписаны в её разметку: плитка остаётся чужой, и
 * подсказка ставится на любую. Квадрат внутри плитки, если он помечен `data-coach-anchor`, получает
 * кольцо сам; без пометки кольцо обнимает плитку целиком. Координаты едут в разметку переменными
 * CSS через CSSOM — CSP запрещает атрибут `style`, но не `style.setProperty`.
 */
export function CoachMark({ target, onDismiss }: CoachMarkProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState(false);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const bubble = bubbleRef.current;
    if (layer === null || bubble === null) return undefined;
    const measure = () => {
      const tile = findTile(target);
      if (tile === null) {
        setPlaced(false);
        return;
      }
      const anchor = tile.querySelector<HTMLElement>("[data-coach-anchor]") ?? tile;
      const parent = (layer.offsetParent as HTMLElement | null) ?? document.body;
      const base = parent.getBoundingClientRect();
      const originX = base.left + parent.clientLeft - parent.scrollLeft;
      const originY = base.top + parent.clientTop - parent.scrollTop;
      const ring = anchor.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const bubbleWidth = bubble.getBoundingClientRect().width;
      const left = Math.min(Math.max(EDGE, ring.left - EDGE), Math.max(EDGE, width - bubbleWidth - EDGE));
      const arrow = Math.min(Math.max(EDGE, ring.left + ring.width / 2 - left - 9), Math.max(EDGE, bubbleWidth - 34));
      const set = (name: string, value: number) => layer.style.setProperty(name, `${Math.round(value)}px`);
      set("--coach-ring-left", ring.left - RING_OUTSET - originX);
      set("--coach-ring-top", ring.top - RING_OUTSET - originY);
      set("--coach-ring-width", ring.width + RING_OUTSET * 2);
      set("--coach-ring-height", ring.height + RING_OUTSET * 2);
      set("--coach-bubble-left", left - originX);
      set("--coach-bubble-top", tile.getBoundingClientRect().bottom + BUBBLE_GAP - originY);
      set("--coach-arrow-left", arrow);
      setPlaced(true);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(document.documentElement);
    observer?.observe(bubble);
    const tile = findTile(target);
    if (tile !== null) observer?.observe(tile);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [target]);

  // «Понятно» снимает подсказку, и фокус не падает на <body>: он уходит на плитку, о которой она была.
  const dismiss = () => {
    const tile = findTile(target);
    onDismiss();
    tile?.focus({ preventScroll: true });
  };

  return (
    <div ref={layerRef} className="coach-layer" data-placed={placed ? "true" : undefined}>
      <span className="coach-ring" aria-hidden="true" />
      <div ref={bubbleRef} className="coach-bubble card">
        <span className="coach-arrow" aria-hidden="true" />
        <p className="coach-text" role="status">{placed ? COACH_TEXT : ""}</p>
        <button className="quiet-button coach-ok" type="button" onClick={dismiss}>Понятно</button>
      </div>
    </div>
  );
}
