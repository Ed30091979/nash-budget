/**
 * The account and family half of the S3 HTTP contract.
 *
 * `@family-budget/sync-client` already owns the journal and the key wraps; what is left is
 * everything a person does on the «Семья» screen — sign in, create the family, issue and accept an
 * invite, list members and devices, leave, revoke. The shapes here are read off
 * `apps/sync-server/src/routes/*.ts` and are parsed rather than trusted: every field that reaches
 * a screen is checked here, once.
 *
 * **No prose of the server's ever reaches a screen.** A refusal carries a code from the server's
 * own closed enumeration and nothing else; the sentence the person reads is written in
 * {@link describeFamilyError}, in this file, from that code. `message` in the body is dropped
 * unread — it is `128` characters of somebody else's text and a screen is not the place for it.
 */
import { toServerErrorCode, type SyncServerErrorCode } from "@family-budget/sync-client";

import type { FamilyRole } from "./session";

export type FamilyErrorCode = SyncServerErrorCode | "network_unreachable" | "malformed_response";

export class FamilyApiError extends Error {
  readonly code: FamilyErrorCode;
  readonly status: number;

  constructor(code: FamilyErrorCode, status: number) {
    super(`family api refused with ${status} ${code}`);
    this.name = "FamilyApiError";
    this.code = code;
    this.status = status;
  }
}

const ERROR_TEXT: Partial<Record<FamilyErrorCode, string>> = {
  network_unreachable: "Сервер синхронизации недоступен. Бюджет на этом устройстве работает как обычно.",
  malformed_response: "Сервер ответил не по договору. Ничего не изменено.",
  unauthorized: "Вход устарел. Войдите ещё раз по коду из письма.",
  device_revoked: "Это устройство отозвано из семьи. Локальный бюджет остался на месте.",
  forbidden: "Это действие доступно только владельцу семьи.",
  owner_required: "Это действие доступно только владельцу семьи.",
  not_found: "Запись не найдена.",
  invalid_request: "Сервер не принял данные запроса. Проверьте введённое и повторите.",
  rate_limited: "Слишком много попыток подряд. Подождите и повторите позже.",
  already_in_family: "Этот аккаунт уже состоит в семье.",
  family_exists: "Такая семья уже создана.",
  no_family: "Аккаунт пока не состоит в семье.",
  rotation_in_progress: "В семье идёт смена ключа. Повторите, когда она завершится.",
  no_rotation: "Эта смена ключа на сервере уже не идёт: её отменили или завершили. Начните заново.",
  epoch_not_wrappable: "Обёртку этой эпохи выдать нельзя.",
  wrap_exists: "Обёртка для этого устройства в этой эпохе уже загружена.",
  batch_too_large: "Пакет слишком велик. Часть журнала не отправлена.",
  epoch_mismatch: "Ключ семьи сменился. Обновите данные семьи и повторите.",
  quota_exhausted: "Квота семьи исчерпана.",
  invite_invalid: "Код приглашения неизвестен, уже использован или просрочен.",
  invite_exists: "Такое приглашение уже выпущено.",
  login_code_invalid: "Код из письма не подошёл. Запросите новый код.",
  device_key_conflict: "Это устройство зарегистрировано с другим ключом. Переустановите приложение и войдите заново.",
};

/**
 * A refusal this feature decided on itself, carrying the sentence a person reads.
 *
 * The rule above — no prose of the server's ever reaches a screen — is about the *server's* text,
 * and it is kept: nothing constructs one of these from a response body. What it does is give the
 * checks the client performs on its own — the inviter's role against the member list (5.3), the
 * frozen boundary against this device's own cursor (5.5) — a way to say what happened instead of
 * being flattened into «не удалось выполнить действие», which is what a bare `Error` becomes.
 */
export class FamilyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamilyRefusal";
  }
}

export function describeFamilyError(error: unknown): string {
  if (error instanceof FamilyRefusal) return error.message;
  if (error instanceof FamilyApiError) {
    return ERROR_TEXT[error.code] ?? "Сервер отказал в действии. Ничего не изменено.";
  }
  return "Не удалось выполнить действие. Ничего не изменено.";
}

/* ───────────────────────────── Разбор ответов ───────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(): never {
  throw new FamilyApiError("malformed_response", 200);
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) malformed();
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) malformed();
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * A field that is legitimately absent — `bindProof` and `inviteId` of a device that joined by a
 * ceremony rather than by a code (6.4). Absent and malformed read alike, as `null`: a value the
 * owner's device cannot use for the HMAC is the same fact as one it was never given.
 */
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireRole(value: unknown): FamilyRole {
  if (value !== "owner" && value !== "member") malformed();
  return value;
}

/* ───────────────────────────── Формы ответов ───────────────────────────── */

