/**
 * Фаза S7: офлайн-сценарии и устойчивость — на стыке двух настоящих устройств.
 *
 * Модульные тесты каждой половины протокола зелёные по определению: `intake.test.ts` проверяет
 * приём по 3.4, `checkpoint.test.ts` — сверку по 3.6, тесты сервера — его маршруты. Ни один из них
 * не видит того, что видит человек: два устройства, писавшие врозь, после схождения показывают
 * одну и ту же сумму — или разные.
 *
 * Поэтому здесь нет ни одного теста, который смотрит на одну сторону. В каждом участвуют два
 * движка над двумя базами, один журнал между ними и один и тот же расчёт домена поверх обоих:
 * `calculateAnnualPlan` и `calculateBudget` считают одни и те же копейки на каждой стороне, и
 * сходство доказывается равенством этих чисел, а не равенством внутренних записей.
 *
 * Канонические величины бюджета G-002, которые здесь сверяются буквально:
 * июльский резерв `1 980 900` копеек (`19 809 ₽`), свободно `4 419 100` (`44 191 ₽`),
 * лимит «Продуктов» `3 000 000` (`30 000 ₽`), потрачено на «Продукты» в июле `2 200 000`
 * (`22 000 ₽`).
 */
import { calculateAnnualPlan, calculateBudget } from "@family-budget/domain";
import { G002 } from "@family-budget/test-fixtures";
import { IndexedDbBudgetRepository } from "@family-budget/storage";
import {
  computeEpochConfirm,
  deviceKeyFingerprint,
  ENVELOPE_VERSION,
  exportDevicePublicKey,
  familyKeyFingerprint,
  generateDeviceKeyPair,
  generateFamilyKey,
  openEnvelope,
  sealEnvelope,
  toHex,
  wrapFamilyKey,
} from "@family-budget/sync-crypto";
import type { OperationDraft, SyncedBudgetState } from "@family-budget/sync-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { fromBase64, toBase64 } from "../src/base64.js";
import { SyncEngine } from "../src/engine.js";
import { resolveEpochChain } from "../src/epoch-chain.js";
import { SyncClientError, SyncServerError } from "../src/errors.js";
import type { FetchResult, SyncTransport } from "../src/transport.js";
import type { DeliveredEnvelope, OutgoingEnvelope } from "../src/types.js";
import {
  createFamilyKey,
  databaseName,
  deleteDatabases,
  DEVICE_A,
  DEVICE_B,
  FAMILY_ID,
  FakeSyncServer,
  FIRST_EPOCH,
  g002Drafts,
  SECOND_EPOCH,
} from "./support.js";

afterEach(deleteDatabases);

/* ───────────────────────────── Канонические числа G-002 ───────────────────────────── */

const JULY_RESERVE_MINOR = 1_980_900;
const JULY_SPENDABLE_MINOR = 4_419_100;
const PRODUCTS_CATEGORY = "73333333-3333-4333-8333-333333333335";
const TRANSPORT_CATEGORY = "73333333-3333-4333-8333-333333333334";
const PRODUCTS_LINE = "74444444-4444-4444-8444-444444444451";
const ACTIVE_BUDGET = "74444444-4444-4444-8444-444444444441";
const MAIN_ACCOUNT = "22222222-2222-4222-8222-222222222221";
/** «Продукты» в июле G-002: одна операция от 8 июля на 22 000 ₽. */
const PRODUCTS_SPENT_MINOR = 2_200_000;
const PRODUCTS_LIMIT_MINOR = 3_000_000;
/** Операций в журнале G-002 до того, как устройства начнут писать своё. */
const G002_TRANSACTIONS = 4;

/* ───────────────────────────── Два устройства ───────────────────────────── */

interface Device {
  readonly label: string;
  /** Имя базы: переоткрытие после «выхода и повторного входа» берёт именно её. */
  readonly databaseName: string;
  readonly deviceId: string;
  repository: IndexedDbBudgetRepository<SyncedBudgetState>;
  engine: SyncEngine;
}

interface DeviceOptions {
  readonly now?: () => number;
  readonly batchSize?: number;
  readonly fetchLimit?: number;
}

function makeEngine(
  transport: SyncTransport,
  repository: IndexedDbBudgetRepository<SyncedBudgetState>,
  deviceId: string,
  family: { readonly key: CryptoKey; readonly digest: string },
  keyEpoch: number,
  options: DeviceOptions,
): SyncEngine {
  return new SyncEngine({
    repository,
    transport,
    familyId: FAMILY_ID,
    deviceId,
    familyKey: family.key,
    keyEpoch,
    keyDigest: family.digest,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.fetchLimit === undefined ? {} : { fetchLimit: options.fetchLimit }),
  });
}

function device(
  transport: SyncTransport,
  family: { readonly key: CryptoKey; readonly digest: string },
  deviceId: string,
  label: string,
  options: DeviceOptions = {},
): Device {
  const name = databaseName(label);
  const repository = new IndexedDbBudgetRepository<SyncedBudgetState>({ databaseName: name });
  return {
    label,
    databaseName: name,
    deviceId,
    repository,
    engine: makeEngine(transport, repository, deviceId, family, FIRST_EPOCH, options),
  };
}

