#!/usr/bin/env bash
#
# build-feed.sh — Build the Token Steward issue feed.
#
# Searches GitHub for fresh open-source issues, enriches with repo metadata
# via a single batched GraphQL query, scores them, and writes feed.json.
#
# Designed to run in GH Actions on a cron, but works locally too.
# Requires: gh CLI (authenticated), jq.
#
set -euo pipefail

FEED_DIR="${FEED_DIR:-feed}"
FEED_FILE="${FEED_DIR}/feed.json"
PREVIOUS_FEED="${FEED_DIR}/feed.json"
MAX_ISSUES_PER_QUERY=20
MAX_FEED_SIZE=200
MIN_STARS=100
LOOKBACK_HOURS="${LOOKBACK_HOURS:-48}"

# Compute the lookback date for filtering search results
if [[ "$(uname)" == "Darwin" ]]; then
  LOOKBACK_DATE=$(date -u -v-${LOOKBACK_HOURS}H +"%Y-%m-%dT%H:%M:%SZ")
else
  LOOKBACK_DATE=$(date -u -d "${LOOKBACK_HOURS} hours ago" +"%Y-%m-%dT%H:%M:%SZ")
fi

# Top languages by GitHub popularity
LANGUAGES=("TypeScript" "Python" "Go" "Rust" "JavaScript" "Java")

# Primary labels — bugs and features
LABELS=("good first issue" "help wanted" "enhancement" "feature")

mkdir -p "$FEED_DIR"

echo "Building Token Steward feed..."
echo "  Languages: ${LANGUAGES[*]}"
echo "  Labels: ${LABELS[*]}"
echo "  Min stars: $MIN_STARS"
echo "  Lookback: ${LOOKBACK_HOURS}h (since $LOOKBACK_DATE)"

# Temporary files
ISSUES_RAW=$(mktemp)
ISSUES_DEDUPED=$(mktemp)
ISSUES_ENRICHED=$(mktemp)
cleanup() { rm -f "$ISSUES_RAW" "$ISSUES_DEDUPED" "$ISSUES_ENRICHED" "${ISSUES_ENRICHED}".{scored,merged}; }
trap cleanup EXIT

# --- Phase 1: Search for issues ---
echo ""
echo "Phase 1: Searching for issues..."

search_count=0
echo -n "" > "$ISSUES_RAW"

for label in "${LABELS[@]}"; do
  for lang in "${LANGUAGES[@]}"; do
    # Rate limit: GitHub search API allows 30 req/min
    if (( search_count > 0 && search_count % 10 == 0 )); then
      echo "  $search_count queries done... (pausing for rate limit)"
      sleep 5
    fi

    # Use -- qualifier to filter by updated date (lookback window)
    result=$(gh search issues \
      --label="$label" \
      --language="$lang" \
      --state=open \
      --sort=updated \
      --limit="$MAX_ISSUES_PER_QUERY" \
      --updated=">=${LOOKBACK_DATE}" \
      --json number,title,url,repository,labels,commentsCount,createdAt,assignees \
      2>/dev/null || echo "[]")

    echo "$result" | jq -c '.[]' >> "$ISSUES_RAW" 2>/dev/null || true
    search_count=$((search_count + 1))
  done
done

echo "  Queries run: $search_count"

# Dedupe by URL
jq -s 'unique_by(.url)' "$ISSUES_RAW" > "$ISSUES_DEDUPED" 2>/dev/null || echo "[]" > "$ISSUES_DEDUPED"

total_raw=$(jq 'length' "$ISSUES_DEDUPED")
echo "  Unique issues found: $total_raw"

# --- Phase 2: Filter ---
echo ""
echo "Phase 2: Filtering..."

# Remove assigned issues
jq '[.[] | select((.assignees | length) == 0)]' "$ISSUES_DEDUPED" > "$ISSUES_RAW"
after_assignee=$(jq 'length' "$ISSUES_RAW")
echo "  After removing assigned: $after_assignee"

# Quality filter: skip non-ASCII-dominant titles (spam signal)
jq '[.[] | select((.title | explode | map(select(. < 128)) | length) as $ascii |
  (.title | length) as $total |
  ($total > 0 and ($ascii / $total) > 0.8))]' "$ISSUES_RAW" > "$ISSUES_DEDUPED"
after_quality=$(jq 'length' "$ISSUES_DEDUPED")
echo "  After quality filter: $after_quality"

# --- Phase 3: Batch-fetch repo metadata via GraphQL ---
echo ""
echo "Phase 3: Fetching repo metadata (batched GraphQL)..."

# Extract unique repos
REPOS=$(jq -r '[.[].repository.nameWithOwner] | unique | .[]' "$ISSUES_DEDUPED")
REPO_COUNT=$(echo "$REPOS" | grep -c . || echo "0")
echo "  Unique repos: $REPO_COUNT"