export interface TokenPair {
  readonly accountId: string;
  readonly deviceId: string;
  readonly accessToken: string;
  readonly accessExpiresAt: number;
  readonly refreshToken: string;
}

export interface MembershipSnapshot {
  readonly familyId: string;
  readonly keyEpoch: number;
  readonly memberId: string;
  readonly role: FamilyRole;
  readonly ownerMemberId: string;
  /**
   * A rotation the server is holding open, or `null`.
   *
   * 7.1 names an unfinished rotation as something the person must be able to see: the server can
   * hold a family on the old epoch indefinitely and nothing but a visible state answers that.
   */
  readonly rotation: { readonly keyEpoch: number; readonly startedAt: number } | null;
}

export interface MemberRecord {
  readonly memberId: string;
  readonly role: FamilyRole;
  readonly joinedAt: number;
  readonly removedAt: number | null;
}

export interface DeviceRecord {
  readonly deviceId: string;
  readonly memberId: string;
  readonly publicKey: string;
  /**
   * The HMAC the joining device sent with its join request, or `null` — 5.4 and 6.4.
   *
   * The automatic half of two-way binding lives on this field: the owner's device recomputes it
   * on the `bindKey` it kept from the invite it issued, and a device whose proof agrees is bound
   * without anybody comparing twenty symbols aloud. Dropping it here — which is what this parser
   * used to do — switched that half off entirely and left a substituted public key detectable by
   * nothing at all.
   */
  readonly bindProof: string | null;
  /** The invite that device joined by, so the proof is recomputed on the right identifier. */
  readonly inviteId: string | null;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly revokedAt: number | null;
}

export interface IssuedInvite {
  readonly inviteId: string;
  readonly familyId: string;
  readonly keyEpoch: number;
  readonly expiresAt: number;
  readonly supersededInviteIds: readonly string[];
}

export interface ClaimedInvite {
  readonly inviteId: string;
  readonly familyId: string;
  readonly keyEpoch: number;
  readonly iv: string;
  readonly inviteBox: string;
}

/**
 * What the server answered when the owner's device declared a rotation — 5.5 step 1.
 *
 * Every number here is the server's, and every number here is checked against something this
 * device knows before it is used: `rotationId` against the value this device generated,
 * `previousKeyEpoch` against the epoch it holds, `keyEpoch` against being strictly above it, and
 * `freezeSeq` against its own cursor and its own high-water mark. A limit measured by the value
 * of the party it limits is not a limit.
 */
export interface DeclaredRotation {
  readonly keyEpoch: number;
  readonly previousKeyEpoch: number;
  readonly rotationId: string;
  readonly freezeSeq: number;
  readonly rotatingDeviceId: string;
  readonly startedAt: number;
}

