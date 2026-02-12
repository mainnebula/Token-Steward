#!/usr/bin/env bash
#
# build-feed.sh — Build the Token Steward issue feed.
#
# Searches GitHub for fresh open-source issues, scores them,
# filters out assigned/PR'd issues, and writes feed.json.
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
MAX_ENRICH=100

# Top languages by GitHub popularity — keeps the search matrix manageable
LANGUAGES=("TypeScript" "Python" "Go" "Rust" "JavaScript" "Java")

# Primary labels — "good first issue" and "help wanted" cover the vast majority
LABELS=("good first issue" "help wanted")

mkdir -p "$FEED_DIR"

echo "Building Token Steward feed..."
echo "  Languages: ${LANGUAGES[*]}"
echo "  Labels: ${LABELS[*]}"

# Temporary files
ISSUES_RAW=$(mktemp)
ISSUES_DEDUPED=$(mktemp)
ISSUES_ENRICHED=$(mktemp)
cleanup() { rm -f "$ISSUES_RAW" "$ISSUES_DEDUPED" "$ISSUES_ENRICHED" "${ISSUES_ENRICHED}".{scored,merged}; }
trap cleanup EXIT

# --- Phase 1: Search for issues ---
echo ""
echo "Phase 1: Searching for issues..."

# gh search issues JSON fields (not the same as gh issue view):
#   number, title, url, repository, labels, commentsCount, createdAt, assignees, body
# Note: reactionGroups is NOT available in search results.

search_count=0
echo -n "" > "$ISSUES_RAW"

for label in "${LABELS[@]}"; do
  for lang in "${LANGUAGES[@]}"; do
    # Rate limit: GitHub search API allows 30 req/min
    if (( search_count > 0 && search_count % 10 == 0 )); then
      echo "  $search_count queries done... (pausing for rate limit)"
      sleep 5
    fi

    result=$(gh search issues \
      --label="$label" \
      --language="$lang" \
      --state=open \
      --sort=updated \
      --limit="$MAX_ISSUES_PER_QUERY" \
      --json number,title,url,repository,labels,commentsCount,createdAt,assignees \
      2>/dev/null || echo "[]")

    # Append each item as a line of JSON (newline-delimited)
    echo "$result" | jq -c '.[]' >> "$ISSUES_RAW" 2>/dev/null || true

    search_count=$((search_count + 1))
  done
done

echo "  Queries run: $search_count"

# Dedupe by URL
jq -s 'unique_by(.url)' "$ISSUES_RAW" > "$ISSUES_DEDUPED" 2>/dev/null || echo "[]" > "$ISSUES_DEDUPED"

total_raw=$(jq 'length' "$ISSUES_DEDUPED")
echo "  Unique issues found: $total_raw"

# --- Phase 2: Filter out assigned issues ---
echo ""
echo "Phase 2: Filtering assigned issues..."

jq '[.[] | select((.assignees | length) == 0)]' "$ISSUES_DEDUPED" > "$ISSUES_RAW"
after_assignee=$(jq 'length' "$ISSUES_RAW")
echo "  After removing assigned: $after_assignee"

# --- Phase 3: Enrich with repo metadata and PR check ---
echo ""
echo "Phase 3: Enriching with metadata (up to $MAX_ENRICH issues)..."

echo "[]" > "$ISSUES_ENRICHED"
enriched_count=0

