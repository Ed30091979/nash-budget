import { DEFAULT_BASE_CURRENCY } from "@family-budget/domain";
import { Money, useBaseCurrency } from "../Money";
import { softHyphenate } from "../../hyphenation";
import { formatMoney } from "../../money";
import type { IncomeTile as IncomeTileModel } from "../../features/overview/overview-model";
import { Tile, TileSquare, type TileDrag } from "./Tile";

/** Доступное имя источника дохода: имя, доход месяца и что делать дальше. */
export function incomeTileLabel(tile: IncomeTileModel, monthWord: string, currency: string = DEFAULT_BASE_CURRENCY): string {
  return `${tile.name}: ${formatMoney(tile.amountMinor, currency)} за ${monthWord}. Затем выберите счёт`;
}

/** Доступное имя источника в архиве: имя, что он в архиве, и доход месяца. */
export function archivedIncomeLabel(tile: IncomeTileModel, monthWord: string, currency: string = DEFAULT_BASE_CURRENCY): string {
  return `${tile.name}, в архиве: ${formatMoney(tile.amountMinor, currency)} за ${monthWord}`;
}

/**
 * Источник в архиве с доходом этого месяца — итог, а не кнопка (ревью 2b, LOW-7): доход месяца
 * виден, но касание ничего не открывает — в архивный источник новый доход не записывают.
 */
export function ArchivedIncomeTile({ tile, monthWord }: { readonly tile: IncomeTileModel; readonly monthWord: string }) {
  const currency = useBaseCurrency();
  return (
    <div className="tile tile-income tile-static" role="group" aria-label={archivedIncomeLabel(tile, monthWord, currency)}>
      <TileSquare icon={tile.icon} tone={tile.tone} />
      <span className="tile-name" aria-hidden="true"><bdi dir="auto">{softHyphenate(tile.name)}</bdi></span>
      <span className="tile-sum" aria-hidden="true"><Money value={tile.amountMinor} /></span>
      <small className="tile-note" aria-hidden="true">в архиве</small>
    </div>
  );
}

/** Плитка источника дохода: квадрат тона своей категории (своего цвета у дохода нет), имя, доход месяца. */
export function IncomeTile({ tile, monthWord, pressed, onPick, drag }: { readonly tile: IncomeTileModel; readonly monthWord: string; readonly pressed: boolean; readonly onPick: () => void; readonly drag?: TileDrag }) {
  const currency = useBaseCurrency();
  return (
    <Tile variant="income" icon={tile.icon} tone={tile.tone} label={incomeTileLabel(tile, monthWord, currency)} pressed={pressed} onClick={onPick} drag={drag} tileKey={`income:${tile.id ?? "none"}`}>
      <span className="tile-name" aria-hidden="true"><bdi dir="auto">{softHyphenate(tile.name)}</bdi></span>
      <span className="tile-sum" aria-hidden="true"><Money value={tile.amountMinor} /></span>
    </Tile>
  );
}
