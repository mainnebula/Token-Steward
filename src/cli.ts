#!/usr/bin/env node

import { Command } from "commander";
import { loadPolicy } from "./policy_store.js";
import { startScheduler, getStatus, tick } from "./scheduler.js";
import { pollUsage, getLatestUsage, injectManualUsage } from "./usage_adapter.js";
import { syncRegistry, getActiveRepos } from "./registry_sync.js";
import { discoverCandidates } from "./issue_discovery.js";
import { rankCandidates } from "./scoring_engine.js";
import {
  queueRun, executeRun, getRecentRuns, cancelRun,
  prepareRepo, getIssueBody, writeContextFile, launchInteractiveClaude,
  checkForNewCommits, pushBranch, openDraftPR, updateRunStatus, getLatestRun,
  findExistingPR, verifyBranchCheckedOut,
} from "./run_orchestrator.js";
import { pauseAutopilot, resumeAutopilot, getGuardrailState } from "./guardrails.js";
import { getRemainingBudget } from "./policy_store.js";
import { getLogger } from "./audit_log.js";
import { getDb, closeDb } from "./db.js";
import { runExport, writeExportFiles } from "./export_data.js";
import { createInterface } from "node:readline";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const program = new Command();

program
  .name("steward")
  .description("Discover and contribute to open-source projects with your unused Claude Code tokens")
  .version("0.1.0");

// --- steward start (deprecated — hidden) ---
program
  .command("start", { hidden: true })
  .description("Start the scheduler daemon (deprecated)")
  .option("--dry-run", "Log actions without executing runs", false)
  .option("--config <path>", "Path to policy config", "config/policy.yaml")
  .action(async (opts) => {
    console.error("Warning: 'steward start' is deprecated. Use 'steward discover', 'steward work', and 'steward submit' instead.");
    loadPolicy(opts.config);
    startScheduler(opts.dryRun);
    // Keep the process alive
    process.on("SIGINT", () => {
      getLogger().info("Shutting down...");
      closeDb();
      process.exit(0);
    });
  });

// --- steward status ---
program
  .command("status")
  .description("Show current status")
  .action(async () => {
    loadPolicy();
    const status = await getStatus();
    console.log(JSON.stringify(status, null, 2));
    closeDb();
  });

// --- steward tick (deprecated — hidden) ---
program
  .command("tick", { hidden: true })
  .description("Run a single scheduler tick (deprecated)")
  .option("--dry-run", "Log actions without executing runs", false)
  .option("--budget <tokens>", "Manually specify remaining token budget (skips OAuth)")
  .action(async (opts) => {
    console.error("Warning: 'steward tick' is deprecated. Use 'steward discover', 'steward work', and 'steward submit' instead.");
    const policy = loadPolicy();
    if (opts.budget) {
      injectManualUsage(parseInt(opts.budget, 10), policy.weekly_target_tokens);
    }
    await tick(opts.dryRun);
    closeDb();
  });

// --- steward usage ---
program
  .command("usage")
  .description("Poll and display usage data")
  .option("--refresh", "Force a fresh poll", false)
  .action(async (opts) => {
    loadPolicy();
    let usage;
    if (opts.refresh) {
      usage = await pollUsage();
    } else {
      usage = getLatestUsage();
    }

    if (!usage) {
      console.log("No usage data available. Run with --refresh to poll.");
    } else {
      const policy = loadPolicy();
      const remaining = getRemainingBudget(policy, usage.tokens_used);
      console.log(JSON.stringify({
        ...usage,
        budget_remaining: remaining,
      }, null, 2));
    }
    closeDb();
  });

