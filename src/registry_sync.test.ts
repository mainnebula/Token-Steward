import { describe, it, expect } from "vitest";
import { getActiveRepos } from "./registry_sync.js";
import type { RegistrySnapshot, RegistryRepo } from "./models.js";

function makeRepo(overrides: Partial<RegistryRepo> = {}): RegistryRepo {
  return {
    slug: "owner/repo",
    name: "Repo",
    description: "A test repo",
    url: "https://github.com/owner/repo",
    category: "developer-tools",
    tags: ["cli", "testing"],
    maintainer: { name: "Test", url: "https://github.com/test" },
    isActive: true,
    featured: false,
    addedAt: "2025-01-01",
    ...overrides,
  };
}

function makeSnapshot(repos: RegistryRepo[]): RegistrySnapshot {
  return {
    schemaVersion: "1",
    lastUpdated: "2025-01-01",
    repositories: repos,
    fetchedAt: new Date().toISOString(),
  };
}

describe("getActiveRepos", () => {
  const defaultFilters = {
    categories_allow: [],
    tags_allow: [],
    repos_allow: [],
    repos_deny: [],
  };

  it("returns only active repos", () => {
    const snapshot = makeSnapshot([
      makeRepo({ slug: "a/active", isActive: true }),
      makeRepo({ slug: "b/inactive", isActive: false }),
    ]);
    const result = getActiveRepos(snapshot, defaultFilters);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("a/active");
  });

  it("filters by category allowlist", () => {
    const snapshot = makeSnapshot([
      makeRepo({ slug: "a/a", category: "developer-tools" }),
      makeRepo({ slug: "b/b", category: "security" }),
      makeRepo({ slug: "c/c", category: "games" }),
    ]);
    const result = getActiveRepos(snapshot, {
      ...defaultFilters,
      categories_allow: ["developer-tools", "security"],
    });
    expect(result).toHaveLength(2);
  });

  it("filters by repo denylist", () => {
    const snapshot = makeSnapshot([
      makeRepo({ slug: "a/good" }),
      makeRepo({ slug: "b/bad" }),
    ]);
    const result = getActiveRepos(snapshot, {
      ...defaultFilters,
      repos_deny: ["b/bad"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("a/good");
  });

  it("filters by repo allowlist", () => {
    const snapshot = makeSnapshot([
      makeRepo({ slug: "a/allowed" }),
      makeRepo({ slug: "b/notallowed" }),
    ]);
    const result = getActiveRepos(snapshot, {
      ...defaultFilters,
      repos_allow: ["a/allowed"],
    });
    expect(result).toHaveLength(1);
  });

  it("filters by tags allowlist", () => {
    const snapshot = makeSnapshot([
      makeRepo({ slug: "a/a", tags: ["cli", "testing"] }),
      makeRepo({ slug: "b/b", tags: ["web"] }),
    ]);
    const result = getActiveRepos(snapshot, {
      ...defaultFilters,
      tags_allow: ["cli"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("a/a");
  });

  it("returns all active when no filters set", () => {
    const snapshot = makeSnapshot([
      makeRepo({ slug: "a/a" }),
      makeRepo({ slug: "b/b" }),
      makeRepo({ slug: "c/c" }),
    ]);
    const result = getActiveRepos(snapshot, defaultFilters);
    expect(result).toHaveLength(3);
  });
});
