---
name: token-steward:submit
description: Submit your contribution — push a PR, post a review, or post a proposal.
---

You are running the Token Steward submit command. This submits whatever work was done in the current session.

Follow these steps:

1. Read the contribution guidelines at `.claude/skills/token-steward/references/contributing.md`.

2. Detect the action type from context:
   - If `STEWARD_CONTEXT.md` exists, read it for the action type
   - If on a `steward/` branch with commits → **Fix** (push + PR)
   - If on a PR checkout branch → **Review** (post review comment)
   - Otherwise ask the user what to submit

---

## Fix — Push branch and open a draft PR

1. Check for uncommitted changes: `git status`
   - If uncommitted changes exist, ask the user if they'd like to commit them first

2. Check that commits exist on the current branch that aren't on the default branch.

3. Determine the upstream repo:
   ```bash
   git remote get-url upstream
   ```

4. Push the branch:
   ```bash
   git push -u origin <current-branch>
   ```

5. Extract the issue number from the branch name (steward/<number>-<slug>).

6. Create a draft PR:
   ```bash
   gh pr create --draft --title "<concise title>" --body "<body>"
   ```
   The PR body should include:
   - `Closes <owner/repo>#<number>` to link the issue
   - A summary of what was changed and why
   - Any testing done
   - `Token-Steward-Donation: <owner/repo>#<number>` footer

7. Report the PR URL to the user.

---

## Review — Post a review comment

1. Confirm the review content with the user.

2. Submit the review:
   ```bash
   gh pr review <pr-number> -R <owner/repo> --comment --body "<review>"
   ```

3. Report that the review was posted.

---

## Propose — Post a proposal comment

1. Confirm the proposal content with the user.

2. Post the comment:
   ```bash
   gh issue comment <number> -R <owner/repo> --body "<proposal>"
   ```

3. Report that the proposal was posted.
