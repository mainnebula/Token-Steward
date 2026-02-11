import { describe, it, expect } from "vitest";
import {
  isInsideScheduleWindow,
  getRemainingBudget,
  getHoursLeft,
  getRequiredBurnRate,
} from "./policy_store.js";
import type { Policy } from "./models.js";

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    enabled: true,
    timezone: "UTC",
    weekly_target_tokens: 500000,
    weekly_min_reserve_tokens: 25000,
    schedule: [
      { day: "FRI", start: "18:00", end: "23:59" },
      { day: "SAT", start: "09:00", end: "23:59" },
    ],
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
    ...overrides,
  } as Policy;
}

describe("isInsideScheduleWindow", () => {
  it("returns true when inside a window", () => {
    // Friday 20:00 UTC
    const friday8pm = new Date("2025-01-31T20:00:00Z"); // Jan 31 2025 is a Friday
    const policy = makePolicy({ timezone: "UTC" });
    expect(isInsideScheduleWindow(policy, friday8pm)).toBe(true);
  });

  it("returns false when outside all windows", () => {
    // Monday 10:00 UTC
    const monday10am = new Date("2025-01-27T10:00:00Z"); // Monday
    const policy = makePolicy({ timezone: "UTC" });
    expect(isInsideScheduleWindow(policy, monday10am)).toBe(false);
  });

  it("returns false when right day but wrong time", () => {
    // Friday 10:00 UTC (window starts at 18:00)
    const friday10am = new Date("2025-01-31T10:00:00Z");
    const policy = makePolicy({ timezone: "UTC" });
    expect(isInsideScheduleWindow(policy, friday10am)).toBe(false);
  });
});

describe("getRemainingBudget", () => {
  it("calculates remaining budget", () => {
    const policy = makePolicy();
    // 500k target - 25k reserve - 200k used = 275k
    expect(getRemainingBudget(policy, 200000)).toBe(275000);
  });

  it("floors at zero", () => {
    const policy = makePolicy();
    expect(getRemainingBudget(policy, 999999)).toBe(0);
  });

  it("returns full budget when nothing used", () => {
    const policy = makePolicy();
    expect(getRemainingBudget(policy, 0)).toBe(475000); // 500k - 25k
  });
});

describe("getHoursLeft", () => {
  it("returns positive hours before week end", () => {
    const policy = makePolicy({ timezone: "UTC" });
    const hours = getHoursLeft(policy, new Date("2025-01-31T12:00:00Z"));
    expect(hours).toBeGreaterThan(0);
  });

  it("returns minimum 0.25", () => {
    const policy = makePolicy({ timezone: "UTC" });
    // Sunday 23:59 UTC, week ends Sunday 23:59:59
    const hours = getHoursLeft(policy, new Date("2026-02-01T23:59:59Z"));
    expect(hours).toBeGreaterThanOrEqual(0.25);
  });
});

describe("getRequiredBurnRate", () => {
  it("calculates tokens per hour", () => {
    // 100k remaining, 10 hours left = 10k/hr
    expect(getRequiredBurnRate(100000, 10)).toBe(10000);
  });

  it("clamps minimum hours to 0.25", () => {
    // 100k remaining, 0.1 hours left => treated as 0.25
    expect(getRequiredBurnRate(100000, 0.1)).toBe(100000 / 0.25);
  });
});
