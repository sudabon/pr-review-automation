# ai-dev-loop

`ai-dev-loop` is a local CLI that automates a controlled development loop:

1. collect the Git diff
2. ask Claude to review it
3. ask a configured fixer, Codex first and Cursor second by default, to address review comments
4. run validation commands
5. ask Claude for a final decision
6. repeat until approved, stopped, or handed back for human review

The tool wraps locally authenticated subscription CLIs. It does not call paid API endpoints directly.

## Requirements

- Node.js 20+
- Git
- `claude` CLI authenticated locally
- `codex` CLI authenticated locally when Codex is enabled as a fixer
- `agent` CLI authenticated locally when Cursor Agent is enabled as a fixer
- `gh` authenticated when the review/fix skills need PR context
- `pr-review-toolkit:review-pr` and `fix-pr-comments` available in the agent environment

## Setup

Install dependencies and build:

```bash
pnpm install
pnpm run build
```

Create the local config:

```bash
pnpm cli init
```

This writes `.ai-dev-loop/config.yml` if it does not already exist. Existing config files are never overwritten.

## Usage

Run the full loop against the configured base branch:

```bash
pnpm cli run
```

Review only, without fixers, validation, or final review:

```bash
pnpm cli run --only-review
```

Run without applying fixer changes:

```bash
pnpm cli run --dry-run
```

Override base branch and loop count:

```bash
pnpm cli run --base main --max-loops 1
```

Resume a previous run:

```bash
pnpm cli run --resume 2026-06-19T10-00-00-000Z-abc123
```

Disable success commits:

```bash
pnpm cli run --no-commit
```

To create a pull request after a successful automatic commit, set
`git.create_pr_on_success: true`. The configured `git.pr_command` must begin
with `gh pr create`; the default is `gh pr create --fill`. PR creation results
are recorded, and a creation failure stops the run for human follow-up.

To use a temporary branch in the current checkout instead of a linked worktree,
set `git.worktree_mode: branch`. This mode requires a clean working tree.

## Artifacts

Each run writes files under `.ai-dev-loop/runs/<run_id>/`:

- `input/diff.patch`
- `input/status.txt`
- `review/claude-review.md`
- `review/review.json`
- `fix/codex-prompt.md` and `fix/codex-output.md`
- `fix/cursor-prompt.md` and `fix/cursor-output.md`
- `validation/*.log`
- `validation/validation-result.json`
- `final/claude-final-review.md`
- `final/final-result.json`
- `meta/command-log.jsonl`
- `meta/loop-state.json`
- `meta/pr-result.json` when automatic PR creation is enabled

## Verification

```bash
pnpm run verify
```
