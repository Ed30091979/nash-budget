import { Icon } from "../../components/Icon";
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
 * Карточки «откуда → куда» наверху листа (DESIGN 5.0 §6, макет 07): подложка 40 с глифом — графит
 * счёта или тон категории, — над именем короткое «Со счёта» / «В категорию». Каждая — кнопка, которая
 * открывает выбор этой стороны; доступное имя называет и сторону, и то, что выбрано. Остаток счёта
 * лист называет строкой «останется» под суммой, а не мелкой цифрой на карточке.
 */
export function FromToTiles({ budget, draft, onPick }: {
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

  const categoryVisualOf = (value: ReturnType<typeof category>) => value === undefined ? { icon: "tag" as const, tone: "neutral" as const } : categoryVisual(value);

  const tile = (side: EndpointSide) => {
    const isAccount = side === "from" ? fromIsAccount : toIsAccount;
    const value = side === "from" ? names.from : names.to;
    const word = side === "from" ? words.from : words.to;
    const pickable = sidePickable(draft, side);
    const chosenAccount = side === "from" ? fromAccount : toAccount;
    const visual = categoryVisualOf(side === "from" ? fromCategory : toCategory);
    const plate = isAccount ? "account" : `tone-${visual.tone}`;
    const glyph = isAccount ? (chosenAccount === undefined ? "wallet" : accountIcon(chosenAccount)) : visual.icon;
    // Имя — с мягкими переносами, как на любой плитке (ревью 2b, раунд 3, NEW-2), и потому только для
    // глаза: что выбрано, диктор слышит из доступного имени, где U+00AD нет.
    const content = <>
      <span className={`endpoint-plate ${plate}`} aria-hidden="true"><Icon name={glyph} size={24} /></span>
      <span className="endpoint-copy">
        <span className="endpoint-word" aria-hidden="true">{word}</span>
        <span className="endpoint-name" aria-hidden="true"><bdi dir="auto">{softHyphenate(value)}</bdi></span>
      </span>
    </>;
    return pickable
      ? <button className="endpoint" type="button" data-side={side} aria-label={`${word}: ${value}. Изменить`} onClick={() => onPick(side)}>{content}</button>
      : <div className="endpoint fixed" role="group" aria-label={`${word}: ${value}`}>{content}</div>;
  };

  return (
    <div className="from-to">
      {tile("from")}
      <span className="from-to-arrow" aria-hidden="true"><Icon name="chevron-right" size={24} /></span>
      {tile("to")}
    </div>
  );
}
