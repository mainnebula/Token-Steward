#!/usr/bin/env bash
#
# seed-feed.sh — Bootstrap the feed branch with a starter feed.
#
# Run this once locally to create the feed branch and push an initial feed.
# After this, the GitHub Actions workflow takes over on its 6-hour schedule.
#
# Requires: gh CLI (authenticated), jq, git
# Compatible with bash 3.x (macOS default)
#
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
FEED_DIR="feed"
FEED_FILE="${FEED_DIR}/feed.json"
MIN_STARS=100

echo "Seeding Token Steward feed..."

# --- Phase 1: Search for issues ---
ISSUES_RAW=$(mktemp)
echo "[]" > "$ISSUES_RAW"

# Use gh search issues (better rate limit handling than raw API)
searches=(
  '--label=good first issue --language=TypeScript'
  '--label=good first issue --language=Python'
  '--label=help wanted --language=Go'
  '--label=good first issue --language=Rust'
  '--label=good first issue --language=JavaScript'
  '--label=enhancement --language=TypeScript'
)

for search_args in "${searches[@]}"; do
  echo "  Searching: $search_args"
  # shellcheck disable=SC2086
  result=$(gh search issues $search_args \
    --state=open --sort=reactions --limit=15 \
    --json number,title,url,repository,labels,commentsCount,createdAt,assignees \
    2>/dev/null || echo "[]")

  # Merge into accumulator
  jq -s '.[0] + .[1]' "$ISSUES_RAW" <(echo "$result") > "${ISSUES_RAW}.tmp"
  mv "${ISSUES_RAW}.tmp" "$ISSUES_RAW"
  sleep 2
done

# Dedupe and filter out assigned
jq '[. | unique_by(.url) | .[] | select((.assignees | length) == 0)]' "$ISSUES_RAW" > "${ISSUES_RAW}.filtered"
total=$(jq 'length' "${ISSUES_RAW}.filtered")
echo "  Found $total unique unassigned issues"

# --- Phase 2: Batch-fetch repo metadata via GraphQL ---
echo ""
echo "  Fetching repo metadata..."

REPOS=$(jq -r '[.[].repository.nameWithOwner] | unique | .[]' "${ISSUES_RAW}.filtered")
REPO_COUNT=$(echo "$REPOS" | grep -c . || echo "0")

# Build GraphQL query
QUERY="query {"
INDEX=0
REPO_MAP_FILE=$(mktemp)

