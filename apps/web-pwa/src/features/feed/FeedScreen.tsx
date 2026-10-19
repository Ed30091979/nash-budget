import { useDeferredValue, useMemo, useState } from "react";
import { categoriesInListOrder, monthEndDate, monthOfDate, monthStartDate, shiftMonth, type BudgetState, type Transaction } from "@family-budget/domain";
import { accountIcon, accountTone, categoryVisual } from "../../category-visual";
import { EmptyState } from "../../components/EmptyState";
import { Hyphenated } from "../../components/Hyphenated";
import { Icon } from "../../components/Icon";
import { LargeTitle } from "../../components/LargeTitle";
import { Money } from "../../components/Money";
import { FEED_KINDS, type OperationsFilterFields } from "../../navigation/routes";
import { plainInputValue } from "../../plain-text";
import { membersById, transactionAuthorLabel } from "../family/model";
import { operationsCount } from "../operations/transaction-words";
import { DayGroup } from "./DayGroup";
import {
  FEED_PAGE_SIZE,
  feedIndex,
  filterFeed,
  filtersOfRoute,
  groupByDay,
  hasFilters,
  KIND_PLURAL,
  monthLabel,
  parseSearch,
  periodLabel,
  routeOfFilters,
} from "./feed-model";
import { FilterBar } from "./FilterBar";
import { FilterSheet, type FilterChoice, type FilterGroup } from "./FilterSheet";
import { PeriodForm } from "./PeriodForm";

/** Заголовок экрана: секция «Операции» названа им, и e2e находит экран по этому имени. */
export const FEED_TITLE_ID = "feed-title";

export interface FeedScreenProps {
  readonly budget: BudgetState;
  readonly today: string;
  /** Фильтры из адреса «Операций». */
  readonly filters: OperationsFilterFields;
  /** Другой фильтр — тот же экран: запись истории заменяется, а не копится. */
  readonly onFilters: (filters: OperationsFilterFields) => void;
  /** Строка открывает операцию в листе ввода: там её меняют и удаляют. */
  readonly onEdit: (transaction: Transaction) => void;
  /** Дорога к записи из пустой ленты. */
  readonly onAdd: () => void;
  /** «Загрузить выписку банка» — действие крупного заголовка. */
  readonly onImport: () => void;
  /** Пока приложение пишет, строки не открывают ничего. */
  readonly busy?: boolean;
}

type SheetKind = "period" | "account" | "category" | "tag" | "member";

/**
 * «Операции» (подволна 2d, дизайн 5.0, макет 08): крупный заголовок, поиск «Сумма, комментарий или
 * #метка», чипы фильтров, строка итогов найденного и лента по дням с итогом дня; по 50 строк, «Показать
 * ещё» добавляет столько же.
 *
 * Фильтры — в адресе, закрытыми типами (`navigation/routes.ts`): «Назад» с листа правки и из
 * «Отчётов» возвращает их, перезагрузка — тоже. Строка поиска — свободный текст, и в адрес она не
 * попадает никогда: она живёт в памяти этого экрана (`useState` ниже) — переживает лист правки поверх
 * него и смену фильтра, а уход с экрана и перезагрузку не переживает (SECURITY §7.3,
 * `address-privacy.test.ts`).
 */
