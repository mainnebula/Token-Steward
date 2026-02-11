import { describe, it, expect } from "vitest";
import { PolicySchema } from "./models.js";

const validPolicy = {
  enabled: true,
  timezone: "America/Chicago",
  weekly_target_tokens: 500000,
  weekly_min_reserve_tokens: 25000,
  schedule: [{ day: "FRI", start: "18:00", end: "23:59" }],
  filters: {
    categories_allow: ["developer-tools"],
    tags_allow: [],
    repos_allow: [],
    repos_deny: [],
    min_confidence: 0.6,
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
};

describe("PolicySchema", () => {
  it("parses a valid policy", () => {
    const result = PolicySchema.parse(validPolicy);
    expect(result.enabled).toBe(true);
    expect(result.weekly_target_tokens).toBe(500000);
  });

  it("rejects target <= reserve", () => {
    expect(() =>
      PolicySchema.parse({
        ...validPolicy,
        weekly_target_tokens: 100,
        weekly_min_reserve_tokens: 200,
      }),
    ).toThrow("weekly_target_tokens must exceed weekly_min_reserve_tokens");
  });

  it("rejects max_tokens_per_run > weekly_target", () => {
    expect(() =>
      PolicySchema.parse({
        ...validPolicy,
        limits: { ...validPolicy.limits, max_tokens_per_run: 999999 },
      }),
    ).toThrow("max_tokens_per_run must not exceed weekly_target_tokens");
  });

  it("rejects invalid schedule time format", () => {
    expect(() =>
      PolicySchema.parse({
        ...validPolicy,
        schedule: [{ day: "MON", start: "9am", end: "23:59" }],
      }),
    ).toThrow();
  });

  it("rejects invalid day", () => {
    expect(() =>
      PolicySchema.parse({
        ...validPolicy,
        schedule: [{ day: "FRIDAY", start: "09:00", end: "23:59" }],
      }),
    ).toThrow();
  });

  it("requires at least one schedule window", () => {
    expect(() =>
      PolicySchema.parse({ ...validPolicy, schedule: [] }),
    ).toThrow();
  });
});
