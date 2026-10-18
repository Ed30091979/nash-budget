/**
 * Семейная новость: что записали другие участники с прошлого раза.
 *
 * Единственный момент на входе, который несёт новость, которой у человека нет, — первое
 * открытие после того, как второй участник семьи что-то записал. Всё остальное, что приложение
 * могло бы сказать при открытии, человек либо уже знает, либо видит на экране; исследование
 * десяти денежных приложений не нашло ни одного, которое говорит что-то при каждом открытии.
 *
 * Никакого нового хранилища. «Что пришло с прошлого раза» вычисляется из того, что уже лежит на
 * устройстве: бюджет на экране — приём записал его в документ одной транзакцией с курсором
 * (`SYNC_STATE_KEYS.cursor`), — и заголовки операций журнала, где у каждой операции стоят
 * устройство и участник, которые её записали. Сама операция автора не хранит: форма записи
 * метку участника не ставит, а журнал ставит всегда, поэтому авторство читается из журнала, а
 * не из поля `memberId` операции.
 *
 * Здесь только арифметика и слова. Когда новость считается увиденной — решает `App.tsx`:
 * человек ушёл с «Сегодня» или свернул приложение, пока она стояла на экране.
 */
import type { BudgetState, Member, MemberId, RecurringRule, RecurringRuleId, Transaction } from "@family-budget/domain";
import type { JournalEntry } from "@family-budget/sync-protocol";

import { formatMoney } from "../../money";
import { plural } from "../../plural";
import { transactionAuthorLabel } from "./model";

/** Кто записал операцию — из заголовка её выигравшей операции в журнале. */
export interface TransactionAuthor {
  readonly deviceId: string;
  readonly memberId?: string;
}

/** Это устройство и его участник: всё, что записано ими, новостью не является. */
export interface OwnAuthor {
  readonly deviceId: string;
  readonly memberId: string | null;
}

/**
 * Авторы операций по идентификатору операции бюджета.
 *
 * Берётся выигравшая запись сущности: операция, которую создал один участник и поправил другой,
 * числится за тем, кто её поправил. Удаления не в счёт — удалённой операции в бюджете нет, и
 * сказать про неё «записана» нельзя.
 */
export function authorsOfTransactions(
  entries: readonly JournalEntry[],
): ReadonlyMap<string, TransactionAuthor> {
  const authors = new Map<string, TransactionAuthor>();
  for (const entry of entries) {
    if (entry.entity !== "transaction" || entry.action === "delete") continue;
    authors.set(
      entry.targetId,
      entry.memberId === undefined
        ? { deviceId: entry.deviceId }
        : { deviceId: entry.deviceId, memberId: entry.memberId },
    );
  }
  return authors;
}

/** Идентификаторы операций состояния — то, что человек уже видел. */
export function transactionIds(state: Pick<BudgetState, "transactions">): ReadonlySet<string> {
  return new Set(state.transactions.map((transaction) => transaction.id));
}

/**
 * Своё или чужое. Участник — точнее устройства: у одного человека бывает два устройства, и
 * запись со второго телефона того же участника новостью для него не является. Устройство —
 * запасной признак для операции, чей заголовок участника не назвал.
 */
function isOwn(author: TransactionAuthor, own: OwnAuthor): boolean {
  if (author.memberId !== undefined && own.memberId !== null) return author.memberId === own.memberId;
  return author.deviceId === own.deviceId;
}

export interface FamilyNewsItem {
  readonly transaction: Transaction;
  /** Участник из заголовка операции; `undefined` — заголовок участника не назвал. */
  readonly memberId: string | undefined;
}

/**
 * Чужие проведённые операции, которых не было в последний раз, когда человек смотрел.
 *
 * `own === null` — синхронизация не настроена или входа нет: новости не бывает никогда, и это
 * первая же строка, а не следствие пустой карты авторов. Операция без автора в журнале — не
 * новость: чьё это, приложение не знает и выдумывать не станет.
 */
export function familyNewsSince(
  seen: ReadonlySet<string>,
  state: Pick<BudgetState, "transactions">,
  authors: ReadonlyMap<string, TransactionAuthor>,
  own: OwnAuthor | null,
): readonly FamilyNewsItem[] {
  if (own === null) return [];
  const items: FamilyNewsItem[] = [];
  for (const transaction of state.transactions) {
    if (transaction.status !== "posted" || seen.has(transaction.id)) continue;
    const author = authors.get(transaction.id);
    if (author === undefined || isOwn(author, own)) continue;
    items.push({ transaction, memberId: author.memberId });
  }
  return items;
}

