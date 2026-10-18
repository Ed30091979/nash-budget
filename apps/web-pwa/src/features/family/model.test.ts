/// <reference types="node" />
import { readFileSync } from "node:fs";

import { makeSeedBudget, type BudgetState, type Transaction } from "@family-budget/domain";
import {
  DOCUMENT_HOLD_REASONS,
  SyncClientError,
  SyncServerError,
  type SyncStatusReport,
  type SyncStop,
} from "@family-budget/sync-client";
import type { JournalIntegrity } from "@family-budget/sync-protocol";
import { describe, expect, it } from "vitest";

import {
  KEY_ALARM_ATTEMPTS,
  MEMBER_FILTER_ALL,
  MEMBER_FILTER_NONE,
  SYNC_INDICATOR_STATES,
  SYNC_ROUND_OUTCOMES,
  UNATTRIBUTED_AUTHOR,
  classifySyncFailure,
  documentHoldNotice,
  familyDocumentNotice,
  showsFamilyHoldScreen,
  filterTransactionsByMember,
  formatInviteCode,
  formatInviteExpiry,
  isValidEmail,
  isValidLoginCode,
  joinConsequence,
  memberFilterOptions,
  membersById,
  normalizeLoginCode,
  ownFingerprintPresentation,
  peerFingerprintPresentation,
  syncAlarm,
  syncIndicatorPresentation,
  syncNotice,
  transactionAuthorLabel,
  withheldHeadline,
  withheldRows,
} from "./model";

function report(overrides: Partial<SyncStatusReport> = {}): SyncStatusReport {
  return {
    cursor: { keyEpoch: 1, seq: 12 },
    queued: 0,
    epoch: { keyEpoch: 1, keyDigest: "a".repeat(64), live: true },
    stop: null,
    hold: null,
    familyDocument: true,
    ...overrides,
  };
}

function stop(overrides: Partial<SyncStop> = {}): SyncStop {
  return {
    reason: "key_mismatch",
    seq: 7,
    opId: "11111111-1111-4111-8111-111111111111",
    attempts: 1,
    ...overrides,
  };
}

describe("индикатор состояния синхронизации", () => {
  it("знает ровно четыре состояния, и каждое из них достижимо", () => {
    expect([...SYNC_INDICATOR_STATES]).toEqual(["local", "synced", "waiting", "error"]);

    expect(syncIndicatorPresentation(null, "ok")).toEqual({
      state: "local",
      text: "локально",
      ariaLabel: "Состояние синхронизации: локально",
      className: "sync-badge local",
    });
    expect(syncIndicatorPresentation(report(), "ok")).toEqual({
      state: "synced",
      text: "синхронизировано",
      ariaLabel: "Состояние синхронизации: синхронизировано",
      className: "sync-badge synced",
    });
    expect(syncIndicatorPresentation(report({ queued: 3 }), "ok")).toEqual({
      state: "waiting",
      text: "ожидает сети",
      ariaLabel: "Состояние синхронизации: ожидает сети",
      className: "sync-badge waiting",
    });
    expect(syncIndicatorPresentation(report({ stop: stop() }), "ok")).toEqual({
      state: "error",
      text: "ошибка синхронизации",
      ariaLabel: "Состояние синхронизации: ошибка синхронизации",
      className: "sync-badge error",
    });
  });

  it("упавший круг не показывается как «синхронизировано» — даже когда отчёт молчит", () => {
    // Отчёт здесь ровно тот же, что у здорового устройства: круг, не дошедший до сервера,
    // не пишет ни курсора, ни очереди, ни остановки. Раньше это и было зелёной надписью.
    const unreachable = syncIndicatorPresentation(report(), "unreachable");
    expect(unreachable.state).toBe("waiting");
    expect(unreachable.text).toBe("ожидает сети");
    expect(unreachable.ariaLabel).toBe("Состояние синхронизации: ожидает сети — сервер недоступен");

    const refused = syncIndicatorPresentation(report(), "refused");
    expect(refused.state).toBe("error");
    expect(refused.text).toBe("ошибка синхронизации");
    expect(refused.ariaLabel).toBe("Состояние синхронизации: ошибка синхронизации — сервер отказал");
  });

  it("отказ сервера важнее пустой очереди, а тревога — важнее отказа", () => {
    expect(syncIndicatorPresentation(report({ queued: 5 }), "refused").state).toBe("error");
    expect(syncIndicatorPresentation(report({ queued: 5, stop: stop() }), "unreachable").state).toBe(
      "error",
    );
  });

  it("без учётной записи исход круга ничего не меняет: продукт локальный и говорит это", () => {
    for (const round of SYNC_ROUND_OUTCOMES) {
      expect(syncIndicatorPresentation(null, round).state).toBe("local");
      expect(syncIndicatorPresentation(null, round).ariaLabel).toBe(
        "Состояние синхронизации: локально",
      );
    }
  });

  it("различает «до сервера не дошли» и «сервер отказал» по коду, а не по тексту ошибки", () => {
    expect([...SYNC_ROUND_OUTCOMES]).toEqual(["ok", "unreachable", "refused"]);
    expect(classifySyncFailure(new SyncClientError("transport_failed", "нет связи"))).toBe(
      "unreachable",
    );
    expect(classifySyncFailure(new SyncServerError(401, "unauthorized"))).toBe("refused");
    expect(classifySyncFailure(new SyncServerError(403, "device_revoked"))).toBe("refused");
    expect(classifySyncFailure(new SyncClientError("epoch_conflict", "эпоха"))).toBe("refused");
    // Что угодно иное — тоже отказ: неизвестное молчанием не считается.
    expect(classifySyncFailure(new Error("что-то"))).toBe("refused");
    expect(classifySyncFailure(undefined)).toBe("refused");
  });
});

