import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetForTesting,
  addRun,
  updateRun,
  getRuns,
  getTodayRunCount,
  addUsageSnapshot,
  getLatestSnapshot,
  getGuardrailData,
  updateGuardrailState,
  incrementCiFailures,
  resetCiFailures,
  closeStore,
} from "./store.js";
import type { Run, UsageSnapshot } from "./models.js";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: Math.random().toString(36).slice(2, 10),
    candidate_repo: "test/repo",
    candidate_issue: 1,
    issue_url: "https://github.com/test/repo/issues/1",
    branch: "steward/test-1",
    status: "queued",
    tokens_consumed: 0,
    pr_url: null,
    error: null,
    started_at: null,
    finished_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  _resetForTesting();
});

describe("runs", () => {
  it("adds and retrieves runs", () => {
    const run = makeRun();
    addRun(run);
    const runs = getRuns({});
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(run.id);
  });

  it("updates a run", () => {
    const run = makeRun();
    addRun(run);
    updateRun(run.id, { status: "running", started_at: "2025-01-01T00:00:00Z" });
    const runs = getRuns({});
    expect(runs[0].status).toBe("running");
    expect(runs[0].started_at).toBe("2025-01-01T00:00:00Z");
  });

  it("filters by statuses", () => {
    addRun(makeRun({ id: "a", status: "queued" }));
    addRun(makeRun({ id: "b", status: "running" }));
    addRun(makeRun({ id: "c", status: "succeeded" }));

    const active = getRuns({ statuses: ["queued", "running"] });
    expect(active).toHaveLength(2);
    expect(active.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("filters by excludeStatuses", () => {
    addRun(makeRun({ id: "a", status: "queued" }));
    addRun(makeRun({ id: "b", status: "succeeded" }));

    const result = getRuns({ excludeStatuses: ["queued"] });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("filters by repo and issue", () => {
    addRun(makeRun({ id: "a", candidate_repo: "foo/bar", candidate_issue: 1 }));
    addRun(makeRun({ id: "b", candidate_repo: "foo/bar", candidate_issue: 2 }));
    addRun(makeRun({ id: "c", candidate_repo: "baz/qux", candidate_issue: 1 }));

    const result = getRuns({ repo: "foo/bar", issue: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("sorts by created_at_desc", () => {
    addRun(makeRun({ id: "a", created_at: "2025-01-01T00:00:00Z" }));
    addRun(makeRun({ id: "b", created_at: "2025-01-02T00:00:00Z" }));

    const result = getRuns({ orderBy: "created_at_desc" });
    expect(result[0].id).toBe("b");
    expect(result[1].id).toBe("a");
  });

  it("sorts active_first then by created_at_desc", () => {
    addRun(makeRun({ id: "a", status: "queued", created_at: "2025-01-02T00:00:00Z" }));
    addRun(makeRun({ id: "b", status: "in_progress", created_at: "2025-01-01T00:00:00Z" }));

    const result = getRuns({ orderBy: "active_first" });
    expect(result[0].id).toBe("b"); // in_progress first
    expect(result[1].id).toBe("a");
  });

  it("sorts by finished_at_desc", () => {
    addRun(makeRun({ id: "a", status: "succeeded", finished_at: "2025-01-01T00:00:00Z" }));
    addRun(makeRun({ id: "b", status: "failed", finished_at: "2025-01-02T00:00:00Z" }));

    const result = getRuns({ orderBy: "finished_at_desc" });
    expect(result[0].id).toBe("b");
    expect(result[1].id).toBe("a");
  });

  it("applies limit", () => {
    addRun(makeRun({ id: "a" }));
    addRun(makeRun({ id: "b" }));
    addRun(makeRun({ id: "c" }));

    const result = getRuns({ limit: 2 });
    expect(result).toHaveLength(2);
  });

  it("getTodayRunCount counts today's non-canceled runs", () => {
    addRun(makeRun({ id: "a", created_at: new Date().toISOString() }));
    addRun(makeRun({ id: "b", created_at: new Date().toISOString(), status: "canceled" }));
    addRun(makeRun({ id: "c", created_at: "2020-01-01T00:00:00Z" }));

    expect(getTodayRunCount()).toBe(1);
  });

  it("does not mutate store when modifying returned runs", () => {
    addRun(makeRun({ id: "x", status: "queued" }));
    const runs = getRuns({});
    runs[0].status = "failed";

    const fresh = getRuns({});
    expect(fresh[0].status).toBe("queued");
  });
});

describe("usage snapshots", () => {
  it("adds and retrieves snapshots", () => {
    const snapshot: UsageSnapshot = {
      timestamp: "2025-01-01T00:00:00Z",
      tokens_used: 1000,
      tokens_quota: 5000,
      tokens_remaining: 4000,
      period_start: "2025-01-01T00:00:00Z",
      period_end: "2025-01-07T00:00:00Z",
      source: "oauth_api",
    };
    addUsageSnapshot(snapshot);

    const latest = getLatestSnapshot();
    expect(latest).not.toBeNull();
    expect(latest!.tokens_used).toBe(1000);
  });

  it("returns latest snapshot by timestamp", () => {
    addUsageSnapshot({
      timestamp: "2025-01-01T00:00:00Z",
      tokens_used: 1000,
      tokens_quota: 5000,
      tokens_remaining: 4000,
      period_start: "2025-01-01T00:00:00Z",
      period_end: "2025-01-07T00:00:00Z",
      source: "oauth_api",
    });
    addUsageSnapshot({
      timestamp: "2025-01-02T00:00:00Z",
      tokens_used: 2000,
      tokens_quota: 5000,
      tokens_remaining: 3000,
      period_start: "2025-01-01T00:00:00Z",
      period_end: "2025-01-07T00:00:00Z",
      source: "oauth_api",
    });

    const latest = getLatestSnapshot();
    expect(latest!.tokens_used).toBe(2000);
  });

  it("returns null when no snapshots", () => {
    expect(getLatestSnapshot()).toBeNull();
  });
});

describe("guardrail state", () => {
  it("returns default state", () => {
    const state = getGuardrailData();
    expect(state.paused).toBe(false);
    expect(state.consecutive_ci_failures).toBe(0);
    expect(state.pause_reason).toBeNull();
    expect(state.last_usage_poll).toBeNull();
  });

  it("updates guardrail state", () => {
    updateGuardrailState({ paused: true, pause_reason: "test" });
    const state = getGuardrailData();
    expect(state.paused).toBe(true);
    expect(state.pause_reason).toBe("test");
  });

  it("increments ci failures", () => {
    incrementCiFailures();
    incrementCiFailures();
    expect(getGuardrailData().consecutive_ci_failures).toBe(2);
  });

  it("resets ci failures", () => {
    incrementCiFailures();
    incrementCiFailures();
    resetCiFailures();
    expect(getGuardrailData().consecutive_ci_failures).toBe(0);
  });

  it("does not mutate store when modifying returned data", () => {
    const state = getGuardrailData();
    state.paused = true;

    const fresh = getGuardrailData();
    expect(fresh.paused).toBe(false);
  });
});

describe("closeStore", () => {
  it("can be called multiple times safely", () => {
    closeStore();
    closeStore();
    // No error thrown
  });
});
