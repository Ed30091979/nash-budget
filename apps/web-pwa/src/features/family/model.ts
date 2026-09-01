/**
 * Everything the family screens decide, as pure functions.
 *
 * The screens themselves are markup. Every rule that a reviewer has to be able to check by
 * reading — which of the four sync states is showing, which stop is the one loud alarm and which
 * is an ordinary notice, what a withheld entity is called in Russian, where a fingerprint on the
 * screen came from — lives here, so that a test can assert it without a browser.
 *
 * Nothing in this file reaches the network or the clock of its own accord: `now` is a parameter.
 */
import type { BudgetState, Member, MemberId, Transaction } from "@family-budget/domain";
import { formatKeyFingerprint } from "@family-budget/sync-crypto";
import {
  SyncClientError,
  type PinState,
  type SyncStatusReport,
  type SyncStop,
} from "@family-budget/sync-client";
import type { JournalIntegrity, WithheldEntity } from "@family-budget/sync-protocol";

/* ───────────────────────────── Индикатор состояния ───────────────────────────── */

/**
 * The four states of the indicator, and no fifth.
 *
 * They are read out of {@link SyncStatusReport} and out of the outcome of the last round — never
 * out of `navigator.onLine` and never out of a timer. A device with a queue is «ожидает сети»
 * whether or not the browser believes it has one: what the person needs to know is that their own
 * change has not reached the family yet, and the browser's opinion about connectivity does not
 * change that.
 *
 * Отчёта одного не хватает, и это выяснилось дорого: он собирается из записей, которых
 * неудавшийся круг не делает, поэтому по нему лежащий сервер неотличим от тишины. Отсюда второй
 * источник — и по-прежнему четыре состояния, а не пятое: «до сервера не дошли» это «ожидает
 * сети», «сервер отказал» — «ошибка синхронизации».
 */
export const SYNC_INDICATOR_STATES = ["local", "synced", "waiting", "error"] as const;
export type SyncIndicatorState = (typeof SYNC_INDICATOR_STATES)[number];

export interface SyncIndicatorPresentation {
  readonly state: SyncIndicatorState;
  readonly text: string;
  readonly ariaLabel: string;
  readonly className: string;
}

const SYNC_INDICATOR_TEXT: Readonly<Record<SyncIndicatorState, string>> = {
  local: "локально",
  synced: "синхронизировано",
  waiting: "ожидает сети",
  error: "ошибка синхронизации",
};

/**
 * Чем кончился последний круг синхронизации — и это отдельная величина от {@link SyncStatusReport}.
 *
 * Отчёт собирается из записанного состояния: курсора, очереди и записи об остановке. Ни одна из
 * трёх не пишется, когда круг не дошёл до сервера, поэтому по отчёту лежащий сервер, умерший
 * токен обновления и отозванное устройство выглядят ровно как тишина — то есть как
 * «синхронизировано». Исход круга здесь для того, чтобы они так не выглядели.
 *
 * `unreachable` — до сервера не дошли; `refused` — сервер ответил и отказал. Разница видна
 * человеку: первое проходит само, когда вернётся связь, второе само не пройдёт.
 */
export const SYNC_ROUND_OUTCOMES = ["ok", "unreachable", "refused"] as const;
export type SyncRoundOutcome = (typeof SYNC_ROUND_OUTCOMES)[number];

/**
 * Отказ круга — в одну из двух половин, и обе берутся из кода ошибки, а не из её текста.
 *
 * `transport_failed` транспорт ставит там, где `fetch` не дал ответа вовсе (и там, где ответ был
 * не JSON, — с точки зрения устройства это то же самое: договорённого ответа нет). Всё остальное
 * — отказ, о котором сервер сказал сам, и он сам не пройдёт.
 */
export function classifySyncFailure(failure: unknown): Exclude<SyncRoundOutcome, "ok"> {
  return failure instanceof SyncClientError && failure.code === "transport_failed"
    ? "unreachable"
    : "refused";
}