export interface RotationWrapUpload {
  readonly deviceId: string;
  readonly senderDeviceId: string;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

export interface FamilyApiOptions {
  readonly baseUrl: string;
  /** Read before every request, so a refreshed token is picked up without a restart. */
  readonly accessToken: () => string | null | Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Обновляет доступ по отказу «вход устарел» и говорит, получилось ли.
   *
   * Доступ живёт пятнадцать минут (6.1), refresh-токен — тридцать дней. Без этого вызова человек
   * с полностью действующей сессией через пятнадцать минут читал «Вход устарел. Войдите ещё раз».
   * Повтор ровно один: второй отказ — настоящий, и его показывают.
   */
  readonly refreshAccess?: () => Promise<boolean>;
}

export interface FamilyApi {
  requestLoginCode(email: string): Promise<void>;
  verifyLoginCode(input: {
    readonly email: string;
    readonly code: string;
    readonly deviceId: string;
    readonly publicKey: string;
  }): Promise<TokenPair>;
  refresh(refreshToken: string): Promise<TokenPair>;
  signOut(): Promise<void>;
  membership(): Promise<MembershipSnapshot | null>;
  createFamily(input: {
    readonly familyId: string;
    readonly memberId: string;
    readonly rotationId: string;
  }): Promise<{ readonly familyId: string; readonly keyEpoch: number; readonly memberId: string }>;
  members(familyId: string): Promise<readonly MemberRecord[]>;
  devices(familyId: string): Promise<readonly DeviceRecord[]>;
  removeMember(familyId: string, memberId: string): Promise<void>;
  leaveFamily(familyId: string): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  createInvite(
    familyId: string,
    record: {
      readonly familyId: string;
      readonly keyEpoch: number;
      readonly inviteId: string;
      readonly iv: string;
      readonly ciphertext: string;
      readonly authTokenDigest: string;
    },
  ): Promise<IssuedInvite>;
  claimInvite(authToken: string): Promise<ClaimedInvite>;
  joinInvite(input: {
    readonly inviteId: string;
    readonly authToken: string;
    readonly memberId: string;
    readonly bindProof: string;
  }): Promise<void>;
  /** 5.5 step 1. The `rotationId` is this device's own and travels *to* the server. */
  declareRotation(familyId: string, rotationId: string): Promise<DeclaredRotation>;
  /** 5.5 steps 5 and 6: the wraps for the remaining bound devices and `rotateConfirm`. */
  uploadRotationKeys(
    familyId: string,
    input: {
      readonly rotationId: string;
      readonly epochConfirm?: string;
      readonly wraps?: readonly RotationWrapUpload[];
    },
  ): Promise<{ readonly keyEpoch: number; readonly wraps: number }>;
  /** 5.5 step 7. The answer is checked against `membership()` before the old key is forgotten. */
  completeRotation(
    familyId: string,
    rotationId: string,
  ): Promise<{ readonly keyEpoch: number; readonly previousKeyEpoch: number }>;
  /** 5.5: the owner may cancel an attempt — their own, or one stuck on a device that is gone. */
  cancelRotation(familyId: string): Promise<{ readonly cancelledKeyEpoch: number }>;
}

export function createFamilyApi(options: FamilyApiOptions): FamilyApi {
  const base = options.baseUrl.replace(/\/+$/u, "");
  const doFetch = options.fetch ?? globalThis.fetch;

  async function request(
    path: string,
    init: RequestInit,
    authenticated = true,
    mayRefresh = true,
  ): Promise<unknown> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (authenticated) {
      const token = await options.accessToken();
      // Never a request with an empty bearer: the server would answer `401` and the screen would
      // report «вход устарел» for what is in fact a device that never signed in.
      if (token === null || token.length === 0) throw new FamilyApiError("unauthorized", 401);
      headers.authorization = `Bearer ${token}`;
    }
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { ...init, headers });
    } catch {
      // Section 9: the server being unreachable is not an error of the user's scenario, and it
      // carries no cause, no URL and no fragment of a token out of here.
      throw new FamilyApiError("network_unreachable", 0);
    }
    let payload: unknown = null;
    const text = await response.text().catch(() => "");
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new FamilyApiError(response.ok ? "malformed_response" : "internal", response.status);
      }
    }
    if (!response.ok) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      const code = toServerErrorCode(error.code);
      // Истёкший доступ — не «войдите заново», а один вызов обновления и один повтор. Повтор
      // помечен `mayRefresh: false`, поэтому цепочка обновлений невозможна; сам `/auth/refresh`
      // сюда не попадает вовсе — он не аутентифицированный.
      if (code === "unauthorized" && authenticated && mayRefresh && options.refreshAccess) {
        if (await options.refreshAccess()) return request(path, init, authenticated, false);
      }
      throw new FamilyApiError(code, response.status);
    }
    return payload;
  }

  const json = (value: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });

  function parseTokens(payload: unknown): TokenPair {
    if (!isRecord(payload)) malformed();
    return {
      accountId: requireString(payload.accountId),
      deviceId: requireString(payload.deviceId),
      accessToken: requireString(payload.accessToken),
      accessExpiresAt: requireNumber(payload.accessExpiresAt),
      refreshToken: requireString(payload.refreshToken),
    };
  }

  return {
    async requestLoginCode(email) {
      await request("/v1/auth/code", json({ email }), false);
    },

    async verifyLoginCode(input) {
      return parseTokens(await request("/v1/auth/verify", json(input), false));
    },

    async refresh(refreshToken) {
      return parseTokens(await request("/v1/auth/refresh", json({ refreshToken }), false));
    },

    async signOut() {
      await request("/v1/auth/logout", { method: "POST" });
    },

    async membership() {
      let payload: unknown;
      try {
        payload = await request("/v1/families/me", { method: "GET" });
      } catch (error) {
        // «Аккаунт ещё не в семье» is the ordinary state of a device that has just signed in, and
        // it is an answer rather than a failure: the screen offers creating a family or entering
        // a code, which is exactly what this case is for.
        if (error instanceof FamilyApiError && (error.code === "no_family" || error.code === "not_found")) {
          return null;
        }
        throw error;
      }
      if (!isRecord(payload)) malformed();
      const rotation = payload.rotation;
      return {
        familyId: requireString(payload.familyId),
        keyEpoch: requireNumber(payload.keyEpoch),
        memberId: requireString(payload.memberId),
        role: requireRole(payload.role),
        ownerMemberId: requireString(payload.ownerMemberId),
        rotation: isRecord(rotation)
          ? { keyEpoch: requireNumber(rotation.keyEpoch), startedAt: requireNumber(rotation.startedAt) }
          : null,
      };
    },

    async createFamily(input) {
      const payload = await request("/v1/families", json(input));
      if (!isRecord(payload)) malformed();
      return {
        familyId: requireString(payload.familyId),
        keyEpoch: requireNumber(payload.keyEpoch),
        memberId: requireString(payload.memberId),
      };
    },

    async members(familyId) {
      const payload = await request(
        `/v1/families/${encodeURIComponent(familyId)}/members`,
        { method: "GET" },
      );
      if (!isRecord(payload) || !Array.isArray(payload.members)) malformed();
      return payload.members.map((entry) => {
        if (!isRecord(entry)) malformed();
        return {
          memberId: requireString(entry.memberId),
          role: requireRole(entry.role),
          joinedAt: requireNumber(entry.joinedAt),
          removedAt: optionalNumber(entry.removedAt),
        };
      });
    },

    async devices(familyId) {
      const payload = await request(
        `/v1/families/${encodeURIComponent(familyId)}/devices`,
        { method: "GET" },
      );
      if (!isRecord(payload) || !Array.isArray(payload.devices)) malformed();
      return payload.devices.map((entry) => {
        if (!isRecord(entry)) malformed();
        return {
          deviceId: requireString(entry.deviceId),
          memberId: requireString(entry.memberId),
          publicKey: requireString(entry.publicKey),
          bindProof: optionalString(entry.bindProof),
          inviteId: optionalString(entry.inviteId),
          createdAt: requireNumber(entry.createdAt),
          lastSeenAt: requireNumber(entry.lastSeenAt),
          revokedAt: optionalNumber(entry.revokedAt),
        };
      });
    },

    async removeMember(familyId, memberId) {
      await request(
        `/v1/families/${encodeURIComponent(familyId)}/members/${encodeURIComponent(memberId)}`,
        { method: "DELETE" },
      );
    },

    async leaveFamily(familyId) {
      await request(`/v1/families/${encodeURIComponent(familyId)}/leave`, { method: "POST" });
    },

    async revokeDevice(deviceId) {
      await request(`/v1/devices/${encodeURIComponent(deviceId)}/revoke`, { method: "POST" });
    },

    async createInvite(familyId, record) {
      const payload = await request(
        `/v1/families/${encodeURIComponent(familyId)}/invites`,
        json(record),
      );
      if (!isRecord(payload)) malformed();
      const superseded = payload.supersededInviteIds;
      return {
        inviteId: requireString(payload.inviteId),
        familyId: requireString(payload.familyId),
        keyEpoch: requireNumber(payload.keyEpoch),
        expiresAt: requireNumber(payload.expiresAt),
        supersededInviteIds: Array.isArray(superseded) ? superseded.map(requireString) : [],
      };
    },

    async claimInvite(authToken) {
      const payload = await request("/v1/invites/claim", json({ authToken }));
      if (!isRecord(payload)) malformed();
      return {
        inviteId: requireString(payload.inviteId),
        familyId: requireString(payload.familyId),
        keyEpoch: requireNumber(payload.keyEpoch),
        iv: requireString(payload.iv),
        inviteBox: requireString(payload.inviteBox),
      };
    },

    async joinInvite(input) {
      await request("/v1/invites/join", json(input));
    },

    async declareRotation(familyId, rotationId) {
      const payload = await request(
        `/v1/families/${encodeURIComponent(familyId)}/rotation`,
        json({ rotationId }),
      );
      if (!isRecord(payload)) malformed();
      return {
        keyEpoch: requireNumber(payload.keyEpoch),
        previousKeyEpoch: requireNumber(payload.previousKeyEpoch),
        rotationId: requireString(payload.rotationId),
        freezeSeq: requireNumber(payload.freezeSeq),
        rotatingDeviceId: requireString(payload.rotatingDeviceId),
        startedAt: requireNumber(payload.startedAt),
      };
    },

    async uploadRotationKeys(familyId, input) {
      const payload = await request(
        `/v1/families/${encodeURIComponent(familyId)}/rotation/keys`,
        json(input),
      );
      if (!isRecord(payload)) malformed();
      return { keyEpoch: requireNumber(payload.keyEpoch), wraps: requireNumber(payload.wraps) };
    },

    async completeRotation(familyId, rotationId) {
      const payload = await request(
        `/v1/families/${encodeURIComponent(familyId)}/rotation/complete`,
        json({ rotationId }),
      );
      if (!isRecord(payload)) malformed();
      return {
        keyEpoch: requireNumber(payload.keyEpoch),
        previousKeyEpoch: requireNumber(payload.previousKeyEpoch),
      };
    },

    async cancelRotation(familyId) {
      const payload = await request(`/v1/families/${encodeURIComponent(familyId)}/rotation`, {
        method: "DELETE",
      });
      if (!isRecord(payload)) malformed();
      return { cancelledKeyEpoch: requireNumber(payload.cancelledKeyEpoch) };
    },
  };
}
