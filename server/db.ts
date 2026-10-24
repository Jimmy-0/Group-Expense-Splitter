import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  archived_at TEXT
);
-- Names are unique among active members only; archived names can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS members_active_name
  ON members(group_id, name COLLATE NOCASE) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS expenses (
  id           INTEGER PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_by      INTEGER NOT NULL REFERENCES members(id),
  split_mode   TEXT NOT NULL CHECK (split_mode IN ('equal', 'exact', 'percent')),
  is_payment   INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS expenses_group ON expenses(group_id) WHERE deleted_at IS NULL;

-- Current split of each expense. input_value keeps what the user typed (cents or basis
-- points) so edits round-trip; amount_cents is the resolved share used for balances.
CREATE TABLE IF NOT EXISTS expense_splits (
  expense_id   INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id    INTEGER NOT NULL REFERENCES members(id),
  input_value  INTEGER,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (expense_id, member_id)
);

-- Append-only audit trail: one immutable snapshot per expense version.
CREATE TABLE IF NOT EXISTS expense_revisions (
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  snapshot   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (expense_id, version)
);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` atomically. node:sqlite is synchronous, so no other request can interleave. */
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
