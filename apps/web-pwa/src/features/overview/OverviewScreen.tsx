import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
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
import { ReachCard } from "./ReachCard";
import { TotalsStrip } from "./TotalsStrip";

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
  /** «Можно тратить» и карточка «Хватает до…» ведут в «План месяца». */
  readonly onPlan: () => void;
  /** «Расходы» ведут в «Отчёты»: там тот же расход разложен по категориям. */
  readonly onReports: () => void;
  /** «Изменить» у ряда (§5.1: ничего только долгим нажатием): экран справочника этого ряда. */
  readonly onEdit: (row: OverviewRow) => void;
  /**
   * Места первого запуска (R2, DIRECTION §e): подсказка на первую трату — сразу за плитками
   * расходов, карточки-подсказки — в конце экрана. Экран их не знает и ничего в них не решает.
   */
  readonly coach?: ReactNode;
  readonly hints?: ReactNode;
}

/** Ряды плиток «Обзора»: «Доходы и счета» одной полосой и сетка «Расходы», у каждого — своё «Изменить». */
export type OverviewRow = "accounts" | "expenses";

/** Доступное имя «Изменить» ряда: глиф карандаша и что именно правится. */
export const ROW_EDIT_LABELS: Readonly<Record<OverviewRow, string>> = {
  accounts: "Изменить счета",
  expenses: "Изменить категории расходов",
};

/** Кикер ряда и карандаш справа: путь к справочнику ряда виден, а не спрятан в долгом нажатии. */
function RowHead({ id, title, row, onEdit }: { readonly id: string; readonly title: string; readonly row: OverviewRow; readonly onEdit: (row: OverviewRow) => void }) {
  return (
    <div className="row-head">
      <h2 id={id} className="row-kicker">{title}</h2>
      <button className="icon-button row-edit" type="button" aria-label={ROW_EDIT_LABELS[row]} onClick={() => onEdit(row)}>
        <Icon name="pencil" size={24} />
      </button>
    </div>
  );
}

/**
 * Месяц и итоги закреплены при прокрутке (макеты v5, 06b). Тень-линия появляется, когда под ними
 * поехало содержимое: метка над шапкой ушла из виду. Без `IntersectionObserver` (сервер, старые
 * движки) линии просто нет.
 */
