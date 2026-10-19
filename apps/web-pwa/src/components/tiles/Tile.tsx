import type { DragEvent, KeyboardEvent, ReactNode, Ref } from "react";
import { Icon } from "../Icon";

/**
 * Плитка — скруглённый квадрат, который нажимают (DESIGN 4.0 §5, §6). Роль у неё одна на все
 * виды: категория, счёт, источник дохода и «+»; вид меняет только тон и содержимое.
 *
 * Выбор — не цвет: `aria-pressed`, видимая галочка и кольцо акцента. Плитка, которую выбирают
 * (счёт, доход), несёт `aria-pressed` всегда — читающий с экрана слышит «не нажата» до касания;
 * плитка категории — нет: её касание открывает лист, а не выбирает. Доступное имя — полное имя
 * сущности с суммами и словом состояния: на самой плитке имя может уйти за две строки.
 *
 * Перетаскивание — только дубль касаний (§9): обработчики приходят от экрана, который включает их
 * лишь при точном указателе.
 */
export type TileVariant = "expense" | "account" | "income";

export interface TileDrag {
  readonly draggable: boolean;
  readonly onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  readonly onDragEnd?: (event: DragEvent<HTMLButtonElement>) => void;
  readonly onDragOver?: (event: DragEvent<HTMLButtonElement>) => void;
  readonly onDrop?: (event: DragEvent<HTMLButtonElement>) => void;
}

export interface TileProps {
  readonly variant: TileVariant;
  /** Полное доступное имя: имя, суммы, состояние, что сделает касание. */
  readonly label: string;
  /** `undefined` — плитка не выбирается (категория); `true`/`false` — выбрана ли. */
  readonly pressed?: boolean;
  readonly onClick: () => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly drag?: TileDrag;
  /** Оттенок плитки категории — `tone-*`; у счёта и дохода свой фон. */
  readonly tone?: string;
  /** Тот же ключ, что и у автомата касаний: e2e и перетаскивание находят плитку по нему. */
  readonly tileKey: string;
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly children: ReactNode;
}

export function Tile({ variant, label, pressed, onClick, onKeyDown, drag, tone, tileKey, buttonRef, children }: TileProps) {
  const classes = ["tile", `tile-${variant}`, tone ? `tone-${tone}` : "", pressed ? "picked" : ""].filter(Boolean).join(" ");
  return (
    <button
      ref={buttonRef}
      className={classes}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      data-tile={tileKey}
      onClick={onClick}
      onKeyDown={onKeyDown}
      draggable={drag?.draggable === true ? true : undefined}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
    >
      {children}
      {pressed ? <span className="tile-check" aria-hidden="true"><Icon name="check" size={20} /></span> : null}
    </button>
  );
}
