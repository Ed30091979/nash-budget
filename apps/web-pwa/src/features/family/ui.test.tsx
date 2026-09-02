/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { SyncStatusReport } from "@family-budget/sync-client";
import type { JournalIntegrity } from "@family-budget/sync-protocol";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { FamilyConfirmation, FamilyScreen, type FamilyActions, type FamilyScreenProps } from "./FamilyScreen";
import { joinConsequence } from "./model";
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
    startRotation: vi.fn(),
    continueRotationWithGaps: vi.fn(),
    dismissRotation: vi.fn(),
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
    pinOf: () => ({ state: "absent" }),
    bindVerdictOf: () => null,
    offeredFingerprintOf: () => undefined,
    memberNameOf: () => null,
    localBudget: { transactions: [] },
    lastBackupAt: null,
    onCreateBackup: vi.fn(async () => undefined),
    invite: null,
    status: null,
    syncRound: "ok",
    integrity: null,
    rotation: null,
    epochAlarm: null,
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

const joinWarning = joinConsequence(3, null, (value) => value);

/** Отчёт с остановкой на подмене ключа: тревога, курсор стоит, очередь пуста. */
const stoppedStatus: SyncStatusReport = {
  cursor: { keyEpoch: 1, seq: 4 },
  queued: 0,
  epoch: { keyEpoch: 1, keyDigest: "a".repeat(64), live: true },
  stop: {
    reason: "key_mismatch",
    seq: 5,
    opId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    attempts: 10,
  },
};

/**
 * Диалог рисуется отдельно — так же, как он рисуется в приложении: порталом в тело документа,
 * вне `.family-screen`. Правило экрана до него не достаёт, и меряется он сам по себе.
 */
function renderDialog(overrides: Partial<ComponentProps<typeof FamilyConfirmation>> = {}): string {
  return renderToStaticMarkup(
    <FamilyConfirmation
      confirming={{ kind: "join", code: "ABCD-EFGH-JKMN" }}
      consequence={joinWarning}
      busy={false}
      backupState="idle"
      dialogRef={{ current: null }}
      cancelRef={{ current: null }}
      onBackup={() => undefined}
      onCancel={() => undefined}
      onConfirm={() => undefined}
      {...overrides}
    />,
  );
}

/* ── Каскад, посчитанный по факту ──────────────────────────────────────────────────────────────
 *
 * Строка `min-height: 48px`, найденная в файле стилей, не значит, что кнопка будет 48 pt: её
 * перебивает любое правило с большей специфичностью. Ровно так и уцелела находка «44 pt в
 * диалоге» — правило `.family-screen button { min-height: 48px }` до диалога не достаёт, а
 * `.dialog-actions button` стояло на 44. Поэтому здесь разбирается разметка, разбираются правила,
 * и для каждой кнопки считается то значение, которое победит.
 */
