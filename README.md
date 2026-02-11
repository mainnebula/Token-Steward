# Token Steward

Turn your unused Claude Code tokens into open-source contributions.

Most Claude Max subscribers don't use their full weekly token allowance. Token Steward helps you put that surplus to work by finding real issues on important open-source projects and helping you resolve them with Claude Code.

## How it works

```
steward discover          # Find impactful issues worth your time
steward work cli/cli#9432 # Jump into a guided Claude Code session
steward submit            # Review your changes and open a draft PR
```

**Discover.** Find interesting, important open-source projects that actually need help. Token Steward uses the GitHub API and your curated registry to find open issues, then scores them by impact and feasibility. You see the ones where your contribution will matter most. Pick one and go.

**Work.** Solve real issues alongside Claude Code. Token Steward sets up everything (forks the repo, creates a branch, pulls in the issue details) then drops you into a Claude Code session with full context already loaded. Just ask Claude to get started. It already knows the issue, the codebase, and what needs to happen.

**Submit.** You're the human in the loop. Review the changes, run the tests, and when you're satisfied, submit quality code to a project that needs it. Token Steward pushes your branch and opens a draft PR. Safe to run multiple times.

## Setup

```bash
git clone <repo-url> token-steward && cd token-steward
nvm install 22 && nvm use 22
npm install && npm run setup
```

`steward init` checks your environment, walks you through policy config, builds the project, and links the CLI globally. After that, `steward discover` is all you need.

Already set up? Run `steward init --check` to verify prerequisites without changing anything.

## Configuration

**`config/policy.yaml`** controls how and when you contribute:

```yaml
weekly_target_tokens: 500000
weekly_min_reserve_tokens: 25000

schedule:
  - day: FRI
    start: "18:00"
    end: "23:59"
  - day: SAT
    start: "09:00"
    end: "23:59"

filters:
  categories_allow: [developer-tools, documentation, security, ai-ml]
  min_confidence: 0.40

limits:
  max_concurrency: 2
  max_tokens_per_run: 60000
  max_runs_per_day: 6
```

**`config/registry.yaml`** is your list of projects you want to contribute to. Each entry specifies which issue labels to look for:

```yaml
repositories:
  - slug: cli/cli
    name: GitHub CLI
    category: developer-tools
    tags: [cli, go, github]
    issue_labels: [good first issue, help wanted]
```

## How issues are scored

Token Steward ranks issues so you spend time on the ones that matter. Each issue is scored across four dimensions:

| Dimension   | Weight | What it looks at |
|-------------|--------|------------------|
| Reach       | 20%    | Reactions, comments, repo stars |
| Impact      | 25%    | Bug vs feature, maintainer engagement, category |
| Confidence  | 30%    | LLM receptivity, approachability labels, CI, CONTRIBUTING.md |
| Effort      | 25%    | Issue age, complexity labels, token budget fit |

## Other commands

```bash
steward init             # Setup wizard (prereqs, config, build)
steward init --check     # Verify prerequisites only
steward status           # Show current state
steward usage            # Check token budget
steward runs             # List recent contributions
steward stats            # Show contribution statistics
steward cancel <id>      # Cancel a run
steward clean            # Remove workspace clones to free disk space
steward export           # Export registry and scored issues as JSON
steward pause            # Pause autopilot
steward resume           # Resume autopilot
```

## Roadmap

- **Public leaderboard.** Track contributions across Token Steward users. Issues resolved, PRs merged, tokens donated. See who's making the biggest impact.
- **Shared registry.** A registry service that maintainers can submit their projects to directly, so contributors always have fresh work to pick from.
- **PR outcome tracking.** Follow up on submitted PRs to measure merge rates and contribution quality over time.
- **Multi-provider support.** Extend beyond Claude Code to other AI tools with token or credit systems.
- **Team mode.** Coordinate across multiple contributors to avoid duplicate work on the same issues.

## Development

```bash
npm run dev          # Run via tsx (no build step)
npm test             # Run all tests (vitest)
npm run build        # Compile TypeScript
```

## License

MIT
