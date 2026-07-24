import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Could not allocate an isolated E2E port.")));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

const port = await reserveEphemeralPort();
const outputDirectory = mkdtempSync(join(tmpdir(), "family-budget-playwright-"));
const child = spawn(
  "pnpm",
  ["exec", "playwright", "test", "--config", "playwright.config.ts"],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      E2E_PORT: String(port),
      E2E_OUTPUT_DIR: outputDirectory,
    },
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

let exitCode = 1;
try {
  exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Playwright was terminated by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
process.exitCode = exitCode;
