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

For unclaimed, reasonably-sized issues — guide the user through understanding and fixing the bug together.

**The key principle: Claude explains at every step. The user should understand what was broken, why, what changed, and how to verify. Claude doesn't silently fix and move on.**

### Step 1: Set up the workspace

Fork and clone the repository:
```bash
gh repo fork <owner/repo> --clone --default-branch-only
```

Navigate into the cloned repo directory.

Create a working branch:
```bash
git checkout -b steward/<issue-number>-<short-slug>
```
(derive slug from issue title: lowercase, hyphens, max 40 chars)

### Step 2: Read and understand the issue

Fetch issue details:
```bash
gh issue view <number> -R <owner/repo> --json title,body,labels,comments,reactionGroups
```

Read the repo's README.md for project context.

Check for and read CONTRIBUTING.md if it exists.

### Step 3: Explain the bug to the user

Present a clear explanation covering:

- **What the bug is** — plain language summary of the problem
- **What symptoms it causes** — how this affects users of the project
- **Where it lives in the codebase** — specific files and lines
- **Why it happens** — the root cause

Keep this conversational, not a wall of text. The user should walk away understanding the bug well enough to explain it to someone else.

### Step 4: Explain the fix approach

Walk through the proposed solution:

- **What needs to change and why** — the specific modifications needed
- **The code changes** — walk through what each change does
- **Edge cases or risks** — anything that could go wrong or needs extra care

**Ask the user if this approach makes sense before writing any code.** Wait for their confirmation or feedback.

### Step 5: Implement the fix

Write the code. As you make each change, explain what you're doing and why — don't just silently edit files.

### Step 6: Explain expected behavior after the fix

Once the code is written, explain:

- **What the new behavior looks like** — what users will see after the fix
- **How it differs from the broken behavior** — before vs. after
- **Side effects or related areas** — anything else that might be affected

### Step 7: Help the user test

Guide the user through verification:

- **How to test manually** — specific steps they can follow
- **Existing tests** — point to the test suite and explain how to run it
- **New test cases** — suggest what additional tests would be valuable, if any

Let the user run the tests and confirm the fix works. Don't just run them silently.

### Step 8: Submit

Only after the user is satisfied with the fix and testing, proceed to submit. Push the branch and open a draft PR, or hand off to `/token-steward:submit`.

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

5. Review the code:
   - Read the changed files in full context
   - Check if the PR actually addresses the issue
   - Look for bugs, edge cases, missing tests, style issues
   - Run the test suite if the repo has one
   - Check if CI is passing

6. Present findings to the user and draft a review comment. Walk through what you found and why it matters. After the user approves the review, submit via:
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

5. Draft a proposal for the user to review:
   - Clear summary of the planned approach
   - Specific files and functions to modify
   - Estimated scope and complexity
   - Any open questions for the maintainer
   - Note that this is an AI-assisted analysis

6. Walk the user through the proposal — explain the reasoning behind each part so they can evaluate it and suggest changes.

7. After the user approves, post it:
   ```bash
   gh issue comment <number> -R <owner/repo> --body "<proposal>"
   ```