# Build a single GraphQL query for all repos (batch in groups of 50 to stay under query limits)
REPO_META_FILE=$(mktemp)
echo '{}' > "$REPO_META_FILE"
INDEX=0
BATCH_QUERY="query {"
BATCH_SIZE=0

flush_batch() {
  if [[ "$BATCH_SIZE" -eq 0 ]]; then return; fi
  local query="${BATCH_QUERY}}"
  local result
  result=$(gh api graphql -f query="$query" --jq '.data' 2>/dev/null || echo '{}')
  # Merge into accumulated metadata
  jq -s '.[0] * .[1]' "$REPO_META_FILE" <(echo "$result") > "${REPO_META_FILE}.tmp"
  mv "${REPO_META_FILE}.tmp" "$REPO_META_FILE"
  BATCH_QUERY="query {"
  BATCH_SIZE=0
}

while IFS= read -r repo; do
  [[ -z "$repo" ]] && continue
  owner="${repo%%/*}"
  name="${repo##*/}"
  alias="repo_${INDEX}"

  BATCH_QUERY+="
  ${alias}: repository(owner: \"${owner}\", name: \"${name}\") {
    nameWithOwner
    stargazerCount
    primaryLanguage { name }
    contributing: object(expression: \"HEAD:CONTRIBUTING.md\") { __typename }
    workflows: object(expression: \"HEAD:.github/workflows\") { __typename }
  }"

  INDEX=$((INDEX + 1))
  BATCH_SIZE=$((BATCH_SIZE + 1))

  if (( BATCH_SIZE >= 50 )); then
    flush_batch
    sleep 1  # Rate limit between batches
  fi
done <<< "$REPOS"

flush_batch

echo "  Metadata fetched: $INDEX repos in $(( (INDEX + 49) / 50 )) GraphQL call(s)"

# Build a repo lookup: nameWithOwner -> {stars, language, has_contributing, has_ci}
REPO_LOOKUP=$(mktemp)
jq 'to_entries | map(.value) | map({
  key: .nameWithOwner,
  value: {
    stars: .stargazerCount,
    language: (.primaryLanguage.name // "unknown"),
    has_contributing: (.contributing != null),
    has_ci: (.workflows != null)
  }
}) | from_entries' "$REPO_META_FILE" > "$REPO_LOOKUP"

# --- Phase 4: Enrich issues with repo data + PR checks ---
echo ""
echo "Phase 4: Enriching issues..."

# Filter by minimum stars first (avoid PR checks on tiny repos)
echo "[]" > "$ISSUES_ENRICHED"
enriched_count=0
skipped_stars=0

while IFS= read -r issue; do
  repo_full=$(echo "$issue" | jq -r '.repository.nameWithOwner // empty')
  issue_number=$(echo "$issue" | jq -r '.number')

  if [[ -z "$repo_full" || -z "$issue_number" ]]; then
    continue
  fi

  # Look up repo metadata
  stars=$(jq -r --arg repo "$repo_full" '.[$repo].stars // 0' "$REPO_LOOKUP")
  if [[ "$stars" -lt "$MIN_STARS" ]]; then
    skipped_stars=$((skipped_stars + 1))
    continue
  fi

  language=$(jq -r --arg repo "$repo_full" '.[$repo].language // "unknown"' "$REPO_LOOKUP")
  has_contributing=$(jq --arg repo "$repo_full" '.[$repo].has_contributing // false' "$REPO_LOOKUP")
  has_ci=$(jq --arg repo "$repo_full" '.[$repo].has_ci // false' "$REPO_LOOKUP")

  # Compute LLM receptivity (mirrors computeLlmReceptivity in src/issue_discovery.ts)
  llm_receptivity=$(jq -n \
    --argjson stars "$stars" \
    --argjson has_contributing "${has_contributing}" \
    --argjson has_ci "${has_ci}" \
    '0.5
    + (if $has_ci then 0.10 else 0 end)
    + (if $has_contributing then 0.10 else 0 end)
    + (if $stars >= 1000 then 0.05 else 0 end)
    + (if $stars >= 10000 then 0.05 else 0 end)
    | [., 1] | min | . * 100 | round / 100')

  # Rate limit PR checks
  if (( enriched_count > 0 && enriched_count % 30 == 0 )); then
    echo "  Enriched $enriched_count issues... (pausing for rate limit)"
    sleep 5
  fi

  # Check for PRs that explicitly reference this issue via closing keywords
  # Uses GraphQL to find PRs linked to the issue (Closes #N, Fixes #N, etc.)
  pr_info="null"
  action="fix"

  linked_prs=$(gh api graphql \
    -F owner="${repo_full%%/*}" \
    -F name="${repo_full##*/}" \
    -F number="$issue_number" \
    -f query='query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) {
          timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], first: 10) {
            nodes {
              ... on CrossReferencedEvent {
                source {
                  ... on PullRequest {
                    number
                    title
                    url
                    state
                    author { login }
                  }
                }
              }
            }
          }
        }
      }
    }' --jq '[.data.repository.issue.timelineItems.nodes[].source | select(.number != null and .state == "OPEN")] | first // empty' 2>/dev/null || echo "")

  if [[ -n "$linked_prs" && "$linked_prs" != "null" ]]; then
    pr_info="$linked_prs"
    action="review"
  fi

  # Extract issue signals
  title=$(echo "$issue" | jq -r '.title')
  url=$(echo "$issue" | jq -r '.url')
  created_at=$(echo "$issue" | jq -r '.createdAt')
  labels=$(echo "$issue" | jq -c '[.labels[].name]')
  comment_count=$(echo "$issue" | jq -r '.commentsCount // 0')

  # Age in days
  if [[ "$(uname)" == "Darwin" ]]; then
    created_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$created_at" +%s 2>/dev/null || echo "0")
  else
    created_epoch=$(date -d "$created_at" +%s 2>/dev/null || echo "0")
  fi
  age_days=$(( ($(date +%s) - created_epoch) / 86400 ))

  is_bug=$(echo "$labels" | jq 'any(test("bug|defect|broken|regression"; "i"))' 2>/dev/null || echo "false")
  is_complex=$(echo "$labels" | jq 'any(test("large|complex|major|epic"; "i"))' 2>/dev/null || echo "false")
  is_feature=$(echo "$labels" | jq 'any(test("enhancement|feature|proposal|rfc"; "i"))' 2>/dev/null || echo "false")

  # Infer category from labels (mirrors src/scoring_engine.ts category bonuses)
  category="general"
  if echo "$labels" | jq -e 'any(test("doc|documentation|docs"; "i"))' > /dev/null 2>&1; then
    category="documentation"
  elif echo "$labels" | jq -e 'any(test("security|vulnerability|cve"; "i"))' > /dev/null 2>&1; then
    category="security"
  fi

  # Determine surface type (bugfix vs feature)
  surface="bugfix"
  if [[ "$is_feature" == "true" && "$is_bug" != "true" ]]; then
    surface="feature"
  fi

  if [[ "$is_complex" == "true" && "$action" == "fix" ]]; then
    action="propose"
  fi

  enriched=$(jq -n \
    --arg repo "$repo_full" \
    --argjson number "$issue_number" \
    --arg title "$title" \
    --arg url "$url" \
    --arg created_at "$created_at" \
    --argjson labels "$labels" \
    --arg language "$language" \
    --argjson stars "$stars" \
    --argjson comment_count "$comment_count" \
    --argjson age_days "$age_days" \
    --argjson is_bug "${is_bug:-false}" \
    --argjson is_feature "${is_feature:-false}" \
    --arg category "$category" \
    --arg surface "$surface" \
    --argjson has_contributing "${has_contributing:-false}" \
    --argjson has_ci "${has_ci:-false}" \
    --argjson llm_receptivity "${llm_receptivity:-0.5}" \
    --arg action "$action" \
    --argjson pr_info "${pr_info:-null}" \
    '{
      repo: $repo, number: $number, title: $title, url: $url,
      created_at: $created_at, labels: $labels, language: $language,
      stars: $stars, comment_count: $comment_count, age_days: $age_days,
      is_bug: $is_bug, is_feature: $is_feature, category: $category,
      surface: $surface, has_contributing: $has_contributing,
      has_ci: $has_ci, llm_receptivity: $llm_receptivity,
      action: $action, pr: $pr_info
    }')

  jq --argjson new "$enriched" '. + [$new]' "$ISSUES_ENRICHED" > "${ISSUES_ENRICHED}.tmp"
  mv "${ISSUES_ENRICHED}.tmp" "$ISSUES_ENRICHED"

  enriched_count=$((enriched_count + 1))
