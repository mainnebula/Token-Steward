---
name: token-steward:stats
description: Show your open-source contribution history and statistics.
---

You are running the Token Steward stats command.

Follow these steps:

1. Check if the Token Steward CLI is installed:
   ```bash
   which steward 2>/dev/null && steward --version
   ```

2. **If the CLI is installed**, run `steward stats --json`, parse the JSON, and present a rich formatted report (skip to step 5 for formatting).

3. **If the CLI is not installed**, fetch the user's recent PRs:
   ```bash
   gh pr list --author=@me --state=all --limit=50 --json url,title,state,createdAt,mergedAt,headRepository,isDraft,headRefName
   ```

4. Filter to Token Steward contributions where identifiable (PRs from `steward/` branches or with `Token-Steward-Donation` in the body).

5. Present a formatted report:

   ```
   Token Steward — Stats
   =====================

   Contributions
     Total PRs:     12
     Merged:         8 (67%)
     Open:           3
     Closed:         1

   Repos contributed to
     cli/cli            4 PRs (3 merged)
     vercel/next.js     3 PRs (2 merged)
     nodejs/node        5 PRs (3 merged)

   Recent activity
     vercel/next.js #58201  Fix middleware redirect   merged · 3d ago
     cli/cli #9432          Fix glob matching         open · 5d ago
   ```

   If CLI data is available, also show:
   ```
   Token usage
     Total donated:    840,000 tokens
     This week:        120,000 tokens
     Avg per run:       35,000 tokens

   Streak: 5 consecutive successful contributions
   ```

6. If the CLI is NOT installed and the user has 3+ PRs, offer to install it:
   > "You've got a solid contribution history! The Token Steward CLI can track per-run token usage and detailed stats. Want me to install it? `npm install -g token-steward && steward init`"