interface StyleNode {
  readonly tag: string;
  readonly classes: readonly string[];
  readonly attrs: Readonly<Record<string, string>>;
  readonly parent: StyleNode | null;
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function parseElements(html: string): StyleNode[] {
  const nodes: StyleNode[] = [];
  const open: StyleNode[] = [];
  const tagPattern = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'=<>`/]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>/gu;
  for (let match = tagPattern.exec(html); match !== null; match = tagPattern.exec(html)) {
    const [, closing, tag, rawAttributes, selfClosing] = match;
    if (closing === "/") {
      open.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrPattern = /([^\s"'=<>`/]+)(?:\s*=\s*"([^"]*)")?/gu;
    for (let attr = attrPattern.exec(rawAttributes ?? ""); attr !== null; attr = attrPattern.exec(rawAttributes ?? "")) {
      attrs[attr[1]!.toLowerCase()] = attr[2] ?? "";
    }
    const node: StyleNode = {
      tag: tag!.toLowerCase(),
      classes: (attrs.class ?? "").split(/\s+/u).filter((name) => name.length > 0),
      attrs,
      parent: open.at(-1) ?? null,
    };
    nodes.push(node);
    if (selfClosing !== "/" && !VOID_TAGS.has(node.tag)) open.push(node);
  }
  return nodes;
}

interface MinHeightRule {
  readonly selector: string;
  readonly px: number;
  readonly inMedia: boolean;
  readonly order: number;
}

function minHeightRules(css: string): MinHeightRule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: MinHeightRule[] = [];
  const preludes: string[] = [];
  let buffer = "";
  let order = 0;
  for (const character of source) {
    if (character === "{") {
      preludes.push(buffer.trim());
      buffer = "";
      continue;
    }
    if (character === "}") {
      const prelude = preludes.pop() ?? "";
      const declared = /(?:^|;)\s*min-height:\s*([\d.]+)px\s*(?:;|$)/u.exec(buffer);
      if (prelude.length > 0 && !prelude.startsWith("@") && declared !== null) {
        const inMedia = preludes.some((outer) => outer.startsWith("@"));
        for (const selector of prelude.split(",")) {
          rules.push({ selector: selector.trim(), px: Number(declared[1]), inMedia, order: (order += 1) });
        }
      }
      buffer = "";
      continue;
    }
    buffer += character;
  }
  return rules;
}

function matchesCompound(node: StyleNode | null, compound: string): boolean {
  if (node === null) return false;
  const negations: string[] = [];
  const rest = compound.replace(/:not\(([^)]*)\)/gu, (_full, inner: string) => {
    negations.push(inner);
    return "";
  });
  // Псевдокласс состояния (`:focus-visible`, `:disabled`) статической разметке не соответствует.
  if (rest.includes(":")) return false;
  const tokens = rest.match(/^[a-zA-Z][\w-]*|\.[\w-]+|\[[^\]]+\]/gu) ?? [];
  if (tokens.join("") !== rest) return false;
  for (const token of tokens) {
    if (token.startsWith(".")) {
      if (!node.classes.includes(token.slice(1))) return false;
    } else if (token.startsWith("[")) {
      const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/u.exec(token);
      if (attribute === null) return false;
      const value = node.attrs[attribute[1]!];
      if (value === undefined) return false;
      if (attribute[2] !== undefined && value !== attribute[2]) return false;
    } else if (node.tag !== token.toLowerCase()) return false;
  }
  return negations.every((inner) => !matchesCompound(node, inner));
}

function matchesSelector(node: StyleNode, selector: string): boolean {
  const parts = selector.split(/\s+/u).filter((part) => part.length > 0);
  let index = parts.length - 1;
  if (!matchesCompound(node, parts[index]!)) return false;
  let current: StyleNode | null = node;
  index -= 1;
  while (index >= 0) {
    let child = false;
    if (parts[index] === ">") {
      child = true;
      index -= 1;
      if (index < 0) return false;
    }
    const compound = parts[index]!;
    if (child) {
      current = current?.parent ?? null;
      if (!matchesCompound(current, compound)) return false;
    } else {
      let ancestor: StyleNode | null = current?.parent ?? null;
      while (ancestor !== null && !matchesCompound(ancestor, compound)) ancestor = ancestor.parent;
      if (ancestor === null) return false;
      current = ancestor;
    }
    index -= 1;
  }
  return true;
}

function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/gu) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]/gu) ?? []).length;
  const tags = (selector.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/gu) ?? []).length;
  return ids * 10_000 + classes * 100 + tags;
}

