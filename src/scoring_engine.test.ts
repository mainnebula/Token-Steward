import { describe, it, expect } from "vitest";
import { scoreCandidate, rankCandidates } from "./scoring_engine.js";
import type { Candidate, Policy } from "./models.js";

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    repo_slug: "owner/repo",
    issue_number: 1,
    issue_title: "A reasonably descriptive issue title here",
    issue_url: "https://github.com/owner/repo/issues/1",
    issue_labels: [],
    category: "developer-tools",
    tags: ["cli"],
    score: 0,
    est_tokens: 0,
    discovered_at: new Date().toISOString(),
    comment_count: 0,
    reaction_count: 0,
    has_maintainer_comment: false,
    age_days: 14,
    is_bug: false,
    repo_stars: 500,
    repo_has_contributing: true,
    repo_has_ci: true,
    llm_receptivity: 0.7,
    ...overrides,
  };
}

function makePolicy(): Policy {
  return {
    enabled: true,
    timezone: "UTC",
    weekly_target_tokens: 500000,
    weekly_min_reserve_tokens: 25000,
    schedule: [{ day: "FRI", start: "18:00", end: "23:59" }],
    filters: {
      categories_allow: [],
      tags_allow: [],
      repos_allow: [],
      repos_deny: [],
      min_confidence: 0.3,
    },
    limits: {
      max_concurrency: 2,
      max_tokens_per_run: 60000,
      max_runs_per_day: 6,
    },
    safety: {
      pause_on_ci_failures_consecutive: 3,
      pause_on_failure_rate_percent: 50,
      max_stale_usage_minutes: 30,
    },
  } as Policy;
}

describe("scoreCandidate", () => {
  it("gives a score between 0 and 1", () => {
    const scored = scoreCandidate(makeCandidate(), makePolicy(), 30000);
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.score).toBeLessThanOrEqual(1);
  });

  it("boosts score for high reaction count (reach)", () => {
    const base = scoreCandidate(makeCandidate({ reaction_count: 0 }), makePolicy(), 30000);
    const popular = scoreCandidate(makeCandidate({ reaction_count: 25 }), makePolicy(), 30000);
    expect(popular.score).toBeGreaterThan(base.score);
  });

  it("boosts score for bugs (impact)", () => {
    const feature = scoreCandidate(makeCandidate({ is_bug: false }), makePolicy(), 30000);
    const bug = scoreCandidate(makeCandidate({ is_bug: true }), makePolicy(), 30000);
    expect(bug.score).toBeGreaterThan(feature.score);
  });

  it("boosts score for maintainer engagement (impact)", () => {
    const noMaintainer = scoreCandidate(makeCandidate({ has_maintainer_comment: false }), makePolicy(), 30000);
    const withMaintainer = scoreCandidate(makeCandidate({ has_maintainer_comment: true }), makePolicy(), 30000);
    expect(withMaintainer.score).toBeGreaterThan(noMaintainer.score);
  });

  it("boosts score for high LLM receptivity (confidence)", () => {
    const lowReceptivity = scoreCandidate(makeCandidate({ llm_receptivity: 0.3 }), makePolicy(), 30000);
    const highReceptivity = scoreCandidate(makeCandidate({ llm_receptivity: 0.9 }), makePolicy(), 30000);
    expect(highReceptivity.score).toBeGreaterThan(lowReceptivity.score);
  });

  it("boosts score for approachable labels (confidence)", () => {
    const noLabels = scoreCandidate(makeCandidate({ issue_labels: [] }), makePolicy(), 30000);
    const approachable = scoreCandidate(
      makeCandidate({ issue_labels: ["good first issue"] }),
      makePolicy(),
      30000,
    );
    expect(approachable.score).toBeGreaterThan(noLabels.score);
  });

  it("prefers fresh issues over old ones (effort)", () => {
    const fresh = scoreCandidate(makeCandidate({ age_days: 3 }), makePolicy(), 30000);
    const stale = scoreCandidate(makeCandidate({ age_days: 200 }), makePolicy(), 30000);
    expect(fresh.score).toBeGreaterThan(stale.score);
  });

  it("estimates fewer tokens for small/easy labels", () => {
    const normal = scoreCandidate(makeCandidate(), makePolicy(), 30000);
    const small = scoreCandidate(
      makeCandidate({ issue_labels: ["small"] }),
      makePolicy(),
      30000,
    );
    expect(small.est_tokens).toBeLessThan(normal.est_tokens);
  });
});

describe("rankCandidates", () => {
  it("returns sorted candidates above confidence threshold", () => {
    const candidates = [
      makeCandidate({ repo_slug: "a/a", issue_number: 1, reaction_count: 20, is_bug: true }),
      makeCandidate({ repo_slug: "b/b", issue_number: 2, reaction_count: 0 }),
      makeCandidate({ repo_slug: "c/c", issue_number: 3, reaction_count: 10, has_maintainer_comment: true }),
    ];
    const ranked = rankCandidates(candidates, makePolicy(), 100000, 2);
    expect(ranked.length).toBeGreaterThan(0);
    for (const c of ranked) {
      expect(c.score).toBeGreaterThan(0);
    }
  });

  it("filters out below min_confidence", () => {
    const policy = makePolicy();
    policy.filters.min_confidence = 0.99;
    const candidates = [makeCandidate({ issue_title: "x", llm_receptivity: 0.1 })];
    const ranked = rankCandidates(candidates, policy, 100000, 2);
    expect(ranked.length).toBe(0);
  });

  it("diversifies across repos", () => {
    const candidates = [
      makeCandidate({ repo_slug: "a/a", issue_number: 1, reaction_count: 30 }),
      makeCandidate({ repo_slug: "a/a", issue_number: 2, reaction_count: 25 }),
      makeCandidate({ repo_slug: "b/b", issue_number: 3, reaction_count: 0 }),
    ];
    const ranked = rankCandidates(candidates, makePolicy(), 100000, 3);
    if (ranked.length >= 3) {
      const bIndex = ranked.findIndex((c) => c.repo_slug === "b/b");
      const secondAIndex = ranked.findIndex(
        (c, i) => c.repo_slug === "a/a" && ranked.findIndex((r) => r.repo_slug === "a/a") !== i,
      );
      if (bIndex !== -1 && secondAIndex !== -1) {
        expect(bIndex).toBeLessThan(secondAIndex);
      }
    }
  });
});
