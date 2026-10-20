import { DEFAULT_BASE_CURRENCY } from "@family-budget/domain";
import { Money, useBaseCurrency } from "../Money";
import { softHyphenate } from "../../hyphenation";
import { formatMoney } from "../../money";
import type { CategoryTile as CategoryTileModel } from "../../features/overview/overview-model";
import { Tile, type TileDrag } from "./Tile";

/** Слово состояния лимита — в доступном имени; глиф и цифры — на самой плитке (§9). */
export function limitWord(tile: CategoryTileModel, currency: string = DEFAULT_BASE_CURRENCY): string {
  if (tile.status === "near") return "почти лимит";
  if (tile.status === "over") return tile.limitMinor === null ? "перелимит" : `перелимит ${formatMoney(tile.spentMinor - tile.limitMinor, currency)}`;
  return "";
}

/**
 * Полное доступное имя плитки категории: имя целиком, суммы, состояние и что сделает касание.
 * Суммы — в базовой валюте семьи: траты по категориям считаются по снимкам в ней.
 */
export function categoryTileLabel(tile: CategoryTileModel, currency: string = DEFAULT_BASE_CURRENCY): string {
  const spent = `потрачено ${formatMoney(tile.spentMinor, currency)}${tile.limitMinor === null ? "" : ` из ${formatMoney(tile.limitMinor, currency)}`}`;
  const word = limitWord(tile, currency);
  return `${tile.name}: ${spent}${word ? `, ${word}` : ""}. Записать расход`;
}

/**
 * Плитка категории расхода (DESIGN 5.0 §6): квадрат тона с глифом, имя под ним, потрачено, «из
 * лимита» и полоса потрачено/лимит на треке холста. Состояние «почти» и «перелимит» — бейдж в углу
 * квадрата (треугольник и круг), цифры «3 500 ₽ / из 3 000 ₽» и слово в доступном имени; цвет полосы
 * — четвёртым. Без лимита нет ни полосы, ни бейджа, а нулевой расход набран приглушённо.
 */
export function CategoryTile({ tile, onPick, drag }: { readonly tile: CategoryTileModel; readonly onPick: () => void; readonly drag?: TileDrag }) {
  const currency = useBaseCurrency();
  const badge = tile.status === "near" || tile.status === "over" ? tile.status : undefined;
  const quiet = tile.limitMinor === null && tile.spentMinor === 0;
  return (
    <Tile variant="expense" icon={tile.visual.icon} tone={tile.visual.tone} badge={badge} label={categoryTileLabel(tile, currency)} onClick={onPick} drag={drag} tileKey={`category:${tile.id}`}>
      <span className="tile-name" aria-hidden="true"><bdi dir="auto">{softHyphenate(tile.name)}</bdi></span>
      <span className={quiet ? "tile-sum quiet" : "tile-sum"} aria-hidden="true"><Money value={tile.spentMinor} /></span>
      {tile.limitMinor === null ? null : <span className="tile-limit" aria-hidden="true">из <Money value={tile.limitMinor} /></span>}
      {tile.limitMinor === null ? null : <span className={`tile-bar ${tile.status}`} data-fill={tile.fill} aria-hidden="true" />}
    </Tile>
  );
}
