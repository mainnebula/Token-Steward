import { z } from "zod";

// --- Policy schema ---

const DayEnum = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

const ScheduleWindow = z.object({
  day: DayEnum,
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

export const PolicySchema = z
  .object({
    enabled: z.boolean(),
    timezone: z.string(),
    weekly_target_tokens: z.number().positive(),
    weekly_min_reserve_tokens: z.number().nonnegative(),
    schedule: z.array(ScheduleWindow).min(1),
    filters: z.object({
      categories_allow: z.array(z.string()),
      tags_allow: z.array(z.string()),
      repos_allow: z.array(z.string()),
      repos_deny: z.array(z.string()),
      min_confidence: z.number().min(0).max(1),
    }),
    limits: z.object({
      max_concurrency: z.number().int().positive(),
      max_tokens_per_run: z.number().positive(),
      max_runs_per_day: z.number().int().positive(),
    }),
    safety: z.object({
      pause_on_ci_failures_consecutive: z.number().int().positive(),
      pause_on_failure_rate_percent: z.number().min(0).max(100),
      max_stale_usage_minutes: z.number().positive(),
    }),
  })
  .refine((p) => p.weekly_target_tokens > p.weekly_min_reserve_tokens, {
    message: "weekly_target_tokens must exceed weekly_min_reserve_tokens",
  })
  .refine((p) => p.limits.max_tokens_per_run <= p.weekly_target_tokens, {
    message: "max_tokens_per_run must not exceed weekly_target_tokens",
  });

export type Policy = z.infer<typeof PolicySchema>;
export type ScheduleWindowType = z.infer<typeof ScheduleWindow>;

// --- Usage data ---

export interface UsageSnapshot {
  timestamp: string;
  tokens_used: number;
  tokens_quota: number;
  tokens_remaining: number;
  period_start: string;
  period_end: string;
  source: "oauth_api" | "stats_cache" | "manual";
}

// --- Registry ---

export interface RegistryRepo {
  slug: string;
  name: string;
  description: string;
  url: string;
  category: string;
  tags: string[];
  issue_labels: string[];
  maintainer: { name: string; url: string };
  isActive: boolean;
  featured: boolean;
  addedAt: string;
}

export interface RegistrySnapshot {
  schemaVersion: string;
  lastUpdated: string;
  repositories: RegistryRepo[];
  fetchedAt: string;
}

// --- Candidate ---

export interface Candidate {
  repo_slug: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  issue_labels: string[];
  category: string;
  tags: string[];
  score: number;
  est_tokens: number;
  discovered_at: string;
  // GitHub-enriched signals (populated during discovery)
  comment_count: number;
  reaction_count: number;
  has_maintainer_comment: boolean;
  age_days: number;
  is_bug: boolean;
  repo_stars: number;
  repo_has_contributing: boolean;
  repo_has_ci: boolean;
  llm_receptivity: number; // 0-1 score for how likely the repo accepts AI contributions
}

// --- Run ---

export type RunStatus =
  | "queued"
  | "running"
  | "in_progress"
  | "succeeded"
  | "no_changes"
  | "failed"
  | "canceled";

export interface Run {
  id: string;
  candidate_repo: string;
  candidate_issue: number;
  issue_url: string;
  branch: string;
  status: RunStatus;
  tokens_consumed: number;
  pr_url: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

// --- Audit event ---

export interface AuditEvent {
  timestamp: string;
  event:
    | "usage_poll"
    | "usage_error"
    | "registry_sync"
    | "candidate_scored"
    | "run_queued"
    | "run_started"
    | "run_succeeded"
    | "run_no_changes"
    | "run_failed"
    | "run_canceled"
    | "guardrail_triggered"
    | "autopilot_paused"
    | "autopilot_resumed"
    | "scheduler_tick";
  data: Record<string, unknown>;
}

// --- Guardrail state ---

export interface GuardrailState {
  paused: boolean;
  pause_reason: string | null;
  consecutive_ci_failures: number;
  recent_run_results: Array<{ succeeded: boolean; finished_at: string }>;
  last_usage_poll: string | null;
}
