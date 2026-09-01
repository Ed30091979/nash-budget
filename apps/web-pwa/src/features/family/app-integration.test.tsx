/// <reference types="node" />
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "../../App";
import { memberNameFromEmail, parsePins, serializePins } from "./controller";

const source = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");

const originalFetch = globalThis.fetch;
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    throw new Error("the local-only application must not reach the network");
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("приложение с экраном семьи", () => {
  it("первый кадр локального приложения не обращается к сети", () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain("Открываем семейный план…");
    expect(calls).toEqual([]);
  });

  it("экран семьи добавлен как маршрут и не трогает нижнюю навигацию", () => {
    expect(source).toContain('| "family"');
    expect(source).toContain('{screen === "family" ? <FamilyScreen');
    // Кнопок в нижней навигации по-прежнему четыре, и порядок прежний.
    const navButtons = source.match(/<NavButton /gu) ?? [];
    expect(navButtons).toHaveLength(4);
    expect(source).toContain('label="Сегодня"');
    expect(source).toContain('label="Год"');
    expect(source).toContain('label="Записать"');
    expect(source).toContain('label="Ещё"');
    // Вход на экран — из «Ещё», тем же приёмом, что и переход в горизонт.
    expect(source).toContain('className="year-preview" type="button" onClick={props.onFamily}');
    expect(source).toContain('<button className="secondary-button" type="button" onClick={props.onBack}'.slice(0, 20));
  });

  it("индикатор синхронизации стоит в шапке рядом с прежним сетевым, а не вместо него", () => {
    expect(source).toContain("networkStatusPresentation(nativeRuntime, online)");
    expect(source).toContain("syncIndicatorPresentation(family.status)");
    expect(source).toMatch(
      /<span className=\{networkStatus\.className\}[\s\S]{0,600}<span className=\{syncIndicator\.className\}/u,
    );
    // Без входа шапка не меняется вовсе: второй пилюли у локального пользователя нет.
    expect(source).toContain('syncIndicator.state === "local" ? null :');
    // Само состояние «локально» при этом видно — на карточке перехода и на экране «Семья».
    expect(source).toContain("syncIndicator={syncIndicator}");
  });

  it("тревога о подмене ключа не идёт через самозакрывающийся тост", () => {
    expect(source).toContain("const keyAlarm = syncAlarm(family.status?.stop ?? null);");
    expect(source).toContain('<section className="key-alarm" role="alert"');
    // Тост гасится таймером; тревога в него не попадает ни на одном пути.
    expect(source).toMatch(/setTimeout\(\(\) => setMessage\(null\), 6000\)/u);
    expect(source).not.toMatch(/setMessage\([^)]*keyAlarm/u);
    const banner = source.slice(source.indexOf('className="key-alarm"'), source.indexOf('{screen === "today" ?'));
    expect(banner).not.toMatch(/Закрыть|Понятно|Скрыть|dismiss/u);
  });

  it("автор операции и фильтр по участнику подключены к истории", () => {
    expect(source).toContain("filterTransactionsByMember(postedTransactions, memberFilter)");
    expect(source).toContain("memberFilterOptions(budget)");
    expect(source).toContain('<label htmlFor="history-member-filter">Кто записал</label>');
    expect(source).toContain("transactionAuthorLabel(memberById, transaction.memberId)");
    // Без участников в бюджете экран остаётся ровно таким, каким был: ни фильтра, ни автора.
    expect(source).toContain("memberOptions.length > 2 ?");
    expect(source).toContain("showAuthor={memberOptions.length > 2}");
  });

  it("адрес сервера читается из конфигурации сборки, а не зашит", () => {
    expect(source).toContain("resolveSyncServerUrl(import.meta.env");
    expect(source).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/u);
  });
});

describe("участник в локальном бюджете", () => {
  it("имя выводится из адреса и никогда не уходит на сервер", () => {
    expect(memberNameFromEmail("anna@example.com")).toBe("Anna");
    expect(memberNameFromEmail("anna.petrova@example.com")).toBe("Anna petrova");
    expect(memberNameFromEmail("@example.com")).toBe("Участник");
    expect(memberNameFromEmail("x".repeat(90) + "@example.com")).toHaveLength(60);

    const controller = readFileSync(new URL("./controller.ts", import.meta.url), "utf8");
    // Имя идёт только в локальный бюджет: ни один запрос его не несёт.
    expect(controller).not.toMatch(/name:\s*memberNameFromEmail[\s\S]{0,200}api\./u);
    expect(controller).toContain("registerLocalMember({");
  });

  it("приложение записывает участника тем же CAS, что и любое изменение бюджета", () => {
    expect(source).toContain("registerLocalMember: async (member) => {");
    expect(source).toContain("await budgetSave.apply((state) => ({");
    expect(source).toContain("memberNameOf={(memberId) => memberById.get(memberId)?.name ?? null}");
  });
});

describe("запись бюджета подключена к журналу", () => {
  it("координатор записи спрашивает журнал на каждом сохранении", () => {
    // Не «один раз при сборке»: семья создаётся посреди сессии, и запомненный ответ означал бы
    // журнал, начинающий вестись только после перезагрузки.
    expect(source).toContain("journalWrite: () => journalWriteRef.current");
    expect(source).toContain("journalWriteRef.current = family.writeBudget;");
    // Единственный funnel записи остался единственным: экраны по-прежнему зовут budgetSave.apply.
    const applies = source.match(/budgetSave\.apply\(/gu) ?? [];
    expect(applies.length).toBeGreaterThanOrEqual(4);
  });

  it("чужие операции доходят до экрана, а не только до базы", () => {
    expect(source).toContain("publishRemoteBudget: (value, revision) => {");
    // Пока идёт своя запись, показ откладывается: её сравнение ревизии — источник истины.
    expect(source).toMatch(
      /publishRemoteBudget[\s\S]{0,500}if \(budgetRef\.current === null \|\| budgetSave\.locked\) return;/u,
    );
    expect(source).toMatch(/publishRemoteBudget[\s\S]{0,700}prepareBudgetState\(value\)/u);
  });
});

describe("таблица закреплённых отпечатков", () => {
  it("переживает запись и чтение и отбрасывает всё, что не отпечаток", () => {
    const pins = new Map([
      ["77777777-7777-4777-8777-777777777777", new Uint8Array(32).fill(0x22)],
    ]);
    const serialized = serializePins(pins);
    expect(serialized["77777777-7777-4777-8777-777777777777"]).toBe("22".repeat(32));
    expect(parsePins(serialized).get("77777777-7777-4777-8777-777777777777")).toEqual(
      new Uint8Array(32).fill(0x22),
    );

    expect(parsePins(null).size).toBe(0);
    expect(parsePins("пины").size).toBe(0);
    expect(parsePins({ device: "не hex" }).size).toBe(0);
    expect(parsePins({ device: "22".repeat(31) }).size).toBe(0);
  });

  it("закрепление создаётся только подтверждением человека", () => {
    const controller = readFileSync(new URL("./controller.ts", import.meta.url), "utf8");
    const writes = controller.match(/key: PINS_STATE_KEY/gu) ?? [];
    // Ровно два места пишут пин: подтверждение человеком и вступление по коду приглашения,
    // где церемонией был сам код (5.4, первая строка таблицы).
    expect(writes).toHaveLength(2);
    expect(controller).toContain("confirmFingerprint(deviceId)");
    expect(controller).toContain("opened.senderKeyFingerprint");
  });
});
