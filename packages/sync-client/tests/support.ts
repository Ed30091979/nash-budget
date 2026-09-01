import "fake-indexeddb/auto";

import { IndexedDbBudgetRepository } from "@family-budget/storage";
import {
  ENVELOPE_VERSION,
  familyKeyFingerprint,
  generateFamilyKey,
  sealEnvelope,
  toHex,
  utf8,
} from "@family-budget/sync-crypto";
import {
  createClock,
  createLocalOperation,
  encodeOperation,
  type Operation,
  type OperationDraft,
  type SyncedBudgetState,
  type TransactionFields,
} from "@family-budget/sync-protocol";
import { G002, toDomainBudgetState } from "@family-budget/test-fixtures";

import { toBase64 } from "../src/base64.js";
import { SyncClientError, SyncServerError } from "../src/errors.js";
import type { FetchQuery, FetchResult, KeysResult, SubmitResult, SyncTransport } from "../src/transport.js";
import type { DeliveredEnvelope, OutgoingEnvelope } from "../src/types.js";

export const FAMILY_ID = "0f000000-0000-4000-8000-00000000fa11";
export const DEVICE_A = "0000000a-0000-4000-8000-000000000001";
export const DEVICE_B = "0000000b-0000-4000-8000-000000000002";
export const FIRST_EPOCH = 1;
/** The epoch a rotation puts the family on — 5.5. */
export const SECOND_EPOCH = 2;

export const databaseNames = new Set<string>();

export function databaseName(label: string): string {
  const value = `sync-client-${label}-${crypto.randomUUID()}`;
  databaseNames.add(value);
  return value;
}

export function makeRepository(label: string): IndexedDbBudgetRepository<SyncedBudgetState> {
  return new IndexedDbBudgetRepository<SyncedBudgetState>({ databaseName: databaseName(label) });
}

export function reopen(
  repository: IndexedDbBudgetRepository<SyncedBudgetState>,
  name: string,
): IndexedDbBudgetRepository<SyncedBudgetState> {
  void repository;
  return new IndexedDbBudgetRepository<SyncedBudgetState>({ databaseName: name });
}

export async function deleteDatabases(): Promise<void> {
  for (const name of databaseNames) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  }
  databaseNames.clear();
}

export interface FamilyKeyMaterial {
  readonly key: CryptoKey;
  readonly digest: string;
}

export async function createFamilyKey(): Promise<FamilyKeyMaterial> {
  const key = await generateFamilyKey();
  return { key, digest: toHex(await familyKeyFingerprint(key)) };
}

/** Seals one operation exactly the way the engine does, so a peer's envelope is indistinguishable. */
export async function sealOperation(
  familyKey: CryptoKey,
  operation: Operation,
  overrides: Partial<OutgoingEnvelope> = {},
): Promise<OutgoingEnvelope> {
  const header = {
    envelopeVersion: ENVELOPE_VERSION,
    kind: "operation" as const,
    familyId: FAMILY_ID,
    opId: operation.opId,
    deviceId: operation.deviceId,
    // The epoch is part of the AAD (5.2), so an override of it has to reach the sealing itself.
    // Pasted over the finished envelope it would only produce a broken tag, and a test of an
    // honest envelope of another epoch would be testing a forged one.
    keyEpoch: overrides.keyEpoch ?? FIRST_EPOCH,
  };
  const sealed = await sealEnvelope(familyKey, header, utf8(encodeOperation(operation)));
  return {
    ...header,
    iv: toBase64(sealed.iv),
    ciphertext: toBase64(sealed.ciphertext),
    ...overrides,
  };
}

/** Seals arbitrary plaintext under a header of the caller's choosing. */
export async function sealRaw(
  familyKey: CryptoKey,
  header: {
    readonly envelopeVersion?: number;
    readonly kind?: string;
    readonly opId: string;
    readonly deviceId: string;
    readonly keyEpoch?: number;
  },
  plaintext: string,
): Promise<OutgoingEnvelope> {
  const full = {
    envelopeVersion: header.envelopeVersion ?? ENVELOPE_VERSION,
    kind: header.kind ?? "operation",
    familyId: FAMILY_ID,
    opId: header.opId,
    deviceId: header.deviceId,
    keyEpoch: header.keyEpoch ?? FIRST_EPOCH,
  };
  const sealed = await sealEnvelope(familyKey, full, utf8(plaintext));
  return { ...full, iv: toBase64(sealed.iv), ciphertext: toBase64(sealed.ciphertext) };
}

