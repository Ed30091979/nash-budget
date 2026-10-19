import { useMemo, useState } from "react";
import { moveCategory, type BudgetState, type CategoryType } from "@family-budget/domain";
import { TitleBar, TitleBarAction } from "../../components/TitleBar";
import { useFocusAfterRender } from "../../components/focus-after-render";
import { Icon } from "../../components/Icon";
import { Money, useBaseCurrency } from "../../components/Money";
import { ReorderList, stepsBetween, type ReorderDirection } from "../../components/ReorderControls";
import { AddTile } from "../../components/tiles/AddTile";
import { Tile } from "../../components/tiles/Tile";
import { TileGrid } from "../../components/tiles/TileGrid";
import { softHyphenate } from "../../hyphenation";
import { formatMoney } from "../../money";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { AddCategorySheet } from "../overview/AddCategorySheet";
import { categoriesView, categoryFormError, categoryPositionWords, planMonthWord, restoreCategory, type CategoryCard } from "./category-model";

export interface CategoriesScreenProps {
  readonly budget: BudgetState;
  readonly type: CategoryType;
  readonly write: BudgetWriter;
  readonly onBack: () => void;
  readonly onType: (type: CategoryType) => void;
  readonly onOpen: (categoryId: string) => void;
  readonly onMessage: (message: string) => void;
  /** Экран под листом категории: та же картинка под затемнением, без строки состояния. */
  readonly background?: boolean;
}

/** Доступное имя плитки: имя, лимит месяца плана и что сделает касание. */
export function categoryCardLabel(card: CategoryCard, currency: string, month: string | null): string {
  if (card.category.type === "income") return `${card.category.name}. Изменить`;
  const limit = card.limitMinor === null ? "без лимита" : `лимит ${formatMoney(card.limitMinor, currency)}${month === null ? "" : ` на ${month}`}`;
  return `${card.category.name}: ${limit}. Изменить`;
}

/**
 * «Категории и доходы» (дизайн 5.0, макет 13): чипы «Расходы / Доходы», расходы — сетками плиток
 * по группам в порядке D-041 («Каждый день» первой), доходы — одной сеткой. Плитка — анатомия
 * «Обзора»: квадрат тона с глифом, имя, лимит месяца плана и карандаш в углу; касание открывает лист
 * категории. Последняя плитка — «+ Своя» (лист «Своя категория»), а не чёрная кнопка над сеткой.
 * Порядок в группе — режимом «Изменить порядок»; архив ниже, с «Вернуть». Удаления нет (D-030).
 */
