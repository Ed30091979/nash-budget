import { Icon } from "../Icon";
import { Money } from "../Money";
import { formatMoney } from "../../money";
import type { CategoryTile as CategoryTileModel } from "../../features/overview/overview-model";
import { Tile, type TileDrag } from "./Tile";

/** Слово состояния лимита — в доступном имени; глиф и цифры — на самой плитке (§9). */
export function limitWord(tile: CategoryTileModel): string {
  if (tile.status === "near") return "почти лимит";
  if (tile.status === "over") return tile.limitMinor === null ? "перелимит" : `перелимит ${formatMoney(tile.spentMinor - tile.limitMinor)}`;
  return "";
}

/** Полное доступное имя плитки категории: имя целиком, суммы, состояние и что сделает касание. */
export function categoryTileLabel(tile: CategoryTileModel): string {
  const spent = `потрачено ${formatMoney(tile.spentMinor)}${tile.limitMinor === null ? "" : ` из ${formatMoney(tile.limitMinor)}`}`;
  const word = limitWord(tile);
  return `${tile.name}: ${spent}${word ? `, ${word}` : ""}. Записать расход`;
}

/**
 * Плитка категории расхода: тон категории, глиф на белой подложке, имя до двух строк, потрачено и
 * лимит, полоса потрачено/лимит. Состояние «почти» и «перелимит» — глиф в углу (треугольник и круг),
 * цифры «3 500 / 3 000» и слово в доступном имени; цвет полосы — третьим.
 */
export function CategoryTile({ tile, onPick, drag }: { readonly tile: CategoryTileModel; readonly onPick: () => void; readonly drag?: TileDrag }) {
  return (
    <Tile variant="expense" tone={tile.visual.tone} label={categoryTileLabel(tile)} onClick={onPick} drag={drag} tileKey={`category:${tile.id}`}>
      <span className="tile-top">
        <span className="tile-glyph" aria-hidden="true"><Icon name={tile.visual.icon} size={20} /></span>
        {tile.status === "near" ? <span className={`tile-state ${tile.status}`} aria-hidden="true"><Icon name="triangle-alert" size={20} /></span> : null}
        {tile.status === "over" ? <span className={`tile-state ${tile.status}`} aria-hidden="true"><Icon name="circle-alert" size={20} /></span> : null}
      </span>
      <span className="tile-name" aria-hidden="true">{tile.name}</span>
      <span className="tile-sum" aria-hidden="true">
        <Money value={tile.spentMinor} />
        {tile.limitMinor === null ? null : <small> / <Money value={tile.limitMinor} /></small>}
      </span>
      {tile.limitMinor === null ? null : <span className={`tile-bar ${tile.status}`} data-fill={tile.fill} aria-hidden="true" />}
    </Tile>
  );
}
