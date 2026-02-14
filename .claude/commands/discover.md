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

3. **If the CLI is installed**, run `steward discover --json`, parse the output, assign action types per the rules in SKILL.md, and skip to step 6 to present results.

4. **Ask the user what kind of contribution they're looking for.** Present this as a multiple-choice question:

   > **What kind of contribution are you looking for?**
   >
   > 1. **Projects I use** — find issues on repos you've starred or contributed to
   > 2. **Important projects** — find approachable issues on well-known open-source projects
   >
   > Or tell me about a specific project you want to help.

   Based on the user's answer, follow **one** of the three paths below.

---

### Path 1: "Projects I use"

**Step A — Fetch starred repos:**
```bash
gh api user/starred --method GET -H "Accept: application/vnd.github.v3+json" --paginate --jq '.[] | {full_name, language, stargazers_count}' 2>/dev/null
```

**Step B — Search for approachable issues on starred repos with >50 stars:**

For each qualifying repo, check for open issues:
```bash
gh issue list --repo=<owner/repo> --label="good first issue" --state=open --limit=5 --json number,title,url,labels,assignees,createdAt
```

Run these in parallel (batch 5-10 repos at a time). Filter out issues where `assignees` is non-empty.

**Step C — Assign action types** to each issue per the rules in SKILL.md's "Action Types" section:
- Check for open PRs linked to the issue → **Review**
- Large/complex labels or vague scope → **Propose**
- Otherwise → **Fix**

**Step D — Score and present** the top 5 issues grouped by repo, sorted by stars and recency.

**Step E — If no results found**, tell the user:
> No approachable issues found on your starred repos right now. Want to try "Important projects" instead?

If they say yes, follow Path 2.

---

### Path 2: "Important projects"

**Step A — Fetch the pre-built feed:**
```bash
curl -sf "https://raw.githubusercontent.com/mainnebula/token-steward/feed/feed/feed.json"
```

If the feed fetch fails, tell the user:
> The issue feed isn't available right now. You can generate it locally by running `scripts/seed-feed.sh`, or tell me a specific project you'd like to contribute to.

Do NOT fall back to live search. Stop here if the feed is missing.

**Step B — Ask a follow-up to narrow results:**

> How should I filter these?
>
> 1. **Whatever has the most impact** — highest scored across all projects
> 2. **In my language** — I'll check your GitHub profile for languages and filter
> 3. A specific area (type it in)

**Step C — Apply the filter:**
- Option 1: Sort by score, take the top 5.
- Option 2: Fetch the user's languages from their GitHub profile:
  ```bash
  gh repo list @me --limit=20 --json primaryLanguage --jq '[.[].primaryLanguage.name // empty] | unique'
  ```
  Filter the feed to matching languages, then sort by score.
- Option 3: Filter by the user's text input against repo names, labels, and descriptions.

**Step D — Present** the top 5 issues from the filtered feed.

---

### Path 3: Specific project (free text)

If the user names a specific project instead of picking option 1 or 2:

**Step A — Validate the repo exists:**
```bash
gh repo view <owner/repo> --json nameWithOwner,stargazerCount,primaryLanguage,description
```

**Step B — Fetch approachable issues:**
```bash
gh issue list --repo=<owner/repo> --label="good first issue" --state=open --limit=10 --json number,title,url,labels,assignees,createdAt
```

Filter out issues where `assignees` is non-empty.

**Step C — Assign action types and score** per SKILL.md rules.

**Step D — Present** the results.

---

5. **Dedupe against the user's existing open PRs** before presenting:
   ```bash
   gh pr list --author=@me --state=open --json url,headRepository
   ```

6. **Present results** sorted by score, showing:
   - **Action type** tag: `[Fix]`, `[Review]`, or `[Propose]`
   - Repository name and stars
   - Issue title and number
   - For Review: the PR number and author
   - Key labels
   - Estimated complexity (small/medium/large)

   Example format:
   ```
    1  [Fix] cli/cli #9432                                    ★ 37.2k
       Fix glob pattern matching in run command
       good first issue · help wanted                    ~15,000 tokens

    2  [Review] vercel/next.js #58201 — PR #58245 by @user   ★ 131.2k
       Fix middleware redirect loop
       bug · good first issue                             ~8,000 tokens

    3  [Propose] facebook/react #29100                        ★ 234.5k
       Redesign error boundary retry mechanism
       enhancement · complex                             ~60,000 tokens
   ```

7. Ask the user if they'd like to act on any of the presented issues. If they select one, hand off to `/token-steward:work` with the issue reference and action type.

8. If the CLI is NOT installed, offer to install it:
   > "The Token Steward CLI can handle discovery locally, saving Claude Code tokens on future runs. It also tracks contributions and enforces usage budgets. Want me to install it? I'll run `npm install -g token-steward && steward init`."

   Only offer once. If the user declines, don't mention it again.
