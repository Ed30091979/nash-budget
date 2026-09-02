/**
 * Смена ключа семьи на устройстве владельца — `SYNC_ARCHITECTURE.md` 5.5, все семь шагов.
 *
 * Серверная половина ротации была написана и покрыта тестами, а устройство её не вызывало ни
 * откуда. Практическое следствие называлось на экране прямым текстом и было ложью: владелец терял
 * телефон, на втором устройстве нажимал «отозвать», сервер гасил токены и отвечал
 * `rotationRequired: true`, приложение показывало «устройство отозвано» — и номер эпохи оставался
 * прежним навсегда. Тот, кто снял копию базы с потерянного телефона, читал всё, что семья запишет
 * дальше: `FK` лежит в IndexedDB и от отзыва токена не портится (5.5, третья строка таблицы
 * триггеров; 6.7).
 *
 * Три величины здесь не принимаются на слово от сервера, и это общий класс дефектов, а не
 * частность: **измерением предела не может быть величина, которую пишет тот, кого предел
 * ограничивает.**
 *
 *  - **номер эпохи.** Сервер его выделяет — иначе двум попыткам достался бы один номер (5.4), — но
 *    устройство принимает только строго больший своего и только при `previousKeyEpoch`, равном
 *    тому, что оно держит;
 *  - **граница переноса `freezeSeq`.** Принимается только не меньшей двух собственных величин:
 *    курсора и наибольшего `seq`, когда-либо виденного в этой эпохе. Сверх того устройство само
 *    спрашивает журнал **за** границей: усечение с конца непрерывно и по разрывам не видно, а
 *    конверт, пришедший после `freezeSeq`, — прямое доказательство занижения;
 *  - **завершённость.** Ответ `complete` сам по себе ничего не значит: после него читается
 *    `membership()`, и эпоха считается переключённой, только если сервер во втором, независимом
 *    ответе назвал новый номер и не показывает идущей ротации.
 *
 * И отдельно — непрерывность `1 … freezeSeq` проверяется **до** переноса. Норматив предупреждает
 * прямо: пропуск, не замеченный здесь, исчезает навсегда вместе со старой эпохой, и усечение
 * журнала становится законной новой историей. Разрыв останавливает ротацию; продолжение — только
 * по осознанному решению человека, и тогда номера уезжают в `inheritedGaps` первого чекпойнта
 * новой эпохи (3.6).
 */
import type {
  FetchQuery,
  FetchResult,
  OutgoingEnvelope,
  SubmitResult,
} from "@family-budget/sync-client";
import { fromBase64, toBase64 } from "@family-budget/sync-client";
import {
  computeEpochConfirm,
  familyKeyFingerprint,
  generateFamilyKey,
  openEnvelope,
  reencryptJournal,
  toHex,
  wrapFamilyKey,
  type SealedEnvelope,
} from "@family-budget/sync-crypto";

import { FamilyRefusal, type DeclaredRotation, type DeviceRecord, type FamilyApi } from "./api";

/** Сколько конвертов уходит одним пакетом. Константа этой сборки, не число из ответа. */
export const ROTATION_SUBMIT_BATCH = 200;
/** Сколько конвертов запрашивается одной страницей. Тоже своя. */
export const ROTATION_FETCH_LIMIT = 200;
/** Сколько обёрток уходит одним запросом: серверная схема принимает не более `64`. */
export const ROTATION_WRAP_BATCH = 64;
/**
 * Потолок страниц на один перенос. Ограничивает **один вызов**, а не журнал: квота семьи —
 * `100 000` конвертов (5.5), и этот потолок стоит выше неё, чтобы честная семья в него не упёрлась.
 */
const MAX_FETCH_PAGES = 1024;

export type RotationPhase =
  | "preparing"
  | "declaring"
  | "reading"
  | "transferring"
  | "wrapping"
  | "uploading"
  | "completing"
  | "done";

/** Что именно не сошлось в журнале старой эпохи — в номерах, а не в словах. */
export interface RotationGap {
  /** Номера, которых сервер не отдал вовсе, внутри `1 … freezeSeq`. */
  readonly missing: readonly number[];
  /** Номера конвертов, которые пришли, но не расшифровались ключом этой эпохи (3.4). */
  readonly undecryptable: readonly number[];
}

