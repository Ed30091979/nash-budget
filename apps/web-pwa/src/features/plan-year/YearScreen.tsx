import type { BudgetState, calculateAnnualPlan } from "@family-budget/domain";
import { Icon, type IconName } from "../../components/Icon";
import { Money } from "../../components/Money";
import { SectionTitle } from "../../components/SectionTitle";
import { DashboardScreen, monthsSpan, nextScheduledDate } from "../dashboard";

/** План на 12–24 месяца от месяца плана — то, что «Год» показывает, а «Ещё» пересказывает. */
export type AnnualPlan = ReturnType<typeof calculateAnnualPlan>;

/**
 * §6: состояние всегда несут слово и глиф вместе, цвет — третьим. Глиф объявлен рядом со словом
 * ровно поэтому: чип без глифа был на «Сегодня» и был с глифом на «Записать», то есть правило
 * держалось на памяти автора, а не на коде.
 */
const statusIcons: Record<string, IconName> = {
  no_plan: "circle-dashed",
  normal: "circle-check",
  near_limit: "triangle-alert",
  exhausted: "triangle-alert",
  over_limit: "circle-alert",
  funded: "circle-check",
  on_track: "circle-check",
  due_soon: "triangle-alert",
  overdue: "circle-alert",
};

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

/**
 * «Год»: горизонт и платежи, которые его создают.
 *
 * Верхнюю часть — вывод, строй месяца и лестницу месяцев — рисует `DashboardScreen`. Ниже стоит
 * один список платежей, и упорядочен он по числу месяца, а не по названию: число — то, по чему
 * семья помнит свои платежи («пятого — аренда, пятнадцатого — ЖКХ»). Крупные и разовые платежи
 * идут своими группами: их копят помесячно, а не платят каждый месяц.
 */
export function YearScreen({ budget, plan, paydays, onPlanning, categoryById }: { budget: BudgetState; plan: AnnualPlan; paydays: readonly number[]; onPlanning: () => void; categoryById: Map<string, BudgetState["categories"][number]> }) {
  const groups = paymentGroups(budget, plan, categoryById);
  return <>
    <DashboardScreen budget={budget} paydays={paydays} onPlanning={onPlanning} />

    <section className="section-card" aria-labelledby="payments-by-day-title">
      <SectionTitle id="payments-by-day-title" title="Платежи по числам" note="Число месяца — то, по чему семья помнит свои платежи" />
      {groups.length ? groups.map((group) => <div className="pay-group" key={group.title}>
        <h3>{group.title}</h3>
        {group.rows.map((row) => <PayRow key={row.key} row={row} />)}
      </div>) : <div className="empty-state">
        <span className="empty-state-mark"><Icon name="calendar-clock" size={32} /></span>
        <h3>Платежей в плане нет</h3>
        <p>Сюда попадает всё, что платят по расписанию или копят заранее: аренда, страховка, обучение, шины, отпуск. Горизонт держится на них — без них он равен доходу.</p>
        <button className="primary-button" type="button" onClick={onPlanning}>Добавить платёж в план</button>
      </div>}
    </section>

    {/* Правило резерва объясняется один раз и по требованию: это справка, а не содержимое экрана. */}
    <details className="section-card collapsible-card">
      <summary><span>Как это считается</span><Icon name="chevron-right" size={24} className="row-chevron" /></summary>
      <p className="body-copy">Крупный платёж показывается в месяце оплаты, но не вычитается второй раз: до срока приложение ежемесячно резервирует нужную сумму. Полоса месяца — что остаётся от дохода после платежей, резервов и взносов в цели; насечка на ней — конверты повседневных лимитов, и всё за насечкой свободно.</p>
    </details>
  </>;
}

interface PayRowData {
  readonly key: string;
  /** Число крупно: «5» и рядом «-го», либо «15» и «янв». */
  readonly day: string;
  readonly daySuffix: string;
  readonly name: string;
  /** «Жильё · сентябрь — май» — одна строка вместо трёх подписей. */
  readonly note: string;
  readonly amountMinor: number;
  /** Сколько откладывать в месяц; `null` — регулярный платёж, его не копят. */
  readonly reserveMinor: number | null;
  /** Состояние резерва, когда оно стоит того, чтобы его назвать: «по плану» — молчание. */
  readonly status: string | null;
  /** Дата ближайшего платежа: по ней строки упорядочены внутри группы. */
  readonly sortKey: string;
}