/** Гонит очередь до конца: `push` уходит пачками, а посев G-002 больше одной пачки. */
async function drain(target: Device): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await target.engine.push();
    if (result.pending === 0) return;
  }
  throw new Error(`очередь устройства ${target.label} не разошлась`);
}

/** Читает журнал до конца: один `pull` ограничен потолком страниц этой сборки. */
async function pullToEnd(target: Device): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await target.engine.pull();
    if (!result.pageLimitReached) return;
  }
  throw new Error(`устройство ${target.label} не дочитало журнал`);
}

async function documentOf(target: Device): Promise<SyncedBudgetState> {
  const state = await target.repository.load();
  if (state === null) throw new Error(`у устройства ${target.label} нет документа`);
  return state;
}

/** Ровно те числа, которые человек видит на экране, посчитанные на этом устройстве. */
interface Money {
  readonly reserveMinor: number;
  readonly spendableMinor: number;
  readonly productsActualMinor: number;
  readonly productsRemainingMinor: number;
  readonly transportActualMinor: number;
  readonly transactions: number;
}

/** Лимит «Продуктов» в активном бюджете — величина, которую правят оба устройства сразу. */
function limitOf(state: SyncedBudgetState): number | undefined {
  return state.budgets
    .find((budget) => budget.id === ACTIVE_BUDGET)
    ?.lines.find((line) => line.id === PRODUCTS_LINE)?.plannedMinor;
}

function moneyOf(state: SyncedBudgetState): Money {
  const month = calculateAnnualPlan(state, G002.startMonth, 12).currentMonth;
  const metrics = calculateBudget(state);
  const products = metrics.categoryMetrics[PRODUCTS_CATEGORY];
  const transport = metrics.categoryMetrics[TRANSPORT_CATEGORY];
  if (products === undefined || transport === undefined) {
    throw new Error("в состоянии нет канонических категорий G-002");
  }
  return {
    reserveMinor: month.annualReserveMinor,
    spendableMinor: month.spendableAfterPlanMinor,
    productsActualMinor: products.actualMinor,
    productsRemainingMinor: products.remainingMinor,
    transportActualMinor: transport.actualMinor,
    transactions: state.transactions.length,
  };
}

async function moneyAt(target: Device): Promise<Money> {
  return moneyOf(await documentOf(target));
}

/* ───────────────────────────── Черновики операций ───────────────────────────── */

function expenseDraft(options: {
  readonly id: string;
  readonly occurredOn: string;
  readonly amountMinor: number;
  readonly categoryId: string;
}): OperationDraft {
  return {
    entity: "transaction",
    action: "create",
    targetId: options.id,
    fields: {
      kind: "expense",
      occurredOn: options.occurredOn,
      status: "posted",
      amountMinor: options.amountMinor,
      accountId: MAIN_ACCOUNT,
      categoryId: options.categoryId,
    },
  };
}

/** Тот же лимит «Продуктов», который правят оба устройства сразу. */
function productsLimit(plannedMinor: number): OperationDraft {
  return {
    entity: "budgetLine",
    action: "update",
    targetId: PRODUCTS_LINE,
    fields: { budgetId: ACTIVE_BUDGET, categoryId: PRODUCTS_CATEGORY, plannedMinor },
  };
}

/** Уникальный идентификатор операции: `NN` виден в отчёте, если тест упадёт. */
function transactionId(marker: string, index: number): string {
  return `7aaaaaaa-${marker}-4aaa-8aaa-${String(index).padStart(12, "0")}`;
}

/**
 * Семья с посеянным G-002 и двумя устройствами, которые уже сошлись на нём.
 *
 * Дальше каждый тест ломает ровно одну вещь, и с этой точки сравнение имеет смысл: обе стороны
 * до поломки показывали одно и то же, и это проверено здесь, а не предполагается.
 */
async function seededFamily(
  server: FakeSyncServer,
  family: { readonly key: CryptoKey; readonly digest: string },
  labels: readonly [string, string],
  options: DeviceOptions = {},
): Promise<{ readonly anna: Device; readonly boris: Device }> {
  const anna = device(server, family, DEVICE_A, labels[0], options);
  const boris = device(server, family, DEVICE_B, labels[1], options);

  await anna.engine.enqueue(g002Drafts());
  await drain(anna);
  await pullToEnd(anna);
  await pullToEnd(boris);

  const seeded = { reserveMinor: JULY_RESERVE_MINOR, spendableMinor: JULY_SPENDABLE_MINOR };
  expect(await moneyAt(anna)).toMatchObject(seeded);
  expect(await moneyAt(boris)).toMatchObject(seeded);
  return { anna, boris };
}

