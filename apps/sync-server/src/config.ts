/**
 * Server configuration, resolved once and never re-read.
 *
 * Two fields carry requirements rather than preferences. `allowedOrigins` is the explicit CORS
 * allowlist of 1.1 — `"*"` is rejected here, at construction, rather than checked at request time,
 * because a wildcard would make the separation between the delivery origin and the sync server
 * unverifiable. `deliverLoginCode` is the only way a one-time code leaves the process: the request
 * logger never sees it, and there is no default that writes it anywhere.
 */
export type LoginCodeSink = (email: string, code: string) => void;

export interface SyncServerConfig {
  /** `":memory:"` in tests, a file path in `dev`. */
  readonly databasePath: string;
  /**
   * Browser origins allowed to call this server (1.1). `"*"` is not accepted.
   *
   * An empty list is still a legitimate configuration, but it means "no client may call it at
   * all" — not "browsers may not, the app may". The Android shell has an origin like any other
   * browser: Capacitor serves the page over `https` (`androidScheme` defaults to it), so the
   * WebView runs at `https://localhost` and sends `Origin: https://localhost` on every call,
   * preceded by a preflight because the transport carries `authorization` and `content-type`.
   * Measured on the emulator in phase S9; see `apps/android/README.md`. A deployment that serves
   * the Android app must therefore name `https://localhost` here, beside the origin the PWA is
   * delivered from, or every request from the app is blocked by the WebView.
   */
  readonly allowedOrigins: readonly string[];
  /** Secret behind the access-token MAC and the login-code MAC. */
  readonly tokenSecret: Uint8Array;
  /** Injectable clock. Rotation timeouts of 5.5 are hours long and untestable on the wall clock. */
  readonly now: () => number;
  /** Stands in for e-mail (6.1). Phase S3 ships no transport; the sink is supplied by the caller. */
  readonly deliverLoginCode: LoginCodeSink;
  /** Pino destination. Tests point it at a buffer to prove what does and does not reach the log. */
  readonly logStream?: NodeJS.WritableStream;
  readonly logLevel?: string;
}

export interface SyncServerOptions {
  readonly databasePath?: string;
  readonly allowedOrigins?: readonly string[];
  readonly tokenSecret?: Uint8Array;
  readonly now?: () => number;
  readonly deliverLoginCode: LoginCodeSink;
  readonly logStream?: NodeJS.WritableStream;
  readonly logLevel?: string;
}

/**
 * Everything the configuration fixes except the token secret.
 *
 * The secret is resolved after the database is open, because when the caller does not supply one
 * it is *loaded* rather than generated — see `loadOrCreateTokenSecret`. Leaving a freshly random
 * value here was how a restart silently invalidated every login code in a file database.
 */
export type ResolvedConfig = Omit<SyncServerConfig, "tokenSecret"> & {
  readonly tokenSecret?: Uint8Array;
};

export function resolveConfig(options: SyncServerOptions): ResolvedConfig {
  const allowedOrigins = [...(options.allowedOrigins ?? [])];
  for (const origin of allowedOrigins) {
    if (origin === "*") {
      throw new Error(
        'CORS allowlist may not contain "*": SYNC_ARCHITECTURE.md 1.1 requires the delivery origin ' +
          "to be separated from the sync server by an explicit list of origins",
      );
    }
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
      throw new Error(`not an origin: ${origin}`);
    }
  }
  return {
    databasePath: options.databasePath ?? ":memory:",
    allowedOrigins,
    ...(options.tokenSecret === undefined ? {} : { tokenSecret: options.tokenSecret }),
    now: options.now ?? (() => Date.now()),
    deliverLoginCode: options.deliverLoginCode,
    ...(options.logStream === undefined ? {} : { logStream: options.logStream }),
    ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
  };
}
