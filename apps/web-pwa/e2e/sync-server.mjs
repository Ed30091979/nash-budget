/**
 * Настоящий сервер синхронизации, поднятый рядом с e2e и только на петле.
 *
 * Это `apps/sync-server` как есть, отдельным процессом и по настоящему HTTP: подменять его здесь
 * нечем и незачем. Вся фаза S7 — про стык, а обе половины стыка по отдельности уже зелёные, так
 * что единственная проверка, которой ещё не было, — та, где браузер разговаривает с сервером,
 * который написан отдельно от него.
 *
 * Одноразовый код входа берётся из `stdout` процесса: `main.ts` печатает его туда потому, что
 * почтового транспорта в плане нет, и это единственное место, где код покидает процесс. Тест
 * читает его оттуда же, где его прочитал бы человек, и никакого «тестового режима» серверу для
 * этого не добавляется.
 *
 * Наружу ничего не выставляется: адрес всегда `127.0.0.1`, порт — эфемерный, база — файл во
 * временном каталоге прогона.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const SYNC_SERVER_ENTRY = resolve(
  import.meta.dirname,
  "..",
  "..",
  "sync-server",
  "src",
  "main.ts",
);

/** `login code for <адрес>: <шесть цифр>` — единственная строка, ради которой читается вывод. */
const LOGIN_CODE_LINE = /^login code for (?<email>\S+): (?<code>\d{6})$/u;
const READY_LINE = /^sync server listening on /u;

export function reserveEphemeralPort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Could not allocate an isolated sync-server port.")));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

export class LocalSyncServer {
  #child = null;
  #codes = new Map();
  #log = "";
  #pending = null;

  /**
   * @param {{ port: number, databasePath: string, allowedOrigin: string }} options
   */
  constructor(options) {
    this.port = options.port;
    this.databasePath = options.databasePath;
    this.allowedOrigin = options.allowedOrigin;
    this.url = `http://127.0.0.1:${options.port}`;
  }

  get running() {
    const child = this.#child;
    return child !== null && child.exitCode === null && child.signalCode === null;
  }

  /**
   * Последний код, который сервер выдал этому адресу.
   *
   * Коды не накапливаются по адресу: повторный запрос обесценивает прежний, и тест, взявший
   * несвежий код, проверял бы не то, что проверяет человек.
   */
  loginCodeFor(email) {
    return this.#codes.get(email.trim().toLowerCase()) ?? null;
  }

  #consume(chunk) {
    this.#log += chunk;
    const lines = this.#log.split("\n");
    this.#log = lines.pop() ?? "";
    for (const line of lines) {
      const match = LOGIN_CODE_LINE.exec(line.trim());
      if (match?.groups) {
        this.#codes.set(match.groups.email.trim().toLowerCase(), match.groups.code);
        continue;
      }
      if (READY_LINE.test(line.trim()) && this.#pending !== null) {
        this.#pending.resolveReady();
      }
    }
  }

  async start() {
    if (this.running) return;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", SYNC_SERVER_ENTRY],
      {
        cwd: resolve(SYNC_SERVER_ENTRY, "..", ".."),
        env: {
          ...process.env,
          SYNC_PORT: String(this.port),
          SYNC_HOST: "127.0.0.1",
          SYNC_DATABASE: this.databasePath,
          SYNC_ALLOWED_ORIGINS: this.allowedOrigin,
          SYNC_LOG_LEVEL: "silent",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#consume(chunk));
    child.stderr.on("data", (chunk) => {
      process.stderr.write(`sync-server: ${chunk}`);
    });

    await new Promise((resolveReady, reject) => {
      const settle = { resolveReady: () => {
        this.#pending = null;
        clearTimeout(timer);
        resolveReady();
      } };
      this.#pending = settle;
      const timer = setTimeout(() => {
        this.#pending = null;
        reject(new Error("the local sync server did not report readiness in 20 s"));
      }, 20_000);
      child.once("exit", (code, signal) => {
        if (this.#pending === null) return;
        this.#pending = null;
        clearTimeout(timer);
        reject(new Error(`the local sync server exited before it was ready (${signal ?? code})`));
      });
    });
  }

  /**
   * Останавливает сервер и ждёт, пока порт освободится.
   *
   * Ждать обязательно: сценарий «сервер недоступен» проверяет отказ соединения, а не гонку с
   * закрывающимся сокетом, и перезапуск после него должен получить тот же порт обратно.
   */
  async stop() {
    const child = this.#child;
    if (child === null) return;
    this.#child = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolveStop) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(force);
        clearTimeout(fallback);
        resolveStop();
      };
      let fallback;
      child.once("close", finish);
      child.once("error", finish);
      child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        fallback = setTimeout(finish, 1_000);
      }, 2_000);
    });
  }
}
