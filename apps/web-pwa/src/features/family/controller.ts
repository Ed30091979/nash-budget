/**
 * Everything the «Семья» screen does that has a side effect.
 *
 * The screen is markup and form state; this is the half that talks to the server, to WebCrypto and
 * to IndexedDB. It is a hook rather than a component so that the header's indicator and the
 * screen's body read the same state, and so that not one line of it runs on the local-only path:
 * the effects below start with `serverUrl === null` and `session === null` and stop there.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BudgetState } from "@family-budget/domain";
import type { IndexedDbBudgetRepository } from "@family-budget/storage";
import {
  SYNC_STATE_KEYS,
  SyncClientError,
  SyncEngine,
  SyncServerError,
  createHttpTransport,
  fromBase64,
  toBase64,
  type OutgoingEnvelope,
  type SyncStatusReport,
  type SyncTransport,
} from "@family-budget/sync-client";
import {
  computeBindProof,
  deviceKeyFingerprint,
  deriveInviteSecrets,
  exportDevicePublicKey,
  familyKeyFingerprint,
  fromHex,
  generateDeviceKeyPair,
  generateFamilyKey,
  generateInviteCode,
  normalizeInviteCode,
  openInvite,
  sealInvite,
  toHex,
  verifyBindProof,
} from "@family-budget/sync-crypto";
import { restoreJournal, type JournalIntegrity } from "@family-budget/sync-protocol";

import { EPOCH_REFUSAL_TEXT, takeIncomingEpoch } from "./epoch-intake";
import {
  rotateFamilyKey,
  RotationHalted,
  type RotationGap,
  type RotationProgress,
  type SkippedDevice,
} from "./rotation";

import {
  createFamilyApi,
  describeFamilyError,
  FamilyRefusal,
  type DeviceRecord,
  type FamilyApi,
  type MemberRecord,
  type MembershipSnapshot,
} from "./api";
import type { ActiveInvite, FamilyActions } from "./FamilyScreen";
import { prepareBudgetState } from "../../backup";
import { BudgetWriteRefusal } from "../../write-refusal";
import { budgetJournalDrafts } from "./journal";
import { authorsOfTransactions, type TransactionAuthor } from "./news";
import {
  classifySyncFailure,
  normalizeEmail,
  type LocalPinState,
  type SyncRoundOutcome,
} from "./model";
import {
  PINS_STATE_KEY,
  forgetSession,
  isSyncActive,
  loadSession,
  persistSession,
  type FamilySession,
} from "./session";

/** Принимает ли шлюз приложения состояние журнала: документ хранит только такие (см. SyncEngine). */
export function acceptsJournalState(state: BudgetState): boolean {
  try {
    prepareBudgetState(state);
    return true;
  } catch {
    return false;
  }
}

/** The device's own ECDH pair, kept where the family key is kept and nowhere else. */
const DEVICE_KEY_STATE_KEY = "device-key";
/** The family key of the epoch this device has accepted. */
const FAMILY_KEY_STATE_KEY = "family-key";
/**
 * The issuing device's half of a live invite — and, deliberately, **not** the code.
 *
 * 6.3 in one sentence: the code «показывается на экране один раз и не хранится ни на сервере, ни в
 * локальной базе», while `bindKey` «остаётся в локальной базе устройства владельца — он
 * понадобится для проверки `bindProof`». This record used to hold exactly the opposite pair: the
 * code was written to disk and never removed, and `bindKey` was dropped on the floor with the rest
 * of `sealInvite`'s `issuerSecrets`, so the automatic half of binding could not run at all.
 *
 * What is kept is what the HMAC of 5.4 is recomputed on: the key, and the four identifiers the
 * message is built from. It is erased the moment a verdict is reached about the device that joined
 * by it, and on expiry, which is the other half of 6.3's sentence about it.
 */
const INVITE_STATE_KEY = "issued-invite";
/**
 * The verdict of the automatic binding check, per device — 6.4.
 *
 * Local, like every verdict about a key's authenticity (2.2): the server hands out the public keys
 * and may not also be the place that records whether they were believed. «bound» is what a
 * matching `bindProof` writes; «failed» is a device whose proof did not agree, which gets no wrap
 * at the next rotation and is shown as «ключ не подтверждён».
 */
const BIND_STATE_KEY = "device-bind";
/**
 * Наибольший `seq`, который это устройство когда-либо видело в текущей эпохе.
 *
 * Собственная величина, и в этом весь смысл: 5.5 шаг 2 велит принимать `freezeSeq` «только не
 * меньшим двух своих величин — собственного курсора и наибольшего `seq`, который он когда-либо
 * видел». Курсор один этого не даёт: остановка приёма (3.4) держит курсор ниже номера конверта,
 * на котором она произошла, а этот номер устройство **видело**.
 */
const HIGH_WATER_STATE_KEY = "journal-high-water";
/**
 * Номера, потерянные при переносе журнала, — 5.5 шаг 2 и 3.6.
 *
 * Едут в `inheritedGaps` **первого** чекпойнта новой эпохи и больше никуда: это факт о переходе, а
 * не о наборе этого устройства, и повторение их в каждом чекпойнте превратило бы одну потерю в
 * повторяющуюся. Движок сам ставит их только в чекпойнт с индексом `1`.
 */
const INHERITED_GAPS_STATE_KEY = "inherited-gaps";
/**
 * Ключ эпохи, которую устройство только что покинуло, — 5.4.1.
 *
 * «Ключи прошедших эпох стираются… но лишь после доказательства, что новая эпоха живая.» Сервер
 * вправе отдать обёртку и подтверждение **до** публикации новой эпохи, а потом отменить ротацию по
 * таймауту; устройство, стёршее старый ключ сразу, оказалось бы выключено из семьи навсегда без
 * единой подделки. Пока запись жива, движок получает её в `retiredKeys` и переносит ею свою
 * очередь; она стирается, когда новая эпоха доказана живой и очередь пуста.
 */
const RETIRED_KEY_STATE_KEY = "retired-family-key";
/**
 * Откуда берётся бюджет этой семьи — и это решается один раз, при вступлении в неё.
 *
 * `local` пишет устройство, которое семью **создало**: его бюджет и есть бюджет семьи, поэтому
 * первая же запись отправляет в журнал всё состояние целиком. Без этого второе устройство
 * получило бы одну операцию и ни одной категории, к которой её отнести.
 *
 * `family` пишет устройство, которое **вступило** по коду: бюджет придёт к нему журналом, и
 * посев здесь означал бы, что личный бюджет вступающего молча вливается в семейный. Признак
 * хранится, а не вычисляется из «журнал пуст», ровно потому, что журнал пуст в обоих случаях.
 */
export const JOURNAL_ORIGIN_KEY = "journal-origin";
export type JournalOrigin = "local" | "family";

/** Как часто устройство в семье само спрашивает журнал. Одна цифра, не выведенная из ответа. */
const SYNC_INTERVAL_MS = 15_000;

interface StoredDeviceKey {
  readonly keyPair: CryptoKeyPair;
  readonly spki: string;
}

interface StoredFamilyKey {
  readonly key: CryptoKey;
  readonly keyEpoch: number;
}

/** Отметка о наибольшем виденном `seq`, по эпохам. Эпоха обязательна: номера поэпоховые. */
export interface HighWaterMark {
  readonly keyEpoch: number;
  readonly seq: number;
}

/**
 * Новая высокая вода — из курсора и из номера, на котором приём остановился.
 *
 * Останов входит в счёт наравне с курсором: конверт, на котором выдача встала, устройство видело,
 * и `freezeSeq` ниже его номера означал бы, что сервер вырезал ровно то, чего устройство ещё не
 * применило. Запись другой эпохи не переносится — номера начинаются заново с каждой эпохой.
 */
export function nextHighWater(stored: unknown, report: SyncStatusReport): HighWaterMark {
  const seen = Math.max(report.cursor.seq, report.stop?.seq ?? 0);
  if (
    typeof stored === "object" &&
    stored !== null &&
    !Array.isArray(stored) &&
    (stored as HighWaterMark).keyEpoch === report.cursor.keyEpoch &&
    Number.isSafeInteger((stored as HighWaterMark).seq)
  ) {
    return {
      keyEpoch: report.cursor.keyEpoch,
      seq: Math.max((stored as HighWaterMark).seq, seen),
    };
  }
  return { keyEpoch: report.cursor.keyEpoch, seq: seen };
}

/** Прочитанная отметка для запрошенной эпохи, или `0`, когда её нет. */
export function highWaterFor(stored: unknown, keyEpoch: number): number {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return 0;
  const record = stored as HighWaterMark;
  if (record.keyEpoch !== keyEpoch || !Number.isSafeInteger(record.seq)) return 0;
  return Math.max(0, record.seq);
}

/** Пропуски, унаследованные новой эпохой, — читаются только для той эпохи, которой они принадлежат. */
export function inheritedGapsFor(stored: unknown, keyEpoch: number): readonly number[] {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return [];
  const record = stored as { readonly keyEpoch?: unknown; readonly gaps?: unknown };
  if (record.keyEpoch !== keyEpoch || !Array.isArray(record.gaps)) return [];
  return record.gaps.filter(
    (value): value is number => Number.isSafeInteger(value) && (value as number) > 0,
  );
}

export interface StoredInvite {
  readonly inviteId: string;
  readonly familyId: string;
  readonly keyEpoch: number;
  readonly expiresAt: number;
  readonly supersededCount: number;
  /** `bindKey` in lower-case hex — the third of the Argon2id output that binds the joining key. */
  readonly bindKey: string;
}

export type BindVerdict = "bound" | "failed";

/**
 * Reads the issued-invite record, and reads anything that is not one as «нет приглашения».
 *
 * The strictness is what erases the old shape rather than tolerating it. A build before this one
 * wrote `{ code, expiresAt, supersededCount }` here, and a device upgrading into this build must
 * not go on carrying a plaintext invite code in its database because the fields it does recognise
 * happened to parse: no `bindKey`, no record — and {@link useFamily} then overwrites it with
 * `null`, which is what actually removes the code from disk.
 */
export function parseStoredInvite(value: unknown): StoredInvite | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.bindKey !== "string" || !/^[0-9a-f]{64}$/u.test(record.bindKey)) return null;
  if (typeof record.inviteId !== "string" || record.inviteId.length === 0) return null;
  if (typeof record.familyId !== "string" || record.familyId.length === 0) return null;
  if (!Number.isSafeInteger(record.keyEpoch)) return null;
  if (!Number.isSafeInteger(record.expiresAt)) return null;
  return {
    inviteId: record.inviteId,
    familyId: record.familyId,
    keyEpoch: record.keyEpoch as number,
    expiresAt: record.expiresAt as number,
    supersededCount: Number.isSafeInteger(record.supersededCount)
      ? (record.supersededCount as number)
      : 0,
    bindKey: record.bindKey,
  };
}

