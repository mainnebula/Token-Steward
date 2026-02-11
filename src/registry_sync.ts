import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { getDb } from "./db.js";
import { emitEvent } from "./audit_log.js";
import type { RegistrySnapshot, RegistryRepo } from "./models.js";

const SYMPHONY_URL =
  "https://raw.githubusercontent.com/pedramamini/Maestro/main/symphony-registry.json";
const LOCAL_REGISTRY_PATH = "config/registry.yaml";
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Load the local registry from config/registry.yaml.
 */
function loadLocalRegistry(): RegistryRepo[] {
  if (!existsSync(LOCAL_REGISTRY_PATH)) return [];

  const raw = readFileSync(LOCAL_REGISTRY_PATH, "utf-8");
  const data = parseYaml(raw);
  if (!data?.repositories || !Array.isArray(data.repositories)) return [];

  return data.repositories.map((r: any) => ({
    slug: r.slug,
    name: r.name ?? r.slug,
    description: r.description ?? "",
    url: r.url ?? `https://github.com/${r.slug}`,
    category: r.category ?? "general",
    tags: r.tags ?? [],
    issue_labels: r.issue_labels ?? ["good first issue", "help wanted"],
    maintainer: r.maintainer ?? { name: "", url: "" },
    isActive: r.isActive ?? true,
    featured: r.featured ?? false,
    addedAt: r.addedAt ?? new Date().toISOString().slice(0, 10),
  }));
}

/**
 * Fetch the Symphony remote registry from GitHub, with TTL-based caching.
 */
async function fetchSymphonyRegistry(): Promise<RegistryRepo[]> {
  const cached = getCachedRegistry();

  // If cache is fresh, return it
  if (cached) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < TTL_MS) return cached.repositories;
  }

  try {
    const resp = await fetch(SYMPHONY_URL, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();
    const repos: RegistryRepo[] = (data.repositories ?? []).map((r: any) => ({
      ...r,
      issue_labels: r.issue_labels ?? ["good first issue", "help wanted"],
    }));

    const snapshot: RegistrySnapshot = {
      schemaVersion: data.schemaVersion,
      lastUpdated: data.lastUpdated,
      repositories: repos,
      fetchedAt: new Date().toISOString(),
    };

    // Cache in DB
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO registry_cache (id, data, fetched_at)
      VALUES (1, ?, ?)
    `).run(JSON.stringify(snapshot), snapshot.fetchedAt);

    return repos;
  } catch (err) {
    emitEvent("registry_stale", {
      error: String(err),
      cache_age_hours: cached
        ? (Date.now() - new Date(cached.fetchedAt).getTime()) / 3600000
        : null,
    });

    // Use stale cache if within 24h
    if (cached) {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < MAX_STALE_MS) return cached.repositories;
    }

    return [];
  }
}

/**
 * Sync all registry sources (local + Symphony remote).
 * Local entries take precedence on slug collisions.
 */
export async function syncRegistry(): Promise<RegistrySnapshot | null> {
  const local = loadLocalRegistry();
  const remote = await fetchSymphonyRegistry();

  // Merge: local wins on slug collision
  const bySlug = new Map<string, RegistryRepo>();
  for (const r of remote) bySlug.set(r.slug, r);
  for (const r of local) bySlug.set(r.slug, r); // local overrides

  const merged = Array.from(bySlug.values());

  if (merged.length === 0) return null;

  emitEvent("registry_sync", {
    local_count: local.length,
    remote_count: remote.length,
    merged_count: merged.length,
  });

  return {
    schemaVersion: "2.0",
    lastUpdated: new Date().toISOString(),
    repositories: merged,
    fetchedAt: new Date().toISOString(),
  };
}

function getCachedRegistry(): RegistrySnapshot | null {
  const db = getDb();
  const row = db
    .prepare("SELECT data, fetched_at FROM registry_cache WHERE id = 1")
    .get() as any;
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

/**
 * Get active repos from the registry, filtered by policy.
 */
export function getActiveRepos(
  registry: RegistrySnapshot,
  filters: {
    categories_allow: string[];
    tags_allow: string[];
    repos_allow: string[];
    repos_deny: string[];
  },
): RegistryRepo[] {
  return registry.repositories.filter((repo) => {
    if (!repo.isActive) return false;
    if (filters.repos_deny.includes(repo.slug)) return false;
    if (
      filters.repos_allow.length > 0 &&
      !filters.repos_allow.includes(repo.slug)
    )
      return false;
    if (
      filters.categories_allow.length > 0 &&
      !filters.categories_allow.includes(repo.category)
    )
      return false;
    if (
      filters.tags_allow.length > 0 &&
      !repo.tags.some((t) => filters.tags_allow.includes(t))
    )
      return false;
    return true;
  });
}
