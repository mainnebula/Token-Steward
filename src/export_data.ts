import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadPolicy, getRemainingBudget } from "./policy_store.js";
import { syncRegistry, getActiveRepos } from "./registry_sync.js";
import { discoverCandidates } from "./issue_discovery.js";
import { rankCandidates } from "./scoring_engine.js";
import { getLatestUsage } from "./usage_adapter.js";
import type { RegistryRepo, Candidate } from "./models.js";

export interface ExportedRepo {
  slug: string;
  name: string;
  description: string;
  url: string;
  category: string;
  tags: string[];
  issue_labels: string[];
  featured: boolean;
}

export interface ScoreBreakdown {
  reach: number;
  impact: number;
  confidence: number;
  effort: number;
}

export interface ExportedIssue {
  repo_slug: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  issue_labels: string[];
  category: string;
  tags: string[];
  score: number;
  score_breakdown: ScoreBreakdown;
  est_tokens: number;
  age_days: number;
  is_bug: boolean;
  reaction_count: number;
  comment_count: number;
}

/**
 * Compute a RICE score breakdown for display purposes.
 * Mirrors the logic in scoring_engine.ts but returns individual dimensions.
 */
function computeBreakdown(c: Candidate): ScoreBreakdown {
  // Reach
  let reach = 0.3;
  if (c.reaction_count >= 1) reach += 0.1;
  if (c.reaction_count >= 5) reach += 0.15;
  if (c.reaction_count >= 20) reach += 0.15;
  if (c.comment_count >= 2) reach += 0.1;
  if (c.comment_count >= 5) reach += 0.1;
  if (c.repo_stars >= 1000) reach += 0.05;
  if (c.repo_stars >= 10000) reach += 0.05;
  reach = Math.min(1, reach);

  // Impact
  let impact = 0.4;
  if (c.is_bug) impact += 0.2;
  if (c.has_maintainer_comment) impact += 0.15;
  if (c.category === "documentation") impact += 0.1;
  if (c.category === "security") impact += 0.15;
  impact = Math.min(1, impact);

  // Confidence
  let confidence = 0.3;
  confidence += c.llm_receptivity * 0.3;
  if (c.issue_title.length > 15) confidence += 0.05;
  if (c.issue_title.length > 40) confidence += 0.05;
  const approachable = [
    "good first issue", "good-first-issue", "help wanted", "help-wanted",
    "beginner-friendly", "easy", "small", "documentation", "docs", "enhancement",
  ];
  if (c.issue_labels.some((l) => approachable.includes(l.toLowerCase()))) {
    confidence += 0.15;
  }
  if (c.repo_has_contributing) confidence += 0.05;
  if (c.repo_has_ci) confidence += 0.1;
  confidence = Math.min(1, confidence);

  // Effort
  let effort = 0.5;
  if (c.age_days < 7) effort += 0.15;
  else if (c.age_days < 30) effort += 0.1;
  else if (c.age_days > 180) effort -= 0.1;
  if (c.issue_labels.some((l) => /\bsmall\b|easy|trivial|minor/i.test(l))) effort += 0.15;
  if (c.issue_labels.some((l) => /\blarge\b|complex|major|epic/i.test(l))) effort -= 0.15;
  effort = Math.max(0, Math.min(1, effort));

  return {
    reach: Math.round(reach * 100) / 100,
    impact: Math.round(impact * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    effort: Math.round(effort * 100) / 100,
  };
}

function toExportedRepo(repo: RegistryRepo): ExportedRepo {
  return {
    slug: repo.slug,
    name: repo.name,
    description: repo.description,
    url: repo.url ?? `https://github.com/${repo.slug}`,
    category: repo.category,
    tags: repo.tags,
    issue_labels: repo.issue_labels,
    featured: repo.featured,
  };
}

function toExportedIssue(c: Candidate): ExportedIssue {
  return {
    repo_slug: c.repo_slug,
    issue_number: c.issue_number,
    issue_title: c.issue_title,
    issue_url: c.issue_url,
    issue_labels: c.issue_labels,
    category: c.category,
    tags: c.tags,
    score: c.score,
    score_breakdown: computeBreakdown(c),
    est_tokens: c.est_tokens,
    age_days: c.age_days,
    is_bug: c.is_bug,
    reaction_count: c.reaction_count,
    comment_count: c.comment_count,
  };
}

export interface ExportResult {
  registry: ExportedRepo[];
  scoredIssues: ExportedIssue[];
}

/**
 * Run the full export pipeline: sync registry, discover issues, score, and return structured data.
 */
export async function runExport(): Promise<ExportResult> {
  const policy = loadPolicy();
  const registrySnapshot = await syncRegistry();
  if (!registrySnapshot) {
    throw new Error("Failed to load registry");
  }

  const activeRepos = getActiveRepos(registrySnapshot, policy.filters);
  const candidates = await discoverCandidates(activeRepos);

  const usage = getLatestUsage();
  const remainingBudget = usage
    ? getRemainingBudget(policy, usage.tokens_used)
    : policy.weekly_target_tokens - policy.weekly_min_reserve_tokens;

  const ranked = rankCandidates(candidates, policy, remainingBudget, policy.limits.max_concurrency);

  return {
    registry: activeRepos.map(toExportedRepo),
    scoredIssues: ranked.map(toExportedIssue),
  };
}

/**
 * Write export data to files in the given directory.
 */
export function writeExportFiles(result: ExportResult, outDir: string): void {
  mkdirSync(outDir, { recursive: true });

  const registryOut = {
    generated_at: new Date().toISOString(),
    repo_count: result.registry.length,
    repositories: result.registry,
  };

  const issuesOut = {
    generated_at: new Date().toISOString(),
    issue_count: result.scoredIssues.length,
    issues: result.scoredIssues,
  };

  writeFileSync(join(outDir, "registry.json"), JSON.stringify(registryOut, null, 2) + "\n");
  writeFileSync(join(outDir, "scored-issues.json"), JSON.stringify(issuesOut, null, 2) + "\n");
}
