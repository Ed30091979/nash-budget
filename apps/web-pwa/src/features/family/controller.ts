/**
 * Everything the «Семья» screen does that has a side effect.
 *
 * The screen is markup and form state; this is the half that talks to the server, to WebCrypto and
 * to IndexedDB. It is a hook rather than a component so that the header's indicator and the
 * screen's body read the same state, and so that not one line of it runs on the local-only path:
 * the effects below start with `serverUrl === null` and `session === null` and stop there.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IndexedDbBudgetRepository } from "@family-budget/storage";
import {
  SYNC_STATE_KEYS,
  SyncEngine,
  createHttpTransport,
  fromBase64,
  toBase64,
  type PinState,
  type SyncStatusReport,
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
}

interface SyncStateStore {
  readSyncState<V = unknown>(key: string): Promise<V | undefined>;
  writeSyncState(entries: readonly { readonly key: string; readonly value: unknown }[]): Promise<void>;
  clearSyncData(): Promise<void>;
  countOutbox(): Promise<number>;
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

  const registerLocalMember = useCallback(async (member: LocalMember) => {
    try {
      await registerLocalMemberRef.current?.(member);
    } catch {
      // Не смертельно: участник в семье уже создан, а имя — украшение локального бюджета.
    }
  }, []);

  const api: FamilyApi | null = useMemo(
    () =>
      serverUrl === null
        ? null
        : createFamilyApi({
            baseUrl: serverUrl,
            accessToken: () => sessionRef.current?.accessToken ?? null,
          }),
    [serverUrl],
  );

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

  /* ── Состояние синхронизации из SyncStatusReport, а не из догадок. ── */
  useEffect(() => {
    if (!isSyncActive(serverUrl, session) || session?.familyId == null || api === null) {
      setStatus(null);
      setIntegrity(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const stored = await store.readSyncState<StoredFamilyKey>(FAMILY_KEY_STATE_KEY);
        if (stored === undefined) return;
        const engine = new SyncEngine({
          repository: repository as never,
          transport: createHttpTransport({
            baseUrl: serverUrl!,
            accessToken: () => sessionRef.current?.accessToken ?? "",
          }),
          familyId: session!.familyId!,
          deviceId: session!.deviceId,
          familyKey: stored.key,
          keyEpoch: stored.keyEpoch,
          keyDigest: toHex(await familyKeyFingerprint(stored.key)),
        });
        const report = await engine.status();
        if (!cancelled) setStatus(report);
      } catch {
        if (!cancelled) setStatus(null);
      }
      try {
        const journal = await store.readSyncState(SYNC_STATE_KEYS.journal);
        if (!cancelled && journal !== undefined) setIntegrity(restoreJournal(journal).integrity);
      } catch {
        if (!cancelled) setIntegrity(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, repository, serverUrl, session, store, reload]);

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
  };
}
