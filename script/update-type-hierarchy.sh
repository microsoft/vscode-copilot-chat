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
original_branch="$(git rev-parse --abbrev-ref HEAD)"

cleanup() {
	if [[ -n "$original_branch" ]]; then
		git switch "$original_branch" >/dev/null 2>&1 || true
	fi
}

trap cleanup EXIT

printf '==> Syncing fork %s\n' "$fork_repo"
gh repo sync "$fork_repo" --branch main

printf '==> Fetching upstream\n'
git fetch origin

git config rerere.enabled true
git config rerere.autoUpdate true

if git show-ref --verify --quiet "refs/remotes/origin/$feature_branch"; then
	if git show-ref --verify --quiet "refs/heads/$feature_branch"; then
		git switch "$feature_branch"
		git reset --hard "origin/$feature_branch"
	else
		git switch -c "$feature_branch" "origin/$feature_branch"
	fi
else
	echo "Missing remote branch origin/$feature_branch" >&2
	exit 1
fi

if ! git show-ref --verify --quiet "refs/heads/$stack_branch"; then
	printf '==> Bootstrapping %s from %s\n' "$stack_branch" "$feature_branch"
	git branch "$stack_branch" "$feature_branch"
fi

printf '==> Rebasing %s onto %s\n' "$stack_branch" "$origin_branch"
git switch "$stack_branch"
git rebase "$origin_branch"

printf '==> Rebasing %s onto %s\n' "$feature_branch" "$stack_branch"
git switch "$feature_branch"
git rebase "$stack_branch"

printf '==> Running typecheck\n'
npm run typecheck

printf '\n✅ type hierarchy stack rebased and validated\n'
