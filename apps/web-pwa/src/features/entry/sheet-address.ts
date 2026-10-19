import { isUuid, type BudgetState, type Transaction } from "@family-budget/domain";
import { sameRecordId, type Route, type SheetFields } from "../../navigation/routes";
import type { SheetRequest } from "../overview/pick-model";
import { blankEntryDraft, newEntryDraft, switchMode, type EntryDraft } from "./entry-model";

/**
 * Лист ввода в адресе (`routes.ts`, SECURITY §7.3): вид и непрозрачные идентификаторы плиток — и
 * больше ничего. Здесь касание плиток становится ключами адреса, а ключи адреса — черновиком.
 *
 * Расход: `src` — счёт (без него — основной), `dst` — категория. Доход: `src` — источник (без него —
 * «Без категории»), `dst` — счёт. Перевод: `src` и `dst` — счета.
 */

/** Ключи листа без самого `sheet`: то, что оболочка кладёт рядом с `sheet=entry`. */
export type SheetOpening = Omit<SheetFields, "sheet">;

/** Идентификатор — в адрес, только если это UUID: свободный текст туда не попадает никогда. */
function idField<K extends "src" | "dst">(key: K, id: string | null): Partial<Record<K, string>> {
  return id !== null && isUuid(id) ? { [key]: id.toLowerCase() } as Partial<Record<K, string>> : {};
}

/** Касания плиток «Обзора» — ключами адреса. */
export function sheetOpeningOf(request: SheetRequest): SheetOpening {
  switch (request.kind) {
    case "expense":
      return { op: "expense", ...idField("src", request.accountId), ...idField("dst", request.categoryId) };
    case "income":
      return { op: "income", ...idField("src", request.categoryId), ...idField("dst", request.accountId) };
    case "transfer":
      return { op: "transfer", ...idField("src", request.fromAccountId), ...idField("dst", request.toAccountId) };
  }
}

/** Операция, открытая для правки, — ключом адреса; идентификатор не UUID в адрес не идёт. */
export function sheetEditOf(transaction: Pick<Transaction, "id">): SheetOpening | null {
  return isUuid(transaction.id) ? { edit: transaction.id.toLowerCase() } : null;
}

/** Хранимый идентификатор по адресному: адрес пишет строчными, бюджет хранит как пришло. */
function storedId<T extends { readonly id: string; readonly active: boolean }>(items: readonly T[], routed: string | undefined, accept: (item: T) => boolean = () => true): string | null {
  if (routed === undefined) return null;
  return items.find((item) => item.active && accept(item) && sameRecordId(item.id, routed))?.id ?? null;
}

/**
 * Черновик открытия по адресу листа. Чего в бюджете нет (счёт закрыт, категорию удалили на другом
 * устройстве), то лист не подставляет: он открывается с тем видом, который назван, и с основным
 * счётом, а «куда» выбирают в нём.
 */
export function draftOfSheet(state: BudgetState, route: Route, today: string): EntryDraft {
  const account = (routed: string | undefined) => storedId(state.accounts, routed);
  const category = (routed: string | undefined, type: "expense" | "income") => storedId(state.categories, routed, (item) => item.type === type);
  switch (route.op) {
    case undefined:
      return blankEntryDraft(state, "expense", today);
    case "expense": {
      const categoryId = category(route.dst, "expense");
      const accountId = account(route.src);
      if (categoryId === null) {
        const blank = blankEntryDraft(state, "expense", today);
        return accountId === null ? blank : { ...blank, accountId };
      }
      return newEntryDraft(state, { kind: "expense", accountId, categoryId }, today);
    }
    case "income": {
      const accountId = account(route.dst);
      const categoryId = category(route.src, "income");
      if (accountId === null) {
        const blank = blankEntryDraft(state, "income", today);
        return { ...blank, incomeCategoryId: categoryId ?? "" };
      }
      return newEntryDraft(state, { kind: "income", categoryId, accountId }, today);
    }
    case "transfer": {
      const from = account(route.src);
      const to = account(route.dst);
      if (from === null || to === null || from === to) {
        // Названный конец остаётся, второй — первый другой активный счёт, как при смене вида.
        const start = blankEntryDraft(state, "expense", today);
        const transfer = switchMode(state, { ...start, accountId: from ?? start.accountId }, "transfer");
        return to !== null && to !== transfer.accountId ? { ...transfer, toAccountId: to } : transfer;
      }
      return newEntryDraft(state, { kind: "transfer", fromAccountId: from, toAccountId: to }, today);
    }
  }
}

/** Лист открыт «+»: вид не назван, его выбирают в листе. */
export function sheetChoosesMode(route: Route): boolean {
  return route.op === undefined && route.edit === undefined;
}
