import { Children, isValidElement, type ReactNode } from "react";

/**
 * Сетка плиток: `repeat(auto-fill, minmax(max(4.5em, 64px), 1fr))` (DESIGN §5) — на 320 pt четыре
 * колонки по 66, при ×2.7 колонок меньше; ряд доходов прокручивается внутри себя, а не страница.
 */
export function TileGrid({ label, layout, children }: { readonly label: string; readonly layout: "grid" | "accounts" | "row"; readonly children: ReactNode }) {
  return (
    <ul className={`tile-grid tile-grid-${layout}`} aria-label={label}>
      {Children.toArray(children).map((child, index) => <li key={isValidElement(child) ? child.key ?? index : index}>{child}</li>)}
    </ul>
  );
}
