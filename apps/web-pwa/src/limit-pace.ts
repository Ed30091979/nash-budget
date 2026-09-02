/**
 * Темп месяца в строке лимита — §4 исследования 2026 («полоса „потрачено из лимита“ с маркером
 * темпа месяца») и §10, пункт K («янтарный — опережение темпа, красный — только факт превышения»).
 *
 * Здесь только арифметика и слова; рисование живёт в `styles.css`.
 *
 * Почему проценты квантуются. Полоса рисуется одним градиентом на фоне самой строки, и её
 * стопы — проценты. Задать процент разметке нечем: CSP запрещает инлайновые стили (`style-src
 * 'self'`), и приложение не ставит атрибут `style` ни в одном месте. Поэтому процент едет в
 * разметку шагом 5 % — атрибутом `data-*`, к которому в таблице стилей привязана переменная.
 * Точные числа под полосой набраны словами и не округляются.
 */

/** Шаг шкалы процентов: 5 % — это 1,5 дня месяца и 5 px на полосе шириной 300. */
export const PERCENT_STEP = 5;

/** Все шаги шкалы: таблица стилей объявляет ровно их, и проверка сверяется с этим же списком. */
export const PERCENT_STEPS: readonly number[] = Array.from(
  { length: 100 / PERCENT_STEP + 1 },
  (_unused, index) => index * PERCENT_STEP,
);

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

/**
 * Какая доля периода бюджета прошла к дню `today` — от 0 до 1.
 *
 * День считается прошедшим целиком: в первый день месяца маркер стоит на 1/31, в последний —
 * на конце полосы. За пределами периода — 0 до его начала и 1 после конца: у закрытого месяца
 * темп не спрашивают, у него прошло всё.
 */
export function periodProgress(startDate: string, endDate: string, today: string): number {
  const start = utcDay(startDate);
  const end = utcDay(endDate);
  const now = utcDay(today);
  if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(now)) return 1;
  const span = end - start + 1;
  if (span <= 0) return 1;
  return Math.min(Math.max((now - start + 1) / span, 0), 1);
}

/** Сегодняшний день по часам семьи, а не по UTC: маркер темпа обязан совпадать с календарём. */
export function localToday(now: Date): string {
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export interface LimitBarInput {
  /** Название категории — им начинается объявление полосы для читающих с экрана. */
  readonly name: string;
  /** Доля израсходованного лимита; `null` — лимита нет. */
  readonly execution: number | null;
  /** Состояние лимита из домена: перелимит — единственный повод для красного. */
  readonly overLimit: boolean;
  /** Доля прошедшего периода. */
  readonly pace: number;
}

export interface LimitBarPresentation {
  /** Классы полосы: тон заливки и то, с какой стороны от маркера она кончается. */
  readonly className: string;
  /** Шаг заливки для `data-spent`. */
  readonly spent: number;
  /** Видимая подпись — только когда есть что сказать сверх статус-чипа. */
  readonly note: string | null;
  /** Объявление полосы целиком: состояние никогда не остаётся одним цветом. */
  readonly label: string;
}

export const AHEAD_OF_PACE_NOTE = "Тратите быстрее, чем идёт месяц";

/**
 * Полоса лимита словами и классами.
 *
 * Цвет заливки: красный — только факт превышения лимита; янтарный — опережение темпа месяца;
 * иначе зелёный. Состояние при этом несут ещё две вещи, кроме цвета: положение маркера темпа
 * относительно конца заливки и подпись под полосой (§10, пункт K — дальтонизм у ~8 % мужчин).
 */
export function limitBar({ name, execution, overLimit, pace }: LimitBarInput): LimitBarPresentation {
  // Лимита нет, а трата есть — домен зовёт это перелимитом. Полоса тогда залита целиком:
  // «потрачено сверх плана» нельзя показывать пустой полосой, иначе строка выглядит нетронутой.
  const ratio = execution ?? (overLimit ? 1 : 0);
  const spent = percentStep(ratio);
  const paceStep = percentStep(pace);
  const ahead = !overLimit && ratio > pace;
  const tone = overLimit ? "over" : ahead ? "ahead" : "within";
  // Маркер темпа читается на своей подложке: тёмный на светлом треке, светлый на тёмной заливке.
  // Это и есть «порядок стопов меняется» из §4 — только флаг меняет не порядок, а цвет метки.
  const marker = spent > paceStep ? "marker-on-fill" : "marker-on-track";
  const paceWords = overLimit
    ? "лимит превышен"
    : ahead
      ? "тратите быстрее, чем идёт месяц"
      : "тратите не быстрее, чем идёт месяц";
  return {
    className: `limit-bar ${tone} ${marker}`,
    spent,
    note: ahead ? AHEAD_OF_PACE_NOTE : null,
    label: `${name}: потрачено ${Math.round(ratio * 100)} % лимита, прошло ${Math.round(pace * 100)} % месяца — ${paceWords}`,
  };
}