/** Значение, которое победит на этом элементе, — или `null`, если его не задаёт никто. */
function computedMinHeight(node: StyleNode, rules: readonly MinHeightRule[]): number | null {
  let winner: MinHeightRule | null = null;
  for (const rule of rules) {
    if (rule.inMedia || !matchesSelector(node, rule.selector)) continue;
    if (
      winner === null ||
      specificity(rule.selector) > specificity(winner.selector) ||
      (specificity(rule.selector) === specificity(winner.selector) && rule.order > winner.order)
    ) {
      winner = rule;
    }
  }
  return winner?.px ?? null;
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
      bindProof: null,
      inviteId: null,
      createdAt: NOW - 86_400_000,
      lastSeenAt: NOW,
      revokedAt: null,
    },
    {
      deviceId: PEER_DEVICE,
      memberId: OTHER_MEMBER,
      publicKey: "BBBB",
      bindProof: null,
      inviteId: null,
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
          deviceId === PEER_DEVICE
            ? { state: "pinned", fingerprint: pinned }
            : { state: "absent" },
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
    ...stoppedStatus,
    stop: { ...stoppedStatus.stop!, attempts },
  });

  it("тревога выводится как alert, без кнопки закрытия и с действием", () => {
    const markup = render({ ...signedInOwner(), status: stopped(10) });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Ключ семьи не совпадает");
    expect(markup).toContain("Сверить отпечатки ключей");
    // Переход к сверке — кнопка с переводом фокуса, а не адрес с решёткой: якорь писал бы в
    // историю браузера, и фокус за ним идёт не во всяком браузере.
    expect(markup).not.toContain('href="#family-fingerprints"');
    expect(markup).toContain('id="family-fingerprints" tabindex="-1"');
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

  it("«Вступить» открывает предупреждение, а не вступает", () => {
    const actions = noopActions();
    const markup = render({ session, membership: null, actions, localBudget: { transactions: [1, 2, 3] } });
    // До нажатия предупреждения на экране нет, и никто никуда не вступил.
    expect(markup).toContain("Вступить по коду");
    expect(markup).not.toContain("После вступления здесь будет бюджет семьи");
    expect(actions.joinByCode).not.toHaveBeenCalled();

    const screen = readFileSync(new URL("./FamilyScreen.tsx", import.meta.url), "utf8");
    // Кнопка формы открывает вопрос…
    expect(screen).toContain('setConfirming({ kind: "join", code });');
    // …и код уходит только из подтверждения диалога. Другого вызова в файле нет.
    expect(screen).toContain('if (confirming.kind === "join") props.actions.joinByCode(confirming.code);');
    expect(screen.match(/actions\.joinByCode\(/gu)).toHaveLength(1);
  });

  it("предупреждение предлагает копию на месте и объявляет её результат", () => {
    const screen = readFileSync(new URL("./FamilyScreen.tsx", import.meta.url), "utf8");
    expect(screen).toContain("props.onCreateBackup().then(");

    const idle = renderDialog();
    expect(idle).toContain(joinWarning.backupLine);
    expect(idle).toContain(joinWarning.backupActionLabel);

    // Пока файл готовится, вступить нельзя: иначе бюджет сменится раньше, чем копия ляжет на диск.
    const running = renderDialog({ backupState: "running" });
    expect(running.match(/<button[^>]*disabled/gu)).toHaveLength(3);
    expect(running).toContain("Копия готовится…");

    const done = renderDialog({ backupState: "done" });
    expect(done).toContain('role="status"');
    expect(done).toContain("Копия скачана.");
    expect(renderDialog({ backupState: "failed" })).toContain('role="alert"');
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

describe("типографика: «код и отпечаток» — роль из DESIGN.md, а не изобретение экрана", () => {
  const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const design = readFileSync(new URL("../../../../../DESIGN.md", import.meta.url), "utf8");
  const MONOSPACE = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

  it("моноширинный стек назван в документе и берётся из токена, а не переписывается в правилах", () => {
    // Роль введена в §4 явно: код приглашения и отпечаток ключа диктуют голосом, и ноль там
    // обязан отличаться от «O». Всё остальное — системный стек.
    expect(design).toContain("| `code` — код приглашения, отпечаток ключа |");
    expect(design).toContain(`font-family: ${MONOSPACE};`);
    expect(styles).toContain(`--font-code: ${MONOSPACE};`);

    const stacks = styles.match(/font-family: [^;]+;/gu) ?? [];
    expect(new Set(stacks)).toEqual(
      new Set([
        'font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif;',
        "font-family: var(--font-code);",
      ]),
    );
  });

  it("трекинг — только значения из таблицы §4", () => {
    const approved = new Set(["-0.02em", "-0.01em", "0", "0.08em", "var(--tracking-code)"]);
    const tracking = (styles.match(/letter-spacing: ([^;]+);/gu) ?? []).map((declaration) =>
      declaration.slice("letter-spacing: ".length, -1),
    );
    expect(tracking.length).toBeGreaterThan(0);
    for (const value of tracking) expect(approved).toContain(value);
    // Токен роли — тоже утверждённое значение, а не третий трекинг мимо документа.
    expect(styles).toContain("--tracking-code: 0.08em;");
    expect(design).toContain("`letter-spacing` больше 0.08em");
  });

  it("подпись тревоги не разбавляет документированную пару контраста прозрачностью", () => {
    const alarm = styles.slice(styles.indexOf(".key-alarm {"), styles.indexOf(".family-notice"));
    expect(alarm).toContain("background: var(--red-soft)");
    expect(alarm).toContain("color: var(--red-ink)");
    expect(alarm).not.toContain("opacity");
  });
});

describe("доступность экрана семьи", () => {
  it("держит цели нажатия не меньше 48 pt и объявляет смену состояния", () => {
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    expect(styles).toMatch(
      /\.family-screen button, \.family-screen select, \.family-screen input:not\(\[type="radio"\]\):not\(\[type="checkbox"\]\) \{ min-height: 48px; \}/u,
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

  it("цели нажатия в диалоге — 48 pt по факту, а не по строке в файле стилей", () => {
    const rules = minHeightRules(readFileSync(new URL("../../styles.css", import.meta.url), "utf8"));
    const dialog = parseElements(renderDialog());
    const buttons = dialog.filter((node) => node.tag === "button");

    // Три кнопки: «сделать копию», «Отмена» и подтверждение. Ни одной не потерять.
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(computedMinHeight(button, rules)).toBeGreaterThanOrEqual(48);
    }

    // И ни одно правило под медиазапросом не опускает их обратно на узком экране.
    for (const button of buttons) {
      for (const rule of rules) {
        if (rule.inMedia && matchesSelector(button, rule.selector)) {
          expect(rule.px).toBeGreaterThanOrEqual(48);
        }
      }
    }
  });

  it("считает каскад так же, как браузер: побеждает специфичность, а не порядок строк", () => {
    // Проверка самой проверки. Правило экрана до диалога не достаёт — и меньшее значение из
    // общего правила не должно выигрывать у большего из более специфичного.
    const rules = minHeightRules(
      ".family-screen button { min-height: 48px; }\n" +
        "button { min-height: 44px; }\n" +
        ".dialog-actions button { min-height: 40px; }\n" +
        "@media (max-width: 360px) { .dialog-actions button { min-height: 32px; } }\n",
    );
    const [outer, inner] = parseElements(
      '<div class="dialog-actions"><button type="button">Отмена</button></div>',
    );

    expect(outer?.tag).toBe("div");
    expect(computedMinHeight(inner!, rules)).toBe(40);
    expect(rules.filter((rule) => rule.inMedia)).toHaveLength(1);
    expect(matchesSelector(inner!, ".family-screen button")).toBe(false);
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
    expect(source).toContain("<BackButton label=\"К разделу «Ещё»\" onClick={props.onBack} />");
    expect(source).toContain('className="screen-heading"');
    expect(source).toContain('className="section-card"');
    // Ни одного перехода по адресу с решёткой: он пишет в историю браузера, а фокус за ним
    // идёт не во всяком браузере. Переход к сверке — кнопка с переводом фокуса.
    expect(source).not.toMatch(/href="#/u);
  });

  it("действие тревоги переводит фокус на раздел сверки, а не прыгает по якорю", () => {
    const source = readFileSync(new URL("./FamilyScreen.tsx", import.meta.url), "utf8");
    expect(source).toContain("fingerprintsRef.current?.focus({ preventScroll: true })");
    expect(source).toContain('fingerprintsRef.current?.scrollIntoView({ block: "start" })');

    // Цель перехода — сама себе точка фокуса, как и основное содержимое приложения.
    const markup = render({ ...signedInOwner(), status: stoppedStatus });
    expect(markup).toContain('id="family-fingerprints" tabindex="-1"');
    const alarm = markup.slice(markup.indexOf("key-alarm"), markup.indexOf("</section>", markup.indexOf("key-alarm")));
    expect(alarm).toContain("<button");
    expect(alarm).not.toContain("<a ");
  });

  it("после закрытия диалога фокус возвращается кнопке, которая его открыла", () => {
    const source = readFileSync(new URL("./FamilyScreen.tsx", import.meta.url), "utf8");
    // Третьим аргументом — кнопка-инициатор, как на соседнем экране «Данные». С `null` фокус
    // после Esc и «Отмены» падал на тело документа, и следующий Tab начинал обход сначала.
    expect(source).toMatch(
      /activateDialogEnvironment\(\s*document\.getElementById\("root"\),\s*cancelRef\.current,\s*dialogTriggerRef\.current,\s*\)/u,
    );
    const neighbour = readFileSync(
      new URL("../data-management/DataManagementScreen.tsx", import.meta.url),
      "utf8",
    );
    expect(neighbour).toContain("clearTriggerRef.current,");

    // И запоминает её каждый, кто диалог открывает: сколько открытий, столько и запоминаний.
    const opens = source.match(/setConfirming\(\{ kind:/gu) ?? [];
    const records = source.match(/dialogTriggerRef\.current = /gu) ?? [];
    expect(opens).toHaveLength(3);
    expect(records).toHaveLength(opens.length);
  });

  it("«Понятно» на уведомлении не стирает сообщение об успехе", () => {
    const source = readFileSync(new URL("./FamilyScreen.tsx", import.meta.url), "utf8");
    // Гашение уведомления — состояние экрана и ничего больше. Прежде оно же звало действие
    // контроллера, которое стирало `message` — сообщение постороннего удавшегося действия.
    expect(source).toContain("onClick={() => setDismissedStopOpId(stop?.opId ?? null)}");
    const controller = readFileSync(new URL("./controller.ts", import.meta.url), "utf8");
    expect(controller).not.toContain("dismissNotice");

    // Оба сообщения живут на экране одновременно и друг о друге не знают.
    const markup = render({
      ...signedInOwner(),
      message: "Отпечаток закреплён.",
      status: {
        ...stoppedStatus,
        stop: { reason: "journal_incomplete", seq: 5, opId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", attempts: 1 },
      },
    });
    expect(markup).toContain("Отпечаток закреплён.");
    expect(markup).toContain("Журнал неполон");
  });
});

describe("смена ключа семьи на экране", () => {
  it("владелец видит раздел, участник — не видит: ротацию делает устройство владельца", () => {
    const owner = render(signedInOwner());
    expect(owner).toContain("Ключ семьи");
    expect(owner).toContain("Сменить ключ семьи");
    expect(owner).toContain("Сейчас действует эпоха 1");

    const base = signedInOwner();
    const member = render({
      ...base,
      membership: { ...base.membership!, role: "member", memberId: OTHER_MEMBER },
    });
    expect(member).not.toContain("Сменить ключ семьи");
  });

  it("отозванное устройство поднимает раздел до «пора сменить», а не до одной справки", () => {
    const base = signedInOwner();
    const markup = render({
      ...base,
      devices: base.devices!.map((device) =>
        device.deviceId === PEER_DEVICE ? { ...device, revokedAt: NOW - 60_000 } : device,
      ),
    });
    // Прежде экран говорил «ключ, лежащий на нём, отзывом не стирается» и не давал ничего, чем
    // его отобрать. Теперь то же предложение кончается кнопкой.
    expect(markup).toContain("Ключ пора сменить");
    expect(markup).toContain("открывает всё, что семья запишет дальше");
    expect(markup).toMatch(/class="primary-button"[^>]*>\s*Сменить ключ семьи/u);
  });

  it("во время ротации показывает фазу, счёт и то, что будет при обрыве", () => {
    const markup = render(
      signedInOwner({
        rotation: {
          kind: "running",
          progress: {
            phase: "uploading",
            keyEpoch: 2,
            previousKeyEpoch: 1,
            freezeSeq: 40,
            moved: 200,
            total: 400,
          },
        },
      }),
    );
    expect(markup).toContain("Загружаем новую эпоху: 200 из 400");
    expect(markup).toContain("остаются оба ключа");
    expect(markup).toContain("возьмёт следующий номер эпохи");
    expect(markup).toContain("вся семья не может отправлять новые записи");
    expect(markup).toContain("Смена ключа идёт…");
  });

  it("остановка на разрыве называет номера и оставляет решение человеку", () => {
    const markup = render(
      signedInOwner({
        rotation: {
          kind: "halted",
          keyEpoch: 2,
          freezeSeq: 12,
          gap: { missing: [7, 8], undecryptable: [11] },
        },
      }),
    );
    expect(markup).toContain("Журнал неполон");
    expect(markup).toContain("1 … 12");
    expect(markup).toContain("не отданы сервером: 7, 8");
    expect(markup).toContain("пришли, но не читаются ключом этой эпохи: 11");
    // Ровно то, ради чего проверка стоит до переноса: после него разрыв стал бы историей.
    expect(markup).toContain("станет законной новой историей");
    expect(markup).toContain("Продолжить без этих записей");
    expect(markup).toContain("Отложить");
    // Пока человек решает, запись в семье открыта: попытка на сервере отменена.
    expect(markup).toContain("Попытка на сервере отменена");
  });

  it("итог перечисляет, кто получил ключ и кто остался без него и почему", () => {
    const markup = render(
      signedInOwner({
        rotation: {
          kind: "done",
          keyEpoch: 2,
          previousKeyEpoch: 1,
          moved: 137,
          wrapped: [PEER_DEVICE],
          skipped: [
            { deviceId: OWN_DEVICE, reason: "revoked" },
            { deviceId: OTHER_MEMBER, reason: "not_pinned" },
          ],
          inheritedGaps: [7, 8],
        },
      }),
    );
    expect(markup).toContain("эпоха 1 → 2");
    expect(markup).toContain("перенесено записей 137");
    expect(markup).toContain("отозвано — ради этого смена ключа и делается");
    expect(markup).toContain("отпечаток не закреплён");
    expect(markup).toContain("не перенесены записи с номерами 7, 8");
  });
});