while IFS= read -r issue; do
  repo_full=$(echo "$issue" | jq -r '.repository.nameWithOwner // empty')
  issue_number=$(echo "$issue" | jq -r '.number')

  if [[ -z "$repo_full" || -z "$issue_number" ]]; then
    continue
  fi

  # Rate limit: ~3 API calls per issue
  if (( enriched_count > 0 && enriched_count % 15 == 0 )); then
    echo "  Enriched $enriched_count issues... (pausing for rate limit)"
    sleep 5
  fi

  # Check for existing PRs
  pr_count=$(gh pr list -R "$repo_full" --search "$issue_number" --state=open --json number --jq 'length' 2>/dev/null || echo "0")

  if [[ "$pr_count" -gt 0 ]]; then
    pr_info=$(gh pr list -R "$repo_full" --search "$issue_number" --state=open --json number,title,url,author --jq '.[0]' 2>/dev/null || echo "null")
    action="review"
  else
    pr_info="null"
    action="fix"
  fi

  # Fetch repo metadata via GraphQL (stars + CONTRIBUTING + CI in one call)
  owner="${repo_full%%/*}"
  name="${repo_full##*/}"

  repo_data=$(gh api graphql -f query='query {
    repository(owner: "'"$owner"'", name: "'"$name"'") {
      stargazerCount
      primaryLanguage { name }
      contributing: object(expression: "HEAD:CONTRIBUTING.md") { __typename }
      workflows: object(expression: "HEAD:.github/workflows") { __typename }
    }
  }' --jq '.data.repository // {}' 2>/dev/null || echo '{}')

  stars=$(echo "$repo_data" | jq '.stargazerCount // 0')
  repo_language=$(echo "$repo_data" | jq -r '.primaryLanguage.name // "unknown"')
  has_contributing=$(echo "$repo_data" | jq '.contributing != null')
  has_ci=$(echo "$repo_data" | jq '.workflows != null')

  # Extract issue signals
  title=$(echo "$issue" | jq -r '.title')
  url=$(echo "$issue" | jq -r '.url')
  created_at=$(echo "$issue" | jq -r '.createdAt')
  labels=$(echo "$issue" | jq -c '[.labels[].name]')
  comment_count=$(echo "$issue" | jq -r '.commentsCount // 0')

  # Calculate age in days (macOS and Linux compatible)
  if [[ "$(uname)" == "Darwin" ]]; then
    created_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$created_at" +%s 2>/dev/null || echo "0")
  else
    created_epoch=$(date -d "$created_at" +%s 2>/dev/null || echo "0")
  fi
  now_epoch=$(date +%s)
  age_days=$(( (now_epoch - created_epoch) / 86400 ))

  # Detect bug and complexity labels
  is_bug=$(echo "$labels" | jq 'any(test("bug|defect|broken|regression"; "i"))' 2>/dev/null || echo "false")
  is_complex=$(echo "$labels" | jq 'any(test("large|complex|major|epic"; "i"))' 2>/dev/null || echo "false")

  if [[ "$is_complex" == "true" && "$action" == "fix" ]]; then
    action="propose"
  fi

  # Build enriched issue object
  enriched=$(jq -n \
    --arg repo "$repo_full" \
    --argjson number "$issue_number" \
    --arg title "$title" \
    --arg url "$url" \
    --arg created_at "$created_at" \
    --argjson labels "$labels" \
    --arg language "$repo_language" \
    --argjson stars "$stars" \
    --argjson comment_count "$comment_count" \
    --argjson age_days "$age_days" \
    --argjson is_bug "${is_bug:-false}" \
    --argjson has_contributing "${has_contributing:-false}" \
    --argjson has_ci "${has_ci:-false}" \
    --arg action "$action" \
    --argjson pr_info "${pr_info:-null}" \
    '{
      repo: $repo,
      number: $number,
      title: $title,
      url: $url,
      created_at: $created_at,
      labels: $labels,
      language: $language,
      stars: $stars,
      comment_count: $comment_count,
      age_days: $age_days,
      is_bug: $is_bug,
      has_contributing: $has_contributing,
      has_ci: $has_ci,
      action: $action,
      pr: $pr_info
    }')

  # Append to enriched list
  jq --argjson new "$enriched" '. + [$new]' "$ISSUES_ENRICHED" > "${ISSUES_ENRICHED}.tmp"
  mv "${ISSUES_ENRICHED}.tmp" "$ISSUES_ENRICHED"

  enriched_count=$((enriched_count + 1))
done < <(jq -c '.[]' "$ISSUES_RAW" | head -n "$MAX_ENRICH")

echo "  Enriched: $enriched_count issues"

# --- Phase 4: Score issues ---
echo ""
echo "Phase 4: Scoring..."

# RICE scoring in jq (mirrors scoring_engine.ts)
jq '
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
    | [., 1] | min;

  def score_confidence:
    0.3
    + 0.15
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

  [.[] | . + {
    score: (
      (score_reach * 0.20) +
      (score_impact * 0.25) +
      (score_confidence * 0.30) +
      (score_effort * 0.25)
      | . * 100 | round / 100
    )
  }]
  | sort_by(-.score)
' "$ISSUES_ENRICHED" > "${ISSUES_ENRICHED}.scored"

scored_count=$(jq 'length' "${ISSUES_ENRICHED}.scored")
echo "  Scored: $scored_count issues"

# --- Phase 5: Merge with previous feed ---
echo ""
echo "Phase 5: Merging with previous feed..."

if [[ -f "$PREVIOUS_FEED" ]] && jq -e '.issues' "$PREVIOUS_FEED" > /dev/null 2>&1; then
  prev_count=$(jq '.issues | length' "$PREVIOUS_FEED")
  echo "  Previous feed: $prev_count issues"

  # New issues take priority, keep old ones that are still unique, cap at MAX_FEED_SIZE
  jq -s --argjson max "$MAX_FEED_SIZE" '
    (.[0] // []) as $new |
    ((.[1].issues // []) | [.[] | select(.url as $u | ($new | map(.url) | index($u) | not))]) as $old |
    ($new + $old) | unique_by(.url) | sort_by(-.score) | .[:$max]
  ' "${ISSUES_ENRICHED}.scored" "$PREVIOUS_FEED" > "${ISSUES_ENRICHED}.merged"
else
  echo "  No previous feed found, starting fresh."
  jq --argjson max "$MAX_FEED_SIZE" '.[:$max]' "${ISSUES_ENRICHED}.scored" > "${ISSUES_ENRICHED}.merged"
fi

# --- Phase 6: Write final feed ---
echo ""
echo "Phase 6: Writing feed..."

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

echo ""
echo "Feed written to $FEED_FILE"
echo "  Total issues: $final_count"
echo "  Languages: $(jq -r '.languages | join(", ")' "$FEED_FILE")"
echo "  Top score: $(jq -r '.issues[0].score // "n/a"' "$FEED_FILE")"
top5=$(jq -r '.issues[:5][] | "    [\(.score)] [\(.action)] \(.repo)#\(.number) — \(.title[:60])"' "$FEED_FILE")
echo "  Top 5:"
echo "$top5"
echo ""
