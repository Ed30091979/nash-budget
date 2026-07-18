import { type ChangeEvent, type FormEvent, useEffect, useMemo, useState } from "react";
import {
  calculateAnnualPlan,
  calculateBudget,
  makePlanningSeed,
  type AnnualCommitment,
  type BudgetState,
  type ScheduledExpense,
  type Transaction,
} from "@family-budget/domain";
import {
  IndexedDbBudgetRepository,
  requestStorageHealth,
  serializeBackup,
  type StorageHealth,
} from "@family-budget/storage";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { prepareBudgetState, restoreBudgetBackup } from "./backup";
import { formatMoney, parseMoney } from "./money";

type Screen = "today" | "year" | "operations" | "more";
type EntryKind = "expense" | "income";
type Horizon = 12 | 24;

const monthLong = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
const monthShort = new Intl.DateTimeFormat("ru-RU", { month: "short", year: "2-digit", timeZone: "UTC" });
const dateShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const calendarMonths = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

const statusLabels: Record<string, string> = {
  no_plan: "Без лимита",
  normal: "В норме",
  near_limit: "Почти лимит",
  exhausted: "Лимит исчерпан",
  over_limit: "Перелимит",
  funded: "Сумма собрана",
  on_track: "По плану",
  due_soon: "Скоро платёж",
  overdue: "Срок прошёл",
};

const transactionLabels: Record<Transaction["kind"], string> = {
  income: "Доход",
  expense: "Расход",
  refund: "Возврат",
  transfer: "Перевод",
  goal_contribution: "Взнос в цель",
};

function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatDate(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : dateShort.format(date);
}

function formatMonth(value: string, compact = false): string {
  const date = new Date(`${value}-01T00:00:00.000Z`);
  return compact ? monthShort.format(date).replace(" г.", "") : monthLong.format(date).replace(" г.", "");
}

function transactionCategoryId(transaction: Transaction): string | null {
  return transaction.kind === "expense" || transaction.kind === "refund" ? transaction.categoryId : null;
}

function transactionSign(transaction: Transaction): string {
  if (transaction.kind === "income" || transaction.kind === "refund") return "+";
  if (transaction.kind === "transfer" || transaction.kind === "goal_contribution") return "↔";
  return "−";
}

function storageText(health: StorageHealth | null): string {
  if (!health) return "Проверяем локальное хранилище…";
  if (health.quota === null || health.usage === null) {
    return health.persisted ? "Постоянное локальное хранение разрешено." : "Хранилище браузера работает в обычном режиме.";
  }
  return `${(health.usage / 1024 / 1024).toFixed(1)} МБ из ${(health.quota / 1024 / 1024).toFixed(0)} МБ`;
}

