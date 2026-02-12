import { describe, it, expect, beforeEach, vi } from "vitest";
import { _resetForTesting, updateGuardrailState } from "./store.js";

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
  _resetForTesting();
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
    updateGuardrailState({ consecutive_ci_failures: 3 });
    const result = checkGuardrails(makePolicy());
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain("consecutive_ci_failures");
  });
});
