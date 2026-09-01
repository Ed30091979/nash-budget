/**
 * The harness the API tests share.
 *
 * Three things are worth stating about it. The clock is injected and never advances by itself:
 * 5.5 measures rotation timeouts in hours and 6.1 measures a login code in minutes, and both are
 * untestable on the wall clock. The database is `:memory:`, so every test gets a schema created by
 * the same migration the real server runs. And the login code is captured through the configured
 * sink rather than read out of the database — that is the only way a code leaves the process, and
 * a test that reached into the table would be proving something else.
 */
import { randomUUID } from "node:crypto";

import {
  computeBindProof,
  generateFamilyKey,
  generateInviteCode,
  sealInvite,
} from "@family-budget/sync-crypto";

import { buildServer, type SyncServer } from "../src/server.ts";

export interface DeliveredCode {
  readonly email: string;
  readonly code: string;
}

export interface Harness {
  readonly server: SyncServer;
  readonly codes: DeliveredCode[];
  /** The log, as JSON lines, for the tests that check what does and does not reach it. */
  readonly logLines: string[];
  /** Milliseconds since the epoch, as the server sees them. Tests move it by hand. */
  now: number;
  advance(ms: number): void;
  close(): Promise<void>;
}

export interface Session {
  readonly accountId: string;
  readonly deviceId: string;
  readonly email: string;
  accessToken: string;
  refreshToken: string;
}

export interface Family {
  readonly familyId: string;
  readonly memberId: string;
  readonly rotationId: string;
}

const START = Date.UTC(2026, 0, 15, 9, 0, 0);

