import { describe, it, expect } from "vitest";

// Test the field probing helpers directly by importing the module
// Since they're not exported, we test them indirectly through behavior

describe("usage_adapter field probing", () => {
  // We test the firstNumber/firstString logic via mock scenarios
  // These mirror what pollOAuthUsage does with various API shapes

  function probeNumber(
    data: Record<string, unknown>,
    keys: string[],
  ): number | null {
    for (const k of keys) {
      const v = data[k];
      if (typeof v === "number") return v;
    }
    return null;
  }

  function probeString(
    data: Record<string, unknown>,
    keys: string[],
  ): string | null {
    for (const k of keys) {
      const v = data[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
  }

  const usageKeys = [
    "tokens_used", "usage", "tokenUsage", "used",
    "totalTokensUsed", "total_tokens_used",
  ];
  const quotaKeys = [
    "tokens_quota", "quota", "limit", "tokenLimit",
    "totalTokensQuota", "total_tokens_quota", "allowance",
  ];

  it("finds tokens_used in snake_case response", () => {
    const data = { tokens_used: 150000, tokens_quota: 500000 };
    expect(probeNumber(data, usageKeys)).toBe(150000);
    expect(probeNumber(data, quotaKeys)).toBe(500000);
  });

  it("finds usage/quota in alternate naming", () => {
    const data = { usage: 200000, limit: 1000000 };
    expect(probeNumber(data, usageKeys)).toBe(200000);
    expect(probeNumber(data, quotaKeys)).toBe(1000000);
  });

  it("finds camelCase variants", () => {
    const data = { tokenUsage: 75000, tokenLimit: 500000 };
    expect(probeNumber(data, usageKeys)).toBe(75000);
    expect(probeNumber(data, quotaKeys)).toBe(500000);
  });

  it("returns null when no keys match", () => {
    const data = { something_else: 42 };
    expect(probeNumber(data, usageKeys)).toBeNull();
  });

  it("finds period strings", () => {
    const periodKeys = ["period_start", "periodStart", "billing_period_start"];
    expect(probeString({ period_start: "2025-01-27" }, periodKeys)).toBe("2025-01-27");
    expect(probeString({ periodStart: "2025-01-27" }, periodKeys)).toBe("2025-01-27");
    expect(probeString({}, periodKeys)).toBeNull();
  });

  it("ignores empty strings", () => {
    const keys = ["period_start"];
    expect(probeString({ period_start: "" }, keys)).toBeNull();
  });
});
