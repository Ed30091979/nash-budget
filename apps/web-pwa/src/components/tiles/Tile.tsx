import type { DragEvent, KeyboardEvent, ReactNode, Ref } from "react";
import type { CategoryTone } from "../../category-visual";
import { Icon, type IconName } from "../Icon";

/**
 * Плитка (DESIGN 5.0 §6): скруглённый квадрат 52 с глифом 24 — тон сущности или графит счёта, — под
 * ним имя, сумма и всё, что о ней надо сказать. Роль у неё одна на все виды: категория, счёт,
 * источник дохода; вид меняет только заливку квадрата и строки под ним. Нажимается вся плитка, а не
 * квадрат: цель — колонка целиком, не меньше 48×48.
 *
 * Выбор — не цвет: `aria-pressed`, видимая галочка на углу квадрата и кольцо акцента вокруг него.
 * Плитка, которую выбирают (счёт, доход), несёт `aria-pressed` всегда — читающий с экрана слышит «не
 * нажата» до касания; плитка категории — нет: её касание открывает лист, а не выбирает. Доступное
 * имя — полное имя сущности с суммами и словом состояния: на самой плитке имя переносится по слогам.
 *
 * Перетаскивание — только дубль касаний (§9): обработчики приходят от экрана, который включает их
 * лишь при точном указателе.
 */
export type TileVariant = "expense" | "account" | "income";

/** Знак в углу квадрата: состояние лимита, отрицательный остаток, карандаш справочника. */
export type TileBadge = "near" | "over" | "negative" | "edit";

export interface TileDrag {
  readonly draggable: boolean;
  readonly onDragStart?: (event: DragEvent<HTMLButtonElement>) => void;
  readonly onDragEnd?: (event: DragEvent<HTMLButtonElement>) => void;
  readonly onDragOver?: (event: DragEvent<HTMLButtonElement>) => void;
  readonly onDrop?: (event: DragEvent<HTMLButtonElement>) => void;
}

const BADGE_ICONS: Readonly<Record<TileBadge, IconName>> = {
  near: "triangle-alert",
  over: "circle-alert",
  negative: "circle-alert",
  edit: "pencil",
};

/**
 * Квадрат плитки: заливка тона с глифом его чернилами (5.05–6.50:1) или графит счёта с белым глифом
 * (15.37:1). Его же рисуют плитки, которые не нажимают, — источник в архиве и образец над формой.
 */
export function TileSquare({ icon, tone, badge, picked = false }: {
  readonly icon: IconName;
  readonly tone: CategoryTone | "account";
  readonly badge?: TileBadge;
  readonly picked?: boolean;
}) {
  return (
    <span className={`tile-square ${tone === "account" ? "account" : `tone-${tone}`}`} aria-hidden="true">
      <Icon name={icon} size={24} />
      {picked
        ? <span className="tile-check"><Icon name="check" size={20} /></span>
        : badge === undefined ? null : <span className={`tile-badge ${badge}`}><Icon name={BADGE_ICONS[badge]} size={20} /></span>}
    </span>
  );
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
  readonly icon: IconName;
  /** Заливка квадрата: тон сущности или графит счёта. */
  readonly tone: CategoryTone | "account";
  readonly badge?: TileBadge;
  /** Тот же ключ, что и у автомата касаний: e2e и перетаскивание находят плитку по нему. */
  readonly tileKey: string;
  readonly buttonRef?: Ref<HTMLButtonElement>;
  /** Строки под квадратом: имя, сумма, «из лимита», полоса. */
  readonly children: ReactNode;
}

export function Tile({ variant, label, pressed, onClick, onKeyDown, drag, icon, tone, badge, tileKey, buttonRef, children }: TileProps) {
  const classes = ["tile", `tile-${variant}`, pressed ? "picked" : ""].filter(Boolean).join(" ");
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
      <TileSquare icon={icon} tone={tone} badge={badge} picked={pressed === true} />
      {children}
    </button>
  );
}
