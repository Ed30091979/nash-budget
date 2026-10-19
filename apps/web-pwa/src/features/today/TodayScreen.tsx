import type { calculateAnnualPlan, calculateBudget, BudgetState, Member, Transaction } from "@family-budget/domain";
import { Icon, type IconName } from "../../components/Icon";
import { Money } from "../../components/Money";
import { SectionTitle } from "../../components/SectionTitle";
import { categoryVisual } from "../../category-visual";
import { formatDate, formatDay, monthGenitive, monthName, monthNominative, monthOnly } from "../../date-words";
import { MEMBER_FILTER_ALL, transactionAuthorLabel, type MemberFilter } from "../family";
import { OperationAmount, transactionCurrency } from "../operations";
import { formatMoney, moneyScale } from "../../money";
import {
  reach,
  reachWord,
  runsOutOn,
  type PaydayHorizon,
  type PeriodClock,
  type Reach,
  type ReachState,
} from "../../reach";

const transactionLabels: Record<Transaction["kind"], string> = {
  income: "Доход",
  expense: "Расход",
  refund: "Возврат",
  transfer: "Перевод",
  goal_contribution: "Взнос в цель",
  debt_out: "Долг: со счёта",
  debt_in: "Долг: на счёт",
};

/**
 * Как называется край линейки: «до 20 июля», когда дата выведена из доходов, и «до конца июля»,
 * когда выводить было не из чего. Второе — не запасной путь, а обычный: у нового пользователя
 * истории доходов нет вовсе, и придумывать ему аванс приложение не станет.
 */
function paydayLabel(payday: PaydayHorizon): string {
  return payday.source === "income" ? formatDay(payday.date) : `конца ${monthGenitive(payday.date)}`;
}

/**
 * Подпись под насечкой.
 *
 * У выведенной даты слово нужно: без него «20 июля» — просто число в середине полосы. У
 * календарного края оно лишнее: последнее число месяца само себя объясняет, а голос под линейкой
 * в ту же секунду говорит «Хватает до конца сентября». Лишнее слово там стоило второй строки.
 */
function paydayLegend(payday: PaydayHorizon): string {
  return payday.source === "income" ? `${formatDay(payday.date)} · выплата` : formatDay(payday.date);
}

/** Средний расход в день — величина показа, а не хранения: до рубля, без копеек. */
function perDayMinor(line: Reach): number | null {
  return line.perDayMinor === null ? null : Math.round(line.perDayMinor / 100) * 100;
}

function transactionCategoryId(transaction: Transaction): string | null {
  if (transaction.kind === "expense" || transaction.kind === "refund") return transaction.categoryId;
  // Доход тоже бывает с категорией, и тогда строка называет её: «Зарплата», а не «Доход».
  return transaction.kind === "income" ? transaction.categoryId ?? null : null;
}

// §6: вид операции показывает глиф из спрайта, а не знак «+/−» текстом. Смысл дублирован
// подписью строки и суммой со знаком, поэтому сама иконка декоративная.
const transactionIcons: Record<Transaction["kind"], IconName> = {
  income: "arrow-down-left",
  expense: "arrow-up-right",
  refund: "rotate-ccw",
  transfer: "arrow-left-right",
  goal_contribution: "target",
  debt_out: "arrow-up-right",
  debt_in: "arrow-down-left",
};

export type AnnualPlan = ReturnType<typeof calculateAnnualPlan>;
export type BudgetMetrics = ReturnType<typeof calculateBudget>;
export type CategoryRow = { category: BudgetState["categories"][number]; metric: BudgetMetrics["categoryMetrics"][string] | undefined };

/**
 * «Сегодня»: одно огромное число и один голос под ним.
 *
 * Голос отвечает на тот вопрос, с которым приложение открывают, — хватит ли до выплаты, — и
 * важное внутри него отмечено весом, а не размером. Восемь ступеней кегля были восемью уровнями,
 * которые приходилось различать; различать больше нечего.
 *
 * Экран говорит про один месяц — месяц плана. Пока сегодняшний день лежит внутри него, число и
 * линейка — про одно и то же: остаток месяца и на сколько дней вперёд он дотягивает. Когда месяц
 * закрыт (или ещё не начался), линейки нет вовсе: прогноз «хватает до конца сентября» рядом с
 * остатком июля был арифметически бессвязен, и честнее сказать словами, что показан закрытый
 * месяц и почему у него нет прогноза.
 */