describe("два устройства, один журнал (S7)", () => {
  it("оба офлайн правят одну категорию и после схождения считают одинаково до копейки", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { anna, boris } = await seededFamily(server, family, ["same-cat-a", "same-cat-b"]);

    // До расхождения обе стороны видят канонический июль G-002 целиком.
    expect(await moneyAt(anna)).toEqual({
      reserveMinor: JULY_RESERVE_MINOR,
      spendableMinor: JULY_SPENDABLE_MINOR,
      productsActualMinor: PRODUCTS_SPENT_MINOR,
      productsRemainingMinor: PRODUCTS_LIMIT_MINOR - PRODUCTS_SPENT_MINOR,
      transportActualMinor: 400_000,
      transactions: G002_TRANSACTIONS,
    });

    // Сеть пропала у обоих, и оба продолжают работать: запись не ждёт сервера.
    server.offline = true;
    await anna.engine.enqueue([
      expenseDraft({
        id: transactionId("aaaa", 1),
        occurredOn: "2026-07-09",
        amountMinor: 400_000,
        categoryId: PRODUCTS_CATEGORY,
      }),
      productsLimit(3_500_000),
    ]);
    await boris.engine.enqueue([
      expenseDraft({
        id: transactionId("bbbb", 1),
        occurredOn: "2026-07-10",
        amountMinor: 150_000,
        categoryId: PRODUCTS_CATEGORY,
      }),
      productsLimit(2_800_000),
    ]);
    await expect(anna.engine.push()).rejects.toBeInstanceOf(SyncClientError);
    await expect(boris.engine.push()).rejects.toBeInstanceOf(SyncClientError);

    // Локально каждый уже видит свою запись: 22 000 + 4 000 у одного, 22 000 + 1 500 у другого.
    expect((await moneyAt(anna)).productsActualMinor).toBe(2_600_000);
    expect((await moneyAt(boris)).productsActualMinor).toBe(2_350_000);

    server.offline = false;
    await anna.engine.sync();
    await boris.engine.sync();
    await pullToEnd(anna);
    await pullToEnd(boris);

    const left = await documentOf(anna);
    const right = await documentOf(boris);
    expect(left).toEqual(right);

    // 22 000 + 4 000 + 1 500 = 27 500 ₽. Обе записи целы, ни одна не потерялась и не удвоилась.
    const converged = await moneyAt(anna);
    expect(converged.productsActualMinor).toBe(2_750_000);
    expect(converged.transactions).toBe(G002_TRANSACTIONS + 2);
    expect(await moneyAt(boris)).toEqual(converged);

    // Лимит правили оба: побеждает один, и он один и тот же на обеих сторонах.
    expect([2_800_000, 3_500_000]).toContain(limitOf(left));
    expect(limitOf(right)).toBe(limitOf(left));
    expect(converged.productsRemainingMinor).toBe(limitOf(left)! - 2_750_000);

    // Резерв от строк бюджета не зависит и остаётся каноническим. Свободный остаток зависит:
    // он уменьшается ровно на то, на сколько победивший лимит вырос против канонических
    // 30 000 ₽ — и уменьшается одинаково на обеих сторонах, до копейки.
    expect(converged.reserveMinor).toBe(JULY_RESERVE_MINOR);
    expect(converged.spendableMinor).toBe(
      JULY_SPENDABLE_MINOR - (limitOf(left)! - PRODUCTS_LIMIT_MINOR),
    );
    expect([3_919_100, 4_619_100]).toContain(converged.spendableMinor);

    // Один журнал, один порядок: ни один номер не выдан дважды, ни одна очередь не осталась.
    const seqs = server.stored.map((envelope) => envelope.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(await anna.repository.countOutbox()).toBe(0);
    expect(await boris.repository.countOutbox()).toBe(0);
  });

  it("часы устройств, разошедшиеся на месяцы вперёд и назад, суммы не двигают", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const trueNow = Date.UTC(2026, 6, 17, 14, 16, 6);
    const DAY = 86_400_000;
    // Одно устройство ушло на 37 дней вперёд, другое отстало на 11 дней: разница между ними
    // почти семь недель, и ни одна из них не должна попасть ни в одну сумму.
    let annaClock = trueNow + 37 * DAY;
    let borisClock = trueNow - 11 * DAY;
    const { anna, boris } = await seededFamily(server, family, ["skew-a", "skew-b"], {});
    anna.engine = makeEngine(server, anna.repository, DEVICE_A, family, FIRST_EPOCH, {
      now: () => annaClock,
    });
    boris.engine = makeEngine(server, boris.repository, DEVICE_B, family, FIRST_EPOCH, {
      now: () => borisClock,
    });

    await anna.engine.enqueue([
      expenseDraft({
        id: transactionId("aaaa", 2),
        occurredOn: "2026-07-09",
        amountMinor: 400_000,
        categoryId: TRANSPORT_CATEGORY,
      }),
    ]);
    await boris.engine.enqueue([
      expenseDraft({
        id: transactionId("bbbb", 2),
        occurredOn: "2026-07-11",
        amountMinor: 90_000,
        categoryId: PRODUCTS_CATEGORY,
      }),
    ]);
    await drain(anna);
    await drain(boris);
    await pullToEnd(anna);
    await pullToEnd(boris);

    // Дата операции — это то, что ввёл человек, а не то, что показывают часы устройства.
    const converged = await moneyAt(anna);
    expect(converged.transportActualMinor).toBe(800_000);
    expect(converged.productsActualMinor).toBe(2_290_000);
    expect(converged.reserveMinor).toBe(JULY_RESERVE_MINOR);
    expect(converged.spendableMinor).toBe(JULY_SPENDABLE_MINOR);
    expect(await moneyAt(boris)).toEqual(converged);
    expect(await documentOf(anna)).toEqual(await documentOf(boris));

    // Якорь целостности (3.6) устройство пишет по своим часам — и чекпойнт устройства, чьи часы
    // убежали на 37 дней, сходится у устройства, чьи часы отстали: в дайджест время не входит.
    expect(await anna.engine.writeCheckpoint({ force: true })).toBe(true);
    await drain(anna);
    const readBack = await boris.engine.pull();
    expect(readBack.checkpoints).toBe(1);
    expect(readBack.compared).toBe(1);
    expect(readBack.alarms).toEqual([]);
    expect((await boris.engine.readCheckpointReport()).alarm).toBeNull();

    // И обратно: отставшие часы тоже пишут чекпойнт, который сходится у убежавших.
    borisClock += 11 * DAY;
    expect(await boris.engine.writeCheckpoint({ force: true })).toBe(true);
    await drain(boris);
    annaClock += 60_000;
    const back = await anna.engine.pull();
    expect(back.compared).toBe(1);
    expect(back.alarms).toEqual([]);
    expect(await moneyAt(anna)).toEqual(converged);
  });

  it("один и тот же пакет, доставленный дважды, состояние не меняет", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { anna, boris } = await seededFamily(server, family, ["twice-a", "twice-b"]);

    await anna.engine.enqueue([
      expenseDraft({
        id: transactionId("aaaa", 3),
        occurredOn: "2026-07-09",
        amountMinor: 400_000,
        categoryId: TRANSPORT_CATEGORY,
      }),
    ]);
    await drain(anna);

    // Сервер выдал конверту второй номер: тот же `opId`, тот же шифротекст, другой `seq`.
    const written = server.stored[server.stored.length - 1]!;
    expect(written.kind).toBe("operation");
    const duplicateSeq = server.seed({
      envelopeVersion: written.envelopeVersion,
      kind: written.kind,
      familyId: written.familyId,
      opId: written.opId,
      deviceId: written.deviceId,
      keyEpoch: written.keyEpoch,
      iv: written.iv,
      ciphertext: written.ciphertext,
    });
    expect(duplicateSeq).toBe(written.seq + 1);

    await pullToEnd(boris);
    const afterDuplicate = await moneyAt(boris);
    expect(afterDuplicate.transportActualMinor).toBe(800_000);
    expect(afterDuplicate.transactions).toBe(G002_TRANSACTIONS + 1);
    expect((await boris.engine.status()).cursor).toEqual({
      keyEpoch: FIRST_EPOCH,
      seq: duplicateSeq,
    });
    expect((await boris.engine.status()).stop).toBeNull();

    // А теперь тот же самый пакет доставляется ещё раз — сервер отматывает выдачу к началу.
    // Курсор назад не идёт, суммы не двигаются, и второй записи 4 000 ₽ не появляется.
    const replaying = makeEngine(
      replayFrom(server, 0),
      boris.repository,
      DEVICE_B,
      family,
      FIRST_EPOCH,
      {},
    );
    const replayed = await replaying.pull();
    // 3.4 шаг 2 не знает разницы между «сервер повторил» и «сервер потерял середину»: обе
    // ситуации — нарушение непрерывности, и обе останавливают курсор на месте, а не двигают его.
    expect(replayed.applied).toBe(0);
    expect(replayed.stop).toMatchObject({ reason: "journal_incomplete", seq: 1 });
    expect(await moneyAt(boris)).toEqual(afterDuplicate);
    expect((await replaying.status()).cursor.seq).toBe(duplicateSeq);
    expect(await documentOf(anna)).toEqual(await documentOf(boris));
  });

  it("обрыв посреди пакета не создаёт дубля и не теряет ни одной операции", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    // Пачка в пять конвертов: двадцать операций — это ровно четыре пачки, и обрыв приходится
    // на середину, а не на границу.
    const { anna, boris } = await seededFamily(
      server,
      family,
      ["cut-a", "cut-b"],
      { batchSize: 5 },
    );

    const drafts = Array.from({ length: 20 }, (_unused, index) =>
      expenseDraft({
        id: transactionId("cccc", index),
        occurredOn: "2026-07-12",
        amountMinor: 1_000 * (index + 1),
        categoryId: PRODUCTS_CATEGORY,
      }),
    );
    await anna.engine.enqueue(drafts);
    expect(await anna.repository.countOutbox()).toBe(20);

    // Первая пачка ушла и была записана, ответ на неё пропал по дороге.
    const before = server.stored.length;
    server.dropNextAnswer = true;
    await expect(anna.engine.push()).rejects.toBeInstanceOf(SyncClientError);
    expect(server.stored.length).toBe(before + 5);
    expect(await anna.repository.countOutbox()).toBe(20);

    // Повторная попытка отправляет ту же пачку заново — сервер узнаёт её по `opId`.
    await drain(anna);
    expect(await anna.repository.countOutbox()).toBe(0);
    expect(server.stored.length).toBe(before + 20);
    const opIds = server.stored.map((envelope) => envelope.opId);
    expect(new Set(opIds).size).toBe(opIds.length);

    // Обрыв на приёме: первая страница получена, вторая — нет. Предел страницы задаёт сам
    // движок (`fetchLimit`), а не ответ сервера: величина, которой меряют предел, не может быть
    // величиной, которую пишет тот, кого предел ограничивает.
    const arrivedAt = (await boris.engine.status()).cursor.seq;
    let pages = 0;
    const flaky: SyncTransport = {
      submit: (familyId, envelopes) => server.submit(familyId, envelopes),
      fetch: async (familyId, query) => {
        pages += 1;
        if (pages === 2) {
          throw new SyncClientError("transport_failed", "связь оборвалась посреди выборки");
        }
        return server.fetch(familyId, query);
      },
      keys: (familyId) => server.keys(familyId),
    };
    boris.engine = makeEngine(flaky, boris.repository, DEVICE_B, family, FIRST_EPOCH, {
      fetchLimit: 7,
    });
    await expect(boris.engine.pull()).rejects.toBeInstanceOf(SyncClientError);
    expect(pages).toBe(2);
    const stalled = await boris.engine.status();
    expect(stalled.cursor.seq).toBe(arrivedAt + 7);
    expect(stalled.stop).toBeNull();

    // Связь вернулась — курсор продолжает с того же места, ничего не переспрашивая заново.
    boris.engine = makeEngine(server, boris.repository, DEVICE_B, family, FIRST_EPOCH, {});
    await pullToEnd(boris);

    // 1 000 + 2 000 + … + 20 000 = 210 000 копеек поверх 2 200 000.
    const converged = await moneyAt(boris);
    expect(converged.productsActualMinor).toBe(PRODUCTS_SPENT_MINOR + 210_000);
    expect(converged.transactions).toBe(G002_TRANSACTIONS + 20);
    expect(converged.reserveMinor).toBe(JULY_RESERVE_MINOR);
    await pullToEnd(anna);
    expect(await moneyAt(anna)).toEqual(converged);
    expect(await documentOf(anna)).toEqual(await documentOf(boris));
  });

  it("повторный вход на том же устройстве заново читает журнал и приходит к тем же суммам", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { anna, boris } = await seededFamily(server, family, ["relogin-a", "relogin-b"]);

    await anna.engine.enqueue([
      expenseDraft({
        id: transactionId("aaaa", 4),
        occurredOn: "2026-07-09",
        amountMinor: 400_000,
        categoryId: TRANSPORT_CATEGORY,
      }),
    ]);
    await drain(anna);
    await pullToEnd(boris);
    const expected = await moneyAt(boris);
    expect(expected.transportActualMinor).toBe(800_000);

    // Выход из учётной записи: `clearSyncData` уносит курсор, очередь, эпоху и якорь. Бюджет
    // остаётся на устройстве целиком — 6.6 на этом настаивает.
    const localBefore = await documentOf(boris);
    await boris.repository.clearSyncData();
    expect(await documentOf(boris)).toEqual(localBefore);

    // Повторный вход на том же устройстве: та же база, тот же `deviceId`, курсор с нуля.
    boris.repository = new IndexedDbBudgetRepository<SyncedBudgetState>({
      databaseName: boris.databaseName,
    });
    boris.engine = makeEngine(server, boris.repository, DEVICE_B, family, FIRST_EPOCH, {});
    expect((await boris.engine.status()).cursor).toEqual({ keyEpoch: FIRST_EPOCH, seq: 0 });

    await pullToEnd(boris);
    const again = await boris.engine.status();
    expect(again.stop).toBeNull();
    expect(again.cursor.seq).toBe(server.stored.length);

    // Журнал прочитан заново поверх уцелевшего документа: ни одной удвоенной операции.
    expect(await moneyAt(boris)).toEqual(expected);
    expect(await documentOf(boris)).toEqual(await documentOf(anna));

    // И устройство продолжает работать как участник семьи, а не как читатель.
    await boris.engine.enqueue([
      expenseDraft({
        id: transactionId("bbbb", 4),
        occurredOn: "2026-07-13",
        amountMinor: 250_000,
        categoryId: PRODUCTS_CATEGORY,
      }),
    ]);
    await drain(boris);
    await pullToEnd(anna);
    expect((await moneyAt(anna)).productsActualMinor).toBe(2_450_000);
    expect(await documentOf(anna)).toEqual(await documentOf(boris));
  });

  it("сервер, потерявший хвост журнала, обнаружен чекпойнтом, который написало устройство", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const anna = device(server, family, DEVICE_A, "truncate-a");

    await anna.engine.enqueue(g002Drafts());
    await drain(anna);
    await pullToEnd(anna);
    // Якорь пишет устройство и только устройство: величина, которой меряют сервер, не может
    // быть величиной, которую пишет сервер.
    expect(await anna.engine.writeCheckpoint({ force: true })).toBe(true);
    await drain(anna);
    const anchor = server.stored[server.stored.length - 1]!;
    expect(anchor.kind).toBe("checkpoint");
    expect(anchor.deviceId).toBe(DEVICE_A);
    const journalOpCount = server.stored.length - 1;

    // Сервер отдаёт журнал без трёх операций и перенумеровывает остаток: ряд `seq` остаётся
    // непрерывным, каждый конверт расшифровывается, и 3.4 по построению слепа к этому.
    // `g002Drafts` пишет операции последними, а «сделать бюджет активным» — самой последней,
    // поэтому прячутся три записи из четырёх, а состояние остаётся связным.
    const operations = server.stored.filter((envelope) => envelope.kind === "operation");
    const dropped = operations.slice(-5, -2).map((envelope) => envelope.opId);
    expect(dropped).toHaveLength(3);
    const truncated = truncatingTransport(server, new Set(dropped));

    const boris = device(truncated, family, DEVICE_B, "truncate-b");
    const pulled = await boris.engine.pull();

    expect(pulled.stop).toBeNull();
    expect(pulled.applied).toBe(journalOpCount - 3);
    expect(pulled.alarms).toHaveLength(1);
    expect(pulled.alarms[0]).toMatchObject({
      reason: "journal_diverged",
      checkpointCount: journalOpCount,
      ownCount: journalOpCount - 3,
      missingHere: 3,
    });
    const report = await boris.engine.readCheckpointReport();
    expect(report.alarm).toMatchObject({ missingHere: 3 });

    // И тревога — не косметика: у второго устройства действительно другой бюджет. Спрятаны
    // доход 180 000 ₽, расход 45 000 ₽ по «Жилью» и расход 22 000 ₽ по «Продуктам»; осталась
    // одна операция из четырёх, и «Продукты» на втором устройстве выглядят нетронутыми.
    const seenByBoris = await moneyAt(boris);
    expect(seenByBoris.transactions).toBe(1);
    expect(seenByBoris.productsActualMinor).toBe(0);
    expect(seenByBoris.transportActualMinor).toBe(400_000);
    const seenByAnna = await moneyAt(anna);
    expect(seenByAnna.transactions).toBe(G002_TRANSACTIONS);
    expect(seenByAnna.productsActualMinor).toBe(PRODUCTS_SPENT_MINOR);
    expect(seenByAnna.spendableMinor).toBe(JULY_SPENDABLE_MINOR);

    // Сервер перестал прятать — то же устройство перечитывает журнал и приходит к канону,
    // и тревога снимается, потому что журналы сошлись, а не потому что о ней забыли.
    await boris.repository.clearSyncData();
    boris.repository = new IndexedDbBudgetRepository<SyncedBudgetState>({
      databaseName: boris.databaseName,
    });
    boris.engine = makeEngine(server, boris.repository, DEVICE_B, family, FIRST_EPOCH, {});
    await pullToEnd(boris);
    expect(await moneyAt(boris)).toEqual(seenByAnna);
    expect((await boris.engine.readCheckpointReport()).alarm).toBeNull();
  });

  it("ротация ключа при живом втором устройстве: оно принимает новую эпоху и продолжает читать", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { anna, boris } = await seededFamily(server, family, ["rotate-a", "rotate-b"]);

    await anna.engine.enqueue([
      expenseDraft({
        id: transactionId("aaaa", 5),
        occurredOn: "2026-07-09",
        amountMinor: 400_000,
        categoryId: TRANSPORT_CATEGORY,
      }),
    ]);
    await drain(anna);
    await pullToEnd(boris);
    const before = await moneyAt(boris);
    expect(before.transportActualMinor).toBe(800_000);
    expect((await boris.engine.status()).epoch).toMatchObject({
      keyEpoch: FIRST_EPOCH,
      live: false,
    });

    // 5.5: владелец создаёт `FK'`, перешифровывает журнал и кладёт обёртку для второго устройства.
    const owner = await party(DEVICE_A);
    const receiver = await party(DEVICE_B);
    const nextKey = await generateFamilyKey();
    const nextDigest = toHex(await familyKeyFingerprint(nextKey));
    const reencrypted = await reencryptJournal(server.stored, family.key, nextKey);
    server.rotateTo(SECOND_EPOCH);
    for (const envelope of reencrypted) server.seed(envelope);
    server.wraps = {
      keyEpoch: SECOND_EPOCH,
      wraps: [await rotationWrap(owner, receiver, family.key, nextKey)],
    };

    // Второе устройство живо и узнаёт о смене ровно так, как узнаёт приложение: отказом `409`.
    const refusal = await boris.engine.pull().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SyncServerError);
    expect((refusal as SyncServerError).serverCode).toBe("epoch_mismatch");
    expect(await moneyAt(boris)).toEqual(before);

    // 5.4.1: цепочка эпох, а не «сервер сказал». Подтверждение выводится из удерживаемого ключа.
    const chain = await resolveEpochChain({
      familyId: FAMILY_ID,
      deviceId: receiver.deviceId,
      deviceSpki: receiver.spki,
      devicePrivateKey: receiver.pair.privateKey,
      wraps: server.wraps.wraps,
      accepted: { keyEpoch: FIRST_EPOCH, key: family.key },
      pin: () => ({ state: "pinned", fingerprint: owner.fingerprint }),
      senderSpki: () => owner.spki,
    });
    expect(chain.refusal).toBeNull();
    expect(chain.advanced).toBe(1);
    expect(chain.epoch?.keyEpoch).toBe(SECOND_EPOCH);
    expect(chain.epoch?.keyDigest).toBe(nextDigest);

    boris.engine = makeEngine(
      server,
      boris.repository,
      DEVICE_B,
      { key: chain.key!, digest: chain.epoch!.keyDigest },
      SECOND_EPOCH,
      {},
    );
    await pullToEnd(boris);
    const status = await boris.engine.status();
    expect(status.stop).toBeNull();
    expect(status.cursor).toEqual({ keyEpoch: SECOND_EPOCH, seq: reencrypted.length });
    expect(await moneyAt(boris)).toEqual(before);

    // Владелец переехал на тот же ключ, и семья снова пишет друг другу — уже во второй эпохе.
    anna.engine = makeEngine(
      server,
      anna.repository,
      DEVICE_A,
      { key: nextKey, digest: nextDigest },
      SECOND_EPOCH,
      {},
    );
    await pullToEnd(anna);
    await boris.engine.enqueue([
      expenseDraft({
        id: transactionId("bbbb", 5),
        occurredOn: "2026-07-14",
        amountMinor: 175_000,
        categoryId: PRODUCTS_CATEGORY,
      }),
    ]);
    await drain(boris);
    expect((await boris.engine.status()).epoch).toMatchObject({
      keyEpoch: SECOND_EPOCH,
      live: true,
    });
    await pullToEnd(anna);

    const after = await moneyAt(anna);
    expect(after.productsActualMinor).toBe(PRODUCTS_SPENT_MINOR + 175_000);
    expect(after.transportActualMinor).toBe(800_000);
    expect(after.reserveMinor).toBe(JULY_RESERVE_MINOR);
    expect(after.spendableMinor).toBe(JULY_SPENDABLE_MINOR);
    expect(await moneyAt(boris)).toEqual(after);
    expect(await documentOf(anna)).toEqual(await documentOf(boris));
  });

  it("при недоступном сервере устройство пишет и читает, а вернувшаяся сеть догоняет всё разом", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const { anna, boris } = await seededFamily(server, family, ["down-a", "down-b"]);

    // Сервер лежит. Двенадцать записей подряд ложатся в очередь и сразу видны в документе.
    server.offline = true;
    for (let index = 0; index < 12; index += 1) {
      await anna.engine.enqueue([
        expenseDraft({
          id: transactionId("dddd", index),
          occurredOn: "2026-07-15",
          amountMinor: 10_000,
          categoryId: PRODUCTS_CATEGORY,
        }),
      ]);
      // Каждая запись доступна немедленно: ожидание сети не блокирует ввод (3.1 шаг 8).
      expect((await moneyAt(anna)).transactions).toBe(G002_TRANSACTIONS + index + 1);
      await expect(anna.engine.sync()).rejects.toBeInstanceOf(SyncClientError);
    }
    const offlineMoney = await moneyAt(anna);
    expect(offlineMoney.productsActualMinor).toBe(PRODUCTS_SPENT_MINOR + 120_000);
    expect(offlineMoney.reserveMinor).toBe(JULY_RESERVE_MINOR);

    // Отчёт о состоянии при лежащем сервере читается и не выдумывает остановку.
    const waiting = await anna.engine.status();
    expect(waiting.queued).toBe(12);
    expect(waiting.stop).toBeNull();
    expect(waiting.cursor.keyEpoch).toBe(FIRST_EPOCH);

    server.offline = false;
    await anna.engine.sync();
    await pullToEnd(anna);
    await pullToEnd(boris);
    expect(await anna.repository.countOutbox()).toBe(0);
    expect(await moneyAt(boris)).toEqual(offlineMoney);
    expect(await documentOf(anna)).toEqual(await documentOf(boris));
  });
});

