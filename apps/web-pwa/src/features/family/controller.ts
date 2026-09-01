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
  SyncEngine,
  SyncServerError,
  createHttpTransport,
  fromBase64,
  toBase64,
  type PinState,
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
} from "@family-budget/sync-crypto";
import { restoreJournal, type JournalIntegrity } from "@family-budget/sync-protocol";

import { createFamilyApi, describeFamilyError, type DeviceRecord, type FamilyApi, type MemberRecord, type MembershipSnapshot } from "./api";
import type { ActiveInvite, FamilyActions } from "./FamilyScreen";
import { budgetJournalDrafts } from "./journal";
import { normalizeEmail } from "./model";
import {
  PINS_STATE_KEY,
  forgetSession,
  isSyncActive,
  loadSession,
  persistSession,
  type FamilySession,
} from "./session";

/** The device's own ECDH pair, kept where the family key is kept and nowhere else. */
const DEVICE_KEY_STATE_KEY = "device-key";
/** The family key of the epoch this device has accepted. */
const FAMILY_KEY_STATE_KEY = "family-key";
/** The invite this device issued and is still reading out. Local: the server never sees the code. */
const INVITE_STATE_KEY = "issued-invite";
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

interface StoredInvite {
  readonly code: string;
  readonly expiresAt: number;
  readonly supersededCount: number;
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
   * Показывает состояние, которое принесли чужие операции.
   *
   * Приём уже записал его в документ одной транзакцией с курсором и журналом — экрану остаётся
   * узнать, что документ изменился. Без этого вызова операция, введённая на другом устройстве,
   * лежала бы в базе и не появлялась бы на экране до перезапуска.
   */
  readonly publishRemoteBudget?: (value: unknown, revision: string) => void;
}

/**
 * Результат записи бюджета через журнал.
 *
 * Форма нарочно совпадает с `saveIfRevision`: координатор записи в `App.tsx` не должен знать, чем
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
 * целостности показывает снимок, только когда его можно показать, иначе документ сохраняет
 * прежнее состояние (решение 19). Поэтому результат читается с диска, а не собирается из
 * намерения — иначе экран показывал бы изменение, которого перезапуск не найдёт.
 */