export interface RotationProgress {
  readonly phase: RotationPhase;
  readonly keyEpoch: number | null;
  readonly previousKeyEpoch: number;
  readonly freezeSeq: number | null;
  /** Сколько конвертов уже перешифровано и отправлено в staging. */
  readonly moved: number;
  /** Сколько их всего в переносимом наборе, или `null`, пока набор не прочитан. */
  readonly total: number | null;
}

/** Устройство, оставшееся без обёртки, и почему (5.4.1: «пользователь видит, какое и почему»). */
export interface SkippedDevice {
  readonly deviceId: string;
  readonly reason: "revoked" | "not_pinned" | "bind_failed" | "no_public_key" | "wrap_failed";
}

export interface RotationResult {
  readonly keyEpoch: number;
  readonly previousKeyEpoch: number;
  readonly familyKey: CryptoKey;
  readonly keyDigest: string;
  /** Конверты, перенесённые в новую эпоху. */
  readonly moved: number;
  readonly wrapped: readonly string[];
  readonly skipped: readonly SkippedDevice[];
  /** Номера, которых журнал недосчитался и которые уедут в первый чекпойнт новой эпохи. */
  readonly inheritedGaps: readonly number[];
  /** `opId` собственной очереди, уехавшей в новую эпоху: их строки можно снимать с очереди. */
  readonly movedQueueOpIds: readonly string[];
}

/**
 * Остановка на неполном журнале — не отказ и не сбой, а вопрос к человеку.
 *
 * 5.5: «Разрыв останавливает ротацию с сообщением „журнал неполон“; продолжить можно только
 * осознанным решением пользователя». Ротация к этому моменту **объявлена** и живёт на сервере:
 * поэтому здесь едет и `rotationId`, и номер эпохи — продолжение идёт той же попыткой, а отказ
 * человека отменяет именно её, а не какую-нибудь следующую.
 */
export class RotationHalted extends Error {
  readonly gap: RotationGap;
  readonly rotationId: string;
  readonly keyEpoch: number;
  readonly freezeSeq: number;

  constructor(input: {
    readonly gap: RotationGap;
    readonly rotationId: string;
    readonly keyEpoch: number;
    readonly freezeSeq: number;
  }) {
    super("journal incomplete");
    this.name = "RotationHalted";
    this.gap = input.gap;
    this.rotationId = input.rotationId;
    this.keyEpoch = input.keyEpoch;
    this.freezeSeq = input.freezeSeq;
  }
}

export type RotationApi = Pick<
  FamilyApi,
  "declareRotation" | "uploadRotationKeys" | "completeRotation" | "membership"
>;

export interface RotationTransport {
  fetch(familyId: string, query: FetchQuery): Promise<FetchResult>;
  submit(familyId: string, envelopes: readonly OutgoingEnvelope[]): Promise<SubmitResult>;
}

export interface RotateFamilyKeyParams {
  readonly api: RotationApi;
  readonly transport: RotationTransport;
  readonly familyId: string;
  /** Устройство владельца: оно ведёт ротацию и подписывает обёртки как отправитель. */
  readonly deviceId: string;
  readonly deviceSpki: Uint8Array;
  readonly devicePrivateKey: CryptoKey;
  readonly familyKey: CryptoKey;
  readonly keyEpoch: number;
  readonly devices: readonly DeviceRecord[];
  /** Локальный пин получателя. Никогда не значение из ответа сервера (5.4). */
  readonly pin: (deviceId: string) => Uint8Array | undefined;
  /** Вердикт автоматической привязки (6.4): расхождение — обёртки не будет. */
  readonly bindVerdict: (deviceId: string) => "bound" | "failed" | null;
  /** Курсор этого устройства: `freezeSeq` ниже него — занижение, а не «сервер так посчитал». */
  readonly cursorSeq: number;
  /** Наибольший `seq`, когда-либо виденный этим устройством в этой эпохе. */
  readonly highWaterSeq: number;
  /** Неотправленная очередь этого устройства под старым ключом — 5.5 шаг 2. */
  readonly queued: readonly OutgoingEnvelope[];
  /**
   * Идентификатор попытки. Порождает **устройство владельца**, а не сервер (5.4).
   *
   * Параметром, а не вызовом `crypto.randomUUID()` внутри, ровно по одной причине: продолжение
   * после остановки на разрыве обязано идти **той же** попыткой, иначе на сервере остались бы две.
   */
  readonly rotationId: string;
  /**
   * Разрыв в журнале уже показан человеку, и человек решил продолжать.
   *
   * `false` — остановка с {@link RotationHalted}. `true` — перенос идёт без недостающих номеров, и
   * они уезжают в `inheritedGaps` первого чекпойнта новой эпохи.
   */
  readonly acceptGaps?: boolean;
  readonly report?: (progress: RotationProgress) => void;
  /** Порождение `FK'`. Подменяется в тесте, чтобы ключ был известной величиной. */
  readonly newFamilyKey?: () => Promise<CryptoKey>;
}

