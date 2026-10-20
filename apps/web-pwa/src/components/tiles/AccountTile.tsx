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
 * Плитка счёта: графитовый квадрат с белым глифом (15.37:1) — или тон, который выбрала семья (D-036),
 * — имя и остаток в валюте счёта под ним (§7: валюта счёта на плитке, база — в итогах).
 * Отрицательный остаток — знаком U+2212 и бейджем-кругом в углу квадрата, а не красным числом.
 */
export function AccountTile({ tile, pressed, onPick, drag }: { readonly tile: AccountTileModel; readonly pressed: boolean; readonly onPick: () => void; readonly drag?: TileDrag }) {
  const negative = tile.balanceMinor !== null && tile.balanceMinor < 0;
  return (
    <Tile variant="account" icon={tile.icon} tone={tile.tone ?? "account"} badge={negative ? "negative" : undefined} label={accountTileLabel(tile)} pressed={pressed} onClick={onPick} drag={drag} tileKey={`account:${tile.id}`}>
      <span className="tile-name" aria-hidden="true"><bdi dir="auto">{softHyphenate(tile.name)}</bdi></span>
      <span className="tile-sum" aria-hidden="true">{tile.balanceMinor === null ? "—" : <Money value={tile.balanceMinor} currency={tile.currency} />}</span>
      {!tile.includeInTotal ? <small className="tile-note" aria-hidden="true">вне итога</small> : tile.unvalued ? <small className="tile-note" aria-hidden="true">нет курса</small> : null}
    </Tile>
  );
}
