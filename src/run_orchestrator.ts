import { execSync, spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getDb, withDbWriteRetry } from "./db.js";
import { emitEvent, getLogger } from "./audit_log.js";
import { pollUsage } from "./usage_adapter.js";
import type { Candidate, Run, Policy } from "./models.js";

const WORKSPACE_DIR = "workspace";

/**
 * Queue a run for a candidate issue.
 */
export function queueRun(candidate: Candidate): Run {
  const id = randomUUID().slice(0, 8);
  const branch = `steward/${candidate.repo_slug.replace("/", "-")}-${candidate.issue_number}-${id}`;
  const now = new Date().toISOString();

  const run: Run = {
    id,
    candidate_repo: candidate.repo_slug,
    candidate_issue: candidate.issue_number,
    issue_url: candidate.issue_url,
    branch,
    status: "queued",
    tokens_consumed: 0,
    pr_url: null,
    error: null,
    started_at: null,
    finished_at: null,
    created_at: now,
  };

  const db = getDb();
  withDbWriteRetry(() => {
    db.prepare(`
      INSERT INTO runs (id, candidate_repo, candidate_issue, issue_url, branch, status, tokens_consumed, pr_url, error, started_at, finished_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.candidate_repo, run.candidate_issue, run.issue_url,
      run.branch, run.status, run.tokens_consumed, run.pr_url,
      run.error, run.started_at, run.finished_at, run.created_at,
    );
  });

  emitEvent("run_queued", { run_id: id, repo: candidate.repo_slug, issue: candidate.issue_number });
  return run;
}

/**
 * Execute a queued run: clone, branch, run claude -p, open draft PR.
 */
export async function executeRun(run: Run, policy: Policy): Promise<Run> {
  const log = getLogger();
  const db = getDb();

  const updateRun = (updates: Partial<Run>) => {
    Object.assign(run, updates);
    const setClauses = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    const values = Object.values(updates);
    withDbWriteRetry(() => {
      db.prepare(`UPDATE runs SET ${setClauses} WHERE id = ?`).run(...values, run.id);
    });
  };

  try {
    updateRun({ status: "running", started_at: new Date().toISOString() });
    emitEvent("run_started", { run_id: run.id });

    // Take usage snapshot before
    const usageBefore = await pollUsage();
    const tokensBefore = usageBefore?.tokens_used ?? 0;

    // 1. Clone or fetch the repo
    const repoDir = await prepareRepo(run.candidate_repo, run.branch);

    // 2. Fetch issue details for the prompt
    const issueBody = getIssueBody(run.candidate_repo, run.candidate_issue);

    // 3. Run claude -p with the contribution prompt
    const prompt = buildContributionPrompt(run, issueBody);
    log.info({ run_id: run.id }, "Executing claude -p contribution");

    const claudeResult = await runClaude(prompt, repoDir, policy);

    // 4. Check if commits were made
    const hasCommits = checkForNewCommits(repoDir, run.branch);

    // 5. Estimate tokens consumed
    const usageAfter = await pollUsage();
    const tokensAfter = usageAfter?.tokens_used ?? tokensBefore;
    const tokensConsumed = Math.max(0, tokensAfter - tokensBefore);

    if (hasCommits) {
      // 5. Push branch and open draft PR
      pushBranch(repoDir, run.branch);
      const prUrl = openDraftPR(run, repoDir);
      updateRun({ pr_url: prUrl });
      updateRun({
        status: "succeeded",
        tokens_consumed: tokensConsumed,
        finished_at: new Date().toISOString(),
      });
      emitEvent("run_succeeded", {
        run_id: run.id,
        tokens_consumed: tokensConsumed,
        has_pr: !!run.pr_url,
      });
    } else {
      const noChangesSummary = summarizeNoChanges(claudeResult.stdout, claudeResult.stderr);
      updateRun({
        status: "no_changes",
        error: noChangesSummary,
        tokens_consumed: tokensConsumed,
        finished_at: new Date().toISOString(),
      });
      emitEvent("run_no_changes", {
        run_id: run.id,
        tokens_consumed: tokensConsumed,
        summary: noChangesSummary,
      });
      log.info({ run_id: run.id }, "Run completed with no commits");
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    updateRun({
      status: "failed",
      error: errorMsg,
      finished_at: new Date().toISOString(),
    });
    emitEvent("run_failed", { run_id: run.id, error: errorMsg });
    log.error({ run_id: run.id, error: errorMsg }, "Run failed");
  }

  return run;
}

export async function prepareRepo(repoSlug: string, branch: string): Promise<string> {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  const repoDir = join(WORKSPACE_DIR, repoSlug.replace("/", "__"));

  if (existsSync(join(repoDir, ".git"))) {
    // Ensure fork remote layout (origin=fork, upstream=original)
    const remotes = execSync("git remote", { cwd: repoDir, encoding: "utf-8" }).trim().split("\n");
    if (!remotes.includes("upstream")) {
      // Pre-fork clone: origin points to upstream. Fork and remap remotes.
      // gh repo fork --remote adds a "fork" remote pointing to user's fork
      execSync(`gh repo fork "${repoSlug}" --remote --remote-name fork`, { cwd: repoDir, timeout: 60000, stdio: ["pipe", "pipe", "pipe"] });
      // Swap: origin (upstream) -> upstream, fork (user's fork) -> origin
      execSync("git remote rename origin upstream", { cwd: repoDir, timeout: 5000 });
      execSync("git remote rename fork origin", { cwd: repoDir, timeout: 5000 });
    }
    execSync("git fetch upstream --quiet --no-tags", { cwd: repoDir, timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
    execSync("git checkout main || git checkout master", {
      cwd: repoDir,
      timeout: 10000,
      shell: "/bin/bash",
      stdio: ["pipe", "pipe", "pipe"],
    });
    execSync("git pull --ff-only upstream main || git pull --ff-only upstream master", {
      cwd: repoDir,
      timeout: 30000,
      shell: "/bin/bash",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } else {
    // Fork (idempotent), then clone the fork into our workspace dir.
    execSync(`gh repo fork "${repoSlug}" --default-branch-only`, { timeout: 60000, stdio: ["pipe", "pipe", "pipe"] });
    // Determine the user's fork slug
    const ghUser = execSync("gh api user --jq .login", { encoding: "utf-8", timeout: 10000 }).trim();
    const repoName = repoSlug.split("/")[1];
    const forkSlug = `${ghUser}/${repoName}`;
    execSync(`gh repo clone "${forkSlug}" "${repoDir}" -- --depth=50 --quiet --no-tags`, { timeout: 90000, stdio: ["pipe", "pipe", "pipe"] });
    // Add upstream remote pointing to original repo (skip if already set by gh clone)
    const cloneRemotes = execSync("git remote", { cwd: repoDir, encoding: "utf-8" }).trim().split("\n");
    if (!cloneRemotes.includes("upstream")) {
      execSync(`git remote add upstream "https://github.com/${repoSlug}.git"`, { cwd: repoDir, timeout: 5000 });
    }
  }

  // Create feature branch
  execSync(`git checkout -b "${branch}"`, { cwd: repoDir, timeout: 5000 });

  return repoDir;
}

export function getIssueBody(repoSlug: string, issueNumber: number): string {
  try {
    return execSync(
      `gh issue view ${issueNumber} --repo "${repoSlug}" --json body --jq .body`,
      { encoding: "utf-8", timeout: 10000 },
    ).trim();
  } catch {
    return "(Issue body unavailable)";
  }
}

export function buildContributionPrompt(run: Run, issueBody: string): string {
  return `You are contributing to the open-source project ${run.candidate_repo} as part of Token Steward, an initiative that redirects unused AI compute toward open-source contributions.

ISSUE #${run.candidate_issue}: ${run.issue_url}

Issue description:
${issueBody}

INSTRUCTIONS:
1. Read and understand the issue thoroughly.
2. Read the CONTRIBUTING.md or README for contribution guidelines if they exist.
3. Explore the repository structure to understand the codebase.
4. Implement a fix or feature as described in the issue.
5. Write clean, well-tested code following the project's existing style and conventions.
6. Run existing tests if a test command is obvious (e.g. npm test, pytest, cargo test). Do not introduce test failures.
7. Make atomic, well-described git commits. End each commit message with:
   Contributed via Token Steward (https://github.com/mainnebula/token-steward) — this repo was identified as a high-impact open-source project worth contributing to. A developer donated their surplus Claude Code tokens to help.
8. Do NOT push to any remote. Only make local commits.
9. If you cannot solve the issue with high confidence, make no commits and explain why.

Focus on quality over speed. A correct, clean contribution is better than a fast, broken one.
Respect the project's conventions. If unsure, err on the side of doing less.`;
}

async function runClaude(
  prompt: string,
  cwd: string,
  _policy: Policy,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--allowedTools", "Bash,Edit,Write,Read,Grep,Glob",
      "--model", "sonnet",
    ];

    const child = spawn("claude", args, {
      cwd,
      timeout: 30 * 60 * 1000, // 30 minute timeout
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

function summarizeNoChanges(stdout: string, stderr: string): string {
  const summary = `${stdout}\n${stderr}`.trim();
  if (!summary) return "No commits were created by Claude.";
  const singleLine = summary.replace(/\s+/g, " ");
  return `No commits were created by Claude. ${singleLine.slice(0, 300)}`;
}

export function checkForNewCommits(repoDir: string, branch: string): boolean {
  try {
    const result = execSync(
      `git log main..${branch} --oneline 2>/dev/null || git log master..${branch} --oneline 2>/dev/null`,
      { cwd: repoDir, encoding: "utf-8", shell: "/bin/bash" },
    ).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

export function pushBranch(repoDir: string, branch: string): void {
  execSync(`git push -u origin "${branch}"`, { cwd: repoDir, timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
}

export function openDraftPR(run: Run, repoDir: string): string | null {
  const bodyFile = join(tmpdir(), `steward-pr-${run.id}.md`);
  try {
    // Determine the fork owner for --head flag (needed for cross-fork PRs)
    const ghUser = execSync("gh api user --jq .login", { encoding: "utf-8", timeout: 10000 }).trim();
    const headRef = `${ghUser}:${run.branch}`;

    const title = `Fix #${run.candidate_issue}`;
    const body = [
      `## What`,
      `Addresses ${run.issue_url}`,
      ``,
      `## Context`,
      `This contribution was created by [Token Steward](https://github.com/mainnebula/token-steward) — an initiative that redirects unused AI compute (from Claude Max subscription plans) toward open-source contributions before weekly token limits reset.`,
      ``,
      `The code was generated by Claude (Anthropic) and should be reviewed like any other contribution. AI-assisted, human-reviewed.`,
      ``,
      `## How to get involved`,
      `- If you maintain an open-source project and want contributions like this, add your repo to the [Token Steward registry](https://github.com/mainnebula/token-steward)`,
      `- If you have a Claude Max plan with unused tokens, run Token Steward yourself to contribute your surplus to open source`,
      ``,
      `---`,
      `*This is a draft PR. Please review thoroughly before merging.*`,
    ].join("\n");

    writeFileSync(bodyFile, body, "utf-8");

    const result = execSync(
      `gh pr create --draft --title "${title}" --body-file "${bodyFile}" --repo "${run.candidate_repo}" --head "${headRef}"`,
      { cwd: repoDir, encoding: "utf-8", timeout: 15000 },
    ).trim();

    return result || null;
  } catch (err) {
    getLogger().warn({ run_id: run.id, error: String(err) }, "Failed to open draft PR");
    return null;
  } finally {
    try { unlinkSync(bodyFile); } catch {}
  }
}

// --- Query helpers ---

export function getActiveRuns(): Run[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM runs WHERE status IN ('queued', 'running', 'in_progress')")
    .all() as Run[];
}

export function getRecentRuns(limit = 10): Run[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Run[];
}

export function getTodayRunCount(): number {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM runs WHERE created_at >= ? AND status != 'canceled'",
    )
    .get(today) as { cnt: number };
  return row.cnt;
}

export function cancelRun(runId: string): void {
  const db = getDb();
  withDbWriteRetry(() => {
    db.prepare(
      "UPDATE runs SET status = 'canceled', finished_at = ? WHERE id = ? AND status IN ('queued', 'running', 'in_progress')",
    ).run(new Date().toISOString(), runId);
  });
  emitEvent("run_canceled", { run_id: runId });
}

// --- Interactive workflow helpers ---

/**
 * Write a STEWARD_CONTEXT.md file in the workspace with issue details.
 */
export function writeContextFile(repoDir: string, run: Run, issueBody: string): void {
  const context = `# Token Steward Context

## Issue
${run.issue_url}

## Description
${issueBody}

## Contribution Guidelines
- Follow the project's existing code style and conventions
- Run tests before committing
- Make atomic commits with clear messages
`;

  const claudeMd = `# Commit conventions

When committing changes, end every commit message with this footer (separated by a blank line from the body):

🔋 <TOKENS> tokens donated via Token Steward (https://github.com/mainnebula/token-steward)

Replace <TOKENS> with the approximate total tokens you've used so far in this session (your best estimate is fine, round to the nearest thousand e.g. "12,000"). Update the number in each subsequent commit to reflect cumulative usage.
`;

  writeFileSync(join(repoDir, "STEWARD_CONTEXT.md"), context, "utf-8");
  writeFileSync(join(repoDir, "CLAUDE.md"), claudeMd, "utf-8");

  // Ensure our files are git-ignored so they don't trigger "uncommitted changes" warnings
  const gitignorePath = join(repoDir, ".git", "info", "exclude");
  try {
    const existing = readFileSync(gitignorePath, "utf-8");
    const additions: string[] = [];
    if (!existing.includes("STEWARD_CONTEXT.md")) additions.push("STEWARD_CONTEXT.md");
    if (!existing.includes("CLAUDE.md")) additions.push("CLAUDE.md");
    if (additions.length > 0) {
      writeFileSync(gitignorePath, existing.trimEnd() + "\n" + additions.join("\n") + "\n", "utf-8");
    }
  } catch {
    writeFileSync(gitignorePath, "STEWARD_CONTEXT.md\nCLAUDE.md\n", "utf-8");
  }
}

/**
 * Launch interactive claude in the workspace directory.
 * stdio is inherited so the user sees the full Claude Code TUI.
 * Requires a TTY — returns nonzero in headless/CI environments.
 */
export function launchInteractiveClaude(repoDir: string): number {
  if (!process.stdin.isTTY) {
    getLogger().error("Cannot launch interactive Claude: no TTY detected (headless/CI environment)");
    console.error("Error: steward work requires an interactive terminal (TTY).");
    console.error("In CI/headless environments, use 'steward run' for autonomous execution.");
    return 1;
  }

  const result = spawnSync("claude", [], {
    cwd: repoDir,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

/**
 * Find an active run for a given repo/issue.
 */
export function getRunByRepo(repoSlug: string, issueNumber: number): Run | null {
  const db = getDb();
  return (db
    .prepare(
      "SELECT * FROM runs WHERE candidate_repo = ? AND candidate_issue = ? AND status IN ('running', 'in_progress') ORDER BY created_at DESC LIMIT 1",
    )
    .get(repoSlug, issueNumber) as Run) ?? null;
}

/**
 * Get the most recent run (any status, but prefer running).
 */
export function getLatestRun(): Run | null {
  const db = getDb();
  return (db
    .prepare(
      "SELECT * FROM runs ORDER BY CASE WHEN status IN ('in_progress', 'running') THEN 0 ELSE 1 END, created_at DESC LIMIT 1",
    )
    .get() as Run) ?? null;
}

/**
 * Check if a PR already exists for a given branch on a repo.
 * Returns the PR URL if found, null otherwise.
 */
export function findExistingPR(repoSlug: string, branch: string): string | null {
  try {
    const result = execSync(
      `gh pr list --repo "${repoSlug}" --head "${branch}" --json url --jq '.[0].url'`,
      { encoding: "utf-8", timeout: 10000 },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Verify that the workspace branch exists and is checked out.
 */
export function verifyBranchCheckedOut(repoDir: string, branch: string): boolean {
  try {
    const current = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return current === branch;
  } catch {
    return false;
  }
}

/**
 * Update a run's status and optional fields.
 */
export function updateRunStatus(runId: string, updates: Partial<Run>): void {
  const db = getDb();
  const setClauses = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(", ");
  const values = Object.values(updates);
  withDbWriteRetry(() => {
    db.prepare(`UPDATE runs SET ${setClauses} WHERE id = ?`).run(...values, runId);
  });
}
