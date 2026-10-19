import type { BudgetState, Transaction } from "@family-budget/domain";
import { Money } from "../../components/Money";
import { dayHeading, feedRowView, type FeedDay } from "./feed-model";
import { FeedRow } from "./FeedRow";

export interface FeedAuthors {
  readonly show: boolean;
  readonly label: (memberId: string | undefined) => string;
}

/**
 * День ленты (макет 08): заголовок «Сегодня, 19 октября» и итог дня справа — доходы и возвраты минус
 * расходы в базовой валюте, без переводов, взносов и долгов; у дня одних ожидаемых — слово
 * «ожидается». Под ним — белая карточка строк.
 */
export function DayGroup({ day, budget, today, authors, onEdit, busy }: {
  readonly day: FeedDay;
  readonly budget: BudgetState;
  readonly today: string;
  readonly authors: FeedAuthors;
  readonly onEdit: (transaction: Transaction) => void;
  readonly busy?: boolean;
}) {
  const id = `feed-day-${day.date}`;
  return (
    <section className="feed-day" aria-labelledby={id}>
      <div className="feed-day-head">
        <h2 id={id}>{dayHeading(day.date, today)}</h2>
        {day.pendingOnly ? <p className="feed-day-total">ожидается</p> : day.totalMinor === null ? null : (
          <p className="feed-day-total">
            <span className="visually-hidden">Итог дня: </span>
            <Money value={day.totalMinor} {...(day.totalMinor > 0 ? { sign: "+" as const } : {})} />
          </p>
        )}
      </div>
      <ul className="feed-list card">
        {day.entries.map((entry) => (
          <FeedRow key={entry.transaction.id} view={feedRowView(entry, budget, authors)} onOpen={() => onEdit(entry.transaction)} {...(busy === undefined ? {} : { busy })} />
        ))}
      </ul>
    </section>
  );
}