export function TodayScreen({ budget, plan, flexibleRows, safeToSpendMinor, flexibleSpentMinor, clock, recentTransactions, categoryById, memberById, memberOptions, memberFilter, onMemberFilterChange, hasRecords, monthToOpen, openingMonth, onOpenMonth, onAdd, onYear, onPlanning, onImport, familyNews }: { budget: BudgetState; plan: AnnualPlan; flexibleRows: CategoryRow[]; safeToSpendMinor: number; flexibleSpentMinor: number; clock: PeriodClock; recentTransactions: Transaction[]; categoryById: Map<string, BudgetState["categories"][number]>; memberById: ReadonlyMap<string, Member>; memberOptions: readonly { readonly value: MemberFilter; readonly label: string }[]; memberFilter: MemberFilter; onMemberFilterChange: (value: MemberFilter) => void; hasRecords: boolean; monthToOpen: string | null; openingMonth?: boolean; onOpenMonth?: (month: string) => void; onAdd: () => void; onYear: () => void; onPlanning: () => void; onImport?: () => void; familyNews: readonly string[] }) {
  const overLimit = flexibleRows.filter((row) => row.metric?.status === "over_limit");
  const nextId = plan.upcomingCommitmentIds[0];
  const next = budget.annualCommitments.find((item) => item.id === nextId);
  const nextMetrics = next ? plan.commitments[next.id] : undefined;
  const safeToSpend = formatMoney(safeToSpendMinor);
  const { today, payday, elapsedDays } = clock;
  const line = reach({
    remainingMinor: safeToSpendMinor,
    spentMinor: flexibleSpentMinor,
    elapsedDays,
    daysAhead: payday.daysAhead,
  });
  const rate = perDayMinor(line);
  const until = paydayLabel(payday);
  // Прогноз округляется до рубля: копейки в «останется 5 000 ₽» — точность, которой у прогноза
  // нет, и она сразу выдаёт в нём арифметику вместо ответа.
  const leftAtPayday = line.perDayMinor === null
    ? safeToSpendMinor
    : Math.round((safeToSpendMinor - line.perDayMinor * payday.daysAhead) / 100) * 100;
  const needPerDay = payday.daysAhead > 0 ? Math.round(safeToSpendMinor / payday.daysAhead / 100) * 100 : 0;
  const monthWord = monthOnly.format(new Date(`${plan.startMonth}-01T00:00:00.000Z`));
  const monthOf = monthGenitive(`${plan.startMonth}-15`);
  return <>
    <h1 className="visually-hidden">Обзор: семейный бюджет</h1>
    <section className={`hero-card${line.state === "out" && clock.inPeriod ? " danger" : ""}`}>
      {/* Эйбрау называет месяц, к которому относятся числа, и больше ничего. Числа дня здесь
          не было: его человек видит в строке состояния телефона, а положение внутри месяца
          показывает линейка под суммой. Слово «сегодня» вдобавок повторяло имя вкладки, на
          которой человек стоит. Приписка появляется только когда месяц не идёт — тогда ей есть
          что сообщить. */}
      <p className="eyebrow">{monthWord}{clock.inPeriod ? "" : clock.position === "after" ? " · закрыт" : " · ещё не начался"}</p>
      <span>{clock.inPeriod ? "Можно на повседневные расходы" : `Осталось от повседневных лимитов ${monthOf}`}</span>
      <strong data-money-scale={moneyScale(safeToSpend)}><Money value={safeToSpendMinor} breakDigits /></strong>
      {clock.inPeriod ? <>
        <span className={`limit-bar hero-reach ${line.state}`} data-spent={line.fill} role="img" aria-label={`Линейка до выплаты: ${reachAnnouncement(line, payday, today)}`} />
        {/* Слева сегодня, у самой насечки — дата края, за ней — запас. Дату сегодняшнего дня
            подпись не повторяет: её уже сказал эйбрау над числом. */}
        <p className="reach-legend">
          <span><span>сегодня</span><b>{paydayLegend(payday)}</b></span>
          <span>{line.surplusDays > 0 ? "запас" : ""}</span>
        </p>
        {line.state === "out"
          ? <p><b>Повседневные лимиты исчерпаны.</b> До {until} ещё {payday.daysAhead} дн. Платежи и накопления учтены отдельно и на них это не влияет.</p>
          : rate === null
            ? <p><b>Хватает до {until}.</b> По повседневным лимитам в этом месяце пока ничего не записано.</p>
            : line.state === "reaches"
              ? <p><b>Хватает до {until}.</b> Тратим <Money value={rate} /> в день — к этому дню останется <Money value={Math.max(0, leftAtPayday)} />.</p>
              : <p><b>Хватает до {formatDay(runsOutOn(today, line.daysCovered) ?? payday.date)}, а до {until} не дотягивает.</b> Тратим <Money value={rate} /> в день; чтобы дотянуть — <Money value={needPerDay} /> в день.</p>}
      </> : <>
        <p>
          <b>{monthNominative(plan.startMonth)} {clock.position === "after" ? "закончился" : "ещё не начался"}.</b> Сегодня {formatDay(today)}, а показан месяц плана: линейка до выплаты считает только внутри своего месяца, и прогноза у него нет. Покупка, записанная сегодняшним числом, в эти конверты не попадёт.
        </p>
        {/* Выход из закрытого месяца. Экран, который называет тупик и ничего не предлагает, —
            это половина ответа: месяц плана кончился, а нового взять неоткуда, и каждая покупка
            уходит мимо конвертов. Открывает месяц человек и только человек: за его спиной это
            не случается, потому что перенос — это его деньги и его план, и приложение обязано
            сначала сказать, что именно оно перенесёт. */}
        {monthToOpen && onOpenMonth ? <>
          <p>Открыть {monthName(monthToOpen)} — значит перенести в него те же лимиты и положить сверху остатки конвертов {monthOf}. {monthNominative(plan.startMonth)} останется в истории со своими числами.</p>
          <button className="primary-button" type="button" disabled={openingMonth} aria-busy={openingMonth} onClick={() => onOpenMonth(monthToOpen)}><span className="icon-label"><Icon name="calendar-clock" size={20} />Открыть {monthName(monthToOpen)}</span></button>
        </> : null}
      </>}
      <button className={monthToOpen && onOpenMonth && !clock.inPeriod ? "secondary-button" : "primary-button"} type="button" onClick={onAdd}><span className="icon-label"><Icon name="plus" size={20} />Записать покупку</span></button>
    </section>

    {/* §6 Семейная новость: единственный заслуженный момент на входе — первое открытие после
        того, как второй участник что-то записал. Стоит под героем и никогда над ним: герой
        не ждёт её и не двигается из-за неё. В потоке, ничего не накрывает. Итог по видам и
        суммам, а не строки операций — те и так стоят в «Последних записях». */}
    {familyNews.length > 0 ? <div className="family-news" role="status">
      <span className="family-news-mark"><Icon name="users" size={24} /></span>
      <div>
        {familyNews.map((line) => <strong key={line}>{line}</strong>)}
        <small>Новое с прошлого раза</small>
      </div>
    </div> : null}

    {overLimit.length ? <div className="limit-alert danger" role="alert"><b>Перелимит</b><span>{overLimit.map((row, index) => <span key={row.category.id}>{index > 0 ? " · " : ""}{row.category.name}: <Money value={row.metric?.overMinor ?? 0} sign="+" /></span>)}</span></div> : null}

    <dl className="month-split">
      <SplitRow icon="repeat" label="Платежи месяца" value={plan.currentMonth.scheduledExpenseMinor} />
      <SplitRow icon="calendar-clock" label="Отложить к срокам" value={plan.currentMonth.annualReserveMinor} />
      <SplitRow icon="wallet" label="Не распределено" value={plan.currentMonth.spendableAfterPlanMinor} />
    </dl>

    {next ? <section className="next-card">
      <div><span className="card-kicker">Ближайший крупный платёж</span><h2>{next.name}</h2><p>{formatDate(next.dueDate)} · <Money value={next.amountMinor} /></p></div>
      <div className="reserve-pill"><span>Откладывать</span><b><Money value={nextMetrics?.monthlyReserveMinor ?? 0} />/мес</b></div>
    </section> : null}

    <section className="section-card">
      <SectionTitle title="Повседневные лимиты" note={clock.inPeriod ? `Та же линейка: дотянет ли конверт до ${until}` : `Итог ${monthOf}: что осталось в конвертах`} />
      <CategoryList rows={flexibleRows} clock={clock} onPlanning={onPlanning} />
    </section>

    <button className="year-preview" type="button" onClick={onYear}><span className="row-mark"><Icon name="calendar" size={24} /></span><span className="row-copy"><b>Посмотреть 12–24 месяца</b><small>Сезонные расходы, обучение, лагерь, страховка и дом</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></button>

    <section className="section-card">
      <SectionTitle title="Последние записи" note="Фактические операции" />
      {memberOptions.length > 2 ? <div className="field member-filter">
        <label htmlFor="history-member-filter">Кто записал</label>
        <select id="history-member-filter" value={memberFilter} onChange={(event) => onMemberFilterChange(event.target.value as MemberFilter)}>
          {memberOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div> : null}
      <TransactionList transactions={recentTransactions} accounts={budget.accounts} categoryById={categoryById} memberById={memberById} showAuthor={memberOptions.length > 2} onAdd={onAdd} hiddenByMemberFilter={hasRecords && memberFilter !== MEMBER_FILTER_ALL} onShowEveryone={() => onMemberFilterChange(MEMBER_FILTER_ALL)} />
    </section>

    {/* Холодный старт: пока записей нет, вторая дверь — выписка банка. Она стоит после пустого
        состояния, а не внутри него: основное действие там одно, ручная запись, и порядок «сначала
        руками, потом банк» — тот, что повышает доверие (§6 исследования, пункт 31). Постоянный дом
        импорта — «Ещё → Данные»; здесь только дверь для того, у кого история ещё пуста. */}
    {!hasRecords && onImport ? <button className="year-preview" type="button" onClick={onImport}><span className="row-mark"><Icon name="receipt-text" size={24} /></span><span className="row-copy"><b>Загрузить выписку банка</b><small>CSV из Т-Банка. Файл читается на этом устройстве и никуда не уходит</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></button> : null}
  </>;
}

/**
 * Строка разбора месяца: подпись слева, сумма справа столбцом (§7.4).
 *
 * Числа здесь поддерживают герой-число, а не спорят с ним: тот же кегль, что у обычного текста,
 * начертание 600 против 700 у героя и приглушённая подпись (§1 и §2 исследования).
 */
function SplitRow({ icon, label, value }: { icon: IconName; label: string; value: number }) {
  return <div><dt><Icon name={icon} size={20} />{label}</dt><dd><Money value={value} /></dd></div>;
}

/** Глиф состояния линейки: слово и глиф вместе, цвет — третьим (§6). */
const reachIcons: Record<ReachState, IconName> = {
  reaches: "circle-check",
  short: "triangle-alert",
  out: "circle-alert",
};

/**
 * Состояние линейки словами — для читающих с экрана и для проверок.
 *
 * Цвет заливки здесь ничего не решает: та же мысль сказана словом чипа, положением заливки
 * относительно насечки и вот этой строкой. Дальтонизм — у восьми процентов мужчин.
 */
function reachAnnouncement(line: Reach, payday: PaydayHorizon, today: string): string {
  const edge = payday.source === "income"
    ? `выплаты ${formatDay(payday.date)}`
    : `конца месяца, ${formatDay(payday.date)}`;
  if (line.state === "out") return `денег не осталось, до ${edge} ещё ${payday.daysAhead} дн.`;
  const out = runsOutOn(today, line.daysCovered);
  if (line.state === "reaches") {
    return out === null
      ? `трат ещё не было, до ${edge} денег хватает`
      : `хватает до ${formatDay(out)}, то есть дальше ${edge}`;
  }
  return `хватает до ${out === null ? "неизвестного дня" : formatDay(out)}, а это раньше ${edge}`;
}

/**
 * Список лимитов месяца в грамматике той же линейки.
 *
 * Насечка у всех строк стоит на одной доле полосы, поэтому сквозь карточку проходит одна
 * вертикаль, и видно, какие конверты её не пересекают. Полоса «сколько процентов лимита
 * израсходовано» отвечала на вопрос, которого семья не задаёт.
 *
 * У закрытого месяца линейки нет: прогноз «до 20 июля» из сентября — не прогноз. Строка тогда
 * называет итог словами и числами: сколько осталось, сколько ушло из лимита.
 */
function CategoryList({ rows, clock, onPlanning }: { rows: CategoryRow[]; clock: PeriodClock; onPlanning: () => void }) {
  // Пустой список — не пустая разметка: §6 исследования требует назвать состояние, объяснить его
  // и дать дорогу дальше. Раньше здесь оставалась пустая карточка без единого слова.
  if (!rows.length) return <div className="empty-state">
    <span className="empty-state-mark"><Icon name="target" size={32} /></span>
    <h3>Лимитов на этот месяц нет</h3>
    <p>Лимит — сумма на месяц по одной статье: продукты, транспорт, развлечения. Пока его нет, приложение не может сказать, сколько по ней осталось.</p>
    <button className="primary-button" type="button" onClick={onPlanning}>Задать лимиты в плане</button>
  </div>;
  const { today, payday, elapsedDays } = clock;
  return <ul className={`category-list${clock.inPeriod ? "" : " closed"}`}>{rows.map(({ category, metric }) => {
    if (!metric) return null;
    const visual = categoryVisual(category);
    const line = reach({
      remainingMinor: metric.remainingMinor,
      spentMinor: metric.actualMinor,
      elapsedDays,
      daysAhead: payday.daysAhead,
      overLimit: metric.status === "over_limit",
    });
    const rate = perDayMinor(line);
    const out = runsOutOn(today, line.daysCovered);
    const overMinor = metric.overMinor ?? 0;
    // Факт и путь: нехватка не называется без числа, которым её закрывают. «До 12-го» — факт,
    // «чтобы дотянуть — 400 ₽ в день» — путь; строка без второго была бы упрёком без ответа.
    const needPerDay = payday.daysAhead > 0 ? Math.round(Math.max(0, metric.remainingMinor) / payday.daysAhead / 100) * 100 : 0;
    // Закрытый месяц: слово итога вместо слова прогноза. «Хватило» — конверт дожил до конца
    // месяца с остатком; «Конверт пуст» и «Перелимит» — факты, они не меняются.
    const chipState: ReachState = line.state === "out" ? "out" : clock.inPeriod ? line.state : "reaches";
    const chipWord = line.state === "out" && overMinor > 0
      ? <>Перелимит <Money value={overMinor} /></>
      : clock.inPeriod ? reachWord(line.state) : line.state === "out" ? reachWord("out") : "Хватило";
    return <li key={category.id}>
      <div className="category-head">
        <span className={`category-tile tone-${visual.tone}`}><Icon name={visual.icon} size={24} /></span>
        <strong>{category.name}</strong>
        <span className={`status-chip ${chipState}`}>
          <Icon name={reachIcons[chipState]} size={20} />
          {chipWord}
        </span>
      </div>
      {clock.inPeriod ? <span className={`limit-bar ${line.state}`} data-spent={line.fill} role="img" aria-label={`${category.name}: ${reachAnnouncement(line, payday, today)}`} /> : null}
      <div className="category-values">
        {clock.inPeriod ? <>
          <span><b><Money value={Math.max(0, metric.remainingMinor)} /></b>{rate === null ? "" : <> · <Money value={rate} /> в день</>}</span>
          {line.state === "out"
            ? <span className="out">{overMinor > 0 ? "потрачено сверх лимита" : "конверт пуст"}</span>
            : line.state === "short" && out !== null
              ? <span className="short">до {formatDay(out)} · чтобы дотянуть — <Money value={needPerDay} /> в день</span>
              : <span>{out === null ? "трат не было" : `до ${formatDay(out)}`}</span>}
        </> : <>
          <span><b><Money value={Math.max(0, metric.remainingMinor)} /></b> осталось</span>
          <span className={line.state === "out" ? "out" : undefined}>ушло <Money value={metric.actualMinor} /> из <Money value={metric.availableMinor} /></span>
        </>}
      </div>
    </li>;
  })}</ul>;
}

function TransactionList({ transactions, accounts, categoryById, memberById, showAuthor, onAdd, hiddenByMemberFilter = false, onShowEveryone }: { transactions: Transaction[]; accounts: BudgetState["accounts"]; categoryById: Map<string, BudgetState["categories"][number]>; memberById: ReadonlyMap<string, Member>; showAuthor: boolean; onAdd?: () => void; hiddenByMemberFilter?: boolean; onShowEveryone?: () => void }) {
  // §6 исследования, пункт 29: пустое состояние обязано сообщить состояние системы, объяснить,
  // что сюда попадает, и дать прямой путь к задаче. «Здесь появятся операции» отвечало только на
  // первый вопрос, и человек, только что создавший бюджет, оставался с ним один на один.
  //
  // И оно же врало: список фильтруется по участнику, и у участника без записей эта строка
  // утверждала, что операций не появилось вовсе, — при полном бюджете рядом. Пустой список и
  // список, опустевший от фильтра, — разные состояния системы, и называются они по-разному.
  if (!transactions.length) return <div className="empty-state">
    <span className="empty-state-mark"><Icon name="inbox" size={32} /></span>
    {hiddenByMemberFilter ? <>
      <h3>У выбранного участника записей нет</h3>
      <p>Фильтр показывает операции одного человека. Записи остальных на месте — они вернутся, как только фильтр снят.</p>
      {onShowEveryone ? <button className="primary-button" type="button" onClick={onShowEveryone}>Показать записи всех</button> : null}
    </> : <>
      <h3>Записей пока нет</h3>
      <p>Здесь будут пять последних покупок, доходов и переводов — в том порядке, в каком они случились.</p>
      {onAdd ? <button className="primary-button" type="button" onClick={onAdd}>Записать первую операцию</button> : null}
    </>}
  </div>;
  return <ul className="transaction-list">{transactions.map((transaction) => {
    const categoryId = transactionCategoryId(transaction);
    const category = categoryId === null ? undefined : categoryById.get(categoryId);
    const visual = category ? categoryVisual(category) : null;
    const kindLabel = transactionLabels[transaction.kind];
    const title = category ? category.name : kindLabel;
    // «Доход · 1 июл. · Доход» — вид операции, названный дважды подряд, потому что у дохода без
    // категории названием строки становится он сам. Подпись повторяет название только тогда,
    // когда ей есть что добавить.
    const note = [formatDate(transaction.occurredOn)];
    if (category) note.push(kindLabel);
    if (showAuthor) note.push(transactionAuthorLabel(memberById, transaction.memberId));
    return <li className={`transaction-row ${transaction.kind}`} key={transaction.id}>
      <span className={`transaction-icon ${visual ? `tone-${visual.tone}` : "tone-neutral"}`}><Icon name={visual ? visual.icon : transactionIcons[transaction.kind]} size={24} /></span>
      <span className="transaction-copy">
        <strong>{title}</strong>
        <small>{note.join(" · ")}</small>
      </span>
      {/* В валюте счёта операции, как в «Вся история»: «₽» у покупки по счёту в долларах был бы неправдой. */}
      <b><OperationAmount value={transaction.amountMinor} currency={transactionCurrency(transaction, { accounts })} sign={transactionSign(transaction.kind)} /></b>
    </li>;
  })}</ul>;
}

/** Направление операции в строке. Сумма хранится положительной, знак принадлежит строке. */
function transactionSign(kind: Transaction["kind"]): "+" | "−" | undefined {
  if (kind === "income" || kind === "refund") return "+";
  return kind === "expense" ? "−" : undefined;
}