function useStuck(): [RefObject<HTMLSpanElement | null>, boolean] {
  const sentinel = useRef<HTMLSpanElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const node = sentinel.current;
    if (node === null || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(([entry]) => setStuck(entry !== undefined && !entry.isIntersecting));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [sentinel, stuck];
}

/**
 * «Обзор» (DESIGN 5.0 §8, макеты v5 06): месяц со стрелками и три итога «На счетах · Расходы · Можно
 * тратить» — закреплены; карточка «Хватает до …»; одна полоса «Доходы и счета» (доходы — тоном своей
 * категории, за разделителем — графитовые счета); сетка «Расходы» в 4 колонки. Касание — основной
 * путь; выбор и его следующий шаг решает автомат `pick-model.ts`, а подсказка говорит их словами в
 * `role="status"` — пузырём над навигацией, пока что-то выбрано, и только для диктора, пока нет.
 */
export function OverviewScreen({
  budget, today, month, onMonth, clock, flexiblePlanMinor, familyNews, monthToOpen, openingMonth, onOpenMonth, onOpenSheet, onAddCategory, onPlan, onReports, onEdit, coach, hints,
}: OverviewScreenProps) {
  const model = useMemo(() => overviewModel(budget, month, today), [budget, month, today]);
  const line = useMemo(() => reachLineModel(budget, flexiblePlanMinor), [budget, flexiblePlanMinor]);
  const [picked, setPicked] = useState<PickState>(PICK_IDLE);
  const fine = useFinePointer();
  const dragged = useRef<PickTile | null>(null);
  const [sentinel, stuck] = useStuck();
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
  return (
    <div className="overview-screen" onKeyDown={onKeyDown}>
      <span ref={sentinel} className="overview-sentinel" aria-hidden="true" />
      <header className="overview-head" data-stuck={stuck ? "true" : undefined}>
        <MonthSwitch month={month} onMonth={(next) => { setPicked(PICK_IDLE); onMonth(next); }} />
        <TotalsStrip
          totalMinor={model.totalInBaseMinor}
          spentMinor={model.spentMinor}
          canSpendMinor={line.hasLimits ? line.safeToSpendMinor : null}
          onAccounts={() => onEdit("accounts")}
          onReports={onReports}
          onPlan={onPlan}
        />
      </header>
      {/* Архивный счёт плитки не имеет, а в итоге остаётся (правило 9 контракта): итог называет эту
          часть, чтобы сходиться с плитками (ревью 2c, LOW-5). Счёт без курса назван, а не выброшен. */}
      {model.archivedInTotalMinor === null && model.unvaluedAccounts.length === 0 ? null : (
        <div className="overview-notes">
          {model.archivedInTotalMinor === null ? null : <p className="overview-note">На счетах — в том числе в архиве <Money value={model.archivedInTotalMinor} /></p>}
          {model.unvaluedAccounts.length > 0 ? (
            <p className="overview-note warning">
              <Icon name="triangle-alert" size={20} />
              <span>В итог не вошли: {model.unvaluedAccounts.map((tile, index) => <span key={tile.id}>{index > 0 ? "; " : ""}«<bdi dir="auto">{tile.name}</bdi>»{tile.archived ? " (в архиве)" : ""} — нет курса {tile.currency}</span>)}.</span>
            </p>
          ) : null}
        </div>
      )}

      <ReachCard line={line} clock={clock} monthToOpen={monthToOpen} openingMonth={openingMonth} onOpenMonth={onOpenMonth} onPlan={onPlan} />

      {/* §6 Семейная новость: первое открытие после того, как второй участник что-то записал. */}
      {familyNews.length > 0 ? <div className="family-news" role="status">
        <span className="family-news-mark"><Icon name="users" size={24} /></span>
        <div>
          {familyNews.map((news) => <strong key={news}>{news}</strong>)}
          <small>Новое с прошлого раза</small>
        </div>
      </div> : null}

      <section className="tile-section" aria-labelledby="overview-accounts">
        <RowHead id="overview-accounts" title="Доходы и счета" row="accounts" onEdit={onEdit} />
        {/* Одна полоса, листается вбок внутри себя: сначала доходы — тоном своей категории, — за
            разделителем графитовые счета. Пятая плитка выглядывает из-за края: дальше есть ещё. */}
        <div className="tile-row">
          <TileGrid label="Источники дохода" layout="row">
            {model.incomes.map((tile) => {
              if (tile.archived) return <ArchivedIncomeTile key={tile.id ?? "none"} tile={tile} monthWord={monthWord} />;
              const key: PickTile = { kind: "income", id: tile.id };
              return <IncomeTile key={tile.id ?? "none"} tile={tile} monthWord={monthWord} pressed={isPicked(picked, key)} onPick={tap(key)} drag={dragFor(key)} />;
            })}
            <AddTile key="add" label="Добавить источник дохода" caption="Доход" onClick={() => onAddCategory("income")} />
          </TileGrid>
          {model.accounts.length > 0 ? <>
            <span className="tile-row-divider" aria-hidden="true" />
            <TileGrid label="Счета" layout="accounts">
              {model.accounts.map((tile) => {
                const key: PickTile = { kind: "account", id: tile.id };
                return <AccountTile key={tile.id} tile={tile} pressed={isPicked(picked, key)} onPick={tap(key)} drag={dragFor(key)} />;
              })}
            </TileGrid>
          </> : null}
        </div>
        {model.accounts.length > 0 ? null : <p className="field-hint">Активных счетов нет. Без счёта операцию записать некуда — заведите счёт карандашом над этим рядом.</p>}
      </section>

      <section className="tile-section" aria-labelledby="overview-expenses">
        <RowHead id="overview-expenses" title="Расходы" row="expenses" onEdit={onEdit} />
        <TileGrid label="Категории расходов" layout="grid">
          {model.categories.map((tile) => {
            const key: PickTile = { kind: "category", id: tile.id };
            return <CategoryTile key={tile.id} tile={tile} onPick={tap(key)} drag={dragFor(key)} />;
          })}
          <AddTile key="add" label="Своя категория расходов" caption="Своя" onClick={() => onAddCategory("expense")} />
        </TileGrid>
        {coach}
      </section>

      {hints}

      {/* Пока ничего не выбрано, подсказка — только для диктора: постоянного абзаца над плитками больше
          нет (первую трату подсказывает пузырь онбординга). Выбран счёт или доход — она пузырём над
          навигацией говорит, что будет дальше; в конце потока она не сдвигает плитки под пальцем. */}
      <p className={picked.selected === null ? "pick-hint visually-hidden" : "pick-hint"} role="status"><PickHintText parts={hint} /></p>
    </div>
  );
}
