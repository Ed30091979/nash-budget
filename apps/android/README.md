# Android local build

This directory contains the Capacitor 8.4.2 Android shell for the offline
family-budget web application. It is a local release-candidate pipeline, not a
RuStore publication setup.

## Compatibility decision

- `minSdk 24` is the Capacitor 8 generated minimum and keeps Android 7.0 as the
  oldest supported local test target.
- `compileSdk 36` and `targetSdk 36` match the installed Android SDK and the
  generated Capacitor 8.4.2 project.
- Gradle uses the generated wrapper `8.14.3`, Android Gradle Plugin `8.13.0`,
  and JDK 21. Capacitor 8.4.2 compiles its Android sources with Java 21, so
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

## Security and publication boundary

The app requests no Android system or runtime permissions. AndroidX contributes
one app-scoped, signature-protected permission used to keep dynamic receivers
non-exported; it cannot be granted to an unrelated app. All UI assets are
packaged locally; the Capacitor configuration contains no `server` block,
live-reload host, or remote navigation allowlist. Mixed content, cleartext
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