/** Причина, дописанная к ярлыку для скринридера: видимый текст остаётся его началом. */
const SYNC_ROUND_CAUSE: Readonly<Record<Exclude<SyncRoundOutcome, "ok">, string>> = {
  unreachable: "сервер недоступен",
  refused: "сервер отказал",
};

/**
 * `null` is the local-only product, and it is the first branch on purpose.
 *
 * Section 9: without an account there is no synchronisation to report on, so the indicator says
 * «локально» and the app has made no request to be able to say it.
 *
 * `round` не имеет значения по умолчанию нарочно: круг, чей исход забыли передать, — это ровно
 * тот случай, из которого выросла зелёная надпись при лежащем сервере, и компилятор о нём
 * спрашивает на каждом месте вызова.
 */
export function syncIndicatorPresentation(
  report: SyncStatusReport | null,
  round: SyncRoundOutcome,
): SyncIndicatorPresentation {
  const state: SyncIndicatorState =
    report === null
      ? "local"
      : report.stop !== null || round === "refused"
        ? "error"
        : round === "unreachable" || report.queued > 0
          ? "waiting"
          : "synced";
  const text = SYNC_INDICATOR_TEXT[state];
  const cause = report === null || round === "ok" ? null : SYNC_ROUND_CAUSE[round];
  return {
    state,
    text,
    ariaLabel: `Состояние синхронизации: ${text}${cause === null ? "" : ` — ${cause}`}`,
    className: `sync-badge ${state}`,
  };
}

/* ───────────────────────────── Тревога и обычные остановки ───────────────────────────── */

/**
 * 3.4: `10` is a threshold of *retries of one envelope* and it changes the wording, nothing else.
 *
 * Below it the alarm reads «не удалось прочитать», at or above it «ключ семьи не совпадает». The
 * cursor has been stopped since the first refusal in both cases, and neither is dismissible.
 */
export const KEY_ALARM_ATTEMPTS = 10;

/**
 * The one loud signal this system has (3.4, 5.4.1).
 *
 * `dismissible` is `false` and is a literal type rather than a boolean, so that a screen cannot
 * quietly acquire a close button by passing a variable. There is no auto-dismiss and no swipe:
 * the family is being told their key may have been substituted, and the only way out is the
 * comparison of 5.4.1 that the person starts themselves.
 */
export interface SyncAlarm {
  readonly title: string;
  readonly body: string;
  readonly actionLabel: string;
  readonly opId: string;
  readonly seq: number;
  readonly attempts: number;
  readonly dismissible: false;
}

export function syncAlarm(stop: SyncStop | null): SyncAlarm | null {
  if (stop === null || stop.reason !== "key_mismatch") return null;
  const substituted = stop.attempts >= KEY_ALARM_ATTEMPTS;
  return {
    title: substituted ? "Ключ семьи не совпадает" : "Не удалось прочитать запись семьи",
    body: substituted
      ? "Запись семьи зашифрована не тем ключом, который держит это устройство. Так выглядит подмена ключа. Приём чужих операций остановлен и сам не продолжится: сверьте отпечатки ключей с другим участником голосом или лично."
      : "Запись семьи не открылась ключом этого устройства. Приём чужих операций остановлен и сам не продолжится. Если это повторится, значит ключ подменён — сверьте отпечатки ключей с другим участником.",
    actionLabel: "Сверить отпечатки ключей",
    opId: stop.opId,
    seq: stop.seq,
    attempts: stop.attempts,
    dismissible: false,
  };
}

export interface SyncNotice {
  readonly title: string;
  readonly body: string;
  readonly dismissible: true;
}

const NOTICE_BY_REASON = {
  journal_incomplete: {
    title: "Журнал неполон",
    body: "Сервер не отдал одну из промежуточных записей. Приём остановлен на ней и повторится сам; ничего не потеряно.",
  },
  update_required: {
    title: "Требуется обновление приложения",
    body: "Семья записала операцию, которую эта версия приложения прочитать не умеет. Обновите приложение — до этого новые записи семьи не применяются.",
  },
  quarantined: {
    title: "Запись отложена",
    body: "Одна запись не прошла проверку и отложена в карантин. Остальные операции семьи применяются как обычно.",
  },
} as const;

