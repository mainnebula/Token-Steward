---
name: token-steward:status
description: Show current Token Steward state — environment, open PRs, CLI, and workspace info.
---

You are running the Token Steward status command.

Follow these steps:

1. Check if the Token Steward CLI is installed:
   ```bash
   which steward 2>/dev/null && steward --version
   ```

2. **If the CLI is installed**, run `steward status` and present the formatted output. Then also run the checks below to supplement.

3. Show GitHub authentication status:
   ```bash
   gh auth status
   ```

4. List the user's open contribution PRs:
   ```bash
   gh pr list --author=@me --state=open --limit=20 --json url,title,createdAt,headRepository,isDraft
   ```

5. Show current git branch info if in a steward workspace:
   ```bash
   git branch --show-current
   git log --oneline -5
   ```

6. Present a unified status report:

   ```
   Token Steward — Status
   ======================

   Environment
     GitHub CLI:     ✓ authenticated as @username
     Token Steward:  ✓ v0.1.0 (or: not installed)
     Current dir:    /path/to/workspace (or: not in a steward workspace)

   Open PRs (3)
     cli/cli #9432        Fix glob pattern matching     draft · 2d ago
     vercel/next.js #201  Fix middleware redirect        draft · 5d ago
     nodejs/node #51200   Update test runner docs        open · 1w ago

   Workspace
     Branch: steward/9432-fix-glob-matching
     Commits: 3 ahead of main
   ```

   If the CLI is installed, also show:
   ```
   Budget
     Weekly target:   1,600,000 tokens
     Used this week:  340,000 tokens
     Remaining:       1,260,000 tokens

   Schedule
     Next window: FRI 18:00 - 23:59
   ```

7. If the CLI is NOT installed and this is the first time running status, offer to install it:
   > "Want to track your contributions and see impact stats? I can install the Token Steward CLI: `npm install -g token-steward && steward init`"
