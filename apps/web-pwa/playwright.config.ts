import { defineConfig, devices } from "@playwright/test";
import { isAbsolute } from "node:path";

const port = Number(process.env.E2E_PORT);
const outputDir = process.env.E2E_OUTPUT_DIR;

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("E2E_PORT must be an available TCP port selected by e2e/run.mjs.");
}
if (!outputDir || !isAbsolute(outputDir)) {
  throw new Error("E2E_OUTPUT_DIR must be an isolated absolute temporary directory.");
}

const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  outputDir,
  expect: {
    timeout: 10_000,
  },
  reporter: [["line"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node ./e2e/server.mjs",
    url: `${baseURL}/__e2e__/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
