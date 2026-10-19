import type { DocumentHold } from "@family-budget/sync-client";
import { holdWriteRefusal } from "../features/family/model";
import { parentRoute, ROOT_ROUTE, type Route } from "../navigation/routes";
import { WRITE_REFUSAL_TEXT } from "../write-refusal";

/**
 * While the family document is held the device only reads (docs/SECURITY.md §7.1), and a form
 * that writes the budget is not opened at all: a person would fill it in only to be refused at
 * «Записать» (review of 2a, finding 6). The refusal is said where the form would have opened, with
 * the way to the family screen, where the hold is explained.
 */

/** The routes whose screen is a form that writes the budget: «+» and its edit, the month plan, the statement. */
export function opensWriteForm(route: Route): boolean {
  return route.name === "entry" || route.name === "plan-month" || route.name === "import";
}

export interface WriteFormRefusal {
  /** The same words a refused write shows. */
  readonly message: string;
  /** Where an arrival at the form goes instead (a typed address, Back or Forward, a link). */
  readonly fallback: Route;
}

/** What to do instead of opening `route` while `hold` is in force, or `null` when it may open. */
export function writeFormRefusal(hold: DocumentHold | null, route: Route): WriteFormRefusal | null {
  if (hold === null || !opensWriteForm(route)) return null;
  return { message: WRITE_REFUSAL_TEXT[holdWriteRefusal(hold)], fallback: parentRoute(route) ?? ROOT_ROUTE };
}

/** The toast's way out: the family screen names the hold and what lifts it. */
export const HOLD_DETAILS_LABEL = "Подробнее в «Семье»";