/* ───────────────────────────── Транспорты, ломающие ровно одно ───────────────────────────── */

/**
 * Сервер, отматывающий выдачу к началу журнала: тот же пакет, доставленный ещё раз.
 *
 * `after` подменяется на `from`, поэтому устройство получает конверты, которые уже применяло, с
 * их прежними номерами. Ровно так выглядит повторная доставка со стороны получателя.
 */
function replayFrom(server: FakeSyncServer, from: number): SyncTransport {
  return {
    submit: (familyId, envelopes) => server.submit(familyId, envelopes),
    fetch: (familyId, query) => server.fetch(familyId, { ...query, after: from }),
    keys: (familyId) => server.keys(familyId),
  };
}

/**
 * Сервер, потерявший часть журнала и перенумеровавший остаток.
 *
 * Перенумерация — обязательная часть сценария: без неё пропуск виден проверке непрерывности 3.4,
 * и якорь 3.6 не понадобился бы. Журнал G-002 короче одной страницы, поэтому перенумерация
 * делается по одной выдаче; для журнала длиннее страницы этого было бы мало.
 */
function truncatingTransport(server: FakeSyncServer, dropped: ReadonlySet<string>): SyncTransport {
  return {
    submit: (familyId, envelopes) => server.submit(familyId, envelopes),
    fetch: async (familyId, query): Promise<FetchResult> => {
      const page = await server.fetch(familyId, { ...query, after: 0, limit: query.limit });
      const kept = page.envelopes
        .filter((envelope) => !dropped.has(envelope.opId))
        .map((envelope, index): DeliveredEnvelope => ({
          ...envelope,
          seq: index + 1,
          receivedAt: index + 1,
        }))
        .filter((envelope) => envelope.seq > query.after);
      return { keyEpoch: page.keyEpoch, hasMore: false, envelopes: kept };
    },
    keys: (familyId) => server.keys(familyId),
  };
}

