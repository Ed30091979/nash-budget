/**
 * Линейка до выплаты — §6 документа дизайна.
 *
 * Полоса на «Сегодня» показывает не долю потраченного лимита, а на сколько дней вперёд дотягивают
 * деньги. Слева сегодня, справа насечка на дате следующей выплаты; заливка либо переваливает за
 * насечку — тогда за ней запас, — либо не доходит до неё. Доля потраченного отвечала на вопрос,
 * которого семья не задаёт: «сколько процентов лимита израсходовано» — это отчёт, а «хватит ли
 * до зарплаты» — это то, зачем открывают приложение.
 *
 * Здесь только арифметика и слова; рисование живёт в `styles.css`.
 *
 * Почему доли квантуются. Полоса рисуется градиентами на фоне самой строки, и её стопы — проценты.
 * Задать процент разметке нечем: CSP запрещает инлайновые стили (`style-src 'self'`), и приложение
 * не ставит атрибут `style` ни в одном месте. Поэтому доля едет в разметку шагом 5 % — атрибутом
 * `data-*`, к которому в таблице стилей привязана переменная. Точные числа под полосой набраны
 * словами и не округляются.
 *
 * Насечка стоит на одной и той же доле полосы во всех строках экрана: сквозь карточку проходит
 * одна вертикаль, и видно, какие конверты её не пересекают. Доля объявлена здесь и в `:root`
 * одним числом, и разъехаться им нельзя.
 */

/** Шаг шкалы долей: 5 % — это 5 px на полосе шириной 300. */
export const PERCENT_STEP = 5;

/** Все шаги шкалы: таблица стилей объявляет ровно их, и проверка сверяется с этим же списком. */
export const PERCENT_STEPS: readonly number[] = Array.from(
  { length: 100 / PERCENT_STEP + 1 },
  (_unused, index) => index * PERCENT_STEP,
);

/**
 * Где на полосе стоит насечка выплаты — в процентах её ширины.
 *
 * Число одно на всё приложение: `--reach-mark` в `:root` объявляет ту же долю, и полоса героя,
 * полосы строк и направляющая карточки встают на одну вертикаль просто потому, что считают от
 * одного числа. Оно же обязано лежать на шкале шагов, иначе заливка «ровно до насечки» не смогла
 * бы совпасть с ней после квантования.
 */
export const REACH_MARK_PERCENT = 75;

/** Округление доли 0…1 до шага шкалы. */
export function percentStep(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  const clamped = Math.min(Math.max(ratio, 0), 1);
  return Math.round((clamped * 100) / PERCENT_STEP) * PERCENT_STEP;
}

const DAY_MS = 86_400_000;

function utcDay(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? Number.NaN : parsed / DAY_MS;
}

function isoDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Сколько целых дней от `from` до `to`; отрицательное — дата уже прошла. */
export function daysBetween(from: string, to: string): number {
  const start = utcDay(from);
  const end = utcDay(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return Number.NaN;
  return end - start;
}

/** Сегодняшний день по часам семьи, а не по UTC: линейка обязана совпадать с календарём. */
export function localToday(now: Date): string {
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Сколько дней периода уже прошло, считая сегодняшний; не меньше одного.
 *
 * Нужно не линейке, а среднему расходу в день: чтобы разделить потраченное, надо знать, на
 * сколько дней его делить. День считается прошедшим целиком, а закрытый месяц не растёт дальше
 * своего последнего дня.
 */
export function daysElapsed(startDate: string, endDate: string, today: string): number {
  const start = utcDay(startDate);
  const now = utcDay(today);
  const end = utcDay(endDate);
  if (Number.isNaN(start) || Number.isNaN(now) || Number.isNaN(end)) return 1;
  return Math.max(1, Math.min(now, end) - start + 1);
}

/**
 * Дата следующей выплаты.
 *
 * Расписаний дохода в домене нет, и заводить их ради линейки нельзя: это миграция хранилища,
 * смена формата резервной копии и новая операция журнала. Дата выводится в слое представления из
 * дат уже записанных доходных операций — ровно так же, как выводятся иконки и тона категорий.
 *
 * Уверенность важнее полноты. Если истории нет или даты нерегулярны, линейка честно говорит про
 * календарный месяц и ни слова про аванс: у нового пользователя истории нет вовсе, и выдумывать
 * ему зарплату двадцатого числа приложение не станет.
 */
export interface PaydayHorizon {
  /** Дата, на которой стоит насечка. */
  readonly date: string;
  /** Откуда она взята: из дат доходов или из календаря. */
  readonly source: "income" | "month";
  /** Целых дней от сегодня до неё; не меньше одного. */
  readonly daysAhead: number;
}

/** Сколько выплат подряд должны лечь на одно число, чтобы считать его расписанием. */
const CONFIDENT_REPEATS = 2;
/** Разброс чисел месяца внутри одной выплаты: 15-е и 17-е — одна выплата, 5-е и 20-е — разные. */
const DAY_SPREAD = 2;
/** Сколько последних доходов смотрим: год назад семья могла получать деньги иначе. */
const HISTORY_DEPTH = 8;
/** Дальше этого горизонта выведенная дата не бывает: месяц с хвостом, а не полгода. */
const MAX_DAYS_AHEAD = 45;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Ближайшее после `today` вхождение числа месяца `dayOfMonth`; короткий месяц число подрезает. */
function nextOccurrence(dayOfMonth: number, today: string): string | null {
  const now = new Date(`${today}T00:00:00.000Z`);
  if (Number.isNaN(now.getTime())) return null;
  for (let ahead = 0; ahead <= 2; ahead += 1) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + ahead;
    const target = new Date(Date.UTC(year, month, 1));
    const day = Math.min(dayOfMonth, daysInMonth(target.getUTCFullYear(), target.getUTCMonth()));
    const candidate = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day));
    if (candidate.getTime() > now.getTime()) return candidate.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Числа месяца, на которые семье приходят деньги, — из дат уже записанных доходов.
 *
 * Числа собираются в грозди: у семьи бывает и одна выплата в месяц, и аванс с зарплатой. Гроздь
 * считается расписанием, только если повторилась в разные месяцы: две выплаты одного месяца —
 * это ещё не «двадцатого числа каждого месяца». Пустой список — истории нет или даты
 * нерегулярны, и тогда экран говорит про календарный месяц и ни слова про аванс.
 *
 * Тем же списком пользуются «Год» (ось чисел месяца) и «Ещё» (строка «Наш месяц»): даты выплат
 * выведены один раз и одинаково везде.
 */
export function paydayDays(incomeDates: readonly string[], today: string): readonly number[] {
  const history = [...new Set(incomeDates)]
    .filter((date) => Number.isFinite(utcDay(date)) && utcDay(date) <= utcDay(today))
    .sort()
    .slice(-HISTORY_DEPTH);
  if (history.length < CONFIDENT_REPEATS) return [];

  const clusters: { days: number[]; months: Set<string> }[] = [];
  for (const date of history) {
    const dayOfMonth = Number(date.slice(8, 10));
    const month = date.slice(0, 7);
    const cluster = clusters.find((item) => item.days.some((day) => Math.abs(day - dayOfMonth) <= DAY_SPREAD));
    if (cluster) {
      cluster.days.push(dayOfMonth);
      cluster.months.add(month);
    } else {
      clusters.push({ days: [dayOfMonth], months: new Set([month]) });
    }
  }

  return clusters
    .filter((cluster) => cluster.months.size >= CONFIDENT_REPEATS)
    .map((cluster) => [...cluster.days].sort((left, right) => left - right)[Math.floor(cluster.days.length / 2)])
    .filter((day): day is number => day !== undefined)
    .sort((left, right) => left - right);
}

/**
 * Выводит дату следующей выплаты из дат доходов, а при неуверенности — из конца месяца.
 *
 * `incomeDates` — даты доходных операций в любом порядке; `periodEnd` — последний день периода
 * бюджета, он же запасная насечка.
 */
export function nextPayday(
  incomeDates: readonly string[],
  today: string,
  periodEnd: string,
): PaydayHorizon {
  const fallback = (): PaydayHorizon => {
    const ahead = daysBetween(today, periodEnd);
    if (Number.isFinite(ahead) && ahead >= 1) return { date: periodEnd, source: "month", daysAhead: ahead };
    // Конец периода уже позади — это последний его день либо закрытый месяц, открытый задним
    // числом. Насечка всё равно обязана стоять впереди: линейка меряет дни вперёд, и назад их
    // не бывает. Тогда край — конец того месяца, в котором семья находится сейчас.
    const now = new Date(`${today}T00:00:00.000Z`);
    if (Number.isNaN(now.getTime())) return { date: periodEnd, source: "month", daysAhead: 1 };
    const monthEnd = (offset: number) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1 + offset, 0)).toISOString().slice(0, 10);
    const edge = daysBetween(today, monthEnd(0)) >= 1 ? monthEnd(0) : monthEnd(1);
    return { date: edge, source: "month", daysAhead: Math.max(1, daysBetween(today, edge)) };
  };

  const candidates = paydayDays(incomeDates, today)
    .map((day) => nextOccurrence(day, today))
    .filter((date): date is string => date !== null)
    .map((date) => ({ date, daysAhead: daysBetween(today, date) }))
    .filter(({ daysAhead }) => daysAhead >= 1 && daysAhead <= MAX_DAYS_AHEAD)
    .sort((left, right) => left.daysAhead - right.daysAhead);

  const nearest = candidates[0];
  return nearest ? { date: nearest.date, source: "income", daysAhead: nearest.daysAhead } : fallback();
}