// --- steward candidates ---
program
  .command("candidates")
  .description("List eligible candidates")
  .option("--limit <n>", "Max candidates to show", "20")
  .action(async (opts) => {
    const policy = loadPolicy();
    const registry = await syncRegistry();
    if (!registry) {
      console.error("Failed to fetch registry");
      closeDb();
      process.exit(1);
    }

    const activeRepos = getActiveRepos(registry, policy.filters);
    console.log(`Active repos: ${activeRepos.length}`);

    const candidates = await discoverCandidates(activeRepos);
    console.log(`Raw candidates: ${candidates.length}`);

    const usage = getLatestUsage();
    const remainingBudget = usage
      ? getRemainingBudget(policy, usage.tokens_used)
      : policy.weekly_target_tokens - policy.weekly_min_reserve_tokens;

    const ranked = rankCandidates(candidates, policy, remainingBudget, policy.limits.max_concurrency);
    const limited = ranked.slice(0, parseInt(opts.limit, 10));

    for (const c of limited) {
      console.log(
        `  [${c.score.toFixed(2)}] ${c.repo_slug}#${c.issue_number} - ${c.issue_title} (~${c.est_tokens} tokens)`,
      );
    }
    closeDb();
  });

// --- steward run now ---
program
  .command("run")
  .description("Manually trigger a run for a specific issue")
  .argument("<issue>", "Issue in owner/repo#123 format")
  .action(async (issueArg) => {
    const policy = loadPolicy();
    const match = issueArg.match(/^(.+?)#(\d+)$/);
    if (!match) {
      console.error("Invalid format. Use owner/repo#123");
      process.exit(1);
    }
    const [, repoSlug, issueNum] = match;

    const candidate = {
      repo_slug: repoSlug,
      issue_number: parseInt(issueNum, 10),
      issue_title: "(manual run)",
      issue_url: `https://github.com/${repoSlug}/issues/${issueNum}`,
      issue_labels: [],
      category: "",
      tags: [],
      score: 1.0,
      est_tokens: policy.limits.max_tokens_per_run,
      discovered_at: new Date().toISOString(),
      comment_count: 0,
      reaction_count: 0,
      has_maintainer_comment: false,
      age_days: 0,
      is_bug: false,
      repo_stars: 0,
      repo_has_contributing: false,
      repo_has_ci: false,
      llm_receptivity: 1.0,
    };

    const run = queueRun(candidate);
    console.log(`Run queued: ${run.id}`);
    const result = await executeRun(run, policy);
    console.log(`Run finished: ${result.status}`);
    if (result.pr_url) console.log(`PR: ${result.pr_url}`);
    if (result.error) console.log(`Error: ${result.error}`);
    closeDb();
  });

// --- steward runs ---
program
  .command("runs")
  .description("List recent runs")
  .option("--limit <n>", "Max runs to show", "10")
  .action(async (opts) => {
    loadPolicy();
    const runs = getRecentRuns(parseInt(opts.limit, 10));
    if (runs.length === 0) {
      console.log("No runs yet.");
    } else {
      for (const r of runs) {
        const pr = r.pr_url ? ` PR: ${r.pr_url}` : "";
        const err = r.error ? ` Error: ${r.error.slice(0, 60)}` : "";
        console.log(
          `  [${r.status.padEnd(9)}] ${r.id} ${r.candidate_repo}#${r.candidate_issue} (${r.tokens_consumed} tokens)${pr}${err}`,
        );
      }
    }
    closeDb();
  });

// --- steward pause ---
program
  .command("pause")
  .description("Pause autopilot")
  .option("--reason <reason>", "Reason for pausing", "manual")
  .action(async (opts) => {
    loadPolicy();
    pauseAutopilot(opts.reason);
    console.log(`Autopilot paused: ${opts.reason}`);
    closeDb();
  });

// --- steward resume ---
program
  .command("resume")
  .description("Resume autopilot")
  .action(async () => {
    loadPolicy();
    resumeAutopilot();
    console.log("Autopilot resumed");
    closeDb();
  });

// --- steward cancel ---
program
  .command("cancel")
  .description("Cancel a queued/running run")
  .argument("<runId>", "Run ID to cancel")
  .action(async (runId) => {
    loadPolicy();
    cancelRun(runId);
    console.log(`Run ${runId} canceled`);
    closeDb();
  });

// --- steward go (deprecated — hidden) ---
program
  .command("go", { hidden: true })
  .description("Quick start: inject budget, skip schedule check, run one tick (deprecated)")
  .requiredOption("--budget <tokens>", "Remaining token budget")
  .option("--dry-run", "Log actions without executing runs", false)
  .action(async (opts) => {
    console.error("Warning: 'steward go' is deprecated. Use 'steward discover', 'steward work', and 'steward submit' instead.");
    const policy = loadPolicy();
    // Inject manual budget
    const budget = parseInt(opts.budget, 10);
    injectManualUsage(budget, policy.weekly_target_tokens);
    console.log(`Budget injected: ${budget.toLocaleString()} tokens remaining`);

    // Always override schedule for "go" — the whole point is to run right now
    const now = new Date();
    const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
    policy.schedule = [{ day: days[now.getDay()], start: "00:00", end: "23:59" }];

    await tick(opts.dryRun);
    closeDb();
  });

// --- steward discover ---
program
  .command("discover")
  .description("Discover, score, and rank candidate issues from registry repos")
  .option("--limit <n>", "Max candidates to show", "20")
  .option("--json", "Output as JSON for scripting", false)
  .option("--repo <slug>", "Filter to a specific repo (owner/repo)")
  .action(async (opts) => {
    const policy = loadPolicy();
    const registry = await syncRegistry();
    if (!registry) {
      console.error("Failed to fetch registry");
      closeDb();
      process.exit(1);
    }

    let activeRepos = getActiveRepos(registry, policy.filters);
    if (opts.repo) {
      activeRepos = activeRepos.filter((r) => r.slug === opts.repo);
      if (activeRepos.length === 0) {
        console.error(`Repo ${opts.repo} not found in registry or filtered out by policy.`);
        closeDb();
        process.exit(1);
      }
    }

    const candidates = await discoverCandidates(activeRepos);

    const usage = getLatestUsage();
    const remainingBudget = usage
      ? getRemainingBudget(policy, usage.tokens_used)
      : policy.weekly_target_tokens - policy.weekly_min_reserve_tokens;

    const ranked = rankCandidates(candidates, policy, remainingBudget, policy.limits.max_concurrency);
    const limit = parseInt(opts.limit, 10);
    const limited = ranked.slice(0, limit);

    if (opts.json) {
      console.log(JSON.stringify({
        total: ranked.length,
        budget_remaining: remainingBudget,
        candidates: limited.map((c) => ({
          repo: c.repo_slug,
          issue: c.issue_number,
          title: c.issue_title,
          url: c.issue_url,
          score: c.score,
          est_tokens: c.est_tokens,
          labels: c.issue_labels,
        })),
      }, null, 2));
      closeDb();
      return;
    }

    console.log("");
    console.log(`Token Steward — Candidates (${ranked.length} found, showing top ${limited.length})`);
    console.log(`Budget: ~${remainingBudget.toLocaleString()} tokens remaining`);
    console.log("");
    console.log(
      ` ${"#".padStart(2)}  ${"Score".padEnd(6)}  ${"Repo".padEnd(28)}  ${"Issue".padEnd(7)}  ${"Title".padEnd(40)}  Est Tokens`,
    );

    for (let i = 0; i < limited.length; i++) {
      const c = limited[i];
      const num = String(i + 1).padStart(2);
      const score = c.score.toFixed(2).padEnd(6);
      const repo = c.repo_slug.length > 28 ? c.repo_slug.slice(0, 25) + "..." : c.repo_slug.padEnd(28);
      const issue = `#${c.issue_number}`.padEnd(7);
      const title = c.issue_title.length > 40 ? c.issue_title.slice(0, 37) + "..." : c.issue_title.padEnd(40);
      const tokens = `~${c.est_tokens.toLocaleString()}`;
      console.log(` ${num}  ${score}  ${repo}  ${issue}  ${title}  ${tokens}`);
    }

    if (limited.length > 0) {
      const top = limited[0];
      console.log("");
      console.log(`Run: steward work ${top.repo_slug}#${top.issue_number}`);
    }
    closeDb();
  });

// --- steward work ---
program
  .command("work")
  .description("Prepare a workspace for an issue and launch interactive Claude")
  .argument("<issue>", "Issue in owner/repo#123 format")
  .action(async (issueArg) => {
    const policy = loadPolicy();
    const match = issueArg.match(/^(.+?)#(\d+)$/);
    if (!match) {
      console.error("Invalid format. Use owner/repo#123");
      process.exit(1);
    }
    const [, repoSlug, issueNum] = match;
    const issueNumber = parseInt(issueNum, 10);

    const candidate = {
      repo_slug: repoSlug,
      issue_number: issueNumber,
      issue_title: "(interactive)",
      issue_url: `https://github.com/${repoSlug}/issues/${issueNum}`,
      issue_labels: [] as string[],
      category: "",
      tags: [] as string[],
      score: 1.0,
      est_tokens: policy.limits.max_tokens_per_run,
      discovered_at: new Date().toISOString(),
      comment_count: 0,
      reaction_count: 0,
      has_maintainer_comment: false,
      age_days: 0,
      is_bug: false,
      repo_stars: 0,
      repo_has_contributing: false,
      repo_has_ci: false,
      llm_receptivity: 1.0,
    };

    // 1. Record the run in DB
    const run = queueRun(candidate);
    updateRunStatus(run.id, { status: "in_progress", started_at: new Date().toISOString() });

    console.log(`Run ${run.id} started for ${repoSlug}#${issueNumber}`);
    console.log(`Branch: ${run.branch}`);

    // 2. Clone/fetch repo and create branch
    console.log("Preparing workspace...");
    const repoDir = await prepareRepo(repoSlug, run.branch);

    // 3. Fetch issue body
    console.log("Fetching issue details...");
    const issueBody = getIssueBody(repoSlug, issueNumber);

    // 4. Write context file
    writeContextFile(repoDir, run, issueBody);
    console.log("Wrote STEWARD_CONTEXT.md");

    // 5. Print summary
    console.log("");
    console.log(`Issue: ${run.issue_url}`);
    console.log(`Workspace: ${repoDir}`);
    console.log("");
    console.log("Launching Claude Code...");
    console.log("");

    // 6. Launch interactive claude
    const exitCode = launchInteractiveClaude(repoDir);

    if (exitCode !== 0 && !process.stdin.isTTY) {
      // TTY check failed inside launchInteractiveClaude
      console.log("");
      console.log("Next steps:");
      console.log(`  cd ${repoDir}`);
      console.log(`  claude`);
      console.log(`  steward submit ${run.id}`);
      closeDb();
      return;
    }

    // 7. Post-session: check if PR was already opened during the session
    console.log("");
    const existingPr = findExistingPR(run.candidate_repo, run.branch);

    if (existingPr) {
      // Claude Code (or the user) already pushed and opened a PR
      updateRunStatus(run.id, {
        status: "succeeded",
        pr_url: existingPr,
        finished_at: new Date().toISOString(),
      });
      console.log(`PR: ${existingPr}`);
      console.log("");
      console.log("Next steps:");
      console.log(`  steward discover        Pick another issue`);
      console.log(`  steward clean           Free up disk space`);
    } else {
      const hasCommits = checkForNewCommits(repoDir, run.branch);

      if (hasCommits) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question("Commits detected. Push branch and open draft PR? (Y/n) ", resolve);
        });
        rl.close();

        if (answer.toLowerCase() !== "n") {
          console.log("Pushing branch...");
          pushBranch(repoDir, run.branch);
          console.log("Opening draft PR...");
          const prUrl = openDraftPR(run, repoDir);
          updateRunStatus(run.id, {
            status: "succeeded",
            pr_url: prUrl,
            finished_at: new Date().toISOString(),
          });
          if (prUrl) {
            console.log(`PR: ${prUrl}`);
            console.log("");
            console.log("Next steps:");
            console.log(`  steward discover        Pick another issue`);
            console.log(`  steward clean           Free up disk space`);
          } else {
            console.log("PR creation failed. Retry with:");
            console.log(`  steward submit ${run.id}`);
          }
        } else {
          console.log("");
          console.log("When you're ready:");
          console.log(`  steward submit ${run.id}`);
        }
      } else {
        console.log(`No commits found on branch ${run.branch}.`);
        console.log("");
        console.log("To continue working:");
        console.log(`  cd ${repoDir} && claude`);
        console.log("");
        console.log("When ready to submit:");
        console.log(`  steward submit ${run.id}`);
      }
    }
    closeDb();
  });

