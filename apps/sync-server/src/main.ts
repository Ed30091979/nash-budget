/**
 * `pnpm --filter @family-budget/sync-server dev` — the local server of the plan's phase S3.
 *
 * It is deliberately thin, and two of its lines are requirements rather than convenience. The CORS
 * allowlist comes from `SYNC_ALLOWED_ORIGINS` and is empty when unset: 1.1 wants the browser
 * origins named, and an empty list is a legitimate answer ("no browser may call it") while a
 * wildcard is not one at all — `resolveConfig` refuses `"*"` outright. And the login code is
 * printed to the console because phase S3 ships no mail transport; that is the one place a code
 * leaves the process, and it is visible in the source rather than hidden behind a default.
 */
import { buildServer } from "./server.ts";

const port = Number(process.env["SYNC_PORT"] ?? 8787);
const host = process.env["SYNC_HOST"] ?? "127.0.0.1";
const databasePath = process.env["SYNC_DATABASE"] ?? "./sync-server.sqlite";
const allowedOrigins = (process.env["SYNC_ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const server = buildServer({
  databasePath,
  allowedOrigins,
  logLevel: process.env["SYNC_LOG_LEVEL"] ?? "info",
  deliverLoginCode: (email, code) => {
    process.stdout.write(`login code for ${email}: ${code}\n`);
  },
});

const address = await server.listen({ host, port });
process.stdout.write(`sync server listening on ${address}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