done < <(jq -c '.[]' "$ISSUES_DEDUPED" | head -n 200)

echo "  Enriched: $enriched_count issues (skipped $skipped_stars below $MIN_STARS stars)"

# --- Phase 5: Score issues ---
echo ""
echo "Phase 5: Scoring..."

# Scoring aligned with src/scoring_engine.ts
# Missing from feed: per-issue reaction_count (gh search doesn't return it) — uses 0
# Missing from feed: token fit (no budget context in feed) — omitted, expected
jq '
  # Reach: reactions, comments, repo stars (mirrors scoreReach)
  def score_reach:
    0.3
    # Note: reaction_count not available from gh search; reactions would add up to +0.40
    + (if .comment_count >= 2 then 0.10 else 0 end)
    + (if .comment_count >= 5 then 0.10 else 0 end)
    + (if .stars >= 1000 then 0.05 else 0 end)
    + (if .stars >= 10000 then 0.05 else 0 end)
    | [., 1] | min;

  # Impact: bug severity, maintainer engagement, category (mirrors scoreImpact)
  def score_impact:
    0.4
    + (if .is_bug then 0.20 else 0 end)
    + (if .comment_count >= 3 then 0.15 else 0 end)  # proxy for has_maintainer_comment
    + (if .category == "documentation" then 0.10 else 0 end)
    + (if .category == "security" then 0.15 else 0 end)
    | [., 1] | min;

  # Confidence: LLM receptivity, labels, repo signals (mirrors scoreConfidence)
  def score_confidence:
    0.3
    + (.llm_receptivity * 0.30)
    + (if (.labels | any(test("good.first.issue|help.wanted|beginner|easy|small|docs|enhancement"; "i"))) then 0.15 else 0 end)
    + (if .has_contributing then 0.05 else 0 end)
    + (if .has_ci then 0.10 else 0 end)
    + (if (.title | length) > 15 then 0.05 else 0 end)
    + (if (.title | length) > 40 then 0.05 else 0 end)
    | [., 1] | min;

  # Effort: age, complexity labels (mirrors scoreEffort, minus token fit)
  def score_effort:
    0.5
    + (if .age_days < 7 then 0.15
       elif .age_days < 30 then 0.10
       elif .age_days > 180 then -0.10
       else 0 end)
    + (if (.labels | any(test("small|easy|trivial|minor"; "i"))) then 0.15 else 0 end)
    + (if (.labels | any(test("large|complex|major|epic"; "i"))) then -0.15 else 0 end)
    | [., 1] | min | [., 0] | max;

  [.[] | . + {
    score: (
      (score_reach * 0.20) +
      (score_impact * 0.25) +
      (score_confidence * 0.30) +
      (score_effort * 0.25)
      | . * 100 | round / 100
    ),
    score_breakdown: {
      reach: (score_reach | . * 100 | round / 100),
      impact: (score_impact | . * 100 | round / 100),
      confidence: (score_confidence | . * 100 | round / 100),
      effort: (score_effort | . * 100 | round / 100)
    }
  }]
  | sort_by(-.score)