// --- steward submit ---
program
  .command("submit")
  .description("Push branch and open a draft PR for a run")
  .argument("[runId]", "Run ID (defaults to most recent)")
  .action(async (runId?: string) => {
    loadPolicy();

    let run;
    if (runId) {
      const runs = getRecentRuns(100);
      run = runs.find((r) => r.id === runId);
    } else {
      run = getLatestRun();
    }

    if (!run) {
      console.error(runId ? `Run ${runId} not found.` : "No runs found.");
      closeDb();
      process.exit(1);
    }

    // Already submitted — idempotent success
    if (run.status === "succeeded" && run.pr_url) {
      console.log(`Run ${run.id} already submitted.`);
      console.log(`PR: ${run.pr_url}`);
      closeDb();
      return;
    }

    const repoDir = join("workspace", run.candidate_repo.replace("/", "__"));
    if (!existsSync(join(repoDir, ".git"))) {
      console.error(`Workspace not found at ${repoDir}`);
      closeDb();
      process.exit(1);
    }

    // Verify branch is checked out
    if (!verifyBranchCheckedOut(repoDir, run.branch)) {
      console.error(`Branch ${run.branch} is not checked out in ${repoDir}.`);
      console.error("Ensure the workspace is on the correct branch before submitting.");
      closeDb();
      process.exit(1);
    }

    const hasCommits = checkForNewCommits(repoDir, run.branch);
    if (!hasCommits) {
      console.error("No commits found on branch. Nothing to submit.");
      closeDb();
      process.exit(1);
    }

    // Check if PR already exists for this branch
    const existingPr = findExistingPR(run.candidate_repo, run.branch);
    if (existingPr) {
      console.log(`PR already exists for branch ${run.branch}.`);
      console.log(`PR: ${existingPr}`);
      updateRunStatus(run.id, {
        status: "succeeded",
        pr_url: existingPr,
        finished_at: run.finished_at ?? new Date().toISOString(),
      });
      closeDb();
      return;
    }

    console.log(`Submitting run ${run.id}: ${run.candidate_repo}#${run.candidate_issue}`);
    console.log("Pushing branch...");
    pushBranch(repoDir, run.branch);

    console.log("Opening draft PR...");
    const prUrl = openDraftPR(run, repoDir);
    updateRunStatus(run.id, {
      status: "succeeded",
      pr_url: prUrl,
      finished_at: new Date().toISOString(),
    });

    if (prUrl) console.log(`PR: ${prUrl}`);
    else console.log("PR creation may have failed. Check GitHub manually.");
    closeDb();
  });