function toSealed(envelope: {
  readonly envelopeVersion: number;
  readonly kind: string;
  readonly familyId: string;
  readonly opId: string;
  readonly deviceId: string;
  readonly keyEpoch: number;
  readonly iv: string;
  readonly ciphertext: string;
}): SealedEnvelope | null {
  const iv = fromBase64(envelope.iv);
  const ciphertext = fromBase64(envelope.ciphertext);
  if (iv === null || ciphertext === null) return null;
  return {
    envelopeVersion: envelope.envelopeVersion,
    kind: envelope.kind,
    familyId: envelope.familyId,
    opId: envelope.opId,
    deviceId: envelope.deviceId,
    keyEpoch: envelope.keyEpoch,
    iv,
    ciphertext,
  };
}

function toWire(envelope: SealedEnvelope): OutgoingEnvelope {
  return {
    envelopeVersion: envelope.envelopeVersion,
    kind: envelope.kind,
    familyId: envelope.familyId,
    opId: envelope.opId,
    deviceId: envelope.deviceId,
    keyEpoch: envelope.keyEpoch,
    iv: toBase64(envelope.iv),
    ciphertext: toBase64(envelope.ciphertext),
  };
}

/**
 * Журнал старой эпохи, страницами, и **своя** проверка того, где он кончается.
 *
 * Конец диапазона задан `freezeSeq`, а не ответом сервера: `hasMore` здесь не читается вовсе по
 * той же причине, по какой его не читает движок (3.6). Один лишний запрос делается уже **за**
 * границей — он и ловит усечение с конца, которое непрерывно и разрывом не выглядит.
 */
async function readEpochJournal(
  transport: RotationTransport,
  familyId: string,
  keyEpoch: number,
  freezeSeq: number,
): Promise<{ readonly bySeq: Map<number, SealedEnvelope>; readonly beyond: number[] }> {
  const bySeq = new Map<number, SealedEnvelope>();
  let after = 0;
  for (let page = 0; page < MAX_FETCH_PAGES && after < freezeSeq; page += 1) {
    const answer = await transport.fetch(familyId, {
      keyEpoch,
      after,
      limit: ROTATION_FETCH_LIMIT,
    });
    if (answer.envelopes.length === 0) break;
    let highest = after;
    for (const delivered of answer.envelopes) {
      if (delivered.seq > freezeSeq) continue;
      const sealed = toSealed(delivered);
      // Конверт, чьи `iv` или шифротекст сервер написал не по договору, — это отсутствующий
      // конверт: перенести его нельзя, и молча пропустить тоже нельзя. Он остаётся дырой в
      // диапазоне и попадёт в разрыв ниже.
      if (sealed !== null) bySeq.set(delivered.seq, sealed);
      if (delivered.seq > highest) highest = delivered.seq;
    }
    if (highest <= after) break;
    after = highest;
  }
  // Тот самый лишний запрос: сервер, занизивший границу, обязан либо отдать то, что за ней, либо
  // солгать второй раз — и второе видно уже по расхождению с курсором и с высокой водой.
  const tail = await transport.fetch(familyId, { keyEpoch, after: freezeSeq, limit: 1 });
  return { bySeq, beyond: tail.envelopes.map((envelope) => envelope.seq) };
}

