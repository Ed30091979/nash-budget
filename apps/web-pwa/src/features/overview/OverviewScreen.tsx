import { useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent } from "react";
import type { BudgetState } from "@family-budget/domain";
import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import { AccountTile } from "../../components/tiles/AccountTile";
import { AddTile } from "../../components/tiles/AddTile";
import { CategoryTile } from "../../components/tiles/CategoryTile";
import { ArchivedIncomeTile, IncomeTile } from "../../components/tiles/IncomeTile";
import type { TileDrag } from "../../components/tiles/Tile";
import { TileGrid } from "../../components/tiles/TileGrid";
import { monthName } from "../../date-words";
import type { PeriodClock } from "../../reach";
import { MonthSwitch } from "./MonthSwitch";
import { overviewModel, reachLineModel, UNCATEGORIZED_INCOME_NAME } from "./overview-model";
import { isDragSource, isPicked, pick, pickHintParts, PICK_IDLE, type HintPart, type PickEvent, type PickState, type PickTile, type SheetRequest } from "./pick-model";
import { ReachLine } from "./ReachLine";

/** Перетаскивание — только при точном указателе (§9): на касаниях оно мешало бы прокрутке. */
const FINE_POINTER = "(pointer: fine)";

function subscribeFinePointer(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(FINE_POINTER);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function finePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(FINE_POINTER).matches;
}

function useFinePointer(): boolean {
  return useSyncExternalStore(subscribeFinePointer, finePointer, () => false);
}

/** Подсказка автомата касаний: имена, набранные семьёй, изолированы от слов приложения (LOW-4). */
export function PickHintText({ parts }: { readonly parts: readonly HintPart[] }) {
  return <>{parts.map((part, index) => (typeof part === "string" ? part : <bdi key={index} dir="auto">{part.name}</bdi>))}</>;
}

export interface OverviewScreenProps {
  readonly budget: BudgetState;
  readonly today: string;
  readonly month: string;
  readonly onMonth: (month: string) => void;
  readonly clock: PeriodClock;
  /** Повседневные лимиты месяца плана — `calculateAnnualPlan(...).currentMonth.flexiblePlanMinor`. */
  readonly flexiblePlanMinor: number;
  readonly familyNews: readonly string[];
  readonly monthToOpen: string | null;
  readonly openingMonth: boolean;
  readonly onOpenMonth: (month: string) => void;
  /** Касание плиток решило, что записать: лист ввода открывает оболочка. */
  readonly onOpenSheet: (request: SheetRequest) => void;
  readonly onAddCategory: (type: "expense" | "income") => void;
  readonly onPlan: () => void;
  /** «Изменить» у ряда (§5.1: ничего только долгим нажатием): экран справочника этого ряда. */
  readonly onEdit: (row: OverviewRow) => void;
}

/** Ряды плиток «Обзора», у каждого — своё «Изменить». */
export type OverviewRow = "incomes" | "accounts" | "expenses";

/** Доступное имя «Изменить» ряда: видимое слово и что именно правится (WCAG 2.5.3). */
export const ROW_EDIT_LABELS: Readonly<Record<OverviewRow, string>> = {
  incomes: "Изменить источники дохода",
  accounts: "Изменить счета",
  expenses: "Изменить категории расходов",
};

/** Кикер ряда с «Изменить» справа: путь к справочнику ряда виден, а не спрятан в долгом нажатии. */
function RowHead({ id, title, row, onEdit }: { readonly id: string; readonly title: string; readonly row: OverviewRow; readonly onEdit: (row: OverviewRow) => void }) {
  return (
    <div className="row-head">
      <h2 id={id} className="row-kicker">{title}</h2>
      <button className="quiet-button row-edit" type="button" aria-label={ROW_EDIT_LABELS[row]} onClick={() => onEdit(row)}>
        <span className="icon-label"><Icon name="pencil" size={20} />Изменить</span>
      </button>
    </div>
  );
}

/**
 * «Обзор» (план волны 2, §1.1): месяц, «Всего на счетах», «Потрачено N» (по лимитам — «N из M»), строка «Можно на
 * повседневные» и три ряда плиток — доходы, счета, расходы. Касание — основной путь; выбор и его
 * следующий шаг решает автомат `pick-model.ts`, а подсказка говорит их словами в `role="status"`.
 */