export function createBudgetJournalWriter(options: JournalWriterOptions): BudgetJournalWrite {
  return async ({ expectedRevision, previous, next }) => {
    const engine = await options.engineFor();
    if (engine === null) return null;
    const origin = await options.store
      .readSyncState<JournalOrigin>(JOURNAL_ORIGIN_KEY)
      .catch(() => undefined);
    const journal = await options.store
      .readSyncState(SYNC_STATE_KEYS.journal)
      .catch(() => undefined);
    const seed = origin === "local" && journal === undefined;
    const drafts = budgetJournalDrafts(seed ? null : previous, next, options.memberId());
    if (drafts.length === 0) {
      // Ни одна сущность не изменилась. Журналу сказать нечего, и запись идёт прежним путём,
      // чтобы форма состояния на диске всё равно догнала показанную.
      return options.saveIfRevision(expectedRevision, next);
    }
    const committed = await engine.enqueue(drafts);
    const document = await options.store.loadVersioned().catch(() => null);
    options.afterWrite?.(engine);
    if (document !== null) return { status: "saved", value: document.value, revision: document.revision };
    return {
      status: "saved",
      value: committed.snapshot.integrity.ready ? committed.snapshot.state : previous,
      revision: committed.revision,
    };
  };
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
  readonly membership: MembershipSnapshot | null;
  readonly members: readonly MemberRecord[];
  readonly devices: readonly DeviceRecord[];
  readonly ownFingerprint: Uint8Array | null;
  readonly pinOf: (deviceId: string) => PinState;
  readonly offeredFingerprintOf: (deviceId: string) => Uint8Array | undefined;
  readonly invite: ActiveInvite | null;
  readonly status: SyncStatusReport | null;
  readonly integrity: JournalIntegrity | null;
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

interface SyncStateStore {
  readSyncState<V = unknown>(key: string): Promise<V | undefined>;
  writeSyncState(entries: readonly { readonly key: string; readonly value: unknown }[]): Promise<void>;
  clearSyncData(): Promise<void>;
  countOutbox(): Promise<number>;
  loadVersioned(): Promise<{ readonly value: unknown; readonly revision: string } | null>;
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
  const [offered, setOffered] = useState<ReadonlyMap<string, Uint8Array>>(new Map());
  const [invite, setInvite] = useState<ActiveInvite | null>(null);
  const [status, setStatus] = useState<SyncStatusReport | null>(null);
  const [integrity, setIntegrity] = useState<JournalIntegrity | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const sessionRef = useRef<FamilySession | null>(null);
  sessionRef.current = session;
  // Held in a ref so that the actions below do not change identity every render because of it.
  const registerLocalMemberRef = useRef(options.registerLocalMember);
  registerLocalMemberRef.current = options.registerLocalMember;
  const publishRemoteBudgetRef = useRef(options.publishRemoteBudget);
  publishRemoteBudgetRef.current = options.publishRemoteBudget;
  const apiRef = useRef<FamilyApi | null>(null);
  /** Одно обновление на все запросы сразу: refresh-токен поворачивается, и второй с тем же не пройдёт. */
  const refreshingRef = useRef<Promise<boolean> | null>(null);

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
   * Сообщает экрану, что журнал и очередь изменились, и подаёт состояние наверх.
   *
   * Читается настоящее состояние движка, а не догадка: отчёт берётся из `status()`, целостность —
   * из записанного журнала, а показанное состояние — из документа, который приём уже записал одной
   * транзакцией с курсором. Ни одна из трёх величин здесь не выводится из другой.
   */
  const refreshSyncState = useCallback(
    async (engine: SyncEngine, publishDocument: boolean): Promise<void> => {
      try {
        setStatus(await engine.status());
      } catch {
        setStatus(null);
      }
      try {
        const journal = await store.readSyncState(SYNC_STATE_KEYS.journal);
        setIntegrity(journal === undefined ? null : restoreJournal(journal).integrity);
      } catch {
        setIntegrity(null);
      }
      if (!publishDocument) return;
      try {
        const document = await store.loadVersioned();
        if (document !== null) publishRemoteBudgetRef.current?.(document.value, document.revision);
      } catch {
        // Документ не прочитался — экран остаётся на том состоянии, которое уже показывает.
      }
    },
    [store],
  );

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
            try {
              await engine.sync();
            } catch {
              // Офлайн — не ошибка сценария. Очередь ждёт связи, индикатор её показывает.
            }
            await refreshSyncState(engine, true);
          })();
        },
      }),
    [engineFor, refreshSyncState, repository, store],
  );