/** Кого именно эта ротация оставляет без ключа, и почему (5.4.1). */
export function classifyRecipients(params: {
  readonly devices: readonly DeviceRecord[];
  readonly ownDeviceId: string;
  readonly pin: (deviceId: string) => Uint8Array | undefined;
  readonly bindVerdict: (deviceId: string) => "bound" | "failed" | null;
}): {
  readonly recipients: readonly DeviceRecord[];
  readonly skipped: readonly SkippedDevice[];
} {
  const recipients: DeviceRecord[] = [];
  const skipped: SkippedDevice[] = [];
  for (const device of params.devices) {
    if (device.deviceId === params.ownDeviceId) continue;
    if (device.revokedAt !== null) {
      // Ровно то, ради чего ротацию и нажали: отозванное устройство обёртки не получает.
      skipped.push({ deviceId: device.deviceId, reason: "revoked" });
      continue;
    }
    if (params.bindVerdict(device.deviceId) === "failed") {
      // 6.4: «обёртку `FK'` это устройство при ротации не получит».
      skipped.push({ deviceId: device.deviceId, reason: "bind_failed" });
      continue;
    }
    if (params.pin(device.deviceId) === undefined) {
      // 5.4.1: «Ротация с непривязанным устройством в семье не блокируется — она проходит без
      // него, и пользователь видит, какое устройство осталось без ключа и почему.»
      skipped.push({ deviceId: device.deviceId, reason: "not_pinned" });
      continue;
    }
    if (fromBase64(device.publicKey) === null) {
      skipped.push({ deviceId: device.deviceId, reason: "no_public_key" });
      continue;
    }
    recipients.push(device);
  }
  return { recipients, skipped };
}

/**
 * Проводит ротацию по 5.5 и возвращает то, что устройству владельца остаётся записать на диск.
 *
 * Ничего локального эта функция не пишет: старый ключ семьи забывается только после того, как
 * сервер подтвердил шаг 7, и решает это вызывающий, получив результат. До тех пор у владельца
 * оба ключа — иначе прерванная ротация оставила бы семью без доступа к собственным данным из-за
 * сетевого таймаута (5.5, «Когда владелец вправе забыть старый ключ»).
 */
