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
import { closeDb } from "./db.js";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
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

    // 7. Post-session: check for commits
    console.log("");
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
      console.log("");
      console.log("To check all runs:");
      console.log("  steward runs");
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

program.parse();
