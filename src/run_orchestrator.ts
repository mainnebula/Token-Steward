import { execSync, spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { addRun, updateRun, getRuns } from "./store.js";
import { emitEvent, getLogger } from "./audit_log.js";
import { pollUsage } from "./usage_adapter.js";
import type { Candidate, Run, Policy } from "./models.js";

/** Validate a repo slug contains only safe characters (owner/name). */
function validateRepoSlug(slug: string): void {
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(slug)) {
    throw new Error(`Invalid repo slug: ${slug}`);
  }
}

/** Run a command with args array (no shell interpolation). Throws on failure. */
function execCmd(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): string {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 30000,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args[0]} failed: ${(result.stderr || result.error?.message || "").toString().slice(0, 500)}`);
  }
  return (result.stdout ?? "").trim();
}

/** Run a command, returning empty string on failure instead of throwing. */
function execCmdSafe(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): string {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 30000,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) return "";
  return (result.stdout ?? "").trim();
}

const WORKSPACE_DIR = "workspace";

/**
 * Queue a run for a candidate issue.
 */
export function queueRun(candidate: Candidate): Run {
  const id = randomUUID().slice(0, 8);
  const branch = `steward/${candidate.repo_slug.replaceAll("/", "-")}-${candidate.issue_number}-${id}`;
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

  addRun(run);

  emitEvent("run_queued", { run_id: id, repo: candidate.repo_slug, issue: candidate.issue_number });
  return run;
}

/**
 * Execute a queued run: clone, branch, run claude -p, open draft PR.
 */
export async function executeRun(run: Run, policy: Policy): Promise<Run> {
  const log = getLogger();

  const applyUpdate = (updates: Partial<Run>) => {
    Object.assign(run, updates);
    updateRun(run.id, updates);
  };

  try {
    applyUpdate({ status: "running", started_at: new Date().toISOString() });
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
      applyUpdate({ pr_url: prUrl });
      applyUpdate({
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
      applyUpdate({
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
    applyUpdate({
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
  validateRepoSlug(repoSlug);
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  const repoDir = join(WORKSPACE_DIR, repoSlug.replaceAll("/", "__"));

  // Path containment check
  if (!resolve(repoDir).startsWith(resolve(WORKSPACE_DIR))) {
    throw new Error(`Invalid repo slug produces path outside workspace: ${repoSlug}`);
  }

  if (existsSync(join(repoDir, ".git"))) {
    // Ensure fork remote layout (origin=fork, upstream=original)
    const remotes = execCmd("git", ["remote"], { cwd: repoDir, timeout: 5000 }).split("\n");
    if (!remotes.includes("upstream")) {
      // Pre-fork clone: origin points to upstream. Fork and remap remotes.
      execCmd("gh", ["repo", "fork", repoSlug, "--remote", "--remote-name", "fork"], { cwd: repoDir, timeout: 60000 });
      // Swap: origin (upstream) -> upstream, fork (user's fork) -> origin
      execCmd("git", ["remote", "rename", "origin", "upstream"], { cwd: repoDir, timeout: 5000 });
      execCmd("git", ["remote", "rename", "fork", "origin"], { cwd: repoDir, timeout: 5000 });
    }
    execCmd("git", ["fetch", "upstream", "--quiet", "--no-tags"], { cwd: repoDir, timeout: 30000 });
    // Try main, fall back to master
    const mainResult = execCmdSafe("git", ["checkout", "main"], { cwd: repoDir, timeout: 10000 });
    if (!mainResult && mainResult === "") {
      execCmdSafe("git", ["checkout", "master"], { cwd: repoDir, timeout: 10000 });
    }
    const pullResult = execCmdSafe("git", ["pull", "--ff-only", "upstream", "main"], { cwd: repoDir, timeout: 30000 });
    if (!pullResult && pullResult === "") {
      execCmdSafe("git", ["pull", "--ff-only", "upstream", "master"], { cwd: repoDir, timeout: 30000 });
    }
  } else {
    // Try to fork, then clone the fork. If forking fails (403, disabled, etc.),
    // fall back to cloning upstream directly.
    try {
      execCmd("gh", ["repo", "fork", repoSlug, "--default-branch-only"], { timeout: 60000 });
      const ghUser = execCmd("gh", ["api", "user", "--jq", ".login"], { timeout: 10000 });
      const repoName = repoSlug.split("/")[1];
      const forkSlug = `${ghUser}/${repoName}`;
      execCmd("gh", ["repo", "clone", forkSlug, repoDir, "--", "--depth=50", "--quiet", "--no-tags"], { timeout: 90000 });
      const cloneRemotes = execCmd("git", ["remote"], { cwd: repoDir, timeout: 5000 }).split("\n");
      if (!cloneRemotes.includes("upstream")) {
        execCmd("git", ["remote", "add", "upstream", `https://github.com/${repoSlug}.git`], { cwd: repoDir, timeout: 5000 });
      }
    } catch (forkErr) {
      const msg = forkErr instanceof Error ? forkErr.message : String(forkErr);
      getLogger().warn({ repo: repoSlug, error: msg }, "Fork failed, cloning upstream directly");
      console.warn(`  Warning: Could not fork ${repoSlug} (${msg.includes("403") ? "forking disabled or token lacks permission" : "fork failed"})`);
      console.warn("  Cloning upstream directly. You'll need to fork manually to open a PR.");
      execCmd("gh", ["repo", "clone", repoSlug, repoDir, "--", "--depth=50", "--quiet", "--no-tags"], { timeout: 90000 });
    }
  }

  // Disable git hooks to prevent malicious hooks in cloned repos from executing
  execCmd("git", ["config", "core.hooksPath", "/dev/null"], { cwd: repoDir, timeout: 5000 });

  // Create feature branch
  execCmd("git", ["checkout", "-b", branch], { cwd: repoDir, timeout: 5000 });

  return repoDir;
}

