import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = "state/runtime.db";
const SQLITE_BUSY = "SQLITE_BUSY";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH, { timeout: 5000 });
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      tokens_used INTEGER NOT NULL,
      tokens_quota INTEGER NOT NULL,
      tokens_remaining INTEGER NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      source TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      candidate_repo TEXT NOT NULL,
      candidate_issue INTEGER NOT NULL,
      issue_url TEXT NOT NULL,
      branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      tokens_consumed INTEGER NOT NULL DEFAULT 0,
      pr_url TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guardrail_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT,
      consecutive_ci_failures INTEGER NOT NULL DEFAULT 0,
      last_usage_poll TEXT
    );

    INSERT OR IGNORE INTO guardrail_state (id, paused, consecutive_ci_failures)
      VALUES (1, 0, 0);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function withDbWriteRetry<T>(
  operation: () => T,
  maxRetries = 5,
): T {
  let attempts = 0;

  while (true) {
    try {
      return operation();
    } catch (err) {
      const isBusy =
        err instanceof Error &&
        "code" in err &&
        (err as { code?: string }).code === SQLITE_BUSY;
      if (!isBusy || attempts >= maxRetries) throw err;

      attempts += 1;
      sleep(20 * attempts);
    }
  }
}

function sleep(ms: number): void {
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, ms);
}