describe("тревога «ключ семьи не совпадает»", () => {
  it("не закрывается и не имеет автопропуска", () => {
    const alarm = syncAlarm(stop({ attempts: KEY_ALARM_ATTEMPTS }));
    expect(alarm).not.toBeNull();
    expect(alarm?.dismissible).toBe(false);
    expect(alarm?.title).toBe("Ключ семьи не совпадает");
    expect(alarm?.actionLabel).toBe("Сверить отпечатки ключей");
    expect(alarm?.body).toContain("подмена ключа");
    // Никакого «что-то пошло не так»: человек должен понять, что произошло.
    expect(alarm?.body).not.toMatch(/что-то пошло не так/iu);
  });

  it("до десятого повтора того же конверта говорит «не удалось прочитать», но остаётся тревогой", () => {
    const early = syncAlarm(stop({ attempts: KEY_ALARM_ATTEMPTS - 1 }));
    expect(early?.title).toBe("Не удалось прочитать запись семьи");
    expect(early?.dismissible).toBe(false);
    expect(early?.actionLabel).toBe("Сверить отпечатки ключей");
    expect(KEY_ALARM_ATTEMPTS).toBe(10);
  });

  it("несёт идентификаторы как данные и не строит из них предложение", () => {
    const alarm = syncAlarm(stop({ opId: "22222222-2222-4222-8222-222222222222", seq: 41 }));
    expect(alarm?.opId).toBe("22222222-2222-4222-8222-222222222222");
    expect(alarm?.seq).toBe(41);
    expect(alarm?.body).not.toContain("22222222");
  });

  it("три остальные остановки — обычные уведомления, а не тревога", () => {
    expect(syncAlarm(stop({ reason: "journal_incomplete" }))).toBeNull();
    expect(syncAlarm(null)).toBeNull();

    expect(syncNotice(stop({ reason: "key_mismatch" }))).toBeNull();
    expect(syncNotice(stop({ reason: "journal_incomplete" }))).toEqual({
      title: "Журнал неполон",
      body: expect.stringContaining("повторится сам"),
      dismissible: true,
    });
    expect(syncNotice(stop({ reason: "update_required" }))?.title).toBe(
      "Требуется обновление приложения",
    );
    expect(syncNotice(stop({ reason: "quarantined" }))?.title).toBe("Запись отложена");
  });
});