export async function sealCheckpoint(
  familyKey: CryptoKey,
  opId: string,
  deviceId: string,
  record: unknown,
): Promise<OutgoingEnvelope> {
  const header = {
    envelopeVersion: ENVELOPE_VERSION,
    kind: "checkpoint" as const,
    familyId: FAMILY_ID,
    opId,
    deviceId,
    keyEpoch: FIRST_EPOCH,
  };
  const sealed = await sealEnvelope(familyKey, header, utf8(JSON.stringify(record)));
  return { ...header, iv: toBase64(sealed.iv), ciphertext: toBase64(sealed.ciphertext) };
}

type FixtureState = ReturnType<typeof toDomainBudgetState>;
type FixtureTransaction = FixtureState["transactions"][number];

function withoutId<T extends { readonly id: string }>(entity: T): Omit<T, "id"> {
  const { id: _id, ...fields } = entity;
  return fields;
}

function transactionFields(transaction: FixtureTransaction): TransactionFields {
  const base = {
    occurredOn: transaction.occurredOn,
    status: transaction.status,
    amountMinor: transaction.amountMinor,
  };
  switch (transaction.kind) {
    case "income":
      return { ...base, kind: "income", accountId: transaction.accountId };
    case "expense":
      return { ...base, kind: "expense", accountId: transaction.accountId, categoryId: transaction.categoryId };
    case "refund":
      return {
        ...base,
        kind: "refund",
        accountId: transaction.accountId,
        categoryId: transaction.categoryId,
        originalTransactionId: transaction.originalTransactionId,
      };
    case "transfer":
      return { ...base, kind: "transfer", fromAccountId: transaction.fromAccountId, toAccountId: transaction.toAccountId };
    case "goal_contribution":
      return {
        ...base,
        kind: "goal_contribution",
        fromAccountId: transaction.fromAccountId,
        toAccountId: transaction.toAccountId,
        goalId: transaction.goalId,
      };
  }
}

/** The canonical G-002 budget as an append-only journal of drafts, in the order a device writes it. */
export function g002Drafts(): OperationDraft[] {
  const state: FixtureState = toDomainBudgetState(G002);
  const drafts: OperationDraft[] = [];
  for (const account of state.accounts) {
    drafts.push({ entity: "account", action: "create", targetId: account.id, fields: withoutId(account) });
  }
  for (const category of state.categories) {
    drafts.push({ entity: "category", action: "create", targetId: category.id, fields: withoutId(category) });
  }
  for (const budget of state.budgets) {
    const { id, lines, ...fields } = budget;
    drafts.push({ entity: "budget", action: "create", targetId: id, fields });
    for (const line of lines) {
      drafts.push({
        entity: "budgetLine",
        action: "create",
        targetId: line.id,
        fields: { budgetId: id, ...withoutId(line) },
      });
    }
  }
  for (const goal of state.goals) {
    drafts.push({ entity: "goal", action: "create", targetId: goal.id, fields: withoutId(goal) });
  }
  for (const commitment of state.annualCommitments) {
    drafts.push({ entity: "annualCommitment", action: "create", targetId: commitment.id, fields: withoutId(commitment) });
  }
  for (const expense of state.scheduledExpenses) {
    drafts.push({ entity: "scheduledExpense", action: "create", targetId: expense.id, fields: withoutId(expense) });
  }
  for (const transaction of state.transactions) {
    drafts.push({
      entity: "transaction",
      action: "create",
      targetId: transaction.id,
      fields: transactionFields(transaction),
    });
  }
  drafts.push({ entity: "budget", action: "activate", targetId: state.activeBudgetId });
  return drafts;
}

/** Stamps drafts as one device would, without touching any storage. */
export function stampDrafts(deviceId: string, drafts: readonly OperationDraft[], from = 0): Operation[] {
  let clock = createClock(deviceId, from);
  const operations: Operation[] = [];
  for (const draft of drafts) {
    const local = createLocalOperation(clock, draft);
    clock = local.clock;
    operations.push(local.operation);
  }
  return operations;
}

interface StoredEnvelope extends DeliveredEnvelope {}

/**
 * The journal half of `apps/sync-server`, reimplemented to the letter of 3.3 and 3.4.
 *
 * The point of a fake here rather than the real server is the one thing the real one cannot be
 * asked to do honestly: lose the network in the middle of a batch, and lose the *answer* to a
 * batch it has already committed.
 */
