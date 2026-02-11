import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

let testDb: Database.Database;

// Mock the db module to use in-memory SQLite
vi.mock("./db.js", () => ({
  getDb: () => testDb,
  closeDb: () => {},
  withDbWriteRetry: <T>(op: () => T) => op(),
}));

// Mock audit_log to avoid file I/O
vi.mock("./audit_log.js", () => ({
  emitEvent: vi.fn(),
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock usage_adapter since guardrails imports isUsageStale
vi.mock("./usage_adapter.js", () => ({
  isUsageStale: () => false,
  pollUsage: vi.fn(),
  getLatestUsage: vi.fn(),
}));

import {
  getGuardrailState,
  checkGuardrails,
  recordRunResult,
  pauseAutopilot,
  resumeAutopilot,
} from "./guardrails.js";
import type { Policy } from "./models.js";

function makePolicy(): Policy {
  return {
    enabled: true,
    timezone: "UTC",
    weekly_target_tokens: 500000,
    weekly_min_reserve_tokens: 25000,
    schedule: [{ day: "FRI", start: "18:00", end: "23:59" }],
    filters: {
      categories_allow: [],
      tags_allow: [],
      repos_allow: [],
      repos_deny: [],
      min_confidence: 0.5,
    },
    limits: {
      max_concurrency: 2,
      max_tokens_per_run: 60000,
      max_runs_per_day: 6,
    },
    safety: {
      pause_on_ci_failures_consecutive: 3,
      pause_on_failure_rate_percent: 50,
      max_stale_usage_minutes: 30,
    },
  } as Policy;
}

beforeEach(() => {
  testDb = new Database(":memory:");
  testDb.pragma("journal_mode = WAL");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(`
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
});

afterEach(() => {
  testDb.close();
});

describe("guardrails", () => {
  it("starts in healthy state", () => {
    const state = getGuardrailState();
    expect(state.paused).toBe(false);
    expect(state.consecutive_ci_failures).toBe(0);
  });

  it("pauses on manual pause", () => {
    pauseAutopilot("test_reason");
    const state = getGuardrailState();
    expect(state.paused).toBe(true);
    expect(state.pause_reason).toBe("test_reason");
  });

  it("resumes after pause", () => {
    pauseAutopilot("test");
    resumeAutopilot();
    const state = getGuardrailState();
    expect(state.paused).toBe(false);
    expect(state.consecutive_ci_failures).toBe(0);
  });

  it("tracks consecutive failures", () => {
    recordRunResult(false);
    recordRunResult(false);
    const state = getGuardrailState();
    expect(state.consecutive_ci_failures).toBe(2);
  });

  it("resets consecutive failures on success", () => {
    recordRunResult(false);
    recordRunResult(false);
    recordRunResult(true);
    const state = getGuardrailState();
    expect(state.consecutive_ci_failures).toBe(0);
  });

  it("checkGuardrails returns unhealthy when paused", () => {
    pauseAutopilot("manual");
    const result = checkGuardrails(makePolicy());
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain("manual");
  });

  it("checkGuardrails triggers on consecutive failures", () => {
    testDb.prepare(
      "UPDATE guardrail_state SET consecutive_ci_failures = 3 WHERE id = 1",
    ).run();
    const result = checkGuardrails(makePolicy());
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain("consecutive_ci_failures");
  });
});
