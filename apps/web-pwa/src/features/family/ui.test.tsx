/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { PinState, SyncStatusReport } from "@family-budget/sync-client";
import type { JournalIntegrity } from "@family-budget/sync-protocol";
import { describe, expect, it, vi } from "vitest";

import { FamilyScreen, type FamilyActions, type FamilyScreenProps } from "./FamilyScreen";
import { formatKeyFingerprint } from "@family-budget/sync-crypto";
import type { FamilySession } from "./session";

const OWN_DEVICE = "77777777-7777-4777-8777-777777777777";
const PEER_DEVICE = "99999999-9999-4999-8999-999999999999";
const OWNER_MEMBER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OTHER_MEMBER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);

function noopActions(): FamilyActions {
  return {
    requestLoginCode: vi.fn(),
    submitLoginCode: vi.fn(),
    cancelLoginCode: vi.fn(),
    signOut: vi.fn(),
    createFamily: vi.fn(),
    issueInvite: vi.fn(),
    joinByCode: vi.fn(),
    leaveFamily: vi.fn(),
    removeMember: vi.fn(),
    revokeDevice: vi.fn(),
    confirmFingerprint: vi.fn(),
    dismissNotice: vi.fn(),
  };
}

const session: FamilySession = {
  email: "semya@example.com",
  deviceId: OWN_DEVICE,
  accountId: "88888888-8888-4888-8888-888888888888",
  accessToken: "access",
  accessExpiresAt: NOW + 900_000,
  refreshToken: "refresh",
  familyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  memberId: OWNER_MEMBER,
  role: "owner",
};

function props(overrides: Partial<FamilyScreenProps> = {}): FamilyScreenProps {
  return {
    serverUrl: "http://127.0.0.1:8787",
    session: null,
    membership: null,
    members: [],
    devices: [],
    ownFingerprint: null,
    pinOf: () => ({ state: "absent" }) as PinState,
    offeredFingerprintOf: () => undefined,
    memberNameOf: () => null,
    invite: null,
    status: null,
    integrity: null,
    now: NOW,
    busy: false,
    message: null,
    error: null,
    awaitingLoginCode: false,
    actions: noopActions(),
    onBack: vi.fn(),
    ...overrides,
  };
}

function render(overrides: Partial<FamilyScreenProps> = {}): string {
  return renderToStaticMarkup(<FamilyScreen {...props(overrides)} />);
}

const signedInOwner = (extra: Partial<FamilyScreenProps> = {}): Partial<FamilyScreenProps> => ({
  session,
  membership: {
    familyId: session.familyId!,
    keyEpoch: 1,
    memberId: OWNER_MEMBER,
    role: "owner",
    ownerMemberId: OWNER_MEMBER,
    rotation: null,
  },
  members: [
    { memberId: OWNER_MEMBER, role: "owner", joinedAt: NOW - 86_400_000, removedAt: null },
    { memberId: OTHER_MEMBER, role: "member", joinedAt: NOW - 3_600_000, removedAt: null },
  ],
  devices: [
    {
      deviceId: OWN_DEVICE,
      memberId: OWNER_MEMBER,
      publicKey: "AAAA",
      createdAt: NOW - 86_400_000,
      lastSeenAt: NOW,
      revokedAt: null,
    },
    {
      deviceId: PEER_DEVICE,
      memberId: OTHER_MEMBER,
      publicKey: "BBBB",
      createdAt: NOW - 3_600_000,
      lastSeenAt: NOW,
      revokedAt: null,
    },
  ],
  ownFingerprint: new Uint8Array(32).fill(0x11),
  memberNameOf: (memberId) =>
    memberId === OWNER_MEMBER ? "Анна" : memberId === OTHER_MEMBER ? "Борис" : null,
  ...extra,
});

describe("экран «Семья» без входа", () => {
  it("предлагает вход по адресу почты и не рисует ничего из семейного", () => {
    const markup = render();
    expect(markup).toContain("Вход по адресу почты");
    expect(markup).toContain('id="family-email"');
    expect(markup).toContain("Выслать код");
    expect(markup).not.toContain("Участники");
    expect(markup).not.toContain("Приглашение");
    // Индикатор честно говорит, что синхронизации нет.
    expect(markup).toContain("локально");
  });

  it("второй шаг спрашивает шестизначный код и даёт вернуться к адресу", () => {
    const markup = render({ awaitingLoginCode: true });
    expect(markup).toContain('id="family-login-code"');
    expect(markup).toContain('autoComplete="one-time-code"');
    expect(markup).toContain("Ввести другой адрес");
    expect(markup).toContain("Шесть цифр");
  });

  it("в сборке без адреса сервера не показывает форму входа вовсе", () => {
    const markup = render({ serverUrl: null });
    expect(markup).toContain("Синхронизация в этой сборке выключена");
    expect(markup).not.toContain('id="family-email"');
    expect(markup).not.toContain("Выслать код");
  });
});

