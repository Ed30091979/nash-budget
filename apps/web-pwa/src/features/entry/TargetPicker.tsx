import { useEffect, useRef } from "react";
import type { BudgetState } from "@family-budget/domain";
import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import { accountIcon, categoryVisual } from "../../category-visual";
import { AddTile } from "../../components/tiles/AddTile";
import { softHyphenate } from "../../hyphenation";
import { formatMoney } from "../../money";
import { UNCATEGORIZED_INCOME_NAME } from "../overview/overview-model";
import type { EntryDraft } from "./entry-model";
import type { EndpointSide } from "./FromToTiles";

interface PickOption {
  readonly id: string;
  readonly name: string;
  readonly tone: string;
  readonly icon: Parameters<typeof Icon>[0]["name"];
  readonly balance?: { readonly minor: number; readonly currency: string };
}

/** Что можно выбрать стороной `side` у этого вида: активные счета или категории нужного типа. */
export function pickOptions(budget: BudgetState, draft: EntryDraft, side: EndpointSide, balances: Readonly<Record<string, number | null>>): readonly PickOption[] {
  const accounts = (except: string): PickOption[] => budget.accounts
    .filter((account) => account.active && account.id !== except)
    .map((account) => {
      const minor = balances[account.id];
      return { id: account.id, name: account.name, tone: "tile-account", icon: accountIcon(account), ...(minor === null || minor === undefined ? {} : { balance: { minor, currency: account.currency } }) };
    });
  const categories = (type: "expense" | "income"): PickOption[] => budget.categories
    .filter((category) => category.active && category.type === type)
    .map((category) => {
      const visual = categoryVisual(category);
      return { id: category.id, name: category.name, tone: `tone-${visual.tone}`, icon: visual.icon };
    });
  switch (draft.mode) {
    case "expense": return side === "from" ? accounts("") : categories("expense");
    case "income": return side === "from" ? [...categories("income"), { id: "", name: UNCATEGORIZED_INCOME_NAME, tone: "tone-neutral", icon: "banknote" }] : accounts("");
    case "transfer": return side === "from" ? accounts(draft.toAccountId) : accounts(draft.accountId);
    case "refund": return side === "to" ? accounts("") : [];
  }
}

/**
 * Доступное имя плитки выбора: имя целиком, у счёта — и остаток, как на «Обзоре». Имя на самой
 * плитке — с мягкими переносами и скрыто от диктора: в доступное имя U+00AD не попадает.
 */
export function pickOptionLabel(option: PickOption): string {
  return option.balance === undefined ? option.name : `${option.name}: остаток ${formatMoney(option.balance.minor, option.balance.currency)}`;
}

/** Какую категорию можно завести прямо из выбора стороны: расходную — «куда», источник дохода — «откуда». */
export function creatableCategory(draft: EntryDraft, side: EndpointSide): "expense" | "income" | null {
  if (draft.mode === "expense" && side === "to") return "expense";
  if (draft.mode === "income" && side === "from") return "income";
  return null;
}

/** Выбранное сейчас значение стороны. */
export function pickedValue(draft: EntryDraft, side: EndpointSide): string {
  switch (draft.mode) {
    case "expense": return side === "from" ? draft.accountId : draft.categoryId;
    case "income": return side === "from" ? draft.incomeCategoryId : draft.accountId;
    case "transfer": return side === "from" ? draft.accountId : draft.toAccountId;
    case "refund": return side === "to" ? draft.accountId : "";
  }
}

/** Черновик с новым значением стороны. */
export function withPicked(draft: EntryDraft, side: EndpointSide, id: string): EntryDraft {
  switch (draft.mode) {
    case "expense": return side === "from" ? { ...draft, accountId: id, baseAmount: "" } : { ...draft, categoryId: id };
    case "income": return side === "from" ? { ...draft, incomeCategoryId: id } : { ...draft, accountId: id, baseAmount: "" };
    case "transfer": return side === "from" ? { ...draft, accountId: id, toAmount: "" } : { ...draft, toAccountId: id, toAmount: "" };
    case "refund": return side === "to" ? { ...draft, accountId: id, baseAmount: "" } : draft;
  }
}

/**
 * Выбор стороны операции внутри листа: плитки счетов или категорий, выбранная — нажатой. Фокус — на
 * первой плитке; «Назад» и Esc возвращают к листу, ничего не меняя.
 */
export function TargetPicker({ budget, draft, side, balances, onPick, onBack, onCreate }: {
  readonly budget: BudgetState;
  readonly draft: EntryDraft;
  readonly side: EndpointSide;
  readonly balances: Readonly<Record<string, number | null>>;
  readonly onPick: (id: string) => void;
  readonly onBack: () => void;
  /** «Своя категория» — последней плиткой, где сторона — категория. */
  readonly onCreate?: () => void;
}) {
  const creatable = creatableCategory(draft, side);
  const options = pickOptions(budget, draft, side, balances);
  const current = pickedValue(draft, side);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const title = side === "from"
    ? (draft.mode === "income" ? "Откуда доход" : "С какого счёта")
    : (draft.mode === "expense" ? "В какую категорию" : "На какой счёт");
  return (
    <section className="target-picker" aria-labelledby="entry-picker-title">
      <div className="target-picker-head">
        <button className="secondary-button back-button" type="button" onClick={onBack}><Icon name="arrow-left" size={20} />Назад</button>
        <h3 id="entry-picker-title">{title}</h3>
      </div>
      {options.length === 0 && creatable === null ? <p className="field-hint">Выбирать не из чего: активных счетов или категорий нет.</p> : (
        <ul className="tile-grid tile-grid-grid picker-grid">
          {options.map((option, index) => (
            <li key={option.id === "" ? "none" : option.id}>
              <button
                ref={index === 0 ? first : undefined}
                className={`tile pick-option ${option.tone}${option.id === current ? " picked" : ""}`}
                type="button"
                aria-label={pickOptionLabel(option)}
                aria-pressed={option.id === current}
                onClick={() => onPick(option.id)}
              >
                <span className="tile-top"><span className="tile-glyph" aria-hidden="true"><Icon name={option.icon} size={20} /></span></span>
                {/* Ревью 2b, раунд 3, NEW-2: имя в выборе — с теми же мягкими переносами, что и на «Обзоре». */}
                <span className="tile-name" aria-hidden="true"><bdi dir="auto">{softHyphenate(option.name)}</bdi></span>
                {option.balance ? <span className="tile-sum" aria-hidden="true"><Money value={option.balance.minor} currency={option.balance.currency} /></span> : null}
                {option.id === current ? <span className="tile-check" aria-hidden="true"><Icon name="check" size={20} /></span> : null}
              </button>
            </li>
          ))}
          {creatable !== null && onCreate !== undefined ? (
            <li key="add"><AddTile label={creatable === "expense" ? "Своя категория расходов" : "Свой источник дохода"} onClick={onCreate} /></li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
