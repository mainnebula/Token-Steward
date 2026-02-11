import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { emitEvent } from "./audit_log.js";
import type { RegistrySnapshot, RegistryRepo } from "./models.js";

const LOCAL_REGISTRY_PATH = "config/registry.yaml";

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
 * Load the registry from config/registry.yaml.
 */
export async function syncRegistry(): Promise<RegistrySnapshot | null> {
  const repos = loadLocalRegistry();

  if (repos.length === 0) return null;

  emitEvent("registry_sync", {
    repo_count: repos.length,
  });

  return {
    schemaVersion: "2.0",
    lastUpdated: new Date().toISOString(),
    repositories: repos,
    fetchedAt: new Date().toISOString(),
  };
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
