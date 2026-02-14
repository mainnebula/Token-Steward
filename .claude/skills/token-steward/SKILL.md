# Token Steward

Token Steward helps you contribute to the open-source projects you care about. It finds real issues on projects that matter to you, sets up workspaces, and guides you through submitting quality PRs. Got unused Claude Code tokens? Put them to work on the tools you depend on.

## Prerequisites

Only `gh` CLI authenticated with GitHub is required. Verify with:

```bash
gh auth status
```

Everything works natively with just `gh` and `git`.

## Action Types

Every discovered issue gets one of three action types based on its state:

| Action | When | What you do |
|--------|------|-------------|
| **Fix** | No assignee, no open PRs, reasonable size | Fork, branch, code, submit a draft PR |
| **Review** | Issue has an open PR from another contributor | Checkout the PR, review code, run tests, post feedback |
| **Propose** | Issue is too large/complex for one session | Analyze the codebase, post an approach plan as a comment |

### How action type is determined

1. **Check for existing PRs** linked to the issue:
   ```bash
   gh pr list -R <owner/repo> --search "<issue-number>" --state=open --json number,title,url,author,additions,deletions
   ```
   If open PRs exist → **Review**

2. **Check assignees**:
   ```bash
   gh issue view <number> -R <owner/repo> --json assignees
   ```
   If assigned to someone → skip (someone is already working on it)

3. **Estimate complexity** from labels and issue body:
   - Large/complex/epic labels → **Propose**
   - Issue body is vague or open-ended (no clear steps) → **Propose**
   - Estimated >30k tokens of work → **Propose**
   - Otherwise → **Fix**

## The Workflow

### 1. Discover

Discovery uses a **two-path choice** to quickly find relevant issues without wasting tokens on broad searching.

#### Issue Feed

A pre-built feed of scored, filtered issues is published to:
```
https://raw.githubusercontent.com/mainnebula/token-steward/feed/feed/feed.json
```

The feed is rebuilt every 6 hours by a GitHub Actions workflow that:
- Searches across 12+ languages and common approachability labels
- Filters out assigned issues and stale issues
- Checks for existing PRs (marks as review vs fix)
- Fetches repo metadata (stars, CI, CONTRIBUTING.md)
- Scores with RICE
- Merges with the previous feed (keeps up to 200 issues)

#### Discovery flow

The user picks one of three paths:

> 1. **Projects I use** — find issues on repos you've starred or contributed to
> 2. **Important projects** — find approachable issues on well-known open-source projects
> 3. Or name a specific project

**Path 1 — "Projects I use":**
1. Fetch starred repos via `gh api user/starred`
2. For starred repos with >50 stars, check for open "good first issue" issues
3. Filter out assigned issues, assign action types, present top 5

**Path 2 — "Important projects":**
1. Fetch the pre-built feed (one curl call)
2. Ask a follow-up to narrow: highest impact, filter by user's languages, or a specific area
3. Filter and present top 5. No live fallback — if the feed is missing, tell the user to run `scripts/seed-feed.sh`

**Path 3 — Specific project:**
1. Validate repo via `gh repo view`
2. Fetch "good first issue" issues, filter assigned, score, present

All paths dedupe against the user's existing open PRs before presenting results. Top 5 issues are shown sorted by score with action type tags.

### 2. Work

Behavior depends on the action type:

#### Fix (guided)

Claude acts as a **guide** — the user should understand what's broken, why, what changed, and how to verify.

1. **Set up workspace** — fork, clone, branch (mechanical setup, Claude handles this)
2. **Read and understand** — fetch issue details, README, CONTRIBUTING.md
3. **Explain the bug** — what it is, what symptoms it causes, where in the codebase it lives, why it happens
4. **Explain the fix approach** — what needs to change and why, walk through the code changes, flag edge cases. **Ask the user if the approach makes sense before writing code.**
5. **Implement the fix** — write the code, explaining each change as it goes
6. **Explain expected behavior** — what the new behavior looks like, how it differs from the broken behavior, any side effects
7. **Help the user test** — explain how to test manually, point to existing tests, suggest new test cases. Let the user run tests and confirm.
8. **Submit** — only after the user is satisfied, proceed to PR

#### Review

1. Clone the repo (no fork needed):
   ```bash
   gh repo clone <owner/repo>
   ```
2. Checkout the PR:
   ```bash
   gh pr checkout <pr-number> -R <owner/repo>
   ```
3. Fetch PR details:
   ```bash
   gh pr view <pr-number> -R <owner/repo> --json title,body,files,additions,deletions,commits,comments,reviews
   gh pr diff <pr-number> -R <owner/repo>
   ```
4. Fetch the linked issue for context:
   ```bash
   gh issue view <issue-number> -R <owner/repo> --json title,body,labels
   ```
5. Write `STEWARD_CONTEXT.md` with:
   - Issue title, number, and URL
   - PR title, number, URL, and author
   - PR diff summary (files changed, additions, deletions)
   - Action: Review
6. Review the code:
   - Read the changed files
   - Check if the PR actually addresses the issue
   - Run tests if the repo has them
   - Look for bugs, edge cases, style issues
7. Post a review comment via `gh pr review` or summarize findings for the user to post

#### Propose

1. Clone the repo (no fork needed for reading):
   ```bash
   gh repo clone <owner/repo>
   ```
2. Fetch issue details:
   ```bash
   gh issue view <number> -R <owner/repo> --json title,body,labels,comments
   ```
3. Analyze the codebase to understand the relevant code paths
4. Write `STEWARD_CONTEXT.md` with:
   - Issue title, number, and URL
   - Action: Propose
   - Proposed approach (3-5 bullet points)
   - Files that would need to change
   - Estimated scope
5. Draft a proposal comment for the user to review before posting:
   - Summarize the planned approach
   - List specific files to modify
   - Ask if the approach looks right
   - Mention this is an AI-assisted analysis
6. After user approval, post the comment:
   ```bash
   gh issue comment <number> -R <owner/repo> --body "<proposal>"
   ```

### 3. Submit

For **Fix** actions: push branch and open a draft PR (same as before).

For **Review** actions: post the review via `gh pr review` or summarize for the user.

For **Propose** actions: post the proposal comment via `gh issue comment`.

## CLI Integration

The skill works standalone, but the Token Steward CLI adds persistent tracking, budgets, and local processing that saves Claude Code tokens.

### Detecting the CLI

At the start of any command, check if the CLI is installed:

```bash
which steward 2>/dev/null && steward --version
```

Store the result — don't check again in the same session.

### When to offer CLI installation

Offer to install the CLI (don't just mention it) when:
- The user has completed a discover → work → submit cycle
- The user runs discover more than once in a session
- The user asks about tracking, budgets, or history

**How to offer:**

> The Token Steward CLI can handle discovery and workspace setup locally, saving Claude Code tokens on future runs. It also tracks your contributions and enforces usage budgets.
>
> Want me to install it? I'll run:
> ```
> npm install -g token-steward && steward init
> ```

Only offer once per session. If the user declines, don't ask again.

### What the CLI adds

| Feature | Skill only | With CLI |
|---------|-----------|----------|
| Discover issues | Claude searches via `gh` | `steward discover` runs locally |
| Work on issues | Claude forks/branches via `gh` | `steward work` does it locally |
| Submit PRs | Claude pushes via `gh`/`git` | `steward submit` does it locally |
| Run history | None | Persistent, queryable |
| Token budgets | None | Enforced per-run and weekly |
| Scheduling | None | Automated contribution windows |
| Stats | Basic (from `gh pr list`) | Detailed per-run tracking |
