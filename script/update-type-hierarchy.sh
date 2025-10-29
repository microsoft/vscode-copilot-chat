#!/usr/bin/env bash
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
	echo "gh CLI is required" >&2
	exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

origin_branch="origin/main"
stack_branch="personal/main"
feature_branch="feature/type-hierarchy-tool"
fork_repo="yulongbai-nov/vscode-copilot-chat"

printf '==> Syncing fork %s\n' "$fork_repo"
gh repo sync "$fork_repo" --branch main

printf '==> Fetching upstream\n'
git fetch origin

git config rerere.enabled true
git config rerere.autoUpdate true

printf '==> Rebasing %s onto %s\n' "$stack_branch" "$origin_branch"
git switch "$stack_branch"
git rebase "$origin_branch"

printf '==> Rebasing %s onto %s\n' "$feature_branch" "$stack_branch"
git switch "$feature_branch"
git rebase "$stack_branch"

printf '==> Running typecheck\n'
npm run typecheck

printf '\n✅ type hierarchy stack rebased and validated\n'
