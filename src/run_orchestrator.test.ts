import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

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

// Mock usage_adapter
vi.mock("./usage_adapter.js", () => ({
  pollUsage: vi.fn(),
  getLatestUsage: vi.fn(),
}));

import {
  queueRun,
  getRecentRuns,
  getLatestRun,
  getRunByRepo,
  getActiveRuns,
  updateRunStatus,
  cancelRun,
  writeContextFile,
  checkForNewCommits,
  launchInteractiveClaude,
  findExistingPR,
  verifyBranchCheckedOut,
} from "./run_orchestrator.js";
import type { Candidate, Run } from "./models.js";

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    repo_slug: "test/repo",
    issue_number: 42,
    issue_title: "Fix the bug",
    issue_url: "https://github.com/test/repo/issues/42",
    issue_labels: ["bug"],
    category: "tools",
    tags: ["typescript"],
    score: 0.85,
    est_tokens: 30000,
    discovered_at: new Date().toISOString(),
    comment_count: 3,
    reaction_count: 5,
    has_maintainer_comment: true,
    age_days: 10,
    is_bug: true,
    repo_stars: 1000,
    repo_has_contributing: true,
    repo_has_ci: true,
    llm_receptivity: 0.8,
    ...overrides,
  };
}

function setupDb() {
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
}

beforeEach(() => {
  setupDb();
});

afterEach(() => {
  testDb.close();
});

describe("queueRun", () => {
  it("creates a run with queued status", () => {
    const run = queueRun(makeCandidate());
    expect(run.status).toBe("queued");
    expect(run.candidate_repo).toBe("test/repo");
    expect(run.candidate_issue).toBe(42);
    expect(run.branch).toMatch(/^steward\/test-repo-42-/);
    expect(run.id).toHaveLength(8);
  });

  it("persists run to database", () => {
    const run = queueRun(makeCandidate());
    const row = testDb.prepare("SELECT * FROM runs WHERE id = ?").get(run.id) as Run;
    expect(row).toBeDefined();
    expect(row.status).toBe("queued");
  });
});

describe("updateRunStatus", () => {
  it("updates status fields", () => {
    const run = queueRun(makeCandidate());
    updateRunStatus(run.id, { status: "in_progress", started_at: "2025-01-01T00:00:00Z" });

    const row = testDb.prepare("SELECT * FROM runs WHERE id = ?").get(run.id) as Run;
    expect(row.status).toBe("in_progress");
    expect(row.started_at).toBe("2025-01-01T00:00:00Z");
  });

  it("updates pr_url on success", () => {
    const run = queueRun(makeCandidate());
    updateRunStatus(run.id, {
      status: "succeeded",
      pr_url: "https://github.com/test/repo/pull/1",
      finished_at: "2025-01-01T01:00:00Z",
    });

    const row = testDb.prepare("SELECT * FROM runs WHERE id = ?").get(run.id) as Run;
    expect(row.status).toBe("succeeded");
    expect(row.pr_url).toBe("https://github.com/test/repo/pull/1");
  });
});

describe("getLatestRun", () => {
  it("returns null when no runs exist", () => {
    expect(getLatestRun()).toBeNull();
  });

  it("returns most recent run", () => {
    const first = queueRun(makeCandidate({ issue_number: 1 }));
    const second = queueRun(makeCandidate({ issue_number: 2 }));
    // Ensure deterministic ordering by setting distinct timestamps
    testDb.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run("2025-01-01T00:00:00Z", first.id);
    testDb.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run("2025-01-01T01:00:00Z", second.id);

    const latest = getLatestRun();
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(second.id);
  });

  it("prefers in_progress over other statuses", () => {
    const first = queueRun(makeCandidate({ issue_number: 1 }));
    queueRun(makeCandidate({ issue_number: 2 }));
    updateRunStatus(first.id, { status: "in_progress" });

    const latest = getLatestRun();
    expect(latest!.id).toBe(first.id);
    expect(latest!.status).toBe("in_progress");
  });
});

describe("getRunByRepo", () => {
  it("returns null when no matching runs", () => {
    expect(getRunByRepo("test/repo", 42)).toBeNull();
  });

  it("finds in_progress run by repo and issue", () => {
    const run = queueRun(makeCandidate());
    updateRunStatus(run.id, { status: "in_progress" });

    const found = getRunByRepo("test/repo", 42);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(run.id);
  });

  it("does not find queued runs", () => {
    queueRun(makeCandidate());
    expect(getRunByRepo("test/repo", 42)).toBeNull();
  });
});

describe("getActiveRuns", () => {
  it("includes queued, running, and in_progress runs", () => {
    const r1 = queueRun(makeCandidate({ issue_number: 1 }));
    const r2 = queueRun(makeCandidate({ issue_number: 2 }));
    const r3 = queueRun(makeCandidate({ issue_number: 3 }));
    updateRunStatus(r2.id, { status: "running" });
    updateRunStatus(r3.id, { status: "in_progress" });

    const active = getActiveRuns();
    expect(active).toHaveLength(3);
    const statuses = active.map((r) => r.status).sort();
    expect(statuses).toEqual(["in_progress", "queued", "running"]);
  });

  it("excludes succeeded and canceled runs", () => {
    const r1 = queueRun(makeCandidate({ issue_number: 1 }));
    const r2 = queueRun(makeCandidate({ issue_number: 2 }));
    updateRunStatus(r1.id, { status: "succeeded" });
    cancelRun(r2.id);

    expect(getActiveRuns()).toHaveLength(0);
  });
});

