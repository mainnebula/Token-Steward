# RICE Scoring Formula

Token Steward scores issues using a RICE framework adapted for open-source contributions. Each dimension produces a score from 0 to 1, then dimensions are combined with weights.

## Formula

```
final_score = reach * 0.20 + impact * 0.25 + confidence * 0.30 + effort * 0.25
```

## Dimensions

### Reach (20%)

How many people care about this issue?

| Signal | Condition | Score Change |
|--------|-----------|-------------|
| Reactions | >= 1 | +0.10 |
| Reactions | >= 5 | +0.15 |
| Reactions | >= 20 | +0.15 |
| Comments | >= 2 | +0.10 |
| Comments | >= 5 | +0.10 |
| Repo stars | >= 1,000 | +0.05 |
| Repo stars | >= 10,000 | +0.05 |

Baseline: 0.30. Capped at 1.0.

### Impact (25%)

How valuable is solving this?

| Signal | Condition | Score Change |
|--------|-----------|-------------|
| Bug label | is_bug = true | +0.20 |
| Maintainer commented | has_maintainer_comment = true | +0.15 |
| Documentation category | category = "documentation" | +0.10 |
| Security category | category = "security" | +0.15 |

Baseline: 0.40. Capped at 1.0.

### Confidence (30%)

How likely is an LLM to produce an accepted contribution?

| Signal | Condition | Score Change |
|--------|-----------|-------------|
| LLM receptivity | Scaled 0-1 | + value * 0.30 |
| Approachability labels | good-first-issue, help-wanted, etc. | +0.15 |
| CONTRIBUTING.md exists | repo_has_contributing = true | +0.05 |
| CI configured | repo_has_ci = true | +0.10 |
| Descriptive title | length > 15 chars | +0.05 |
| Descriptive title | length > 40 chars | +0.05 |

Baseline: 0.30. Capped at 1.0.

Approachability labels: `good first issue`, `good-first-issue`, `help wanted`, `help-wanted`, `beginner-friendly`, `easy`, `small`, `documentation`, `docs`, `enhancement`.

### Effort (25%)

Inverse of expected difficulty (higher = easier = better).

| Signal | Condition | Score Change |
|--------|-----------|-------------|
| Fresh issue | age < 7 days | +0.15 |
| Recent issue | age < 30 days | +0.10 |
| Stale issue | age > 180 days | -0.10 |
| Small/easy labels | matches small/easy/trivial/minor | +0.15 |
| Large/complex labels | matches large/complex/major/epic | -0.15 |
| Fits in budget | est_tokens / budget_per_slot <= 1 | +0.10 |
| Comfortably fits | est_tokens / budget_per_slot <= 0.5 | +0.05 |

Baseline: 0.50. Clamped to [0, 1].

## Action Type Assignment

After scoring, assign an action type to each issue:

1. **Check for open PRs** linked to the issue:
   ```bash
   gh pr list -R <owner/repo> --search "<issue-number>" --state=open
   ```
   - If open PRs exist → **Review**

2. **Check assignees** (from the search results `assignees` field):
   - If assigned and no open PRs → **skip** (someone is working on it)

3. **Estimate complexity:**
   - Labels matching `large`, `complex`, `major`, `epic` → **Propose**
   - Issue body is vague (no clear steps, very short, or open-ended question) → **Propose**
   - Estimated tokens > 30,000 → **Propose**
   - Otherwise → **Fix**

## Inline Scoring Instructions

When scoring without the CLI, compute each dimension for every candidate issue:

1. Start with the baseline for each dimension
2. Add/subtract based on the signals available from `gh search issues` output and repo metadata
3. For signals you can't determine (like LLM receptivity), use 0.5 as a default
4. Compute the weighted sum
5. Assign an action type per the rules above
6. Present the top 5 issues sorted by final score, showing the score, action type, and key signals for each