export function FeedScreen({ budget, today, filters: routed, onFilters, onEdit, onAdd, onImport, busy = false }: FeedScreenProps) {
  const [search, setSearch] = useState("");
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const filters = useMemo(() => filtersOfRoute(routed), [routed]);
  const deferredSearch = useDeferredValue(search);
  const index = feedIndex(budget);
  const parsed = useMemo(() => parseSearch(deferredSearch), [deferredSearch]);
  const result = useMemo(() => filterFeed(index, filters, parsed), [index, filters, parsed]);
  // Страница — от того, что найдено: другой фильтр или запрос возвращает список к первой странице.
  const listKey = `${JSON.stringify(routeOfFilters(filters))}|${deferredSearch}`;
  const [page, setPage] = useState({ key: listKey, count: FEED_PAGE_SIZE });
  const visible = page.key === listKey ? page.count : FEED_PAGE_SIZE;
  const days = useMemo(() => groupByDay(result.entries, visible), [result.entries, visible]);

  const activeMembers = (budget.members ?? []).filter((member) => member.active);
  const showMembers = activeMembers.length > 0;
  const byId = useMemo(() => membersById(budget), [budget]);
  const authors = { show: showMembers, label: (memberId: string | undefined) => transactionAuthorLabel(byId, memberId) };

  const searching = search.trim().length > 0;
  const filtering = hasFilters(filters);
  const total = budget.transactions.length;
  const shown = Math.min(visible, result.entries.length);
  const apply = (next: OperationsFilterFields) => {
    setSheet(null);
    onFilters(next);
  };
  // Только ключи фильтров: лист поверх экрана и всё прочее из маршрута в новый адрес не переходят.
  const patch = (change: Partial<Record<keyof OperationsFilterFields, string | undefined>>) => {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...routeOfFilters(filters), ...change })) if (value !== undefined) next[key] = value;
    apply(next as OperationsFilterFields);
  };
  const resetAll = () => {
    setSearch("");
    setSheet(null);
    if (filtering) onFilters({});
  };

  const account = routed.acc === undefined ? undefined : budget.accounts.find((item) => item.id.toLowerCase() === routed.acc);
  const category = routed.cat === undefined ? undefined : budget.categories.find((item) => item.id.toLowerCase() === routed.cat);
  const tag = routed.tag === undefined ? undefined : (budget.tags ?? []).find((item) => item.id.toLowerCase() === routed.tag);
  const member = routed.member === undefined ? undefined : activeMembers.find((item) => item.id.toLowerCase() === routed.member);
  const chips = [
    { key: "period", label: periodLabel(routed.from, routed.to, today), set: routed.from !== undefined || routed.to !== undefined },
    { key: "account", label: account?.name ?? "Все счета", set: routed.acc !== undefined },
    { key: "category", label: category?.name ?? (routed.kind === undefined ? "Все категории" : KIND_PLURAL[routed.kind]), set: routed.cat !== undefined || routed.kind !== undefined },
    ...((budget.tags ?? []).length > 0 || routed.tag !== undefined ? [{ key: "tag", label: tag === undefined ? "Метки" : `#${tag.name}`, set: routed.tag !== undefined }] : []),
    ...(showMembers ? [{ key: "member", label: member?.name ?? "Участник", set: routed.member !== undefined }] : []),
  ].map((chip) => ({ ...chip, expanded: sheet === chip.key, onOpen: () => setSheet(chip.key as SheetKind) }));

  // Список, опустевший от одного фильтра участника, — не пустой бюджет и не пустой поиск: у этого
  // участника записей нет, а у остальных — есть.
  const onlyMember = !searching && routed.member !== undefined && Object.keys(routeOfFilters(filters)).length === 1;

  return <div className="feed-screen">
    {/* Вкладка — крупным заголовком; «назад» у неё нет: с вкладки системное «Назад» ведёт на «Обзор». */}
    {/* При ×2.7 «Операции» шире строки: перенос по слогам с дефисом, а не посреди слова (§4). */}
    <LargeTitle id={FEED_TITLE_ID} title={<Hyphenated text="Операции" />} action={(
      <button className="icon-button" type="button" aria-label="Загрузить выписку банка" onClick={onImport}><Icon name="receipt-text" size={24} /></button>
    )} />
    <section className="feed-body" aria-labelledby={FEED_TITLE_ID}>
      <div className="feed-search" role="search">
        <label className="visually-hidden" htmlFor="feed-search">Поиск по операциям</label>
        <Icon name="search" size={20} className="feed-search-icon" />
        <input
          id="feed-search"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          placeholder="Сумма, комментарий, #метка"
          value={search}
          onChange={(event) => setSearch(plainInputValue(event.currentTarget))}
          onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
        />
        {searching ? (
          <button className="icon-button feed-search-clear" type="button" aria-label="Очистить поиск" onClick={() => setSearch("")}><Icon name="x" size={20} /></button>
        ) : null}
      </div>
      <FilterBar label="Фильтры операций" chips={chips} />
      {/* Итоги — того, что нашли: у всей истории без фильтра и поиска они ни о чём не говорят. */}
      {result.entries.length > 0 && (searching || filtering) ? (
        <p className="feed-sum">
          <span>Расходы <b><Money value={result.totals.expenseMinor} /></b></span>
          <span>Доходы <b><Money value={result.totals.incomeMinor} /></b></span>
        </p>
      ) : null}
      {days.map((day) => (
        <DayGroup key={day.date} day={day} budget={budget} today={today} authors={authors} onEdit={onEdit} busy={busy} />
      ))}
      {result.entries.length === 0 ? (
        total === 0 ? (
          <EmptyState glyph="history" title="Записей пока нет" text="Здесь будет всё, что вы запишете." action={{ label: "Записать расход", onClick: onAdd }} />
        ) : onlyMember ? (
          <EmptyState glyph="user-round" title="У выбранного участника записей нет" text="Записи остальных на месте." action={{ label: "Показать записи всех", onClick: () => patch({ member: undefined }) }} />
        ) : (
          <EmptyState glyph="search" title="Ничего не нашлось" text="Попробуйте сумму или другое слово." action={{ label: "Сбросить фильтры", onClick: resetAll }} />
        )
      ) : null}
      {shown < result.entries.length ? (
        <button
          className="secondary-button wide feed-more"
          type="button"
          aria-label={`Показать ещё операции, осталось ${result.entries.length - shown}`}
          onClick={() => setPage({ key: listKey, count: visible + FEED_PAGE_SIZE })}
        >
          Показать ещё {Math.min(FEED_PAGE_SIZE, result.entries.length - shown)}
        </button>
      ) : null}
      <p className="feed-status" role="status">
        {searching || filtering ? `Найдено ${result.entries.length} из ${total}. ` : ""}Показано {shown} из {result.entries.length}
      </p>
    </section>
    {sheet === null ? null : (
      <FilterSheet id={`feed-${sheet}`} title={SHEET_TITLES[sheet]} groups={sheetGroups(sheet, budget, routed, today, patch)} onClose={() => setSheet(null)}>
        {sheet === "period" ? (
          <PeriodForm
            from={routed.from}
            to={routed.to}
            today={today}
            submitLabel="Показать"
            onSubmit={(from, to) => patch({ from, to })}
          />
        ) : null}
      </FilterSheet>
    )}
  </div>;
}

