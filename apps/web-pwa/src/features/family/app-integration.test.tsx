/// <reference types="node" />
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeBindProof,
  deriveInviteSecrets,
  deviceKeyFingerprint,
  exportDevicePublicKey,
  generateDeviceKeyPair,
  generateInviteCode,
  toHex,
} from "@family-budget/sync-crypto";
import { toBase64 } from "@family-budget/sync-client";

import App from "../../app/AppShell";
import {
  checkInviteBinding,
  memberNameFromEmail,
  parsePins,
  parseStoredInvite,
  serializePins,
} from "./controller";
import { readAppSource } from "../../app/shell-source";

const source = readAppSource();

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
  it("первый кадр локального приложения не обращается к сети и не мигает индикатором", () => {
    const markup = renderToStaticMarkup(<App />);
    // §6 исследования, пункт 30 (NN/g): под секундой индикатор не нужен вообще, а офлайн-первое
    // приложение читает бюджет с диска быстрее. Первый кадр молчит словами и говорит `aria-busy`.
    // Прежняя проверка сверяла саму надпись — и осталась бы зелёной, даже если бы плашка
    // «открываем» мигала на каждом открытии приложения.
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("Открываем семейный план…");
    expect(calls).toEqual([]);
  });

  it("экран семьи добавлен как маршрут и не трогает нижнюю навигацию", () => {
    expect(source).toContain('| "family"');
    // Один и тот же экран «Семья» — маршрут оболочки и дверь с экрана ожидания документа семьи.
    expect(source).toContain('{screen === "family" ? familyScreen(() => navigate("more")) : null}');
    expect(source).toContain("const familyScreen = (onBack: () => void) => (\n    <FamilyScreen");
    // Кнопок в нижней навигации по-прежнему четыре, и порядок прежний.
    const navButtons = source.match(/<NavButton /gu) ?? [];
    expect(navButtons).toHaveLength(4);
    expect(source).toContain('label="Сегодня"');
    expect(source).toContain('label="Год"');
    expect(source).toContain('label="Записать"');
    expect(source).toContain('label="Ещё"');
    // Вход на экран — строкой списка «Ещё», названной словами.
    expect(source).toMatch(/onClick=\{props\.onFamily\}>[\s\S]{0,200}Семья и синхронизация/u);
    expect(source).toContain("<BackButton label=");
  });

  it("индикатор синхронизации — единственное слово шапки о сети, и только после входа", () => {
    // Исход последнего круга — второй аргумент, а не догадка: без него шапка говорила бы
    // «синхронизировано» при лежащем сервере.
    expect(source).toContain("syncIndicatorPresentation(family.status, family.syncRound)");
    expect(source).toContain("syncRound={family.syncRound}");
    // Без входа шапка молчит вовсе: сетевой пилюли рядом больше нет — без синхронизации
    // приложение к сети не обращается, и слово «в сети» было бы сведением ни о чём.
    expect(source).toContain('syncIndicator.state === "local" ? null :');
    expect(source).not.toMatch(/Состояние сети|network-badge/u);
    // Само состояние «локально» при этом видно — на строке «Ещё» и на экране «Семья».
    expect(source).toContain("syncIndicator={syncIndicator}");
  });

  it("тревога о подмене ключа не идёт через самозакрывающийся тост", () => {
    expect(source).toContain("const keyAlarm = syncAlarm(family.status?.stop ?? null);");
    expect(source).toContain('<section className="key-alarm" role="alert"');
    // Тост гасится таймером; тревога в него не попадает ни на одном пути.
    expect(source).toMatch(/setTimeout\(\(\) => setMessage\(null\), 6000\)/u);
    expect(source).not.toMatch(/setMessage\([^)]*keyAlarm/u);
    const banner = source.slice(source.indexOf('className="key-alarm"'), source.indexOf("<RouteView "));
    expect(banner).not.toMatch(/Закрыть|Понятно|Скрыть|dismiss/u);
  });

  it("в семье без документа семьи на месте бюджета стоит экран ожидания, а не онбординг", () => {
    // Второе ревью, LOW-5: онбординг создавал личный бюджет, который следующий приём выдавал за
    // семейный. Решение — до онбординга и до оболочки.
    const gate = source.indexOf('if (showsFamilyHoldScreen(family.inFamily, loadState !== "empty", family.status)) {');
    const onboarding = source.indexOf('if (loadState === "empty") return <AppFrame className="onboarding-route"');
    const shell = source.indexOf('<AppFrame className="app-shell"');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(onboarding);
    expect(gate).toBeLessThan(shell);
    const branch = source.slice(gate, onboarding);
    expect(branch).toContain("notice={familyDocumentNotice(family.status?.hold ?? null)}");
    expect(branch).toContain("onBackup={createBackup}");
    expect(branch).not.toContain("<Onboarding");
  });

  it("задержанный документ виден плашкой на каждом экране, кроме «Семьи», без кнопки «закрыть»", () => {
    expect(source).toContain("const hold = family.inFamily ? family.status?.hold ?? null : null;");
    expect(source).toContain("const holdNotice = documentHoldNotice(hold);");
    expect(source).toContain("{hold !== null && holdNotice !== null && screen !== \"family\" ? (");
    const banner = source.slice(source.indexOf('className="key-alarm family-hold-banner"'), source.indexOf("{keyAlarm && screen !== \"family\" ? ("));
    // The words follow the reason: «обновите приложение» for a version skew, «дождитесь бюджета»
    // for a journal with nothing to show.
    expect(banner).toContain("{WRITE_REFUSAL_TEXT[holdWriteRefusal(hold)]}");
    expect(banner).not.toMatch(/Закрыть|Понятно|Скрыть|dismiss/u);
  });

  it("предупреждение о смене бюджета получает и бюджет, и дату копии, и саму копию", () => {
    // Без бюджета (экран ожидания документа семьи) предупреждать о замене нечего — и это сказано
    // явно, а не подставлено молча.
    expect(source).toContain("localBudget={budget ?? NO_LOCAL_BUDGET}");
    expect(source).toContain("const NO_LOCAL_BUDGET = { transactions: [] } as const;");
    expect(source).toContain("lastBackupAt={lastSuccessfulBackup}");
    expect(source).toContain("onCreateBackup={createBackup}");
    // Копия, сделанная перед вступлением, — та же копия, что и на экране «Данные»: один путь,
    // одна отметка о дате. Иначе «Данные» продолжали бы показывать «копия ещё не создавалась».
    expect(source).toContain("await downloadTextFile(prepareJsonDownload(backup.text));");
    expect(source).toContain("await recordBackup(backup.createdAt);");
    expect(source).toContain("onRecordSuccessfulBackup={recordBackup}");
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

  it("созданная семья сразу засевает журнал записью участника, а не ждёт первой покупки", () => {
    // Третье ревью, e2e: со старой сессией в ссылке участник ложился мимо журнала, журнал семьи
    // оставался пустым, и вступившее устройство стояло на «Бюджет семьи ещё не пришёл».
    const controller = readFileSync(new URL("./controller.ts", import.meta.url), "utf8");
    const create = controller.slice(controller.indexOf("createFamily() {"), controller.indexOf("issueInvite() {"));
    expect(create.indexOf("sessionRef.current = next;")).toBeGreaterThan(0);
    expect(create.indexOf("sessionRef.current = next;")).toBeLessThan(create.indexOf("await registerLocalMember({"));
    // And the join no longer writes a participant into the budget the device had before joining.
    const join = controller.slice(controller.indexOf("joinByCode(rawCode) {"), controller.indexOf("leaveFamily() {"));
    expect(join).not.toContain("registerLocalMember(");
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
    expect(source).toMatch(/publishRemoteBudget[\s\S]{0,700}if \(budgetSave\.locked\) return;/u);
    // Без бюджета показ идёт только на экран ожидания семьи — не поверх онбординга.
    expect(source).toMatch(
      /publishRemoteBudget[\s\S]{0,900}const waiting = budgetRef\.current === null && loadStateRef\.current === "empty" && inFamilyRef\.current;\s*if \(budgetRef\.current === null && !waiting\) return;/u,
    );
    expect(source).toMatch(/publishRemoteBudget[\s\S]{0,1100}prepareBudgetState\(value\)/u);
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

  /**
   * Прежде здесь считались вхождения `key: PINS_STATE_KEY` в файле контроллера, и «ровно два» было
   * утверждением о форме текста, а не о том, что пин создаёт. Такая проверка не отличила бы третий
   * законный путь (автоматическая привязка по `bindProof`, 6.4) от лишней записи пина по серверной
   * подсказке и падала бы на первом, пропуская вторую. Здесь проверяется смысл: что именно
   * `checkInviteBinding` объявляет привязкой и какое значение отдаёт под пин.
   */
  it("автоматическая привязка создаёт пин только на сошедшемся bindProof", async () => {
    const familyId = "0f000000-0000-4000-8000-00000000fa11";
    const inviteId = "11111111-1111-4111-8111-111111111111";
    const joiningDeviceId = "22222222-2222-4222-8222-222222222222";
    const code = generateInviteCode();
    const secrets = await deriveInviteSecrets(code);
    const joining = await generateDeviceKeyPair();
    const spki = await exportDevicePublicKey(joining.publicKey);
    const proof = await computeBindProof(secrets.bindKey, {
      familyId,
      inviteId,
      deviceId: joiningDeviceId,
      spki,
    });
    const invite = {
      inviteId,
      familyId,
      keyEpoch: 1,
      expiresAt: 4_102_444_800_000,
      supersededCount: 0,
      bindKey: toHex(secrets.bindKey),
    };
    const device = {
      deviceId: joiningDeviceId,
      memberId: "33333333-3333-4333-8333-333333333333",
      publicKey: toBase64(spki),
      bindProof: toBase64(proof),
      inviteId,
      createdAt: 1,
      lastSeenAt: 1,
      revokedAt: null,
    };

    const agreed = await checkInviteBinding(invite, [device]);
    expect(agreed?.verdict).toBe("bound");
    // Под пин уходит отпечаток присланного SPKI — та самая величина, на которой потом сходится
    // обёртка ключа семьи, — а не что-нибудь, что можно взять из ответа сервера отдельно.
    expect(agreed?.fingerprint).toEqual(await deviceKeyFingerprint(spki));

    // Сервер подменил открытый ключ вступившего, оставив настоящее доказательство: HMAC считается
    // по SPKI, поэтому расхождение видно, и пина не возникает ни при каком исходе.
    const substituted = await exportDevicePublicKey((await generateDeviceKeyPair()).publicKey);
    const forged = await checkInviteBinding(invite, [
      { ...device, publicKey: toBase64(substituted) },
    ]);
    expect(forged).toEqual({ deviceId: joiningDeviceId, verdict: "failed", fingerprint: null });

    // Доказательство, посчитанное на другом коде: тот, кто не знает кода, `bindKey` не выведет.
    const otherSecrets = await deriveInviteSecrets(generateInviteCode());
    const otherProof = await computeBindProof(otherSecrets.bindKey, {
      familyId,
      inviteId,
      deviceId: joiningDeviceId,
      spki,
    });
    const mismatched = await checkInviteBinding(invite, [
      { ...device, bindProof: toBase64(otherProof) },
    ]);
    expect(mismatched).toEqual({ deviceId: joiningDeviceId, verdict: "failed", fingerprint: null });

    // Устройство, вступившее не по этому коду, вердикта не получает вовсе: это не «не сошлось»,
    // а «проверять нечего», и ключ приглашения из-за него не стирается.
    expect(await checkInviteBinding(invite, [{ ...device, inviteId: null }])).toBeNull();
    expect(await checkInviteBinding(invite, [{ ...device, bindProof: null }])).toBeNull();
  });

  it("код приглашения в локальную базу не пишется, а bindKey пишется", () => {
    const controller = readFileSync(new URL("./controller.ts", import.meta.url), "utf8");
    // 6.3 одной строкой, и реализация делала ровно наоборот по обоим пунктам.
    expect(parseStoredInvite({ code: "ABCDEFGHJKMN", expiresAt: 1, supersededCount: 0 })).toBeNull();
    expect(
      parseStoredInvite({
        inviteId: "11111111-1111-4111-8111-111111111111",
        familyId: "0f000000-0000-4000-8000-00000000fa11",
        keyEpoch: 1,
        expiresAt: 1,
        supersededCount: 0,
        bindKey: "ab".repeat(32),
      })?.bindKey,
    ).toBe("ab".repeat(32));
    // Записываемая структура собирается из `sealed.issuerSecrets`, а поля `code` в ней нет.
    const record = controller.slice(
      controller.indexOf("const record: StoredInvite = {"),
      controller.indexOf("await store.writeSyncState([{ key: INVITE_STATE_KEY, value: record }])"),
    );
    expect(record).toContain("bindKey: toHex(sealed.issuerSecrets.bindKey)");
    expect(record).not.toContain("code");
  });

  it("подтверждение создаёт пин и не переписывает уже существующий", () => {
    const controller = readFileSync(new URL("./controller.ts", import.meta.url), "utf8");
    const confirm = controller.slice(
      controller.indexOf("confirmFingerprint(deviceId)"),
      controller.indexOf("},", controller.indexOf("confirmFingerprint(deviceId)")),
    );
    // 5.4.1: подтверждение *создаёт* пин. Кнопки для перезаписи на экране нет (`createsPin`
    // ложно при существующем пине), но проверяет тот, кто пишет, а не тот, кто рисует.
    expect(confirm).toContain('if (pins.has(deviceId)) throw new Error("a pin for this device already exists");');
    expect(confirm.indexOf("pins.has(deviceId)")).toBeLessThan(confirm.indexOf("writeSyncState"));
  });
});