export function OverviewScreen({
  budget, today, month, onMonth, clock, flexiblePlanMinor, familyNews, monthToOpen, openingMonth, onOpenMonth, onOpenSheet, onAddCategory, onPlan, onEdit,
}: OverviewScreenProps) {
  const model = useMemo(() => overviewModel(budget, month, today), [budget, month, today]);
  const line = useMemo(() => reachLineModel(budget, flexiblePlanMinor), [budget, flexiblePlanMinor]);
  const [picked, setPicked] = useState<PickState>(PICK_IDLE);
  const fine = useFinePointer();
  const dragged = useRef<PickTile | null>(null);
  const context = { defaultAccountId: model.defaultAccountId };

  const dispatch = (event: PickEvent) => {
    const result = pick(picked, event, context);
    setPicked(result.state);
    if (result.open !== null) onOpenSheet(result.open);
  };
  const tap = (tile: PickTile) => () => dispatch({ type: "tap", tile });

  const accountName = (id: string) => budget.accounts.find((account) => account.id === id)?.name ?? "счёт";
  const incomeName = (id: string | null) => (id === null ? UNCATEGORIZED_INCOME_NAME : budget.categories.find((category) => category.id === id)?.name ?? "доход");
  const hint = pickHintParts(picked, { account: accountName, income: incomeName });

  /** Перетаскивание через тот же автомат: взятая плитка — источник, плитка под курсором — цель. */
  const dragFor = (tile: PickTile): TileDrag | undefined => {
    if (!fine) return undefined;
    return {
      draggable: isDragSource(tile),
      onDragStart: isDragSource(tile) ? (event: DragEvent<HTMLButtonElement>) => {
        dragged.current = tile;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", tile.kind);
      } : undefined,
      onDragEnd: () => { dragged.current = null; },
      onDragOver: (event: DragEvent<HTMLButtonElement>) => {
        if (dragged.current !== null && tile.kind !== "income") event.preventDefault();
      },
      onDrop: (event: DragEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const source = dragged.current;
        dragged.current = null;
        if (source !== null) dispatch({ type: "drop", source, target: tile });
      },
    };
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && picked.selected !== null) {
      event.preventDefault();
      dispatch({ type: "escape" });
    }
  };

  const monthWord = monthName(month);
  const spentLimited = model.limitsMinor !== null;
  return (
    <div className="overview-screen" onKeyDown={onKeyDown}>
      <header className="overview-head">
        <MonthSwitch month={month} onMonth={(next) => { setPicked(PICK_IDLE); onMonth(next); }} />
        <dl className="overview-totals">
          <div className="overview-balance">
            <dt>Всего на счетах</dt>
            <dd className="overview-total"><Money value={model.totalInBaseMinor} breakDigits /></dd>
          </div>
          {/* «Потрачено» — весь расход месяца, тот же, что в «Отчётах»; расход по лимитам против их
              суммы — другое число, и у него своя подпись (ревью 2b, MEDIUM-8). */}
          <div className="overview-spent">
            <dt>Потрачено</dt>
            <dd><Money value={model.spentMinor} /></dd>
            {spentLimited ? <dd className="overview-limits">по лимитам <Money value={model.spentWithLimitMinor} /> из <Money value={model.limitsMinor ?? 0} /></dd> : null}
          </div>
        </dl>
        {model.unvaluedAccounts.length > 0 ? (
          <p className="overview-note">
            <Icon name="triangle-alert" size={20} />
            <span>В итог не вошли: {model.unvaluedAccounts.map((tile, index) => <span key={tile.id}>{index > 0 ? "; " : ""}«<bdi dir="auto">{tile.name}</bdi>» — нет курса {tile.currency}</span>)}.</span>
          </p>
        ) : null}
      </header>

      <ReachLine line={line} clock={clock} monthToOpen={monthToOpen} openingMonth={openingMonth} onOpenMonth={onOpenMonth} onPlan={onPlan} />

      {/* §6 Семейная новость: первое открытие после того, как второй участник что-то записал. */}
      {familyNews.length > 0 ? <div className="family-news" role="status">
        <span className="family-news-mark"><Icon name="users" size={24} /></span>
        <div>
          {familyNews.map((news) => <strong key={news}>{news}</strong>)}
          <small>Новое с прошлого раза</small>
        </div>
      </div> : null}

      <p className="pick-hint" role="status"><PickHintText parts={hint} /></p>

      <section className="tile-section" aria-labelledby="overview-incomes">
        <RowHead id="overview-incomes" title="Доходы" row="incomes" onEdit={onEdit} />
        <TileGrid label="Источники дохода" layout="row">
          {model.incomes.map((tile) => {
            if (tile.archived) return <ArchivedIncomeTile key={tile.id ?? "none"} tile={tile} monthWord={monthWord} />;
            const key: PickTile = { kind: "income", id: tile.id };
            return <IncomeTile key={tile.id ?? "none"} tile={tile} monthWord={monthWord} pressed={isPicked(picked, key)} onPick={tap(key)} drag={dragFor(key)} />;
          })}
          <AddTile key="add" label="Добавить источник дохода" onClick={() => onAddCategory("income")} />
        </TileGrid>
      </section>

      <section className="tile-section" aria-labelledby="overview-accounts">
        <RowHead id="overview-accounts" title="Счета" row="accounts" onEdit={onEdit} />
        {model.accounts.length > 0 ? (
          <TileGrid label="Счета" layout="accounts">
            {model.accounts.map((tile) => {
              const key: PickTile = { kind: "account", id: tile.id };
              return <AccountTile key={tile.id} tile={tile} pressed={isPicked(picked, key)} onPick={tap(key)} drag={dragFor(key)} />;
            })}
          </TileGrid>
        ) : <p className="field-hint">Активных счетов нет. Без счёта операцию записать некуда — заведите счёт кнопкой «Изменить» над этим рядом.</p>}
      </section>

      <section className="tile-section" aria-labelledby="overview-expenses">
        <RowHead id="overview-expenses" title="Расходы" row="expenses" onEdit={onEdit} />
        <TileGrid label="Категории расходов" layout="grid">
          {model.categories.map((tile) => {
            const key: PickTile = { kind: "category", id: tile.id };
            return <CategoryTile key={tile.id} tile={tile} onPick={tap(key)} drag={dragFor(key)} />;
          })}
          <AddTile key="add" label="Добавить категорию расходов" onClick={() => onAddCategory("expense")} />
        </TileGrid>
      </section>
    </div>
  );
}
