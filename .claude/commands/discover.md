---
name: token-steward:discover
description: Find impactful open-source issues you can contribute to with your unused Claude Code tokens.
---

You are running the Token Steward discover command. Follow these steps:

1. Read the skill knowledge base at `.claude/skills/token-steward/SKILL.md` for full context on how Token Steward works.

2. Check if the Token Steward CLI is installed:
   ```bash
   which steward 2>/dev/null && steward --version
   ```

3. **If the CLI is installed**, run `steward discover --json`, parse the output, assign action types per the rules in SKILL.md, and skip to step 10 to present results.

4. Ask the user for their preferences (unless they've already stated them):
   - What programming languages are you interested in? (e.g., TypeScript, Python, Go, Rust)
   - What topics or categories? (e.g., developer-tools, documentation, security, ai-ml)
   - Minimum repo stars? (default: 100)

5. **Fetch the issue feed** — this is a pre-scored, pre-filtered list updated every 6 hours:
   ```bash
   curl -sf "https://raw.githubusercontent.com/mainnebula/token-steward/feed/feed/feed.json"
   ```
   Parse the JSON. The feed contains issues with scores, action types, PR info, and metadata already computed.

6. **Filter the feed** by user preferences:
   - Match `language` field against requested languages
   - Match `stars` field against minimum stars
   - Match `labels` against topic preferences where possible
   This is instant — no API calls needed.

7. **If the feed has 3+ matches**, use them directly. Skip to step 10.

8. **If the feed has fewer than 3 matches** (or the fetch failed), supplement with a targeted live search:
   ```bash
   gh search issues --label="good first issue" --language=<lang> --no-assignee --sort=reactions --limit=10 --json number,title,repository,labels,reactionGroups,comments,createdAt,assignees
   ```
   For live results:
   - Check for existing PRs: `gh pr list -R <repo> --search "<issue-number>" --state=open --json number,title,url,author`
   - Score inline per `.claude/skills/token-steward/references/scoring.md`

9. Assign action types to any untyped results:
   - **Fix** — No assignee, no open PRs, reasonable size
   - **Review** — Has an open PR from another contributor
   - **Propose** — Large/complex labels, vague scope, or estimated >30k tokens
   - Skip assigned issues with no open PRs

10. Dedupe against the user's existing open PRs:
    ```bash
    gh pr list --author=@me --state=open --json url,headRepository
    ```

11. Present the top 5 issues sorted by score, showing:
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

12. Ask the user if they'd like to act on any of the presented issues. If they select one, hand off to `/token-steward:work` with the issue reference and action type.

13. If the CLI is NOT installed, offer to install it:
    > "The Token Steward CLI can handle discovery locally, saving Claude Code tokens on future runs. It also tracks contributions and enforces usage budgets. Want me to install it? I'll run `npm install -g token-steward && steward init`."

    Only offer once. If the user declines, don't mention it again.