export function getIssueBody(repoSlug: string, issueNumber: number): string {
  try {
    return execCmd("gh", ["issue", "view", String(issueNumber), "--repo", repoSlug, "--json", "body", "--jq", ".body"], { timeout: 10000 });
  } catch {
    return "(Issue body unavailable)";
  }
}

export function buildContributionPrompt(run: Run, issueBody: string): string {
  return `You're helping a developer fix an issue on ${run.candidate_repo}. Write code the way a careful human contributor would.

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
7. Make atomic commits with clear messages. Look at recent commits (git log --oneline -10) and match the project's commit style. No emoji, no attribution footers — just normal commit messages.
8. Do NOT push to any remote. Only make local commits.
9. If you cannot solve the issue with high confidence, make no commits and explain why.

Focus on quality over speed. A correct, clean contribution is better than a fast, broken one.
Keep changes minimal and focused. Don't refactor surrounding code or add unrelated improvements.
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
  // Try main..branch, fall back to master..branch
  const result = execCmdSafe("git", ["log", `main..${branch}`, "--oneline"], { cwd: repoDir, timeout: 5000 });
  if (result.length > 0) return true;
  const fallback = execCmdSafe("git", ["log", `master..${branch}`, "--oneline"], { cwd: repoDir, timeout: 5000 });
  return fallback.length > 0;
}

export function pushBranch(repoDir: string, branch: string): void {
  execCmd("git", ["push", "-u", "origin", branch], { cwd: repoDir, timeout: 30000 });
}

export function openDraftPR(run: Run, repoDir: string): string | null {
  const bodyFile = join(tmpdir(), `steward-pr-${run.id}.md`);
  try {
    // Determine the fork owner for --head flag (needed for cross-fork PRs)
    const ghUser = execCmd("gh", ["api", "user", "--jq", ".login"], { timeout: 10000 });
    const headRef = `${ghUser}:${run.branch}`;

    const title = `Fix #${run.candidate_issue}`;
    const body = [
      `Addresses ${run.issue_url}`,
      ``,
      `---`,
      `*Draft PR — please review before merging. AI-assisted (Claude Code), human-reviewed.*`,
    ].join("\n");

    writeFileSync(bodyFile, body, "utf-8");

    const result = execCmd("gh", [
      "pr", "create", "--draft",
      "--title", title,
      "--body-file", bodyFile,
      "--repo", run.candidate_repo,
      "--head", headRef,
    ], { cwd: repoDir, timeout: 15000 });

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
  return getRuns({ statuses: ["queued", "running", "in_progress"] });
}