/**
 * Записи очереди, приведённые к форме конверта, — 5.5 шаг 2 переносит их вместе с журналом.
 *
 * Форма проверяется здесь, а не приводится приведением типа: очередь читается с диска, и запись,
 * оставшаяся от другой версии сборки, не должна попасть в переносимый набор молча. Всё, что не
 * конверт, отбрасывается — оно и так не отправилось бы.
 */
export function queuedEnvelopes(
  records: readonly { readonly envelope: unknown }[],
): readonly OutgoingEnvelope[] {
  const envelopes: OutgoingEnvelope[] = [];
  for (const record of records) {
    const value = record.envelope;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const candidate = value as Partial<OutgoingEnvelope>;
    if (
      !Number.isSafeInteger(candidate.envelopeVersion) ||
      typeof candidate.kind !== "string" ||
      typeof candidate.familyId !== "string" ||
      typeof candidate.opId !== "string" ||
      typeof candidate.deviceId !== "string" ||
      !Number.isSafeInteger(candidate.keyEpoch) ||
      typeof candidate.iv !== "string" ||
      typeof candidate.ciphertext !== "string"
    ) {
      continue;
    }
    envelopes.push(candidate as OutgoingEnvelope);
  }
  return envelopes;
}

export function parseBindVerdicts(value: unknown): ReadonlyMap<string, BindVerdict> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return new Map();
  const verdicts = new Map<string, BindVerdict>();
  for (const [deviceId, verdict] of Object.entries(value as Record<string, unknown>)) {
    if (verdict === "bound" || verdict === "failed") verdicts.set(deviceId, verdict);
  }
  return verdicts;
}

export function serializeBindVerdicts(
  verdicts: ReadonlyMap<string, BindVerdict>,
): Record<string, BindVerdict> {
  const record: Record<string, BindVerdict> = {};
  for (const [deviceId, verdict] of verdicts) record[deviceId] = verdict;
  return record;
}

/** What the automatic half of binding decided about the device that used one invite. */
export interface BindCheckOutcome {
  readonly deviceId: string;
  readonly verdict: BindVerdict;
  /** `SHA-256(SPKI)` of the joined device — the pin a matching proof creates (6.4). */
  readonly fingerprint: Uint8Array | null;
}

/**
 * Recomputes `bindProof` on the `bindKey` kept from the invite — 5.4 and 6.4, the owner's side.
 *
 * «Устройство владельца при первом же выходе в сеть забирает `(deviceId, SPKI, bindProof)` нового
 * устройства и пересчитывает HMAC на своём `bindKey`. Совпадение — устройство помечено привязанным
 * автоматически, без участия пользователя. Расхождение — устройство помечено как "ключ не
 * подтверждён"». The check is on the owner's own `inviteId`, never on the one the response names,
 * which is why substituting that identifier gains the server nothing.
 *
 * `null` means there is nothing to decide yet: no device in the list joined by this invite, or the
 * one that did has not had its proof served. Neither is a verdict, and neither erases the key.
 */
export async function checkInviteBinding(
  invite: StoredInvite,
  devices: readonly DeviceRecord[],
): Promise<BindCheckOutcome | null> {
  const joined = devices.find(
    (device) => device.inviteId === invite.inviteId && device.bindProof !== null,
  );
  if (joined === undefined || joined.bindProof === null) return null;
  let spki: Uint8Array;
  let proof: Uint8Array;
  try {
    spki = decodeBase64(joined.publicKey, "device key");
    proof = decodeBase64(joined.bindProof, "bind proof");
  } catch {
    // A key or a proof the server could not spell is a device whose binding did not check out.
    return { deviceId: joined.deviceId, verdict: "failed", fingerprint: null };
  }
  let agreed: boolean;
  try {
    agreed = await verifyBindProof(
      fromHex(invite.bindKey),
      {
        familyId: invite.familyId,
        inviteId: invite.inviteId,
        deviceId: joined.deviceId,
        spki,
      },
      proof,
    );
  } catch {
    return { deviceId: joined.deviceId, verdict: "failed", fingerprint: null };
  }
  return {
    deviceId: joined.deviceId,
    verdict: agreed ? "bound" : "failed",
    fingerprint: agreed ? await deviceKeyFingerprint(spki) : null,
  };
}

type Repository = IndexedDbBudgetRepository<never> | IndexedDbBudgetRepository<unknown>;

/** The participant record the local budget keeps. Names live in the budget, never on the server. */
export interface LocalMember {
  readonly id: string;
  readonly name: string;
  readonly role: "owner" | "member";
  readonly active: boolean;
}

export interface FamilyControllerOptions {
  /**
   * Writes this device's participant into the local budget.
   *
   * 2.2 keeps display names out of the server entirely, so the member list the server serves has
   * roles and dates and nothing a person recognises. The name is a property of the budget, and
   * this is where it is put there — once, when the family is created or joined.
   */
  readonly registerLocalMember?: (member: LocalMember) => Promise<void>;
  /**
   * Экран догоняет документ на диске: показывает его, если показанное — другая ревизия.
   *
   * Приём записал чужие операции в документ одной транзакцией с курсором и журналом — экрану
   * остаётся его показать. Зовётся после каждого круга, а не только после того, что сообщил
   * «применено»: сообщение теряется (круг снят, конверт применила другая вкладка), а курсор уже за
   * конвертом, и ни один следующий круг его не принесёт. Без этого вызова операция, введённая на
   * другом устройстве, лежала бы в базе и не появлялась бы на экране до перезапуска. Отвечает,
   * показан ли новый документ.
   */
  readonly showStoredBudget?: () => Promise<boolean>;
}

/**
 * Результат записи бюджета через журнал.
 *
 * Форма нарочно совпадает с `saveIfRevision`: координатор записи (`app/budget-store.ts`) не должен знать, чем
 * он писал. `null` — это «журнала нет» (нет адреса сервера, нет сессии, нет семьи или ключа), и
 * тогда вызывающий пишет ровно так, как писал до синхронизации.
 */
export type JournalWriteOutcome =
  | { readonly status: "saved"; readonly value: unknown; readonly revision: string }
  | {
      readonly status: "conflict";
      readonly current: { readonly value: unknown; readonly revision: string } | null;
    };

export interface BudgetJournalWrite {
  (input: {
    readonly expectedRevision: string | null;
    readonly previous: BudgetState;
    readonly next: BudgetState;
  }): Promise<JournalWriteOutcome | null>;
}

export interface JournalWriterOptions {
  /** Движок семьи или `null`, если журнала нет. Спрашивается на каждой записи. */
  readonly engineFor: () => Promise<SyncEngine | null>;
  readonly store: SyncStateStore;
  /** Участник этого устройства: он попадает в заголовок каждой операции. */
  readonly memberId: () => string | undefined;
  /** Прежняя запись документа. Нужна там, где журналу сказать нечего. */
  readonly saveIfRevision: (
    expectedRevision: string | null,
    value: unknown,
  ) => Promise<JournalWriteOutcome>;
  /** Что сделать после того, как операции легли в очередь. Обычно — отправка. */
  readonly afterWrite?: (engine: SyncEngine) => void;
}

/**
 * Запись бюджета журналом. Единственный путь, которым изменение попадает в очередь операций.
 *
 * Отвечает `null`, когда журнала нет: без адреса сервера, без сессии, без семьи и без ключа
 * вызывающий пишет ровно тем же сравнением ревизии, что и до синхронизации. Проверка стоит
 * первой и до любого чтения хранилища — это она держит обещание, а не дисциплина вызывающего.
 *
 * Посев (сравнение с `null` вместо прежнего состояния) делает только устройство, создавшее семью,
 * и только пока журнал пуст: его бюджет и есть бюджет семьи. Устройство, вступившее по коду,
 * посева не делает никогда — иначе его личный бюджет молча влился бы в семейный.
 *
 * Показывается то, что действительно легло в документ, а не то, что просили записать: шлюз
 * целостности показывает снимок, только когда его можно показать (решение 19). Поэтому результат
 * читается с диска, а не собирается из намерения — иначе экран показывал бы изменение, которого
 * перезапуск не найдёт.
 *
 * Только чтение — пока документ задержан (`SyncStatusReport.hold`: семья записала то, что эта
 * версия не открывает) и пока на устройстве нет документа семьи (`familyDocument`: вступившее
 * устройство всё ещё держит бюджет, который был у него до вступления). В обоих случаях показанное
 * — не состояние журнала, и правка, собранная из него, ушла бы семье целыми сущностями под
 * меткой, перебивающей чужие правки, — а из личного бюджета ещё и чужими семье счетами (второе
 * ревью, MEDIUM-2 и MEDIUM-3). Запись отклоняется {@link BudgetWriteRefusal} раньше, чем что-либо
 * ляжет в очередь или в документ, и форма показывает, почему. Журнал, состояние которого нельзя
 * показать вовсе (задержка `journal_not_ready`), пропускает одну запись — ту, после которой его
 * можно показать: открытие месяца; это решает движок по состоянию, которое запись оставит.
 *
 * Правка собирается из того, что показано на экране, и только если это и есть документ. Задержка,
 * снятая здесь же, или чужая запись, ещё не показанная, означают, что экран отстал: правка из него
 * несла бы старые сущности поверх новых — переименование другого участника пропало бы у всей
 * семьи (третье ревью, S1), а личный бюджет вступившего ушёл бы семье (S6). Тогда ответ —
 * `conflict` с документом с диска: координатор показывает его, и человек повторяет правку уже на
 * нём, тем же путём, что и при записи другой вкладки.
 */
export function createBudgetJournalWriter(options: JournalWriterOptions): BudgetJournalWrite {
  return async ({ expectedRevision, previous, next }) => {
    const engine = await options.engineFor();
    if (engine === null) return null;
    // Сборка, которая теперь открывает состояние журнала, снимает задержку до того, как о записи
    // будет решено, — иначе первая запись после обновления отклонялась бы зря.
    const settled = await engine.settleDocument();
    const report = await engine.documentStatus();
    if (report.hold !== null && report.hold.reason === "rejected_by_app") throw new BudgetWriteRefusal("held");
    if (!report.familyDocument) throw new BudgetWriteRefusal("pending");
    const stored = await options.store.loadVersioned().catch(() => null);
    if (settled || (stored !== null && showsOtherThan(previous, stored.value))) {
      return { status: "conflict", current: stored };
    }
    const origin = await options.store
      .readSyncState<JournalOrigin>(JOURNAL_ORIGIN_KEY)
      .catch(() => undefined);
    const journal = await options.store
      .readSyncState(SYNC_STATE_KEYS.journal)
      .catch(() => undefined);
    const seed = origin === "local" && journal === undefined;
    const drafts = budgetJournalDrafts(seed ? null : previous, next, options.memberId());
    if (drafts.length === 0) {
      // Задержанный документ не переписывается ничем, кроме принятого состояния журнала, — даже
      // записью, в которой не изменилась ни одна сущность.
      if (report.hold !== null) throw new BudgetWriteRefusal("notReady");
      // Ни одна сущность не изменилась. Журналу сказать нечего, и запись идёт прежним путём,
      // чтобы форма состояния на диске всё равно догнала показанную.
      return options.saveIfRevision(expectedRevision, next);
    }
    let committed: Awaited<ReturnType<SyncEngine["enqueue"]>>;
    try {
      committed = await engine.enqueue(drafts);
    } catch (failure) {
      // Задержка могла начаться между проверкой выше и записью — приёмом в другой вкладке.
      if (failure instanceof SyncClientError && failure.code === "document_held") throw new BudgetWriteRefusal("held");
      if (failure instanceof SyncClientError && failure.code === "state_refused") throw new BudgetWriteRefusal("refused");
      if (failure instanceof SyncClientError && failure.code === "journal_not_ready") throw new BudgetWriteRefusal("notReady");
      throw failure;
    }
    const document = await options.store.loadVersioned().catch(() => null);
    options.afterWrite?.(engine);
    if (document !== null) return { status: "saved", value: document.value, revision: document.revision };
    // Документ не прочитался после записи. Принятый снимок журнала несёт ту же правку, что и
    // `next`, — показывается `next`: его приложение уже проверило.
    if (committed.revision === null) return { status: "conflict", current: null };
    return { status: "saved", value: next, revision: committed.revision };
  };
}