interface PayGroup {
  readonly title: string;
  readonly rows: readonly PayRowData[];
}

const dayMonthShort = new Intl.DateTimeFormat("ru-RU", { month: "short" });

/** «янв» — месяц срока крупного платежа без точки: «15 янв», а не «15 янв.». */
function monthShortOf(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? date.slice(5, 7) : dayMonthShort.format(parsed).replace(".", "");
}

export function paymentGroups(
  budget: BudgetState,
  plan: AnnualPlan,
  categoryById: Map<string, BudgetState["categories"][number]>,
): readonly PayGroup[] {
  const byDay = (left: PayRowData, right: PayRowData) => left.sortKey.localeCompare(right.sortKey) || left.name.localeCompare(right.name, "ru-RU");
  const schedules = budget.scheduledExpenses.filter((item) => item.active);
  const monthly = schedules.filter((item) => item.mode === "monthly").map((item): PayRowData => ({
    key: `schedule-${item.id}`,
    day: String(item.dueDay),
    daySuffix: "-го",
    name: item.name,
    note: categoryById.get(item.categoryId)?.name ?? "",
    amountMinor: item.amountMinor,
    reserveMinor: null,
    status: null,
    sortKey: String(item.dueDay).padStart(2, "0"),
  })).sort(byDay);
  const seasonal = schedules.filter((item) => item.mode !== "monthly").map((item): PayRowData => ({
    key: `schedule-${item.id}`,
    day: String(item.dueDay),
    daySuffix: "-го",
    name: item.name,
    note: [categoryById.get(item.categoryId)?.name, monthsSpan(item.months ?? [])].filter((part) => part).join(" · "),
    amountMinor: item.amountMinor,
    reserveMinor: null,
    status: null,
    // Внутри группы — по числу месяца; расписание, чьи месяцы кончились, идёт в конец.
    sortKey: `${nextScheduledDate(item, plan.startMonth) === null ? "z" : "a"}${String(item.dueDay).padStart(2, "0")}`,
  })).sort(byDay);
  const commitment = (item: BudgetState["annualCommitments"][number]): PayRowData => {
    const status = plan.commitments[item.id]?.status ?? null;
    return {
      key: `commitment-${item.id}`,
      day: String(Number(item.dueDate.slice(8, 10))),
      daySuffix: ` ${monthShortOf(item.dueDate)}`,
      name: item.name,
      note: categoryById.get(item.categoryId)?.name ?? "",
      amountMinor: item.amountMinor,
      reserveMinor: plan.commitments[item.id]?.monthlyReserveMinor ?? 0,
      status: status === "on_track" ? null : status,
      sortKey: item.dueDate,
    };
  };
  const commitments = budget.annualCommitments.filter((item) => item.active);
  const annual = commitments.filter((item) => item.recurrence === "annual").map(commitment).sort(byDay);
  const once = commitments.filter((item) => item.recurrence !== "annual").map(commitment).sort(byDay);
  return [
    { title: "Каждый месяц", rows: monthly },
    { title: "По расписанию", rows: seasonal },
    { title: "Раз в год — откладываем помесячно", rows: annual },
    { title: "Один раз", rows: once },
  ].filter((group) => group.rows.length > 0);
}

function PayRow({ row }: { row: PayRowData }) {
  return <article className="pay-row">
    <span className="pay-day"><b>{row.day}</b><small>{row.daySuffix}</small></span>
    <div className="pay-copy">
      <strong>{row.name}</strong>
      {row.note ? <small>{row.note}</small> : null}
      {row.status ? <span className={`status-chip ${row.status}`}><Icon name={statusIcons[row.status] ?? "circle-dashed"} size={20} />{statusLabels[row.status] ?? ""}</span> : null}
    </div>
    <p className="pay-amount">
      <b><Money value={row.amountMinor} /></b>
      {row.reserveMinor === null ? null : <span><Money value={row.reserveMinor} /> в месяц</span>}
    </p>
  </article>;
}