export default function App() {
  const repository = useMemo(() => new IndexedDbBudgetRepository<BudgetState>(), []);
  const [budget, setBudget] = useState<BudgetState | null>(null);
  const [screen, setScreen] = useState<Screen>("today");
  const [horizon, setHorizon] = useState<Horizon>(12);
  const [online, setOnline] = useState(navigator.onLine);
  const [storageHealth, setStorageHealth] = useState<StorageHealth | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [entryKind, setEntryKind] = useState<EntryKind>("expense");
  const [entryAmount, setEntryAmount] = useState("");
  const [entryCategoryId, setEntryCategoryId] = useState("");
  const [entryDate, setEntryDate] = useState(todayLocal);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const stored = await repository.load();
        const next = stored ? prepareBudgetState(stored) : makePlanningSeed();
        await repository.save(next);
        if (!cancelled) setBudget(next);
      } catch {
        if (!cancelled) {
          setBudget(makePlanningSeed());
          setMessage("Хранилище браузера недоступно: изменения сохранятся только до закрытия страницы.");
        }
      }
      try {
        const health = await requestStorageHealth();
        if (!cancelled) setStorageHealth(health);
      } catch {
        if (!cancelled) setStorageHealth({ persisted: false, usage: null, quota: null });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [repository]);

  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    return () => {
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", disconnected);
    };
  }, []);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  const metrics = useMemo(() => budget ? calculateBudget(budget) : null, [budget]);
  const plan = useMemo(() => {
    if (!budget) return null;
    const active = budget.budgets.find((item) => item.id === budget.activeBudgetId);
    return calculateAnnualPlan(budget, active?.startDate.slice(0, 7), horizon);
  }, [budget, horizon]);
  const categoryById = useMemo(
    () => new Map(budget?.categories.map((category) => [category.id, category]) ?? []),
    [budget],
  );

  const commitBudget = async (next: BudgetState, successMessage?: string) => {
    setBudget(next);
    try {
      await repository.save(next);
      if (successMessage) setMessage(successMessage);
    } catch {
      setMessage("Изменение видно сейчас, но браузер не смог сохранить его локально.");
    }
  };

  const addTransaction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!budget) return;
    try {
      const amountMinor = parseMoney(entryAmount);
      const account = budget.accounts[0];
      if (!account) throw new Error("Сначала нужен хотя бы один счёт.");
      const transaction: Transaction = entryKind === "income"
        ? { id: crypto.randomUUID(), occurredOn: entryDate, status: "posted", kind: "income", amountMinor, accountId: account.id }
        : { id: crypto.randomUUID(), occurredOn: entryDate, status: "posted", kind: "expense", amountMinor, accountId: account.id, categoryId: entryCategoryId || budget.categories[0]?.id || "" };
      if (transaction.kind === "expense" && !transaction.categoryId) throw new Error("Выберите категорию расхода.");
      await commitBudget({ ...budget, transactions: [...budget.transactions, transaction] }, "Операция сохранена.");
      setEntryAmount("");
      setScreen("today");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось сохранить операцию.");
    }
  };

  const exportBackup = () => {
    if (!budget) return;
    const url = URL.createObjectURL(new Blob([serializeBackup(budget)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `family-budget-${todayLocal()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("Резервная копия подготовлена.");
  };

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      await restoreBudgetBackup(
        file,
        (restored) => repository.save(restored),
        (restored) => setBudget(restored),
      );
      setMessage("Резервная копия восстановлена.");
      setScreen("today");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось восстановить копию.");
    }
  };

  if (!budget || !metrics || !plan) return <main className="content" aria-busy="true"><p>Открываем семейный план…</p></main>;

  const activeBudget = budget.budgets.find((item) => item.id === budget.activeBudgetId)!;
  const flexibleIds = new Set(activeBudget.lines.map((line) => line.categoryId));
  const flexibleRows = budget.categories
    .filter((category) => flexibleIds.has(category.id))
    .map((category) => ({ category, metric: metrics.categoryMetrics[category.id] }))
    .filter((row) => row.metric);
  const flexibleSpentMinor = flexibleRows.reduce((total, row) => total + (row.metric?.actualMinor ?? 0), 0);
  const safeToSpendMinor = plan.currentMonth.flexiblePlanMinor - flexibleSpentMinor;
  const recentTransactions = [...budget.transactions]
    .filter((transaction) => transaction.status === "posted")
    .sort((left, right) => right.occurredOn.localeCompare(left.occurredOn))
    .slice(0, screen === "operations" ? 50 : 5);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand"><span className="brand-mark">₽</span><div><strong>Семейный план</strong><small>видим месяц и будущее</small></div></div>
        <span className={`network-badge${online ? "" : " offline"}`}>{online ? "в сети" : "офлайн"}</span>
      </header>

      <nav className="bottom-nav" aria-label="Основные разделы">
        <NavButton active={screen === "today"} icon="⌂" label="Сегодня" onClick={() => setScreen("today")} />
        <NavButton active={screen === "year"} icon="▦" label="Год" onClick={() => setScreen("year")} />
        <NavButton active={screen === "operations"} icon="＋" label="Записать" onClick={() => setScreen("operations")} />
        <NavButton active={screen === "more"} icon="•••" label="Ещё" onClick={() => setScreen("more")} />
      </nav>

      <main className="content">
        {screen === "today" ? <TodayScreen budget={budget} plan={plan} flexibleRows={flexibleRows} safeToSpendMinor={safeToSpendMinor} recentTransactions={recentTransactions} categoryById={categoryById} onAdd={() => setScreen("operations")} onYear={() => setScreen("year")} /> : null}
        {screen === "year" ? <YearScreen budget={budget} plan={plan} horizon={horizon} onHorizon={setHorizon} categoryById={categoryById} /> : null}
        {screen === "operations" ? <OperationsScreen budget={budget} entryKind={entryKind} entryAmount={entryAmount} entryCategoryId={entryCategoryId} entryDate={entryDate} transactions={recentTransactions} categoryById={categoryById} onKindChange={setEntryKind} onAmountChange={setEntryAmount} onCategoryChange={setEntryCategoryId} onDateChange={setEntryDate} onSubmit={(event) => void addTransaction(event)} /> : null}
        {screen === "more" ? <MoreScreen storageHealth={storageHealth} showIosInstall={isIos && !isStandalone} onExport={exportBackup} onImport={(event) => void importBackup(event)} /> : null}
      </main>

      {message ? <aside className="message-toast" role="status"><p>{message}</p><button className="primary-button" type="button" onClick={() => setMessage(null)}>Закрыть</button></aside> : null}
      <UpdatePrompt />
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: string; label: string; onClick: () => void }) {
  return <button className={`nav-button${active ? " active" : ""}`} type="button" onClick={onClick} aria-current={active ? "page" : undefined}><b aria-hidden="true">{icon}</b><span>{label}</span></button>;
}

type AnnualPlan = ReturnType<typeof calculateAnnualPlan>;
type BudgetMetrics = ReturnType<typeof calculateBudget>;
type CategoryRow = { category: BudgetState["categories"][number]; metric: BudgetMetrics["categoryMetrics"][string] | undefined };

function TodayScreen({ budget, plan, flexibleRows, safeToSpendMinor, recentTransactions, categoryById, onAdd, onYear }: { budget: BudgetState; plan: AnnualPlan; flexibleRows: CategoryRow[]; safeToSpendMinor: number; recentTransactions: Transaction[]; categoryById: Map<string, BudgetState["categories"][number]>; onAdd: () => void; onYear: () => void }) {
  const overLimit = flexibleRows.filter((row) => row.metric?.status === "over_limit");
  const nextId = plan.upcomingCommitmentIds[0];
  const next = budget.annualCommitments.find((item) => item.id === nextId);
  const nextMetrics = next ? plan.commitments[next.id] : undefined;
  return <>
    <div className="eyebrow">{formatMonth(plan.startMonth)}</div>
    <section className={`hero-card${safeToSpendMinor < 0 ? " danger" : ""}`}>
      <span>Можно на повседневные расходы</span>
      <strong>{formatMoney(safeToSpendMinor)}</strong>
      <p>Остаток лимитов после уже записанных покупок. Обязательные платежи и накопления учтены отдельно.</p>
      <button className="hero-button" type="button" onClick={onAdd}>+ Записать покупку</button>
    </section>

    {overLimit.length ? <div className="limit-alert danger" role="alert"><b>Перелимит</b><span>{overLimit.map((row) => `${row.category.name}: +${formatMoney(row.metric?.overMinor ?? 0)}`).join(" · ")}</span></div> : null}

    <div className="quick-grid">
      <QuickCard icon="↻" label="Платежи месяца" value={formatMoney(plan.currentMonth.scheduledExpenseMinor)} />
      <QuickCard icon="◎" label="Отложить к срокам" value={formatMoney(plan.currentMonth.annualReserveMinor)} />
      <QuickCard icon="◌" label="Не распределено" value={formatMoney(plan.currentMonth.spendableAfterPlanMinor)} />
    </div>

    {next ? <section className="next-card">
      <div><span className="card-kicker">Ближайший крупный платёж</span><h2>{next.name}</h2><p>{formatDate(next.dueDate)} · {formatMoney(next.amountMinor)}</p></div>
      <div className="reserve-pill"><span>Откладывать</span><b>{formatMoney(nextMetrics?.monthlyReserveMinor ?? 0)}/мес</b></div>
    </section> : null}

    <section className="section-card">
      <SectionTitle title="Повседневные лимиты" note="Мелкие покупки этого месяца" />
      <CategoryList rows={flexibleRows} />
    </section>

    <button className="year-preview" type="button" onClick={onYear}><span><b>Посмотреть 12–24 месяца</b><small>Сезонные расходы, обучение, лагерь, страховка и дом</small></span><strong>→</strong></button>

    <section className="section-card"><SectionTitle title="Последние записи" note="Фактические операции" /><TransactionList transactions={recentTransactions} categoryById={categoryById} /></section>
  </>;
}

function QuickCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return <article className="quick-card"><i aria-hidden="true">{icon}</i><span>{label}</span><strong>{value}</strong></article>;
}

function YearScreen({ budget, plan, horizon, onHorizon, categoryById }: { budget: BudgetState; plan: AnnualPlan; horizon: Horizon; onHorizon: (value: Horizon) => void; categoryById: Map<string, BudgetState["categories"][number]> }) {
  return <>
    <div className="screen-heading"><div><span className="card-kicker">Планирование</span><h1>Горизонт семьи</h1><p>Все ожидаемые деньги по месяцам — без смешивания с фактическими покупками.</p></div><div className="horizon-toggle" aria-label="Горизонт"><button className={horizon === 12 ? "active" : ""} type="button" onClick={() => onHorizon(12)}>12 мес.</button><button className={horizon === 24 ? "active" : ""} type="button" onClick={() => onHorizon(24)}>24 мес.</button></div></div>

    <div className="month-strip" aria-label="План по месяцам">
      {plan.months.map((month) => <article className={`month-card${month.spendableAfterPlanMinor < 0 ? " risk" : ""}`} key={month.month}>
        <header><b>{formatMonth(month.month, true)}</b>{month.annualDueMinor > 0 ? <span>платёж</span> : null}</header>
        <dl><div><dt>Доход</dt><dd>{formatMoney(month.plannedIncomeMinor)}</dd></div><div><dt>По расписанию</dt><dd>{formatMoney(month.scheduledExpenseMinor)}</dd></div><div><dt>Повседневное</dt><dd>{formatMoney(month.flexiblePlanMinor)}</dd></div><div><dt>В резерв</dt><dd>{formatMoney(month.annualReserveMinor)}</dd></div>{month.annualDueMinor > 0 ? <div className="due"><dt>К оплате из резерва</dt><dd>{formatMoney(month.annualDueMinor)}</dd></div> : null}</dl>
        <footer><span>Свободно</span><b>{formatMoney(month.spendableAfterPlanMinor)}</b></footer>
      </article>)}
    </div>

    <section className="section-card"><SectionTitle title="Крупные и ежегодные" note="Копим заранее, платим из резерва" /><div className="plan-list">{budget.annualCommitments.map((item) => <CommitmentRow key={item.id} item={item} metrics={plan.commitments[item.id]} category={categoryById.get(item.categoryId)?.name} />)}</div></section>
    <section className="section-card"><SectionTitle title="Расходы по расписанию" note="Каждый месяц или только в выбранные месяцы" /><div className="plan-list">{budget.scheduledExpenses.map((item) => <ScheduleRow key={item.id} item={item} category={categoryById.get(item.categoryId)?.name} />)}</div></section>
    <section className="explain-card"><b>Как это считается</b><p>Крупный платёж показывается в месяце оплаты, но не вычитается второй раз: до срока приложение ежемесячно резервирует нужную сумму.</p></section>
  </>;
}

function CommitmentRow({ item, metrics, category }: { item: AnnualCommitment; metrics: AnnualPlan["commitments"][string] | undefined; category?: string }) {
  return <article className="plan-row"><span className="plan-icon">◎</span><div><strong>{item.name}</strong><small>{category} · {item.recurrence === "annual" ? "каждый год" : "один раз"} · {formatDate(item.dueDate)}</small><span className={`status-chip ${metrics?.status}`}>{statusLabels[metrics?.status ?? ""] ?? ""}</span></div><p><b>{formatMoney(item.amountMinor)}</b><span>{formatMoney(metrics?.monthlyReserveMinor ?? 0)}/мес</span></p></article>;
}

function ScheduleRow({ item, category }: { item: ScheduledExpense; category?: string }) {
  const schedule = item.mode === "monthly" ? "каждый месяц" : item.months?.map((month) => calendarMonths[month - 1]).join(", ");
  return <article className="plan-row"><span className="plan-icon">↻</span><div><strong>{item.name}</strong><small>{category} · {schedule} · до {item.dueDay}-го</small></div><p><b>{formatMoney(item.amountMinor)}</b><span>за месяц</span></p></article>;
}

function SectionTitle({ title, note }: { title: string; note: string }) {
  return <div className="section-title"><div><h2>{title}</h2><p>{note}</p></div></div>;
}

function CategoryList({ rows }: { rows: CategoryRow[] }) {
  return <ul className="category-list">{rows.map(({ category, metric }) => {
    if (!metric) return null;
    const percent = (metric.execution ?? 0) * 100;
    return <li key={category.id}><div className="category-head"><strong>{category.name}</strong><span className={`status-chip ${metric.status}`}>{statusLabels[metric.status]}</span></div><div className="progress-track" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}><span className={`progress-value ${metric.status}`} style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }} /></div><div className="category-values"><span>Потрачено <b>{formatMoney(metric.actualMinor)}</b></span><span>Осталось <b>{formatMoney(metric.remainingMinor)}</b></span></div></li>;
  })}</ul>;
}

function OperationsScreen({ budget, entryKind, entryAmount, entryCategoryId, entryDate, transactions, categoryById, onKindChange, onAmountChange, onCategoryChange, onDateChange, onSubmit }: { budget: BudgetState; entryKind: EntryKind; entryAmount: string; entryCategoryId: string; entryDate: string; transactions: Transaction[]; categoryById: Map<string, BudgetState["categories"][number]>; onKindChange: (kind: EntryKind) => void; onAmountChange: (value: string) => void; onCategoryChange: (value: string) => void; onDateChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <><div className="screen-heading"><div><span className="card-kicker">Факт</span><h1>Записать операцию</h1><p>Только то, что уже произошло. Будущие платежи живут в плане.</p></div></div><section className="entry-card"><form className="form-grid" onSubmit={onSubmit}><fieldset className="segmented"><legend className="sr-only">Тип операции</legend><label><input type="radio" checked={entryKind === "expense"} onChange={() => onKindChange("expense")} />Расход</label><label><input type="radio" checked={entryKind === "income"} onChange={() => onKindChange("income")} />Доход</label></fieldset><div className="amount-field"><label htmlFor="amount">Сумма, ₽</label><input id="amount" inputMode="decimal" placeholder="0" value={entryAmount} onChange={(event) => onAmountChange(event.target.value)} required /></div>{entryKind === "expense" ? <div className="field"><label htmlFor="category">На что</label><select id="category" value={entryCategoryId} onChange={(event) => onCategoryChange(event.target.value)} required><option value="">Выберите категорию</option>{budget.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div> : null}<div className="field"><label htmlFor="date">Когда</label><input id="date" type="date" value={entryDate} onChange={(event) => onDateChange(event.target.value)} required /></div><button className="primary-button wide" type="submit">Сохранить</button></form></section><section className="section-card"><SectionTitle title="История" note={`${transactions.length} проведённых операций`} /><TransactionList transactions={transactions} categoryById={categoryById} /></section></>;
}

function TransactionList({ transactions, categoryById }: { transactions: Transaction[]; categoryById: Map<string, BudgetState["categories"][number]> }) {
  if (!transactions.length) return <p className="empty-state">Здесь появятся операции.</p>;
  return <ul className="transaction-list">{transactions.map((transaction) => { const categoryId = transactionCategoryId(transaction); return <li className={`transaction-row ${transaction.kind}`} key={transaction.id}><span className="transaction-icon">{transactionSign(transaction)}</span><span className="transaction-copy"><strong>{categoryId ? categoryById.get(categoryId)?.name : transactionLabels[transaction.kind]}</strong><small>{formatDate(transaction.occurredOn)} · {transactionLabels[transaction.kind]}</small></span><b>{transaction.kind === "income" || transaction.kind === "refund" ? "+" : transaction.kind === "expense" ? "−" : ""}{formatMoney(transaction.amountMinor)}</b></li>; })}</ul>;
}

function MoreScreen({ storageHealth, showIosInstall, onExport, onImport }: { storageHealth: StorageHealth | null; showIosInstall: boolean; onExport: () => void; onImport: (event: ChangeEvent<HTMLInputElement>) => void }) {
  return <><div className="screen-heading"><div><span className="card-kicker">Приложение</span><h1>Данные и установка</h1><p>Бюджет работает локально и без регистрации.</p></div></div>{showIosInstall ? <div className="install-note"><strong>Установите на iPhone</strong><p>В Safari нажмите «Поделиться» → «На экран Домой». После первого запуска план доступен без сети.</p></div> : null}<section className="section-card"><SectionTitle title="Резервная копия" note="Перенос между устройствами вручную" /><div className="backup-actions"><button className="primary-button" type="button" onClick={onExport}>Скачать JSON</button><label className="secondary-button" htmlFor="backup-file">Восстановить</label><input className="sr-only" id="backup-file" type="file" accept="application/json,.json" onChange={onImport} /></div><p className="storage-meter">{storageText(storageHealth)}</p></section><section className="section-card"><SectionTitle title="Конфиденциальность MVP" note="Данные остаются в этом браузере" /><p className="body-copy">Нет регистрации, рекламы и аналитики. Облачную семейную синхронизацию добавим отдельным безопасным этапом.</p></section></>;
}
