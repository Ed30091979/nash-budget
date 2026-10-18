/**
 * The «Семья» screen.
 *
 * Layout follows the screens that already exist rather than inventing anything: the back button of
 * the planning screen, the `screen-heading` of «Ещё», the `section-card` and `plan-row` of the year
 * screen, the confirmation dialog of the data screen. Decision 42 allows the composition to be
 * approved from the working result, and narrows it in the same breath — only the approved palette
 * and typography, and no new navigation idiom.
 *
 * The component is presentational and holds only form state. Everything that talks to a server or
 * to WebCrypto is a callback in {@link FamilyActions}, so the markup can be rendered and asserted
 * without either.
 */
import { type FormEvent, type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SyncStatusReport } from "@family-budget/sync-client";
import type { JournalIntegrity } from "@family-budget/sync-protocol";

import { BackButton } from "../../components/BackButton";
import { Icon } from "../../components/Icon";
import { activateDialogEnvironment, handleDialogKeyboard } from "../data-management/dialog-accessibility";
import type { DeviceRecord, MemberRecord, MembershipSnapshot } from "./api";
import type { RotationState } from "./controller";
import { formatLastBackupDate } from "../data-management/model";
import {
  MEMBER_ROLE_LABELS,
  documentHoldNotice,
  formatInviteCode,
  formatInviteExpiry,
  isValidEmail,
  isValidLoginCode,
  joinConsequence,
  normalizeLoginCode,
  ownFingerprintPresentation,
  peerFingerprintPresentation,
  rotationGapSummary,
  rotationProgressLine,
  ROTATION_SKIP_REASONS,
  syncAlarm,
  syncIndicatorPresentation,
  syncNotice,
  withheldHeadline,
  withheldRows,
  type JoinConsequence,
  type LocalPinState,
  type SyncRoundOutcome,
} from "./model";
import type { FamilySession } from "./session";

/**
 * An invite this device issued and is still reading out to somebody.
 *
 * `code` is `null` for a live invite whose code this session no longer holds. That is the ordinary
 * state after a reload and not a failure: 6.3 keeps the code out of the local database entirely,
 * so it exists on the screen it was issued on and nowhere else.
 */
export interface ActiveInvite {
  readonly code: string | null;
  readonly expiresAt: number;
  readonly supersededCount: number;
}

export interface FamilyActions {
  requestLoginCode(email: string): void;
  submitLoginCode(code: string): void;
  cancelLoginCode(): void;
  signOut(): void;
  createFamily(): void;
  issueInvite(): void;
  joinByCode(code: string): void;
  leaveFamily(): void;
  removeMember(memberId: string): void;
  revokeDevice(deviceId: string): void;
  /** 5.5: смена ключа семьи. Делает её устройство владельца, и никто больше. */
  startRotation(): void;
  /** Продолжить после остановки на неполном журнале — осознанным решением человека. */
  continueRotationWithGaps(): void;
  /** Убрать с экрана итог или отказ прошлой попытки. */
  dismissRotation(): void;
  /** 5.4.1: the person's confirmation is what *creates* the pin. Nothing else may create one. */
  confirmFingerprint(deviceId: string): void;
}

export interface FamilyScreenProps {
  /** `null` means this build has no server configured — the local-only product, and it says so. */
  readonly serverUrl: string | null;
  readonly session: FamilySession | null;
  readonly membership: MembershipSnapshot | null;
  readonly members: readonly MemberRecord[];
  readonly devices: readonly DeviceRecord[];
  /** This device's own fingerprint, computed from its own public key. Never from a response. */
  readonly ownFingerprint: Uint8Array | null;
  readonly pinOf: (deviceId: string) => LocalPinState;
  /**
   * The verdict of the automatic binding check (6.4), or `null` when it never ran for this device.
   *
   * Rendered rather than only stored, because 6.4 asks for exactly that: «Расхождение — устройство
   * помечено как "ключ не подтверждён", владелец получает предупреждение».
   */
  readonly bindVerdictOf: (deviceId: string) => "bound" | "failed" | null;
  /** `SHA-256(SPKI)` as the server offered it. Used only where no pin exists (5.4). */
  readonly offeredFingerprintOf: (deviceId: string) => Uint8Array | undefined;
  /** Names for the identifiers the server list carries. They live in the budget, not on a server. */
  readonly memberNameOf: (memberId: string) => string | null;
  /**
   * The budget this device holds right now — what the join warning is about.
   *
   * Only the shape the warning reads is required, so a test does not have to build a whole budget
   * to assert the wording. The screen is unreachable before onboarding, so there is always one.
   */
  readonly localBudget: { readonly transactions: { readonly length: number } };
  /** ISO moment of the last successful backup, or `null` when none was ever made. */
  readonly lastBackupAt: string | null;
  /** Makes a backup from the family screen, so the warning can offer one instead of only naming it. */
  readonly onCreateBackup: () => Promise<void>;
  readonly invite: ActiveInvite | null;
  readonly status: SyncStatusReport | null;
  /** Чем кончился последний круг синхронизации. Отчёт о нём молчит — см. `runSyncRound`. */
  readonly syncRound: SyncRoundOutcome;
  readonly integrity: JournalIntegrity | null;
  /** Ход смены ключа семьи (5.5), или `null`, когда её в этой сессии не начинали. */
  readonly rotation: RotationState | null;
  /** Тревога «смена ключа не подтверждена» — 5.5 шаг 8. Не гасится сама и не гасится кнопкой. */
  readonly epochAlarm: string | null;
  readonly now: number;
  readonly busy: boolean;
  readonly message: string | null;
  readonly error: string | null;
  /** True between «выслать код» and the code being accepted or cancelled. */
  readonly awaitingLoginCode: boolean;
  readonly actions: FamilyActions;
  readonly onBack: () => void;
}

