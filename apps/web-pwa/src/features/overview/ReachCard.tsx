import { Icon, type IconName } from "../../components/Icon";
import { Money } from "../../components/Money";
import { formatDay, monthGenitive, monthName, monthNominative } from "../../date-words";
import { reach, runsOutOn, type PaydayHorizon, type PeriodClock, type ReachState } from "../../reach";
import type { ReachLineModel } from "./overview-model";

/** «20 октября», когда дата выведена из доходов, и «конца октября», когда выводить не из чего. */
function paydayLabel(payday: PaydayHorizon): string {
  return payday.source === "income" ? formatDay(payday.date) : `конца ${monthGenitive(payday.date)}`;
}

/** Глиф состояния — слово и глиф вместе, цвет — третьим (§6, чип состояния). */
const REACH_ICONS: Readonly<Record<ReachState, IconName>> = {
  reaches: "circle-check",
  short: "triangle-alert",
  out: "circle-alert",
};

export interface ReachCardProps {
  readonly line: ReachLineModel;
  readonly clock: PeriodClock;
  /** Месяц, который предлагается открыть, когда месяц плана кончился. */
  readonly monthToOpen: string | null;
  readonly openingMonth: boolean;
  readonly onOpenMonth: (month: string) => void;
  /** Карточка ведёт в «План месяца». */
  readonly onPlan: () => void;
}

/**
 * «Хватает до 20 октября» — наше отличие (DESIGN 5.0 §6, макеты v5 §d): карточка под итогами
 * объясняет «Можно тратить». Заголовок — на сколько дней вперёд дотягивают повседневные лимиты,
 * подпись — «лимиты: 26 000 из 53 000 ₽», полоса — дни до выплаты с насечкой на 75 %.
 *
 * Голос о нехватке — факт и путь (DESIGN §6): «Хватает до 12 октября», а под ним «до 20 октября не
 * дотянет · чтобы дотянуть — 400 ₽ в день». Закрытый месяц плана назван закрытым, и выход из него —
 * «Открыть октябрь» — стоит здесь же, со словами о том, что при этом произойдёт. Без лимитов
 * карточка — «Сколько можно тратить? Задайте лимиты — покажем, хватит ли до …» с дорогой в план, а
 * не «0 ₽ · исчерпаны».
 */
export function ReachCard({ line, clock, monthToOpen, openingMonth, onOpenMonth, onPlan }: ReachCardProps) {
  const { today, payday, elapsedDays } = clock;
  const until = paydayLabel(payday);
  const planMonthOf = line.planMonth === "" ? "" : monthGenitive(`${line.planMonth}-15`);
  if (!clock.inPeriod) {
    const closed = clock.position === "after";
    return (
      <section className="card reach-card closed" aria-label="Повседневные лимиты месяца плана">
        <button className="reach-open" type="button" onClick={onPlan}>
          <span className="reach-plate" aria-hidden="true"><Icon name="calendar-clock" size={24} /></span>
          <span className="reach-copy">
            <span className="reach-title">{line.planMonth === "" ? "Месяц плана" : monthNominative(line.planMonth)} {closed ? "закрыт" : "ещё не начался"}: осталось от повседневных лимитов {planMonthOf}</span>
            <span className="reach-caption"><Money value={line.safeToSpendMinor} /></span>
          </span>
          <Icon name="chevron-right" size={24} className="row-chevron" />
        </button>
        {monthToOpen !== null ? <>
          <p>Открыть {monthName(monthToOpen)} — значит перенести в него те же лимиты и положить сверху остатки {planMonthOf}. {line.planMonth === "" ? "Прошлый месяц" : monthNominative(line.planMonth)} останется в истории со своими числами, а покупки сегодняшним числом лягут в лимиты нового месяца.</p>
          <button className="primary-button wide" type="button" disabled={openingMonth} aria-busy={openingMonth} onClick={() => onOpenMonth(monthToOpen)}>
            <span className="icon-label"><Icon name="calendar-clock" size={20} />Открыть {monthName(monthToOpen)}</span>
          </button>
        </> : null}
      </section>
    );
  }
  if (!line.hasLimits) {
    // Пустое состояние (§6 исследования, пункт 29): назвать, объяснить, дать дорогу — компактной
    // строкой той же анатомии, что и карточка с лимитами (макеты v5 03b, 05): вопрос, на который
    // ответят лимиты, и что для этого сделать; вся строка ведёт в план. Состояние названо итогом
    // «Можно тратить · лимитов нет» прямо над карточкой и, для диктора, в начале самой кнопки.
    // «Можно 0 ₽ · лимиты исчерпаны» было бы неправдой: исчерпывать нечего, лимитов просто нет.
    return (
      <section className="card reach-card empty" aria-label="Повседневные лимиты">
        <button className="reach-open" type="button" onClick={onPlan}>
          <span className="reach-plate" aria-hidden="true"><Icon name="circle-dashed" size={24} /></span>
          <span className="reach-copy">
            <span className="visually-hidden">Лимитов на этот месяц нет. </span>
            <span className="reach-title">Сколько можно тратить?</span>
            <span className="reach-caption">Задайте лимиты — покажем, хватит ли до {until}</span>
          </span>
          <Icon name="chevron-right" size={24} className="row-chevron" />
        </button>
      </section>
    );
  }
  const reachLine = reach({ remainingMinor: line.safeToSpendMinor, spentMinor: line.flexibleSpentMinor, elapsedDays, daysAhead: payday.daysAhead });
  const needPerDay = payday.daysAhead > 0 ? Math.round(Math.max(0, line.safeToSpendMinor) / payday.daysAhead / 100) * 100 : 0;
  const runsOut = runsOutOn(today, reachLine.daysCovered);
  const title = reachLine.state === "out"
    ? "Повседневные лимиты исчерпаны"
    : `Хватает до ${reachLine.state === "short" ? formatDay(runsOut ?? payday.date) : until}`;
  const caption = reachLine.state === "out"
    ? <>до {until} ещё {payday.daysAhead} дн.</>
    : reachLine.state === "short"
      ? <>до {until} не дотянет · чтобы дотянуть — <Money value={needPerDay} /> в день</>
      : <>лимиты: <Money value={line.flexibleSpentMinor} bare /> из <Money value={line.limitsMinor} /></>;
  return (
    <section className={`card reach-card ${reachLine.state}`} aria-label="Хватает ли до выплаты">
      <button className="reach-open" type="button" onClick={onPlan}>
        <span className="reach-plate" aria-hidden="true"><Icon name={REACH_ICONS[reachLine.state]} size={24} /></span>
        <span className="reach-copy">
          <span className="reach-title">{title}</span>
          <span className="reach-caption">{caption}</span>
        </span>
        <Icon name="chevron-right" size={24} className="row-chevron" />
        {/* Полоса — дни до выплаты, а не доля лимита: слева сегодня, насечка — день выплаты. Состояние
            уже сказано словами и глифом; полоса для глаза, точные числа — в заголовке и подписи. */}
        <span className={`limit-bar reach-bar${reachLine.state === "reaches" ? "" : ` ${reachLine.state}`}`} data-spent={reachLine.fill} aria-hidden="true" />
      </button>
    </section>
  );
}
