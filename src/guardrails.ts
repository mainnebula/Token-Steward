import { getDb, withDbWriteRetry } from "./db.js";
import { emitEvent, getLogger } from "./audit_log.js";
import { isUsageStale } from "./usage_adapter.js";
import type { Policy, GuardrailState } from "./models.js";

export function getGuardrailState(): GuardrailState {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM guardrail_state WHERE id = 1")
    .get() as any;

  // Calculate recent run results
  const recentRuns = db
    .prepare(
      `SELECT status, finished_at FROM runs
       WHERE finished_at IS NOT NULL
         AND status IN ('succeeded', 'failed')
       ORDER BY finished_at DESC LIMIT 10`,
    )
    .all() as Array<{ status: string; finished_at: string }>;

  return {
    paused: !!row.paused,
    pause_reason: row.pause_reason,
    consecutive_ci_failures: row.consecutive_ci_failures,
    recent_run_results: recentRuns.map((r) => ({
      succeeded: r.status === "succeeded",
      finished_at: r.finished_at,
    })),
    last_usage_poll: row.last_usage_poll,
  };
}

/**
 * Check all guardrails and return whether autopilot should be paused.
 * If a guardrail triggers, automatically pause and return the reason.
 */
export function checkGuardrails(policy: Policy): {
  healthy: boolean;
  reason: string | null;
} {
  const log = getLogger();
  const state = getGuardrailState();
  if (state.paused) {
    return { healthy: false, reason: state.pause_reason ?? "manually_paused" };
  }

  const evaluation = evaluateGuardrails(policy);
  if (evaluation.healthy) return evaluation;

  if (evaluation.reason) {
    if (evaluation.reason === "stale_usage_data") {
      log.warn("Usage data is stale, pausing autopilot");
    }
    pauseAutopilot(evaluation.reason);
    emitEvent("guardrail_triggered", { reason: evaluation.reason });
  }

  return evaluation;
}

export function evaluateGuardrails(policy: Policy): {
  healthy: boolean;
  reason: string | null;
} {
  const state = getGuardrailState();

  // Check consecutive CI failures
  if (
    state.consecutive_ci_failures >=
    policy.safety.pause_on_ci_failures_consecutive
  ) {
    const reason = `consecutive_ci_failures: ${state.consecutive_ci_failures}`;
    return { healthy: false, reason };
  }

  // Check failure rate over last 6 runs
  const last6 = state.recent_run_results.slice(0, 6);
  if (last6.length >= 3) {
    const failCount = last6.filter((r) => !r.succeeded).length;
    const failRate = (failCount / last6.length) * 100;
    if (failRate > policy.safety.pause_on_failure_rate_percent) {
      const reason = `failure_rate: ${failRate.toFixed(0)}% over last ${last6.length} runs`;
      return { healthy: false, reason };
    }
  }

  // Check usage data staleness
  if (isUsageStale(policy.safety.max_stale_usage_minutes)) {
    return { healthy: false, reason: "stale_usage_data" };
  }

  return { healthy: true, reason: null };
}

/**
 * Record a run result for guardrail tracking.
 */
export function recordRunResult(succeeded: boolean): void {
  const db = getDb();
  withDbWriteRetry(() => {
    if (succeeded) {
      db.prepare(
        "UPDATE guardrail_state SET consecutive_ci_failures = 0 WHERE id = 1",
      ).run();
    } else {
      db.prepare(
        "UPDATE guardrail_state SET consecutive_ci_failures = consecutive_ci_failures + 1 WHERE id = 1",
      ).run();
    }
  });
}

export function pauseAutopilot(reason: string): void {
  const db = getDb();
  withDbWriteRetry(() => {
    db.prepare(
      "UPDATE guardrail_state SET paused = 1, pause_reason = ? WHERE id = 1",
    ).run(reason);
  });
  emitEvent("autopilot_paused", { reason });
}

export function resumeAutopilot(): void {
  const db = getDb();
  withDbWriteRetry(() => {
    db.prepare(
      "UPDATE guardrail_state SET paused = 0, pause_reason = NULL, consecutive_ci_failures = 0 WHERE id = 1",
    ).run();
  });
  emitEvent("autopilot_resumed", {});
}
