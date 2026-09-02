/**
 * The client half of the S3 HTTP contract.
 *
 * Nothing here decides anything: it moves bytes, checks the shape of what comes back against the
 * routes of `apps/sync-server`, and turns a refusal into a {@link SyncServerError} carrying the
 * code the server spelled. Every judgement about what the bytes mean lives in `intake.ts`.
 *
 * The interface is separate from the `fetch` implementation because the engine's tests have to
 * cut the network in the middle of a batch and put it back, which no HTTP client can be asked to
 * do honestly.
 */
import { SyncClientError, SyncServerError } from "./errors.js";
import type { DeliveredEnvelope, OutgoingEnvelope } from "./types.js";

export interface SubmitResult {
  readonly keyEpoch: number;
  readonly accepted: readonly { readonly opId: string; readonly seq: number }[];
}

export interface FetchQuery {
  readonly keyEpoch: number;
  /** Exclusive lower bound: the `seq` this device has already applied. */
  readonly after: number;
  /**
   * A constant of this client, never a number read out of a server response — and, being the
   * client's own, the number the answer is measured against before a byte of it is parsed.
   */
  readonly limit: number;
}

export interface FetchResult {
  readonly keyEpoch: number;
  /**
   * The server's paging hint, carried through and deliberately not acted on as an end-of-journal
   * signal. 3.6: the end of the journal is decided by the client — a short page, or two requests
   * in a row that bring no new `seq` — because a server that left this `true` for ever would
   * otherwise switch off checkpoint comparison with one boolean.
   */
  readonly hasMore: boolean;
  readonly envelopes: readonly DeliveredEnvelope[];
}

export interface KeyWrapRecord {
  readonly keyEpoch: number;
  readonly deviceId: string;
  readonly senderDeviceId: string;
  readonly rotationId: string;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly rotateConfirm: string | null;
  readonly confirmRotationId: string | null;
}

export interface KeysResult {
  /** The epoch in force. It travels server to client and never the other way (2.2). */
  readonly keyEpoch: number;
  readonly wraps: readonly KeyWrapRecord[];
}

/**
 * What the server reports about a deletion it has carried out (6.8), parsed rather than trusted.
 *
 * Counts, not lists: the numbers are the caller's own — its devices, its memberships — and the
 * identifiers the answer could otherwise carry are strings written by the other side. `familyId` in
 * particular is something this device already knows and does not need to be told.
 */
export interface AccountDeletionResult {
  /** Echoed back and checked: an answer about another account is not an answer to this request. */
  readonly accountId: string;
  readonly deletedAt: number;
  /** How many device rows the server removed. At least one — the device that asked. */
  readonly devices: number;
  readonly memberships: number;
  /**
   * The family went too, because this account was its last live member (6.8).
   *
   * `false` means the family stands and the other members keep working — which is the outcome the
   * confirmation screen has to describe differently, because it is the one where data of other
   * people survives and this device's departure obliges the owner to rotate the key (6.6).
   */
  readonly familyDeleted: boolean;
  readonly rotationRequired: boolean;
}

export interface DeleteAccountOptions {
  /**
   * Called once, if the server asks for a fresh sign-in, and expected to complete the one-time code
   * ceremony of 6.1 before it resolves.
   *
   * 6.8 is irreversible and the server refuses to act on a live access token alone: a token is a
   * bearer credential, and this is the one act that takes the family with it. The retry is made
   * exactly once — a loop here would turn a refusal the user is meant to see into an invisible
   * cycle of code requests, and the server rate-limits those per address anyway (6.1).
   *
   * Omit it, and `reauth_required` simply arrives as a {@link SyncServerError} for the caller to
   * handle; {@link isReauthRequired} is the predicate for that branch.
   */
  readonly reauthenticate?: () => Promise<void>;
}

/**
 * The account's own lifecycle, kept apart from {@link SyncTransport} deliberately.
 *
 * The engine's transport is the journal contract, and the engine is given fakes of it in tests and
 * in local mode; deletion is not something a journal fake should have to implement, and not
 * something the engine may ever call. `createHttpTransport` returns both.
 */