/* ── Состояние синхронизации и приём чужих операций. Ни того, ни другого без входа. ── */
  useEffect(() => {
    if (!isSyncActive(serverUrl, session) || session?.familyId == null || api === null) {
      setStatus(null);
      setIntegrity(null);
      return;
    }
    let cancelled = false;
    let running = false;
    const round = async () => {
      if (running || cancelled) return;
      running = true;
      try {
        const engine = await engineFor();
        if (engine === null || cancelled) return;
        let applied = 0;
        try {
          const result = await engine.sync();
          applied = result.pull.applied;
        } catch {
          // Сервер недоступен — приложение остаётся полностью рабочим, отчёт ниже это покажет.
        }
        if (cancelled) return;
        await refreshSyncState(engine, applied > 0);
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
  }, [api, engineFor, refreshSyncState, serverUrl, session?.familyId, session?.deviceId, reload]);

  /* ── Список семьи. Ни одного запроса без сессии. ── */
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
        const storedInvite = await store.readSyncState<StoredInvite>(INVITE_STATE_KEY);
        if (!cancelled && storedInvite !== undefined) {
          setInvite({
            code: storedInvite.code,
            expiresAt: storedInvite.expiresAt,
            supersededCount: storedInvite.supersededCount,
          });
        }
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
          const active: StoredInvite = {
            code,
            expiresAt: issued.expiresAt,
            supersededCount: issued.supersededInviteIds.length,
          };
          await store.writeSyncState([{ key: INVITE_STATE_KEY, value: active }]);
          setInvite(active);
          return "Код выпущен. Продиктуйте его голосом — в переписке код читает тот, кто её видит.";
        });
      },

      joinByCode(rawCode) {
        if (api === null || session === null) return;
        run(async () => {
          const code = normalizeInviteCode(rawCode);
          const secrets = await deriveInviteSecrets(code);
          const authToken = toBase64(secrets.authToken);
          const claimed = await api.claimInvite(authToken);
          const opened = await openInvite({
            code,
            familyId: claimed.familyId,
            keyEpoch: claimed.keyEpoch,
            inviteId: claimed.inviteId,
            iv: decodeBase64(claimed.iv, "invite iv"),
            ciphertext: decodeBase64(claimed.inviteBox, "invite box"),
          });
          const deviceKey = await store.readSyncState<StoredDeviceKey>(DEVICE_KEY_STATE_KEY);
          if (deviceKey === undefined) throw new Error("no device key on this device");
          const spki = decodeBase64(deviceKey.spki, "device key");
          const memberId = crypto.randomUUID();
          const bindProof = await computeBindProof(opened.bindKey, {
            familyId: claimed.familyId,
            inviteId: claimed.inviteId,
            deviceId: session.deviceId,
            spki,
          });
          await api.joinInvite({
            inviteId: claimed.inviteId,
            authToken,
            memberId,
            bindProof: toBase64(bindProof),
          });
          // 5.4, first row of the table: the sender's fingerprint travelled inside the invite box
          // under `KEK`, so it is pinned here without a further ceremony — the code *was* the
          // ceremony, and the value never came from the server.
          const nextPins = new Map(pins);
          nextPins.set(opened.senderDeviceId, opened.senderKeyFingerprint);
          await store.writeSyncState([
            {
              key: FAMILY_KEY_STATE_KEY,
              value: { key: opened.familyKey, keyEpoch: claimed.keyEpoch } satisfies StoredFamilyKey,
            },
            { key: PINS_STATE_KEY, value: serializePins(nextPins) },
            // Бюджет придёт журналом. Посева здесь нет и быть не может: он влил бы личный бюджет
            // вступающего в семейный, и семья увидела бы чужие счета как свои.
            { key: JOURNAL_ORIGIN_KEY, value: "family" satisfies JournalOrigin },
          ]);
          setPins(nextPins);
          const next: FamilySession = {
            ...session,
            familyId: claimed.familyId,
            memberId,
            role: "member",
          };
          await persistSession(store, next);
          setSession(next);
          await registerLocalMember({
            id: memberId,
            name: memberNameFromEmail(session.email),
            role: "member",
            active: true,
          });
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
          return "Участник удалён. Ключ семьи у его устройств остался — смените ключ семьи.";
        });
      },

      revokeDevice(deviceId) {
        if (api === null) return;
        run(async () => {
          await api.revokeDevice(deviceId);
          setReload((value) => value + 1);
          return "Устройство отозвано. Ключ, лежащий на нём, отзывом не стирается.";
        });
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
          const candidate = offered.get(deviceId);
          if (candidate === undefined) throw new Error("no candidate fingerprint for this device");
          const nextPins = new Map(pins);
          nextPins.set(deviceId, candidate);
          await store.writeSyncState([{ key: PINS_STATE_KEY, value: serializePins(nextPins) }]);
          setPins(nextPins);
          return "Отпечаток закреплён. Дальше сверка сравнивает эту запись, а не ответ сервера.";
        });
      },

      dismissNotice() {
        setMessage(null);
      },
    }),
    [api, membership, offered, pendingEmail, pins, registerLocalMember, run, session, store],
  );

  const pinOf = useCallback(
    (deviceId: string): PinState => {
      const fingerprint = pins.get(deviceId);
      return fingerprint === undefined ? { state: "absent" } : { state: "pinned", fingerprint };
    },
    [pins],
  );

  const offeredFingerprintOf = useCallback(
    (deviceId: string) => offered.get(deviceId),
    [offered],
  );

  return {
    serverUrl,
    session,
    membership,
    members,
    devices,
    ownFingerprint,
    pinOf,
    offeredFingerprintOf,
    invite,
    status,
    integrity,
    busy,
    message,
    error,
    awaitingLoginCode: pendingEmail !== null,
    actions,
    writeBudget,
  };
}
