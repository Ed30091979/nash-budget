/**
 * Опрос семьи спит вместе со вкладкой.
 *
 * До этой правки круг шёл каждые пятнадцать секунд всегда — и в свёрнутом браузере, и на телефоне
 * с погашенным экраном. Здесь проверяется не «интервал стал больше», а то, что скрытая вкладка не
 * делает ни одного круга, и что возвращение догоняет пропущенное сразу, а не через интервал.
 *
 * Часы, таймеры и подписка — параметры, поэтому проверка идёт без браузера и без ожидания.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SyncClientError, SyncServerError } from "@family-budget/sync-client";

import { runSyncRound, startVisibilityAwarePolling, type VisibilityAwarePoll } from "./controller";

function harness(startsHidden = false) {
  let hidden = startsHidden;
  let nextHandle = 1;
  const timers = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  const rounds: string[] = [];

  const poll: VisibilityAwarePoll = {
    intervalMs: 15_000,
    run: () => rounds.push(hidden ? "hidden" : "visible"),
    isHidden: () => hidden,
    setInterval: (callback) => {
      const handle = nextHandle++;
      timers.set(handle, callback);
      return handle;
    },
    clearInterval: (handle) => {
      timers.delete(handle);
    },
    onVisibilityChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    poll,
    rounds,
    get timerCount() {
      return timers.size;
    },
    get listenerCount() {
      return listeners.size;
    },
    tick(times = 1) {
      for (let index = 0; index < times; index += 1) {
        for (const callback of [...timers.values()]) callback();
      }
    },
    setHidden(value: boolean) {
      hidden = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("опрос семьи и видимость вкладки", () => {
  it("видимая вкладка опрашивает сразу и дальше по интервалу", () => {
    const test = harness();
    startVisibilityAwarePolling(test.poll);

    expect(test.rounds).toEqual(["visible"]);
    test.tick(2);
    expect(test.rounds).toEqual(["visible", "visible", "visible"]);
  });

  it("скрытая вкладка не делает ни одного круга и не держит таймера", () => {
    const test = harness();
    startVisibilityAwarePolling(test.poll);
    test.rounds.length = 0;

    test.setHidden(true);

    expect(test.timerCount).toBe(0);
    test.tick(10);
    expect(test.rounds).toEqual([]);
  });

  it("возвращение догоняет пропущенное сразу, а не через интервал", () => {
    const test = harness();
    startVisibilityAwarePolling(test.poll);
    test.setHidden(true);
    test.rounds.length = 0;

    test.setHidden(false);

    expect(test.rounds).toEqual(["visible"]);
    expect(test.timerCount).toBe(1);
    test.tick();
    expect(test.rounds).toEqual(["visible", "visible"]);
  });

  it("не заводит второго таймера, если видимость подтвердилась дважды", () => {
    const test = harness();
    startVisibilityAwarePolling(test.poll);
    test.rounds.length = 0;

    test.setHidden(false);
    test.setHidden(false);

    expect(test.timerCount).toBe(1);
    expect(test.rounds).toEqual([]);
    test.tick();
    expect(test.rounds).toEqual(["visible"]);
  });

  it("вкладка, скрытая на старте, не будит сеть до возвращения", () => {
    const test = harness(true);
    startVisibilityAwarePolling(test.poll);

    expect(test.rounds).toEqual([]);
    expect(test.timerCount).toBe(0);

    test.setHidden(false);
    expect(test.rounds).toEqual(["visible"]);
  });

  it("остановка снимает и таймер, и подписку", () => {
    const test = harness();
    const stop = startVisibilityAwarePolling(test.poll);
    test.rounds.length = 0;

    stop();

    expect(test.timerCount).toBe(0);
    expect(test.listenerCount).toBe(0);
    test.setHidden(false);
    test.tick(5);
    expect(test.rounds).toEqual([]);
  });
});

describe("исход круга синхронизации не пропадает", () => {
  const engine = (behaviour: () => Promise<{ readonly pull: { readonly applied: number; readonly settled?: boolean } }>) => ({
    sync: behaviour,
  });

  it("удавшийся круг отдаёт «ok» и число применённых операций", async () => {
    await expect(runSyncRound(engine(async () => ({ pull: { applied: 3 } })))).resolves.toEqual({
      applied: 3,
      settled: false,
      outcome: "ok",
    });
  });

  it("снятая без новых операций задержка — тоже новость для экрана", async () => {
    // Второе ревью, LOW-4: сборка, которая открывает состояние, переписывает документ, хотя
    // `applied` — ноль, и круг обязан это передать, иначе экран остался бы на вчерашнем бюджете.
    await expect(runSyncRound(engine(async () => ({ pull: { applied: 0, settled: true } })))).resolves.toEqual({
      applied: 0,
      settled: true,
      outcome: "ok",
    });
  });

  it("недоступный сервер — «unreachable», и приложение остаётся рабочим", async () => {
    await expect(
      runSyncRound(
        engine(async () => {
          throw new SyncClientError("transport_failed", "the sync server could not be reached");
        }),
      ),
    ).resolves.toEqual({ applied: 0, settled: false, outcome: "unreachable" });
  });

  it("умерший вход и отозванное устройство — «refused»: само это не пройдёт", async () => {
    for (const code of ["unauthorized", "device_revoked"] as const) {
      await expect(
        runSyncRound(
          engine(async () => {
            throw new SyncServerError(401, code);
          }),
        ),
      ).resolves.toEqual({ applied: 0, settled: false, outcome: "refused" });
    }
  });

  it("круг не бросает наружу ничего: отказ — это значение", async () => {
    await expect(
      runSyncRound(
        engine(() => {
          throw new Error("что угодно");
        }),
      ),
    ).resolves.toEqual({ applied: 0, settled: false, outcome: "refused" });
  });
});

describe("цикл синхронизации подключён к видимости, а не к голому интервалу", () => {
  const source = readFileSync(new URL("./controller.ts", import.meta.url), "utf8");

  it("не заводит интервала опроса мимо этого правила", () => {
    expect(source).toContain("startVisibilityAwarePolling({");
    expect(source).toContain('isHidden: () => document.visibilityState === "hidden"');
    expect(source).toContain('document.addEventListener("visibilitychange", listener)');
    expect(source).toContain('document.removeEventListener("visibilitychange", listener)');
    // Единственное обращение к таймеру браузера во всём файле — то, что помощник получает
    // параметром. Второй `window.setInterval` означал бы опрос в обход этого правила.
    expect(source.match(/window\.setInterval\(/gu)).toHaveLength(1);
    expect(source).toContain("setInterval: (callback, ms) => window.setInterval(callback, ms),");
    expect(source).toContain("timer = poll.setInterval(() => poll.run(), poll.intervalMs);");
  });

  it("каждый круг записывает свой исход, и пустых «поймали и забыли» в файле нет", () => {
    // Прежде здесь стояли два числа — «ровно три и ровно три», — и они говорили о длине файла, а
    // не о правиле. Третье место, откуда идёт круг (подготовка к смене ключа, 5.5), сломало бы
    // такую проверку и написанное правильно, и написанное неправильно, одинаково. Проверяется
    // само правило: сколько в файле кругов, столько и записей исхода. Иначе индикатор снова
    // говорил бы «синхронизировано» при лежащем сервере.
    const callSites = (source.match(/runSyncRound\(/gu) ?? []).length - 1; // минус объявление
    const recorded = (source.match(/setSyncRound\(\(await runSyncRound\(|setSyncRound\(result\.outcome\)/gu) ?? [])
      .length;
    expect(callSites).toBeGreaterThan(0);
    expect(recorded).toBe(callSites);
    expect(source).not.toMatch(/await engine\.sync\(\);\s*\n\s*\} catch \{/u);
  });
});