/**
 * Показывает ли экран не то, что лежит в документе: есть ли хоть одна сущность, которой они
 * различаются. По сущностям, а не по ревизии: чекпойнт и перешифровка очереди переписывают
 * документ без единого изменения, и сравнение ревизий называло бы каждую такую запись чужой.
 * Документ, который не открывается шлюзом, — заведомо не то, что показано.
 */
function showsOtherThan(shown: BudgetState, stored: unknown): boolean {
  try {
    return budgetJournalDrafts(shown, prepareBudgetState(stored)).length > 0;
  } catch {
    return true;
  }
}

/** «Анна» out of «anna@example.com». Local, cosmetic, and editable later in the budget itself. */
export function memberNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[._-]+/gu, " ").trim().slice(0, 60);
  if (cleaned.length === 0) return "Участник";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export interface FamilyController {
  readonly serverUrl: string | null;
  readonly session: FamilySession | null;
  /**
   * Устройство в семье и ведёт её журнал: адрес сервера, сессия и семья есть. Тогда бюджет на
   * экране — бюджет семьи или ничего: без документа семьи (`status.familyDocument`) приложение
   * показывает, чего устройство ждёт, а не онбординг и не бюджет, который был до вступления.
   */
  readonly inFamily: boolean;
  readonly membership: MembershipSnapshot | null;
  readonly members: readonly MemberRecord[];
  readonly devices: readonly DeviceRecord[];
  readonly ownFingerprint: Uint8Array | null;
  readonly pinOf: (deviceId: string) => LocalPinState;
  /**
   * What the automatic half of binding decided about a device (6.4), or `null` when it never ran.
   *
   * `null` is the ordinary state of a device that joined by a ceremony rather than by a code:
   * there is no `bindProof` to check and none is expected.
   */
  readonly bindVerdictOf: (deviceId: string) => BindVerdict | null;
  readonly offeredFingerprintOf: (deviceId: string) => Uint8Array | undefined;
  readonly invite: ActiveInvite | null;
  readonly status: SyncStatusReport | null;
  /**
   * Исход последнего круга. Отдельно от `status` потому, что это разные источники: отчёт —
   * записанное состояние, исход — то, чем кончилась попытка его пополнить.
   */
  readonly syncRound: SyncRoundOutcome;
  readonly integrity: JournalIntegrity | null;
  /**
   * Кто записал каждую операцию бюджета — из заголовков выигравших операций журнала.
   *
   * Нужно семейной новости (§6): сама операция автора не хранит, форма записи метку участника
   * не ставит, а журнал ставит всегда. Пустая карта — журнала нет: без адреса сервера, без
   * сессии, без семьи. Читается там же и тогда же, где журнал читается ради целостности, —
   * второго прохода по журналу ради неё нет.
   */
  readonly transactionAuthors: ReadonlyMap<string, TransactionAuthor>;
  /** Ход смены ключа семьи, или `null`, когда её никто не начинал в этой сессии. */
  readonly rotation: RotationState | null;
  /**
   * Отказ приёма новой эпохи — 5.5 шаг 8: «не сбой синхронизации, а сигнал тревоги».
   *
   * Устройство осталось на прежней эпохе, продолжает работать локально и показывает, что смена
   * ключа не подтверждена. Тихого перехода «потому что сервер так сказал» не существует.
   */
  readonly epochAlarm: string | null;
  readonly busy: boolean;
  readonly message: string | null;
  readonly error: string | null;
  readonly awaitingLoginCode: boolean;
  readonly actions: FamilyActions;
  /**
   * Запись бюджета через журнал семьи, или `null`, когда журнала нет.
   *
   * Это единственный путь, которым изменение бюджета попадает в очередь операций. Он отвечает
   * `null` раньше любого чтения хранилища, если нет адреса сервера или сессии, — и именно это, а
   * не дисциплина вызывающего, держит обещание «без входа ничего не меняется».
   */
  readonly writeBudget: BudgetJournalWrite;
}

export interface SyncStateStore {
  readSyncState<V = unknown>(key: string): Promise<V | undefined>;
  writeSyncState(entries: readonly { readonly key: string; readonly value: unknown }[]): Promise<void>;
  clearSyncData(): Promise<void>;
  countOutbox(): Promise<number>;
  loadVersioned(): Promise<{ readonly value: unknown; readonly revision: string } | null>;
  /** Очередь этого устройства — 5.5 шаг 2 переносит её вместе с журналом. */
  listOutbox(limit?: number): Promise<readonly { readonly opId: string; readonly envelope: unknown }[]>;
  /** Снимает с очереди ровно те записи, которым сервер выдал `seq`. */
  confirmOutbox(opIds: readonly string[]): Promise<number>;
}

/**
 * Транспорт, который на «вход устарел» обновляет токен и повторяет запрос — один раз.
 *
 * Доступ живёт пятнадцать минут (6.1), а обновление у клиента было и не вызывалось ниоткуда: через
 * пятнадцать минут работы синхронизация останавливалась с надписью «вход устарел» при полностью
 * действующей сессии. Повтор ровно один: если и он получил отказ, отказ настоящий и его показывают.
 */
export function transportWithTokenRefresh(
  inner: SyncTransport,
  refreshAccess: () => Promise<boolean>,
): SyncTransport {
  const once = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (failure) {
      if (!(failure instanceof SyncServerError) || failure.serverCode !== "unauthorized") throw failure;
      if (!(await refreshAccess())) throw failure;
      return call();
    }
  };
  return {
    submit: (familyId, envelopes) => once(() => inner.submit(familyId, envelopes)),
    fetch: (familyId, query) => once(() => inner.fetch(familyId, query)),
    keys: (familyId) => once(() => inner.keys(familyId)),
  };
}

/**
 * `fromBase64` answers `null` on anything malformed, because every caller of it parses untrusted
 * input. Here the input is untrusted too — a device's SPKI comes from the server, and the stored
 * one comes off disk — so the refusal is turned into one this feature's `run()` already renders.
 */
function decodeBase64(text: string, label: string): Uint8Array {
  const bytes = fromBase64(text);
  if (bytes === null) throw new Error(`${label} is not base64`);
  return bytes;
}

/* ───────────────────────────── Опрос, который спит вместе со вкладкой ───────────────────────────── */

export interface VisibilityAwarePoll {
  readonly intervalMs: number;
  /** Один круг опроса. Вызывается только тогда, когда документ видим. */
  readonly run: () => void;
  readonly isHidden: () => boolean;
  readonly setInterval: (callback: () => void, ms: number) => number;
  readonly clearInterval: (handle: number) => void;
  /** Подписка на смену видимости. Возвращает отписку. */
  readonly onVisibilityChange: (listener: () => void) => () => void;
}

/**
 * Опрос идёт, пока вкладку видно, и не идёт, пока не видно.
 *
 * Фоновая вкладка, опрашивающая сервер каждые пятнадцать секунд, тратит не своё: на телефоне это
 * радио, которое будит устройство, и заряд, который человек тратит на экран, которого не видит.
 * Ничего не теряется — журнал накопительный, курсор сохранён на диске, и один круг при возвращении
 * догоняет всё пропущенное разом.
 *
 * Круг при возвращении делается сразу, а не через интервал: человек, вернувшийся во вкладку,
 * смотрит на цифры прямо сейчас, и показывать ему пятнадцать секунд заведомо устаревшее значение
 * было бы хуже, чем не опрашивать вовсе. Скрытый старт круга не делает — иначе «не будить фоновую
 * вкладку» нарушалось бы ровно в тот момент, когда приложение восстановили в фоне.
 */
export function startVisibilityAwarePolling(poll: VisibilityAwarePoll): () => void {
  let timer: number | null = null;

  const stop = () => {
    if (timer === null) return;
    poll.clearInterval(timer);
    timer = null;
  };

  const start = () => {
    if (timer !== null) return;
    poll.run();
    timer = poll.setInterval(() => poll.run(), poll.intervalMs);
  };

  const unsubscribe = poll.onVisibilityChange(() => {
    if (poll.isHidden()) stop();
    else start();
  });

  if (!poll.isHidden()) start();

  return () => {
    unsubscribe();
    stop();
  };
}

/** Ровно та часть движка, которую делает круг. Тест подставляет сюда объект в несколько строк. */
export interface SyncRoundEngine {
  settleDocument(): Promise<boolean>;
  sync(): Promise<{ readonly pull: { readonly applied: number; readonly settled?: boolean } }>;
}

export interface SyncRoundResult {
  readonly applied: number;
  /**
   * Документ переписан из журнала без новых операций — задержка снята сборкой, которая открывает
   * состояние (`PullResult.settled`). Экрану есть что показать, хотя `applied` — ноль.
   */
  readonly settled: boolean;
  readonly outcome: SyncRoundOutcome;
}

/**
 * Один круг синхронизации — и его исход, который никуда не пропадает.
 *
 * Здесь была пустая `catch`, а рядом обещание, что «отчёт ниже это покажет». Отчёт этого показать
 * не мог: он собирается из курсора, очереди и записи об остановке, а все три пишутся только после
 * ответа сервера. Круг, не дошедший до сервера, не менял ничего — и индикатор оставался зелёным
 * при лежащем сервере, умершем токене обновления и отозванном устройстве.
 *
 * Поэтому исход возвращается значением, а не проглатывается: `unreachable` — до сервера не дошли,
 * `refused` — сервер ответил и отказал. Приложение при любом из них остаётся полностью рабочим;
 * молчит оно теперь только тогда, когда молчать не о чем.
 */
export async function runSyncRound(engine: SyncRoundEngine): Promise<SyncRoundResult> {
  // Документ снимается с задержки отдельным шагом, до сети и до всего, что в ней может упасть, —
  // и его исход переживает сбой круга: сборка, обновлённая офлайн, сняла задержку на диске, и
  // экран обязан это показать, хотя до сервера круг не дошёл (третье ревью, S5). Единственный
  // путь, которым круг узнаёт о снятой задержке; `sync()` спрашивает ещё раз и отвечает «нет».
  let settled = false;
  try {
    settled = await engine.settleDocument();
    const result = await engine.sync();
    return { applied: result.pull.applied, settled: settled || (result.pull.settled ?? false), outcome: "ok" };
  } catch (failure) {
    return { applied: 0, settled, outcome: classifySyncFailure(failure) };
  }
}