export interface AccountTransport {
  /**
   * `DELETE /v1/accounts/:accountId` — 6.8.
   *
   * Removes the account, its devices, its memberships and, when it was the family's last live
   * member, the family with every envelope and invite in it. It does **not** touch anything on this
   * device: 6.8 leaves the local budget alone, and erasing it is a separate command the user gives
   * separately. A client that cleared its own storage here would be doing on the server's word what
   * the server itself is forbidden to order.
   *
   * After it returns, every token this device holds is refused: the device row it named is gone. A
   * second call is answered `401 unauthorized`, exactly as an unauthenticated request is.
   */
  deleteAccount(accountId: string, options?: DeleteAccountOptions): Promise<AccountDeletionResult>;
}

/** True for the refusal 6.8 answers a stale sign-in with — the one that is retried, not reported. */
export function isReauthRequired(error: unknown): boolean {
  return error instanceof SyncServerError && error.serverCode === "reauth_required";
}

export interface SyncTransport {
  submit(familyId: string, envelopes: readonly OutgoingEnvelope[]): Promise<SubmitResult>;
  fetch(familyId: string, query: FetchQuery): Promise<FetchResult>;
  /**
   * Takes the family and nothing else.
   *
   * The absence of a parameter is the requirement, not an omission. 5.4.1: the issuing of chain
   * links accepts no input, because the one input that would be natural — "the epoch I have
   * accepted" — is local state the server must never be told. The server answers with every wrap
   * addressed to this device, in epoch order, and the device finds its own way through them.
   */
  keys(familyId: string): Promise<KeysResult>;
}

export interface HttpTransportOptions {
  /** Base URL of the sync server. Configuration, never a compiled-in production address (§9). */
  readonly baseUrl: string;
  /** Called before every request, so a refreshed access token is picked up without a restart. */
  readonly accessToken: () => string | Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SyncClientError("malformed_response", `${label} must be a safe integer`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SyncClientError("malformed_response", `${label} must be a non-empty string`);
  }
  return value;
}

function parseDelivered(value: unknown, index: number): DeliveredEnvelope {
  if (!isRecord(value)) {
    throw new SyncClientError("malformed_response", `envelope ${index} must be an object`);
  }
  return {
    envelopeVersion: requireNumber(value.envelopeVersion, "envelopeVersion"),
    kind: requireString(value.kind, "kind"),
    familyId: requireString(value.familyId, "familyId"),
    opId: requireString(value.opId, "opId"),
    deviceId: requireString(value.deviceId, "deviceId"),
    keyEpoch: requireNumber(value.keyEpoch, "keyEpoch"),
    seq: requireNumber(value.seq, "seq"),
    receivedAt: requireNumber(value.receivedAt, "receivedAt"),
    iv: requireString(value.iv, "iv"),
    ciphertext: requireString(value.ciphertext, "ciphertext"),
  };
}

