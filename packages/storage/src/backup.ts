export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
export const BACKUP_FORMAT_VERSION = 2;
export const BACKUP_SCHEMA_VERSION = 1;

const BACKUP_APP = "family-budget";
const BACKUP_APP_VERSION = "0.1.0";
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_COLLECTION_ITEMS = 50_000;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type BackupPayloadValidator<T> = (value: unknown) => T;

export interface BackupIntegrity {
  /** A corruption checksum only. It is not a signature and provides no authenticity. */
  readonly algorithm: "sha256";
  readonly checksum: string;
}

export interface FamilyBudgetBackup<T> {
  readonly app: "family-budget";
  readonly appVersion: string;
  readonly formatVersion: 2;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly integrity: BackupIntegrity;
  readonly payload: T;
}

interface LegacyFamilyBudgetBackup<T> {
  readonly backupVersion: 1;
  readonly createdAt: string;
  readonly app: "family-budget";
  readonly payload: T;
}

export interface SerializeBackupOptions {
  readonly createdAt?: string;
  readonly appVersion?: string;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function genericPayloadGuard(value: unknown, rejectDuplicateIds = true): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const ids = new Set<string>();
  let nodes = 0;
  let characterUnits = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_NODES) throw new Error("Резервная копия содержит слишком много данных.");
    if (current.depth > MAX_DEPTH) throw new Error("Резервная копия имеет слишком глубокую структуру.");

    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      if (typeof current.value === "string") {
        characterUnits += current.value.length;
        if (characterUnits > MAX_BACKUP_BYTES) {
          throw new Error("Резервная копия больше допустимых 5 МБ.");
        }
      }
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value) || Math.abs(current.value) > Number.MAX_SAFE_INTEGER) {
        throw new Error("Резервная копия содержит небезопасное числовое значение.");
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_COLLECTION_ITEMS) {
        throw new Error("Резервная копия содержит слишком большую коллекцию.");
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(current.value)) {
      throw new Error("Резервная копия содержит неподдерживаемый тип данных.");
    }

    const keys = Object.keys(current.value);
    if (keys.length > MAX_COLLECTION_ITEMS) {
      throw new Error("Резервная копия содержит слишком большой объект.");
    }
    for (const key of keys) {
      characterUnits += key.length;
      if (characterUnits > MAX_BACKUP_BYTES) throw new Error("Резервная копия больше допустимых 5 МБ.");
      if (DANGEROUS_KEYS.has(key)) {
        throw new Error("Резервная копия содержит запрещённое имя поля.");
      }
      const child = current.value[key];
      if (rejectDuplicateIds && key === "id" && typeof child === "string") {
        if (ids.has(child)) throw new Error("Резервная копия содержит повторяющийся идентификатор.");
        ids.add(child);
      }
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/** Small synchronous SHA-256 implementation for browser-compatible corruption checks. */
function sha256(value: string): string {
  const bytes = Array.from(new TextEncoder().encode(value));
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
    0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
    0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
    0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
    0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
    0x5be0cd19,
  ];
  const words = new Array<number>(64);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const cursor = offset + index * 4;
      words[index] =
        ((bytes[cursor]! << 24) | (bytes[cursor + 1]! << 16) | (bytes[cursor + 2]! << 8) | bytes[cursor + 3]!) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]!;
      const y = words[index - 2]!;
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choose = (e! & f!) ^ (~e! & g!);
      const first = (h! + sigma1 + choose + constants[index]! + words[index]!) >>> 0;
      const sigma0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const second = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  return hash.map((part) => part.toString(16).padStart(8, "0")).join("");
}

function requireIsoTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("Резервная копия содержит неверную дату создания.");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Резервная копия содержит неверную дату создания.");
  }
  return value;
}

