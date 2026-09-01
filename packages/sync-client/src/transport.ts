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
  /** A constant of this client, never a number read out of a server response. */
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

export function createHttpTransport(options: HttpTransportOptions): SyncTransport {
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
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      const code = typeof error.code === "string" ? error.code : "internal";
      const { code: _code, message: _message, ...details } = error;
      throw new SyncServerError(response.status, code, details);
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
      return {
        keyEpoch: requireNumber(payload.keyEpoch, "keyEpoch"),
        hasMore: payload.hasMore === true,
        envelopes: payload.envelopes.map(parseDelivered),
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