export function CategoriesScreen({ budget, type, write, onBack, onType, onOpen, onMessage, background = false }: CategoriesScreenProps) {
  const currency = useBaseCurrency();
  const view = useMemo(() => categoriesView(budget, type), [budget, type]);
  const month = planMonthWord(budget);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [ordering, setOrdering] = useState(false);
  const canOrder = view.groups.some((group) => group.cards.length > 1);
  const reordering = ordering && canOrder;
  // Возвращённая категория уходит из архива в сетку: фокус — на её плитку (ревью 2c, MEDIUM-3).
  const focusAfterRender = useFocusAfterRender();
  const run = async (change: (state: BudgetState) => BudgetState, done: string, then?: Parameters<typeof focusAfterRender>[0]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await write.run(change);
      setStatus(done);
      if (then !== undefined) focusAfterRender(then);
    } catch (cause) {
      setError(categoryFormError(cause).message);
    } finally {
      setBusy(false);
    }
  };
  const restore = (card: CategoryCard) => run(
    (state) => restoreCategory(state, card.category.id),
    `«${card.category.name}» снова на «Обзоре» и в выборе.`,
    { selector: `[data-tile="manage-category:${card.category.id}"]` },
  );
  const find = (id: string) => {
    for (const group of view.groups) {
      const index = group.cards.findIndex((card) => card.category.id === id);
      if (index >= 0) return { card: group.cards[index]!, index, count: group.cards.length };
    }
    return null;
  };
  const move = (id: string, direction: ReorderDirection) => {
    const found = find(id);
    if (found === null) return undefined;
    const place = direction === "up" ? found.index : found.index + 2;
    return run((state) => moveCategory(state, id, direction), `«${found.card.category.name}» — теперь ${categoryPositionWords(found.card.category, place, found.count)} в группе.`);
  };
  const moveTo = (id: string, to: number) => {
    const found = find(id);
    if (found === null) return undefined;
    const steps = stepsBetween(found.index, to);
    return run((state) => steps.reduce((next, step) => moveCategory(next, id, step), state), `«${found.card.category.name}» — теперь ${categoryPositionWords(found.card.category, to + 1, found.count)} в группе.`);
  };
  const toggleOrder = () => {
    if (busy) return;
    setOrdering(!reordering);
    setError(null);
    setStatus(reordering ? "" : "Стрелки меняют место плитки в группе на «Обзоре» и в выборе.");
  };
  const income = type === "income";
  const newLabel = income ? "Новый источник дохода" : "Новая категория";
  const last = view.groups.length - 1;
  return (
    <div className="manage-screen dir-screen categories-screen">
      <TitleBar back={{ label: "Ещё", onClick: onBack }} title="Категории и доходы" action={<TitleBarAction icon="plus" label={newLabel} onClick={() => setAdding(true)} />} />
      <div className="chip-row" role="group" aria-label="Какой список показать">
        <button className="chip" type="button" aria-pressed={!income} onClick={() => onType("expense")}><span className="chip-face">Расходы</span></button>
        <button className="chip" type="button" aria-pressed={income} onClick={() => onType("income")}><span className="chip-face">Доходы</span></button>
      </div>
      {background ? null : <p className="manage-status" role="status">{status}</p>}
      {background || error === null ? null : <p className="field-error" role="alert">{error}</p>}

      {view.groups.map((group, index) => (
        <section key={group.key} className="dir-group" aria-labelledby={`categories-${group.key}`}>
          {/* У доходов группа одна — её имя повторило бы чип «Доходы». */}
          <h2 id={`categories-${group.key}`} className={view.groups.length > 1 ? "dir-kicker" : "sr-only"}>{group.title}</h2>
          {reordering ? (
            group.cards.length === 0 ? <p className="field-hint dir-hint">В этой группе пока ничего нет.</p> : (
              <ReorderList
                idPrefix="category"
                label={`Порядок: ${group.title}`}
                items={group.cards.map((card) => ({
                  id: card.category.id,
                  name: card.category.name,
                  plate: <span className={`icon-plate dir-plate tone-${card.visual.tone}`} aria-hidden="true"><Icon name={card.visual.icon} size={24} /></span>,
                }))}
                busy={busy}
                onMove={move}
                onMoveTo={moveTo}
              />
            )
          ) : (
            <TileGrid label={group.title} layout="grid">
              {[
                ...group.cards.map((card) => (
                  <Tile
                    key={card.category.id}
                    variant={income ? "income" : "expense"}
                    icon={card.visual.icon}
                    tone={card.visual.tone}
                    badge="edit"
                    label={categoryCardLabel(card, currency, month)}
                    onClick={() => onOpen(card.category.id)}
                    tileKey={`manage-category:${card.category.id}`}
                  >
                    <span className="tile-name" aria-hidden="true"><bdi dir="auto">{softHyphenate(card.category.name)}</bdi></span>
                    {/* Анатомия плитки «Обзора»: под именем сумма — здесь лимит месяца плана, — и подпись. */}
                    {income ? null : card.limitMinor === null
                      ? <span className="tile-limit" aria-hidden="true">без лимита</span>
                      : <><span className="tile-sum" aria-hidden="true"><Money value={card.limitMinor} /></span><span className="tile-limit" aria-hidden="true">лимит</span></>}
                  </Tile>
                )),
                // «+ Своя» — последней плиткой последней группы, как на «Обзоре» (макет 13).
                ...(index === last ? [<AddTile key="add" label={income ? "Свой источник дохода" : "Своя категория"} caption={income ? "Свой" : "Своя"} onClick={() => setAdding(true)} />] : []),
              ]}
            </TileGrid>
          )}
        </section>
      ))}
      {canOrder ? (
        <button className="quiet-button dir-mode" type="button" aria-disabled={busy || undefined} onClick={toggleOrder}>
          <span className="icon-label"><Icon name={reordering ? "check" : "arrow-up-down"} size={24} />{reordering ? "Готово" : "Изменить порядок"}</span>
        </button>
      ) : null}

      {view.archived.length === 0 || reordering ? null : (
        <section className="dir-group" aria-labelledby="categories-archived">
          <h2 id="categories-archived" className="dir-kicker">В архиве</h2>
          <ul className="card dir-card">
            {view.archived.map((card) => (
              <li key={card.category.id} className="dir-archived">
                <button className="dir-row" type="button" aria-label={`${card.category.name}, в архиве. Изменить`} onClick={() => onOpen(card.category.id)}>
                  <span className={`icon-plate dir-plate tone-${card.visual.tone}`} aria-hidden="true"><Icon name={card.visual.icon} size={24} /></span>
                  <span className="dir-copy" aria-hidden="true"><strong><bdi dir="auto">{softHyphenate(card.category.name)}</bdi></strong><small>в архиве</small></span>
                </button>
                <button className="quiet-button dir-restore" type="button" aria-disabled={busy || undefined} aria-label={`Вернуть «${card.category.name}» из архива`} onClick={() => void restore(card)}>Вернуть</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {adding ? (
        <AddCategorySheet
          budget={budget}
          type={type}
          onChange={(change) => write.run(change)}
          onDone={(_id, name) => {
            setAdding(false);
            onMessage(income ? `Источник дохода «${name}» добавлен.` : `Категория «${name}» добавлена.`);
          }}
          onChoose={(id) => {
            setAdding(false);
            onOpen(id);
          }}
          onClose={() => setAdding(false)}
          description={income ? "Новый источник встанет плиткой в «Доходы» и в выбор при записи дохода." : "Новая категория встанет плиткой в «Расходы». Лимит можно задать сейчас или позже, в её листе."}
        />
      ) : null}
    </div>
  );
}