// --- steward clean ---
program
  .command("clean")
  .description("Remove workspace clones to free disk space")
  .option("--all", "Remove all workspaces without prompting", false)
  .option("--dry-run", "Show what would be removed without deleting", false)
  .action(async (opts) => {
    const wsDir = "workspace";
    if (!existsSync(wsDir)) {
      console.log("No workspace directory found. Nothing to clean.");
      return;
    }

    const entries = readdirSync(wsDir).filter((e) => {
      const full = join(wsDir, e);
      return statSync(full).isDirectory() && existsSync(join(full, ".git"));
    });

    if (entries.length === 0) {
      console.log("No workspace clones found.");
      return;
    }

    // Show sizes
    let totalBytes = 0;
    const sizes: Array<{ name: string; path: string; size: string; bytes: number }> = [];
    for (const entry of entries) {
      const full = join(wsDir, entry);
      const bytes = getDirSize(full);
      totalBytes += bytes;
      sizes.push({ name: entry.replace("__", "/"), path: full, size: formatBytes(bytes), bytes });
    }

    console.log("");
    console.log(`Workspaces (${sizes.length}):`);
    for (const s of sizes) {
      console.log(`  ${s.size.padStart(8)}  ${s.name}`);
    }
    console.log(`  ${formatBytes(totalBytes).padStart(8)}  total`);
    console.log("");

    if (opts.dryRun) {
      console.log("Dry run — nothing removed.");
      return;
    }

    if (!opts.all) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question("Remove all workspaces? (y/N) ", resolve);
      });
      rl.close();
      if (answer.toLowerCase() !== "y") {
        console.log("Canceled.");
        return;
      }
    }

    for (const s of sizes) {
      rmSync(s.path, { recursive: true, force: true });
      console.log(`  Removed ${s.name} (${s.size})`);
    }
    console.log("Done.");
  });