export function getRecentRuns(limit = 10): Run[] {
  return getRuns({ orderBy: "created_at_desc", limit });
}

export function getTodayRunCount(): number {
  const today = new Date().toISOString().slice(0, 10);
  return getRuns({}).filter(
    (r) => r.created_at >= today && r.status !== "canceled",
  ).length;
}

export function cancelRun(runId: string): void {
  const activeStatuses = new Set(["queued", "running", "in_progress"]);
  const run = getRuns({}).find((r) => r.id === runId);
  if (run && activeStatuses.has(run.status)) {
    updateRun(runId, { status: "canceled", finished_at: new Date().toISOString() });
  }
  emitEvent("run_canceled", { run_id: runId });
}

// --- Interactive workflow helpers ---

/**
 * Write a STEWARD_CONTEXT.md file in the workspace with issue details.
 */
export function writeContextFile(repoDir: string, run: Run, issueBody: string, proposeFirst = false): void {
  const proposalSection = proposeFirst ? `
## Approach: Propose First

Before writing any code, follow these steps:

1. **Analyze.** Read the issue, explore the codebase, and understand the problem thoroughly.
2. **Draft a proposal.** Write a concise comment for the issue covering:
   - What the problem is and where it lives in the codebase
   - Your proposed approach (files to change, strategy)
   - Trade-offs or open questions
   Keep it direct and technical. No filler.
   End the comment with: "This issue was identified for fixing by [Token Steward](https://github.com/mainnebula/token-steward)."
3. **Post it.** Use \`gh issue comment ${run.candidate_issue} --repo ${run.candidate_repo} --body-file <file>\` to post. The developer (me) will review before you post.
4. **Stop.** Do NOT start implementing. Wait for maintainer feedback.
` : '';

  const context = `# Token Steward Context

You're helping a developer contribute to this project. They found this issue and want to fix it.

## Your job

Before jumping into code, start by explaining what you find. The developer wants to understand:
- What part of the codebase is involved
- What's actually going wrong (for bugs) or what needs to be built (for features)
- How the relevant code works today
- What your proposed fix or implementation looks like

Walk through this with the developer so they have a clear picture before you start making changes. Then implement the fix.

After making changes, tell the developer how to test it. Give them concrete steps they can run to verify the fix works (commands, expected output, what to look for).

## Issue
${run.issue_url}

## Description
${issueBody}
${proposalSection}
## Contribution Guidelines
- Follow the project's existing code style and conventions
- Read CONTRIBUTING.md if it exists
- Run tests before committing
- Make atomic commits with clear, descriptive messages
- Keep changes minimal and focused on the issue
`;

  const claudeMd = `# Commit conventions

Write commit messages like a human developer would — clear subject line describing what changed and why. No emoji, no tokens-used counters, no attribution footers. Just normal, clean commit messages that match the project's existing style.

Look at recent commits in the repo (\`git log --oneline -10\`) and match their format.
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
  return getRuns({
    statuses: ["running", "in_progress"],
    repo: repoSlug,
    issue: issueNumber,
    orderBy: "created_at_desc",
    limit: 1,
  })[0] ?? null;
}

/**
 * Get the most recent run (any status, but prefer running).
 */
export function getLatestRun(): Run | null {
  return getRuns({ orderBy: "active_first", limit: 1 })[0] ?? null;
}

/**
 * Check if a PR already exists for a given branch on a repo.
 * Returns the PR URL if found, null otherwise.
 */
export function findExistingPR(repoSlug: string, branch: string): string | null {
  const result = execCmdSafe("gh", ["pr", "list", "--repo", repoSlug, "--head", branch, "--json", "url", "--jq", ".[0].url"], { timeout: 10000 });
  return result || null;
}

/**
 * Verify that the workspace branch exists and is checked out.
 */
export function verifyBranchCheckedOut(repoDir: string, branch: string): boolean {
  const current = execCmdSafe("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir, timeout: 5000 });
  return current === branch;
}

/**
 * Update a run's status and optional fields.
 */
export function updateRunStatus(runId: string, updates: Partial<Run>): void {
  updateRun(runId, updates);
}
