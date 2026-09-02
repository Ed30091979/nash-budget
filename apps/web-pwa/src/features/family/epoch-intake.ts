/**
 * Приём новой эпохи на устройстве, которое ротацию не вело — 5.4.1 и 5.5 шаг 8.
 *
 * Вторая половина находки о ротации: сменить ключ мало, его надо ещё и принять, а принять его
 * можно ровно двумя путями и третьего нет. Здесь реализован первый — цепочка подтверждений от
 * эпохи, ключ которой у устройства уже есть, — и реализован он вызовом готового
 * `resolveEpochChain`, а не второй копией тех же правил.
 *
 * Что этот файл **не** делает и делать не вправе: он не принимает эпоху по слову сервера. Ни одно
 * решение здесь не читается из ответа: пины берутся из локальной таблицы, ключ прошлой эпохи — с
 * диска, а `keys()` не получает ни одного параметра, потому что единственный напрашивающийся —
 * «какую эпоху я принял» — это локальное состояние, которого серверу знать нельзя (5.4.1).
 */
import { resolveEpochChain, fromBase64, type SyncTransport } from "@family-budget/sync-client";
import type { EpochChainRefusal } from "@family-budget/sync-client";
import { familyKeyFingerprint, toHex } from "@family-budget/sync-crypto";

import type { DeviceRecord } from "./api";

export interface EpochIntakeParams {
  readonly transport: Pick<SyncTransport, "keys">;
  readonly familyId: string;
  readonly deviceId: string;
  readonly deviceSpki: Uint8Array;
  readonly devicePrivateKey: CryptoKey;
  /** Ключ эпохи, которую устройство держит сейчас. */
  readonly familyKey: CryptoKey;
  readonly keyEpoch: number;
  /**
   * Прошла ли эта эпоха доказательство живости (5.4.1).
   *
   * Передаётся насквозь, а не выдумывается: доказательство стоит круга, в котором сервер
   * пронумеровал собственный конверт устройства, и walk, всегда отвечающий `live: false`,
   * заставил бы вызывающего затереть уже заработанное.
   */
  readonly live: boolean;
  readonly pins: ReadonlyMap<string, Uint8Array>;
  /** Список устройств: из него берётся SPKI отправителя — недоверенный, пока не сойдётся с пином. */
  readonly devices: readonly DeviceRecord[];
}

export type EpochIntakeOutcome =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "advanced";
      readonly keyEpoch: number;
      readonly key: CryptoKey;
      readonly keyDigest: string;
      /** Сколько звеньев цепочки пройдено: `> 1` — устройство отставало больше чем на эпоху. */
      readonly advanced: number;
    }
  | { readonly kind: "refused"; readonly reason: EpochChainRefusal; readonly keyEpoch: number };

/** Что человек читает при отказе цепочки. Тревога, а не «повторите попытку». */
export const EPOCH_REFUSAL_TEXT: Record<EpochChainRefusal, string> = {
  key_substituted:
    "Сервер предложил другой ключ той же эпохи. Это подмена, а не смена ключа: приложение осталось на прежнем ключе и продолжает работать локально.",
  missing_confirmation:
    "Сервер объявил новую эпоху без подтверждения преемственности. Смена ключа не подтверждена, приложение осталось на прежнем ключе.",
  confirmation_failed:
    "Подтверждение новой эпохи не сошлось на ключе прошлой. Смена ключа не подтверждена, приложение осталось на прежнем ключе.",
  sender_not_pinned:
    "Ключ предложен устройством, отпечаток которого здесь не закреплён. Сверьте отпечатки голосом — до этого новый ключ не принимается.",
  sender_key_changed:
    "Открытый ключ отправителя не совпал с закреплённым отпечатком. Новый ключ не принят: сверьте отпечатки голосом.",
  unwrap_failed:
    "Обёртка нового ключа не открылась. Новый ключ не принят, приложение осталось на прежнем ключе.",
};

/**
 * Спрашивает у сервера все обёртки, адресованные этому устройству, и проходит их цепочкой.
 *
 * Возвращает то, что вызывающему остаётся записать, и ничего не пишет само: старый ключ стирается
 * только после доказательства живости новой эпохи (5.4.1), а доказательство появляется кругом
 * позже — сервер должен принять в новой эпохе собственный конверт этого устройства и вернуть
 * `seq`. До тех пор устройство держит оба ключа и, если новая эпоха так и не ожила, возвращается к
 * прежней.
 */
export async function takeIncomingEpoch(
  params: EpochIntakeParams,
): Promise<EpochIntakeOutcome> {
  const answer = await params.transport.keys(params.familyId);
  const spkiOf = new Map<string, Uint8Array>();
  for (const device of params.devices) {
    const spki = fromBase64(device.publicKey);
    if (spki !== null) spkiOf.set(device.deviceId, spki);
  }

  const walked = await resolveEpochChain({
    familyId: params.familyId,
    deviceId: params.deviceId,
    deviceSpki: params.deviceSpki,
    devicePrivateKey: params.devicePrivateKey,
    wraps: answer.wraps,
    accepted: { keyEpoch: params.keyEpoch, key: params.familyKey, live: params.live },
    // Пин — только из локальной таблицы. «Нет записи» и «требуется пере-закрепление» отказывают
    // одинаково: доверие к звену либо есть, либо его нет.
    pin: (senderDeviceId) => {
      const fingerprint = params.pins.get(senderDeviceId);
      return fingerprint === undefined
        ? { state: "absent" }
        : { state: "pinned", fingerprint };
    },
    senderSpki: (senderDeviceId) => spkiOf.get(senderDeviceId),
  });

  if (walked.advanced > 0 && walked.epoch !== null && walked.key !== null) {
    // Цепочка прошла хотя бы одно звено. Отказ **после** пройденных звеньев не отменяет их: они
    // подтверждены ключом предыдущей эпохи, и устройство законно стоит там, докуда дошло.
    return {
      kind: "advanced",
      keyEpoch: walked.epoch.keyEpoch,
      key: walked.key,
      keyDigest: toHex(await familyKeyFingerprint(walked.key)),
      advanced: walked.advanced,
    };
  }
  if (walked.refusal !== null) {
    return {
      kind: "refused",
      reason: walked.refusal.reason,
      keyEpoch: walked.refusal.keyEpoch,
    };
  }
  return { kind: "unchanged" };
}