' "$ISSUES_ENRICHED" > "${ISSUES_ENRICHED}.scored"

scored_count=$(jq 'length' "${ISSUES_ENRICHED}.scored")
echo "  Scored: $scored_count issues"

# --- Phase 6: Merge with previous feed ---
echo ""
echo "Phase 6: Merging with previous feed..."

if [[ -f "$PREVIOUS_FEED" ]] && jq -e '.issues' "$PREVIOUS_FEED" > /dev/null 2>&1; then
  prev_count=$(jq '.issues | length' "$PREVIOUS_FEED")
  echo "  Previous feed: $prev_count issues"

  jq -s --argjson max "$MAX_FEED_SIZE" '
    (.[0] // []) as $new |
    ((.[1].issues // []) | [.[] | select(.url as $u | ($new | map(.url) | index($u) | not))]) as $old |
    ($new + $old) | unique_by(.url) | sort_by(-.score) | .[:$max]
  ' "${ISSUES_ENRICHED}.scored" "$PREVIOUS_FEED" > "${ISSUES_ENRICHED}.merged"
else
  echo "  No previous feed found, starting fresh."
  jq --argjson max "$MAX_FEED_SIZE" '.[:$max]' "${ISSUES_ENRICHED}.scored" > "${ISSUES_ENRICHED}.merged"
fi

# --- Phase 7: Write final feed ---
echo ""
echo "Phase 7: Writing feed..."

final_count=$(jq 'length' "${ISSUES_ENRICHED}.merged")

jq -n \
  --arg updated_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  --argjson issue_count "$final_count" \
  --slurpfile issues "${ISSUES_ENRICHED}.merged" \
  '{
    updated_at: $updated_at,
    issue_count: $issue_count,
    languages: ($issues[0] | map(.language) | unique | sort),
    issues: $issues[0]
  }' > "$FEED_FILE"

# Cleanup extra temp files
rm -f "$REPO_META_FILE" "$REPO_LOOKUP"

echo ""
echo "Feed written to $FEED_FILE"
echo "  Total issues: $final_count"
echo "  Languages: $(jq -r '.languages | join(", ")' "$FEED_FILE")"
echo "  Top score: $(jq -r '.issues[0].score // "n/a"' "$FEED_FILE")"
top5=$(jq -r '.issues[:5][] | "    [\(.score)] [\(.action)] \(.repo)#\(.number) — \(.title[:60])"' "$FEED_FILE")
echo "  Top 5:"
echo "$top5"
echo ""
