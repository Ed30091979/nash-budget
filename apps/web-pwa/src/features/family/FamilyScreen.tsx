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

import { activateDialogEnvironment, handleDialogKeyboard } from "../data-management/dialog-accessibility";
import type { DeviceRecord, MemberRecord, MembershipSnapshot } from "./api";
import { formatLastBackupDate } from "../data-management/model";
import {
  MEMBER_ROLE_LABELS,
  formatInviteCode,
  formatInviteExpiry,
  isValidEmail,
  isValidLoginCode,
  joinConsequence,
  normalizeLoginCode,
  ownFingerprintPresentation,
  peerFingerprintPresentation,
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

/** An invite this device issued and is still reading out to somebody. */
export interface ActiveInvite {
  readonly code: string;
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
        <button className="secondary-button" type="button" onClick={props.onBack}>
          ← К разделу «Ещё»
        </button>
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
                  <span className="plan-icon" aria-hidden="true">
                    ◍
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
                  <code>{formatInviteCode(props.invite.code)}</code>
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