/* ───────────────────────────── Ротация, как её делает владелец ───────────────────────────── */

interface Party {
  readonly pair: CryptoKeyPair;
  readonly spki: Uint8Array;
  readonly fingerprint: Uint8Array;
  readonly deviceId: string;
}

async function party(deviceId: string): Promise<Party> {
  const pair = await generateDeviceKeyPair();
  const spki = await exportDevicePublicKey(pair.publicKey);
  return { pair, spki, fingerprint: await deviceKeyFingerprint(spki), deviceId };
}

const ROTATION_ID = "0000002a-0000-4000-8000-000000000002";

async function rotationWrap(
  owner: Party,
  receiver: Party,
  previousKey: CryptoKey,
  nextKey: CryptoKey,
) {
  const wrap = await wrapFamilyKey({
    familyKey: nextKey,
    senderPrivateKey: owner.pair.privateKey,
    senderSpki: owner.spki,
    senderDeviceId: owner.deviceId,
    recipientSpki: receiver.spki,
    recipientDeviceId: receiver.deviceId,
    pinnedRecipientFingerprint: receiver.fingerprint,
    familyId: FAMILY_ID,
    keyEpoch: SECOND_EPOCH,
    rotationId: ROTATION_ID,
  });
  const confirm = await computeEpochConfirm({
    previousFamilyKey: previousKey,
    familyId: FAMILY_ID,
    keyEpoch: SECOND_EPOCH,
    rotationId: ROTATION_ID,
    nextFamilyKey: nextKey,
  });
  return {
    keyEpoch: SECOND_EPOCH,
    deviceId: receiver.deviceId,
    senderDeviceId: owner.deviceId,
    rotationId: ROTATION_ID,
    salt: toBase64(wrap.salt),
    iv: toBase64(wrap.iv),
    ciphertext: toBase64(wrap.ciphertext),
    rotateConfirm: toBase64(confirm),
    confirmRotationId: ROTATION_ID,
  };
}