export class FakeSyncServer implements SyncTransport {
  private readonly envelopes: StoredEnvelope[] = [];
  /** One counter per epoch: 5.5 step 1 gives a new epoch its own `seq`, starting at `1`. */
  private readonly counters = new Map<number, number>();
  private received = 0;
  keyEpoch = FIRST_EPOCH;
  offline = false;
  /** Commits the next submission and then drops the answer, as a cut link would. */
  dropNextAnswer = false;
  submissions = 0;
  fetches = 0;
  wraps: KeysResult = { keyEpoch: FIRST_EPOCH, wraps: [] };

  get stored(): readonly StoredEnvelope[] {
    return this.envelopes;
  }

  /** Puts an envelope into the journal without a client, as another family device would. */
  seed(envelope: OutgoingEnvelope): number {
    const next = (this.counters.get(envelope.keyEpoch) ?? 0) + 1;
    this.counters.set(envelope.keyEpoch, next);
    this.received += 1;
    this.envelopes.push({ ...envelope, seq: next, receivedAt: this.received });
    return next;
  }

  /**
   * 5.5 step 7, as far as a client can see it: the new epoch is in force and the retired one's
   * envelopes are physically gone. The owner's re-encrypted journal is seeded afterwards, under
   * the new epoch's own numbering.
   */
  rotateTo(keyEpoch: number): void {
    const surviving = this.envelopes.filter((envelope) => envelope.keyEpoch >= keyEpoch);
    this.envelopes.splice(0, this.envelopes.length, ...surviving);
    this.keyEpoch = keyEpoch;
  }

  /** Removes an envelope from the middle of the journal, as a server that held one back would. */
  withhold(seq: number): DeliveredEnvelope | undefined {
    const index = this.envelopes.findIndex((envelope) => envelope.seq === seq);
    if (index < 0) return undefined;
    return this.envelopes.splice(index, 1)[0];
  }

  /** Puts a withheld envelope back where it was, as a server that stopped holding it would. */
  reinstate(envelope: DeliveredEnvelope): void {
    this.envelopes.push(envelope);
  }

  private online(): void {
    if (this.offline) {
      throw new SyncClientError("transport_failed", "the sync server could not be reached");
    }
  }

  async submit(familyId: string, envelopes: readonly OutgoingEnvelope[]): Promise<SubmitResult> {
    this.online();
    this.submissions += 1;
    if (familyId !== FAMILY_ID) throw new SyncServerError(403, "forbidden");
    if (envelopes.some((envelope) => envelope.keyEpoch !== this.keyEpoch)) {
      throw new SyncServerError(409, "epoch_mismatch", { keyEpoch: this.keyEpoch });
    }
    const accepted: { opId: string; seq: number }[] = [];
    for (const envelope of envelopes) {
      const existing = this.envelopes.find(
        (stored) => stored.keyEpoch === envelope.keyEpoch && stored.opId === envelope.opId,
      );
      if (existing !== undefined) {
        accepted.push({ opId: envelope.opId, seq: existing.seq });
        continue;
      }
      accepted.push({ opId: envelope.opId, seq: this.seed(envelope) });
    }
    if (this.dropNextAnswer) {
      this.dropNextAnswer = false;
      throw new SyncClientError("transport_failed", "the answer was lost on the way back");
    }
    return { keyEpoch: this.keyEpoch, accepted };
  }

  async fetch(familyId: string, query: FetchQuery): Promise<FetchResult> {
    this.online();
    this.fetches += 1;
    if (familyId !== FAMILY_ID) throw new SyncServerError(403, "forbidden");
    if (query.keyEpoch !== this.keyEpoch) {
      throw new SyncServerError(409, "epoch_mismatch", { keyEpoch: this.keyEpoch });
    }
    const matching = this.envelopes
      .filter((envelope) => envelope.keyEpoch === query.keyEpoch && envelope.seq > query.after)
      .sort((left, right) => left.seq - right.seq);
    const page = matching.slice(0, query.limit);
    return { keyEpoch: query.keyEpoch, hasMore: matching.length > page.length, envelopes: page };
  }

  async keys(familyId: string): Promise<KeysResult> {
    this.online();
    if (familyId !== FAMILY_ID) throw new SyncServerError(403, "forbidden");
    return this.wraps;
  }
}