describe("экран «Семья» после входа", () => {
  it("показывает участников, приглашение с кодом и сроком, выход и отзыв устройства", () => {
    const markup = render({
      ...signedInOwner(),
      invite: { code: "ABCDEFGHJKMN", expiresAt: NOW + 24 * 3_600_000, supersededCount: 1 },
    });
    expect(markup).toContain("Участники");
    expect(markup).toContain("владелец");
    expect(markup).toContain("участник");
    expect(markup).toContain("это вы");
    // Имя участника берётся из локального бюджета: на сервере его нет и быть не должно (2.2).
    expect(markup).toContain("Анна");
    expect(markup).toContain("Борис");
    expect(markup).toContain("ABCD-EFGH-JKMN");
    expect(markup).toContain("действует ещё 24 ч");
    expect(markup).toContain("Прежний код перестал действовать");
    expect(markup).toContain("Отозвать устройство");
    expect(markup).toContain("Выйти из учётной записи");
    // Владелец из семьи выйти не может — сервер это запрещает, и экран не предлагает.
    expect(markup).not.toContain("Выйти из семьи");
    expect(markup).toContain("Владелец не может выйти из семьи");
  });

  it("участнику предлагает выход из семьи и не предлагает выпуск приглашения", () => {
    const markup = render({
      ...signedInOwner(),
      session: { ...session, memberId: OTHER_MEMBER, role: "member" },
      membership: {
        familyId: session.familyId!,
        keyEpoch: 1,
        memberId: OTHER_MEMBER,
        role: "member",
        ownerMemberId: OWNER_MEMBER,
        rotation: null,
      },
    });
    expect(markup).toContain("Выйти из семьи");
    expect(markup).not.toContain("Выпустить код");
  });

  it("не показывает семейного, пока сервер не подтвердил членство, и предлагает создать или вступить", () => {
    const markup = render({ session, membership: null });
    expect(markup).toContain("Создать семью");
    expect(markup).toContain("Вступить по коду");
    expect(markup).toContain('id="family-join-code"');
    expect(markup).not.toContain("Участники");
  });

  it("незавершённую смену ключа показывает, а не прячет", () => {
    const base = signedInOwner();
    const markup = render({
      ...base,
      membership: { ...base.membership!, rotation: { keyEpoch: 2, startedAt: NOW - 7_200_000 } },
    });
    expect(markup).toContain("начата смена ключа");
    expect(markup).toContain("эпоха 2");
  });
});

describe("отпечатки ключей на экране", () => {
  it("своё устройство показывает отпечаток из собственной пары", () => {
    const own = new Uint8Array(32).fill(0x11);
    const markup = render(signedInOwner({ ownFingerprint: own }));
    expect(markup).toContain("Отпечаток этого устройства");
    expect(markup).toContain(formatKeyFingerprint(own));
    expect(markup).toContain("fingerprint-block own");
  });

  it("чужое устройство с закреплением показывает пин, а не значение сервера", () => {
    const pinned = new Uint8Array(32).fill(0x22);
    const offered = new Uint8Array(32).fill(0x33);
    const markup = render(
      signedInOwner({
        pinOf: (deviceId) =>
          (deviceId === PEER_DEVICE
            ? { state: "pinned", fingerprint: pinned }
            : { state: "absent" }) as PinState,
        offeredFingerprintOf: () => offered,
      }),
    );
    expect(markup).toContain(formatKeyFingerprint(pinned));
    expect(markup).not.toContain(formatKeyFingerprint(offered));
    expect(markup).toContain("Подтверждённый отпечаток");
    // Подтверждать нечего: пин уже есть, сравнение — это сравнение, а не создание.
    expect(markup).not.toContain("Отпечатки совпали — подтвердить");
  });

  it("без закрепления показывает помеченного непроверенного кандидата и кнопку подтверждения", () => {
    const offered = new Uint8Array(32).fill(0x33);
    const markup = render(signedInOwner({ offeredFingerprintOf: () => offered }));
    expect(markup).toContain("Непроверенный отпечаток");
    expect(markup).toContain("fingerprint-block unverified_candidate");
    expect(markup).toContain(formatKeyFingerprint(offered));
    expect(markup).toContain("Отпечатки совпали — подтвердить");
    expect(markup).toContain("пришло от сервера");
  });

  it("отозванное устройство честно говорит, что ключ на нём остался", () => {
    const base = signedInOwner();
    const markup = render({
      ...base,
      devices: base.devices!.map((device) =>
        device.deviceId === PEER_DEVICE ? { ...device, revokedAt: NOW - 60_000 } : device,
      ),
    });
    expect(markup).toContain("Устройство отозвано");
    expect(markup).toContain("отзывом не стирается");
  });
});

