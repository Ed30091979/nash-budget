import { useDeferredValue, useMemo, useState } from "react";
import { baseCurrencyOf, categoriesInListOrder, monthEndDate, monthOfDate, monthStartDate, shiftMonth, type BudgetState, type Transaction } from "@family-budget/domain";
import { accountIcon, accountTone, categoryVisual } from "../../category-visual";
import { EmptyState } from "../../components/EmptyState";
import { Hyphenated } from "../../components/Hyphenated";
import { Icon } from "../../components/Icon";
import { LargeTitle } from "../../components/LargeTitle";
import { Money } from "../../components/Money";
import { TitleBar, type TitleBarBack } from "../../components/TitleBar";
import { FEED_KINDS, type OperationsFilterFields } from "../../navigation/routes";
import { plainInputValue } from "../../plain-text";
import { membersById, transactionAuthorLabel } from "../family/model";
import { operationsCount } from "../operations/transaction-words";
import { DayGroup } from "./DayGroup";
import {
  FEED_PAGE_SIZE,
  feedIndex,
  feedPeriodLabel,
  feedScope,
  filterFeed,
  filtersOfRoute,
  groupByDay,
  hasFilters,
  KIND_PLURAL,
  listedAccounts,
  monthLabel,
  offersAllTime,
  parseSearch,
  patchFilters,
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
  /**
   * «‹ Отчёты»: лента открыта строкой легенды поверх «Отчётов» и ведёт назад к той же записи истории
   * (ревью 2d, LOW-6). Без него — вкладка с крупным заголовком: с неё «Назад» ведёт на «Обзор».
   */
  readonly back?: TitleBarBack;
}

/** Участник фильтра, чьей записи в бюджете уже нет: имени назвать нельзя, а фильтр виден и снимается. */
export const FORMER_MEMBER = "Участник, вышедший из семьи";

/** Наш текст с заглавной — в доступном имени после двоеточия строчной: «Период: октябрь». */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

type SheetKind = "period" | "account" | "category" | "tag" | "member";

/**
 * «Операции» (подволна 2d, дизайн 5.0, макет 08): крупный заголовок, поиск «Сумма, комментарий или
 * #метка», чипы фильтров, строка итогов и лента по дням с итогом дня; по 50 строк, «Показать ещё»
 * добавляет столько же. По умолчанию — текущий месяц: у месяца итоги дней и строка «Расходы · Доходы»
 * говорят о чём-то, у всей истории — нет. «Весь период» — в листе периода, а поиск, который за месяц
 * нашёл мало, предлагает «Искать за всё время» и сохраняет набранное (ревью 2d, LOW-11).
 *
 * Фильтры — в адресе, закрытыми типами (`navigation/routes.ts`): «Назад» с листа правки и из
 * «Отчётов» возвращает их, перезагрузка — тоже. Строка поиска — свободный текст, и в адрес она не
 * попадает никогда: она живёт в памяти этого экрана (`useState` ниже) — переживает лист правки поверх
 * него и смену фильтра, а уход с экрана и перезагрузку не переживает (SECURITY §7.3,
 * `address-privacy.test.ts`).
 */
