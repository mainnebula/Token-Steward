import cron from "node-cron";
import { getPolicy, isInsideScheduleWindow, getRemainingBudget, getHoursLeft, getRequiredBurnRate } from "./policy_store.js";
import { pollUsage, getLatestUsage } from "./usage_adapter.js";
import { syncRegistry, getActiveRepos } from "./registry_sync.js";
import { discoverCandidates } from "./issue_discovery.js";
import { rankCandidates } from "./scoring_engine.js";
import { queueRun, executeRun, getActiveRuns, getTodayRunCount } from "./run_orchestrator.js";
import { checkGuardrails, evaluateGuardrails, getGuardrailState, recordRunResult } from "./guardrails.js";
import { emitEvent, getLogger } from "./audit_log.js";

let running = false;
let tickInProgress = false;

/**
 * Main control loop tick. Runs every 15 minutes.
 */
export async function tick(dryRun = false): Promise<void> {
  if (tickInProgress) {
    getLogger().warn("Tick already in progress, skipping");
    return;
  }

  tickInProgress = true;
  const log = getLogger();
  try {
    const policy = getPolicy();

    emitEvent("scheduler_tick", { dry_run: dryRun });

    // 1. Check policy enabled
    if (!policy.enabled) {
      log.info("Policy disabled, skipping tick");
      return;
    }

    // 2. Check schedule window
    if (!isInsideScheduleWindow(policy)) {
      log.info("Outside schedule window, skipping tick");
      return;
    }

    // 3. Check guardrails
    const guardrails = checkGuardrails(policy);
    if (!guardrails.healthy) {
      log.warn({ reason: guardrails.reason }, "Guardrails unhealthy, skipping tick");
      return;
    }

    // 4. Poll usage (use existing snapshot if available, e.g. from manual injection)
    let usage = getLatestUsage();
    if (!usage) {
      usage = await pollUsage();
    }
    if (!usage) {
      log.error("Failed to poll usage, skipping tick");
      return;
    }

    // 5. Calculate budget
    const remainingBudget = getRemainingBudget(policy, usage.tokens_used);
    const hoursLeft = getHoursLeft(policy);
    const burnRate = getRequiredBurnRate(remainingBudget, hoursLeft);

    log.info({
      tokens_used: usage.tokens_used,
      remaining_budget: remainingBudget,
      hours_left: hoursLeft.toFixed(1),
      burn_rate: Math.round(burnRate),
    }, "Burn-down status");

    if (remainingBudget <= 0) {
      log.info("No remaining budget, skipping tick");
      return;
    }

    // 6. Check available run slots
    const activeRuns = getActiveRuns();
    const availableSlots = policy.limits.max_concurrency - activeRuns.length;
    if (availableSlots <= 0) {
      log.info({ active: activeRuns.length }, "No available run slots");
      return;
    }

    // 7. Check daily run limit
    const todayCount = getTodayRunCount();
    if (todayCount >= policy.limits.max_runs_per_day) {
      log.info({ today: todayCount }, "Daily run limit reached");
      return;
    }

    // 8. Sync registry and discover candidates
    const registry = await syncRegistry();
    if (!registry) {
      log.error("Registry unavailable, skipping tick");
      return;
    }

    const activeRepos = getActiveRepos(registry, policy.filters);
    if (activeRepos.length === 0) {
      log.info("No active repos matching filters");
      return;
    }

    const candidates = await discoverCandidates(activeRepos);
    if (candidates.length === 0) {
      log.info("No eligible candidates found");
      return;
    }

    // 9. Score and rank
    const ranked = rankCandidates(candidates, policy, remainingBudget, availableSlots);
    if (ranked.length === 0) {
      log.info("No candidates above confidence threshold");
      return;
    }

    // 10. Launch runs (up to available slots)
    const slotsToFill = Math.min(
      availableSlots,
      policy.limits.max_runs_per_day - todayCount,
      ranked.length,
    );

    for (let i = 0; i < slotsToFill; i++) {
      const candidate = ranked[i];
      log.info({
        repo: candidate.repo_slug,
        issue: candidate.issue_number,
        score: candidate.score,
        est_tokens: candidate.est_tokens,
      }, "Launching run");

      if (dryRun) {
        log.info("[DRY RUN] Would queue run");
        continue;
      }

      const run = queueRun(candidate);

      // Execute asynchronously (don't block the tick)
      executeRun(run, policy)
        .then((result) => {
          if (result.status === "succeeded") {
            recordRunResult(true);
          } else if (result.status === "failed") {
            recordRunResult(false);
          }
        })
        .catch((err) => {
          getLogger().error({ run_id: run.id, error: String(err) }, "Run execution error");
          recordRunResult(false);
        });
    }
  } finally {
    tickInProgress = false;
  }
}

/**
 * Start the scheduler daemon.
 */
export function startScheduler(dryRun = false): void {
  const log = getLogger();

  if (running) {
    log.warn("Scheduler already running");
    return;
  }

  running = true;
  log.info({ dry_run: dryRun }, "Scheduler started (15-minute cycle)");

  // Run immediately on start
  tick(dryRun).catch((err) => log.error({ error: String(err) }, "Tick error"));

  // Then every 15 minutes
  cron.schedule("*/15 * * * *", () => {
    tick(dryRun).catch((err) => log.error({ error: String(err) }, "Tick error"));
  });
}

export function stopScheduler(): void {
  running = false;
  getLogger().info("Scheduler stopped");
}

/**
 * Get current status summary.
 */
export async function getStatus(): Promise<Record<string, unknown>> {
  const policy = getPolicy();
  const usage = getLatestUsage();
  const activeRuns = getActiveRuns();
  const state = getGuardrailState();
  const guardrails = state.paused
    ? { healthy: false, reason: state.pause_reason ?? "manually_paused" }
    : evaluateGuardrails(policy);

  return {
    enabled: policy.enabled,
    in_schedule_window: isInsideScheduleWindow(policy),
    guardrails_healthy: guardrails.healthy,
    pause_reason: guardrails.reason,
    usage: usage
      ? {
          tokens_used: usage.tokens_used,
          tokens_quota: usage.tokens_quota,
          tokens_remaining: usage.tokens_remaining,
          source: usage.source,
          last_poll: usage.timestamp,
        }
      : null,
    budget: usage
      ? {
          remaining: getRemainingBudget(policy, usage.tokens_used),
          hours_left: getHoursLeft(policy).toFixed(1),
          burn_rate: Math.round(
            getRequiredBurnRate(
              getRemainingBudget(policy, usage.tokens_used),
              getHoursLeft(policy),
            ),
          ),
        }
      : null,
    active_runs: activeRuns.length,
    today_runs: getTodayRunCount(),
    limits: {
      max_concurrency: policy.limits.max_concurrency,
      max_runs_per_day: policy.limits.max_runs_per_day,
    },
  };
}
