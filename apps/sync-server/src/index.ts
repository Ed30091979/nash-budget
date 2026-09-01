/**
 * The package surface: a server one can build, and the numbers a caller may need to build one.
 *
 * Nothing that touches a request is exported. Everything reaches the outside through `buildServer`,
 * so there is no way to obtain the database or the token secret without also having the
 * configuration that produced them.
 */
export { buildServer } from "./server.ts";
export type { RegisteredRoute, SyncServer } from "./server.ts";
export type { LoginCodeSink, SyncServerConfig, SyncServerOptions } from "./config.ts";
export { API_ERROR_CODES } from "./errors.ts";
export type { ApiErrorCode } from "./errors.ts";
