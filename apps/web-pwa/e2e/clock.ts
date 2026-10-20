import type { BrowserContext } from "@playwright/test";

/**
 * Часы прогона: каждый тест видит один и тот же день, а не сегодняшний.
 *
 * Приложение считает от «сегодня» почти всё, что показывает: демо раскладывает сцену по дням
 * текущего месяца, получка 20-го числа до своего дня «ожидается», а с него записана, линейка «Хватает
 * до …» меряет дни до выплаты, план месяца закрывается по календарю. Прогон на настоящих часах
 * проходил девятнадцатого и падал двадцатого: «На счетах» демо — 554 000 ₽ до получки и 664 000 ₽
 * с её дня. Поэтому часы страниц прогона поддельные и стоят на одном дне.
 *
 * День по умолчанию — канонический день демо: под него сведены числа макетов v5 и приёмки
 * (554 000 · 71 000 · 27 000, «Хватает до 20 октября»). Тест, которому нужен другой день, просит его
 * сам — `test.use({ today: "…" })` — или двигает часы страницы (`page.clock`), если меряет время
 * внутри себя. `E2E_TODAY=ГГГГ-ММ-ДД` сдвигает день по умолчанию на один запуск: так проверяется,
 * что ни один тест не опирается на день, которого он не назвал. В репозитории это переменная, а не
 * другой день по умолчанию.
 */
export const CANONICAL_E2E_DAY = "2026-10-19";

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

function validDay(day: string): boolean {
  const match = DAY.exec(day);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === day;
}

/** День по умолчанию: `E2E_TODAY`, если задан, иначе канонический. */
export function defaultE2EToday(): string {
  const day = process.env.E2E_TODAY;
  if (day === undefined || day === "") return CANONICAL_E2E_DAY;
  if (!validDay(day)) throw new Error(`E2E_TODAY must be a calendar day YYYY-MM-DD, got «${day}».`);
  return day;
}

let current = defaultE2EToday();

/** День, который видит текущий тест: им же собираются бюджеты прогона на стороне Node. */
export function e2eToday(): string {
  return current;
}

/**
 * Утро дня прогона, 09:00 по Москве (06:00 UTC): в любом поясе от UTC−6 до UTC+14 это тот же
 * календарный день, поэтому и браузер, и Node называют одно «сегодня».
 */
export function e2eNow(day: string = current): Date {
  return new Date(`${day}T09:00:00+03:00`);
}

/**
 * Ставит часы контекста на утро дня `day` и запоминает его для Node. Часы идут дальше сами (таймеры
 * настоящие по ходу, а не замёрзшие): тосты, проверка обновления и анимации живут как обычно, а
 * тест, которому нужно, отматывает время `page.clock.fastForward`.
 */
export async function installE2EClock(context: BrowserContext, day: string = current): Promise<void> {
  if (!validDay(day)) throw new Error(`The e2e day must be YYYY-MM-DD, got «${day}».`);
  current = day;
  await context.clock.install({ time: e2eNow(day) });
}
