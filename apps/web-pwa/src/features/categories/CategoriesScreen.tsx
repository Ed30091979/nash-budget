import { useMemo, useState } from "react";
import type { BudgetState, CategoryType } from "@family-budget/domain";
import { TitleBar } from "../../components/TitleBar";
import { useFocusAfterRender } from "../../components/focus-after-render";
import { Icon } from "../../components/Icon";
import { Money, useBaseCurrency } from "../../components/Money";
import { Tile } from "../../components/tiles/Tile";
import { TileGrid } from "../../components/tiles/TileGrid";
import { softHyphenate } from "../../hyphenation";
import { formatMoney } from "../../money";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { AddCategorySheet } from "../overview/AddCategorySheet";
import { categoriesView, categoryFormError, planMonthWord, restoreCategory, type CategoryCard } from "./category-model";

export interface CategoriesScreenProps {
  readonly budget: BudgetState;
  readonly type: CategoryType;
  readonly write: BudgetWriter;
  readonly onBack: () => void;
  readonly onType: (type: CategoryType) => void;
  readonly onOpen: (categoryId: string) => void;
  readonly onMessage: (message: string) => void;
}

/** Доступное имя плитки: имя, лимит месяца плана и что сделает касание. */
export function categoryCardLabel(card: CategoryCard, currency: string, month: string | null): string {
  if (card.category.type === "income") return `${card.category.name}. Изменить`;
  const limit = card.limitMinor === null ? "без лимита" : `лимит ${formatMoney(card.limitMinor, currency)}${month === null ? "" : ` на ${month}`}`;
  return `${card.category.name}: ${limit}. Изменить`;
}

/**
 * «Категории и доходы» (план волны 2, §1.7): расходы — сеткой плиток по группам «Обязательные
 * платежи», «Каждый день», «Личное и досуг», «Прочее», доходы — одной сеткой; плитка — та же, что на
 * «Обзоре», с лимитом месяца плана вместо трат, и касание открывает категорию для правки. Новая —
 * листом «Своя категория»; архив ниже, с «Вернуть». Удаления нет (D-030).
 */
export function CategoriesScreen({ budget, type, write, onBack, onType, onOpen, onMessage }: CategoriesScreenProps) {
  const currency = useBaseCurrency();
  const view = useMemo(() => categoriesView(budget, type), [budget, type]);
  const month = planMonthWord(budget);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // Возвращённая категория уходит из архива в сетку: фокус — на её плитку (ревью 2c, MEDIUM-3).
  const focusAfterRender = useFocusAfterRender();
  const restore = async (card: CategoryCard) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await write.run((state) => restoreCategory(state, card.category.id));
      setStatus(`«${card.category.name}» снова на «Обзоре» и в выборе.`);
      focusAfterRender({ selector: `[data-tile="manage-category:${card.category.id}"]` });
    } catch (cause) {
      setError(categoryFormError(cause).message);
    } finally {
      setBusy(false);
    }
  };
  const income = type === "income";
  return (
    <div className="manage-screen categories-screen">
      <TitleBar back={{ label: "Ещё", onClick: onBack }} title="Категории и доходы" />
      <header className="manage-head">
        <p>{income
          ? "Источники дохода — плитки ряда «Доходы» на «Обзоре». Коснитесь источника, чтобы переименовать его, сменить иконку и цвет или убрать в архив."
          : `Коснитесь категории, чтобы переименовать её, сменить иконку и цвет, задать лимит${month === null ? "" : ` на ${month}`} или убрать в архив.`}</p>
      </header>
      <div className="chip-row" role="group" aria-label="Какой список показать">
        <button className="chip" type="button" aria-pressed={!income} onClick={() => onType("expense")}><span className="chip-face">Расходы</span></button>
        <button className="chip" type="button" aria-pressed={income} onClick={() => onType("income")}><span className="chip-face">Доходы</span></button>
      </div>
      <button className="primary-button manage-add" type="button" onClick={() => setAdding(true)}>
        <span className="icon-label"><Icon name="plus" size={20} />{income ? "Новый источник дохода" : "Новая категория"}</span>
      </button>
      <p className="manage-status" role="status">{status}</p>
      {error === null ? null : <p className="field-error" role="alert">{error}</p>}

      {view.groups.map((group) => (
        <section key={group.key} className="manage-group" aria-labelledby={`categories-${group.key}`}>
          <h2 id={`categories-${group.key}`} className="list-kicker">{group.title}</h2>
          {group.cards.length === 0 ? <p className="field-hint">В этой группе пока ничего нет.</p> : (
            <TileGrid label={group.title} layout="grid">
              {group.cards.map((card) => (
                <Tile
                  key={card.category.id}
                  variant={income ? "income" : "expense"}
                  tone={income ? undefined : card.visual.tone}
                  label={categoryCardLabel(card, currency, month)}
                  onClick={() => onOpen(card.category.id)}
                  tileKey={`manage-category:${card.category.id}`}
                >
                  <span className="tile-top">
                    <span className="tile-glyph" aria-hidden="true"><Icon name={card.visual.icon} size={20} /></span>
                    <span className="tile-edit" aria-hidden="true"><Icon name="pencil" size={20} /></span>
                  </span>
                  <span className="tile-name" aria-hidden="true"><bdi dir="auto">{softHyphenate(card.category.name)}</bdi></span>
                  {income ? null : (
                    <span className="tile-sum tile-limit" aria-hidden="true">{card.limitMinor === null ? <small>без лимита</small> : <Money value={card.limitMinor} />}</span>
                  )}
                </Tile>
              ))}
            </TileGrid>
          )}
        </section>
      ))}

      {view.archived.length === 0 ? null : (
        <section className="manage-group" aria-labelledby="categories-archived">
          <h2 id="categories-archived" className="list-kicker">В архиве</h2>
          <p className="field-hint">{income
            ? "Архивный источник не предлагается для новых доходов; записанные доходы остаются в «Операциях» и отчётах."
            : "Архивная категория не стоит на «Обзоре» и не предлагается при записи; её операции остаются в «Операциях» и отчётах."}</p>
          <ul className="list-card manage-list">
            {view.archived.map((card) => (
              <li key={card.category.id} className="manage-row">
                <button className="row-open" type="button" aria-label={`${card.category.name}, в архиве. Изменить`} onClick={() => onOpen(card.category.id)}>
                  <span className={`icon-plate tone-${card.visual.tone}`} aria-hidden="true"><Icon name={card.visual.icon} size={24} /></span>
                  <span className="manage-copy" aria-hidden="true"><strong><bdi dir="auto">{card.category.name}</bdi></strong><small>в архиве</small></span>
                </button>
                <button className="secondary-button" type="button" aria-disabled={busy || undefined} aria-label={`Вернуть «${card.category.name}» из архива`} onClick={() => void restore(card)}>Вернуть</button>
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
          description={income ? "Новый источник встанет плиткой в «Доходы» и в выбор при записи дохода." : "Новая категория встанет плиткой в «Расходы». Лимит можно задать сейчас или позже, на её экране."}
        />
      ) : null}
    </div>
  );
}
