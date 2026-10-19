/**
 * Касания плиток «Обзора» — чистый автомат (план волны 2, §1.1; DESIGN §9).
 *
 * Плитка — это «откуда» или «куда». Касание категории записывает расход; счёт сначала выбирается,
 * и следующее касание решает, что с ним делать: категория — расход с этого счёта, другой счёт —
 * перевод, тот же счёт — снять выбор. Источник дохода выбирается так же, и счёт после него — доход
 * на этот счёт. Esc сбрасывает выбор. Перетаскивание (только при точном указателе) идёт через те же
 * переходы: «взять» — касание источника, «отпустить» — касание цели.
 *
 * Автомат не знает ни бюджета, ни экрана: он получает касание и отвечает новым выбором, просьбой
 * открыть лист ввода и подсказкой — словами для `role="status"`.
 */

/** Плитка «Обзора», которой можно коснуться. Доход без категории — `incomeId: null` (D-026). */
export type PickTile =
  | { readonly kind: "account"; readonly id: string }
  | { readonly kind: "income"; readonly id: string | null }
  | { readonly kind: "category"; readonly id: string };

/** Что выбрано и ждёт второго касания. */
export type PickSelection =
  | { readonly kind: "account"; readonly id: string }
  | { readonly kind: "income"; readonly id: string | null };

export interface PickState {
  readonly selected: PickSelection | null;
}

/** Просьба открыть лист ввода: что записать и между какими плитками. */
export type SheetRequest =
  | { readonly kind: "expense"; readonly accountId: string | null; readonly categoryId: string }
  | { readonly kind: "income"; readonly categoryId: string | null; readonly accountId: string }
  | { readonly kind: "transfer"; readonly fromAccountId: string; readonly toAccountId: string };

export type PickEvent =
  | { readonly type: "tap"; readonly tile: PickTile }
  | { readonly type: "escape" }
  /** Перетаскивание: источник — плитка, которую взяли, цель — на которую отпустили. */
  | { readonly type: "drop"; readonly source: PickTile; readonly target: PickTile };

export interface PickResult {
  readonly state: PickState;
  /** Открыть лист — выбор при этом уже сброшен. */
  readonly open: SheetRequest | null;
}

export const PICK_IDLE: PickState = { selected: null };

/** Счёт, с которого записывается расход, если счёт не выбран: основной — его называет экран. */
export interface PickContext {
  readonly defaultAccountId: string | null;
}

function same(left: PickSelection, right: PickTile): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function tap(state: PickState, tile: PickTile, context: PickContext): PickResult {
  const selected = state.selected;
  switch (tile.kind) {
    case "category":
      // Категория — всегда расход: со счёта, который выбран, иначе с основного.
      return {
        state: PICK_IDLE,
        open: { kind: "expense", accountId: selected?.kind === "account" ? selected.id : context.defaultAccountId, categoryId: tile.id },
      };
    case "income":
      // Тот же источник ещё раз — снять выбор; любой другой выбор он заменяет.
      if (selected !== null && same(selected, tile)) return { state: PICK_IDLE, open: null };
      return { state: { selected: { kind: "income", id: tile.id } }, open: null };
    case "account": {
      if (selected === null) return { state: { selected: { kind: "account", id: tile.id } }, open: null };
      if (selected.kind === "income") {
        return { state: PICK_IDLE, open: { kind: "income", categoryId: selected.id, accountId: tile.id } };
      }
      if (selected.id === tile.id) return { state: PICK_IDLE, open: null };
      return { state: PICK_IDLE, open: { kind: "transfer", fromAccountId: selected.id, toAccountId: tile.id } };
    }
  }
}

/** Один шаг автомата. */
export function pick(state: PickState, event: PickEvent, context: PickContext): PickResult {
  switch (event.type) {
    case "escape":
      return { state: PICK_IDLE, open: null };
    case "tap":
      return tap(state, event.tile, context);
    case "drop": {
      // Перетаскивание — те же два касания с чистого листа: взятая плитка, затем цель. Плитку,
      // которую нельзя взять (категорию), перетаскивание не начинает вовсе.
      if (event.source.kind === "category") return { state, open: null };
      const taken = tap(PICK_IDLE, event.source, context);
      if (taken.open !== null) return taken;
      return tap(taken.state, event.target, context);
    }
  }
}

/** Можно ли начать перетаскивание с этой плитки: «откуда» — счёт или доход, но не категория. */
export function isDragSource(tile: PickTile): boolean {
  return tile.kind !== "category";
}

/**
 * Подсказка под рядом плиток — что сейчас выбрано и что сделает следующее касание. Имена не
 * склоняются: они стоят в кавычках рядом с рамочным словом.
 */
export function pickHint(state: PickState, names: { readonly account: (id: string) => string; readonly income: (id: string | null) => string }): string {
  const selected = state.selected;
  if (selected === null) return "Коснитесь категории, чтобы записать расход. Счёт, а затем категория или другой счёт — расход с него или перевод.";
  if (selected.kind === "account") {
    return `Выбран счёт «${names.account(selected.id)}». Теперь категория — расход с него, другой счёт — перевод, этот же счёт — снять выбор.`;
  }
  return `Выбран доход «${names.income(selected.id)}». Теперь счёт, на который он пришёл.`;
}

/** Выбрана ли плитка: `aria-pressed`, галочка и кольцо. */
export function isPicked(state: PickState, tile: PickTile): boolean {
  return state.selected !== null && tile.kind !== "category" && same(state.selected, tile);
}