/** Всё, что круг опроса берёт у хука, — без React: тест подставляет сюда свои функции. */
export interface FamilyPollRound<E extends SyncRoundEngine> {
  /** Движок семьи, собранный заново, или `null`, когда журнала нет. */
  readonly engineFor: () => Promise<E | null>;
  /** Приём новой эпохи по 5.4.1 после отказа сервера; `true` — ключ сменился. */
  readonly acceptIncomingEpoch: () => Promise<boolean>;
  /**
   * Эффект, начавший круг, уже снят: сменилась семья или устройство, действие на экране «Семья»
   * начало цикл опроса заново (`reload`), или хук размонтирован. Тогда круг не пишет ни исхода, ни
   * отчёта — они принадлежат новому циклу.
   */
  readonly cancelled: () => boolean;
  readonly setSyncRound: (outcome: SyncRoundOutcome) => void;
  /**
   * Отчёт движка — на экран, и участник этого устройства — в документ семьи, если его там нет.
   * Идёт после {@link showStored}: запись участника строится из показанного бюджета.
   */
  readonly refreshSyncState: (engine: E) => Promise<void>;
  /**
   * Экран догоняет то, что лежит на диске: документ, если показана другая ревизия
   * (`createAppBudgetSaveCoordinator().catchUp` в оболочке), и журнал при нём — целостность и
   * авторы операций. Ничего не пишет. `complete` — круг дошёл до отчёта, и журнал перечитывается
   * всегда; снятый или упавший круг перечитывает его, только если показал новый документ.
   */
  readonly showStored: (complete: boolean) => Promise<unknown>;
}

/**
 * Один круг опроса семьи — и после него, всегда, сверка экрана с тем, что лежит на диске.
 *
 * Прежде экран узнавал о чужой операции только от того круга, который её применил, — по
 * `applied > 0` его же результата, — и только если этот круг доживал до конца: снятый круг
 * уходил молча. А снимался он тогда на каждом старте: список устройств и пины приходили, пока
 * первый круг ждал ответа, и цикл опроса начинался заново (теперь их читают по ссылке, и цикл
 * снимают только смена семьи, `reload` и размонтирование). Приём тем временем уже записал конверт
 * в документ одной транзакцией с курсором, курсор ушёл за конверт, следующий круг ничего нового не
 * находил — и экран до перезапуска показывал бюджет без чужой покупки, со «синхронизировано» в
 * шапке и без семейной новости (прогон проверки 2b). То же — с конвертом, который применила
 * другая вкладка.
 *
 * Поэтому показ больше не ждёт сообщения: после каждого круга — удачного, неудачного, снятого —
 * экран сверяется с документом по ревизии и перечитывает журнал при нём. Сообщение можно потерять;
 * ревизию на диске — нет.
 */
export async function pollFamilyRound<E extends SyncRoundEngine>(poll: FamilyPollRound<E>): Promise<void> {
  let shown = false;
  const show = async (complete: boolean) => {
    shown = true;
    await poll.showStored(complete).catch(() => undefined);
  };
  try {
    const engine = await poll.engineFor();
    if (engine === null || poll.cancelled()) return;
    let result = await runSyncRound(engine);
    // Снятый круг не пишет ни исхода, ни отчёта: они принадлежат циклу, который его сменил.
    if (poll.cancelled()) return;
    if (result.outcome === "refused") {
      // Сервер отказал — и один из отказов, `409 epoch_mismatch`, лечится не повтором, а приёмом
      // новой эпохи по 5.4.1. Попытка идёт на любой отказ: она стоит одного запроса и ничего не
      // решает сама — решает цепочка подтверждений.
      const moved = await poll.acceptIncomingEpoch().catch(() => false);
      if (poll.cancelled()) return;
      if (moved) {
        const next = await poll.engineFor();
        if (next !== null && !poll.cancelled()) {
          result = await runSyncRound(next);
          if (poll.cancelled()) return;
          poll.setSyncRound(result.outcome);
          await show(true);
          await poll.refreshSyncState(next);
          return;
        }
      }
    }
    // Исход круга — состояние, а не пустое место: без него шапка говорила бы «синхронизировано»
    // при лежащем сервере, умершем токене и отозванном устройстве, потому что отчёт собирается из
    // записей, которых неудавшийся круг не делает.
    poll.setSyncRound(result.outcome);
    // Экран — до отчёта: отчёт вписывает участника этого устройства в документ семьи записью,
    // которая строится из показанного бюджета, и бюджет, отставший от диска, дал бы ей конфликт.
    await show(true);
    await poll.refreshSyncState(engine);
  } finally {
    // И снятый круг тоже: документ на диске — устройства, а не сессии, и то, что круг в него
    // записал, экран обязан показать, кто бы ни писал отчёт.
    if (!shown) await show(false);
  }
}

/**
 * Участник этого устройства, которого ещё нет в документе семьи, — или `null`, когда вписывать
 * некого или некуда.
 *
 * Вступившее устройство записывало своего участника в момент вступления, и запись шла в бюджет,
 * который был у него до вступления: бюджет семьи приходил позже и заменял его, а участник
 * пропадал — у семьи его имени не было никогда (третье ревью, S4). Участник вписывается, когда
 * у устройства впервые есть документ семьи и писать в него можно: без задержки, с сессией семьи.
 * Проверка — по документу, поэтому повтор ничего не меняет, а сбой записи повторится сам на
 * следующем круге.
 */
export function missingLocalMember(
  document: Pick<BudgetState, "members"> | null,
  report: Pick<SyncStatusReport, "hold" | "familyDocument"> | null,
  session: Pick<FamilySession, "email" | "familyId" | "memberId" | "role"> | null,
): LocalMember | null {
  if (document === null || report === null || !report.familyDocument || report.hold !== null) return null;
  if (session === null || session.familyId === null || session.memberId === null) return null;
  const memberId = session.memberId;
  if ((document.members ?? []).some((member) => member.id === memberId)) return null;
  return { id: memberId, name: memberNameFromEmail(session.email), role: session.role === "owner" ? "owner" : "member", active: true };
}

/**
 * Reads the pin table, tolerating anything that is not one.
 *
 * The pins are the whole of 5.4.1's local state. A record that has been corrupted must read as
 * "no pins" rather than as "some pins": a half-parsed table would silently downgrade a device from
 * «сверка сравнивает пин с реальностью» to «сравнение двух копий серверного значения», which is the
 * one substitution the section exists to refuse.
 */
export function parsePins(value: unknown): ReadonlyMap<string, Uint8Array> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return new Map();
  const pins = new Map<string, Uint8Array>();
  for (const [deviceId, hex] of Object.entries(value as Record<string, unknown>)) {
    if (typeof hex !== "string" || !/^[0-9a-f]{64}$/u.test(hex)) continue;
    pins.set(deviceId, fromHex(hex));
  }
  return pins;
}

export function serializePins(pins: ReadonlyMap<string, Uint8Array>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [deviceId, fingerprint] of pins) record[deviceId] = toHex(fingerprint);
  return record;
}

/**
 * Что показывает экран, пока идёт смена ключа, и чем она кончилась.
 *
 * Ротация — длинная операция с состоянием, а не мгновенная кнопка: перенос журнала при квоте в
 * `100 000` конвертов — это сотни запросов по мобильной сети (5.5). Поэтому у неё есть видимые
 * фазы, видимая остановка на неполном журнале, требующая решения человека, и видимый итог, в
 * котором перечислено, какие устройства остались без ключа и почему (5.4.1).
 */
export type RotationState =
  | { readonly kind: "running"; readonly progress: RotationProgress }
  | {
      readonly kind: "halted";
      readonly gap: RotationGap;
      readonly keyEpoch: number;
      readonly freezeSeq: number;
    }
  | {
      readonly kind: "done";
      readonly keyEpoch: number;
      readonly previousKeyEpoch: number;
      readonly moved: number;
      readonly wrapped: readonly string[];
      readonly skipped: readonly SkippedDevice[];
      readonly inheritedGaps: readonly number[];
    }
  | { readonly kind: "failed"; readonly message: string };

export interface JoinByCodeDeps {
  readonly api: Pick<FamilyApi, "claimInvite" | "joinInvite" | "members" | "leaveFamily">;
  readonly store: SyncStateStore;
  /** This device's identifier, as the server registered it. Enters `bindProof` (5.4). */
  readonly deviceId: string;
  /** The `memberId` this device chooses for itself (6.4). */
  readonly memberId: string;
  /** The pin table as it stands. The invite adds the owner's pin to it and changes nothing else. */
  readonly pins: ReadonlyMap<string, Uint8Array>;
}

export interface JoinByCodeResult {
  readonly familyId: string;
  readonly memberId: string;
  readonly keyEpoch: number;
  readonly pins: ReadonlyMap<string, Uint8Array>;
}

/**
 * Вступление по коду — 5.3, 5.4 и 6.4, целиком, включая **обе** независимые проверки.
 *
 * Вынесено из хука не ради стройности, а ради проверяемости: находка была именно «вызова нет», и
 * утверждение «вызов есть» имеет смысл только тогда, когда его можно предъявить исполнением, а не
 * поиском строки по файлу. Здесь всё, что происходит между набранным кодом и записью ключа на
 * диск, — и подставной сервер в тесте отвечает на это ровно так же, как настоящий.
 *
 * Порядок проверок:
 *
 *  1. `openInvite` вскрывает посылку и **сам** отвергает роль `senderRole ≠ owner` внутри неё.
 *     Это первая из двух проверок 5.3 и в одиночку она не значит ничего: роль в посылке пишет
 *     тот, кто посылку собрал;
 *  2. серверный список участников подтверждает `senderMemberId` ролью `owner`. Пакет прямо
 *     передал эту проверку вызывающему (`invite.ts`), и до сих пор её никто не подбирал.
 *
 * Список выдаётся только участнику, поэтому прочитать его раньше вступления нельзя, и порядок
 * здесь вынужденный, а не выбранный. Оберегается им то, ради чего он и нужен: **ключ семьи и пин
 * владельца записываются только после согласия двух источников**, а при расхождении вступление
 * отменяется обратным вызовом `leaveFamily`, и на устройстве не остаётся ни ключа, ни пина, ни
 * признака происхождения журнала.
 */
