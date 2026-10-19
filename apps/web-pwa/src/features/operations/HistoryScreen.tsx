import { useMemo, useState } from "react";
import type { BudgetState, Member, Transaction, TransactionKind, calculateBudget } from "@family-budget/domain";
import { BackButton } from "../../components/BackButton";
import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import { categoryVisual } from "../../category-visual";
import { plainInputValue } from "../../plain-text";
import { searchOperations } from "../dashboard";
import { filterTransactionsByMember, MEMBER_FILTER_ALL, transactionAuthorLabel, type MemberFilter, type MemberFilterOption } from "../family/model";
import { OperationAmount } from "./OperationAmount";
import {
  kindIcons,
  kindLabels,
  kindSign,
  operationLabel,
  operationsCount,
  transactionCategory,
  transactionCurrency,
  transactionDetail,
} from "./transaction-words";

const PAGE_SIZE = 25;

/** Знак направления строки, если он у вида есть: перевод знака не несёт. */
function signOf(kind: TransactionKind): { readonly sign?: "+" | "−" } {
  const sign = kindSign(kind);
  return sign === undefined ? {} : { sign };
}

type BudgetMetrics = ReturnType<typeof calculateBudget>;

/** Заголовок истории: секция названа им, и e2e находит экран по этому имени. */
export const HISTORY_TITLE_ID = "operations-history-title";

/** «Кто записал»: участники семьи, выбранный фильтр и имена авторов строк. */
export interface HistoryMembers {
  readonly options: readonly MemberFilterOption[];
  readonly filter: MemberFilter;
  readonly onFilter: (filter: MemberFilter) => void;
  readonly byId: ReadonlyMap<string, Member>;
}

export interface HistoryScreenProps {
  readonly budget: BudgetState;
  /** Семья: фильтр «Кто записал» и автор в каждой строке. Без участников их нет. */
  readonly members?: HistoryMembers;
  /** Строка истории открывает операцию в форме «Записать»: там её меняют и удаляют. */
  readonly onEdit: (transaction: Transaction) => void;
  /** Дорога к записи из пустой истории. */
  readonly onAdd: () => void;
  /** Кнопка «назад» — только там, где история открыта подэкраном; вкладке «Операции» она не нужна. */
  readonly onBack?: () => void;
  /** Пока приложение пишет, строки не открывают ничего: открытая форма спорила бы с записью. */
  readonly busy?: boolean;
}

/**
 * «Операции» — вкладка нижней навигации (2a: прежняя «Вся история» целиком, план волны 2, §1.3).
 *
 * Прежде история стояла свёрнутой под табло конвертов, и экран записи нёс в себе второй главный
 * экран. Экран записи существует, чтобы ответить «можем ли мы себе это позволить» до траты;
 * история отвечает на «что уже записано» — это другой вопрос, и живёт он там, где его ищут:
 * рядом с копией и выпиской. Поиск стоит над списком, который он фильтрует, а «Показать ещё»
 * держит разметку ограниченной: даже на пятидесяти тысячах операций в DOM попадают только
 * видимые строки.
 */