describe("состояние журнала, которое приложение не открыло", () => {
  it("говорит, что случилось и что делать, и молчит, когда документ показывает журнал", () => {
    expect(documentHoldNotice(null)).toBeNull();
    const kept = documentHoldNotice({ reason: "rejected_by_app", document: "kept" })!;
    expect(kept.title).toBe("Новые записи семьи не открываются в этой версии");
    // Second review: the held device is read-only, and the words say so instead of promising that
    // its writes travel.
    expect(kept.body).toContain("записи на этом устройстве временно недоступны");
    expect(kept.body).not.toContain("уходят семье");
    expect(kept.body).toContain("Обновите приложение");
    expect(kept.body).toContain("Ничего не потеряно");
    const empty = documentHoldNotice({ reason: "rejected_by_app", document: "empty" })!;
    expect(empty.title).toBe("Бюджет семьи не открывается в этой версии");
    expect(empty.body).toContain("Обновите приложение");
    expect(empty.body).toContain("записи недоступны");
    // Every reason the engine can record has words, for both kinds of document.
    for (const reason of DOCUMENT_HOLD_REASONS) {
      for (const document of ["kept", "empty"] as const) {
        expect(documentHoldNotice({ reason, document })?.title.length, `${reason} ${document}`).toBeGreaterThan(0);
      }
    }
  });

  it("экран ожидания стоит на месте бюджета ровно тогда, когда в семье нет документа семьи", () => {
    // Второе ревью, LOW-5: в семье без документа — экран ожидания, а не онбординг.
    expect(showsFamilyHoldScreen(true, false, null)).toBe(true);
    expect(showsFamilyHoldScreen(true, false, report({ familyDocument: true }))).toBe(true);
    // MEDIUM-3 (b): прежний бюджет вступившего устройства не показывается как семейный.
    expect(showsFamilyHoldScreen(true, true, report({ familyDocument: false }))).toBe(true);
    expect(showsFamilyHoldScreen(true, true, report({ familyDocument: false, hold: { reason: "rejected_by_app", document: "empty" } }))).toBe(true);
    // Документ семьи — бюджет; задержка над ним — плашка, а не этот экран.
    expect(showsFamilyHoldScreen(true, true, report({ familyDocument: true }))).toBe(false);
    expect(showsFamilyHoldScreen(true, true, report({ familyDocument: true, hold: { reason: "rejected_by_app", document: "kept" } }))).toBe(false);
    // Пока отчёта нет, бюджет показан как был; без семьи — обычное приложение и онбординг.
    expect(showsFamilyHoldScreen(true, true, null)).toBe(false);
    expect(showsFamilyHoldScreen(false, false, null)).toBe(false);
    expect(showsFamilyHoldScreen(false, true, report({ familyDocument: false }))).toBe(false);
  });

  it("экран вместо бюджета не выдаёт прежний бюджет устройства за семейный", () => {
    // Без задержки бюджет семьи просто ещё не пришёл; с задержкой — не открывается этой версией.
    const pending = familyDocumentNotice(null);
    expect(pending.title).toBe("Бюджет семьи ещё не пришёл");
    expect(pending.body).toContain("записи на этом устройстве недоступны");
    for (const reason of DOCUMENT_HOLD_REASONS) {
      // Whatever the hold says the document is, this screen stands in for a budget that is not the
      // family's, so it always speaks of the family's budget as not shown.
      expect(familyDocumentNotice({ reason, document: "kept" })).toEqual(documentHoldNotice({ reason, document: "empty" }));
      expect(familyDocumentNotice({ reason, document: "empty" })).toEqual(documentHoldNotice({ reason, document: "empty" }));
    }
  });
});

describe("перечень удержанных сущностей", () => {
  const integrity = (): JournalIntegrity => ({
    ready: true,
    problems: [],
    withheld: [
      {
        entity: "transaction",
        id: "33333333-3333-4333-8333-333333333333",
        reason: "unknown_reference",
      },
      { entity: "budgetLine", id: "44444444-4444-4444-8444-444444444444", reason: "duplicate_budget_line" },
    ],
  });

  it("показывается и тогда, когда снимок помечен пригодным к показу", () => {
    const rows = withheldRows(integrity());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      entity: "transaction",
      id: "33333333-3333-4333-8333-333333333333",
      reason: "unknown_reference",
      entityLabel: "Операция",
      reasonLabel: "ссылается на запись, которой в бюджете нет",
    });
    expect(rows[1]?.entityLabel).toBe("Строка бюджета");
    expect(withheldHeadline(rows)).toBe("Записей семьи не показано в бюджете: 2");
  });

  it("называет удержанную метку меткой", () => {
    const rows = withheldRows({
      ready: true,
      problems: [],
      withheld: [{ entity: "tag", id: "55555555-5555-4555-8555-555555555555", reason: "identifier_claimed_twice" }],
    });
    expect(rows[0]).toMatchObject({ entity: "tag", entityLabel: "Метка" });
  });

  it("называет удержанный курс, хозяйство и расхождение валют своими словами", () => {
    const rows = withheldRows({
      ready: true,
      problems: [],
      withheld: [
        { entity: "exchangeRate", id: "55555555-5555-4555-8555-555555555556", reason: "identifier_claimed_twice" },
        { entity: "household", id: "55555555-5555-4555-8555-555555555557", reason: "identifier_claimed_twice" },
        { entity: "transaction", id: "55555555-5555-4555-8555-555555555558", reason: "currency_mismatch" },
      ],
    });
    expect(rows.map((row) => row.entityLabel)).toEqual(["Курс валюты", "Хозяйство", "Операция"]);
    expect(rows[2]?.reasonLabel).toBe("валюта записи не сходится с валютой счёта или семьи");
  });

  it("называет снимок, не равный сумме по курсу, своими словами", () => {
    const rows = withheldRows({
      ready: true,
      problems: [],
      withheld: [{ entity: "transaction", id: "55555555-5555-4555-8555-555555555559", reason: "snapshot_mismatch" }],
    });
    expect(rows[0]).toMatchObject({ entityLabel: "Операция", reasonLabel: "сумма в базовой валюте не сходится с суммой операции по её курсу" });
  });

  it("молчит только когда удерживать нечего", () => {
    expect(withheldRows({ ready: true, problems: [], withheld: [] })).toEqual([]);
    expect(withheldRows(null)).toEqual([]);
    expect(withheldHeadline([])).toBeNull();
    expect(withheldHeadline(withheldRows(integrity()).slice(0, 1))).toBe(
      "Одна запись семьи не показана в бюджете",
    );
  });
});

