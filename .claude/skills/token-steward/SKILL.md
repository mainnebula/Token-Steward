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

Discovery uses a **feed-first** approach to minimize API calls and Claude Code token usage.

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

1. Build a profile from the user's GitHub activity automatically (3 API calls):
   - Their repos: `gh repo list @me` → languages, topics
   - Their starred repos: `gh api user/starred` → projects they care about
   - Their recent PRs: `gh pr list --author=@me` → ecosystems they're active in
   Present a summary and ask if they want to adjust. If their profile is thin (< 5 repos, no stars), fall back to asking conversationally about interests

2. **Fetch the feed** (one HTTP call):
   ```bash
   curl -sf "https://raw.githubusercontent.com/mainnebula/token-steward/feed/feed/feed.json"
   ```

3. **Filter locally** by user preferences — language, stars, labels. This is instant, no API calls.

4. If the feed has **3+ matching issues**, present them directly (already scored, already checked for PRs/assignees).

5. If the feed has **fewer than 3 matches** for the user's criteria, supplement with a targeted live search:
   ```bash
   gh search issues --label="good first issue" --language=<lang> --no-assignee --sort=reactions --limit=10 --json number,title,repository,labels,reactionGroups,comments,createdAt,assignees
   ```
   For live results, do a quick PR check and score inline per `references/scoring.md`.

6. Assign action type (Fix, Review, or Propose) per the rules in "Action Types" above.

7. Dedupe against user's open PRs:
   ```bash
   gh pr list --author=@me --state=open --json url,headRepository
   ```

8. Present top 5 sorted by score, with action type shown for each.

### 2. Work

Behavior depends on the action type:

#### Fix (default)

1. Fork and clone the repo:
   ```bash
   gh repo fork <owner/repo> --clone --default-branch-only
   ```
2. Create a working branch:
   ```bash
   git checkout -b steward/<issue-number>-<slug>
   ```
3. Fetch issue details:
   ```bash
   gh issue view <number> -R <owner/repo> --json title,body,labels,comments
   ```
4. Write `STEWARD_CONTEXT.md` in the repo root with:
   - Issue title, number, and URL
   - Issue body
   - Labels
   - Summary of repo README
   - Key sections from CONTRIBUTING.md (if present)
   - Action: Fix
5. Read the context file and begin working on the issue

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