while IFS= read -r repo; do
  [[ -z "$repo" ]] && continue
  owner="${repo%%/*}"
  name="${repo##*/}"
  alias="r${INDEX}"
  printf '%s\t%s\n' "$repo" "$alias" >> "$REPO_MAP_FILE"
  QUERY="${QUERY}
  ${alias}: repository(owner: \"${owner}\", name: \"${name}\") {
    nameWithOwner
    stargazerCount
    primaryLanguage { name }
    contributing: object(expression: \"HEAD:CONTRIBUTING.md\") { __typename }
    workflows: object(expression: \"HEAD:.github/workflows\") { __typename }
  }"
  INDEX=$((INDEX + 1))
done <<< "$REPOS"
QUERY="${QUERY}}"

REPO_META_FILE=$(mktemp)
gh api graphql -f query="$QUERY" --jq '.data' > "$REPO_META_FILE" 2>/dev/null || echo '{}' > "$REPO_META_FILE"

# Build a clean lookup: {repo_name: {stars, language, has_contributing, has_ci}}
REPO_LOOKUP=$(mktemp)
jq '[to_entries[].value | select(.nameWithOwner != null)] | map({
  key: .nameWithOwner,
  value: {
    stars: (.stargazerCount // 0),
    language: (.primaryLanguage.name // "unknown"),
    has_contributing: (.contributing != null),
    has_ci: (.workflows != null)
  }
}) | from_entries' "$REPO_META_FILE" > "$REPO_LOOKUP"

echo "  Fetched metadata for $REPO_COUNT repos (1 GraphQL call)"

# --- Phase 3: Enrich and score in one jq pass ---
echo ""
echo "  Enriching and scoring..."

ISSUES_SCORED=$(mktemp)
now_epoch=$(date +%s)

jq --argjson min_stars "$MIN_STARS" \
   --argjson now "$now_epoch" \
   --slurpfile lookup "$REPO_LOOKUP" '

  # Scoring functions (aligned with src/scoring_engine.ts)
  def score_reach:
    0.3
    + (if .comment_count >= 2 then 0.10 else 0 end)
    + (if .comment_count >= 5 then 0.10 else 0 end)
    + (if .stars >= 1000 then 0.05 else 0 end)
    + (if .stars >= 10000 then 0.05 else 0 end)
    | [., 1] | min;

  def score_impact:
    0.4
    + (if .is_bug then 0.20 else 0 end)
    + (if .comment_count >= 3 then 0.15 else 0 end)
    + (if .category == "documentation" then 0.10 else 0 end)
    + (if .category == "security" then 0.15 else 0 end)
    | [., 1] | min;

  def score_confidence:
    0.3
    + (.llm_receptivity * 0.30)
    + (if (.labels | any(test("good.first.issue|help.wanted|beginner|easy|small|docs|enhancement"; "i"))) then 0.15 else 0 end)
    + (if .has_contributing then 0.05 else 0 end)
    + (if .has_ci then 0.10 else 0 end)
    + (if (.title | length) > 15 then 0.05 else 0 end)
    + (if (.title | length) > 40 then 0.05 else 0 end)
    | [., 1] | min;

  def score_effort:
    0.5
    + (if .age_days < 7 then 0.15
       elif .age_days < 30 then 0.10
       elif .age_days > 180 then -0.10
       else 0 end)
    + (if (.labels | any(test("small|easy|trivial|minor"; "i"))) then 0.15 else 0 end)
    + (if (.labels | any(test("large|complex|major|epic"; "i"))) then -0.15 else 0 end)
    | [., 1] | min | [., 0] | max;

  $lookup[0] as $meta |

  [.[] |
    # Extract repo name and look up metadata
    .repository.nameWithOwner as $repo |
    ($meta[$repo] // null) as $rm |
    select($rm != null) |
    select($rm.stars >= $min_stars) |

    # Build enriched issue
    {
      repo: $repo,
      number: .number,
      title: .title,
      url: .url,
      created_at: .createdAt,
      labels: [.labels[].name],
      language: $rm.language,
      stars: $rm.stars,
      comment_count: (.commentsCount // 0),
      age_days: ((($now - (.createdAt | fromdateiso8601)) / 86400) | floor),
      is_bug: ([.labels[].name] | any(test("bug|defect|broken|regression"; "i"))),
      is_feature: ([.labels[].name] | any(test("enhancement|feature|proposal|rfc"; "i"))),
      category: (
        if ([.labels[].name] | any(test("doc|documentation|docs"; "i"))) then "documentation"
        elif ([.labels[].name] | any(test("security|vulnerability|cve"; "i"))) then "security"
        else "general" end
      ),
      surface: (
        if ([.labels[].name] | any(test("enhancement|feature|proposal|rfc"; "i"))) and
           ([.labels[].name] | any(test("bug|defect|broken|regression"; "i")) | not)
        then "feature" else "bugfix" end
      ),
      has_contributing: $rm.has_contributing,
      has_ci: $rm.has_ci,
      llm_receptivity: (
        0.5
        + (if $rm.has_ci then 0.10 else 0 end)
        + (if $rm.has_contributing then 0.10 else 0 end)
        + (if $rm.stars >= 1000 then 0.05 else 0 end)
        + (if $rm.stars >= 10000 then 0.05 else 0 end)
        | [., 1] | min | . * 100 | round / 100
      ),
      action: (
        if ([.labels[].name] | any(test("large|complex|major|epic"; "i"))) then "propose"
        else "fix" end
      ),
      pr: null
    }
  ] |

  # Score each issue
  [.[] | . + {
    score: (
      (score_reach * 0.20) + (score_impact * 0.25) +
      (score_confidence * 0.30) + (score_effort * 0.25)
      | . * 100 | round / 100
    ),
    score_breakdown: {
      reach: (score_reach | . * 100 | round / 100),
      impact: (score_impact | . * 100 | round / 100),
      confidence: (score_confidence | . * 100 | round / 100),
      effort: (score_effort | . * 100 | round / 100)
    }
  }] | sort_by(-.score)

' "${ISSUES_RAW}.filtered" > "$ISSUES_SCORED"

final_count=$(jq 'length' "$ISSUES_SCORED")
echo "  Scored: $final_count issues"

# --- Write feed ---
mkdir -p "$FEED_DIR"
jq -n \
  --arg updated_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  --argjson issue_count "$final_count" \
  --slurpfile issues "$ISSUES_SCORED" \
  '{
    updated_at: $updated_at,
    issue_count: $issue_count,
    languages: ($issues[0] | map(.language) | unique | sort),
    issues: $issues[0]
  }' > "$FEED_FILE"

echo ""
echo "Seed feed written: $FEED_FILE ($final_count issues)"
if [[ "$final_count" -gt 0 ]]; then
  jq -r '.issues[:5][] | "  [\(.score)] [\(.action)] \(.repo)#\(.number) — \(.title[:60])"' "$FEED_FILE"
fi

# --- Push to feed branch ---
echo ""
read -p "Push to feed branch on origin? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  CURRENT_BRANCH=$(git branch --show-current)

  git checkout --orphan feed 2>/dev/null || git checkout feed
  git rm -rf . --quiet 2>/dev/null || true
  git checkout "$CURRENT_BRANCH" -- scripts/build-feed.sh 2>/dev/null || true

  cp -r "$REPO_ROOT/$FEED_DIR" .
  git add "$FEED_DIR/feed.json"
  git commit -m "Seed issue feed $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git push -u origin feed
  git checkout "$CURRENT_BRANCH"
  echo "Feed branch pushed. Raw URL:"
  echo "  https://raw.githubusercontent.com/mainnebula/token-steward/feed/feed/feed.json"
else
  echo "Feed saved locally at $FEED_FILE. Push manually when ready."
fi

# Cleanup
rm -f "$ISSUES_RAW" "${ISSUES_RAW}.filtered" "${ISSUES_RAW}.tmp" "$REPO_META_FILE" "$REPO_MAP_FILE" "$REPO_LOOKUP" "$ISSUES_SCORED"