export function createHttpTransport(
  options: HttpTransportOptions,
): SyncTransport & AccountTransport {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const token = await options.accessToken();
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${token}`,
        },
      });
    } catch {
      // Section 9: the server being unreachable is not an error of the user's scenario. It is
      // reported as one code and nothing else — no cause, no URL, no token fragment.
      throw new SyncClientError("transport_failed", "the sync server could not be reached");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SyncClientError("transport_failed", "the sync server answered with a non-JSON body");
    }
    if (!response.ok) {
      // Both halves of the refusal are the other side's bytes. `SyncServerError` keeps the code
      // only if it is one the server's own enumeration spells, and keeps only the numeric fields
      // the contract names — the message is dropped here and never read.
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      throw new SyncServerError(response.status, error.code, error);
    }
    return payload;
  }

  return {
    async submit(familyId, envelopes) {
      const payload = await request(`/v1/families/${encodeURIComponent(familyId)}/envelopes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelopes }),
      });
      if (!isRecord(payload) || !Array.isArray(payload.accepted)) {
        throw new SyncClientError("malformed_response", "submit answer has no accepted list");
      }
      return {
        keyEpoch: requireNumber(payload.keyEpoch, "keyEpoch"),
        accepted: payload.accepted.map((entry, index) => {
          if (!isRecord(entry)) {
            throw new SyncClientError("malformed_response", `accepted ${index} must be an object`);
          }
          return {
            opId: requireString(entry.opId, "accepted opId"),
            seq: requireNumber(entry.seq, "accepted seq"),
          };
        }),
      };
    },

    async fetch(familyId, query) {
      const search = new URLSearchParams({
        keyEpoch: String(query.keyEpoch),
        after: String(query.after),
        limit: String(query.limit),
      });
      const payload = await request(
        `/v1/families/${encodeURIComponent(familyId)}/envelopes?${search.toString()}`,
        { method: "GET" },
      );
      if (!isRecord(payload) || !Array.isArray(payload.envelopes)) {
        throw new SyncClientError("malformed_response", "fetch answer has no envelope list");
      }
      // The limit travelled *to* the server; nothing so far made it hold on the way back. Checked
      // before the page is parsed, because the page is parsed and then folded, and an answer of a
      // hundred thousand envelopes to a request for two hundred is work this client never asked
      // for. It also makes the end-of-journal test of 3.6 a comparison rather than a coincidence:
      // "shorter than the limit" only means the end of the journal if "longer" is impossible.
      if (payload.envelopes.length > query.limit) {
        throw new SyncClientError(
          "malformed_response",
          "the page is longer than the limit this client asked for",
        );
      }
      return {
        keyEpoch: requireNumber(payload.keyEpoch, "keyEpoch"),
        hasMore: payload.hasMore === true,
        envelopes: payload.envelopes.map(parseDelivered),
      };
    },

    async deleteAccount(accountId, deletion = {}) {
      const send = async (): Promise<unknown> =>
        request(`/v1/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
      let payload: unknown;
      try {
        payload = await send();
      } catch (error) {
        // One retry, and only for the one refusal that has a remedy the caller can perform. Any
        // other failure — `not_found` for an identifier that is not this session's, `unauthorized`
        // for a session that has ended — travels out untouched: retrying those would be asking the
        // user for a code to fix something a code does not fix.
        if (!isReauthRequired(error) || deletion.reauthenticate === undefined) throw error;
        await deletion.reauthenticate();
        payload = await send();
      }
      if (!isRecord(payload)) {
        throw new SyncClientError("malformed_response", "deletion answer is not an object");
      }
      const answered = requireString(payload.accountId, "accountId");
      if (answered !== accountId) {
        // The server has just been asked to destroy something irreversibly, and this is the one
        // field of its answer that can be checked against what was asked. An answer about another
        // account is not evidence that this one is gone.
        throw new SyncClientError("malformed_response", "deletion answer names another account");
      }
      return {
        accountId: answered,
        deletedAt: requireNumber(payload.deletedAt, "deletedAt"),
        devices: requireNumber(payload.devices, "devices"),
        memberships: requireNumber(payload.memberships, "memberships"),
        // Strict booleans: a missing field is `false` and never `undefined` leaking into a screen
        // that renders "семья удалена" from a truthiness test.
        familyDeleted: payload.familyDeleted === true,
        rotationRequired: payload.rotationRequired === true,
      };
    },

    async keys(familyId) {
      const payload = await request(`/v1/families/${encodeURIComponent(familyId)}/keys`, {
        method: "GET",
      });
      if (!isRecord(payload) || !Array.isArray(payload.wraps)) {
        throw new SyncClientError("malformed_response", "keys answer has no wrap list");
      }
      return {
        keyEpoch: requireNumber(payload.keyEpoch, "keyEpoch"),
        wraps: payload.wraps.map((entry, index) => {
          if (!isRecord(entry)) {
            throw new SyncClientError("malformed_response", `wrap ${index} must be an object`);
          }
          return {
            keyEpoch: requireNumber(entry.keyEpoch, "wrap keyEpoch"),
            deviceId: requireString(entry.deviceId, "wrap deviceId"),
            senderDeviceId: requireString(entry.senderDeviceId, "wrap senderDeviceId"),
            rotationId: requireString(entry.rotationId, "wrap rotationId"),
            salt: requireString(entry.salt, "wrap salt"),
            iv: requireString(entry.iv, "wrap iv"),
            ciphertext: requireString(entry.ciphertext, "wrap ciphertext"),
            rotateConfirm: typeof entry.rotateConfirm === "string" ? entry.rotateConfirm : null,
            confirmRotationId:
              typeof entry.confirmRotationId === "string" ? entry.confirmRotationId : null,
          };
        }),
      };
    },
  };
}
