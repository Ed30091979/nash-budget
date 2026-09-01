/**
 * The session, and the promise the session is measured against.
 *
 * Section 9 and decision 7: **without an account the application works exactly as it does today.**
 * Not "with synchronisation switched off" — the network layer is simply absent. That promise is
 * kept structurally rather than by discipline, in two places:
 *
 * - the session lives in the sync-state store of the repository, which does not exist until
 *   something writes to it. Reading it at start-up therefore opens the database at the base
 *   version and answers `undefined` (`readSyncState` returns early when the stores are missing);
 *   only {@link persistSession} raises the database to the sync version, and only a sign-in calls
 *   it. A device that never signs in never gets the stores, the queue or the version bump;
 * - the address of the server is configuration and is absent from the build by default
 *   ({@link resolveSyncServerUrl}). With no address there is nothing to call, and every screen
 *   that would call it is not rendered at all.
 */

export type FamilyRole = "owner" | "member";

/**
 * What a signed-in device remembers.
 *
 * Deliberately small: tokens, the device's own identifier, and the membership the server last
 * reported. The family key is **not** here — it lives in the sync state under its own key, is
 * non-extractable, and 5.4.1 makes accepting a new one a thing with rules, not a field to
 * overwrite.
 */
export interface FamilySession {
  readonly email: string;
  readonly deviceId: string;
  readonly accountId: string;
  readonly accessToken: string;
  readonly accessExpiresAt: number;
  readonly refreshToken: string;
  readonly familyId: string | null;
  readonly memberId: string | null;
  readonly role: FamilyRole | null;
}

/** Key of the session record inside the sync-state store. */
export const SESSION_STATE_KEY = "family-session";

/** Key of the local pin table (5.4.1): device identifier to pinned fingerprint, in hex. */
export const PINS_STATE_KEY = "device-pins";

interface SessionStore {
  readSyncState<V = unknown>(key: string): Promise<V | undefined>;
  writeSyncState(entries: readonly { readonly key: string; readonly value: unknown }[]): Promise<void>;
  clearSyncData(): Promise<void>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * A stored session, or `null` — and `null` for anything that is not exactly the shape written.
 *
 * A half-valid record must not become a half-signed-in device: an interface holding an access
 * token with no `deviceId` would make requests it cannot authenticate and show a family screen it
 * cannot fill. Anything unrecognised is treated as "no session", which is the state the whole
 * application is already built to handle.
 */
export function parseSession(value: unknown): FamilySession | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !isNonEmptyString(record.email) ||
    !isNonEmptyString(record.deviceId) ||
    !isNonEmptyString(record.accountId) ||
    !isNonEmptyString(record.accessToken) ||
    !isNonEmptyString(record.refreshToken) ||
    typeof record.accessExpiresAt !== "number" ||
    !Number.isSafeInteger(record.accessExpiresAt)
  ) {
    return null;
  }
  const role = record.role;
  return {
    email: record.email,
    deviceId: record.deviceId,
    accountId: record.accountId,
    accessToken: record.accessToken,
    accessExpiresAt: record.accessExpiresAt,
    refreshToken: record.refreshToken,
    familyId: isNonEmptyString(record.familyId) ? record.familyId : null,
    memberId: isNonEmptyString(record.memberId) ? record.memberId : null,
    role: role === "owner" || role === "member" ? role : null,
  };
}

/**
 * Reads the session without creating anything.
 *
 * The one call the application makes at start-up on the local-only path, and it must stay a read:
 * `readSyncState` opens at the base version and returns `undefined` when the sync stores are
 * absent, so a device that never signed in is not migrated by being looked at.
 */
export async function loadSession(store: SessionStore): Promise<FamilySession | null> {
  return parseSession(await store.readSyncState(SESSION_STATE_KEY));
}

/** The first write of a device's life as a family member, and the one that raises the schema. */
export async function persistSession(store: SessionStore, session: FamilySession): Promise<void> {
  await store.writeSyncState([{ key: SESSION_STATE_KEY, value: { ...session } }]);
}

/**
 * Signing out, leaving the family and being revoked all end here.
 *
 * The whole sync store goes: the session, the cursor, the queue, the pins and the family key. The
 * budget document is untouched — 6.6 is explicit that a device that leaves keeps working locally
 * with what it has, and a screen that emptied the budget on leaving would be deleting data the
 * server never had a copy of.
 */
export async function forgetSession(store: SessionStore): Promise<void> {
  await store.clearSyncData();
}

/**
 * The address of the sync server, from configuration only.
 *
 * Section 9: «Адрес сервера задаётся конфигурацией сборки и не содержит зашитого production-URL».
 * Absent, blank or not `http(s)` means the build has no server — which is not an error state but
 * the default one, and the caller renders the local-only application.
 */
export function resolveSyncServerUrl(env: Readonly<Record<string, unknown>>): string | null {
  const raw = env.VITE_SYNC_SERVER_URL;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\/+$/u, "");
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : null;
}

/**
 * Whether this build and this device may reach the network at all.
 *
 * Both halves are required, and the order is not an accident: a configured address without a
 * session is still the local-only product, and a session in a build with no address is a session
 * that can do nothing. Every network call in this feature is behind this predicate.
 */
export function isSyncActive(serverUrl: string | null, session: FamilySession | null): boolean {
  return serverUrl !== null && session !== null;
}
