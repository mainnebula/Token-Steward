---
name: token-steward:work
description: Set up a workspace for an open-source issue and start a guided session (fix, review, or propose).
---

You are running the Token Steward work command. The user should provide an issue reference like `owner/repo#123` and optionally an action type.

Follow these steps:

1. Read the skill knowledge base at `.claude/skills/token-steward/SKILL.md` for full context.

2. Parse the issue reference from the user's input. It should be in the format `owner/repo#number`. If not provided, ask for it.

3. Determine the action type. If the user specified one (fix, review, propose), use it. Otherwise, auto-detect:
   - Check for open PRs linked to the issue:
     ```bash
     gh pr list -R <owner/repo> --search "<issue-number>" --state=open --json number,title,url,author,additions,deletions
     ```
   - Check assignees:
     ```bash
     gh issue view <number> -R <owner/repo> --json assignees,labels,body,title
     ```
   - If open PRs exist → **Review**
   - If assigned and no open PRs → warn the user someone is already working on it, ask if they want to proceed
   - If large/complex labels or vague scope → **Propose**
   - Otherwise → **Fix**
   - Tell the user which action type was selected and why.

---

## Fix

For unclaimed, reasonably-sized issues — code a solution and prepare a PR.

1. Fork and clone the repository:
   ```bash
   gh repo fork <owner/repo> --clone --default-branch-only
   ```

2. Navigate into the cloned repo directory.

3. Create a working branch:
   ```bash
   git checkout -b steward/<issue-number>-<short-slug>
   ```
   (derive slug from issue title: lowercase, hyphens, max 40 chars)

4. Fetch issue details:
   ```bash
   gh issue view <number> -R <owner/repo> --json title,body,labels,comments,reactionGroups
   ```

5. Read the repo's README.md for project context.

6. Check for and read CONTRIBUTING.md if it exists.

7. Write a `STEWARD_CONTEXT.md` file in the repo root containing:
   - Issue title, number, and URL
   - Issue body (full text)
   - Labels
   - Summary of the repo (from README)
   - Key contribution guidelines (from CONTRIBUTING.md)
   - Action: Fix

8. Read `STEWARD_CONTEXT.md` to load full context, then begin working on the issue. Ask the user how they'd like to approach the implementation.

---

## Review

For issues that already have an open PR — review and test the existing contribution.

1. Clone the repo:
   ```bash
   gh repo clone <owner/repo>
   ```

2. Checkout the PR:
   ```bash
   gh pr checkout <pr-number> -R <owner/repo>
   ```

3. Fetch PR details and diff:
   ```bash
   gh pr view <pr-number> -R <owner/repo> --json title,body,files,additions,deletions,commits,comments,reviews
   gh pr diff <pr-number> -R <owner/repo>
   ```

4. Fetch the linked issue for context:
   ```bash
   gh issue view <issue-number> -R <owner/repo> --json title,body,labels
   ```

5. Write a `STEWARD_CONTEXT.md` file with:
   - Issue title, number, and URL
   - PR title, number, URL, and author
   - PR diff summary (files changed, additions, deletions)
   - Action: Review

6. Review the code:
   - Read the changed files in full context
   - Check if the PR actually addresses the issue
   - Look for bugs, edge cases, missing tests, style issues
   - Run the test suite if the repo has one
   - Check if CI is passing

7. Present findings to the user and draft a review comment. After user approval, submit via:
   ```bash
   gh pr review <pr-number> -R <owner/repo> --comment --body "<review>"
   ```

---

## Propose

For large or complex issues — analyze the codebase and draft an approach plan.

1. Clone the repo:
   ```bash
   gh repo clone <owner/repo>
   ```

2. Fetch issue details:
   ```bash
   gh issue view <number> -R <owner/repo> --json title,body,labels,comments
   ```

3. Read the repo's README.md and CONTRIBUTING.md for project context.

4. Analyze the codebase to understand the relevant code paths, architecture, and conventions.

5. Write a `STEWARD_CONTEXT.md` file with:
   - Issue title, number, and URL
   - Action: Propose
   - Proposed approach (3-5 bullet points)
   - Files that would need to change
   - Estimated scope and complexity

6. Draft a proposal comment for the user to review:
   - Clear summary of the planned approach
   - Specific files and functions to modify
   - Any open questions for the maintainer
   - Note that this is an AI-assisted analysis

7. Present the draft to the user. After approval, post it:
   ```bash
   gh issue comment <number> -R <owner/repo> --body "<proposal>"
   ```
