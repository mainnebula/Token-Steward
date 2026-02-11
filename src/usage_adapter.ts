import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb, withDbWriteRetry } from "./db.js";
import { emitEvent } from "./audit_log.js";
import type { UsageSnapshot } from "./models.js";

const OAUTH_API_URL = "https://api.anthropic.com/api/oauth/usage";
const STATS_CACHE_PATH = join(homedir(), ".claude", "stats-cache.json");

interface OAuthCredentials {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
}

/**
 * Retrieve the OAuth access token from macOS keychain.
 */
function getOAuthToken(): string | null {
  try {
    const result = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: "utf-8", timeout: 5000 },
    ).trim();

    // The keychain value may be a JSON object or a raw token
    try {
      const parsed: OAuthCredentials = JSON.parse(result);
      return parsed.accessToken || parsed.access_token || null;
    } catch {
      // Might be the raw token string
      if (result.length > 20) return result;
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Primary: Call the OAuth usage API endpoint.
 */
async function pollOAuthUsage(): Promise<UsageSnapshot | null> {
  const token = getOAuthToken();
  if (!token) return null;

  try {
    const resp = await fetch(OAUTH_API_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      emitEvent("usage_error", {
        source: "oauth_api",
        status: resp.status,
        statusText: resp.statusText,
      });
      return null;
    }

    const data = await resp.json();

    // Log response shape (keys only — never log values that could contain tokens)
    emitEvent("usage_poll", {
      source: "oauth_api_raw",
      keys: Object.keys(data),
    });

    // Adapt whatever shape the API returns — probe common field name patterns
    const tokensUsed = firstNumber(data, [
      "tokens_used", "usage", "tokenUsage", "used",
      "totalTokensUsed", "total_tokens_used",
    ]);
    const tokensQuota = firstNumber(data, [
      "tokens_quota", "quota", "limit", "tokenLimit",
      "totalTokensQuota", "total_tokens_quota", "allowance",
    ]);
    const tokensRemaining = firstNumber(data, [
      "tokens_remaining", "remaining", "tokensRemaining",
      "total_tokens_remaining",
    ]);
    const periodStart = firstString(data, [
      "period_start", "periodStart", "billing_period_start",
      "billingPeriodStart", "start",
    ]);
    const periodEnd = firstString(data, [
      "period_end", "periodEnd", "billing_period_end",
      "billingPeriodEnd", "end",
    ]);

    // We need at least tokens_used to be useful
    if (tokensUsed === null) {
      emitEvent("usage_error", {
        source: "oauth_api",
        reason: "unrecognized_response_shape",
        keys: Object.keys(data),
      });
      return null;
    }

    const snapshot: UsageSnapshot = {
      timestamp: new Date().toISOString(),
      tokens_used: tokensUsed,
      tokens_quota: tokensQuota ?? 0,
      tokens_remaining:
        tokensRemaining ?? (tokensQuota != null ? tokensQuota - tokensUsed : 0),
      period_start: periodStart ?? "",
      period_end: periodEnd ?? "",
      source: "oauth_api",
    };

    return snapshot;
  } catch (err) {
    emitEvent("usage_error", {
      source: "oauth_api",
      error: String(err),
    });
    return null;
  }
}

/**
 * Fallback: Derive usage from the local stats-cache.json.
 * This only has output tokens tracked locally, so it's an approximation.
 * We use it as a delta tracker rather than absolute quota source.
 */
function pollStatsCache(): UsageSnapshot | null {
  if (!existsSync(STATS_CACHE_PATH)) return null;

  try {
    const raw = readFileSync(STATS_CACHE_PATH, "utf-8");
    const stats = JSON.parse(raw);

    // Sum all model usage tokens
    let totalOutput = 0;
    let totalInput = 0;
    if (stats.modelUsage) {
      for (const model of Object.values(stats.modelUsage) as any[]) {
        totalOutput += model.outputTokens ?? 0;
        totalInput += model.inputTokens ?? 0;
      }
    }

    // Sum this week's daily tokens
    const now = new Date();
    const weekStart = getWeekStart(now);
    let weekTokens = 0;

    if (stats.dailyModelTokens) {
      for (const day of stats.dailyModelTokens) {
        if (new Date(day.date) >= weekStart) {
          for (const count of Object.values(day.tokensByModel) as number[]) {
            weekTokens += count;
          }
        }
      }
    }

    return {
      timestamp: new Date().toISOString(),
      tokens_used: weekTokens,
      tokens_quota: 0, // Unknown from local stats
      tokens_remaining: 0, // Unknown
      period_start: weekStart.toISOString(),
      period_end: getWeekEnd(now).toISOString(),
      source: "stats_cache",
    };
  } catch {
    return null;
  }
}

function getWeekStart(now: Date): Date {
  const d = new Date(now);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? 6 : day - 1; // Start on Monday
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekEnd(now: Date): Date {
  const d = new Date(now);
  const day = d.getDay();
  const daysUntilSunday = day === 0 ? 0 : 7 - day;
  d.setDate(d.getDate() + daysUntilSunday);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Inject a manual usage snapshot (for when quota is known out-of-band).
 */
export function injectManualUsage(
  tokensRemaining: number,
  weeklyQuota: number,
): UsageSnapshot {
  const now = new Date();
  const snapshot: UsageSnapshot = {
    timestamp: now.toISOString(),
    tokens_used: weeklyQuota - tokensRemaining,
    tokens_quota: weeklyQuota,
    tokens_remaining: tokensRemaining,
    period_start: getWeekStart(now).toISOString(),
    period_end: getWeekEnd(now).toISOString(),
    source: "manual",
  };
  storeSnapshot(snapshot);
  return snapshot;
}

/**
 * Poll usage with fallback chain. Stores snapshot in DB.
 * Returns null on complete failure (triggers guardrail pause).
 */
export async function pollUsage(): Promise<UsageSnapshot | null> {
  // Try OAuth API first
  let snapshot = await pollOAuthUsage();

  // Fallback to stats cache
  if (!snapshot) {
    snapshot = pollStatsCache();
  }

  if (!snapshot) {
    emitEvent("usage_error", { reason: "all_sources_failed" });
    return null;
  }

  storeSnapshot(snapshot);
  return snapshot;
}

function storeSnapshot(snapshot: UsageSnapshot): void {
  const db = getDb();
  withDbWriteRetry(() => {
    db.prepare(`
      INSERT INTO usage_snapshots
        (timestamp, tokens_used, tokens_quota, tokens_remaining, period_start, period_end, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.timestamp,
      snapshot.tokens_used,
      snapshot.tokens_quota,
      snapshot.tokens_remaining,
      snapshot.period_start,
      snapshot.period_end,
      snapshot.source,
    );
  });

  emitEvent("usage_poll", {
    source: snapshot.source,
    tokens_used: snapshot.tokens_used,
    tokens_remaining: snapshot.tokens_remaining,
  });
}

/**
 * Get the most recent usage snapshot from DB.
 */
export function getLatestUsage(): UsageSnapshot | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM usage_snapshots ORDER BY timestamp DESC LIMIT 1")
    .get() as any;
  if (!row) return null;
  return {
    timestamp: row.timestamp,
    tokens_used: row.tokens_used,
    tokens_quota: row.tokens_quota,
    tokens_remaining: row.tokens_remaining,
    period_start: row.period_start,
    period_end: row.period_end,
    source: row.source,
  };
}

/**
 * Check if usage data is stale.
 */
export function isUsageStale(maxMinutes: number): boolean {
  const latest = getLatestUsage();
  if (!latest) return true;
  // Manual injections are trusted for the session
  if (latest.source === "manual") return false;
  const age = Date.now() - new Date(latest.timestamp).getTime();
  return age > maxMinutes * 60 * 1000;
}

// --- Field probing helpers ---

function firstNumber(
  data: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "number") return v;
  }
  return null;
}

function firstString(
  data: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}
