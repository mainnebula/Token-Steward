import { execSync } from "node:child_process";
import { getDb } from "./db.js";
import { getLogger } from "./audit_log.js";
import type { Candidate, RegistryRepo } from "./models.js";

interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
  comments: Array<unknown>;
  reactionGroups: Array<{ content: string; users: { totalCount: number } }>;
  createdAt: string;
}

interface RepoMeta {
  stars: number;
  hasContributing: boolean;
  hasCi: boolean;
  llmReceptivity: number;
}

const repoMetaCache = new Map<string, RepoMeta>();

/**
 * Discover open issues from active registry repos.
 * Enriches candidates with GitHub signals for smarter scoring.
 */
export async function discoverCandidates(
  repos: RegistryRepo[],
): Promise<Candidate[]> {
  const log = getLogger();
  const candidates: Candidate[] = [];
  const claimedIssues = getClaimedIssues();

  for (const repo of repos) {
    try {
      const labels = repo.issue_labels ?? ["good first issue", "help wanted"];
      const issues = listIssues(repo.slug, labels);
      const meta = getRepoMeta(repo.slug, repo.category);

      for (const issue of issues) {
        const key = `${repo.slug}#${issue.number}`;
        if (claimedIssues.has(key)) continue;

        const labelNames = issue.labels.map((l) => l.name);
        const totalReactions = (issue.reactionGroups ?? [])
          .reduce((sum, g) => sum + (g.users?.totalCount ?? 0), 0);
        const commentCount = Array.isArray(issue.comments) ? issue.comments.length : 0;
        const ageDays = Math.floor(
          (Date.now() - new Date(issue.createdAt).getTime()) / (1000 * 60 * 60 * 24),
        );
        const isBug = labelNames.some((l) =>
          /\bbug\b|defect|broken|regression|fix/i.test(l),
        );
        // Approximate: issues with 3+ comments likely have maintainer engagement
        const hasMaintainerComment = commentCount >= 3;

        candidates.push({
          repo_slug: repo.slug,
          issue_number: issue.number,
          issue_title: issue.title,
          issue_url: issue.url,
          issue_labels: labelNames,
          category: repo.category,
          tags: repo.tags,
          score: 0,
          est_tokens: 0,
          discovered_at: new Date().toISOString(),
          comment_count: commentCount,
          reaction_count: totalReactions,
          has_maintainer_comment: hasMaintainerComment,
          age_days: ageDays,
          is_bug: isBug,
          repo_stars: meta.stars,
          repo_has_contributing: meta.hasContributing,
          repo_has_ci: meta.hasCi,
          llm_receptivity: meta.llmReceptivity,
        });
      }
    } catch (err) {
      log.warn({ repo: repo.slug, error: String(err) }, "Issue discovery failed for repo");
    }
  }

  return candidates;
}

/**
 * List open issues matching any of the given labels with enriched fields.
 */
function listIssues(repoSlug: string, labels: string[]): GitHubIssue[] {
  const seen = new Set<number>();
  const results: GitHubIssue[] = [];

  for (const label of labels) {
    try {
      const result = execSync(
        `gh issue list --repo "${repoSlug}" --label "${label}" --state open --json number,title,url,labels,comments,reactionGroups,createdAt --limit 10`,
        { encoding: "utf-8", timeout: 15000 },
      );
      const issues: GitHubIssue[] = JSON.parse(result);
      for (const issue of issues) {
        if (!seen.has(issue.number)) {
          seen.add(issue.number);
          results.push(issue);
        }
      }
    } catch {
      // Label might not exist on this repo — that's fine
    }
  }

  return results;
}

/**
 * Fetch repo-level metadata (cached per session).
 */
function getRepoMeta(slug: string, category: string): RepoMeta {
  if (repoMetaCache.has(slug)) return repoMetaCache.get(slug)!;

  let stars = 0;
  let hasContributing = false;
  let hasCi = false;

  try {
    const repoJson = execSync(
      `gh repo view "${slug}" --json stargazerCount,hasWikiEnabled --jq '{stars: .stargazerCount}'`,
      { encoding: "utf-8", timeout: 10000 },
    );
    const parsed = JSON.parse(repoJson);
    stars = parsed.stars ?? 0;
  } catch {}

  // Check for CONTRIBUTING.md (signals structured contribution process)
  try {
    execSync(
      `gh api "repos/${slug}/contents/CONTRIBUTING.md" --silent`,
      { timeout: 8000, stdio: "ignore" },
    );
    hasContributing = true;
  } catch {}

  // Check for CI (signals automation-friendly culture)
  try {
    const workflows = execSync(
      `gh api "repos/${slug}/actions/workflows" --jq '.total_count'`,
      { encoding: "utf-8", timeout: 8000 },
    ).trim();
    hasCi = parseInt(workflows, 10) > 0;
  } catch {}

  // Compute LLM receptivity score
  const llmReceptivity = computeLlmReceptivity(slug, category, hasContributing, hasCi, stars);

  const meta: RepoMeta = { stars, hasContributing, hasCi, llmReceptivity };
  repoMetaCache.set(slug, meta);
  return meta;
}

/**
 * Heuristic score (0-1) for how likely a repo accepts AI-generated contributions.
 */
function computeLlmReceptivity(
  slug: string,
  category: string,
  hasContributing: boolean,
  hasCi: boolean,
  stars: number,
): number {
  let score = 0.5; // neutral baseline

  // AI/ML repos are culturally receptive to AI contributions
  if (category === "ai-ml") score += 0.15;

  // Has CI = can verify contributions programmatically (less reliance on human review)
  if (hasCi) score += 0.1;

  // Has CONTRIBUTING.md = structured process, easier for automated contributors
  if (hasContributing) score += 0.1;

  // Large repos (1k+ stars) are more likely to have triage processes that handle bot PRs
  if (stars >= 1000) score += 0.05;
  if (stars >= 10000) score += 0.05;

  // Known bot-friendly ecosystems (these repos actively use automated tooling)
  const botFriendly = ["freeCodeCamp", "OWASP"];
  if (botFriendly.some((org) => slug.startsWith(org + "/"))) score += 0.1;

  return Math.min(1, Math.round(score * 100) / 100);
}

/**
 * Get the set of issues already claimed by active/recent runs.
 */
function getClaimedIssues(): Set<string> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT candidate_repo, candidate_issue FROM runs
       WHERE status IN ('queued', 'running', 'succeeded')`,
    )
    .all() as Array<{ candidate_repo: string; candidate_issue: number }>;

  return new Set(rows.map((r) => `${r.candidate_repo}#${r.candidate_issue}`));
}
