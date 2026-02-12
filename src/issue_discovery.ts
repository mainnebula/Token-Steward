import { exec } from "node:child_process";
import { getRuns } from "./store.js";
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

const CONCURRENCY = 8;

function execAsync(cmd: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * Discover open issues from active registry repos.
 * Runs repos in parallel (up to CONCURRENCY) for speed.
 */
export async function discoverCandidates(
  repos: RegistryRepo[],
): Promise<Candidate[]> {
  const log = getLogger();
  const claimedIssues = getClaimedIssues();

  const repoResults = await runWithConcurrency(repos, CONCURRENCY, async (repo) => {
    try {
      return await discoverForRepo(repo, claimedIssues);
    } catch (err) {
      log.warn({ repo: repo.slug, error: String(err) }, "Issue discovery failed for repo");
      return [];
    }
  });

  return repoResults.flat();
}

async function discoverForRepo(
  repo: RegistryRepo,
  claimedIssues: Set<string>,
): Promise<Candidate[]> {
  const labels = repo.issue_labels ?? ["good first issue", "help wanted"];

  // Fetch issues and metadata in parallel
  const [issues, meta] = await Promise.all([
    listIssues(repo.slug, labels),
    getRepoMeta(repo.slug, repo.category),
  ]);

  const candidates: Candidate[] = [];

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

  return candidates;
}

/**
 * List open issues matching any of the given labels.
 * Fetches all labels in parallel instead of sequentially.
 */
async function listIssues(repoSlug: string, labels: string[]): Promise<GitHubIssue[]> {
  const seen = new Set<number>();
  const results: GitHubIssue[] = [];

  const labelResults = await Promise.all(
    labels.map(async (label) => {
      try {
        const result = await execAsync(
          `gh issue list --repo "${repoSlug}" --label "${label}" --state open --json number,title,url,labels,comments,reactionGroups,createdAt --limit 20`,
        );
        return JSON.parse(result) as GitHubIssue[];
      } catch {
        return [];
      }
    }),
  );

  for (const issues of labelResults) {
    for (const issue of issues) {
      if (!seen.has(issue.number)) {
        seen.add(issue.number);
        results.push(issue);
      }
    }
  }

  return results;
}

/**
 * Fetch repo-level metadata using a single GraphQL query.
 */
async function getRepoMeta(slug: string, category: string): Promise<RepoMeta> {
  if (repoMetaCache.has(slug)) return repoMetaCache.get(slug)!;

  const [owner, name] = slug.split("/");
  let stars = 0;
  let hasContributing = false;
  let hasCi = false;

  try {
    // Single GraphQL call replaces 3 separate REST calls
    const query = `query {
      repository(owner: "${owner}", name: "${name}") {
        stargazerCount
        contributing: object(expression: "HEAD:CONTRIBUTING.md") { __typename }
        workflows: object(expression: "HEAD:.github/workflows") { __typename }
      }
    }`;
    const result = await execAsync(
      `gh api graphql -f query='${query}' --jq '.data.repository'`,
      10000,
    );
    const parsed = JSON.parse(result);
    stars = parsed.stargazerCount ?? 0;
    hasContributing = parsed.contributing !== null;
    hasCi = parsed.workflows !== null;
  } catch {
    // Fallback: try just getting stars via REST
    try {
      const result = await execAsync(
        `gh repo view "${slug}" --json stargazerCount --jq '.stargazerCount'`,
        10000,
      );
      stars = parseInt(result.trim(), 10) || 0;
    } catch {}
  }

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
  let score = 0.5;

  if (category === "ai-ml") score += 0.15;
  if (hasCi) score += 0.1;
  if (hasContributing) score += 0.1;
  if (stars >= 1000) score += 0.05;
  if (stars >= 10000) score += 0.05;

  const botFriendly = ["OWASP"];
  if (botFriendly.some((org) => slug.startsWith(org + "/"))) score += 0.1;

  return Math.min(1, Math.round(score * 100) / 100);
}

/**
 * Get the set of issues already claimed by active/recent runs.
 */
function getClaimedIssues(): Set<string> {
  const runs = getRuns({ statuses: ["queued", "running", "succeeded"] });
  return new Set(runs.map((r) => `${r.candidate_repo}#${r.candidate_issue}`));
}