export function createHarness(options: { allowedOrigins?: readonly string[] } = {}): Harness {
  const codes: DeliveredCode[] = [];
  const logLines: string[] = [];
  const state = { now: START };
  const server = buildServer({
    databasePath: ":memory:",
    allowedOrigins: options.allowedOrigins ?? [],
    tokenSecret: new Uint8Array(32).fill(7),
    now: () => state.now,
    deliverLoginCode: (email, code) => codes.push({ email, code }),
    logLevel: "info",
    logStream: {
      write(chunk: string): boolean {
        logLines.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
  });
  return {
    server,
    codes,
    logLines,
    get now(): number {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
    advance(ms: number): void {
      state.now += ms;
    },
    async close(): Promise<void> {
      await server.close();
    },
  };
}

export interface Response {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: string;
  json(): any;
}

export async function call(
  harness: Harness,
  method: "GET" | "POST" | "DELETE" | "OPTIONS",
  url: string,
  init: { token?: string; payload?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  await harness.server.app.ready();
  const headers: Record<string, string> = { ...init.headers };
  if (init.token !== undefined) headers["authorization"] = `Bearer ${init.token}`;
  const response = await harness.server.app.inject({
    method,
    url,
    headers,
    ...(init.payload === undefined ? {} : { payload: init.payload as object }),
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers as Record<string, unknown>,
    body: response.body,
    json: () => JSON.parse(response.body),
  };
}

/** A registered, signed-in device. The public key is opaque to the server, so bytes will do. */
export async function signIn(
  harness: Harness,
  email = `user-${randomUUID()}@example.test`,
  deviceId = randomUUID(),
): Promise<Session> {
  const requested = await call(harness, "POST", "/v1/auth/code", { payload: { email } });
  if (requested.statusCode !== 202) throw new Error(`code request failed: ${requested.body}`);
  const delivered = harness.codes.at(-1);
  if (delivered === undefined) throw new Error("no code was delivered");
  const verified = await call(harness, "POST", "/v1/auth/verify", {
    payload: {
      email,
      code: delivered.code,
      deviceId,
      publicKey: Buffer.from(deviceId.replaceAll("-", ""), "hex").toString("base64"),
    },
  });
  if (verified.statusCode !== 200) throw new Error(`verify failed: ${verified.body}`);
  const tokens = verified.json();
  return {
    accountId: tokens.accountId,
    deviceId,
    email,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}

export async function createFamily(harness: Harness, owner: Session): Promise<Family> {
  const family: Family = {
    familyId: randomUUID(),
    memberId: randomUUID(),
    rotationId: randomUUID(),
  };
  const created = await call(harness, "POST", "/v1/families", {
    token: owner.accessToken,
    payload: family,
  });
  if (created.statusCode !== 201) throw new Error(`family creation failed: ${created.body}`);
  return family;
}

/**
 * A fresh access token for a session whose own has aged out.
 *
 * Necessary rather than decorative: an access token lives `15` minutes (6.1) and the rotation
 * timeouts of 5.5 are measured in half-hours and hours, so any test that moves the clock far
 * enough to reach a timeout has also moved it past its own credentials. The refresh token is
 * rotated on every use, so the session's copy is replaced too.
 */
export async function refreshSession(harness: Harness, session: Session): Promise<Session> {
  const response = await call(harness, "POST", "/v1/auth/refresh", {
    payload: { refreshToken: session.refreshToken },
  });
  if (response.statusCode !== 200) throw new Error(`refresh failed: ${response.body}`);
  const tokens = response.json();
  session.accessToken = tokens.accessToken;
  session.refreshToken = tokens.refreshToken;
  return session;
}

/** The bytes `signIn` registers as the device's SPKI. Opaque to the server, and stable per device. */
export function spkiOf(deviceId: string): Uint8Array {
  return new Uint8Array(Buffer.from(deviceId.replaceAll("-", ""), "hex"));
}

/**
 * A second account joined to the family by the real invite ceremony of 5.3 — sealed with
 * `sync-crypto`, claimed with the token, joined with a genuine `bindProof`. Anything shorter would
 * be testing a fixture rather than the route.
 */
export async function addMember(
  harness: Harness,
  owner: Session,
  family: Family,
): Promise<{ session: Session; memberId: string; inviteId: string }> {
  const inviteId = randomUUID();
  const sealed = await sealInvite({
    code: generateInviteCode(),
    familyId: family.familyId,
    keyEpoch: 1,
    inviteId,
    familyKey: await generateFamilyKey(),
    senderDeviceId: owner.deviceId,
    senderSpki: spkiOf(owner.deviceId),
    senderRole: "owner",
    senderMemberId: family.memberId,
  });
  const authToken = Buffer.from(sealed.issuerSecrets.authToken).toString("base64");
  const issued = await call(harness, "POST", `/v1/families/${family.familyId}/invites`, {
    token: owner.accessToken,
    payload: {
      familyId: sealed.record.familyId,
      keyEpoch: sealed.record.keyEpoch,
      inviteId: sealed.record.inviteId,
      iv: Buffer.from(sealed.record.iv).toString("base64"),
      ciphertext: Buffer.from(sealed.record.ciphertext).toString("base64"),
      authTokenDigest: Buffer.from(sealed.record.authTokenDigest).toString("base64"),
    },
  });
  if (issued.statusCode !== 201) throw new Error(`invite creation failed: ${issued.body}`);

  const session = await signIn(harness);
  const claimed = await call(harness, "POST", "/v1/invites/claim", {
    token: session.accessToken,
    payload: { authToken },
  });
  if (claimed.statusCode !== 200) throw new Error(`claim failed: ${claimed.body}`);

  const memberId = randomUUID();
  const bindProof = await computeBindProof(sealed.issuerSecrets.bindKey, {
    familyId: family.familyId,
    inviteId,
    deviceId: session.deviceId,
    spki: spkiOf(session.deviceId),
  });
  const joined = await call(harness, "POST", "/v1/invites/join", {
    token: session.accessToken,
    payload: {
      inviteId,
      authToken,
      memberId,
      bindProof: Buffer.from(bindProof).toString("base64"),
    },
  });
  if (joined.statusCode !== 201) throw new Error(`join failed: ${joined.body}`);
  return { session, memberId, inviteId };
}

export function envelope(
  familyId: string,
  deviceId: string,
  keyEpoch: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    envelopeVersion: 1,
    kind: "operation",
    familyId,
    opId: randomUUID(),
    deviceId,
    keyEpoch,
    iv: Buffer.alloc(12, 3).toString("base64"),
    ciphertext: Buffer.from("not a real ciphertext, and the server cannot tell").toString("base64"),
    ...overrides,
  };
}

export const uuid = randomUUID;