function requireEnvelope(value: unknown): FamilyBudgetBackup<unknown> {
  if (!isRecord(value)) throw new Error("Это не поддерживаемая резервная копия семейного бюджета.");
  const expectedKeys = ["app", "appVersion", "createdAt", "formatVersion", "integrity", "payload", "schemaVersion"];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new Error("Это не поддерживаемая резервная копия семейного бюджета.");
  }
  if (value.app !== BACKUP_APP) throw new Error("Резервная копия создана другим приложением.");
  if (value.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      typeof value.formatVersion === "number" && value.formatVersion > BACKUP_FORMAT_VERSION
        ? "Версия резервной копии новее поддерживаемой."
        : "Это не поддерживаемая версия резервной копии.",
    );
  }
  if (value.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(
      typeof value.schemaVersion === "number" && value.schemaVersion > BACKUP_SCHEMA_VERSION
        ? "Версия схемы данных новее поддерживаемой."
        : "Это не поддерживаемая версия схемы данных.",
    );
  }
  if (typeof value.appVersion !== "string" || value.appVersion.length === 0 || value.appVersion.length > 50) {
    throw new Error("Резервная копия содержит неверную версию приложения.");
  }
  requireIsoTimestamp(value.createdAt);
  if (!isRecord(value.integrity) || value.integrity.algorithm !== "sha256") {
    throw new Error("Резервная копия содержит неподдерживаемую проверку целостности.");
  }
  if (typeof value.integrity.checksum !== "string" || !/^[a-f0-9]{64}$/.test(value.integrity.checksum)) {
    throw new Error("Резервная копия содержит неверную проверку целостности.");
  }
  if (Object.keys(value.integrity).sort().join("\0") !== "algorithm\0checksum") {
    throw new Error("Резервная копия содержит неверную проверку целостности.");
  }
  return value as unknown as FamilyBudgetBackup<unknown>;
}

function legacyPayload(value: unknown): unknown | undefined {
  if (!isRecord(value) || !("backupVersion" in value)) return undefined;
  const expectedKeys = ["app", "backupVersion", "createdAt", "payload"];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new Error("Это не поддерживаемая резервная копия семейного бюджета.");
  }
  if (value.app !== BACKUP_APP) throw new Error("Резервная копия создана другим приложением.");
  if (value.backupVersion !== 1) throw new Error("Это не поддерживаемая версия резервной копии.");
  requireIsoTimestamp(value.createdAt);
  return (value as unknown as LegacyFamilyBudgetBackup<unknown>).payload;
}

export function serializeBackup<T>(payload: T, options: SerializeBackupOptions = {}): string {
  // The compatibility serializer cannot know an application's relationship rules.
  // ValidatedBackupCodec performs them; import always rejects duplicate identifiers.
  genericPayloadGuard(payload, false);
  const createdAt = requireIsoTimestamp(options.createdAt ?? new Date().toISOString());
  const appVersion = options.appVersion ?? BACKUP_APP_VERSION;
  if (appVersion.length === 0 || appVersion.length > 50) throw new Error("Указана неверная версия приложения.");
  const backup: FamilyBudgetBackup<T> = {
    app: BACKUP_APP,
    appVersion,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt,
    integrity: { algorithm: "sha256", checksum: sha256(stableJson(payload)) },
    payload,
  };
  const text = JSON.stringify(backup, null, 2);
  if (byteLength(text) > MAX_BACKUP_BYTES) throw new Error("Резервная копия больше допустимых 5 МБ.");
  return text;
}

export function parseBackup<T>(text: string, validate?: BackupPayloadValidator<T>): T {
  if (byteLength(text) > MAX_BACKUP_BYTES) throw new Error("Резервная копия больше допустимых 5 МБ.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Файл резервной копии не является корректным JSON.");
  }
  const migratedLegacyPayload = legacyPayload(raw);
  const backup = migratedLegacyPayload === undefined ? requireEnvelope(raw) : undefined;
  const payload = backup?.payload ?? migratedLegacyPayload;
  // The compatibility overload leaves entity-level duplicate ordering to its caller.
  // The explicit validated codec always applies this generic duplicate-ID guard first.
  genericPayloadGuard(payload, validate !== undefined);
  if (backup && sha256(stableJson(payload)) !== backup.integrity.checksum) {
    throw new Error("Проверка целостности резервной копии не пройдена.");
  }
  return validate ? validate(payload) : (payload as T);
}

export class ValidatedBackupCodec<T> {
  constructor(private readonly validate: BackupPayloadValidator<T>) {}

  serialize(payload: T, options?: SerializeBackupOptions): string {
    const validated = this.validate(payload);
    genericPayloadGuard(validated, true);
    return serializeBackup(validated, options);
  }

  parse(text: string): T {
    return parseBackup(text, this.validate);
  }
}