/** The three ordinary stops. `key_mismatch` never comes back from here — it is the alarm. */
export function syncNotice(stop: SyncStop | null): SyncNotice | null {
  if (stop === null || stop.reason === "key_mismatch") return null;
  const template = NOTICE_BY_REASON[stop.reason];
  return { title: template.title, body: template.body, dismissible: true };
}

/* ───────────────────────────── Удержанные сущности ───────────────────────────── */

const ENTITY_LABELS = {
  account: "Счёт",
  category: "Категория",
  budget: "Бюджет",
  budgetLine: "Строка бюджета",
  goal: "Цель",
  annualCommitment: "Крупный платёж",
  scheduledExpense: "Расход по расписанию",
  transaction: "Операция",
  member: "Участник",
} as const satisfies Readonly<Record<WithheldEntity["entity"], string>>;

const WITHHOLDING_LABELS = {
  identifier_claimed_twice: "один идентификатор заняли две разные записи",
  unknown_reference: "ссылается на запись, которой в бюджете нет",
  wrong_category_type: "категория не того типа, что нужен записи",
  invalid_refund: "возврат не сходится с расходом, который возвращает",
  goal_account_mismatch: "взнос попал не на тот счёт, что привязан к цели",
  duplicate_budget_line: "категория запланирована в бюджете дважды",
  unknown_active_budget: "выбранный бюджет в семью ещё не пришёл",
} as const satisfies Readonly<Record<WithheldEntity["reason"], string>>;

export interface WithheldRow {
  readonly entity: WithheldEntity["entity"];
  readonly id: string;
  readonly reason: WithheldEntity["reason"];
  readonly entityLabel: string;
  readonly reasonLabel: string;
}

/**
 * Decision 40 and `JournalIntegrity.withheld`: this list is shown even when `ready` is true.
 *
 * That is the whole point of it — a family shown its budget while an operation of its own is
 * quietly absent has been told something false. The identifier is written by whichever device
 * sent the operation, so it is rendered as data in its own element and never spliced into a
 * sentence.
 */
export function withheldRows(integrity: JournalIntegrity | null): readonly WithheldRow[] {
  if (integrity === null) return [];
  return integrity.withheld.map((item) => ({
    entity: item.entity,
    id: item.id,
    reason: item.reason,
    entityLabel: ENTITY_LABELS[item.entity],
    reasonLabel: WITHHOLDING_LABELS[item.reason],
  }));
}

/** Wording for the heading above {@link withheldRows}. Never «всё в порядке» when it is not. */
export function withheldHeadline(rows: readonly WithheldRow[]): string | null {
  if (rows.length === 0) return null;
  return rows.length === 1
    ? "Одна запись семьи не показана в бюджете"
    : `Записей семьи не показано в бюджете: ${rows.length}`;
}

/* ───────────────────────────── Автор операции ───────────────────────────── */

export const MEMBER_FILTER_ALL = "all";
export const MEMBER_FILTER_NONE = "none";
export type MemberFilter = typeof MEMBER_FILTER_ALL | typeof MEMBER_FILTER_NONE | MemberId;

/** Operations written before members existed, and every operation nobody claimed. */
export const UNATTRIBUTED_AUTHOR = "Без участника";

export function membersById(budget: BudgetState): ReadonlyMap<MemberId, Member> {
  return new Map((budget.members ?? []).map((member) => [member.id, member]));
}

/**
 * The author's name, or an honest placeholder.
 *
 * A `memberId` naming somebody who is not in this state is shown as its own case rather than as
 * «Без участника»: the operation does claim an author, and saying otherwise would hide the fact
 * that a member arrived in the journal after the operation that names them.
 */
export function transactionAuthorLabel(
  members: ReadonlyMap<MemberId, Member>,
  memberId: MemberId | undefined,
): string {
  if (memberId === undefined) return UNATTRIBUTED_AUTHOR;
  const member = members.get(memberId);
  return member === undefined ? "Участник не найден" : member.name;
}