const KIND_ORDER: readonly Transaction["kind"][] = [
  "expense",
  "income",
  "refund",
  "transfer",
  "goal_contribution",
  "debt_out",
  "debt_in",
];

const KIND_FORMS: Readonly<Record<Transaction["kind"], readonly [string, string, string]>> = {
  expense: ["покупка", "покупки", "покупок"],
  income: ["доход", "дохода", "доходов"],
  refund: ["возврат", "возврата", "возвратов"],
  transfer: ["перевод", "перевода", "переводов"],
  goal_contribution: ["взнос", "взноса", "взносов"],
  debt_out: ["выдача по долгу", "выдачи по долгу", "выдач по долгу"],
  debt_in: ["поступление по долгу", "поступления по долгу", "поступлений по долгу"],
};

/** «а, б и в» — перечисление, как его читают вслух. */
function joinSpoken(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} и ${parts[parts.length - 1]}`;
}

/** «2 покупки на 4 500 ₽ и 1 доход на 80 000 ₽» — операции одного автора по видам. */
function kindsLine(list: readonly FamilyNewsItem[]): string {
  const parts = KIND_ORDER.flatMap((kind) => {
    const ofKind = list.filter((item) => item.transaction.kind === kind);
    if (ofKind.length === 0) return [];
    const sumMinor = ofKind.reduce((total, item) => total + item.transaction.amountMinor, 0);
    return [`${plural(ofKind.length, KIND_FORMS[kind])} на ${formatMoney(sumMinor)}`];
  });
  return joinSpoken(parts);
}

/**
 * Кто «автор» вхождения регулярной операции: правило, а не участник устройства, которое его
 * материализовало. Правило без названия называется так, как его называет экран.
 */
function ruleLabel(rule: RecurringRule | undefined): string {
  return rule?.name === undefined ? "По регулярной операции" : `По правилу «${rule.name}»`;
}

/**
 * Новость словами: по строке на участника — «Анна: 2 покупки на 4 500 ₽ и 1 доход на 80 000 ₽».
 *
 * Сообщить, а не поздравить: ни похвалы, ни восклицаний — финансовый регулятор Великобритании
 * называет «celebratory messages» признаком вредного дизайна в денежном приложении. Строка не
 * повторяет «Последние записи»: там пять последних операций по одной, здесь — итог того, что
 * пришло с прошлого раза, по видам и суммам. Глагола нет нарочно: имя участника рода не
 * называет, и «записал» ошибалось бы в половине семей.
 *
 * Вхождения регулярной операции идут своей строкой — «По правилу «Аренда»: 1 покупка на …», —
 * а не строкой участника, чьё устройство их записало: его заголовок стоит на операции только
 * потому, что материализовать правило выпало его устройству, и «Анна: 30 покупок» о том, что
 * никто не покупал, было бы неправдой.
 */
export function familyNewsLines(
  items: readonly FamilyNewsItem[],
  members: ReadonlyMap<MemberId, Member>,
  budget: Pick<BudgetState, "recurringRules"> = {},
): readonly string[] {
  const rules = new Map<RecurringRuleId, RecurringRule>((budget.recurringRules ?? []).map((rule) => [rule.id, rule]));
  const byAuthor = new Map<string | undefined, FamilyNewsItem[]>();
  const byRule = new Map<RecurringRuleId, FamilyNewsItem[]>();
  for (const item of items) {
    const ruleId = item.transaction.recurringRuleId;
    if (ruleId !== undefined) {
      byRule.set(ruleId, [...(byRule.get(ruleId) ?? []), item]);
      continue;
    }
    const list = byAuthor.get(item.memberId) ?? [];
    list.push(item);
    byAuthor.set(item.memberId, list);
  }
  return [
    ...[...byAuthor.entries()].map(([memberId, list]) => `${transactionAuthorLabel(members, memberId)}: ${kindsLine(list)}`),
    ...[...byRule.entries()].map(([ruleId, list]) => `${ruleLabel(rules.get(ruleId))}: ${kindsLine(list)}`),
  ].sort((left, right) => left.localeCompare(right, "ru-RU"));
}
