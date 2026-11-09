import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS accounts (
    wallet TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    total_topped_up INTEGER NOT NULL DEFAULT 0,
    total_spent INTEGER NOT NULL DEFAULT 0,
    total_refunded INTEGER NOT NULL DEFAULT 0,
    daily_cap INTEGER,
    session_epoch INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (balance >= 0),
    CHECK (reserved >= 0),
    CHECK (reserved <= balance)
  );
  CREATE TABLE IF NOT EXISTS topups (
    id TEXT PRIMARY KEY,
    wallet TEXT,
    amount INTEGER NOT NULL,
    network TEXT NOT NULL,
    asset TEXT NOT NULL,
    payload_hash TEXT NOT NULL UNIQUE,
    tx_signature TEXT UNIQUE,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS topups_status ON topups(status, created_at);
  CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    amount INTEGER NOT NULL,
    tier TEXT NOT NULL,
    methods TEXT NOT NULL,
    request_id TEXT NOT NULL,
    status TEXT NOT NULL,
    charged INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS reservations_status ON reservations(status, created_at);
  CREATE INDEX IF NOT EXISTS reservations_wallet ON reservations(wallet, status);
  CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    kind TEXT NOT NULL,
    amount INTEGER NOT NULL,
    ref TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (kind, ref)
  );
  CREATE INDEX IF NOT EXISTS journal_wallet ON journal(wallet, id);
  CREATE TABLE IF NOT EXISTS daily_usage (
    wallet TEXT NOT NULL,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    spent INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (wallet, day)
  );
  CREATE TABLE IF NOT EXISTS idempotency (
    wallet TEXT NOT NULL,
    key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    http_status INTEGER,
    headers TEXT,
    body TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (wallet, key)
  );
  CREATE TABLE IF NOT EXISTS refunds (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    amount INTEGER NOT NULL,
    destination TEXT NOT NULL,
    status TEXT NOT NULL,
    tx_signature TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS refunds_status ON refunds(status, created_at);
  CREATE TABLE IF NOT EXISTS siwx_nonces (
    nonce TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    wallet TEXT,
    subject TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_kind ON events(kind, created_at);
  `,
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version]!);
      version += 1;
      db.prepare("UPDATE schema_version SET version = ?").run(version);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}

/** Runs `fn` inside an IMMEDIATE transaction. `fn` must be synchronous. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