describe("тревога, уведомления и удержанные записи на экране", () => {
  const stopped = (attempts: number): SyncStatusReport => ({
    cursor: { keyEpoch: 1, seq: 4 },
    queued: 0,
    epoch: { keyEpoch: 1, keyDigest: "a".repeat(64), live: true },
    stop: {
      reason: "key_mismatch",
      seq: 5,
      opId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      attempts,
    },
  });

  it("тревога выводится как alert, без кнопки закрытия и с действием", () => {
    const markup = render({ ...signedInOwner(), status: stopped(10) });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Ключ семьи не совпадает");
    expect(markup).toContain("Сверить отпечатки ключей");
    expect(markup).toContain('href="#family-fingerprints"');
    expect(markup).toContain("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    // У тревоги нет ни «Понятно», ни «Закрыть», ни «Скрыть».
    const alarm = markup.slice(markup.indexOf("key-alarm"), markup.indexOf("</section>", markup.indexOf("key-alarm")));
    expect(alarm).not.toMatch(/Понятно|Закрыть|Скрыть/u);
  });

  it("обычная остановка — уведомление, которое можно закрыть", () => {
    const markup = render({
      ...signedInOwner(),
      status: {
        ...stopped(1),
        stop: {
          reason: "journal_incomplete",
          seq: 5,
          opId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          attempts: 1,
        },
      },
    });
    expect(markup).toContain("Журнал неполон");
    expect(markup).toContain("Понятно");
    expect(markup).not.toContain("Ключ семьи не совпадает");
  });

  it("тревога не получает памяти о закрытии, а обычная остановка получает", () => {
    const screen = readFileSync(new URL("./FamilyScreen.tsx", import.meta.url), "utf8");
    // Память о закрытии привязана к конверту и живёт только для обычной остановки.
    expect(screen).toContain("const [dismissedStopOpId, setDismissedStopOpId]");
    expect(screen).toContain("stop !== null && stop.opId === dismissedStopOpId ? null : syncNotice(stop)");
    // У тревоги такой ветки нет: она строится прямо из остановки и ничем не гасится.
    expect(screen).toContain("const alarm = syncAlarm(props.status?.stop ?? null);");
    expect(screen).not.toMatch(/dismissed[A-Za-z]*\s*[?&|]{1,2}[^\n]*alarm/u);
  });

  it("перечень удержанных сущностей показывается даже при пригодном к показу снимке", () => {
    const integrity: JournalIntegrity = {
      ready: true,
      problems: [],
      withheld: [
        { entity: "transaction", id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", reason: "unknown_reference" },
      ],
    };
    const markup = render({ ...signedInOwner(), integrity });
    expect(markup).toContain("Одна запись семьи не показана в бюджете");
    expect(markup).toContain("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(markup).toContain("ссылается на запись, которой в бюджете нет");
    expect(markup).toContain("Операция");
  });
});

describe("доступность экрана семьи", () => {
  it("держит цели нажатия не меньше 48 pt и объявляет смену состояния", () => {
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    expect(styles).toMatch(
      /\.family-screen button, \.family-screen a\.primary-button, \.family-screen select, \.family-screen input:not\(\[type="radio"\]\):not\(\[type="checkbox"\]\) \{ min-height: 48px; \}/u,
    );
    expect(styles).toMatch(
      /\.family-actions \.primary-button, \.family-actions \.secondary-button, \.family-actions \.danger-button \{ min-height: 48px; \}/u,
    );
    expect(styles).toContain(".sync-badge.error");

    const markup = render({
      ...signedInOwner(),
      message: "Код выслан.",
      status: {
        cursor: { keyEpoch: 1, seq: 4 },
        queued: 0,
        epoch: { keyEpoch: 1, keyDigest: "a".repeat(64), live: true },
        stop: null,
      },
    });
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-label="Состояние синхронизации: синхронизировано"');
  });

  it("каждая форма и каждое поле подписаны, а разделы озаглавлены", () => {
    const markup = render(signedInOwner());
    expect(markup).toContain('aria-labelledby="family-members-title"');
    expect(markup).toContain('aria-labelledby="family-devices-title"');
    expect(markup).toContain('aria-labelledby="family-exit-title"');

    const signIn = render();
    expect(signIn).toContain('<label for="family-email">');
    expect(signIn).toContain('aria-labelledby="family-signin-title"');
  });

  it("исходник экрана не изобретает новой навигации: возврат тем же приёмом, что и планирование", () => {
    const source = readFileSync(new URL("./FamilyScreen.tsx", import.meta.url), "utf8");
    expect(source).toContain('className="planning-toolbar"');
    expect(source).toContain("← К разделу «Ещё»");
    expect(source).toContain('className="screen-heading"');
    expect(source).toContain('className="section-card"');
  });
});
