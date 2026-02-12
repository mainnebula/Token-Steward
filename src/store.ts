import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname } from "node:path";
import type { Run, RunStatus, UsageSnapshot } from "./models.js";

const DATA_PATH = "state/data.json";

// --- Types ---

export interface GuardrailData {
  paused: boolean;
  pause_reason: string | null;
  consecutive_ci_failures: number;
  last_usage_poll: string | null;
}

interface StoreData {
  runs: Run[];
  usage_snapshots: UsageSnapshot[];
  guardrail_state: GuardrailData;
}

export interface GetRunsOptions {
  statuses?: RunStatus[];
  excludeStatuses?: RunStatus[];
  repo?: string;
  issue?: number;
  orderBy?: "created_at_desc" | "active_first" | "finished_at_desc";
  limit?: number;
}

// --- Singleton ---

let store: StoreData | null = null;
let testMode = false;

function defaultData(): StoreData {
  return {
    runs: [],
    usage_snapshots: [],
    guardrail_state: {
      paused: false,
      pause_reason: null,
      consecutive_ci_failures: 0,
      last_usage_poll: null,
    },
  };
}

function getStore(): StoreData {
  if (!store) {
    mkdirSync(dirname(DATA_PATH), { recursive: true });
    if (existsSync(DATA_PATH)) {
      store = JSON.parse(readFileSync(DATA_PATH, "utf-8"));
    } else {
      migrateFromSqlite();
      if (!store) {
        store = defaultData();
      }
      save();
    }
  }
  return store!;
}

function save(): void {
  if (testMode) return;
  const data = JSON.stringify(store, null, 2) + "\n";
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  const tmpFile = `${DATA_PATH}.tmp.${process.pid}`;
  writeFileSync(tmpFile, data, "utf-8");
  renameSync(tmpFile, DATA_PATH);
}

// --- Lifecycle ---

export function closeStore(): void {
  if (store) {
    save();
    store = null;
  }
}

// --- Runs ---

export function addRun(run: Run): void {
  getStore().runs.push({ ...run });
  save();
}

export function updateRun(id: string, updates: Partial<Run>): void {
  const s = getStore();
  const run = s.runs.find((r) => r.id === id);
  if (run) {
    Object.assign(run, updates);
    save();
  }
}

export function getRuns(opts?: GetRunsOptions): Run[] {
  let result = getStore().runs.map((r) => ({ ...r }));

  if (opts?.statuses) {
    const allowed = new Set(opts.statuses);
    result = result.filter((r) => allowed.has(r.status));
  }
  if (opts?.excludeStatuses) {
    const excluded = new Set(opts.excludeStatuses);
    result = result.filter((r) => !excluded.has(r.status));
  }
  if (opts?.repo) {
    result = result.filter((r) => r.candidate_repo === opts.repo);
  }
  if (opts?.issue !== undefined) {
    result = result.filter((r) => r.candidate_issue === opts.issue);
  }

  const orderBy = opts?.orderBy ?? "created_at_desc";
  if (orderBy === "created_at_desc") {
    result.sort((a, b) => b.created_at.localeCompare(a.created_at));
  } else if (orderBy === "active_first") {
    const activeStatuses = new Set<RunStatus>(["in_progress", "running"]);
    result.sort((a, b) => {
      const aP = activeStatuses.has(a.status) ? 0 : 1;
      const bP = activeStatuses.has(b.status) ? 0 : 1;
      if (aP !== bP) return aP - bP;
      return b.created_at.localeCompare(a.created_at);
    });
  } else if (orderBy === "finished_at_desc") {
    result.sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""));
  }

  if (opts?.limit) {
    result = result.slice(0, opts.limit);
  }

  return result;
}

export function getTodayRunCount(): number {
  const today = new Date().toISOString().slice(0, 10);
  return getStore().runs.filter(
    (r) => r.created_at >= today && r.status !== "canceled",
  ).length;
}

// --- Usage ---

export function addUsageSnapshot(snapshot: UsageSnapshot): void {
  getStore().usage_snapshots.push({ ...snapshot });
  save();
}

export function getLatestSnapshot(): UsageSnapshot | null {
  const snapshots = getStore().usage_snapshots;
  if (snapshots.length === 0) return null;
  return { ...snapshots.reduce((l, s) => (s.timestamp > l.timestamp ? s : l)) };
}

// --- Guardrails ---

export function getGuardrailData(): GuardrailData {
  return { ...getStore().guardrail_state };
}

export function updateGuardrailState(updates: Partial<GuardrailData>): void {
  Object.assign(getStore().guardrail_state, updates);
  save();
}

export function incrementCiFailures(): void {
  getStore().guardrail_state.consecutive_ci_failures += 1;
  save();
}

export function resetCiFailures(): void {
  getStore().guardrail_state.consecutive_ci_failures = 0;
  save();
}

// --- Migration ---

function migrateFromSqlite(): void {
  const dbPath = "state/runtime.db";
  if (!existsSync(dbPath)) return;

  try {
    const query = (sql: string): string =>
      execSync(`sqlite3 -json "${dbPath}" "${sql}"`, {
        encoding: "utf-8",
        timeout: 10000,
      }).trim();

    const runsRaw = query("SELECT * FROM runs");
    const usageRaw = query("SELECT * FROM usage_snapshots");
    const guardrailRaw = query("SELECT * FROM guardrail_state WHERE id = 1");

    const runs: Run[] = (runsRaw ? JSON.parse(runsRaw) : []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      candidate_repo: r.candidate_repo as string,
      candidate_issue: r.candidate_issue as number,
      issue_url: r.issue_url as string,
      branch: r.branch as string,
      status: r.status as RunStatus,
      tokens_consumed: (r.tokens_consumed as number) ?? 0,
      pr_url: (r.pr_url as string) ?? null,
      error: (r.error as string) ?? null,
      started_at: (r.started_at as string) ?? null,
      finished_at: (r.finished_at as string) ?? null,
      created_at: r.created_at as string,
    }));

    const usageSnapshots: UsageSnapshot[] = (usageRaw ? JSON.parse(usageRaw) : []).map(
      (s: Record<string, unknown>) => ({
        timestamp: s.timestamp as string,
        tokens_used: s.tokens_used as number,
        tokens_quota: s.tokens_quota as number,
        tokens_remaining: s.tokens_remaining as number,
        period_start: s.period_start as string,
        period_end: s.period_end as string,
        source: s.source as UsageSnapshot["source"],
      }),
    );

    const guardrailRows = guardrailRaw ? JSON.parse(guardrailRaw) : [];
    const g = guardrailRows[0] as Record<string, unknown> | undefined;

    store = {
      runs,
      usage_snapshots: usageSnapshots,
      guardrail_state: g
        ? {
            paused: !!g.paused,
            pause_reason: (g.pause_reason as string) ?? null,
            consecutive_ci_failures: (g.consecutive_ci_failures as number) ?? 0,
            last_usage_poll: (g.last_usage_poll as string) ?? null,
          }
        : defaultData().guardrail_state,
    };

    console.log(
      `Migrated ${runs.length} runs and ${usageSnapshots.length} usage snapshots from SQLite`,
    );
  } catch {
    console.warn(
      "Could not migrate from SQLite (sqlite3 CLI not available). Starting fresh.",
    );
    console.warn("Old database preserved at state/runtime.db");
  }
}

// --- Testing ---

export function _resetForTesting(): void {
  store = defaultData();
  testMode = true;
}