export async function joinFamilyByCode(
  rawCode: string,
  deps: JoinByCodeDeps,
): Promise<JoinByCodeResult> {
  const code = normalizeInviteCode(rawCode);
  const secrets = await deriveInviteSecrets(code);
  const authToken = toBase64(secrets.authToken);
  const claimed = await deps.api.claimInvite(authToken);
  const opened = await openInvite({
    code,
    familyId: claimed.familyId,
    keyEpoch: claimed.keyEpoch,
    inviteId: claimed.inviteId,
    iv: decodeBase64(claimed.iv, "invite iv"),
    ciphertext: decodeBase64(claimed.inviteBox, "invite box"),
  });
  const deviceKey = await deps.store.readSyncState<StoredDeviceKey>(DEVICE_KEY_STATE_KEY);
  if (deviceKey === undefined) throw new Error("no device key on this device");
  const spki = decodeBase64(deviceKey.spki, "device key");
  const bindProof = await computeBindProof(opened.bindKey, {
    familyId: claimed.familyId,
    inviteId: claimed.inviteId,
    deviceId: deps.deviceId,
    spki,
  });
  await deps.api.joinInvite({
    inviteId: claimed.inviteId,
    authToken,
    memberId: deps.memberId,
    bindProof: toBase64(bindProof),
  });

  // 5.3, вторая из двух: «вступающее устройство берёт `memberIdA` из посылки и сверяет его с ролью
  // в серверном списке участников. Совпали — принимаем; разошлись — отказ. Ни один источник по
  // отдельности доверия не заслуживает.»
  const roster = await deps.api.members(claimed.familyId);
  const inviter = roster.find((entry) => entry.memberId === opened.senderMemberId);
  if (inviter === undefined || inviter.role !== "owner" || inviter.removedAt !== null) {
    // Ничего локального ещё не записано, и записано не будет. Вступление на сервере откатывается;
    // неудача отката ничего не меняет в том, что ключ этой семьи на устройстве не появился.
    await deps.api.leaveFamily(claimed.familyId).catch(() => undefined);
    throw new FamilyRefusal(
      "Код выпущен не владельцем семьи: список участников на сервере не подтверждает его роль. Ключ семьи не развёрнут, вступление отменено.",
    );
  }

  // 5.4, первая строка таблицы: отпечаток отправителя приехал внутри посылки под `KEK`, поэтому
  // он закрепляется здесь без отдельной церемонии — церемонией был сам код, и значение никогда не
  // приходило от сервера.
  const nextPins = new Map(deps.pins);
  nextPins.set(opened.senderDeviceId, opened.senderKeyFingerprint);
  await deps.store.writeSyncState([
    {
      key: FAMILY_KEY_STATE_KEY,
      value: { key: opened.familyKey, keyEpoch: claimed.keyEpoch } satisfies StoredFamilyKey,
    },
    { key: PINS_STATE_KEY, value: serializePins(nextPins) },
    // Бюджет придёт журналом. Посева здесь нет и быть не может: он влил бы личный бюджет
    // вступающего в семейный, и семья увидела бы чужие счета как свои.
    { key: JOURNAL_ORIGIN_KEY, value: "family" satisfies JournalOrigin },
  ]);

  return {
    familyId: claimed.familyId,
    memberId: deps.memberId,
    keyEpoch: claimed.keyEpoch,
    pins: nextPins,
  };
}