/**
 * Журнал старой эпохи, перешифрованный под новый ключ, — 5.5 шаг 7 глазами клиента.
 *
 * `opId`, `deviceId` и открытый текст сохраняются: операция та же самая, изменилась только эпоха,
 * а вместе с ней AAD и, значит, тег. Номера присваивает сервер заново, с единицы.
 */
async function reencryptJournal(
  stored: readonly DeliveredEnvelope[],
  previousKey: CryptoKey,
  nextKey: CryptoKey,
): Promise<OutgoingEnvelope[]> {
  const moved: OutgoingEnvelope[] = [];
  for (const envelope of stored) {
    const iv = fromBase64(envelope.iv);
    const ciphertext = fromBase64(envelope.ciphertext);
    if (iv === null || ciphertext === null) throw new Error("конверт журнала не в base64");
    const header = {
      envelopeVersion: ENVELOPE_VERSION,
      kind: envelope.kind,
      familyId: envelope.familyId,
      opId: envelope.opId,
      deviceId: envelope.deviceId,
      keyEpoch: envelope.keyEpoch,
    };
    const plaintext = await openEnvelope(previousKey, { ...header, iv, ciphertext });
    const next = { ...header, keyEpoch: SECOND_EPOCH };
    const sealed = await sealEnvelope(nextKey, next, plaintext);
    moved.push({ ...next, iv: toBase64(sealed.iv), ciphertext: toBase64(sealed.ciphertext) });
  }
  return moved;
}
