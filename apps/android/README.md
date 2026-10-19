# Android local build

This directory contains the Capacitor 8.4.3 Android shell for the offline
family-budget web application. It is a local release-candidate pipeline, not a
RuStore publication setup.

## Compatibility decision

- `minSdk 24` is the Capacitor 8 generated minimum and keeps Android 7.0 as the
  oldest supported local test target.
- `compileSdk 36` and `targetSdk 36` match the installed Android SDK and the
  generated Capacitor 8.4.3 project.
- Gradle uses the generated wrapper `8.14.3`, Android Gradle Plugin `8.13.0`,
  and JDK 21. Capacitor 8.4.3 compiles its Android sources with Java 21, so
  JDK 17 is not compatible with this generated project.
- Local test identity is `versionCode 1`, `versionName 0.1.0-local`.
- `ru.familybudget.app` remains provisional until the owner confirms the final
  store package name.

## Reproducible local-assets build

Set `JAVA_HOME` to JDK 21 and `ANDROID_HOME` to the Android SDK, then run:

```sh
pnpm --filter @family-budget/android verify:android
```

`sync` performs exactly one production web build and copies its output to
`android/app/src/main/assets/public` before Gradle runs. `sync:from-dist` is
available only when a production `apps/web-pwa/dist` has already been built and
verified in the same pipeline.

The verification pipeline runs unit tests, Android lint, a debug APK build, an
unsigned local release AAB build, and the Android artifact/security scanner.
Generated assets, build outputs, local SDK paths, and signing material are
ignored by Git.

## System Back

`MainActivity` registers an `OnBackPressedCallback`: Back walks the WebView
history while it can (`canGoBack()` → `goBack()`), and otherwise hands the press
to the system, which leaves the app. The web app keeps its routes in that
history (the address hash, `apps/web-pwa/src/navigation/`), so Back from a
subscreen lands on its parent, from a tab on «Обзор», and an unsaved draft is
asked about in the app's own dialog. `scripts/native-source-policy.mjs` checks
the shape of the callback in the node tests and in the artifact scan. This was
written without an Android SDK: run `verify:android` and press Back on an
emulator (a subscreen, a tab, «Обзор», and a typed amount on «+») before the
release.

## Family sync: configuring the server address

The address of the family sync server is configuration of the **web** build and
lives nowhere else. It is read from `VITE_SYNC_SERVER_URL` at Vite build time
and reaches the APK inside the packaged page: the address is inlined into the
bundle and added to the `connect-src` directive of the page content policy.
There is no production URL anywhere in this repository, and a build that is not
given one is the default.

```sh
# Default: a fully local application. No address, no network permission, no sync.
pnpm --filter @family-budget/android verify:android

# Configured: working sync against one named https server.
VITE_SYNC_SERVER_URL=https://sync.example.org \
  pnpm --filter @family-budget/android verify:android
```

`app/build.gradle` derives one thing from that page — whether the app needs
`android.permission.INTERNET` — by looking at the `connect-src` of the
`index.html` it is about to package, and merges `src/sync/AndroidManifest.xml`
when it does. Reading the packaged bytes rather than the environment variable is
deliberate: the permission and the address cannot then disagree, which is the
one failure that is invisible until the app is on a device.
`scripts/verify-artifacts.mjs` re-derives the same fact from the built artifact
with its own implementation and fails if the merged manifest does not match.

The address must be `https`. This is not strictness, it is arithmetic: the
Capacitor WebView runs the page at `https://localhost` (`androidScheme`
defaults to `https`), so an `http://` address is refused as mixed content
before the socket is opened, and the app's network security config refuses
cleartext besides. A build configured with an `http` address installs and can
never sync, so both `release:scan` and the Android artifact scan reject it.

Verified in the emulator (Android 15, WebView 124) with a debug build pointed at
a local https server:

- the page origin is `https://localhost` and `isSecureContext` is `true`, so
  `crypto.subtle` is present — an AES-GCM round trip with additional data, an
  ECDH P-256 key pair and an HMAC-SHA-256 signature all succeed;
