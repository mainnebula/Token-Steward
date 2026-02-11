import type { Candidate, Policy } from "./models.js";

/**
 * RICE-style scoring engine with GitHub-enriched signals.
 *
 * Dimensions (each 0-1, then weighted):
 *   Reach     (0.20) - community demand: reactions, comments, repo stars
 *   Impact    (0.25) - severity signal: bug vs feature, maintainer engagement
 *   Confidence(0.30) - likelihood of success: approachability labels, clear title, LLM receptivity
 *   Effort    (0.25) - inverse effort: token fit, issue age (fresh = less stale context)
 */

const WEIGHTS = {
  reach: 0.20,
  impact: 0.25,
  confidence: 0.30,
  effort: 0.25,
};

export function scoreCandidate(
  candidate: Candidate,
  policy: Policy,
  remainingBudgetPerSlot: number,
): Candidate {
  const reach = scoreReach(candidate);
  const impact = scoreImpact(candidate);
  const confidence = scoreConfidence(candidate);
  const effort = scoreEffort(candidate, policy, remainingBudgetPerSlot);

  const raw =
    WEIGHTS.reach * reach +
    WEIGHTS.impact * impact +
    WEIGHTS.confidence * confidence +
    WEIGHTS.effort * effort;

  const score = Math.min(1, Math.round(raw * 100) / 100);

  // Estimate tokens
  const estTokens = estimateTokens(candidate, policy);

  return { ...candidate, score, est_tokens: estTokens };
}

/**
 * Reach: How many people care about this issue?
 */
function scoreReach(c: Candidate): number {
  let score = 0.3; // baseline

  // Reactions (thumbs up, heart, etc.) — strong demand signal
  if (c.reaction_count >= 1) score += 0.1;
  if (c.reaction_count >= 5) score += 0.15;
  if (c.reaction_count >= 20) score += 0.15;

  // Comments indicate discussion / interest
  if (c.comment_count >= 2) score += 0.1;
  if (c.comment_count >= 5) score += 0.1;

  // Repo stars as reach proxy (log scale)
  if (c.repo_stars >= 1000) score += 0.05;
  if (c.repo_stars >= 10000) score += 0.05;

  return Math.min(1, score);
}

/**
 * Impact: How valuable is solving this?
 */
function scoreImpact(c: Candidate): number {
  let score = 0.4; // baseline

  // Bugs > features (fixing broken things has immediate user impact)
  if (c.is_bug) score += 0.2;

  // Maintainer has commented = they care about this issue
  if (c.has_maintainer_comment) score += 0.15;

  // Documentation/security categories have outsized per-effort impact
  if (c.category === "documentation") score += 0.1;
  if (c.category === "security") score += 0.15;

  return Math.min(1, score);
}

/**
 * Confidence: How likely is an LLM to produce an accepted contribution?
 */
function scoreConfidence(c: Candidate): number {
  let score = 0.3; // baseline

  // LLM receptivity from repo-level signals
  score += c.llm_receptivity * 0.3;

  // Clear, descriptive title = better prompt for the LLM
  if (c.issue_title.length > 15) score += 0.05;
  if (c.issue_title.length > 40) score += 0.05;

  // Approachability labels = scoped work, higher success rate
  const approachable = [
    "good first issue", "good-first-issue", "help wanted", "help-wanted",
    "beginner-friendly", "easy", "small", "documentation", "docs",
    "enhancement",
  ];
  if (c.issue_labels.some((l) => approachable.includes(l.toLowerCase()))) {
    score += 0.15;
  }

  // Repo has CONTRIBUTING.md = clear expectations
  if (c.repo_has_contributing) score += 0.05;

  // Repo has CI = automated verification of the contribution
  if (c.repo_has_ci) score += 0.1;

  return Math.min(1, score);
}

/**
 * Effort: Inverse of expected difficulty (higher = easier = better).
 */
function scoreEffort(
  c: Candidate,
  policy: Policy,
  remainingBudgetPerSlot: number,
): number {
  let score = 0.5; // baseline

  // Fresh issues (< 30 days) have less stale context
  if (c.age_days < 7) score += 0.15;
  else if (c.age_days < 30) score += 0.1;
  else if (c.age_days > 180) score -= 0.1; // very old = likely complex or stuck

  // Small/easy labels
  if (c.issue_labels.some((l) => /\bsmall\b|easy|trivial|minor/i.test(l))) {
    score += 0.15;
  }
  // Large/complex labels
  if (c.issue_labels.some((l) => /\blarge\b|complex|major|epic/i.test(l))) {
    score -= 0.15;
  }

  // Token fit: prefer tasks that fit within budget per slot
  const estTokens = estimateTokens(c, policy);
  if (remainingBudgetPerSlot > 0) {
    const fitRatio = estTokens / remainingBudgetPerSlot;
    if (fitRatio <= 1) score += 0.1; // fits in budget
    if (fitRatio <= 0.5) score += 0.05; // comfortably fits
  }

  return Math.max(0, Math.min(1, score));
}

function estimateTokens(c: Candidate, policy: Policy): number {
  let factor = 0.5; // default: medium complexity
  if (c.issue_labels.some((l) => /\bsmall\b|easy|trivial|docs\b|documentation/i.test(l))) {
    factor = 0.25;
  }
  if (c.issue_labels.some((l) => /\blarge\b|complex|major|epic/i.test(l))) {
    factor = 0.8;
  }
  return Math.round(policy.limits.max_tokens_per_run * factor);
}

/**
 * Score and rank all candidates. Filter by min_confidence.
 */
export function rankCandidates(
  candidates: Candidate[],
  policy: Policy,
  remainingBudget: number,
  availableSlots: number,
): Candidate[] {
  const budgetPerSlot =
    availableSlots > 0 ? remainingBudget / availableSlots : remainingBudget;

  const scored = candidates
    .map((c) => scoreCandidate(c, policy, budgetPerSlot))
    .filter((c) => c.score >= policy.filters.min_confidence)
    .sort((a, b) => b.score - a.score);

  return diversify(scored);
}

function diversify(candidates: Candidate[]): Candidate[] {
  if (candidates.length <= 1) return candidates;

  const result: Candidate[] = [];
  const seenRepos = new Set<string>();

  // First pass: one per repo (highest scored)
  for (const c of candidates) {
    if (!seenRepos.has(c.repo_slug)) {
      result.push(c);
      seenRepos.add(c.repo_slug);
    }
  }

  // Second pass: fill remaining
  for (const c of candidates) {
    if (!result.includes(c)) {
      result.push(c);
    }
  }

  return result;
}
