import { Icon } from "../Icon";
import { Money } from "../Money";
import { softHyphenate } from "../../hyphenation";
import { formatMoney } from "../../money";
import type { AccountTile as AccountTileModel } from "../../features/overview/overview-model";
import { Tile, type TileDrag } from "./Tile";

/** Доступное имя счёта: имя, остаток в его валюте, отношение к итогу и выбран ли он. */
export function accountTileLabel(tile: AccountTileModel): string {
  const balance = tile.balanceMinor === null ? "остаток не представим" : `остаток ${formatMoney(tile.balanceMinor, tile.currency)}`;
  const total = !tile.includeInTotal ? ", не входит в итог" : tile.unvalued ? `, нет курса ${tile.currency} — в итог не вошёл` : "";
  return `${tile.name}: ${balance}${total}`;
}

/**
 * Тёмная плитка счёта: имя и остаток в валюте счёта (§7: валюта счёта на плитке, база — в итогах).
 * Тон, выбранный семьёй, — подложка глифа его цвета (глиф — его чернилами, 5.05–6.50:1); без тона
 * глиф стоит прямо на тёмной плитке.
 * На тёмной плитке только белый и его приглушение; отрицательный остаток — белым, с U+2212 и глифом,
 * а не красным (2.25:1 — запрет §3).
 */
export function AccountTile({ tile, pressed, onPick, drag }: { readonly tile: AccountTileModel; readonly pressed: boolean; readonly onPick: () => void; readonly drag?: TileDrag }) {
  const negative = tile.balanceMinor !== null && tile.balanceMinor < 0;
  return (
    <Tile variant="account" label={accountTileLabel(tile)} pressed={pressed} onClick={onPick} drag={drag} tileKey={`account:${tile.id}`}>
      <span className="tile-top">
        <span className={tile.tone === null ? "tile-glyph" : `tile-glyph tone-${tile.tone}`} aria-hidden="true"><Icon name={tile.icon} size={20} /></span>
        {negative ? <span className="tile-state negative" aria-hidden="true"><Icon name="circle-alert" size={20} /></span> : null}
      </span>
      <span className="tile-name" aria-hidden="true"><bdi dir="auto">{softHyphenate(tile.name)}</bdi></span>
      <span className="tile-sum" aria-hidden="true">{tile.balanceMinor === null ? "—" : <Money value={tile.balanceMinor} currency={tile.currency} />}</span>
      {!tile.includeInTotal ? <small className="tile-note" aria-hidden="true">вне итога</small> : tile.unvalued ? <small className="tile-note" aria-hidden="true">нет курса</small> : null}
    </Tile>
  );
}