- IndexedDB reads and writes normally;
- `fetch` is the platform's own (the `CapacitorHttp` plugin is off, so nothing
  patches it) and reaches the configured https origin, preflight included;
- a request to an origin the policy does not name is refused by CSP; a request
  to an `http://` origin the policy *does* name is refused as mixed content;
- with the same page and the same policy but no `INTERNET` permission, every
  request fails as `net::ERR_CACHE_MISS` — which is why the permission is not
  optional and why the scan checks it.

Because the WebView is a browser, its requests carry `Origin: https://localhost`
and CORS applies in full: a preflight `OPTIONS` precedes every call, since the
transport sends `authorization` and `content-type`. The sync server must
therefore name `https://localhost` in its CORS allowlist (`SYNC_ALLOWED_ORIGINS`)
in addition to the origin the PWA is served from.

## Palette: what the shell paints before the first web frame

Everything Android draws before the page paints its first frame - the system
splash on Android 12+, the activity window and its pre-12 splash drawable, the
status and navigation bars, the WebView background, the launcher icon backdrop
- is the application's canvas, and nothing in the shell has a dark mode: the
app itself is light-only (`color-scheme: light`), so a `DayNight` theme here
would paint a dark frame between a light launcher and a light page. That seam
existed: the shell kept `#100904` from the 1.0.0 dark design after the web app
moved to paper, and on Android 12+ the system splash showed the compat
library's generic Android icon because none was named.

The source of the colours is `:root` in `../web-pwa/src/styles.css`
(`--canvas`, `--ink`, `--orange`). `res/values/colors.xml` is the only place
in the shell that spells them out; `capacitor.config.ts` carries `--canvas` as
the WebView background and pins the core `SystemBars` plugin to `style: "LIGHT"`
(its `DEFAULT` follows the system night mode and turned the status-bar glyphs
white over the canvas); themes, the splash drawable and the adaptive icons
reference `colors.xml` and contain no hex. `scripts/brand-palette.mjs` compares
all of that with the stylesheet, `scripts/brand-palette.test.mjs` runs it as
part of `pnpm test`, and `scripts/verify-artifacts.mjs` runs it again against
the `capacitor.config.json` packaged in the APK and AAB.

Rasters (`splash_logo`, `ic_launcher_foreground`, legacy `ic_launcher` and
`ic_launcher_round`, five densities each) are drawn from the same mark as the
PWA icon and the iOS launch images by `pnpm render:brand`: Chromium via the
web app's Playwright, packed with the web app's PNG codec, no downloads and no
extra dependencies. Re-run it whenever `:root` changes; the test fails until
you do.

## Security and publication boundary

Apart from `INTERNET` in a build that was given a server address, the app
requests no Android system or runtime permissions, and the default build
requests none at all. AndroidX contributes one app-scoped,
signature-protected permission used to keep dynamic receivers non-exported; it
cannot be granted to an unrelated app. All UI assets are packaged locally; the
Capacitor configuration contains no `server` block, live-reload host, or remote
navigation allowlist — where the application is loaded from and which API it
calls are separate questions, and only the first one is settled in that file. Mixed content, cleartext
traffic, WebView debugging, native logging, Android backup, and device-transfer
extraction are disabled. Google Services, analytics, push notifications, and
their Gradle plugin are deliberately absent.

The launcher activity is the only exported component because Android requires
the activity handling `MAIN`/`LAUNCHER` to be exported. The Capacitor
`FileProvider` remains non-exported and grants URI access explicitly.

The release build has no signing configuration. Do not add a keystore to this
repository. Final package naming, production signing-key creation and backup,
real-device verification, RuStore upload, and every rollout action are manual
owner gates.

Sync adds three more owner gates, none of which can be automated here: a domain
for the sync server, a TLS certificate for it from a publicly trusted authority
(the app trusts system anchors only, so a self-signed or privately issued
certificate is refused on device), and hosting to run it on. Until those exist
there is no address to configure, and the default local build is the only one
that can be produced.