export function useFamily(
  repository: Repository,
  serverUrl: string | null,
  options: FamilyControllerOptions = {},
): FamilyController {
  const store = repository as unknown as SyncStateStore;
  const [session, setSession] = useState<FamilySession | null>(null);
  const [membership, setMembership] = useState<MembershipSnapshot | null>(null);
  const [members, setMembers] = useState<readonly MemberRecord[]>([]);
  const [devices, setDevices] = useState<readonly DeviceRecord[]>([]);
  const [ownFingerprint, setOwnFingerprint] = useState<Uint8Array | null>(null);
  const [pins, setPins] = useState<ReadonlyMap<string, Uint8Array>>(new Map());
  const [bindVerdicts, setBindVerdicts] = useState<ReadonlyMap<string, BindVerdict>>(new Map());
  const [rotation, setRotation] = useState<RotationState | null>(null);
  /** Отказ цепочки подтверждений: устройство осталось на прежней эпохе и говорит об этом. */
  const [epochAlarm, setEpochAlarm] = useState<string | null>(null);
  const [offered, setOffered] = useState<ReadonlyMap<string, Uint8Array>>(new Map());
  const [invite, setInvite] = useState<ActiveInvite | null>(null);
  const [status, setStatus] = useState<SyncStatusReport | null>(null);
  const [syncRound, setSyncRound] = useState<SyncRoundOutcome>("ok");
  const [integrity, setIntegrity] = useState<JournalIntegrity | null>(null);
  const [transactionAuthors, setTransactionAuthors] = useState<ReadonlyMap<string, TransactionAuthor>>(new Map());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const sessionRef = useRef<FamilySession | null>(null);
  sessionRef.current = session;
  // Held in a ref so that the actions below do not change identity every render because of it.
  const registerLocalMemberRef = useRef(options.registerLocalMember);
  /** `${familyId}:${memberId}` участника, которого круг уже нашёл в документе семьи. */
  const memberPresentRef = useRef<string | null>(null);
  registerLocalMemberRef.current = options.registerLocalMember;
  const showStoredBudgetRef = useRef(options.showStoredBudget);
  showStoredBudgetRef.current = options.showStoredBudget;
  const apiRef = useRef<FamilyApi | null>(null);
  /** Одно обновление на все запросы сразу: refresh-токен поворачивается, и второй с тем же не пройдёт. */
  const refreshingRef = useRef<Promise<boolean> | null>(null);
  /**
   * Пины и список устройств для приёма новой эпохи — в ссылках, а не в зависимостях.
   *
   * В зависимостях `acceptIncomingEpoch` они перезапускали цикл опроса на каждое своё прибытие: на
   * старте и после каждого обновления токена, которое перечитывает список семьи. Новый цикл сразу
   * начинал круг на том же курсоре, пока прежний ещё ждал ответа. Приём читает их в момент вызова —
   * последние пины и последний список, как и прежде: круг, при котором они сменились, до приёма не
   * доходил.
   */
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  const registerLocalMember = useCallback(async (member: LocalMember) => {
    try {
      await registerLocalMemberRef.current?.(member);
    } catch {
      // Не смертельно: участник в семье уже создан, а имя — украшение локального бюджета.
    }
  }, []);

  /**
   * Обновление доступа по отказу, ровно одно на все ждущие запросы.
   *
   * Сервер поворачивает refresh-токен на каждом использовании (6.1), поэтому два одновременных
   * обновления — это второе с уже потраченным токеном и выход из учётной записи на ровном месте.
   * Новая сессия кладётся в `sessionRef` до записи на диск: повтор запроса должен уйти с новым
   * токеном, даже если запись в IndexedDB ещё идёт.
   */
  const refreshAccess = useCallback(async (): Promise<boolean> => {
    const running = refreshingRef.current;
    if (running !== null) return running;
    const attempt = (async () => {
      const api = apiRef.current;
      const current = sessionRef.current;
      if (api === null || current === null) return false;
      try {
        const tokens = await api.refresh(current.refreshToken);
        const next: FamilySession = {
          ...current,
          accountId: tokens.accountId,
          deviceId: tokens.deviceId,
          accessToken: tokens.accessToken,
          accessExpiresAt: tokens.accessExpiresAt,
          refreshToken: tokens.refreshToken,
        };
        sessionRef.current = next;
        await persistSession(store, next);
        setSession(next);
        return true;
      } catch {
        return false;
      }
    })();
    refreshingRef.current = attempt;
    try {
      return await attempt;
    } finally {
      refreshingRef.current = null;
    }
  }, [store]);

  const api: FamilyApi | null = useMemo(
    () =>
      serverUrl === null
        ? null
        : createFamilyApi({
            baseUrl: serverUrl,
            accessToken: () => sessionRef.current?.accessToken ?? null,
            refreshAccess,
          }),
    [refreshAccess, serverUrl],
  );
  apiRef.current = api;

  /**
   * Движок семьи, собранный на месте из того, что лежит на диске, — или `null`.
   *
   * Собирается на каждый вызов, а не хранится: ключ семьи, эпоха и сессия меняются вступлением,
   * сменой ключа и выходом, и движок, переживший любое из этих событий, шифровал бы под ключ,
   * которого у семьи уже нет. Первые две проверки — адрес и сессия — стоят до единственного
   * чтения хранилища, поэтому на локальном пути этот вызов не трогает базу вовсе.
   */
  const engineFor = useCallback(async (): Promise<SyncEngine | null> => {
    const current = sessionRef.current;
    if (serverUrl === null || current === null || current.familyId === null) return null;
    const stored = await store.readSyncState<StoredFamilyKey>(FAMILY_KEY_STATE_KEY).catch(() => undefined);
    if (stored === undefined) return null;
    // Пропуски прошлой эпохи едут в первый чекпойнт этой (5.5 шаг 2). Читаются по номеру эпохи:
    // запись, оставшаяся от позапрошлой ротации, к этой не относится и молча не переезжает.
    const gaps = inheritedGapsFor(
      await store.readSyncState(INHERITED_GAPS_STATE_KEY).catch(() => undefined),
      stored.keyEpoch,
    );
    // Ключ покинутой эпохи — только для собственной очереди (5.5 шаг 8). Чужой конверт им не
    // открывают никогда: конверт ушедшей эпохи, пришедший от сервера, — это тревога 3.4.
    const retired = await store
      .readSyncState<StoredFamilyKey>(RETIRED_KEY_STATE_KEY)
      .catch(() => undefined);
    const origin = await store.readSyncState<JournalOrigin>(JOURNAL_ORIGIN_KEY).catch(() => undefined);
    return new SyncEngine({
      repository: repository as never,
      transport: transportWithTokenRefresh(
        createHttpTransport({
          baseUrl: serverUrl,
          accessToken: () => sessionRef.current?.accessToken ?? "",
        }),
        refreshAccess,
      ),
      familyId: current.familyId,
      deviceId: current.deviceId,
      familyKey: stored.key,
      keyEpoch: stored.keyEpoch,
      keyDigest: toHex(await familyKeyFingerprint(stored.key)),
      inheritedGaps: gaps,
      retiredKeys:
        retired === undefined || retired.keyEpoch >= stored.keyEpoch
          ? []
          : [{ keyEpoch: retired.keyEpoch, key: retired.key }],
      // Шлюз документа — тот же, через который приложение читает и пишет бюджет. Состояние журнала,
      // которое он не принял бы, в документ не попадает: иначе каждое открытие и каждая запись
      // падали бы на нём на всех устройствах семьи.
      acceptsState: acceptsJournalState,
      // Бюджет устройства, создавшего семью, — бюджет семьи с первой записи (посев). Бюджет
      // вступившего становится семейным, только когда движок запишет в документ принятое
      // состояние журнала; до тех пор он не показывается и не пишется как семейный.
      foundedDocument: origin === "local",
    });
  }, [refreshAccess, repository, serverUrl, store]);

  /* ── Старт: одно чтение, и только чтение. Схему оно не поднимает. ── */
  useEffect(() => {
    if (serverUrl === null) return;
    let cancelled = false;
    void (async () => {
      const stored = await loadSession(store).catch(() => null);
      if (cancelled) return;
      setSession(stored);
      if (stored === null) return;
      const pinRecord = await store.readSyncState(PINS_STATE_KEY).catch(() => undefined);
      if (!cancelled) setPins(parsePins(pinRecord));
      const bindRecord = await store.readSyncState(BIND_STATE_KEY).catch(() => undefined);
      if (!cancelled) setBindVerdicts(parseBindVerdicts(bindRecord));
      const deviceKey = (await store.readSyncState<StoredDeviceKey>(DEVICE_KEY_STATE_KEY).catch(() => undefined));
      if (!cancelled && deviceKey !== undefined) {
        const spki = decodeBase64(deviceKey.spki, "device key");
        setOwnFingerprint(await deviceKeyFingerprint(spki));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverUrl, store, reload]);

  /**
   * Сообщает экрану, что очередь и отчёт движка изменились.
   *
   * Читается настоящее состояние движка, а не догадка: отчёт берётся из `status()`. Документ и
   * журнал при нём сюда не входят: их экран догоняет сам, после каждого круга и до этого отчёта
   * (`showStored`), — участник ниже вписывается записью, которая строится из показанного бюджета.
   */
  const refreshSyncState = useCallback(
    async (engine: SyncEngine): Promise<void> => {
      let report: SyncStatusReport | null = null;
      try {
        report = await engine.status();
        setStatus(report);
        // Высокая вода поднимается здесь и только здесь: это собственная величина устройства, и
        // 5.5 шаг 2 меряет ею границу переноса, которую называет сервер.
        const stored = await store.readSyncState(HIGH_WATER_STATE_KEY).catch(() => undefined);
        const raised = nextHighWater(stored, report);
        if (highWaterFor(stored, raised.keyEpoch) !== raised.seq) {
          await store.writeSyncState([{ key: HIGH_WATER_STATE_KEY, value: raised }]);
        }
        // 5.4.1: ключ покинутой эпохи стирается только после доказательства живости новой — то
        // есть после того, как сервер принял в ней собственный конверт этого устройства и вернул
        // `seq`. Очередь при этом должна быть пуста: пока в ней что-то лежит, старый ключ — это
        // то, чем оно перешифровывается (5.5 шаг 8).
        if (report.epoch.live && report.queued === 0) {
          const retired = await store
            .readSyncState<StoredFamilyKey>(RETIRED_KEY_STATE_KEY)
            .catch(() => undefined);
          if (retired !== undefined && retired !== null && retired.keyEpoch < report.epoch.keyEpoch) {
            await store.writeSyncState([{ key: RETIRED_KEY_STATE_KEY, value: null }]);
          }
        }
      } catch {
        setStatus(null);
      }
      // Участник этого устройства вписывается в документ семьи, как только он есть и писать в него
      // можно (`missingLocalMember`). Документ читается для этого, пока участник не найден в нём
      // хотя бы раз для этой семьи; дальше круг его не перечитывает.
      const current = sessionRef.current;
      const memberKey = current?.familyId != null && current.memberId != null ? `${current.familyId}:${current.memberId}` : null;
      const checkMember = memberKey !== null && memberPresentRef.current !== memberKey && report !== null && report.familyDocument && report.hold === null;
      if (!checkMember) return;
      try {
        const document = await store.loadVersioned();
        if (document !== null) {
          const member = missingLocalMember(document.value as BudgetState, report, current);
          if (member === null) memberPresentRef.current = memberKey;
          else await registerLocalMember(member);
        }
      } catch {
        // Документ не прочитался — экран остаётся на том состоянии, которое уже показывает.
      }
    },
    [registerLocalMember, store],
  );

  /**
   * Экран догоняет то, что лежит на диске: документ — и журнал при нём, целостность и авторы
   * операций. После каждого круга — удачного, неудачного, снятого (`pollFamilyRound`) — и после
   * каждой отправки.
   *
   * Документ и журнал приём пишет одной транзакцией, и показываются они вместе: семейная новость —
   * это операция бюджета и её автор из журнала, и бюджет, показанный без журнала при нём, — это
   * чужая покупка без новости о ней. Журнал читается после документа, поэтому авторы на экране не
   * старше показанного бюджета.
   *
   * `familyId` — семья, ради которой шёл круг. Снятый сменой семьи или выходом круг документ
   * показывает (документ — устройства, а не сессии), а журнала ушедшей семьи на экран не кладёт.
   * `always` — перечитать журнал, даже если документ на экране уже тот же: так делает каждый
   * круг, дошедший до отчёта. Снятый круг перечитывает журнал, только если показал новый документ, —
   * полный проход по журналу на каждый перезапуск цикла был бы платой за то, что и так покажет
   * следующий круг.
   */
  const showStored = useCallback(
    async (familyId: string | null, always: boolean): Promise<void> => {
      const adopted = (await showStoredBudgetRef.current?.()) === true;
      if (!always && !adopted) return;
      if ((sessionRef.current?.familyId ?? null) !== familyId) return;
      try {
        const journal = await store.readSyncState(SYNC_STATE_KEYS.journal);
        if (journal === undefined) {
          setIntegrity(null);
          setTransactionAuthors(new Map());
        } else {
          const snapshot = restoreJournal(journal);
          setIntegrity(snapshot.integrity);
          // Авторы — из того же снимка: заголовки выигравших операций, по одной на сущность.
          setTransactionAuthors(authorsOfTransactions(snapshot.entries));
        }
      } catch {
        setIntegrity(null);
        setTransactionAuthors(new Map());
      }
    },
    [store],
  );

  /**
   * Приём новой эпохи на устройстве, которое ротацию не вело — 5.4.1, первый из двух путей.
   *
   * Вызывается после круга, который сервер отклонил: `409 epoch_mismatch` приходит и на отправке, и
   * на выборке (3.4), и без этого шага любая ротация превращала бы каждое второе устройство семьи
   * в вечное «ошибка синхронизации». Успех — не «сервер сказал сменить ключ», а «цепочка
   * подтверждений сошлась на ключе, который у этого устройства уже был».
   */
  const acceptIncomingEpoch = useCallback(async (): Promise<boolean> => {
    const current = sessionRef.current;
    if (serverUrl === null || current === null || current.familyId === null) return false;
    const stored = await store.readSyncState<StoredFamilyKey>(FAMILY_KEY_STATE_KEY);
    const deviceKey = await store.readSyncState<StoredDeviceKey>(DEVICE_KEY_STATE_KEY);
    if (stored === undefined || deviceKey === undefined) return false;
    const epochRecord = await store.readSyncState<{ readonly keyEpoch?: unknown; readonly live?: unknown }>(
      SYNC_STATE_KEYS.epoch,
    );
    const live =
      typeof epochRecord === "object" &&
      epochRecord !== null &&
      epochRecord.keyEpoch === stored.keyEpoch &&
      epochRecord.live === true;
    const outcome = await takeIncomingEpoch({
      transport: transportWithTokenRefresh(
        createHttpTransport({
          baseUrl: serverUrl,
          accessToken: () => sessionRef.current?.accessToken ?? "",
        }),
        refreshAccess,
      ),
      familyId: current.familyId,
      deviceId: current.deviceId,
      deviceSpki: decodeBase64(deviceKey.spki, "device key"),
      devicePrivateKey: deviceKey.keyPair.privateKey,
      familyKey: stored.key,
      keyEpoch: stored.keyEpoch,
      live,
      pins: pinsRef.current,
      devices: devicesRef.current,
    });
    if (outcome.kind === "refused") {
      // 5.5 шаг 8, последний абзац: «Отказ на шаге 8 — не сбой синхронизации, а сигнал тревоги.»
      // Устройство остаётся на прежней эпохе, продолжает работать локально и говорит об этом.
      setEpochAlarm(EPOCH_REFUSAL_TEXT[outcome.reason]);
      return false;
    }
    if (outcome.kind === "unchanged") return false;
    setEpochAlarm(null);
    // Старый ключ не стирается, а откладывается: пока новая эпоха не доказана живой, он —
    // единственная дорога назад, и он же переносит очередь под новый ключ (5.5 шаг 8).
    await store.writeSyncState([
      {
        key: RETIRED_KEY_STATE_KEY,
        value: { key: stored.key, keyEpoch: stored.keyEpoch } satisfies StoredFamilyKey,
      },
      {
        key: FAMILY_KEY_STATE_KEY,
        value: { key: outcome.key, keyEpoch: outcome.keyEpoch } satisfies StoredFamilyKey,
      },
    ]);
    return true;
  }, [refreshAccess, serverUrl, store]);

  const writeBudget = useMemo(
    () =>
      createBudgetJournalWriter({
        engineFor,
        store,
        memberId: () => sessionRef.current?.memberId ?? undefined,
        saveIfRevision: (revision, value) =>
          (repository as unknown as {
            saveIfRevision(
              expectedRevision: string | null,
              state: unknown,
            ): Promise<JournalWriteOutcome>;
          }).saveIfRevision(revision, value),
        afterWrite: (engine) => {
          // Отправка — отдельно от записи: очередь уже переживёт перезапуск, а сеть может лежать.
          void (async () => {
            // Офлайн — не ошибка сценария, но и не «синхронизировано»: исход круга запоминается
            // здесь тем же способом, что и в опросе, и индикатор показывает именно его.
            // Семья запоминается до сети: вышедшему за время круга журнал ушедшей семьи не показывается.
            const familyId = sessionRef.current?.familyId ?? null;
            setSyncRound((await runSyncRound(engine)).outcome);
            await showStored(familyId, true);
            await refreshSyncState(engine);
          })();
        },
      }),
    [engineFor, refreshSyncState, repository, showStored, store],
  );


/* ── Состояние синхронизации и приём чужих операций. Ни того, ни другого без входа. ── */
  useEffect(() => {
    if (!isSyncActive(serverUrl, session) || session?.familyId == null || api === null) {
      setStatus(null);
      setIntegrity(null);
      setTransactionAuthors(new Map());
      setSyncRound("ok");
      return;
    }
    let cancelled = false;
    let running = false;
    const familyId = session.familyId;
    const round = async () => {
      if (running || cancelled) return;
      running = true;
      try {
        await pollFamilyRound({
          engineFor,
          acceptIncomingEpoch,
          cancelled: () => cancelled,
          setSyncRound,
          refreshSyncState,
          showStored: (complete) => showStored(familyId, complete),
        });
      } finally {
        running = false;
      }
    };
    const stopPolling = startVisibilityAwarePolling({
      intervalMs: SYNC_INTERVAL_MS,
      run: () => void round(),
      isHidden: () => document.visibilityState === "hidden",
      setInterval: (callback, ms) => window.setInterval(callback, ms),
      clearInterval: (handle) => window.clearInterval(handle),
      onVisibilityChange: (listener) => {
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
    });
    return () => {
      cancelled = true;
      stopPolling();
    };
    // `session` целиком в зависимостях был бы перезапуском цикла на каждое обновление токена.
  }, [
    acceptIncomingEpoch,
    api,
    engineFor,
    refreshSyncState,
    serverUrl,
    session?.familyId,
    session?.deviceId,
    showStored,
    reload,
  ]);

  /* ── Список семьи. Ни одного запроса без сессии. ── */
  // Обновление токена — новая сессия, и список перечитывается: кроме действий на экране «Семья»,
  // ничто другое список устройств не обновляет, а по нему приём эпохи ищет ключ отправителя. Цикл
  // опроса это не трогает — устройства он читает по ссылке.
  useEffect(() => {
    if (api === null || session === null) {
      setMembership(null);
      setMembers([]);
      setDevices([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await api.membership();
        if (cancelled) return;
        setMembership(snapshot);
        if (snapshot === null) {
          setMembers([]);
          setDevices([]);
          return;
        }
        const [memberList, deviceList] = await Promise.all([
          api.members(snapshot.familyId),
          api.devices(snapshot.familyId),
        ]);
        if (cancelled) return;
        setMembers(memberList);
        setDevices(deviceList);
        const computed = new Map<string, Uint8Array>();
        for (const device of deviceList) {
          try {
            computed.set(device.deviceId, await deviceKeyFingerprint(decodeBase64(device.publicKey, "device key")));
          } catch {
            // A key the server could not spell is simply not offered as a candidate.
          }
        }
        if (!cancelled) setOffered(computed);
        const storedInvite = parseStoredInvite(await store.readSyncState(INVITE_STATE_KEY));
        if (cancelled) return;
        if (storedInvite === null || storedInvite.expiresAt <= Date.now()) {
          // Expiry is the other half of 6.3: `bindKey` «удаляется вместе с приглашением, когда оно
          // использовано и открытый ключ вступившего устройства проверен, либо по истечении TTL».
          // The same write is what erases a record of the previous shape, code and all.
          const raw = storedInvite === null ? await store.readSyncState(INVITE_STATE_KEY) : null;
          if (storedInvite !== null || (raw !== undefined && raw !== null)) {
            await store.writeSyncState([{ key: INVITE_STATE_KEY, value: null }]);
          }
          if (!cancelled) setInvite(null);
          return;
        }
        // The code is not on disk, so a session that did not issue this invite has no code to
        // show — and says so rather than showing nothing. An invite issued in *this* session keeps
        // the code it is already holding in memory.
        setInvite((current) =>
          current !== null && current.expiresAt === storedInvite.expiresAt
            ? current
            : {
                code: null,
                expiresAt: storedInvite.expiresAt,
                supersededCount: storedInvite.supersededCount,
              },
        );
        // 6.4: «Устройство владельца при первом же выходе в сеть забирает данные нового устройства
        // и пересчитывает HMAC» — here, on the round that brought the device list, and therefore
        // before any wrap of a new family key can be made (5.5 step 5 needs the pin this writes).
        const outcome = await checkInviteBinding(storedInvite, deviceList);
        if (cancelled || outcome === null) return;
        const storedVerdicts = parseBindVerdicts(await store.readSyncState(BIND_STATE_KEY));
        const nextVerdicts = new Map(storedVerdicts);
        nextVerdicts.set(outcome.deviceId, outcome.verdict);
        const writes: { readonly key: string; readonly value: unknown }[] = [
          { key: BIND_STATE_KEY, value: serializeBindVerdicts(nextVerdicts) },
          // The verdict is reached, so the key that reached it has no further use. 6.3 removes it
          // «когда оно использовано и открытый ключ вступившего устройства проверен» — and that is
          // true of a proof that disagreed just as much as of one that agreed.
          { key: INVITE_STATE_KEY, value: null },
        ];
        let nextPins: ReadonlyMap<string, Uint8Array> | null = null;
        if (outcome.verdict === "bound" && outcome.fingerprint !== null) {
          const table = parsePins(await store.readSyncState(PINS_STATE_KEY));
          if (!table.has(outcome.deviceId)) {
            const updated = new Map(table);
            updated.set(outcome.deviceId, outcome.fingerprint);
            nextPins = updated;
            writes.push({ key: PINS_STATE_KEY, value: serializePins(updated) });
          }
        }
        await store.writeSyncState(writes);
        if (cancelled) return;
        setBindVerdicts(nextVerdicts);
        if (nextPins !== null) setPins(nextPins);
        setInvite(null);
        setMessage(
          outcome.verdict === "bound"
            ? "Новое устройство привязано: его открытый ключ сошёлся с кодом приглашения. Сверять отпечатки голосом не нужно."
            : "Новое устройство вступило по коду, но его открытый ключ не сошёлся с кодом. Обёртку нового ключа семьи оно не получит; сверьте отпечатки голосом или выпустите код заново.",
        );
      } catch (failure) {
        if (!cancelled) setError(describeFamilyError(failure));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, session, store, reload]);

  const run = useCallback(
    (work: () => Promise<string | null>) => {
      setBusy(true);
      setError(null);
      void (async () => {
        try {
          const note = await work();
          setMessage(note);
        } catch (failure) {
          setMessage(null);
          setError(describeFamilyError(failure));
        } finally {
          setBusy(false);
        }
      })();
    },
    [],
  );


  /**
   * Смена ключа семьи, целиком, с устройства владельца — 5.5.
   *
   * Отдельным колбэком, а не строкой внутри `actions`, потому что путей входа в неё три и они
   * должны сходиться в одну процедуру: кнопка «сменить ключ», продолжение после остановки на
   * разрыве и то же самое, предложенное сразу после отзыва устройства. Разными их делает только
   * `acceptGaps`.
   */
  const performRotation = useCallback(
    async (acceptGaps: boolean): Promise<string | null> => {
      const current = sessionRef.current;
      if (api === null || current === null || current.familyId === null || membership === null) {
        return null;
      }
      const familyId = current.familyId;
      const engine = await engineFor();
      if (engine === null) {
        throw new FamilyRefusal("На этом устройстве нет ключа семьи. Смена ключа невозможна.");
      }
      setRotation({
        kind: "running",
        progress: {
          phase: "preparing",
          keyEpoch: null,
          previousKeyEpoch: membership.keyEpoch,
          freezeSeq: null,
          moved: 0,
          total: null,
        },
      });
      try {
        // Круг перед объявлением — не украшение: он сливает очередь в действующую эпоху и
        // догоняет курсор, а курсором меряется `freezeSeq` (5.5 шаг 2). Неудача круга ротацию не
        // отменяет — переносимый набор всё равно читается с сервера заново.
        setSyncRound((await runSyncRound(engine)).outcome);
        await showStored(familyId, true);
        await refreshSyncState(engine);
        const report = await engine.status();
        const stored = await store.readSyncState<StoredFamilyKey>(FAMILY_KEY_STATE_KEY);
        if (stored === undefined) {
          throw new FamilyRefusal("На этом устройстве нет ключа семьи. Смена ключа невозможна.");
        }
        const deviceKey = await store.readSyncState<StoredDeviceKey>(DEVICE_KEY_STATE_KEY);
        if (deviceKey === undefined) throw new Error("no device key on this device");
        const queued = queuedEnvelopes(await store.listOutbox());
        const highWater = highWaterFor(
          await store.readSyncState(HIGH_WATER_STATE_KEY),
          stored.keyEpoch,
        );
        const result = await rotateFamilyKey({
          api,
          transport: transportWithTokenRefresh(
            createHttpTransport({
              baseUrl: serverUrl ?? "",
              accessToken: () => sessionRef.current?.accessToken ?? "",
            }),
            refreshAccess,
          ),
          familyId,
          deviceId: current.deviceId,
          deviceSpki: decodeBase64(deviceKey.spki, "device key"),
          devicePrivateKey: deviceKey.keyPair.privateKey,
          familyKey: stored.key,
          keyEpoch: stored.keyEpoch,
          devices,
          pin: (deviceId) => pins.get(deviceId),
          bindVerdict: (deviceId) => bindVerdicts.get(deviceId) ?? null,
          cursorSeq: report.cursor.keyEpoch === stored.keyEpoch ? report.cursor.seq : 0,
          highWaterSeq: highWater,
          queued,
          rotationId: crypto.randomUUID(),
          acceptGaps,
          report: (progress) => setRotation({ kind: "running", progress }),
        });

        // Только теперь старый ключ можно забыть: сервер подтвердил шаг 7 и подтвердил его вторым,
        // независимым ответом (5.5, «Когда владелец вправе забыть старый ключ»). Курсор, останов и
        // якорь переписываются здесь же — ровно то, что делает движок при переходе эпохи, но для
        // владельца, который `409 epoch_mismatch` не получает и получить не может.
        await store.confirmOutbox(result.movedQueueOpIds);
        await store.writeSyncState([
          {
            key: FAMILY_KEY_STATE_KEY,
            value: { key: result.familyKey, keyEpoch: result.keyEpoch } satisfies StoredFamilyKey,
          },
          { key: SYNC_STATE_KEYS.cursor, value: { keyEpoch: result.keyEpoch, seq: 0 } },
          { key: SYNC_STATE_KEYS.stop, value: null },
          { key: SYNC_STATE_KEYS.anchor, value: null },
          {
            key: SYNC_STATE_KEYS.epoch,
            value: { keyEpoch: result.keyEpoch, keyDigest: result.keyDigest, live: true },
          },
          { key: HIGH_WATER_STATE_KEY, value: { keyEpoch: result.keyEpoch, seq: 0 } },
          {
            key: INHERITED_GAPS_STATE_KEY,
            value: { keyEpoch: result.keyEpoch, gaps: result.inheritedGaps },
          },
          // Шаг 7 удаляет на сервере все живые приглашения: посылка несёт ключ ушедшей эпохи.
          // Значит, и `bindKey` этого устройства больше не к чему приложить.
          { key: INVITE_STATE_KEY, value: null },
        ]);
        setInvite(null);
        setRotation({
          kind: "done",
          keyEpoch: result.keyEpoch,
          previousKeyEpoch: result.previousKeyEpoch,
          moved: result.moved,
          wrapped: result.wrapped,
          skipped: result.skipped,
          inheritedGaps: result.inheritedGaps,
        });
        setReload((value) => value + 1);
        return `Ключ семьи сменён: эпоха ${result.keyEpoch}. Прежний ключ на отозванных и удалённых устройствах больше не открывает ничего нового.`;
      } catch (failure) {
        // Отменяем свою `staging`-попытку: пока она жива, приём конвертов закрыт для **всей** семьи
        // (5.5 шаг 1), и оставить её висеть, пока человек думает, — значит остановить запись всем.
        // Завершённой ротации отмена не касается: строки `staging` уже нет, и сервер ответит
        // `no_rotation`, что здесь и проглатывается.
        await api.cancelRotation(familyId).catch(() => undefined);
        if (failure instanceof RotationHalted) {
          setRotation({
            kind: "halted",
            gap: failure.gap,
            keyEpoch: failure.keyEpoch,
            freezeSeq: failure.freezeSeq,
          });
          return null;
        }
        setRotation({ kind: "failed", message: describeFamilyError(failure) });
        throw failure;
      }
    },
    [
      api,
      bindVerdicts,
      devices,
      engineFor,
      membership,
      pins,
      refreshAccess,
      refreshSyncState,
      serverUrl,
      showStored,
      store,
    ],
  );

  const actions: FamilyActions = useMemo(
    () => ({
      requestLoginCode(email) {
        if (api === null) return;
        run(async () => {
          const normalized = normalizeEmail(email);
          await api.requestLoginCode(normalized);
          setPendingEmail(normalized);
          return "Код выслан на указанный адрес. Он живёт десять минут.";
        });
      },

      submitLoginCode(code) {
        if (api === null || pendingEmail === null) return;
        run(async () => {
          // The pair is made here and persisted only after the server accepted it: a device that
          // failed to sign in must not leave a key — or a raised schema version — behind.
          const keyPair = await generateDeviceKeyPair();
          const spki = await exportDevicePublicKey(keyPair.publicKey);
          const deviceId = crypto.randomUUID();
          const tokens = await api.verifyLoginCode({
            email: pendingEmail,
            code,
            deviceId,
            publicKey: toBase64(spki),
          });
          const next: FamilySession = {
            email: pendingEmail,
            deviceId: tokens.deviceId,
            accountId: tokens.accountId,
            accessToken: tokens.accessToken,
            accessExpiresAt: tokens.accessExpiresAt,
            refreshToken: tokens.refreshToken,
            familyId: null,
            memberId: null,
            role: null,
          };
          await store.writeSyncState([
            { key: DEVICE_KEY_STATE_KEY, value: { keyPair, spki: toBase64(spki) } satisfies StoredDeviceKey },
          ]);
          await persistSession(store, next);
          setSession(next);
          setOwnFingerprint(await deviceKeyFingerprint(spki));
          setPendingEmail(null);
          setReload((value) => value + 1);
          return "Вход выполнен.";
        });
      },

      cancelLoginCode() {
        setPendingEmail(null);
        setMessage(null);
        setError(null);
      },

      signOut() {
        run(async () => {
          if (api !== null && sessionRef.current !== null) {
            await api.signOut().catch(() => undefined);
          }
          await forgetSession(store);
          setSession(null);
          setMembership(null);
          setMembers([]);
          setDevices([]);
          setInvite(null);
          setPins(new Map());
          setBindVerdicts(new Map());
          setStatus(null);
          setOwnFingerprint(null);
          return "Вы вышли из учётной записи. Бюджет на устройстве не изменился.";
        });
      },

      createFamily() {
        if (api === null || session === null) return;
        run(async () => {
          const familyId = crypto.randomUUID();
          const memberId = crypto.randomUUID();
          const rotationId = crypto.randomUUID();
          const created = await api.createFamily({ familyId, memberId, rotationId });
          const familyKey = await generateFamilyKey();
          await store.writeSyncState([
            {
              key: FAMILY_KEY_STATE_KEY,
              value: { key: familyKey, keyEpoch: created.keyEpoch } satisfies StoredFamilyKey,
            },
            // Бюджет этого устройства становится бюджетом семьи: первая запись отправит в журнал
            // всё состояние целиком, иначе второму устройству не к чему будет отнести операцию.
            { key: JOURNAL_ORIGIN_KEY, value: "local" satisfies JournalOrigin },
          ]);
          const next: FamilySession = {
            ...session,
            familyId: created.familyId,
            memberId: created.memberId,
            role: "owner",
          };
          await persistSession(store, next);
          // В ссылку — сразу, до записи участника: путь записи читает сессию отсюда, и со старой
          // (без семьи) участник лёг бы мимо журнала, а журнал семьи остался бы пустым до первой
          // покупки. Вступившее устройство всё это время стояло бы на «Бюджет семьи ещё не
          // пришёл» (третье ревью, e2e). Запись участника — посев: она уносит в журнал всё.
          sessionRef.current = next;
          setSession(next);
          await registerLocalMember({
            id: created.memberId,
            name: memberNameFromEmail(session.email),
            role: "owner",
            active: true,
          });
          setReload((value) => value + 1);
          return "Семья создана. Ключ семьи сгенерирован на этом устройстве.";
        });
      },

      issueInvite() {
        if (api === null || session === null || membership === null) return;
        run(async () => {
          const stored = await store.readSyncState<StoredFamilyKey>(FAMILY_KEY_STATE_KEY);
          if (stored === undefined) throw new Error("no family key on this device");
          const deviceKey = await store.readSyncState<StoredDeviceKey>(DEVICE_KEY_STATE_KEY);
          if (deviceKey === undefined) throw new Error("no device key on this device");
          const code = generateInviteCode();
          const inviteId = crypto.randomUUID();
          const sealed = await sealInvite({
            code,
            familyId: membership.familyId,
            keyEpoch: membership.keyEpoch,
            inviteId,
            familyKey: stored.key,
            senderDeviceId: session.deviceId,
            senderSpki: decodeBase64(deviceKey.spki, "device key"),
            senderRole: membership.role,
            senderMemberId: membership.memberId,
          });
          const issued = await api.createInvite(membership.familyId, {
            familyId: membership.familyId,
            keyEpoch: membership.keyEpoch,
            inviteId,
            iv: toBase64(sealed.record.iv),
            ciphertext: toBase64(sealed.record.ciphertext),
            authTokenDigest: toBase64(sealed.record.authTokenDigest),
          });
          // 6.3, both halves of one sentence. What goes to disk is `bindKey` and the four
          // identifiers the HMAC of 5.4 is recomputed on; the code goes to the screen and nowhere
          // else. It is shown once because it is kept nowhere — a reload finds the invite still
          // live and the code gone, which is what the screen then says.
          const record: StoredInvite = {
            inviteId,
            familyId: membership.familyId,
            keyEpoch: membership.keyEpoch,
            expiresAt: issued.expiresAt,
            supersededCount: issued.supersededInviteIds.length,
            bindKey: toHex(sealed.issuerSecrets.bindKey),
          };
          await store.writeSyncState([{ key: INVITE_STATE_KEY, value: record }]);
          setInvite({
            code,
            expiresAt: record.expiresAt,
            supersededCount: record.supersededCount,
          });
          return "Код выпущен и показан один раз: в базу устройства он не записан. Продиктуйте его голосом — в переписке код читает тот, кто её видит.";
        });
      },

      joinByCode(rawCode) {
        if (api === null || session === null) return;
        const current = session;
        run(async () => {
          const joined = await joinFamilyByCode(rawCode, {
            api,
            store,
            deviceId: current.deviceId,
            memberId: crypto.randomUUID(),
            pins,
          });
          setPins(joined.pins);
          const next: FamilySession = {
            ...current,
            familyId: joined.familyId,
            memberId: joined.memberId,
            role: "member",
          };
          await persistSession(store, next);
          setSession(next);
          // Участник не вписывается здесь: бюджет на устройстве — ещё тот, что был до вступления, и
          // запись в него пропала бы вместе с ним. Его впишет круг, когда придёт бюджет семьи
          // (`missingLocalMember`, третье ревью, S4).
          setReload((value) => value + 1);
          return "Вы в семье. Ключ семьи развёрнут кодом приглашения на этом устройстве.";
        });
      },

      leaveFamily() {
        if (api === null || membership === null) return;
        run(async () => {
          await api.leaveFamily(membership.familyId);
          await forgetSession(store);
          setSession(null);
          setMembership(null);
          setMembers([]);
          setDevices([]);
          setPins(new Map());
          setBindVerdicts(new Map());
          setInvite(null);
          setStatus(null);
          return "Вы вышли из семьи. Бюджет на устройстве остался целиком.";
        });
      },

      removeMember(memberId) {
        if (api === null || membership === null) return;
        run(async () => {
          await api.removeMember(membership.familyId, memberId);
          setReload((value) => value + 1);
          return "Участник удалён, его устройства отозваны. Ключ семьи у них остался — смените ключ семьи, это делается кнопкой в разделе «Ключ семьи».";
        });
      },

      revokeDevice(deviceId) {
        if (api === null) return;
        run(async () => {
          await api.revokeDevice(deviceId);
          setReload((value) => value + 1);
          // Обещание сузилось до правды: отзыв гасит токены, ключ отбирает смена ключа, и она
          // здесь же предлагается. Прежде эта строка сообщала о неотбираемом ключе и не давала
          // ничего, чем его отобрать, — а номер эпохи оставался прежним навсегда.
          return "Устройство отозвано: его токены аннулированы. Ключ семьи, лежащий на нём, отзывом не стирается — смените ключ семьи, это делается кнопкой ниже.";
        });
      },

      startRotation() {
        run(() => performRotation(false));
      },

      continueRotationWithGaps() {
        run(() => performRotation(true));
      },

      dismissRotation() {
        setRotation(null);
      },

      /**
       * 5.4.1: «Подтверждение пользователя … и **создаёт** пин.»
       *
       * The value written is the candidate the person has just read aloud and compared — and this
       * is the only path in the application that writes a pin. Nothing here is reachable from a
       * server notification, a banner or a hint: it runs because a person pressed a button on a
       * screen they opened.
       */
      confirmFingerprint(deviceId) {
        run(async () => {
          // Пин создаётся один раз и подтверждением не переписывается: закреплённое значение
          // сравнивают с реальностью, а перезапись превратила бы сверку в «подтвердить то, что
          // прислал сервер». Кнопки для этого на экране нет — но проверяет тот, кто пишет, а не
          // тот, кто рисует.
          if (pins.has(deviceId)) throw new Error("a pin for this device already exists");
          const candidate = offered.get(deviceId);
          if (candidate === undefined) throw new Error("no candidate fingerprint for this device");
          const nextPins = new Map(pins);
          nextPins.set(deviceId, candidate);
          await store.writeSyncState([{ key: PINS_STATE_KEY, value: serializePins(nextPins) }]);
          setPins(nextPins);
          return "Отпечаток закреплён. Дальше сверка сравнивает эту запись, а не ответ сервера.";
        });
      },
    }),
    [
      api,
      membership,
      offered,
      pendingEmail,
      performRotation,
      pins,
      registerLocalMember,
      run,
      session,
      store,
    ],
  );

  const pinOf = useCallback(
    (deviceId: string): LocalPinState => {
      const fingerprint = pins.get(deviceId);
      return fingerprint === undefined ? { state: "absent" } : { state: "pinned", fingerprint };
    },
    [pins],
  );

  const offeredFingerprintOf = useCallback(
    (deviceId: string) => offered.get(deviceId),
    [offered],
  );

  const bindVerdictOf = useCallback(
    (deviceId: string): BindVerdict | null => bindVerdicts.get(deviceId) ?? null,
    [bindVerdicts],
  );

  return {
    serverUrl,
    session,
    inFamily: isSyncActive(serverUrl, session) && session?.familyId != null,
    membership,
    members,
    devices,
    ownFingerprint,
    pinOf,
    bindVerdictOf,
    offeredFingerprintOf,
    invite,
    status,
    syncRound,
    integrity,
    transactionAuthors,
    rotation,
    epochAlarm,
    busy,
    message,
    error,
    awaitingLoginCode: pendingEmail !== null,
    actions,
    writeBudget,
  };
}
