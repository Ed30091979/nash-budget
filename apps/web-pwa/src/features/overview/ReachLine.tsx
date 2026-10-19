import { Icon, type IconName } from "../../components/Icon";
import { Money } from "../../components/Money";
import { formatDay, monthGenitive, monthName, monthNominative } from "../../date-words";
import { reach, runsOutOn, type PaydayHorizon, type PeriodClock, type ReachState } from "../../reach";
import type { ReachLineModel } from "./overview-model";

/** «до 20 октября», когда дата выведена из доходов, и «до конца октября», когда выводить не из чего. */
function paydayLabel(payday: PaydayHorizon): string {
  return payday.source === "income" ? formatDay(payday.date) : `конца ${monthGenitive(payday.date)}`;
}

/** Глиф состояния — слово и глиф вместе, цвет — третьим (§6, чип состояния). */
const REACH_ICONS: Readonly<Record<ReachState, IconName>> = {
  reaches: "circle-check",
  short: "triangle-alert",
  out: "circle-alert",
};

export interface ReachLineProps {
  readonly line: ReachLineModel;
  readonly clock: PeriodClock;
  /** Месяц, который предлагается открыть, когда месяц плана кончился. */
  readonly monthToOpen: string | null;
  readonly openingMonth: boolean;
  readonly onOpenMonth: (month: string) => void;
  /** Строка ведёт в «План месяца». */
  readonly onPlan: () => void;
}

/**
 * «Можно на повседневные 27 000 ₽ · хватает до 20 октября» — наше отличие (решение по умолчанию,
 * §6): та же величина и та же линейка до выплаты, что у прежнего героя «Сегодня», одной строкой.
 * Голос о нехватке — факт и путь (DESIGN §6): «хватает до 12 октября, а до 20-го не дотягивает ·
 * чтобы дотянуть — 400 ₽ в день». Закрытый месяц плана называется закрытым, и выход из него —
 * «Открыть октябрь» — стоит здесь же, со словами о том, что при этом произойдёт.
 */
export function ReachLine({ line, clock, monthToOpen, openingMonth, onOpenMonth, onPlan }: ReachLineProps) {
  const { today, payday, elapsedDays } = clock;
  const until = paydayLabel(payday);
  const planMonthOf = line.planMonth === "" ? "" : monthGenitive(`${line.planMonth}-15`);
  if (!clock.inPeriod) {
    const closed = clock.position === "after";
    return (
      <section className="card reach-line closed" aria-label="Повседневные лимиты месяца плана">
        <button className="reach-open" type="button" onClick={onPlan}>
          <span className="reach-mark" aria-hidden="true"><Icon name="calendar-clock" size={24} /></span>
          <span className="reach-copy">
            <span>{line.planMonth === "" ? "Месяц плана" : monthNominative(line.planMonth)} {closed ? "закрыт" : "ещё не начался"}: осталось от повседневных лимитов {planMonthOf}</span>
            <strong><Money value={line.safeToSpendMinor} /></strong>
          </span>
          <Icon name="chevron-right" size={24} className="row-chevron" />
        </button>
        {monthToOpen !== null ? <>
          <p>Открыть {monthName(monthToOpen)} — значит перенести в него те же лимиты и положить сверху остатки {planMonthOf}. Покупки сегодняшним числом лягут в лимиты нового месяца.</p>
          <button className="primary-button wide" type="button" disabled={openingMonth} aria-busy={openingMonth} onClick={() => onOpenMonth(monthToOpen)}>
            <span className="icon-label"><Icon name="calendar-clock" size={20} />Открыть {monthName(monthToOpen)}</span>
          </button>
        </> : null}
      </section>
    );
  }
  const reachLine = reach({ remainingMinor: line.safeToSpendMinor, spentMinor: line.flexibleSpentMinor, elapsedDays, daysAhead: payday.daysAhead });
  const needPerDay = payday.daysAhead > 0 ? Math.round(Math.max(0, line.safeToSpendMinor) / payday.daysAhead / 100) * 100 : 0;
  const runsOut = runsOutOn(today, reachLine.daysCovered);
  const voice = reachLine.state === "out"
    ? <>повседневные лимиты исчерпаны · до {until} ещё {payday.daysAhead} дн.</>
    : reachLine.state === "short"
      ? <>хватает до {formatDay(runsOut ?? payday.date)}, а до {until} не дотягивает · чтобы дотянуть — <Money value={needPerDay} /> в день</>
      : <>хватает до {until}</>;
  return (
    <section className={`card reach-line ${reachLine.state}`} aria-label="Можно на повседневные">
      <button className="reach-open" type="button" onClick={onPlan}>
        <span className="reach-mark" aria-hidden="true"><Icon name={REACH_ICONS[reachLine.state]} size={24} /></span>
        <span className="reach-copy">
          <span>Можно на повседневные</span>
          <strong><Money value={line.safeToSpendMinor} /></strong>
          <span className="reach-voice">{voice}</span>
        </span>
        <Icon name="chevron-right" size={24} className="row-chevron" />
      </button>
    </section>
  );
}