describe("автор операции и фильтр по участнику", () => {
  const anna = "55555555-5555-4555-8555-555555555551";
  const boris = "55555555-5555-4555-8555-555555555552";
  const archived = "55555555-5555-4555-8555-555555555553";

  function withMembers(): BudgetState {
    return {
      ...makeSeedBudget(),
      members: [
        { id: anna, name: "Анна", role: "owner", active: true },
        { id: boris, name: "Борис", role: "member", active: true },
        { id: archived, name: "Старый профиль", role: "member", active: false },
      ],
    };
  }

  const rows = [
    { memberId: anna },
    { memberId: boris },
    { memberId: undefined },
  ] as unknown as readonly Pick<Transaction, "memberId">[];

  it("показывает имя автора, а при его отсутствии — честную подпись", () => {
    const members = membersById(withMembers());
    expect(transactionAuthorLabel(members, anna)).toBe("Анна");
    expect(transactionAuthorLabel(members, undefined)).toBe(UNATTRIBUTED_AUTHOR);
    expect(transactionAuthorLabel(members, "66666666-6666-4666-8666-666666666666")).toBe(
      "Участник не найден",
    );
  });

  it("предлагает фильтр по живым участникам и отдельно по операциям без метки", () => {
    expect(memberFilterOptions(withMembers())).toEqual([
      { value: MEMBER_FILTER_ALL, label: "Все участники" },
      { value: anna, label: "Анна" },
      { value: boris, label: "Борис" },
      { value: MEMBER_FILTER_NONE, label: UNATTRIBUTED_AUTHOR },
    ]);
    expect(memberFilterOptions(makeSeedBudget())).toHaveLength(2);
  });

  it("фильтрует операции, ничего не теряя на «все»", () => {
    expect(filterTransactionsByMember(rows, MEMBER_FILTER_ALL)).toHaveLength(3);
    expect(filterTransactionsByMember(rows, anna)).toEqual([{ memberId: anna }]);
    expect(filterTransactionsByMember(rows, MEMBER_FILTER_NONE)).toEqual([{ memberId: undefined }]);
  });
});