export function HistoryScreen({ budget, members, onEdit, onAdd, onBack, busy = false }: HistoryScreenProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<TransactionKind | "all">("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // «Кто записал» — только в семье, где есть кого выбрать: «Все участники» и «Без участника» — не выбор.
  const showMembers = members !== undefined && members.options.length > 2;
  const memberFilter = showMembers ? members.filter : MEMBER_FILTER_ALL;
  const searched = useMemo(() => searchOperations(budget, { query, kind }), [budget, kind, query]);
  const filtered = useMemo(() => {
    if (memberFilter === MEMBER_FILTER_ALL) return searched;
    const ids = new Set(filterTransactionsByMember(budget.transactions, memberFilter).map((transaction) => transaction.id));
    return searched.filter(({ transaction }) => ids.has(transaction.id));
  }, [budget, memberFilter, searched]);
  const searching = query.trim().length > 0 || kind !== "all";
  const filtering = searching || memberFilter !== MEMBER_FILTER_ALL;
  // Список, опустевший от фильтра участника, — не пустой бюджет и не пустой поиск: у этого
  // участника записей нет, а у остальных — есть.
  const hiddenByMember = filtered.length === 0 && searched.length > 0 && memberFilter !== MEMBER_FILTER_ALL;
  // В бюджете нет ни одной операции — это «записей пока нет», какой бы фильтр ни стоял.
  const nothingRecorded = budget.transactions.length === 0;
  // Смена запроса и вида возвращает список к первой странице: иначе фильтр показывал бы
  // «Показать ещё» там, где найденное уже помещается целиком.
  const showAll = () => {
    setQuery("");
    setKind("all");
    setVisibleCount(PAGE_SIZE);
    if (showMembers) members.onFilter(MEMBER_FILTER_ALL);
  };

  return <div className="history-screen">
    {onBack ? <div className="planning-toolbar"><BackButton label="К разделу «Ещё»" onClick={onBack} /></div> : null}
    <section className="section-card history-card" aria-labelledby={HISTORY_TITLE_ID}>
      <span className="card-kicker">Все записи</span>
      <h1 id={HISTORY_TITLE_ID}>Операции</h1>
      <p className="history-count">{operationsCount(budget.transactions.length)}</p>
      <div className="search-controls">
        <label htmlFor="operation-history-search">Поиск по категории, счёту или сумме</label>
        <input id="operation-history-search" type="search" autoComplete="off" maxLength={80} value={query} onChange={(event) => { setQuery(plainInputValue(event.currentTarget)); setVisibleCount(PAGE_SIZE); }} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
        <label htmlFor="operation-history-kind">Вид операции</label>
        <select id="operation-history-kind" value={kind} onChange={(event) => { setKind(event.target.value as TransactionKind | "all"); setVisibleCount(PAGE_SIZE); }}>
          <option value="all">Все виды</option>
          {Object.entries(kindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
        {showMembers ? <>
          <label htmlFor="history-member-filter">Кто записал</label>
          <select id="history-member-filter" value={members.filter} onChange={(event) => { members.onFilter(event.target.value as MemberFilter); setVisibleCount(PAGE_SIZE); }}>
            {members.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </> : null}
        <button className="secondary-button" type="button" disabled={!filtering} onClick={showAll}>Сбросить</button>
      </div>
      {filtered.length ? <ul className="transaction-list">{filtered.slice(0, visibleCount).map(({ transaction }) => {
        const category = transactionCategory(transaction, budget);
        const visual = category ? categoryVisual(category) : null;
        const name = operationLabel(transaction, budget);
        const detail = category ? kindLabels[transaction.kind] : transactionDetail(transaction, budget);
        const author = showMembers ? ` · ${transactionAuthorLabel(members.byId, transaction.memberId)}` : "";
        return <li className={`transaction-row history-row ${transaction.kind}`} key={transaction.id}>
          {/* Вся строка — одна цель нажатия: она открывает операцию в листе ввода, где её и
              меняют, и удаляют. Разрушающее действие не стоит под пальцем при пролистывании. */}
          <button className="row-open" type="button" disabled={busy} aria-label={`Изменить операцию «${name}»`} onClick={() => onEdit(transaction)}>
            <span className={`transaction-icon ${visual ? `tone-${visual.tone}` : "tone-neutral"}`}><Icon name={visual ? visual.icon : kindIcons[transaction.kind]} size={24} /></span>
            <span className="transaction-copy"><strong>{category ? category.name : kindLabels[transaction.kind]}</strong><small>{transaction.occurredOn} · {detail}{author}</small></span>
            {/* Сумма строки — в валюте её счёта и с её знаком: «₽» у счёта в долларах был бы неправдой. */}
            <b><OperationAmount value={transaction.amountMinor} currency={transactionCurrency(transaction, budget)} {...signOf(transaction.kind)} /></b>
          </button>
        </li>;
      })}</ul> : <div className="empty-state">
        <span className="empty-state-mark"><Icon name="inbox" size={32} /></span>
        {/* §6 исследования, пункт 29: сообщить состояние, не соврав про него; объяснить, что сюда
            попадает; дать прямой путь к задаче. Фильтр и пустая история — разные состояния, и
            называть их одними словами значит соврать про одно из них. */}
        {!nothingRecorded && hiddenByMember ? <>
          <h3>У выбранного участника записей нет</h3>
          <p>Фильтр «Кто записал» показывает операции одного человека. Записи остальных на месте — они вернутся, как только фильтр снят.</p>
          <button className="primary-button" type="button" onClick={() => members?.onFilter(MEMBER_FILTER_ALL)}>Показать записи всех</button>
        </> : !nothingRecorded && filtering ? <>
          <h3>По этому запросу ничего не нашлось</h3>
          <p>В истории всё ещё {operationsCount(budget.transactions.length)}. Поиск идёт по названию категории, названию счёта и по сумме.</p>
          <button className="primary-button" type="button" onClick={showAll}>Показать все операции</button>
        </> : <>
          <h3>Записей пока нет</h3>
          <p>Сюда попадает каждая покупка, доход и перевод — сразу после того, как их записали кнопкой «+».</p>
          <button className="primary-button" type="button" onClick={onAdd}>Записать первую операцию</button>
        </>}
      </div>}
      {visibleCount < filtered.length ? <button className="secondary-button" type="button" disabled={busy} aria-label={`Показать ещё операции, осталось ${filtered.length - visibleCount}`} onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>Показать ещё ({filtered.length - visibleCount})</button> : null}
      <p role="status">{filtering ? `Найдено ${filtered.length} из ${budget.transactions.length}. ` : ""}Показано {Math.min(visibleCount, filtered.length)} из {filtered.length}</p>
    </section>
  </div>;
}

/**
 * «Итоги и остатки» — строка факта на «Ещё»: доход, расходы, капитал и остатки по счетам.
 *
 * Это справка, а не действие, и на экране записи она не отвечала на вопрос экрана. Здесь она
 * свёрнута в ту же строку, что и «Как хранятся данные»: раскрывают, когда спрашивают.
 */
export function TotalsFact({ budget, metrics }: { readonly budget: BudgetState; readonly metrics: BudgetMetrics }) {
  return <details className="list-fact totals-fact">
    <summary><span className="list-icon"><Icon name="wallet" size={24} /></span><span className="list-copy"><strong>Итоги и остатки</strong><small>Доход, расходы, капитал и остатки по счетам</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></summary>
    <div className="quick-grid" aria-label="Итоги бюджета">
      <article className="quick-card"><span className="quick-label">Доход</span><strong><Money value={metrics.incomeMinor} /></strong></article>
      <article className="quick-card"><span className="quick-label">Расходы с учётом возвратов</span><strong><Money value={metrics.expensesMinor} /></strong></article>
      <article className="quick-card"><span className="quick-label">Капитал</span><strong><Money value={metrics.capitalMinor} /></strong></article>
    </div>
    <dl className="summary-list">{budget.accounts.map((account) => <div key={account.id}><dt>{account.name}{account.active ? "" : " (в архиве)"}</dt><dd><Money value={metrics.accountBalancesMinor[account.id] ?? 0} currency={account.currency} /></dd></div>)}</dl>
  </details>;
}
