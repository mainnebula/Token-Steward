# Contribution Conventions

Guidelines for submitting quality open-source contributions through Token Steward.

## PR Etiquette

- **Always open as draft PR** — Let maintainers review before merging. Use `gh pr create --draft`.
- **Reference the issue** — Include `Closes #<number>` or `Fixes #<number>` in the PR body so the issue auto-closes on merge.
- **Run tests before submitting** — If the repo has CI, check that tests pass locally first.
- **Keep changes focused** — One issue per PR. Don't bundle unrelated changes.
- **Respect existing style** — Match the repo's code style, naming conventions, and patterns.

## Commit Messages

Use clear, descriptive commit messages:

```
<type>: <short description>

<optional body explaining why>

Contributed via Token Steward
```

Types: `fix`, `feat`, `docs`, `refactor`, `test`, `chore`

The `Contributed via Token Steward` footer identifies contributions made through this workflow. **Do NOT include "Generated with Claude Code" or any Claude/AI attribution** — use the Token Steward footer instead.

## Propose-First Protocol

For larger issues (estimated >30k tokens), post a proposal comment on the issue **before writing code**:

1. Summarize the planned approach in 3-5 bullet points
2. Mention specific files you plan to modify
3. Ask if the approach looks right
4. Wait for maintainer feedback before proceeding

This avoids wasting tokens on an approach the maintainer would reject.

When to propose first:
- Issue body is vague or open-ended
- Multiple valid approaches exist
- Changes span many files or modules
- The issue has been open a long time (may have hidden context)

When it's safe to skip:
- Issue is clearly scoped (e.g., "fix typo in README")
- Labeled `good first issue` with specific instructions
- Documentation-only changes

## Respect CONTRIBUTING.md

If the target repo has a `CONTRIBUTING.md`:
1. Read it before starting work
2. Follow their PR template if they have one
3. Follow their branch naming convention if specified
4. Follow their commit message convention if specified
5. Include any required fields (e.g., changelog entries, test plans)
