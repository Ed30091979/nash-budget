/**
 * Что упакованная страница говорит про сервер семьи — и что из этого обязан следовать манифест.
 *
 * Адрес сервера задаётся конфигурацией веб-сборки (`VITE_SYNC_SERVER_URL`, §9) и приезжает в APK
 * внутри `index.html`: Vite вписывает его источник в `connect-src` политики. Здесь эта же страница
 * читается второй раз и независимо от `app/build.gradle`, который по ней решал, класть ли в
 * манифест `INTERNET`. Две реализации одного правила стоят рядом намеренно: сканер проверяет не
 * намерение сборки, а результат, и расхождение между политикой страницы и разрешениями пакета —
 * это ровно тот дефект, который иначе виден только на устройстве и выглядит как отказ сервера.
 */

/** Единственное системное разрешение, которое эта обёртка вправе запросить, и только под адрес. */
export const INTERNET_PERMISSION = "android.permission.INTERNET";

const META_CSP = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/iu;
const CONNECT_SRC = /(?:^|;)\s*connect-src\s+([^;]*)/u;

/**
 * Источник, до которого WebView этой обёртки способен дойти: только `https`, схема-хост-порт.
 *
 * `http` отвергается не из строгости, а потому что он не работает: страница исполняется по адресу
 * `https://localhost` (Capacitor `androidScheme` по умолчанию), и незащищённый запрос из неё
 * блокируется дважды — правилом смешанного содержимого WebView и `cleartextTrafficPermitted=false`
 * в сетевой политике приложения. Сборка с `http`-адресом собирается, ставится и молча не
 * синхронизируется; поэтому она обязана не собираться.
 */
const REACHABLE_ORIGIN = /^https:\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/iu;

/**
 * Адрес сервера семьи, прочитанный из упакованной страницы; `null` — сборка по умолчанию.
 *
 * Бросает, а не возвращает `null`, на всём, что не является ни «адреса нет», ни «адрес один и
 * достижим»: отсутствие политики, отсутствие `connect-src`, несколько удалённых источников,
 * `http`, звёздочка. Каждый из этих случаев — не отсутствие настройки, а настройка, которую
 * нельзя выпускать.
 */
export function resolveConfiguredSyncOrigin(indexHtml) {
  const policy = indexHtml.match(META_CSP)?.[1];
  if (policy === undefined) {
    throw new Error("packaged index.html carries no Content-Security-Policy meta tag");
  }
  const connectSrc = policy.replace(/\s+/gu, " ").match(CONNECT_SRC)?.[1];
  if (connectSrc === undefined) {
    throw new Error("packaged Content-Security-Policy has no connect-src directive");
  }
  const remote = connectSrc
    .trim()
    .split(" ")
    .filter((source) => source.length > 0 && source !== "'self'");
  if (remote.length === 0) {
    return null;
  }
  if (remote.length > 1) {
    throw new Error(`packaged connect-src names more than one source: ${remote.join(" ")}`);
  }
  const [origin] = remote;
  if (!REACHABLE_ORIGIN.test(origin)) {
    throw new Error(
      `packaged connect-src names ${origin}, which this shell cannot reach: the app runs at ` +
        "https://localhost, and both the WebView mixed-content rule and the app network security " +
        "config refuse anything but https to a named host",
    );
  }
  return origin;
}

/**
 * Разрешения, которые обязаны быть в собранном манифесте, — по одному на причину и ни одного про
 * запас. `INTERNET` появляется тогда и только тогда, когда странице разрешено кому-то звонить.
 */
export function expectedManifestPermissions(receiverPermission, syncServerOrigin) {
  return syncServerOrigin === null
    ? [receiverPermission]
    : [receiverPermission, INTERNET_PERMISSION];
}