describe("отпечатки ключей по 5.4.1", () => {
  const own = new Uint8Array(32).fill(0x11);
  const pinned = new Uint8Array(32).fill(0x22);
  const offered = new Uint8Array(32).fill(0x33);

  it("свой отпечаток считается из собственной пары", () => {
    const presentation = ownFingerprintPresentation(own);
    expect(presentation.origin).toBe("own");
    expect(presentation.text).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/u);
    expect(presentation.createsPin).toBe(false);
  });

  it("при наличии закрепления показывается пин, а не значение сервера", () => {
    const presentation = peerFingerprintPresentation(
      { state: "pinned", fingerprint: pinned },
      offered,
    );
    expect(presentation?.origin).toBe("pinned");
    expect(presentation?.text).toBe(ownFingerprintPresentation(pinned).text);
    expect(presentation?.text).not.toBe(ownFingerprintPresentation(offered).text);
    expect(presentation?.createsPin).toBe(false);
  });

  it("без закрепления показывается явно помеченный непроверенный кандидат, и подтверждение создаёт пин", () => {
    const presentation = peerFingerprintPresentation({ state: "absent" }, offered);
    expect(presentation?.origin).toBe("unverified_candidate");
    expect(presentation?.originLabel).toBe("Непроверенный отпечаток");
    expect(presentation?.note).toContain("пришло от сервера");
    expect(presentation?.createsPin).toBe(true);

    expect(peerFingerprintPresentation({ state: "absent" }, undefined)).toBeNull();
  });

  it("«требуется пере-закрепление» сюда не принимается: 5.4.1 требует показать оба значения", () => {
    // Ветка, трактовавшая это состояние как «пина нет», показывала одно новое значение — ровно
    // то, что 5.4.1 запрещает. Состояния в приложении пока нет, и типом оно сюда не проходит:
    // @ts-expect-error — repin_required не входит в LocalPinState
    peerFingerprintPresentation({ state: "repin_required" }, offered);

    // И самой ветки в источнике больше нет — ловушка убрана, а не спрятана за типом.
    const source = readFileSync(new URL("./model.ts", import.meta.url), "utf8");
    expect(source).not.toContain("Прежнее подтверждение отозвано");
    expect(source).not.toContain('pin.state === "repin_required"');
  });
});

describe("вход по почте и коду", () => {
  it("проверяет форму адреса и шестизначный код", () => {
    expect(isValidEmail("  Semya@example.com ")).toBe(true);
    expect(isValidEmail("semya@example")).toBe(false);
    expect(isValidEmail("не почта")).toBe(false);

    expect(normalizeLoginCode(" 12-34 56 78 ")).toBe("123456");
    expect(isValidLoginCode("123456")).toBe(true);
    expect(isValidLoginCode("12345")).toBe(false);
  });
});

describe("приглашение", () => {
  it("читает срок кода из ответа сервера, а не из константы сборки", () => {
    const now = Date.UTC(2026, 6, 9, 12, 0, 0);
    expect(formatInviteExpiry(now + 24 * 3_600_000, now)).toBe("действует ещё 24 ч");
    expect(formatInviteExpiry(now + 90 * 60_000, now)).toBe("действует ещё 1 ч");
    expect(formatInviteExpiry(now + 5 * 60_000, now)).toBe("действует ещё 5 мин");
    expect(formatInviteExpiry(now - 1, now)).toBe("срок кода истёк");
  });

  it("разбивает двенадцать символов кода на три группы", () => {
    expect(formatInviteCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
  });
});

describe("предупреждение перед вступлением", () => {
  const stamp = () => "9 июля 2026 г., 12:00";

  it("называет смену бюджета до нажатия и считает то, что человек здесь записал", () => {
    const warning = joinConsequence(42, null, stamp);

    expect(warning.body).toContain("перестанет показывать бюджет, который вы ведёте здесь сейчас");
    expect(warning.body).toContain("Записанных здесь операций: 42.");
    expect(warning.body).toContain("в семейный не вливается");
    expect(warning.confirmLabel).toBe("Вступить в семью");
  });

  it("не выдумывает счёт операций, когда записей ещё нет", () => {
    expect(joinConsequence(0, null, stamp).body).not.toContain("Записанных здесь операций");
  });

  it("предлагает сделать копию, когда её нет", () => {
    const warning = joinConsequence(1, null, stamp);

    expect(warning.backupLine).toContain("Резервной копии этого бюджета ещё нет");
    expect(warning.backupActionLabel).toBe("Сделать копию сейчас");
  });

  it("называет дату прежней копии и не выдаёт её за полную", () => {
    const warning = joinConsequence(1, "2026-07-09T12:00:00.000Z", stamp);

    expect(warning.backupLine).toContain("9 июля 2026 г., 12:00");
    expect(warning.backupLine).toContain("Записи, сделанные после неё, в файл не попали");
    expect(warning.backupLine).not.toContain("ещё нет");
  });

  it("говорит о последствии, а не пугает потерей", () => {
    const warning = joinConsequence(42, null, stamp);
    const text = `${warning.title} ${warning.body} ${warning.backupLine}`;

    for (const scare of ["удал", "потеря", "безвозвратн", "навсегда", "внимание"]) {
      expect(text.toLowerCase()).not.toContain(scare);
    }
  });
});
