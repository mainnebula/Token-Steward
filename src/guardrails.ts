import { getGuardrailData, updateGuardrailState, incrementCiFailures, resetCiFailures, getRuns } from "./store.js";
import { emitEvent, getLogger } from "./audit_log.js";
import { isUsageStale } from "./usage_adapter.js";
import type { Policy, GuardrailState } from "./models.js";

export function getGuardrailState(): GuardrailState {
  const data = getGuardrailData();
  const recentRuns = getRuns({
    statuses: ["succeeded", "failed"],
    orderBy: "finished_at_desc",
    limit: 10,
  });

  return {
    paused: data.paused,
    pause_reason: data.pause_reason,
    consecutive_ci_failures: data.consecutive_ci_failures,
    recent_run_results: recentRuns.map((r) => ({
      succeeded: r.status === "succeeded",
      finished_at: r.finished_at!,
    })),
    last_usage_poll: data.last_usage_poll,
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
  if (succeeded) {
    resetCiFailures();
  } else {
    incrementCiFailures();
  }
}

export function pauseAutopilot(reason: string): void {
  updateGuardrailState({ paused: true, pause_reason: reason });
  emitEvent("autopilot_paused", { reason });
}

export function resumeAutopilot(): void {
  updateGuardrailState({ paused: false, pause_reason: null, consecutive_ci_failures: 0 });
  emitEvent("autopilot_resumed", {});
}
