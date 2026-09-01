/**
 * The Fastify application.
 *
 * The two hooks at the top are the executable half of 1.1: this server answers `application/json`
 * and nothing else, at any route, under any configuration, and it names the browser origins that
 * may talk to it instead of accepting all of them. The document is explicit that this is a
 * requirement on the code and not on the deployment — if the sync server can hand the browser one
 * script, compromising it becomes compromising the client and the end-to-end encryption is worth
 * nothing. No static handler is registered here, and there is no branch in which one could be.
 */
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { SyncServerConfig, SyncServerOptions } from "./config.ts";
import { resolveConfig } from "./config.ts";
import { ServerContext } from "./context.ts";
import { type Db, loadOrCreateTokenSecret, openDatabase } from "./db.ts";
import { ApiError } from "./errors.ts";
import { MAX_BATCH_BODY_BYTES } from "./limits.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerDeviceRoutes } from "./routes/devices.ts";
import { registerFamilyRoutes } from "./routes/families.ts";
import { registerInviteRoutes } from "./routes/invites.ts";
import { registerJournalRoutes } from "./routes/journal.ts";
import { registerKeyRoutes } from "./routes/keys.ts";
import { registerRotationRoutes } from "./routes/rotation.ts";

/**
 * One registered route, as the application itself saw it.
 *
 * The table is collected rather than written down because two invariants of the document are
 * statements about *every* route and are worthless when audited against a hand-kept list: 1.1 —
 * nothing but `application/json` leaves this server, at any route — and the rule that no endpoint
 * asks a device which key epoch it considers accepted (5.4.1, 2.2). A route added tomorrow and
 * forgotten by a test list would slip past both; a route added tomorrow appears here by itself.
 */
export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly schema: Readonly<Record<string, unknown>> | undefined;
}

export interface SyncServer {
  readonly app: FastifyInstance;
  readonly context: ServerContext;
  readonly config: SyncServerConfig;
  readonly db: Db;
  /** Every route this build registers, in registration order. See {@link RegisteredRoute}. */
  readonly routes: readonly RegisteredRoute[];
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export function buildServer(options: SyncServerOptions): SyncServer {
  const resolved = resolveConfig(options);
  const db = openDatabase(resolved.databasePath);
  // The secret is the database's when the caller does not bring one: it authenticates rows that
  // outlive the process — the login codes of 6.1 — and a value regenerated at every start would
  // refuse them all, in the words reserved for a wrong code.
  const config: SyncServerConfig = {
    ...resolved,
    tokenSecret: resolved.tokenSecret ?? loadOrCreateTokenSecret(db, resolved.now()),
  };
  const context = new ServerContext(db, config);

  const app = Fastify({
    bodyLimit: MAX_BATCH_BODY_BYTES,
    logger:
      config.logStream === undefined
        ? { level: config.logLevel ?? "warn" }
        : { level: config.logLevel ?? "info", stream: config.logStream },
    // Request logging is left at Fastify's default, which records the method, the route and the
    // status and nothing from the body. 6.1 codes, both tokens and every envelope live in bodies,
    // so keeping bodies out of the log is the whole of the plan's "no tokens and no codes in the
    // logs" — there is no field to redact because no body is written in the first place.
    ajv: {
      customOptions: {
        // Fastify's default is `removeAdditional: true`, which silently *deletes* a property that
        // `additionalProperties: false` forbids instead of refusing the request. On the invite
        // route that default would be a security defect: a body carrying `authToken` beside the
        // wire record would be accepted, quietly stripped, and the client would never learn that
        // it had just sent the server a secret 5.3 forbids it to see. Refusal, not repair.
        removeAdditional: false,
        // No coercion either. Every field on this wire has one type; a string silently becoming a
        // number is how a `keyEpoch` of `"1e400"` turns into `Infinity` somewhere downstream.
        coerceTypes: false,
        useDefaults: false,
        allErrors: false,
      },
    },
  });

  const routes: RegisteredRoute[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      routes.push({
        method,
        url: route.url,
        schema: route.schema as Readonly<Record<string, unknown>> | undefined,
      });
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    // Security headers, and then the invariant of 1.1 as a hard stop rather than a convention.
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
    if (payload === null || payload === undefined || payload === "") {
      reply.removeHeader("content-type");
      return payload;
    }
    const contentType = reply.getHeader("content-type");
    if (typeof contentType === "string" && contentType.startsWith("application/json")) {
      return payload;
    }
    // Reaching here means a handler produced something that is not JSON. There is no such handler
    // today; the point of the check is that adding one is a visible failure rather than a quiet
    // erosion of the boundary this server exists to keep.
    reply.code(500);
    reply.header("content-type", JSON_CONTENT_TYPE);
    return JSON.stringify({
      error: {
        code: "non_json_response",
        message: "the sync server answers application/json only",
      },
    });
  });