describe("cancelRun", () => {
  it("cancels in_progress runs", () => {
    const run = queueRun(makeCandidate());
    updateRunStatus(run.id, { status: "in_progress" });
    cancelRun(run.id);

    const row = testDb.prepare("SELECT * FROM runs WHERE id = ?").get(run.id) as Run;
    expect(row.status).toBe("canceled");
    expect(row.finished_at).not.toBeNull();
  });
});

describe("writeContextFile", () => {
  const tmpDir = join("workspace", "__test_write_context__");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates STEWARD_CONTEXT.md with issue details", () => {
    const run: Run = {
      id: "abc12345",
      candidate_repo: "test/repo",
      candidate_issue: 42,
      issue_url: "https://github.com/test/repo/issues/42",
      branch: "steward/test-repo-42-abc12345",
      status: "in_progress",
      tokens_consumed: 0,
      pr_url: null,
      error: null,
      started_at: null,
      finished_at: null,
      created_at: "2025-01-01T00:00:00Z",
    };

    writeContextFile(tmpDir, run, "Fix the flaky test in CI");

    const contextPath = join(tmpDir, "STEWARD_CONTEXT.md");
    expect(existsSync(contextPath)).toBe(true);

    const context = readFileSync(contextPath, "utf-8");
    expect(context).toContain("https://github.com/test/repo/issues/42");
    expect(context).toContain("Fix the flaky test in CI");
    expect(context).toContain("Contribution Guidelines");

    const claudePath = join(tmpDir, "CLAUDE.md");
    expect(existsSync(claudePath)).toBe(true);

    const claudeMd = readFileSync(claudePath, "utf-8");
    expect(claudeMd).toContain("commit messages");
  });
});

describe("launchInteractiveClaude", () => {
  it("returns nonzero when no TTY is available", () => {
    // In test environment, stdin is not a TTY
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const exitCode = launchInteractiveClaude("/tmp");
    expect(exitCode).toBe(1);

    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  });
});

describe("checkForNewCommits", () => {
  const testRepoDir = join("workspace", "__test_commits__");

  beforeEach(() => {
    rmSync(testRepoDir, { recursive: true, force: true });
    mkdirSync(testRepoDir, { recursive: true });
    execSync("git init", { cwd: testRepoDir });
    execSync("git checkout -b main", { cwd: testRepoDir });
    writeFileSync(join(testRepoDir, "README.md"), "initial", "utf-8");
    execSync("git add . && git commit -m 'initial'", { cwd: testRepoDir });
  });

  afterEach(() => {
    rmSync(testRepoDir, { recursive: true, force: true });
  });

  it("returns false when no new commits on branch", () => {
    execSync("git checkout -b steward/test-branch", { cwd: testRepoDir });
    expect(checkForNewCommits(testRepoDir, "steward/test-branch")).toBe(false);
  });

  it("returns true when new commits exist on branch", () => {
    execSync("git checkout -b steward/test-branch", { cwd: testRepoDir });
    writeFileSync(join(testRepoDir, "new-file.txt"), "content", "utf-8");
    execSync("git add . && git commit -m 'new commit'", { cwd: testRepoDir });
    expect(checkForNewCommits(testRepoDir, "steward/test-branch")).toBe(true);
  });
});

describe("verifyBranchCheckedOut", () => {
  const testRepoDir = join("workspace", "__test_branch_verify__");

  beforeEach(() => {
    rmSync(testRepoDir, { recursive: true, force: true });
    mkdirSync(testRepoDir, { recursive: true });
    execSync("git init", { cwd: testRepoDir });
    execSync("git checkout -b main", { cwd: testRepoDir });
    writeFileSync(join(testRepoDir, "README.md"), "initial", "utf-8");
    execSync("git add . && git commit -m 'initial'", { cwd: testRepoDir });
  });

  afterEach(() => {
    rmSync(testRepoDir, { recursive: true, force: true });
  });

  it("returns true when correct branch is checked out", () => {
    execSync("git checkout -b steward/my-branch", { cwd: testRepoDir });
    expect(verifyBranchCheckedOut(testRepoDir, "steward/my-branch")).toBe(true);
  });

  it("returns false when wrong branch is checked out", () => {
    expect(verifyBranchCheckedOut(testRepoDir, "steward/some-other-branch")).toBe(false);
  });

  it("returns false for non-existent directory", () => {
    expect(verifyBranchCheckedOut("/nonexistent/path", "main")).toBe(false);
  });
});

describe("issue arg parsing", () => {
  it("parses owner/repo#123 format correctly", () => {
    const match = "cli/cli#9432".match(/^(.+?)#(\d+)$/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("cli/cli");
    expect(match![2]).toBe("9432");
  });

  it("parses org/repo#1 format", () => {
    const match = "astral-sh/ruff#15201".match(/^(.+?)#(\d+)$/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("astral-sh/ruff");
    expect(match![2]).toBe("15201");
  });

  it("rejects invalid formats", () => {
    expect("nohash".match(/^(.+?)#(\d+)$/)).toBeNull();
    expect("#123".match(/^(.+?)#(\d+)$/)).toBeNull();
    expect("repo#".match(/^(.+?)#(\d+)$/)).toBeNull();
    expect("repo#abc".match(/^(.+?)#(\d+)$/)).toBeNull();
  });
});
