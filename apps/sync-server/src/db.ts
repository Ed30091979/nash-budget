/**
 * SQLite, opened and migrated.
 *
 * Decision 4 of the plan fixes the engine: `better-sqlite3`, so that the whole plan is checkable
 * locally without infrastructure, with a schema written to stay portable to Postgres. Portability
 * is why the columns are `snake_case`, why timestamps are integers of milliseconds rather than
 * SQLite's untyped dates, and why every `WHERE` that matters is backed by an index that Postgres
 * would also accept, partial indexes included.
 *
 * The engine is synchronous, and that is the reason it was chosen over an async driver: 3.3 asks
 * for envelope insertion and `seq` assignment *in one transaction*, and `better-sqlite3` gives a
 * transaction that cannot accidentally interleave with another request because there is no `await`
 * inside it.
 */
import Database from "better-sqlite3";

import { randomBytes } from "./bytes.ts";

export type Db = Database.Database;

/**
 * Schema migrations, applied in order, each guarded by `PRAGMA user_version`.
 *
 * Migrations are append-only: an existing entry is never edited, because a local database that has
 * already run it would silently disagree with a fresh one. This is the same rule the IndexedDB
 * migrations of `packages/storage` follow.
 */
const MIGRATIONS: readonly string[] = [
  // 1 — the whole model of section 2. It arrives in one migration because before this phase there
  // was no server at all and therefore no database anywhere to migrate from.
  `
  CREATE TABLE account (
    account_id TEXT PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  -- 6.1: the code is kept as HMAC-SHA-256 under a server secret, never as a plain hash. A
  -- 10^6 space is small enough that an unkeyed digest of a leaked table is a lookup, not a search.
  CREATE TABLE login_code (
    email      TEXT PRIMARY KEY,
    code_mac   BLOB NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
  );

  -- Rate limiting (6.1, 5.3) as plain event rows: one per attempt, swept by window.
  CREATE TABLE throttle (
    bucket TEXT NOT NULL,
    at     INTEGER NOT NULL
  );
  CREATE INDEX throttle_bucket_at ON throttle (bucket, at);

  -- 2.2 device. \`public_key\` is SPKI as handed over at registration; \`bind_proof\` and \`invite_id\`
  -- are what 5.4 asks the server to keep so the owner can recompute the HMAC on its own bindKey.
  -- There is deliberately no column here for what epoch the device has accepted, nor for its
  -- cursor: 2.2 puts the cursor on the client, and 5.4.1 keeps the accepted-key state there too.
  CREATE TABLE device (
    device_id          TEXT PRIMARY KEY,
    account_id         TEXT NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
    public_key         BLOB NOT NULL,
    bind_proof         BLOB,
    invite_id          TEXT,
    created_at         INTEGER NOT NULL,
    last_seen_at       INTEGER NOT NULL,
    revoked_at         INTEGER,
    refresh_token_hash BLOB,
    refresh_expires_at INTEGER
  );
  CREATE INDEX device_account ON device (account_id);

  -- 2.2 family. \`key_epoch\` is the epoch in force; \`max_key_epoch\` is the highest number ever
  -- handed out. The second column exists because 5.5 deletes the row of a cancelled attempt and
  -- still forbids reusing its number — with the row gone, MAX(key_epoch) would hand it out again,
  -- and 5.4 explains at length why two attempts must never share a number.
  CREATE TABLE family (
    family_id       TEXT PRIMARY KEY,
    created_at      INTEGER NOT NULL,
    key_epoch       INTEGER NOT NULL,
    max_key_epoch   INTEGER NOT NULL,
    owner_member_id TEXT NOT NULL
  );

  -- 2.2 member. The partial unique index is 2.1's "an account is in at most one family": it binds
  -- only live memberships, so a member who left can join again later.
  CREATE TABLE member (
    member_id  TEXT PRIMARY KEY,
    family_id  TEXT NOT NULL REFERENCES family (family_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at  INTEGER NOT NULL,
    removed_at INTEGER
  );
  CREATE UNIQUE INDEX member_one_family
    ON member (account_id) WHERE removed_at IS NULL;
  CREATE INDEX member_family ON member (family_id);

  -- 2.2 epoch. The counter belongs to the epoch and not to the family: during rotation a family
  -- has two live epochs at once, and one shared counter would give them overlapping numbering.
  CREATE TABLE epoch (
    family_id           TEXT NOT NULL REFERENCES family (family_id) ON DELETE CASCADE,
    key_epoch           INTEGER NOT NULL,
    seq_counter         INTEGER NOT NULL DEFAULT 0,
    state               TEXT NOT NULL CHECK (state IN ('staging', 'active', 'retired')),
    rotation_id         TEXT,
    rotating_device_id  TEXT,
    rotation_started_at INTEGER,
    last_progress_at    INTEGER,
    freeze_seq          INTEGER,
    PRIMARY KEY (family_id, key_epoch)
  );
  CREATE INDEX epoch_state ON epoch (state, family_id);

  -- 3.3 step 4: the unique index carries the epoch. Without it the re-encrypted journal of a
  -- rotation, which keeps every opId on purpose (2.1), would collide with itself, be ignored
  -- silently, and leave the new epoch empty while step 7 deletes the old one.
  CREATE TABLE envelope (
    family_id        TEXT NOT NULL,
    key_epoch        INTEGER NOT NULL,
    op_id            TEXT NOT NULL,
    seq              INTEGER NOT NULL,
    envelope_version INTEGER NOT NULL,
    kind             TEXT NOT NULL,
    device_id        TEXT NOT NULL,
    iv               BLOB NOT NULL,
    ciphertext       BLOB NOT NULL,
    received_at      INTEGER NOT NULL,
    PRIMARY KEY (family_id, key_epoch, op_id),
    FOREIGN KEY (family_id, key_epoch) REFERENCES epoch (family_id, key_epoch) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX envelope_seq ON envelope (family_id, key_epoch, seq);

  -- 5.3, last paragraph but one: exactly what the server is allowed to hold. The token itself is
  -- absent by construction — only its SHA-256 has a column — and bindKey has no column at all.
  CREATE TABLE invite (
    invite_id          TEXT PRIMARY KEY,
    family_id          TEXT NOT NULL REFERENCES family (family_id) ON DELETE CASCADE,
    key_epoch          INTEGER NOT NULL,
    auth_token_digest  BLOB NOT NULL,
    iv                 BLOB NOT NULL,
    ciphertext         BLOB,
    created_at         INTEGER NOT NULL,
    expires_at         INTEGER NOT NULL,
    used_at            INTEGER,
    used_by_device_id  TEXT
  );
  CREATE INDEX invite_family ON invite (family_id);

  -- 2.2 keyWrap and epochConfirm: opaque bytes the server stores and cannot check. 5.5 step 7 is
  -- explicit that these two survive the deletion of the old epoch's envelopes, because the
  -- catch-up chain of 5.4 needs them for as long as some device still has that epoch to cross.
  CREATE TABLE key_wrap (
    family_id        TEXT NOT NULL,
    key_epoch        INTEGER NOT NULL,
    device_id        TEXT NOT NULL,
    sender_device_id TEXT NOT NULL,
    rotation_id      TEXT NOT NULL,
    salt             BLOB NOT NULL,
    iv               BLOB NOT NULL,
    ciphertext       BLOB NOT NULL,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (family_id, key_epoch, device_id)
  );
  CREATE INDEX key_wrap_device ON key_wrap (device_id);

  CREATE TABLE epoch_confirm (
    family_id      TEXT NOT NULL,
    key_epoch      INTEGER NOT NULL,
    rotation_id    TEXT NOT NULL,
    rotate_confirm BLOB NOT NULL,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (family_id, key_epoch)
  );
  `,
  // 2 — what the first migration left for someone else to bound. Every statement here exists
  // because a table could be made to grow, or a lookup made to walk, by a party that pays nothing
  // for it; the reasoning belongs next to each one and is repeated at the route that relies on it.
  `
  -- 5.3: an expired invite is deleted, not merely emptied, and the sweep that deletes it must not
  -- read the table to find out there is nothing to delete.
  CREATE INDEX invite_expires ON invite (expires_at);
  -- The claim of 5.3 looks a row up by the digest it was given rather than walking every live
  -- invite. The comparison stays constant-time in the route; what changes is that the number of
  -- rows it touches is a constant instead of a length the issuing owners choose. See invites.ts.
  CREATE INDEX invite_digest ON invite (auth_token_digest);
  -- 6.1: the code table is written by an unauthenticated request, so it is swept by expiry the
  -- same way the throttle windows are.
  CREATE INDEX login_code_expires ON login_code (expires_at);

  -- 3.2.1, counted in bytes as well as in envelopes. Kept on the row and maintained inside the
  -- insertion transaction: a SUM over a hundred thousand rows on every batch would be the same
  -- unbounded scan this migration exists to remove.
  ALTER TABLE epoch ADD COLUMN ciphertext_bytes INTEGER NOT NULL DEFAULT 0;
  UPDATE epoch SET ciphertext_bytes = COALESCE((
    SELECT SUM(LENGTH(e.ciphertext)) FROM envelope e
     WHERE e.family_id = epoch.family_id AND e.key_epoch = epoch.key_epoch
  ), 0);

  -- 6.1: signing out drops the refresh token, and until this column existed it dropped nothing
  -- else — the access token of a signed-out device stayed good for up to fifteen minutes, while
  -- revocation (6.7) acts at once. The serial is named in the access token and compared at the
  -- door, so signing out ends the session it says it ends.
  ALTER TABLE device ADD COLUMN token_serial INTEGER NOT NULL DEFAULT 0;

  -- 2.2: memberId is chosen by the client, and with a single-column key one family's identifier
  -- could collide with another's — a 500 for the caller and an existence oracle for anyone
  -- prepared to read one. The key is the pair, so the collision cannot cross a family boundary
  -- and inside one family it is the caller's own doing and is refused in words.
  CREATE TABLE member_v2 (
    member_id  TEXT NOT NULL,
    family_id  TEXT NOT NULL REFERENCES family (family_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES account (account_id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at  INTEGER NOT NULL,
    removed_at INTEGER,
    PRIMARY KEY (family_id, member_id)
  );
  INSERT INTO member_v2 (member_id, family_id, account_id, role, joined_at, removed_at)
    SELECT member_id, family_id, account_id, role, joined_at, removed_at FROM member;
  DROP TABLE member;
  ALTER TABLE member_v2 RENAME TO member;
  CREATE UNIQUE INDEX member_one_family ON member (account_id) WHERE removed_at IS NULL;
  CREATE INDEX member_family ON member (family_id);

  -- 6.1: the secret behind the access-token MAC and the login-code MAC. Generated once and kept
  -- with the data it authenticates: regenerated at every start, it silently invalidated every code
  -- already in the table, and a restart between "send me a code" and "here is the code" answered a
  -- correct code with "the code is not valid".
  CREATE TABLE server_secret (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    secret     BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const current = Number((db.pragma("user_version", { simple: true }) as number | bigint) ?? 0);
  if (current > MIGRATIONS.length) {
    throw new Error(
      `database schema version ${current} is newer than this build understands (${MIGRATIONS.length})`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) throw new Error(`missing migration ${version + 1}`);
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
  }
}

/**
 * The secret behind the access-token MAC and the login-code MAC (6.1), read from the database or
 * written into it once.
 *
 * It used to be generated at every start, which is fine only for a server whose state dies with
 * the process. With a file database it is a defect with no error message: every login code already
 * in the table was keyed under a secret that no longer exists, so a restart between "send me a
 * code" and "here is the code" answers a correct code with "the code is not valid" — the same
 * refusal a wrong code gets, and 6.1 deliberately makes those two indistinguishable.
 *
 * A secret supplied in the configuration still wins; this is the default, not an override.
 */
export function loadOrCreateTokenSecret(db: Db, now: number): Uint8Array {
  const row = db.prepare("SELECT secret FROM server_secret WHERE id = 1").get() as
    | { secret: Uint8Array }
    | undefined;
  if (row !== undefined) return new Uint8Array(row.secret);
  const secret = randomBytes(32);
  db.prepare("INSERT INTO server_secret (id, secret, created_at) VALUES (1, ?, ?)").run(secret, now);
  return secret;
}