/**
 * Часы периода: где сегодняшний день стоит относительно месяца плана.
 *
 * Линейка до выплаты — прогноз, и прогноз имеет смысл только внутри своего месяца. Пока экран
 * считал запас от сегодняшней даты, а число брал из месяца плана, на одной карточке оказывались
 * два месяца: «ИЮЛЬ», остаток июля и «хватает до конца сентября». Здесь положение сегодняшнего
 * дня названо явно, и каждый экран решает по нему одно и то же: внутри периода — линейка,
 * снаружи — честные слова о том, что месяц закрыт (или ещё не начался), и никакого прогноза.
 */
export type PeriodPosition = "inside" | "after" | "before";

export interface PeriodClock {
  readonly today: string;
  readonly position: PeriodPosition;
  /** Сегодня лежит внутри периода — только тогда линейка до выплаты имеет смысл. */
  readonly inPeriod: boolean;
  /** Сколько дней периода прошло, считая сегодняшний; у закрытого месяца — весь месяц. */
  readonly elapsedDays: number;
  readonly payday: PaydayHorizon;
}

export function periodClock(
  period: { readonly startDate: string; readonly endDate: string },
  incomeDates: readonly string[],
  today: string,
): PeriodClock {
  const position: PeriodPosition = today < period.startDate ? "before" : today > period.endDate ? "after" : "inside";
  return {
    today,
    position,
    inPeriod: position === "inside",
    elapsedDays: daysElapsed(period.startDate, period.endDate, today),
    payday: nextPayday(incomeDates, today, period.endDate),
  };
}

/** Состояние линейки. Слово для человека подбирается по нему же, а не по цвету. */
export type ReachState = "reaches" | "short" | "out";

export interface ReachInput {
  /** Сколько денег осталось; ноль и меньше — конверт пуст. */
  readonly remainingMinor: number;
  /** Сколько уже потрачено за прошедшие дни периода. */
  readonly spentMinor: number;
  /** Сколько дней периода прошло, считая сегодняшний. */
  readonly elapsedDays: number;
  /** Сколько дней до выплаты. */
  readonly daysAhead: number;
  /** Домен назвал строку перелимитом: это факт, а не вывод из остатка. */
  readonly overLimit?: boolean;
}

export interface Reach {
  readonly state: ReachState;
  /** Средний расход в день; `null` — трат ещё не было и делить нечего. */
  readonly perDayMinor: number | null;
  /** На сколько дней вперёд хватает; `null` — трат нет, значит хватает на любой срок. */
  readonly daysCovered: number | null;
  /** Доля заливки шагом шкалы. */
  readonly fill: number;
  /** Сколько дней запаса за насечкой; 0 — запаса нет. */
  readonly surplusDays: number;
}

/**
 * Линейка одной величины: остатка повседневных денег или остатка одного конверта.
 *
 * Квантование не должно спорить со словом: если денег до выплаты не хватает, заливка обязана
 * остановиться раньше насечки, а если хватает — дойти до неё. Поэтому шаг шкалы здесь не просто
 * округляется, а прижимается к нужной стороне насечки.
 */
export function reach({ remainingMinor, spentMinor, elapsedDays, daysAhead, overLimit = false }: ReachInput): Reach {
  const days = Math.max(1, daysAhead);
  const elapsed = Math.max(1, elapsedDays);
  const perDayMinor = spentMinor > 0 ? spentMinor / elapsed : null;

  if (overLimit || remainingMinor <= 0) {
    return { state: "out", perDayMinor, daysCovered: 0, fill: 0, surplusDays: 0 };
  }
  if (perDayMinor === null) {
    return { state: "reaches", perDayMinor: null, daysCovered: null, fill: 100, surplusDays: 0 };
  }

  const daysCovered = remainingMinor / perDayMinor;
  const raw = percentStep((daysCovered / days) * (REACH_MARK_PERCENT / 100));
  if (daysCovered >= days) {
    return {
      state: "reaches",
      perDayMinor,
      daysCovered,
      fill: Math.max(REACH_MARK_PERCENT, raw),
      surplusDays: Math.floor(daysCovered - days),
    };
  }
  return {
    state: "short",
    perDayMinor,
    daysCovered,
    fill: Math.min(REACH_MARK_PERCENT - PERCENT_STEP, raw),
    surplusDays: 0,
  };
}

/** Дата, на которой деньги кончатся при нынешнем темпе; `null` — темпа нет. */
export function runsOutOn(today: string, daysCovered: number | null): string | null {
  if (daysCovered === null || !Number.isFinite(daysCovered)) return null;
  const start = utcDay(today);
  if (Number.isNaN(start)) return null;
  return isoDate(start + Math.floor(Math.max(0, daysCovered)));
}

/**
 * Слово состояния для чипа. Оно, а не цвет, отвечает за то, что состояние вообще прочитано:
 * «В норме» не говорило ни о чём — норма относительно чего, семья не знала.
 *
 * Перелимит называет себя суммой отдельно: «Перелимит 900 ₽» — это факт с величиной, а «конверт
 * пуст» — факт без неё, и путать их нельзя.
 */
export function reachWord(state: ReachState): string {
  if (state === "out") return "Конверт пуст";
  return state === "reaches" ? "Дотянет" : "Не дотянет";
}
