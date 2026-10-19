import { DEFAULT_BASE_CURRENCY } from "@family-budget/domain";
import { Icon } from "../Icon";
import { Money, useBaseCurrency } from "../Money";
import { formatMoney } from "../../money";
import type { IncomeTile as IncomeTileModel } from "../../features/overview/overview-model";
import { Tile, type TileDrag } from "./Tile";

/** Доступное имя источника дохода: имя, доход месяца и что делать дальше. */
export function incomeTileLabel(tile: IncomeTileModel, monthWord: string, currency: string = DEFAULT_BASE_CURRENCY): string {
  return `${tile.name}: ${formatMoney(tile.amountMinor, currency)} за ${monthWord}. Затем выберите счёт`;
}

/** Плитка источника дохода — сиреневая, 64 × 104: имя чернилами дохода, сумма месяца. */
export function IncomeTile({ tile, monthWord, pressed, onPick, drag }: { readonly tile: IncomeTileModel; readonly monthWord: string; readonly pressed: boolean; readonly onPick: () => void; readonly drag?: TileDrag }) {
  const currency = useBaseCurrency();
  return (
    <Tile variant="income" label={incomeTileLabel(tile, monthWord, currency)} pressed={pressed} onClick={onPick} drag={drag} tileKey={`income:${tile.id ?? "none"}`}>
      <span className="tile-label" aria-hidden="true"><Icon name={tile.icon} size={20} /><span className="tile-name">{tile.name}</span></span>
      <span className="tile-sum" aria-hidden="true"><Money value={tile.amountMinor} /></span>
    </Tile>
  );
}