const dateTime = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });

function formatMoment(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateTime.format(date);
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

/** Вопрос, который экран задаёт перед необратимым действием, и ничего больше. */
type Confirmation =
  | { readonly kind: "leave" }
  | { readonly kind: "revoke"; readonly deviceId: string }
  | { readonly kind: "join"; readonly code: string };

/** Копию делает экран «Данные»; здесь та же кнопка на месте вопроса и своя занятость. */
type BackupState = "idle" | "running" | "done" | "failed";

export function FamilyScreen(props: FamilyScreenProps) {
  const [email, setEmail] = useState(props.session?.email ?? "");
  const [loginCode, setLoginCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  // The ordinary stop is dismissible and the alarm is not, so only this one gets a memory — and it
  // remembers *which* envelope was dismissed: a stop on a different `opId` is a different fact and
  // comes back on its own.
  const [dismissedStopOpId, setDismissedStopOpId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  // Копию делает экран «Данные», а здесь — та же кнопка на месте вопроса, поэтому и занятость
  // своя: `props.busy` принадлежит семье и о выгрузке файла ничего не знает.
  const [backupState, setBackupState] = useState<BackupState>("idle");
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<(() => void) | null>(null);
  // Кнопка, которой диалог открыли. Без неё Esc и «Отмена» роняли фокус на тело документа, и
  // следующий Tab начинал обход экрана сначала — от кнопки «назад», а не от того места, где
  // человек работал. Экран «Данные» делает ровно это же своим `clearTriggerRef`.
  const dialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const joinSubmitRef = useRef<HTMLButtonElement>(null);
  // 5.4.1 начинается по кнопке тревоги, и переход к сверке — перевод фокуса, а не адрес с
  // решёткой: якорь писал бы в историю браузера, а фокус за ним идёт не во всяком браузере.
  const fingerprintsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (confirming === null) return;
    restoreRef.current = activateDialogEnvironment(
      document.getElementById("root"),
      cancelRef.current,
      dialogTriggerRef.current,
    );
    return () => {
      restoreRef.current?.();
      restoreRef.current = null;
    };
  }, [confirming]);

  // Bound once so that TypeScript's narrowing survives into the callbacks below: `props.x` is a
  // property access and is re-widened inside every closure, which would make the membership branch
  // unwritable without a non-null assertion on every line.
  const session = props.session;
  const membership = props.membership;
  const indicator = syncIndicatorPresentation(props.status, props.syncRound);
  const alarm = syncAlarm(props.status?.stop ?? null);
  const stop = props.status?.stop ?? null;
  const notice = stop !== null && stop.opId === dismissedStopOpId ? null : syncNotice(stop);
  const hold = documentHoldNotice(props.status?.hold ?? null);
  const withheld = withheldRows(props.integrity);
  const headline = withheldHeadline(withheld);
  // Не `memberNameOf`: так звался и проп рядом, и два разных обращения с одним именем стояли
  // в трёх строках друг от друга. Здесь — запись участника, там — его имя.
  const memberById = new Map(props.members.map((member) => [member.memberId, member]));

  const submitEmail = (event: FormEvent) => {
    event.preventDefault();
    if (isValidEmail(email)) props.actions.requestLoginCode(email);
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (isValidLoginCode(loginCode)) props.actions.submitLoginCode(normalizeLoginCode(loginCode));
  };

  // Вступление — единственное необратимое действие этого экрана, которое меняет то, что человек
  // видит каждый день, поэтому кнопка открывает вопрос, а не отправляет код.
  const submitJoin = (event: FormEvent) => {
    event.preventDefault();
    const code = joinCode.trim();
    if (code.length === 0) return;
    setBackupState("idle");
    dialogTriggerRef.current = joinSubmitRef.current;
    setConfirming({ kind: "join", code });
  };

  const runBackup = () => {
    setBackupState("running");
    props.onCreateBackup().then(
      () => setBackupState("done"),
      () => setBackupState("failed"),
    );
  };

  const consequence =
    confirming?.kind === "join"
      ? joinConsequence(props.localBudget.transactions.length, props.lastBackupAt, formatLastBackupDate)
      : null;

  const dialog = confirming === null ? null : (
    <FamilyConfirmation
      confirming={confirming}
      consequence={consequence}
      busy={props.busy}
      backupState={backupState}
      dialogRef={dialogRef}
      cancelRef={cancelRef}
      onBackup={runBackup}
      onCancel={() => setConfirming(null)}
      onConfirm={() => {
        if (confirming.kind === "join") props.actions.joinByCode(confirming.code);
        else if (confirming.kind === "leave") props.actions.leaveFamily();
        else props.actions.revokeDevice(confirming.deviceId);
        setConfirming(null);
      }}
    />
  );

  return (
    <section className="family-screen" aria-busy={props.busy}>
      <div className="planning-toolbar">
        <BackButton label="К разделу «Ещё»" onClick={props.onBack} />
      </div>

      <div className="screen-heading">
        <div>
          <span className="card-kicker">Совместный доступ</span>
          <h1>Семья</h1>
          <p>
            Синхронизация необязательна. Пока вы не вошли, приложение работает как раньше: локально,
            без сети и без учётной записи.
          </p>
        </div>
        <span className={indicator.className} role="status" aria-label={indicator.ariaLabel}>
          {indicator.text}
        </span>
      </div>

      {alarm ? (
        <section className="key-alarm" role="alert" aria-labelledby="key-alarm-title">
          <span className="key-alarm-mark" aria-hidden="true">
            !
          </span>
          <div>
            <h2 id="key-alarm-title">{alarm.title}</h2>
            <p>{alarm.body}</p>
            <p className="key-alarm-data">
              Остановлено на записи <code>{alarm.opId}</code>, номер <b>{alarm.seq}</b>, попыток подряд{" "}
              <b>{alarm.attempts}</b>.
            </p>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                fingerprintsRef.current?.focus({ preventScroll: true });
                fingerprintsRef.current?.scrollIntoView({ block: "start" });
              }}
            >
              {alarm.actionLabel}
            </button>
          </div>
        </section>
      ) : null}

      {props.epochAlarm ? (
        <section className="key-alarm" role="alert" aria-labelledby="epoch-alarm-title">
          <span className="key-alarm-mark" aria-hidden="true">
            !
          </span>
          <div>
            <h2 id="epoch-alarm-title">Смена ключа семьи не подтверждена</h2>
            <p>{props.epochAlarm}</p>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                fingerprintsRef.current?.focus({ preventScroll: true });
                fingerprintsRef.current?.scrollIntoView({ block: "start" });
              }}
            >
              Сверить отпечатки ключей
            </button>
          </div>
        </section>
      ) : null}

      {hold ? (
        <section className="section-card family-notice family-hold" role="alert" aria-labelledby="family-hold-title">
          <div className="section-title">
            <div>
              <h2 id="family-hold-title">{hold.title}</h2>
              <p>{hold.body}</p>
            </div>
          </div>
        </section>
      ) : null}

      {notice ? (
        <section className="section-card family-notice" role="status">
          <div className="section-title">
            <div>
              <h2>{notice.title}</h2>
              <p>{notice.body}</p>
            </div>
          </div>
          <button
            className="secondary-button"
            type="button"
            // Только состояние экрана: прежде здесь же гасилось `message` контроллера, то есть
            // сообщение об успехе постороннего действия исчезало от «Понятно» на уведомлении.
            onClick={() => setDismissedStopOpId(stop?.opId ?? null)}
          >
            Понятно
          </button>
        </section>
      ) : null}

      {headline ? (
        <section className="section-card family-withheld" aria-labelledby="family-withheld-title">
          <div className="section-title">
            <div>
              <h2 id="family-withheld-title">{headline}</h2>
              <p>
                Эти записи семья прислала, но показать их в бюджете нельзя. Они не удалены: журнал
                хранит их, и часть из них вернётся сама, когда придёт то, чего им не хватает.
              </p>
            </div>
          </div>
          <ul className="withheld-list">
            {withheld.map((row) => (
              <li key={`${row.entity}-${row.id}-${row.reason}`}>
                <strong>{row.entityLabel}</strong>
                <code>{row.id}</code>
                <small>{row.reasonLabel}</small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {props.error ? (
        <p className="family-error" role="alert">
          {props.error}
        </p>
      ) : null}
      {props.message ? (
        <p className="family-message" role="status" aria-live="polite">
          {props.message}
        </p>
      ) : null}

      {props.serverUrl === null ? (
        <section className="section-card">
          <div className="section-title">
            <div>
              <h2>Синхронизация в этой сборке выключена</h2>
              <p>Адрес сервера семьи задаётся конфигурацией сборки и в неё не зашит.</p>
            </div>
          </div>
          <p className="body-copy">
            Бюджет полностью работает без неё: все данные лежат на этом устройстве, сеть не нужна.
          </p>
        </section>
      ) : session === null ? (
        <section className="section-card" aria-labelledby="family-signin-title">
          <div className="section-title">
            <div>
              <h2 id="family-signin-title">Вход по адресу почты</h2>
              <p>Мы вышлем шестизначный код. Пароля нет, почта — единственные личные данные.</p>
            </div>
          </div>
          {props.awaitingLoginCode ? (
            <form className="form-grid" onSubmit={submitCode}>
              <div className="field">
                <label htmlFor="family-login-code">Код из письма</label>
                <input
                  id="family-login-code"
                  name="family-login-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={loginCode}
                  aria-describedby="family-login-code-note"
                  onChange={(event) => setLoginCode(normalizeLoginCode(event.target.value))}
                />
                <small id="family-login-code-note">Шесть цифр. Код живёт десять минут.</small>
              </div>
              <div className="family-actions">
                <button className="primary-button" type="submit" disabled={props.busy || !isValidLoginCode(loginCode)}>
                  Войти
                </button>
                <button className="secondary-button" type="button" disabled={props.busy} onClick={props.actions.cancelLoginCode}>
                  Ввести другой адрес
                </button>
              </div>
            </form>
          ) : (
            <form className="form-grid" onSubmit={submitEmail}>
              <div className="field">
                <label htmlFor="family-email">Адрес почты</label>
                <input
                  id="family-email"
                  name="family-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <div className="family-actions">
                <button className="primary-button" type="submit" disabled={props.busy || !isValidEmail(email)}>
                  Выслать код
                </button>
              </div>
            </form>
          )}
        </section>
      ) : membership === null ? (
        <>
          <section className="section-card" aria-labelledby="family-create-title">
            <div className="section-title">
              <div>
                <h2 id="family-create-title">Создать семью</h2>
                <p>Ключ семьи будет создан на этом устройстве. Сервер его не увидит.</p>
              </div>
            </div>
            <p className="body-copy">Вход выполнен как {session.email}.</p>
            <div className="family-actions">
              <button className="primary-button" type="button" disabled={props.busy} onClick={props.actions.createFamily}>
                Создать семью
              </button>
              <button className="secondary-button" type="button" disabled={props.busy} onClick={props.actions.signOut}>
                Выйти из учётной записи
              </button>
            </div>
          </section>

          <section className="section-card" aria-labelledby="family-join-title">
            <div className="section-title">
              <div>
                <h2 id="family-join-title">Вступить по коду</h2>
                <p>Двенадцать символов, которые вам продиктовал владелец семьи.</p>
              </div>
            </div>
            <form className="form-grid" onSubmit={submitJoin}>
              <div className="field">
                <label htmlFor="family-join-code">Код приглашения</label>
                <input
                  id="family-join-code"
                  name="family-join-code"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={joinCode}
                  onChange={(event) => setJoinCode(event.target.value)}
                />
              </div>
              <div className="family-actions">
                <button
                  ref={joinSubmitRef}
                  className="primary-button"
                  type="submit"
                  disabled={props.busy || joinCode.trim().length === 0}
                >
                  Вступить
                </button>
              </div>
            </form>
          </section>
        </>
      ) : (
        <>
          <section className="section-card" aria-labelledby="family-members-title">
            <div className="section-title">
              <div>
                <h2 id="family-members-title">Участники</h2>
                <p>Список ведёт сервер. Он не знает имён — только роли и даты.</p>
              </div>
            </div>
            <div className="plan-list">
              {props.members.map((member) => (
                <article className="plan-row" key={member.memberId}>
                  <span className="plan-icon">
                    <Icon name="users" size={24} />
                  </span>
                  <div>
                    <strong>{props.memberNameOf(member.memberId) ?? `Участник ${shortId(member.memberId)}`}</strong>
                    <small>
                      {MEMBER_ROLE_LABELS[member.role]} · с {formatMoment(member.joinedAt)}
                      {member.memberId === membership.memberId ? " · это вы" : ""}
                    </small>
                    <span className={`status-chip ${member.removedAt === null ? "normal" : "no_plan"}`}>
                      {member.removedAt === null ? "В семье" : "Удалён"}
                    </span>
                  </div>
                  <p>
                    {membership.role === "owner" &&
                    member.removedAt === null &&
                    member.memberId !== membership.memberId ? (
                      <button
                        className="text-button"
                        type="button"
                        disabled={props.busy}
                        onClick={() => props.actions.removeMember(member.memberId)}
                      >
                        Удалить
                      </button>
                    ) : null}
                  </p>
                </article>
              ))}
            </div>
            {membership.rotation ? (
              <p className="family-rotation" role="status">
                В семье начата смена ключа (эпоха {membership.rotation.keyEpoch}, с{" "}
                {formatMoment(membership.rotation.startedAt)}) и она ещё не завершена. Пока она
                идёт, старый ключ остаётся в силе.
              </p>
            ) : null}
          </section>

          {membership.role === "owner" ? (
            <section className="section-card" aria-labelledby="family-invite-title">
              <div className="section-title">
                <div>
                  <h2 id="family-invite-title">Приглашение</h2>
                  <p>Код разворачивает ключ семьи на новом устройстве. Диктуйте его голосом.</p>
                </div>
              </div>
              {props.invite ? (
                <div className="invite-code" role="status" aria-live="polite">
                  {props.invite.code === null ? (
                    <small>
                      Приглашение ещё действует, но код показан один раз и в базу устройства не
                      записан. Если он потерян — выпустите новый: прежний перестанет действовать.
                    </small>
                  ) : (
                    <>
                      <code>{formatInviteCode(props.invite.code)}</code>
                      <small>Код показан один раз и нигде не сохранён — запишите или продиктуйте его сейчас.</small>
                    </>
                  )}
                  <small>{formatInviteExpiry(props.invite.expiresAt, props.now)}</small>
                  {props.invite.supersededCount > 0 ? (
                    <small>
                      Прежний код перестал действовать: у семьи бывает только один живой код.
                    </small>
                  ) : null}
                </div>
              ) : (
                <p className="body-copy">Живого кода сейчас нет.</p>
              )}
              <div className="family-actions">
                <button className="primary-button" type="button" disabled={props.busy} onClick={props.actions.issueInvite}>
                  {props.invite ? "Выпустить новый код" : "Выпустить код"}
                </button>
              </div>
            </section>
          ) : null}

          {membership.role === "owner" ? (
            <FamilyKeySection
              keyEpoch={membership.keyEpoch}
              rotationDue={
                props.devices.some((device) => device.revokedAt !== null) ||
                props.members.some((member) => member.removedAt !== null)
              }
              serverRotation={membership.rotation}
              rotation={props.rotation}
              busy={props.busy}
              deviceLabel={shortId}
              onStart={props.actions.startRotation}
              onContinue={props.actions.continueRotationWithGaps}
              onDismiss={props.actions.dismissRotation}
            />
          ) : null}

          <section
            ref={fingerprintsRef}
            className="section-card"
            id="family-fingerprints"
            tabIndex={-1}
            aria-labelledby="family-devices-title"
          >
            <div className="section-title">
              <div>
                <h2 id="family-devices-title">Устройства и отпечатки ключей</h2>
                <p>
                  Сверку начинаете вы. Приложение никогда не просит подтвердить ключ по подсказке
                  сервера.
                </p>
              </div>
            </div>

            {props.ownFingerprint ? (
              <FingerprintBlock
                title="Это устройство"
                subtitle={session.deviceId}
                presentation={ownFingerprintPresentation(props.ownFingerprint)}
              />
            ) : null}

            <div className="plan-list">
              {props.devices
                .filter((device) => device.deviceId !== session?.deviceId)
                .map((device) => {
                  const pin = props.pinOf(device.deviceId);
                  const presentation = peerFingerprintPresentation(
                    pin,
                    props.offeredFingerprintOf(device.deviceId),
                  );
                  const owner = memberById.get(device.memberId);
                  return (
                    <article className="device-row" key={device.deviceId}>
                      <div>
                        <strong>Устройство {shortId(device.deviceId)}</strong>
                        <small>
                          {owner
                            ? `${MEMBER_ROLE_LABELS[owner.role]} ${props.memberNameOf(device.memberId) ?? shortId(device.memberId)}`
                            : "участник неизвестен"} ·
                          последняя связь {formatMoment(device.lastSeenAt)}
                        </small>
                        {props.bindVerdictOf(device.deviceId) === "failed" ? (
                          <p className="device-revoked" role="note">
                            Ключ не подтверждён: открытый ключ этого устройства не сошёлся с кодом
                            приглашения, по которому оно вступило. Обёртку нового ключа семьи оно
                            при смене ключа не получит. Сверьте отпечатки голосом или выпустите код
                            заново.
                          </p>
                        ) : null}
                        {props.bindVerdictOf(device.deviceId) === "bound" ? (
                          <small>Привязано автоматически: ключ сошёлся с кодом приглашения.</small>
                        ) : null}
                        {device.revokedAt !== null ? (
                          <p className="device-revoked" role="note">
                            Устройство отозвано {formatMoment(device.revokedAt)}. Ключ семьи, лежащий
                            на нём, отзывом не стирается — доступ к прошлым записям закроет только
                            смена ключа.
                          </p>
                        ) : null}
                      </div>
                      {presentation ? (
                        <FingerprintBlock
                          title={presentation.originLabel}
                          subtitle={null}
                          presentation={presentation}
                        />
                      ) : (
                        <p className="body-copy">Отпечаток этого устройства сервер не прислал.</p>
                      )}
                      <div className="family-actions">
                        {presentation?.createsPin ? (
                          <button
                            className="primary-button"
                            type="button"
                            disabled={props.busy}
                            onClick={() => props.actions.confirmFingerprint(device.deviceId)}
                          >
                            Отпечатки совпали — подтвердить
                          </button>
                        ) : null}
                        {device.revokedAt === null &&
                        (membership.role === "owner" || device.memberId === membership.memberId) ? (
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={props.busy}
                            onClick={(event) => {
                              dialogTriggerRef.current = event.currentTarget;
                              setConfirming({ kind: "revoke", deviceId: device.deviceId });
                            }}
                          >
                            Отозвать устройство
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
            </div>
          </section>

          <section className="section-card" aria-labelledby="family-exit-title">
            <div className="section-title">
              <div>
                <h2 id="family-exit-title">Выход</h2>
                <p>Бюджет остаётся на устройстве целиком, что бы вы здесь ни выбрали.</p>
              </div>
            </div>
            <div className="family-actions">
              <button className="secondary-button" type="button" disabled={props.busy} onClick={props.actions.signOut}>
                Выйти из учётной записи
              </button>
              {membership.role === "owner" ? null : (
                <button
                  className="danger-button"
                  type="button"
                  disabled={props.busy}
                  onClick={(event) => {
                    dialogTriggerRef.current = event.currentTarget;
                    setConfirming({ kind: "leave" });
                  }}
                >
                  Выйти из семьи
                </button>
              )}
            </div>
            {membership.role === "owner" ? (
              <p className="body-copy">
                Владелец не может выйти из семьи: семья осталась бы без того, кто меняет ключ и
                выпускает приглашения.
              </p>
            ) : null}
          </section>
        </>
      )}

      {dialog === null ? null : typeof document === "undefined" ? dialog : createPortal(dialog, document.body)}
    </section>
  );
}

/**
 * Вопрос перед необратимым действием — отдельным компонентом, а не куском экрана.
 *
 * Диалог уходит порталом в тело документа, поэтому правило `.family-screen button` до него не
 * достаёт и цели нажатия у него свои. Отдельный компонент — это то, чем тест отрисовывает диалог
 * без браузера и меряет эти цели по факту, а не по строке в файле стилей: именно так находка
 * «44 pt вместо 48» и уцелела прошлый раз.
 */
export function FamilyConfirmation({
  confirming,
  consequence,
  busy,
  backupState,
  dialogRef,
  cancelRef,
  onBackup,
  onCancel,
  onConfirm,
}: {
  readonly confirming: Confirmation;
  readonly consequence: JoinConsequence | null;
  readonly busy: boolean;
  readonly backupState: BackupState;
  readonly dialogRef: RefObject<HTMLElement | null>;
  readonly cancelRef: RefObject<HTMLButtonElement | null>;
  readonly onBackup: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="confirmation-dialog"
        role="alertdialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="family-confirm-title"
        aria-describedby="family-confirm-description"
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          if (!dialogRef.current) return;
          handleDialogKeyboard(event, dialogRef.current, !busy, onCancel);
        }}
      >
        <h3 id="family-confirm-title">
          {consequence
            ? consequence.title
            : confirming.kind === "leave"
              ? "Выйти из семьи?"
              : "Отозвать это устройство?"}
        </h3>
        <p id="family-confirm-description">
          {consequence
            ? consequence.body
            : confirming.kind === "leave"
              ? "Это устройство перестанет получать операции семьи. Бюджет останется на устройстве целиком — ничего не удаляется. Ключ семьи у вас останется до тех пор, пока владелец не сменит его."
              : "Устройство потеряет доступ к серверу семьи немедленно. Ключ семьи, уже лежащий на нём, отзывом не стирается — закрывает доступ только смена ключа владельцем."}
        </p>
        {consequence ? (
          <div className="dialog-aside">
            <p>{consequence.backupLine}</p>
            {backupState === "done" ? (
              <p className="dialog-aside-result" role="status">
                Копия скачана. Прежний бюджет восстанавливается из этого файла на экране «Данные».
              </p>
            ) : (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={backupState === "running"}
                  onClick={onBackup}
                >
                  {backupState === "running" ? "Копия готовится…" : consequence.backupActionLabel}
                </button>
                {backupState === "failed" ? (
                  <p className="dialog-aside-result" role="alert">
                    Копию сделать не удалось. Бюджет не изменён — вступление можно отложить и
                    повторить попытку на экране «Данные».
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy || backupState === "running"}
            onClick={onCancel}
          >
            Отмена
          </button>
          <button
            type="button"
            className={confirming.kind === "join" ? "primary-button" : "danger-button"}
            disabled={busy || backupState === "running"}
            onClick={onConfirm}
          >
            {consequence
              ? consequence.confirmLabel
              : confirming.kind === "leave"
                ? "Выйти из семьи"
                : "Отозвать устройство"}
          </button>
        </div>
      </section>
    </div>
  );
}


/**
 * «Ключ семьи»: то, чем отзыв устройства и удаление участника доводятся до конца — 5.5, 6.6, 6.7.
 *
 * Кнопки «сменить ключ» здесь не было вовсе, а обещание было: экран сообщал, что ключ на отозванном
 * устройстве продолжает работать, и не давал ничего, чем его отобрать. Раздел устроен как длинная
 * операция с состоянием, а не как мгновенное действие, потому что она такая и есть: человек должен
 * понимать, что происходит, что будет, если прервать, и что делать при остановке на разрыве
 * журнала.
 */
function FamilyKeySection({
  keyEpoch,
  rotationDue,
  serverRotation,
  rotation,
  busy,
  deviceLabel,
  onStart,
  onContinue,
  onDismiss,
}: {
  readonly keyEpoch: number;
  readonly rotationDue: boolean;
  readonly serverRotation: MembershipSnapshot["rotation"];
  readonly rotation: RotationState | null;
  readonly busy: boolean;
  readonly deviceLabel: (deviceId: string) => string;
  readonly onStart: () => void;
  readonly onContinue: () => void;
  readonly onDismiss: () => void;
}) {
  const running = rotation?.kind === "running";
  return (
    <section className="section-card" aria-labelledby="family-key-title">
      <div className="section-title">
        <div>
          <h2 id="family-key-title">Ключ семьи</h2>
          <p>
            Сейчас действует эпоха {keyEpoch}. Смена ключа переписывает весь журнал семьи под новый
            ключ и выдаёт его только тем устройствам, чьи отпечатки закреплены на этом.
          </p>
        </div>
      </div>

      {rotationDue && rotation?.kind !== "done" ? (
        <p className="family-rotation" role="status">
          Ключ пора сменить: в семье есть отозванное устройство или удалённый участник. Отзыв гасит
          токены, но не ключ — он лежит в памяти того устройства и открывает всё, что семья запишет
          дальше, пока эпоха не сменилась.
        </p>
      ) : null}

      {serverRotation && !running ? (
        <p className="family-rotation" role="status">
          На сервере висит незавершённая попытка смены ключа (эпоха {serverRotation.keyEpoch}). Пока
          она висит, семья не может отправлять записи. Новая попытка отменит её и начнётся заново.
        </p>
      ) : null}

      {running ? (
        <div className="rotation-progress" role="status" aria-live="polite">
          <p>{rotationProgressLine(rotation.progress)}</p>
          <p className="body-copy">
            Прерывать безопасно: пока сервер не подтвердил переключение, на этом устройстве
            остаются оба ключа, и семья продолжает читать журнал старым. Прерванная попытка
            отменяется, и смену ключа можно начать заново — она возьмёт следующий номер эпохи.
          </p>
          <p className="body-copy">
            Пока идёт смена, вся семья не может отправлять новые записи. Введённое на других
            устройствах не потеряется — оно уедет в новую эпоху, как только она заработает.
          </p>
        </div>
      ) : null}

      {rotation?.kind === "halted" ? (
        <section className="key-alarm" role="alert" aria-labelledby="rotation-halt-title">
          <span className="key-alarm-mark" aria-hidden="true">
            !
          </span>
          <div>
            <h3 id="rotation-halt-title">Журнал неполон — смена ключа остановлена</h3>
            <p>
              Сервер должен был отдать записи с номерами 1 … {rotation.freezeSeq}, но {" "}
              {rotationGapSummary(rotation.gap)}.
            </p>
            <p>
              Это проверяется до переноса и только здесь: старая эпоха при смене ключа удаляется
              целиком, и пропуск, не замеченный сейчас, исчезнет вместе с ней — усечённый журнал
              станет законной новой историей, и увидеть его будет уже нечем.
            </p>
            <p>
              Попытка на сервере отменена, запись в семье снова открыта. Можно подождать и
              повторить: недостающее могло просто не дойти. Можно продолжить без этих записей — они
              будут потеряны навсегда, а их номера уедут в первый чекпойнт новой эпохи, чтобы семья
              видела, что именно потеряно.
            </p>
            <div className="family-actions">
              <button className="danger-button" type="button" disabled={busy} onClick={onContinue}>
                Продолжить без этих записей
              </button>
              <button className="secondary-button" type="button" disabled={busy} onClick={onDismiss}>
                Отложить
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {rotation?.kind === "done" ? (
        <div className="rotation-result" role="status">
          <p>
            Ключ сменён: эпоха {rotation.previousKeyEpoch} → {rotation.keyEpoch}, перенесено записей{" "}
            {rotation.moved}. Ключ выдан устройствам: {" "}
            {rotation.wrapped.length === 0
              ? "ни одному — других привязанных устройств в семье нет"
              : rotation.wrapped.map(deviceLabel).join(", ")}
            .
          </p>
          {rotation.skipped.length > 0 ? (
            <>
              <p>Без нового ключа остались:</p>
              <ul className="withheld-list">
                {rotation.skipped.map((device) => (
                  <li key={device.deviceId}>
                    <strong>Устройство {deviceLabel(device.deviceId)}</strong>
                    <small>{ROTATION_SKIP_REASONS[device.reason]}</small>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {rotation.inheritedGaps.length > 0 ? (
            <p>
              В новую эпоху не перенесены записи с номерами{" "}
              {rotation.inheritedGaps.join(", ")}: они уехали в первый чекпойнт новой эпохи как
              признанная потеря.
            </p>
          ) : null}
          <button className="secondary-button" type="button" onClick={onDismiss}>
            Понятно
          </button>
        </div>
      ) : null}

      {rotation?.kind === "failed" ? (
        <p className="family-error" role="alert">
          {rotation.message} Ключ на этом устройстве не менялся, попытка на сервере отменена.
        </p>
      ) : null}

      <p className="body-copy">
        Смена ключа — длинная операция: журнал переписывается целиком, и на большом журнале это
        сотни запросов. Пока она идёт, вся семья не может отправлять записи.
      </p>
      <div className="family-actions">
        <button
          className={rotationDue ? "primary-button" : "secondary-button"}
          type="button"
          disabled={busy || running}
          onClick={onStart}
        >
          {running ? "Смена ключа идёт…" : "Сменить ключ семьи"}
        </button>
      </div>
    </section>
  );
}

function FingerprintBlock({
  title,
  subtitle,
  presentation,
}: {
  title: string;
  subtitle: string | null;
  presentation: ReturnType<typeof ownFingerprintPresentation>;
}) {
  return (
    <div className={`fingerprint-block ${presentation.origin}`}>
      <span className="card-kicker">{title}</span>
      {subtitle ? <small>{subtitle}</small> : null}
      <code className="fingerprint-value">{presentation.text}</code>
      <p>{presentation.note}</p>
    </div>
  );
}
