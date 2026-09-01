import { makeSeedBudget, type BudgetState, type Transaction } from "@family-budget/domain";
import type { SyncStatusReport, SyncStop } from "@family-budget/sync-client";
import type { JournalIntegrity } from "@family-budget/sync-protocol";
import { describe, expect, it } from "vitest";

import {
  KEY_ALARM_ATTEMPTS,
  MEMBER_FILTER_ALL,
  MEMBER_FILTER_NONE,
  SYNC_INDICATOR_STATES,
  UNATTRIBUTED_AUTHOR,
  filterTransactionsByMember,
  formatInviteCode,
  formatInviteExpiry,
  isValidEmail,
  isValidLoginCode,
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
  it("знает ровно четыре состояния и берёт их только из отчёта", () => {
    expect([...SYNC_INDICATOR_STATES]).toEqual(["local", "synced", "waiting", "error"]);

    expect(syncIndicatorPresentation(null)).toEqual({
      state: "local",
      text: "локально",
      ariaLabel: "Состояние синхронизации: локально",
      className: "sync-badge local",
    });
    expect(syncIndicatorPresentation(report()).state).toBe("synced");
    expect(syncIndicatorPresentation(report({ queued: 3 })).state).toBe("waiting");
    expect(syncIndicatorPresentation(report({ stop: stop() })).state).toBe("error");
  });

  it("отказ важнее очереди: остановленный курсор не показывается как ожидание сети", () => {
    const presentation = syncIndicatorPresentation(report({ queued: 5, stop: stop() }));
    expect(presentation.state).toBe("error");
    expect(presentation.text).toBe("ошибка синхронизации");
    expect(presentation.ariaLabel).toBe("Состояние синхронизации: ошибка синхронизации");
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

    const repin = peerFingerprintPresentation({ state: "repin_required" }, offered);
    expect(repin?.origin).toBe("unverified_candidate");
    expect(repin?.createsPin).toBe(true);
    expect(repin?.note).toContain("отозвано");

    expect(peerFingerprintPresentation({ state: "absent" }, undefined)).toBeNull();
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