const SHEET_TITLES: Readonly<Record<SheetKind, string>> = {
  period: "Период",
  account: "Счёт",
  category: "Категория",
  tag: "Метка",
  member: "Кто записал",
};

/** Варианты листа фильтра: «Все …» первым, затем записи бюджета; архивные — с пометкой, если по ним есть операции. */
function sheetGroups(
  sheet: SheetKind,
  budget: BudgetState,
  routed: OperationsFilterFields,
  today: string,
  patch: (change: Partial<Record<keyof OperationsFilterFields, string | undefined>>) => void,
): readonly FilterGroup[] {
  const same = (stored: string, wanted: string | undefined) => wanted !== undefined && stored.toLowerCase() === wanted;
  switch (sheet) {
    case "period": {
      const month = monthOfDate(today);
      const previous = shiftMonth(month, -1);
      const year = today.slice(0, 4);
      const range = (from: string | undefined, to: string | undefined): FilterChoice["onSelect"] => () => patch({ from, to });
      const is = (from: string | undefined, to: string | undefined) => routed.from === from && routed.to === to;
      return [{
        key: "quick",
        choices: [
          { key: "all", label: "Весь период", selected: is(undefined, undefined), onSelect: range(undefined, undefined) },
          { key: "month", label: `Этот месяц · ${monthLabel(month, today)}`, selected: is(monthStartDate(month), monthEndDate(month)), onSelect: range(monthStartDate(month), monthEndDate(month)) },
          { key: "previous", label: `Прошлый месяц · ${monthLabel(previous, today)}`, selected: is(monthStartDate(previous), monthEndDate(previous)), onSelect: range(monthStartDate(previous), monthEndDate(previous)) },
          { key: "year", label: `Этот год · ${year}`, selected: is(`${year}-01-01`, `${year}-12-31`), onSelect: range(`${year}-01-01`, `${year}-12-31`) },
        ],
      }];
    }
    case "account": {
      const used = new Set(budget.transactions.flatMap((item) => (item.kind === "transfer" || item.kind === "goal_contribution" ? [item.fromAccountId, item.toAccountId] : [item.accountId])));
      const order = [...budget.accounts].sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0));
      const listed = [...order.filter((item) => item.active), ...order.filter((item) => !item.active && (used.has(item.id) || same(item.id, routed.acc)))];
      return [{
        key: "accounts",
        choices: [
          { key: "all", label: "Все счета", selected: routed.acc === undefined, onSelect: () => patch({ acc: undefined }) },
          ...listed.map((item): FilterChoice => ({
            key: item.id,
            label: item.name,
            ...(item.active ? {} : { detail: "в архиве" }),
            plate: { icon: accountIcon(item), tone: accountTone(item) },
            selected: same(item.id, routed.acc),
            onSelect: () => patch({ acc: item.id.toLowerCase() }),
          })),
        ],
      }];
    }
    case "category": {
      const used = new Set(budget.transactions.flatMap((item) => (item.kind === "expense" || item.kind === "refund" || item.kind === "income") && item.categoryId !== undefined ? [item.categoryId] : []));
      const choiceOf = (item: BudgetState["categories"][number]): FilterChoice => {
        const visual = categoryVisual(item);
        return {
          key: item.id,
          label: item.name,
          ...(item.active ? {} : { detail: "в архиве" }),
          plate: { icon: visual.icon, tone: visual.tone },
          selected: same(item.id, routed.cat),
          onSelect: () => patch({ cat: item.id.toLowerCase(), kind: undefined }),
        };
      };
      const ofType = (type: "expense" | "income") => [
        ...categoriesInListOrder(budget.categories, type),
        ...budget.categories.filter((item) => item.type === type && !item.active && (used.has(item.id) || same(item.id, routed.cat))),
      ].map(choiceOf);
      return [
        { key: "all", choices: [{ key: "all", label: "Все категории", selected: routed.cat === undefined && routed.kind === undefined, onSelect: () => patch({ cat: undefined, kind: undefined }) }] },
        { key: "expense", title: "Расходы", choices: ofType("expense") },
        { key: "income", title: "Доходы", choices: ofType("income") },
        {
          key: "kind",
          title: "Вид операции",
          choices: FEED_KINDS.map((kind): FilterChoice => ({ key: kind, label: KIND_PLURAL[kind], selected: routed.cat === undefined && routed.kind === kind, onSelect: () => patch({ kind, cat: undefined }) })),
        },
      ];
    }
    case "tag": {
      const tags = budget.tags ?? [];
      const used = new Set(budget.transactions.flatMap((item) => item.tagIds ?? []));
      const listed = [...tags.filter((item) => item.active), ...tags.filter((item) => !item.active && (used.has(item.id) || same(item.id, routed.tag)))];
      return [{
        key: "tags",
        choices: [
          { key: "all", label: "Все метки", selected: routed.tag === undefined, onSelect: () => patch({ tag: undefined }) },
          ...listed.map((item): FilterChoice => ({
            key: item.id,
            label: `#${item.name}`,
            detail: item.active ? operationsCount(budget.transactions.filter((one) => one.tagIds?.includes(item.id)).length) : "в архиве",
            selected: same(item.id, routed.tag),
            onSelect: () => patch({ tag: item.id.toLowerCase() }),
          })),
        ],
      }];
    }
    case "member":
      return [{
        key: "members",
        choices: [
          { key: "all", label: "Все участники", selected: routed.member === undefined, onSelect: () => patch({ member: undefined }) },
          ...(budget.members ?? []).filter((item) => item.active).map((item): FilterChoice => ({
            key: item.id,
            label: item.name,
            selected: same(item.id, routed.member),
            onSelect: () => patch({ member: item.id.toLowerCase() }),
          })),
        ],
      }];
  }
}
