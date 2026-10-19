import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import type { BudgetState } from "@family-budget/domain";
import { accountIcon, categoryVisual } from "../../category-visual";
import { softHyphenate } from "../../hyphenation";
import { endpoints, type EntryDraft } from "./entry-model";

/** Какая сторона операции выбирается: «откуда» или «куда». */
export type EndpointSide = "from" | "to";

function sideWords(draft: EntryDraft): { readonly from: string; readonly to: string } {
  switch (draft.mode) {
    case "expense": return { from: "Со счёта", to: "В категорию" };
    case "income": return { from: "Доход", to: "На счёт" };
    case "transfer": return { from: "Со счёта", to: "На счёт" };
    case "refund": return { from: "Возврат из категории", to: "На счёт" };
  }
}

/** Можно ли сменить сторону в листе: у возврата категория — от исходного расхода, её не меняют. */
export function sidePickable(draft: EntryDraft, side: EndpointSide): boolean {
  return !(draft.mode === "refund" && side === "from");
}

/**
 * Плитки «откуда → куда» наверху листа: счёт — тёмной плиткой с остатком, категория — своим тоном.
 * Каждая — кнопка, которая открывает выбор этой стороны; доступное имя называет и сторону, и то, что
 * выбрано.
 */
export function FromToTiles({ budget, draft, balances, onPick }: {
  readonly budget: BudgetState;
  readonly draft: EntryDraft;
  /** Остатки счетов — накопленные, в валюте счёта. */
  readonly balances: Readonly<Record<string, number | null>>;
  readonly onPick: (side: EndpointSide) => void;
}) {
  const names = endpoints(budget, draft);
  const words = sideWords(draft);
  const account = (id: string) => budget.accounts.find((item) => item.id === id);
  const category = (id: string) => budget.categories.find((item) => item.id === id);
  const fromIsAccount = draft.mode !== "income" && draft.mode !== "refund";
  const toIsAccount = draft.mode !== "expense";
  const fromAccount = fromIsAccount ? account(draft.accountId) : undefined;
  const toAccount = draft.mode === "transfer" ? account(draft.toAccountId) : toIsAccount ? account(draft.accountId) : undefined;
  const refundCategory = draft.mode === "refund"
    ? (() => { const original = budget.transactions.find((item) => item.id === draft.originalTransactionId); return original?.kind === "expense" ? category(original.categoryId) : undefined; })()
    : undefined;
  const fromCategory = draft.mode === "income" ? category(draft.incomeCategoryId) : refundCategory;
  const toCategory = draft.mode === "expense" ? category(draft.categoryId) : undefined;

  const accountFace = (value: ReturnType<typeof account>) => value === undefined ? null : <>
    <Icon name={accountIcon(value)} size={20} />
    {balances[value.id] === null || balances[value.id] === undefined ? null : <small className="endpoint-balance" aria-hidden="true"><Money value={balances[value.id] ?? 0} currency={value.currency} /></small>}
  </>;
  const categoryTone = (value: ReturnType<typeof category>) => value === undefined ? "neutral" : categoryVisual(value).tone;

  const tile = (side: EndpointSide) => {
    const isAccount = side === "from" ? fromIsAccount : toIsAccount;
    const value = side === "from" ? names.from : names.to;
    const word = side === "from" ? words.from : words.to;
    const pickable = sidePickable(draft, side);
    const tone = isAccount ? "tile-account" : `tone-${categoryTone(side === "from" ? fromCategory : toCategory)}`;
    // Имя — с мягкими переносами, как на любой плитке (ревью 2b, раунд 3, NEW-2), и потому только для
    // глаза: что выбрано, диктор слышит из доступного имени, где U+00AD нет.
    const content = <>
      <span className="endpoint-word" aria-hidden="true">{word}</span>
      <span className="endpoint-name" aria-hidden="true"><bdi dir="auto">{softHyphenate(value)}</bdi></span>
      {isAccount ? accountFace(side === "from" ? fromAccount : toAccount) : null}
    </>;
    return pickable
      ? <button className={`tile endpoint ${tone}`} type="button" data-side={side} aria-label={`${word}: ${value}. Изменить`} onClick={() => onPick(side)}>{content}</button>
      : <div className={`endpoint fixed ${tone}`} role="group" aria-label={`${word}: ${value}`}>{content}</div>;
  };

  return (
    <div className="from-to">
      {tile("from")}
      <span className="from-to-arrow" aria-hidden="true"><Icon name="chevron-right" size={24} /></span>
      {tile("to")}
    </div>
  );
}
