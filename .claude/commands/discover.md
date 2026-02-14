---
name: token-steward:discover
description: Find impactful open-source issues on projects you care about.
---

You are running the Token Steward discover command. Follow these steps:

1. Read the skill knowledge base at `.claude/skills/token-steward/SKILL.md` for full context on how Token Steward works.

2. Check if the Token Steward CLI is installed:
   ```bash
   which steward 2>/dev/null && steward --version
   ```

3. **If the CLI is installed**, run `steward discover --json`, parse the output, assign action types per the rules in SKILL.md, and skip to step 12 to present results.

4. **Build a profile from the user's GitHub activity.** This runs automatically before asking any questions — 3 quick API calls that give you strong signals about what they care about.

   **Step 4a — Their repos** (languages and topics they work in):
   ```bash
   gh repo list @me --limit=20 --json name,primaryLanguage,repositoryTopics,stargazerCount,isFork --jq '[.[] | select(.isFork == false)] | sort_by(-.stargazerCount)'
   ```
   Extract: top languages (by repo count), topics/tags, whether they build CLIs, web apps, libraries, etc.

   **Step 4b — Their starred repos** (projects they explicitly care about):
   ```bash
   gh api user/starred --method GET -H "Accept: application/vnd.github.v3+json" --paginate --jq '.[] | {full_name, description, language, stargazers_count, topics}' 2>/dev/null | head -100
   ```
   Extract: specific projects they follow, languages they're interested in beyond what they write, ecosystems (e.g., stars Next.js + Prisma + tRPC → full-stack TS).

   **Step 4c — Their recent contributions** (ecosystems they're active in):
   ```bash
   gh pr list --author=@me --state=all --limit=20 --json headRepository,title,state,createdAt --jq '[.[] | {repo: .headRepository.name, owner: .headRepository.owner.login}] | unique'
   ```
   Extract: repos they've already contributed to (good candidates for repeat contributions), and which ones to avoid duplicating.

   **Step 4d — Synthesize a profile.** From the three signals above, build a short profile:
   - **Primary languages**: ranked by frequency across their repos
   - **Interested projects**: starred repos with >1k stars (these are direct matches for feed filtering)
   - **Ecosystems**: inferred from topics and starred repos (e.g., "React ecosystem", "Go infrastructure")
   - **Contribution style**: if they mostly fix bugs vs. add features vs. write docs (from PR titles)

   Present a brief summary to the user, e.g.:
   > Based on your GitHub profile, you write mostly TypeScript and Python. You've starred projects like Next.js, Prisma, and Ruff, and you've contributed to cli/cli and vercel/next.js before. I'll focus on those ecosystems.
   >
   > Want me to adjust anything, or should I find issues based on this?

   If the user wants to adjust, let them. Otherwise proceed with the inferred profile.

5. **If the profile is thin** (< 5 public repos, no stars, new account), or the user wants to specify manually, fall back to asking conversationally:

   **What projects or tools do you use and care about?**
   - Specific repos they depend on (e.g., "I use Next.js and Prisma every day")
   - Types of tools they care about (e.g., "CLI tools", "testing frameworks", "AI/ML libraries")
   - Ecosystems they're part of (e.g., "I'm mostly in the React ecosystem" or "I write a lot of Go")

   **What kind of contributions interest you?**
   - Bug fixes — quick, focused, satisfying
   - Documentation — always needed, great for learning a codebase
   - Features — more involved, bigger impact
   - Code review — help other contributors land their PRs
   - Security — high-impact, high-visibility fixes

   Don't ask about minimum stars or technical filters. Infer those from context.

6. **Fetch the issue feed** — this is a pre-scored, pre-filtered list updated every 6 hours:
   ```bash
   curl -sf "https://raw.githubusercontent.com/mainnebula/token-steward/feed/feed/feed.json"
   ```
   Parse the JSON. The feed contains issues with scores, action types, PR info, and metadata already computed.

7. **Filter the feed** by the user's profile:
   - Match starred repos directly against `repo` field (strongest signal)
   - Match languages from their repos against `language` field
   - Match topics/ecosystems against labels and categories
   - Boost issues on repos the user has starred or previously contributed to
   This is instant — no API calls needed.

8. **If the feed has 3+ matching issues**, use them directly. Skip to step 13.

9. **If the feed has fewer than 3 matches** (or the fetch failed), use the **efficient live search fallback** below. This is designed to minimize API calls.

   **Step 8a — Search for issues.** Use the exact `gh search issues` syntax below (these flags are verified to work):

   If the user named specific repos or has starred repos, search those directly:
   ```bash
   gh search issues --repo=<owner/repo> --label="good first issue" --state=open --sort=reactions --limit=10 --json number,title,url,repository,labels,commentsCount,createdAt,assignees
   ```

   Otherwise search by language (run up to 3 searches in parallel for different languages/labels):
   ```bash
   gh search issues --label="good first issue" --language=TypeScript --state=open --sort=reactions --limit=10 --json number,title,url,repository,labels,commentsCount,createdAt,assignees
   ```

   **Important `gh search issues` notes:**
   - `--no-assignee` is NOT a valid flag — filter assignees from the JSON results instead
   - `--json` fields for search: `number`, `title`, `url`, `repository`, `labels`, `commentsCount`, `createdAt`, `assignees` (NOT `reactionGroups` — that's not available in search)
   - `repository` is an object with `nameWithOwner` field

   **Step 8b — Quality filter.** Before enriching, filter out noise:
   - Remove issues where `assignees` array is non-empty
   - Remove issues with non-ASCII-dominant titles (spam signal)
   - Remove issues where ALL labels are generic (e.g., only "good first issue" with no other labels can be low-signal)

   **Step 8c — Batch-fetch repo metadata.** Instead of calling `gh repo view` per repo, use a SINGLE GraphQL query to get stars, language, CONTRIBUTING.md, and CI for ALL candidate repos at once:

   First, extract unique repo owner/name pairs from the results. Then build one query:
   ```bash
   gh api graphql -f query='query {
     repo0: repository(owner: "vercel", name: "next.js") {
       nameWithOwner
       stargazerCount
       primaryLanguage { name }
       contributing: object(expression: "HEAD:CONTRIBUTING.md") { __typename }
       workflows: object(expression: "HEAD:.github/workflows") { __typename }
     }
     repo1: repository(owner: "cli", name: "cli") {
       nameWithOwner
       stargazerCount
       primaryLanguage { name }
       contributing: object(expression: "HEAD:CONTRIBUTING.md") { __typename }
       workflows: object(expression: "HEAD:.github/workflows") { __typename }
     }
   }'
   ```

   This gets metadata for ALL repos in **1 API call** instead of N.

   **Step 8d — Filter by stars.** Drop any issues from repos with < 100 stars. This eliminates most spam/toy repos.

   **Step 8e — Check for linked PRs** (only for issues that passed the star filter).

   Use GraphQL to find PRs that explicitly reference the issue (via `Closes #N`, `Fixes #N`, or GitHub's linked PR timeline). This avoids false positives from fuzzy number matching:
   ```bash
   gh api graphql -F owner="<owner>" -F name="<repo>" -F number=<issue-number> -f query='
     query($owner: String!, $name: String!, $number: Int!) {
       repository(owner: $owner, name: $name) {
         issue(number: $number) {
           timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], first: 5) {
             nodes {
               ... on CrossReferencedEvent {
                 source {
                   ... on PullRequest { number title url state author { login } }
                 }
               }
             }
           }
         }
       }
     }'
   ```
   Filter to `state == "OPEN"` PRs. If any exist → mark as **Review**.

   This is the one call that can't be batched, but by filtering first we minimize how many we need.

10. Assign action types to any untyped results:
    - **Fix** — No assignee, no open PRs, reasonable size
    - **Review** — Has an open PR from another contributor
    - **Propose** — Large/complex labels, vague scope, or estimated >15k tokens
    - Skip assigned issues with no open PRs

11. **Score each issue** per `.claude/skills/token-steward/references/scoring.md`:
    - Compute reach, impact, confidence, effort dimensions
    - Apply weights: reach 20%, impact 25%, confidence 30%, effort 25%
    - For signals you can't determine, use 0.5 as default
    - **Bonus**: boost score by +0.05 for repos the user has starred, +0.03 for repos matching their primary languages

12. Dedupe against the user's existing open PRs (already fetched in step 4c — reuse that data):
    ```bash
    gh pr list --author=@me --state=open --json url,headRepository
    ```

13. Present the top 5 issues sorted by score, showing:
    - **Action type** tag: `[Fix]`, `[Review]`, or `[Propose]`
    - Repository name and stars
    - Issue title and number
    - For Review: the PR number and author
    - RICE score
    - Key labels
    - Estimated complexity (small/medium/large)
    - Feed freshness: "from feed (updated Xh ago)" or "live search"

    Example format:
    ```
     1  [Fix] cli/cli #9432                                    ★ 37.2k
        Fix glob pattern matching in run command
        good first issue · help wanted                    ~15,000 tokens
        Score: 0.82 · from feed (updated 2h ago)

     2  [Review] vercel/next.js #58201 — PR #58245 by @user   ★ 131.2k
        Fix middleware redirect loop
        bug · good first issue                             ~8,000 tokens
        Score: 0.78 · from feed (updated 2h ago)

     3  [Propose] facebook/react #29100                        ★ 234.5k
        Redesign error boundary retry mechanism
        enhancement · complex                             ~60,000 tokens
        Score: 0.71 · live search
    ```

14. Ask the user if they'd like to act on any of the presented issues. If they select one, hand off to `/token-steward:work` with the issue reference and action type.

15. If the CLI is NOT installed, offer to install it:
    > "The Token Steward CLI can handle discovery locally, saving Claude Code tokens on future runs. It also tracks contributions and enforces usage budgets. Want me to install it? I'll run `npm install -g token-steward && steward init`."

    Only offer once. If the user declines, don't mention it again.
