import { spawn } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.E2E_PORT);

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("E2E_PORT is missing or invalid.");
}

const buildIds = {
  A: "phase8-e2e-a",
  B: "phase8-e2e-b",
};
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

let activeBuild = "A";
let activeBuildProcess = null;
let builds = null;
let cleanupPromise = null;
let requestedSignal = null;
let securityHeaders = null;
let server = null;
let tempDirectory = null;

async function stopActiveBuild() {
  const child = activeBuildProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  await new Promise((resolveStop) => {
    let completed = false;
    let forceTimer;
    let fallbackTimer;
    const complete = () => {
      if (completed) return;
      completed = true;
      clearTimeout(forceTimer);
      clearTimeout(fallbackTimer);
      resolveStop();
    };

    child.once("close", complete);
    child.once("error", complete);
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      fallbackTimer = setTimeout(complete, 1_000);
    }, 2_000);
  });
}

async function cleanup(exitCode = 0) {
  process.exitCode = Math.max(process.exitCode ?? 0, exitCode);
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      await stopActiveBuild();
      if (server?.listening) {
        await new Promise((resolveClose) => server.close(resolveClose));
      }
      if (tempDirectory) {
        rmSync(tempDirectory, { recursive: true, force: true });
        tempDirectory = null;
      }
    })();
  }
  await cleanupPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    requestedSignal = signal;
    void cleanup(1);
  });
}

function runBuild(label) {
  if (!builds) {
    return Promise.reject(new Error("E2E build directories are not initialized."));
  }

  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(
      "pnpm",
      ["exec", "vite", "build", "--outDir", builds[label], "--emptyOutDir"],
      {
        cwd: appDirectory,
        env: {
          ...process.env,
          PWA_BUILD_ID: buildIds[label],
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    activeBuildProcess = child;
    let output = "";
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (activeBuildProcess === child) activeBuildProcess = null;
      if (error) rejectBuild(error);
      else resolveBuild();
    };

    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => settle(error));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        settle();
        return;
      }
      settle(
        new Error(
          `Production build ${label} failed (${signal ?? code}).\n${output}`,
        ),
      );
    });
  });
}

function setHeaders(response, pathname) {
  if (!securityHeaders) {
    throw new Error("Security headers are not initialized.");
  }
  for (const [name, value] of Object.entries(securityHeaders)) {
    response.setHeader(name, value);
  }
  if (
    pathname === "/" ||
    pathname.endsWith(".html") ||
    pathname.endsWith("/sw.js") ||
    pathname.endsWith("/build-meta.json") ||
    pathname.endsWith("/manifest.webmanifest")
  ) {
    response.setHeader("Cache-Control", "no-store");
  }
  if (pathname.endsWith("/sw.js")) {
    response.setHeader("Service-Worker-Allowed", "/");
  }
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

function handleRequest(request, response) {
  let requestUrl;
  try {
    requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  } catch {
    setHeaders(response, "/");
    response.statusCode = 400;
    response.end("Invalid URL.");
    return;
  }
  setHeaders(response, requestUrl.pathname);

  if (requestUrl.pathname === "/__e2e__/health") {
    sendJson(response, 200, {
      ready: true,
      activeBuild,
      buildId: buildIds[activeBuild],
    });
    return;
  }

  if (requestUrl.pathname === "/__e2e__/switch-build") {
    if (
      request.method !== "POST" ||
      request.headers.origin !== `http://127.0.0.1:${port}`
    ) {
      sendJson(response, 403, { switched: false });
      return;
    }
    activeBuild = "B";
    sendJson(response, 200, {
      switched: true,
      activeBuild,
      buildId: buildIds.B,
    });
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestUrl.pathname);
  } catch {
    response.statusCode = 400;
    response.end("Invalid path encoding.");
    return;
  }

  const buildRoot = builds?.[activeBuild];
  if (!buildRoot) {
    response.statusCode = 503;
    response.end("Build is unavailable.");
    return;
  }
  const requestedPath = resolve(buildRoot, `.${decodedPath}`);
  const insideBuild =
    requestedPath === buildRoot || requestedPath.startsWith(`${buildRoot}${sep}`);
  const filePath =
    insideBuild && existsSync(requestedPath) && statSync(requestedPath).isFile()
      ? requestedPath
      : join(buildRoot, "index.html");

  if (!insideBuild || relative(buildRoot, filePath).startsWith("..")) {
    response.statusCode = 400;
    response.end("Invalid path.");
    return;
  }

  response.statusCode = 200;
  response.setHeader(
    "Content-Type",
    contentTypes[extname(filePath)] ?? "application/octet-stream",
  );
  createReadStream(filePath).pipe(response);
}

async function listen() {
  server = createServer(handleRequest);
  await new Promise((resolveListen, rejectListen) => {
    const rejectStartup = (error) => rejectListen(error);
    server.once("error", rejectStartup);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectStartup);
      server.on("error", (error) => {
        process.stderr.write(`${error.stack ?? error}\n`);
        void cleanup(1);
      });
      resolveListen();
    });
  });
}

async function start() {
  tempDirectory = mkdtempSync(join(tmpdir(), "family-budget-e2e-"));
  builds = {
    A: join(tempDirectory, "build-a"),
    B: join(tempDirectory, "build-b"),
  };
  securityHeaders = JSON.parse(
    readFileSync(join(appDirectory, "security-headers.json"), "utf8"),
  );

  await runBuild("A");
  await runBuild("B");
  await listen();
  process.stdout.write(
    `Phase 8 E2E server ready on http://127.0.0.1:${port} with ${buildIds.A} and ${buildIds.B}.\n`,
  );
}

try {
  await start();
} catch (error) {
  if (!requestedSignal) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  }
  await cleanup(1);
}