function getDirSize(dir: string): number {
  let size = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(full);
      } else {
        size += statSync(full).size;
      }
    }
  } catch { /* permission errors, symlinks, etc */ }
  return size;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

// --- steward export ---
program
  .command("export")
  .description("Export registry and scored issues as JSON for the web app")
  .option("--out-dir <path>", "Directory to write JSON files (default: stdout)")
  .action(async (opts) => {
    const result = await runExport();

    if (opts.outDir) {
      writeExportFiles(result, opts.outDir);
      console.log(`Exported ${result.registry.length} repos and ${result.scoredIssues.length} scored issues to ${opts.outDir}`);
    } else {
      // Write to stdout as a single JSON object
      console.log(JSON.stringify({
        registry: {
          generated_at: new Date().toISOString(),
          repo_count: result.registry.length,
          repositories: result.registry,
        },
        scored_issues: {
          generated_at: new Date().toISOString(),
          issue_count: result.scoredIssues.length,
          issues: result.scoredIssues,
        },
      }, null, 2));
    }
    closeDb();
  });

// --- steward stats ---
program
  .command("stats")
  .description("Show contribution statistics")
  .option("--json", "Output as JSON for scripting", false)
  .action(async (opts) => {
    const db = getDb();
    const excluded = `('queued', 'running', 'in_progress')`;

    // Summary stats
    const summary = db.prepare(`
      SELECT
        COUNT(*) AS total_runs,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'no_changes' THEN 1 ELSE 0 END) AS no_changes,
        SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled,
        SUM(CASE WHEN pr_url IS NOT NULL THEN 1 ELSE 0 END) AS prs_opened,
        COUNT(DISTINCT candidate_repo) AS unique_repos,
        COUNT(DISTINCT candidate_issue || ':' || candidate_repo) AS unique_issues,
        SUM(tokens_consumed) AS total_tokens,
        MIN(created_at) AS first_run,
        MAX(created_at) AS last_run
      FROM runs
      WHERE status NOT IN ${excluded}
    `).get() as {
      total_runs: number;
      succeeded: number;
      failed: number;
      no_changes: number;
      canceled: number;
      prs_opened: number;
      unique_repos: number;
      unique_issues: number;
      total_tokens: number;
      first_run: string | null;
      last_run: string | null;
    };

    if (summary.total_runs === 0) {
      if (opts.json) {
        console.log(JSON.stringify({ summary: { total_runs: 0 }, repos: [], latest_prs: [] }, null, 2));
      } else {
        console.log("");
        console.log("No contributions yet.");
        console.log("");
        console.log("Get started:");
        console.log("  steward discover    Find issues to work on");
        console.log("  steward work        Start working on an issue");
      }
      closeDb();
      return;
    }

    // Per-repo breakdown
    const repos = db.prepare(`
      SELECT
        candidate_repo AS repo,
        COUNT(*) AS runs,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN pr_url IS NOT NULL THEN 1 ELSE 0 END) AS prs,
        SUM(tokens_consumed) AS tokens
      FROM runs
      WHERE status NOT IN ${excluded}
      GROUP BY candidate_repo
      ORDER BY runs DESC
    `).all() as Array<{
      repo: string;
      runs: number;
      succeeded: number;
      prs: number;
      tokens: number;
    }>;

    // Latest PRs
    const latestPrs = db.prepare(`
      SELECT candidate_repo AS repo, candidate_issue AS issue, pr_url
      FROM runs
      WHERE pr_url IS NOT NULL AND status NOT IN ${excluded}
      ORDER BY created_at DESC
      LIMIT 5
    `).all() as Array<{
      repo: string;
      issue: number;
      pr_url: string;
    }>;

    // Streak: consecutive succeeded from most recent finished run
    const recentStatuses = db.prepare(`
      SELECT status FROM runs
      WHERE status NOT IN ${excluded}
      ORDER BY created_at DESC
    `).all() as Array<{ status: string }>;

    let streak = 0;
    for (const r of recentStatuses) {
      if (r.status === "succeeded") streak++;
      else break;
    }

    if (opts.json) {
      console.log(JSON.stringify({
        summary: {
          total_runs: summary.total_runs,
          succeeded: summary.succeeded,
          failed: summary.failed,
          no_changes: summary.no_changes,
          canceled: summary.canceled,
          prs_opened: summary.prs_opened,
          unique_repos: summary.unique_repos,
          unique_issues: summary.unique_issues,
          total_tokens: summary.total_tokens,
          first_run: summary.first_run,
          last_run: summary.last_run,
          success_rate: parseFloat(((summary.succeeded / summary.total_runs) * 100).toFixed(1)),
          streak,
        },
        repos,
        latest_prs: latestPrs,
      }, null, 2));
      closeDb();
      return;
    }

    const successRate = ((summary.succeeded / summary.total_runs) * 100).toFixed(1);

    console.log("");
    console.log("Token Steward — Contribution Stats");
    console.log("====================================");
    console.log("");
    console.log(
      `  Total runs       ${String(summary.total_runs).padEnd(12)}` +
      `Success rate     ${successRate}%`
    );
    console.log(
      `  PRs opened       ${String(summary.prs_opened).padEnd(12)}` +
      `Unique repos      ${summary.unique_repos}`
    );
    console.log(
      `  Issues worked    ${String(summary.unique_issues).padEnd(12)}` +
      `Tokens used      ${summary.total_tokens.toLocaleString()}`
    );
    console.log("");
    const firstDate = summary.first_run ? summary.first_run.slice(0, 10) : "—";
    const lastDate = summary.last_run ? summary.last_run.slice(0, 10) : "—";
    console.log(
      `  First run    ${firstDate.padEnd(16)}` +
      `Latest run    ${lastDate}`
    );
    if (streak > 0) {
      console.log(`  Current streak   ${streak} succeeded`);
    }

    console.log("");
    console.log("Per-repo breakdown");
    console.log("------------------");
    console.log(
      `  ${"Repo".padEnd(30)}  ${"Runs".padStart(4)}  ${"OK".padStart(3)}  ${"PRs".padStart(4)}  ${"Tokens".padStart(10)}`
    );
    for (const r of repos) {
      const name = r.repo.length > 30 ? r.repo.slice(0, 27) + "..." : r.repo.padEnd(30);
      console.log(
        `  ${name}  ${String(r.runs).padStart(4)}  ${String(r.succeeded).padStart(3)}  ${String(r.prs).padStart(4)}  ${r.tokens.toLocaleString().padStart(10)}`
      );
    }

    if (latestPrs.length > 0) {
      console.log("");
      console.log("Latest PRs");
      console.log("----------");
      for (const pr of latestPrs) {
        const label = `${pr.repo}#${pr.issue}`;
        console.log(`  ${label.padEnd(40)}  ${pr.pr_url}`);
      }
    }
    console.log("");
    closeDb();
  });

program.parse();
