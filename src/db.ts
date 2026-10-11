import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

export function openDb(path = ':memory:'): DB {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS patients (
      id              TEXT PRIMARY KEY,
      session_count   INTEGER NOT NULL DEFAULT 0,
      needs_outreach  INTEGER NOT NULL DEFAULT 0,
      outreach_reason TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      discharged_at   TEXT,
      updated_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id    TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  `);
  return db;
}

export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}