export function FeedScreen({ budget, today, filters: routed, onFilters, onEdit, onAdd, onImport, busy = false, back }: FeedScreenProps) {
  const [search, setSearch] = useState("");
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const filters = useMemo(() => filtersOfRoute(routed), [routed]);
  const scope = useMemo(() => feedScope(filters, today), [filters, today]);
  const deferredSearch = useDeferredValue(search);
  const index = feedIndex(budget);
  const parsed = useMemo(() => parseSearch(deferredSearch), [deferredSearch]);
  const result = useMemo(() => filterFeed(index, scope, parsed), [index, scope, parsed]);
  // Страница — от того, что найдено: другой фильтр или запрос возвращает список к первой странице.
  const listKey = `${JSON.stringify(routeOfFilters(filters))}|${deferredSearch}`;
  const [page, setPage] = useState({ key: listKey, count: FEED_PAGE_SIZE });
  const visible = page.key === listKey ? page.count : FEED_PAGE_SIZE;
  const days = useMemo(() => groupByDay(result.entries, visible), [result.entries, visible]);

  const activeMembers = (budget.members ?? []).filter((member) => member.active);
  // Чип участника — в семье, и всегда, пока фильтр по участнику задан: даже по тому, кто из семьи
  // вышел, — иначе фильтр не виден и не снимается (ревью 2d, LOW-7).
  const showMembers = activeMembers.length > 0 || routed.member !== undefined;
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
  const patch = (change: Partial<Record<keyof OperationsFilterFields, string | undefined>>) => apply(patchFilters(routed, change));
  const allTime = () => patch({ period: "all" });
  const resetAll = () => {
    setSearch("");
    setSheet(null);
    if (filtering) onFilters({});
  };

  const account = routed.acc === undefined ? undefined : budget.accounts.find((item) => item.id.toLowerCase() === routed.acc);
  const category = routed.cat === undefined ? undefined : budget.categories.find((item) => item.id.toLowerCase() === routed.cat);
  const tag = routed.tag === undefined ? undefined : (budget.tags ?? []).find((item) => item.id.toLowerCase() === routed.tag);
  // Участник фильтра — и вышедший из семьи: его имя, а не безымянное «Участник» (LOW-7).
  const member = routed.member === undefined ? undefined : (budget.members ?? []).find((item) => item.id.toLowerCase() === routed.member);
  const memberName = routed.member === undefined ? undefined : member?.name ?? FORMER_MEMBER;
  const periodText = feedPeriodLabel(filters, today);
  const categoryText = category?.name ?? (routed.kind === undefined ? "Все категории" : KIND_PLURAL[routed.kind]);
  const chips = [
    { key: "period", label: periodText, name: `Период: ${lowerFirst(periodText)}`, set: routed.period !== undefined || routed.from !== undefined || routed.to !== undefined },
    { key: "account", label: account?.name ?? "Все счета", name: account === undefined ? "Счёт: все счета" : `Счёт: ${account.name}`, set: routed.acc !== undefined },
    { key: "category", label: categoryText, name: category === undefined ? `Категория: ${lowerFirst(categoryText)}` : `Категория: ${category.name}`, set: routed.cat !== undefined || routed.kind !== undefined },
    ...((budget.tags ?? []).length > 0 || routed.tag !== undefined ? [{ key: "tag", label: tag === undefined ? "Метки" : `#${tag.name}`, name: tag === undefined ? "Метка: все метки" : `Метка: #${tag.name}`, set: routed.tag !== undefined }] : []),
    ...(showMembers ? [{ key: "member", label: memberName ?? "Участник", name: memberName === undefined ? "Участник: все участники" : `Участник: ${memberName}`, set: routed.member !== undefined }] : []),
  ].map((chip) => ({ ...chip, expanded: sheet === chip.key, onOpen: () => setSheet(chip.key as SheetKind) }));
  // «Искать за всё время»: поиск за месяц или свои дни нашёл мало — набранное остаётся, период — вся история.
  const widen = searching && offersAllTime(parsed, filters, result.entries.length);

  // Список, опустевший от одного фильтра участника, — не пустой бюджет и не пустой поиск: у этого
  // участника записей нет, а у остальных — есть.
  const onlyMember = !searching && routed.member !== undefined && Object.keys(routeOfFilters(filters)).length === 1;

  const importAction = (
    <button className="icon-button" type="button" aria-label="Загрузить выписку банка" onClick={onImport}><Icon name="receipt-text" size={24} /></button>
  );
  return <div className="feed-screen">
    {/* Вкладка — крупным заголовком; «назад» у неё нет: с вкладки системное «Назад» ведёт на «Обзор».
        Лента, открытая из «Отчётов», — строкой заголовка «‹ Отчёты»: назад к той же записи истории. */}
    {/* При ×2.7 «Операции» шире строки: перенос по слогам с дефисом, а не посреди слова (§4). */}
    {back === undefined
      ? <LargeTitle id={FEED_TITLE_ID} title={<Hyphenated text="Операции" />} action={importAction} />
      : <TitleBar back={back} titleId={FEED_TITLE_ID} title={<Hyphenated text="Операции" />} action={importAction} />}
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
      {/* Итоги — того, что показано: по умолчанию это месяц, и строка говорит о нём. */}
      {result.entries.length > 0 ? (
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
        ) : !searching && !filtering ? (
          // Лента по умолчанию — месяц; в этом месяце записей нет, а в других есть.
          <EmptyState glyph="history" title={`${periodText}: записей нет`} text="Записи других месяцев — за весь период." action={{ label: "Показать весь период", onClick: allTime }} />
        ) : widen ? (
          <EmptyState glyph="search" title="Ничего не нашлось" text={`Поиск — в периоде «${periodText}». Поищите за всё время или другим словом.`} action={{ label: "Искать за всё время", onClick: allTime }} />
        ) : (
          <EmptyState glyph="search" title="Ничего не нашлось" text="Попробуйте сумму или другое слово." action={{ label: "Сбросить фильтры", onClick: resetAll }} />
        )
      ) : null}
      {widen && result.entries.length > 0 ? (
        <div className="feed-widen">
          <p>Поиск — в периоде «{periodText}».</p>
          <button className="secondary-button wide" type="button" onClick={allTime}>Искать за всё время</button>
        </div>
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
      const range = (from: string | undefined, to: string | undefined): FilterChoice["onSelect"] => () => patch({ period: undefined, from, to });
      const is = (from: string | undefined, to: string | undefined) => routed.period === undefined && routed.from === from && routed.to === to;
      // «Этот месяц» — лента по умолчанию, без ключей в адресе; те же дни, пришедшие из «Отчётов», — тоже он.
      const thisMonth = is(undefined, undefined) || is(monthStartDate(month), monthEndDate(month));
      return [{
        key: "quick",
        choices: [
          { key: "month", label: `Этот месяц · ${monthLabel(month, today)}`, selected: thisMonth, onSelect: range(undefined, undefined) },
          { key: "all", label: "Весь период", selected: routed.period === "all", onSelect: () => patch({ period: "all" }) },
          { key: "previous", label: `Прошлый месяц · ${monthLabel(previous, today)}`, selected: is(monthStartDate(previous), monthEndDate(previous)), onSelect: range(monthStartDate(previous), monthEndDate(previous)) },
          { key: "year", label: `Этот год · ${year}`, selected: is(`${year}-01-01`, `${year}-12-31`), onSelect: range(`${year}-01-01`, `${year}-12-31`) },
        ],
      }];
    }
    case "account": {
      const listed = listedAccounts(budget, routed.acc);
      return [{
        key: "accounts",
        choices: [
          { key: "all", label: "Все счета", selected: routed.acc === undefined, onSelect: () => patch({ acc: undefined }) },
          ...listed.map((item): FilterChoice => ({
            key: item.id,
            label: item.name,
            ...(item.active ? {} : { detail: "в архиве" }),
            // Знак чужой валюты — как у строки «Счетов» и плитки «Обзора» (`accountIcon` с базой).
            plate: { icon: accountIcon(item, baseCurrencyOf(budget)), tone: accountTone(item) },
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
    case "member": {
      // Активные участники и выбранный, даже вышедший из семьи: выбор виден, «Все участники» его снимает (LOW-7).
      const members = (budget.members ?? []).filter((item) => item.active || same(item.id, routed.member));
      const known = routed.member === undefined || members.some((item) => same(item.id, routed.member));
      return [{
        key: "members",
        choices: [
          { key: "all", label: "Все участники", selected: routed.member === undefined, onSelect: () => patch({ member: undefined }) },
          ...members.map((item): FilterChoice => ({
            key: item.id,
            label: item.name,
            ...(item.active ? {} : { detail: "вышел из семьи" }),
            selected: same(item.id, routed.member),
            onSelect: () => patch({ member: item.id.toLowerCase() }),
          })),
          ...(known ? [] : [{ key: "former", label: FORMER_MEMBER, selected: true, onSelect: () => undefined } satisfies FilterChoice]),
        ],
      }];
    }
  }
}
