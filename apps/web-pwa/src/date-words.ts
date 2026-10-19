/**
 * Даты и месяцы словами — общие для «Сегодня», «Года» и оболочки.
 *
 * Перенесены из `App.tsx` без изменений: «20 июля», «июля», «сентябрь», «Июль».
 */
export const monthOnly = new Intl.DateTimeFormat("ru-RU", { month: "long", timeZone: "UTC" });
const dateShort = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
/** «20 июля» — так дату называют вслух; сокращение «20 июл.» годится списку, но не линейке. */
const dateLong = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

export function formatDate(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : dateShort.format(date);
}

/**
 * «9 июля» — дата, названная словом.
 *
 * Пробел внутри даты неразрывный: число и месяц — одна величина, и разрывать их переносом
 * нельзя. Это то же правило, что и у суммы (§7), только запрет живёт в самой строке, а не в
 * стилях: запрет в стилях не даёт подписи перенестись там, где перенестись ей надо.
 */
export function formatDay(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : dateLong.format(date).replace(/ /gu, "\u00a0");
}

const dateWithYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });

/** «15 октября 2026» — дата с годом, одной величиной: история курсов уходит в прошлые годы. */
export function formatDayYear(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : dateWithYear.format(date).replace(/\s*г\.$/u, "").replace(/ /gu, "\u00a0");
}

/**
 * «15 октября 2026» строкой экрана: день с месяцем неразрывны, а год вправе уйти на следующую
 * строку. При крупном шрифте на узком экране дата целиком в строку не помещается, и неразрывная
 * дата рвалась посреди года; число рвать нельзя (§7). В подписях и вопросах — `formatDayYear`.
 */
export function formatDayYearLine(value: string): string {
  return formatDayYear(value).replace(/\u00a0(?=\d{4}$)/u, " ");
}

/** «июля» — месяц в родительном падеже, отрезанный от «31 июля»: склонять руками нечего. */
export function monthGenitive(value: string): string {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const parts = dateLong.format(date).split(" ");
  return parts[parts.length - 1] ?? value;
}

/**
 * «сентябрь» — месяц назван словом, строчными: «Открыть сентябрь».
 *
 * У названий месяцев винительный падеж совпадает с именительным, поэтому одна форма работает и
 * подлежащим, и дополнением, и склонять здесь нечего.
 */
export function monthName(month: string): string {
  return monthOnly.format(new Date(`${month}-01T00:00:00.000Z`));
}

/** «Июль» — тот же месяц с прописной, как начало фразы. */
export function monthNominative(month: string): string {
  const word = monthName(month);
  return word.charAt(0).toUpperCase() + word.slice(1);
}