export interface MemberFilterOption {
  readonly value: MemberFilter;
  readonly label: string;
}

export function memberFilterOptions(budget: BudgetState): readonly MemberFilterOption[] {
  const members = budget.members ?? [];
  return [
    { value: MEMBER_FILTER_ALL, label: "Все участники" },
    ...members
      .filter((member) => member.active)
      .map((member) => ({ value: member.id as MemberFilter, label: member.name })),
    { value: MEMBER_FILTER_NONE, label: UNATTRIBUTED_AUTHOR },
  ];
}

export function filterTransactionsByMember<T extends Pick<Transaction, "memberId">>(
  transactions: readonly T[],
  filter: MemberFilter,
): readonly T[] {
  if (filter === MEMBER_FILTER_ALL) return transactions;
  if (filter === MEMBER_FILTER_NONE) {
    return transactions.filter((transaction) => transaction.memberId === undefined);
  }
  return transactions.filter((transaction) => transaction.memberId === filter);
}

/* ───────────────────────────── Отпечатки ключей (5.4.1) ───────────────────────────── */

/**
 * Where the value on the screen came from. The three cases of 5.4.1, and no fourth.
 *
 * - `own` — computed from this device's own public key. Local always, never из ответа сервера.
 * - `pinned` — read out of the local pin, so the comparison compares the pin with reality.
 * - `unverified_candidate` — there is no pin yet, so the value arrived from the server and is
 *   labelled as such on the screen. Confirming it is what *creates* the pin.
 */
export type FingerprintOrigin = "own" | "pinned" | "unverified_candidate";

export interface FingerprintPresentation {
  readonly origin: FingerprintOrigin;
  readonly text: string;
  readonly originLabel: string;
  readonly note: string;
  /** True only for the candidate: a pin that exists is compared, not re-created. */
  readonly createsPin: boolean;
}

export function ownFingerprintPresentation(fingerprint: Uint8Array): FingerprintPresentation {
  return {
    origin: "own",
    text: formatKeyFingerprint(fingerprint),
    originLabel: "Отпечаток этого устройства",
    note: "Посчитан из открытого ключа этого устройства. Прочитайте его вслух собеседнику.",
    createsPin: false,
  };
}

/**
 * Пин, каким его знает это приложение: он либо есть, либо его нет.
 *
 * `PinState` семейства `sync-client` знает и третье — `repin_required`. Здесь оно не принимается
 * нарочно (см. {@link peerFingerprintPresentation}), и это проверяет компилятор, а не дисциплина
 * вызывающего.
 */
export type LocalPinState = Extract<PinState, { readonly state: "pinned" | "absent" }>;

/**
 * The peer's fingerprint, chosen by the local pin and never by the server's answer.
 *
 * `offered` is the SPKI hash the server volunteered. It is used **only** when there is no pin: with
 * a pin present, showing the server's value would replace «сравнить пин с реальностью» with
 * «сравнить две копии подставленного значения», which 5.4 forbids in as many words.
 *
 * `repin_required` сюда не приходит и приниматься не должно. 5.4.1 требует показать в этом
 * состоянии **оба** значения — прежний пин и нового кандидата — и прямо запрещает показывать одно;
 * ветка, трактовавшая его как «пина нет», делала запрещённое. Состояния в приложении пока нет
 * (`pinOf` отвечает только `pinned` и `absent`), поэтому вместо готовой ловушки — тип, который
 * такой пин сюда не пропускает. Появится состояние — появится и показ обоих значений.
 */
export function peerFingerprintPresentation(
  pin: LocalPinState,
  offered: Uint8Array | undefined,
): FingerprintPresentation | null {
  if (pin.state === "pinned") {
    return {
      origin: "pinned",
      text: formatKeyFingerprint(pin.fingerprint),
      originLabel: "Подтверждённый отпечаток",
      note: "Значение взято из закреплённой записи этого устройства, а не из ответа сервера. Если собеседник называет другой отпечаток — ключ подменён.",
      createsPin: false,
    };
  }
  if (offered === undefined) return null;
  return {
    origin: "unverified_candidate",
    text: formatKeyFingerprint(offered),
    originLabel: "Непроверенный отпечаток",
    note: "Значение пришло от сервера и поэтому нуждается в подтверждении. Сверьте его голосом или лично: подтверждение создаёт закреплённую запись.",
    createsPin: true,
  };
}

