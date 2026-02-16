# Token Steward

Contribute to open-source projects you care about, powered by Claude Code.

Token Steward finds real issues on projects that matter to you, sets up everything you need, and guides you through making quality contributions. Got unused Claude Code tokens each week? Put them to work on the open-source tools you depend on.

## How it works

**Discover.** Pick your path: find issues on projects you've starred and use, browse high-impact issues on well-known open-source projects, or name a specific repo. No profile analysis or broad searching — just a quick choice and filtered results.

**Work.** Claude guides you through the fix, not the other way around. It explains what the bug is, what causes it, where it lives in the codebase, and walks through the fix approach — then asks if it makes sense before writing code. After implementing, it explains expected behavior and helps you test. You understand every change before it ships.

**Propose.** For larger issues, Claude analyzes the codebase and drafts a proposal comment. It walks you through the reasoning so you can evaluate and adjust before posting. The maintainer can then approve, suggest changes, or decline.

**Submit.** When you're satisfied with the fix and tests pass, Token Steward pushes your branch and opens a draft PR. Safe to run multiple times.

## Claude Code Plugin

Use Token Steward as slash commands directly in Claude Code. No npm install required — just `gh` CLI.

### Install

```bash
npx skills add mainnebula/token-steward
```

Or manually:

```bash
git clone https://github.com/mainnebula/token-steward.git /tmp/token-steward
cp -r /tmp/token-steward/.claude/* ~/.claude/
```

After installing, restart Claude Code for it to discover the new skill.

### Commands

| Command | What it does |
|---------|-------------|
| `/token-steward:discover` | Choose a path (your projects, important projects, or a specific repo) and find approachable issues |
| `/token-steward:work owner/repo#123` | Set up a workspace and get guided through understanding, fixing, and testing the issue |
| `/token-steward:submit` | Submit your contribution — PR, review, or proposal |
| `/token-steward:status` | Show environment, open PRs, budget, and workspace info |
| `/token-steward:stats` | Show contribution history and statistics |

### Plugin + CLI

The plugin works standalone with just `gh` CLI. If you also install the full CLI, the plugin detects it and delegates discovery, scoring, and workspace setup locally — saving Claude Code tokens and adding persistent tracking.

| Feature | Plugin only | Plugin + CLI |
|---------|-----------|-------------|
| Discover issues | Claude searches via `gh` | Runs locally, faster |
| Workspace setup | Claude forks/branches via `gh` | Handled locally |
| Contribution stats | Basic (from GitHub API) | Detailed per-run tracking |
| Token budgets | None | Enforced per-run and weekly |
| Run history | None | Persistent, queryable |
| Scheduling | None | Automated contribution windows |

## CLI

```
steward discover          # Find issues on projects you care about
steward work cli/cli#9432 # Jump into a guided Claude Code session
steward submit            # Review your changes and open a draft PR
```

### Install

```bash
npm install -g token-steward
steward init
```

`steward init` checks your environment, walks you through setup, and gets everything ready. After that, `steward discover` is all you need.

Already set up? Run `steward init --check` to verify prerequisites without changing anything.

### Configuration

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

# auto = propose first for complex issues
# always = always propose before coding
# never = skip straight to implementation
propose_first: auto
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

### Other commands

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

## How issues are scored

Token Steward ranks issues so you spend time on the ones that matter. Each issue is scored across four dimensions:

| Dimension   | Weight | What it looks at |
|-------------|--------|------------------|
| Reach       | 20%    | Reactions, comments, repo stars |
| Impact      | 25%    | Bug vs feature, maintainer engagement, category |
| Confidence  | 30%    | LLM receptivity, approachability labels, CI, CONTRIBUTING.md |
| Effort      | 25%    | Issue age, complexity labels, token budget fit |

## Roadmap

- **Public leaderboard.** Track contributions across Token Steward users. Issues resolved, PRs merged, tokens invested. See who's making the biggest impact.
- **Maintainer opt-in.** A `token-steward.yml` file maintainers drop in their repo to opt in and configure what issues are eligible for contributions.
- **Shared registry.** A registry service that maintainers can submit their projects to directly, so contributors always have fresh work to pick from.
- **PR outcome tracking.** Follow up on submitted PRs to measure merge rates and contribution quality over time.
- **Team mode.** Coordinate across multiple contributors to avoid duplicate work on the same issues.

## Development

```bash
git clone https://github.com/mainnebula/token-steward.git && cd token-steward
npm install
npm run dev          # Run via tsx (no build step)
npm test             # Run all tests (vitest)
npm run build        # Compile TypeScript
```

## License

MIT