  app.addHook("onRequest", async (request, reply) => {
    // CORS by explicit allowlist (1.1), never `*`; `resolveConfig` refuses a wildcard outright.
    // An origin that is not on the list simply gets no CORS headers and the browser stops there;
    // the request itself is not refused, because non-browser clients send no `Origin` at all.
    const origin = request.headers.origin;
    if (typeof origin === "string" && config.allowedOrigins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
    }
  });

  // Preflight, answered with no body and therefore with no content type of any kind.
  const preflight = (request: FastifyRequest, reply: FastifyReply): void => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && config.allowedOrigins.includes(origin)) {
      reply.header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      reply.header("access-control-allow-headers", "content-type, authorization");
      reply.header("access-control-max-age", "600");
    }
    void reply.code(204).send();
  };
  app.route({ method: "OPTIONS", url: "/", handler: preflight });
  app.route({ method: "OPTIONS", url: "/*", handler: preflight });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).header("content-type", JSON_CONTENT_TYPE).send(
      JSON.stringify({
        error: { code: "not_found", message: `no route for ${request.method} ${request.url}` },
      }),
    );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      // A refusal a route wrote, answered in the route's own words — with one exception, and it is
      // the rule `internal` states in `errors.ts`: "the cause is logged without a body; the client
      // is told nothing else". An `ApiError` of `500` is the server's account of a state it did not
      // expect, not something the caller can act on, and three of them ("epoch row is missing")
      // used to travel to the client verbatim and leave no trace in the log at all — while the
      // branch at the end of this handler logged every other five-hundred and replaced its message.
      // One rule, applied wherever the status says five hundred.
      if (error.statusCode >= 500) {
        request.log.error(
          { err: error.name, code: error.code, cause: error.message },
          "unhandled error",
        );
        void reply
          .code(error.statusCode)
          .header("content-type", JSON_CONTENT_TYPE)
          .send(JSON.stringify({ error: { code: error.code, message: "internal error" } }));
        return;
      }
      void reply
        .code(error.statusCode)
        .header("content-type", JSON_CONTENT_TYPE)
        .send(
          JSON.stringify({
            error: { code: error.code, message: error.message, ...error.details },
          }),
        );
      return;
    }
    if (error.validation !== undefined) {
      void reply
        .code(400)
        .header("content-type", JSON_CONTENT_TYPE)
        .send(
          JSON.stringify({
            error: { code: "invalid_request", message: error.message },
          }),
        );
      return;
    }
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      void reply
        .code(413)
        .header("content-type", JSON_CONTENT_TYPE)
        .send(
          JSON.stringify({
            error: { code: "batch_too_large", message: "request body exceeds the wire limit" },
          }),
        );
      return;
    }
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode >= 500) request.log.error({ err: error.name }, "unhandled error");
    void reply
      .code(statusCode)
      .header("content-type", JSON_CONTENT_TYPE)
      .send(
        JSON.stringify({
          error: {
            code: statusCode >= 500 ? "internal" : "invalid_request",
            message: statusCode >= 500 ? "internal error" : error.message,
          },
        }),
      );
  });

  registerAuthRoutes(app, context);
  registerDeviceRoutes(app, context);
  registerFamilyRoutes(app, context);
  registerInviteRoutes(app, context);
  registerJournalRoutes(app, context);
  registerKeyRoutes(app, context);
  registerRotationRoutes(app, context);

  return {
    app,
    context,
    config,
    db,
    routes,
    async listen({ host, port }) {
      return app.listen({ host, port });
    },
    async close() {
      await app.close();
      db.close();
    },
  };
}