/* ───────────────────────────── Вход по почте и коду ───────────────────────────── */

/** Deliberately permissive and only about shape: the server is the authority on the address. */
export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && trimmed.length <= 254 && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/u.test(trimmed);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export const LOGIN_CODE_LENGTH = 6;

export function normalizeLoginCode(value: string): string {
  return value.replace(/\D+/gu, "").slice(0, LOGIN_CODE_LENGTH);
}

export function isValidLoginCode(value: string): boolean {
  return normalizeLoginCode(value).length === LOGIN_CODE_LENGTH;
}

/* ───────────────────────────── Приглашение ───────────────────────────── */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How long the code is good for, in words a person uses.
 *
 * Decision 6 fixes the TTL at 24 hours and the server sets it, so the number here is whatever the
 * server answered — never a constant of this build, which would drift from it silently.
 */
export function formatInviteExpiry(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "срок кода истёк";
  if (left < HOUR_MS) return `действует ещё ${Math.max(1, Math.round(left / MINUTE_MS))} мин`;
  return `действует ещё ${Math.floor(left / HOUR_MS)} ч`;
}

/** Twelve Crockford symbols read aloud in three groups of four. */
export function formatInviteCode(code: string): string {
  const groups: string[] = [];
  for (let index = 0; index < code.length; index += 4) groups.push(code.slice(index, index + 4));
  return groups.join("-");
}

export const MEMBER_ROLE_LABELS = {
  owner: "владелец",
  member: "участник",
} as const;

/* ───────────────────────────── Предупреждение перед вступлением ───────────────────────────── */

export interface JoinConsequence {
  readonly title: string;
  readonly body: string;
  readonly backupLine: string;
  readonly backupActionLabel: string;
  readonly confirmLabel: string;
}

/**
 * Что человек теряет из виду, нажав «вступить», — сказанное до нажатия, а не после.
 *
 * Устройство, вступившее по коду, посева не делает (см. `createBudgetJournalWriter`): личный
 * бюджет в семейный не вливается, и семья присылает свой. Это правильное поведение, но для того,
 * кто вёл бюджет месяц, оно выглядит как пропажа, если о нём не сказать заранее. Поэтому здесь
 * ровно два факта и ни одного пугающего слова: что покажет экран после вступления и чем прежний
 * бюджет сохраняется. Файл копии остаётся у человека, и восстановление — обычный путь экрана
 * «Данные», а не спасательная операция.
 *
 * Дата последней копии называется как есть: копия недельной давности — это копия без записей
 * последней недели, и умалчивать об этом было бы тем же самым умолчанием, что и всё остальное,
 * которое здесь исправляется.
 */
export function joinConsequence(
  localTransactions: number,
  lastBackupAt: string | null,
  formatBackupDate: (value: string) => string,
): JoinConsequence {
  const counted = localTransactions === 0 ? "" : ` Записанных здесь операций: ${localTransactions}.`;
  return {
    title: "После вступления здесь будет бюджет семьи",
    body:
      "Этот экран перестанет показывать бюджет, который вы ведёте здесь сейчас: счета, категории и планы придут от семьи, и на экране будут они." +
      counted +
      " Ваш прежний бюджет в семейный не вливается — иначе ваши счета стали бы общими без спроса.",
    backupLine:
      lastBackupAt === null
        ? "Резервной копии этого бюджета ещё нет. Сделайте её сейчас — файл останется у вас, и прежний бюджет можно будет восстановить на экране «Данные»."
        : `Последняя резервная копия: ${formatBackupDate(lastBackupAt)}. Записи, сделанные после неё, в файл не попали.`,
    backupActionLabel: "Сделать копию сейчас",
    confirmLabel: "Вступить в семью",
  };
}