export async function rotateFamilyKey(params: RotateFamilyKeyParams): Promise<RotationResult> {
  const report = params.report ?? (() => undefined);
  const progress = (
    phase: RotationPhase,
    extra: Partial<RotationProgress> = {},
  ): RotationProgress => ({
    phase,
    keyEpoch: null,
    previousKeyEpoch: params.keyEpoch,
    freezeSeq: null,
    moved: 0,
    total: null,
    ...extra,
  });

  report(progress("declaring"));
  const declared: DeclaredRotation = await params.api.declareRotation(
    params.familyId,
    params.rotationId,
  );

  // Три сверки ответа с тем, что известно этому устройству. Ни одна из них не «на всякий случай»:
  // номер эпохи и есть то, чем два ключа различаются, и принять чужое значение — значит принять
  // чужое различение.
  if (declared.rotationId !== params.rotationId) {
    throw new FamilyRefusal(
      "Сервер ответил о другой смене ключа. Ротация не начата — повторите попытку.",
    );
  }
  if (declared.previousKeyEpoch !== params.keyEpoch) {
    throw new FamilyRefusal(
      "Сервер считает действующей другую эпоху ключа, чем это устройство. Ротация остановлена: обновите данные семьи и повторите.",
    );
  }
  if (declared.keyEpoch <= params.keyEpoch) {
    throw new FamilyRefusal(
      "Сервер выдал номер эпохи не выше действующей. Ротация остановлена — на таком номере два разных ключа стали бы неразличимы.",
    );
  }
  if (declared.rotatingDeviceId !== params.deviceId) {
    throw new FamilyRefusal(
      "Сервер назначил ведущим ротацию другое устройство. Ротация остановлена.",
    );
  }
  // 5.5 шаг 2: «владелец принимает `freezeSeq` только не меньшим двух своих величин».
  const ownFloor = Math.max(params.cursorSeq, params.highWaterSeq);
  if (declared.freezeSeq < ownFloor) {
    throw new FamilyRefusal(
      `Сервер назвал границу переноса ${declared.freezeSeq}, а это устройство видело записи до ${ownFloor}. Это занижение, а не расчёт: хвост журнала был бы вырезан незаметно. Ротация остановлена.`,
    );
  }

  const keyEpoch = declared.keyEpoch;
  const freezeSeq = declared.freezeSeq;
  report(progress("reading", { keyEpoch, freezeSeq }));

  const journal = await readEpochJournal(
    params.transport,
    params.familyId,
    params.keyEpoch,
    freezeSeq,
  );
  if (journal.beyond.length > 0) {
    throw new FamilyRefusal(
      `Сервер назвал границей переноса ${freezeSeq}, но отдаёт записи и после неё (${journal.beyond.join(", ")}). Хвост журнала был бы вырезан вместе со старой эпохой. Ротация остановлена.`,
    );
  }

  // Непрерывность — **до** переноса, и вместе с ней проверка на расшифровываемость: 5.5 обходится
  // с присутствующим, но нечитаемым конвертом ровно так же, как с отсутствующим, иначе одна
  // подделанная строка в базе отключала бы процедуру, которой отвечают на кражу устройства.
  const missing: number[] = [];
  const undecryptable: number[] = [];
  const carried: SealedEnvelope[] = [];
  for (let seq = 1; seq <= freezeSeq; seq += 1) {
    const envelope = journal.bySeq.get(seq);
    if (envelope === undefined) {
      missing.push(seq);
      continue;
    }
    try {
      await openEnvelope(params.familyKey, envelope);
    } catch {
      undecryptable.push(seq);
      continue;
    }
    carried.push(envelope);
  }
  if ((missing.length > 0 || undecryptable.length > 0) && params.acceptGaps !== true) {
    throw new RotationHalted({
      gap: { missing, undecryptable },
      rotationId: params.rotationId,
      keyEpoch,
      freezeSeq,
    });
  }
  const inheritedGaps = [...missing, ...undecryptable].sort((left, right) => left - right);

  // 5.5 шаг 2, вторая половина: собственная очередь входит в переносимый набор здесь, пока она ещё
  // читается старым ключом. Механизм шага 8 к ней неприменим — владелец не получает
  // `409 epoch_mismatch`, он сам переключает эпоху.
  const queuedSealed: SealedEnvelope[] = [];
  for (const queued of params.queued) {
    if (queued.keyEpoch !== params.keyEpoch) continue;
    const sealed = toSealed(queued);
    if (sealed !== null) queuedSealed.push(sealed);
  }

  report(progress("transferring", { keyEpoch, freezeSeq, total: carried.length + queuedSealed.length }));

  // 5.5 шаг 3: новый ключ порождается только после того, как переносимый набор признан полным.
  const nextFamilyKey = await (params.newFamilyKey ?? generateFamilyKey)();
  const epochConfirm = await computeEpochConfirm({
    previousFamilyKey: params.familyKey,
    familyId: params.familyId,
    keyEpoch,
    rotationId: params.rotationId,
    nextFamilyKey,
  });

  // 5.5 шаг 4. `reencryptJournal` сохраняет `opId`, `lamport`, `memberId` и `deviceId` и меняет
  // только `iv`, `keyEpoch` и шифротекст; чекпойнты он не переносит — их цепочки поэпоховые (3.6).
  const moved = await reencryptJournal({
    envelopes: [...carried, ...queuedSealed],
    previousFamilyKey: params.familyKey,
    previousKeyEpoch: params.keyEpoch,
    nextFamilyKey,
    nextKeyEpoch: keyEpoch,
  });
  const movedQueueOpIds = new Set(queuedSealed.map((envelope) => envelope.opId));

  report(progress("wrapping", { keyEpoch, freezeSeq, total: moved.length }));

  // 5.5 шаг 5: обёртка на каждое остающееся **привязанное** устройство. Непривязанные пропускаются
  // и перечисляются вызывающему поимённо.
  const { recipients, skipped } = classifyRecipients({
    devices: params.devices,
    ownDeviceId: params.deviceId,
    pin: params.pin,
    bindVerdict: params.bindVerdict,
  });
  const wraps: {
    deviceId: string;
    senderDeviceId: string;
    salt: string;
    iv: string;
    ciphertext: string;
  }[] = [];
  const failedWraps: SkippedDevice[] = [];
  for (const device of recipients) {
    const recipientSpki = fromBase64(device.publicKey);
    const pinned = params.pin(device.deviceId);
    if (recipientSpki === null || pinned === undefined) continue;
    try {
      // `wrapFamilyKey` сверяет `SHA-256` присланного SPKI с пином **до** вывода общего секрета и
      // отказывает при расхождении: обёртка на ключе, который выбрал сервер, — это выдача ключа
      // семьи серверу.
      const wrap = await wrapFamilyKey({
        familyKey: nextFamilyKey,
        senderPrivateKey: params.devicePrivateKey,
        senderSpki: params.deviceSpki,
        senderDeviceId: params.deviceId,
        recipientSpki,
        recipientDeviceId: device.deviceId,
        pinnedRecipientFingerprint: pinned,
        familyId: params.familyId,
        keyEpoch,
        rotationId: params.rotationId,
      });
      wraps.push({
        deviceId: wrap.recipientDeviceId,
        senderDeviceId: wrap.senderDeviceId,
        salt: toBase64(wrap.salt),
        iv: toBase64(wrap.iv),
        ciphertext: toBase64(wrap.ciphertext),
      });
    } catch {
      // Отпечаток присланного ключа не сошёлся с закреплённым. Это не повод остановить ротацию —
      // она и нужна затем, чтобы отобрать ключ, — но устройство остаётся без ключа, и это видно.
      failedWraps.push({ deviceId: device.deviceId, reason: "wrap_failed" });
    }
  }

  report(progress("uploading", { keyEpoch, freezeSeq, total: moved.length }));

  // 5.5 шаг 6. Конверты новой эпохи принимаются от ведущего ротацию устройства — это единственное
  // исключение из заморозки, иначе загрузить новую эпоху было бы нечем.
  let sent = 0;
  for (let index = 0; index < moved.length; index += ROTATION_SUBMIT_BATCH) {
    const batch = moved.slice(index, index + ROTATION_SUBMIT_BATCH).map(toWire);
    await params.transport.submit(params.familyId, batch);
    sent += batch.length;
    report(progress("uploading", { keyEpoch, freezeSeq, moved: sent, total: moved.length }));
  }

  // Подтверждение преемственности уходит вместе с обёртками. Без него сервер откажет в шаге 7:
  // устройство, у которого нет цепочки, не смогло бы признать новую эпоху ни одним законным путём.
  await params.api.uploadRotationKeys(params.familyId, {
    rotationId: params.rotationId,
    epochConfirm: toBase64(epochConfirm),
    wraps: wraps.slice(0, ROTATION_WRAP_BATCH),
  });
  for (let index = ROTATION_WRAP_BATCH; index < wraps.length; index += ROTATION_WRAP_BATCH) {
    await params.api.uploadRotationKeys(params.familyId, {
      rotationId: params.rotationId,
      wraps: wraps.slice(index, index + ROTATION_WRAP_BATCH),
    });
  }

  report(progress("completing", { keyEpoch, freezeSeq, moved: sent, total: moved.length }));

  // 5.5 шаг 7.
  const completed = await params.api.completeRotation(params.familyId, params.rotationId);
  if (completed.keyEpoch !== keyEpoch || completed.previousKeyEpoch !== params.keyEpoch) {
    throw new FamilyRefusal(
      "Сервер сообщил о завершении другой смены ключа. Старый ключ на устройстве сохранён.",
    );
  }
  // Второе, независимое чтение: признак завершённости не должен назначать тот, кого он
  // ограничивает. 7.1 называет удержание семьи в старой эпохе тем, что сервер может делать сколь
  // угодно долго, и единственная защита — что это видно и не проходит за завершение.
  const membership = await params.api.membership();
  if (membership === null || membership.keyEpoch !== keyEpoch || membership.rotation !== null) {
    throw new FamilyRefusal(
      "Сервер не показывает новую эпоху действующей. Смена ключа не завершена, старый ключ на устройстве сохранён.",
    );
  }

  report(progress("done", { keyEpoch, freezeSeq, moved: sent, total: moved.length }));

  return {
    keyEpoch,
    previousKeyEpoch: params.keyEpoch,
    familyKey: nextFamilyKey,
    keyDigest: toHex(await familyKeyFingerprint(nextFamilyKey)),
    moved: moved.length,
    wrapped: wraps.map((wrap) => wrap.deviceId),
    skipped: [...skipped, ...failedWraps],
    inheritedGaps,
    movedQueueOpIds: [...movedQueueOpIds],
  };
}
