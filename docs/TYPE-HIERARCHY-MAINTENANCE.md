# Type Hierarchy Maintenance Playbook

This note documents how to keep the customized type hierarchy tooling in sync with upstream without hand-merging every upgrade. It assumes the TypeScript-first flow implemented in [../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L78-L137](../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L78-L137) and [../src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts#L32-L140](../src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts#L32-L140).

For a feature-agnostic overview of the maintenance system, see [./FEATURE-MAINTENANCE-GUIDE.md](./FEATURE-MAINTENANCE-GUIDE.md).

```typescript
async prepareTypeHierarchy(uri: vscode.Uri, position: vscode.Position): Promise<vscode.TypeHierarchyItem[]> {
	const document = await this.tryGetDocument(uri);
	if (document && this.shouldUseTypeScriptProvider(document)) {
		this.updateTypeScriptSnapshot(document);
		this.fireTypeScriptTelemetry();
```

## Branch Layout
- Keep `origin` pointed at `microsoft/vscode-copilot-chat` and fork under `yulongbai-nov/vscode-copilot-chat`.
- Track a clean upstream branch locally:
  ```bash
  git fetch origin
  git switch -c main-upstream origin/main
  ```
- Maintain a long-lived integration branch that layers customizations:
  ```bash
  git switch main-upstream
  git branch --force personal/main main-upstream
  git switch personal/main
  git merge --ff-only feature/type-hierarchy-tool
  ```
- Feature work continues on topic branches (`feature/type-hierarchy-tool`) rebased onto `personal/main` before review.

## Routine Update Flow
1. Sync your fork with upstream using GitHub CLI:
   ```bash
   gh repo sync yulongbai-nov/vscode-copilot-chat --branch main
   ```
2. Refresh local tracking branches and enable automatic conflict reuse:
   ```bash
   git fetch origin
   git config rerere.enabled true
   git config rerere.autoUpdate true
   ```
3. Rebase the integration stack and update the feature branch:
   ```bash
   git switch personal/main
   git rebase origin/main
   git switch feature/type-hierarchy-tool
   git rebase personal/main
   ```
4. Run a quick validation before pushing:
   ```bash
   npm run typecheck
   ```
5. Push the updated branches to your fork:
   ```bash
   git push --force-with-lease origin feature/type-hierarchy-tool personal/main
   ```

## When Conflicts Appear
- Resolve each conflict once; `rerere` remembers your resolution the next time the same hunk reappears.
- Prefer extending existing customization files instead of editing shared upstream files to reduce future conflicts, e.g. keep TypeScript-specific helpers near [../src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts#L169-L190](../src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts#L169-L190).
- If upstream adds new capability entry points, integrate them in dedicated files (`src/extension/tools/node/typeHierarchyTool.ts`) and register through `allTools.ts` to keep diffs isolated.

## Patch Queue Fallback
When rebases become noisy, capture your adjustments as a patch series:
```bash
git switch personal/main
git format-patch origin/main --output-directory .git/patches/type-hierarchy
```
Apply them after syncing upstream:
```bash
git switch main-upstream
git reset --hard origin/main
git switch personal/main
git am --3way .git/patches/type-hierarchy/*.patch
```
This makes it obvious which patch fails and keeps history linear.

## Automated Update Script
The helper lives in [../script/update-type-hierarchy.sh#L1-L91](../script/update-type-hierarchy.sh#L1-L91). It accepts a few environment toggles so CI, Copilot, and maintainers can share the same entry point:
```bash
skip_sync="${SKIP_FORK_SYNC:-0}"
auto_strategy="${AUTO_RESOLVE_STRATEGY:-}"
simulate_conflict="${SIMULATE_CONFLICT:-0}"

if [[ "$skip_sync" != "1" ]]; then
	printf '==> Syncing fork %s\n' "$fork_repo"
	gh repo sync "$fork_repo" --branch main
else
	printf '==> Skipping fork sync (SKIP_FORK_SYNC=%s)\n' "$skip_sync"
fi
```
- `SKIP_FORK_SYNC=1` keeps the rebase flow local when you have already synchronized the fork.
- `AUTO_RESOLVE_STRATEGY=theirs` (or another `--strategy-option`) retries the rebase with a conflict bias; see [../script/update-type-hierarchy.sh#L65-L83](../script/update-type-hierarchy.sh#L65-L83).
- `SIMULATE_CONFLICT=1` stops early with a conflict-style failure so the remediation tooling can be rehearsed without touching upstream history; see [../script/update-type-hierarchy.sh#L39-L44](../script/update-type-hierarchy.sh#L39-L44).

Every run ends with a typecheck to catch API drift (see [../script/update-type-hierarchy.sh#L88-L89](../script/update-type-hierarchy.sh#L88-L89)):
```bash
printf '==> Running typecheck\n'
npm run typecheck
```

## GitHub Actions Integration
- The maintenance workflow runs nightly at 02:15 UTC and supports manual dispatch with the `simulate_conflict` toggle; see [../.github/workflows/type-hierarchy-maintenance.yml#L1-L39](../.github/workflows/type-hierarchy-maintenance.yml#L1-L39).
- Merge-conflict remediation is handled by the agent workflow at [../.github/workflows/type-hierarchy-maintenance-agent.yml#L16-L200](../.github/workflows/type-hierarchy-maintenance-agent.yml#L16-L200), which reruns the updater with `AUTO_RESOLVE_STRATEGY=theirs`, writes a report under `docs/reports/`, and opens a follow-up PR.
- When human help is required, trigger the delegate workflow at [../.github/workflows/copilot-maintenance-delegate.yml#L1-L58](../.github/workflows/copilot-maintenance-delegate.yml#L1-L58) to leave an `@copilot` comment (optionally including extra instructions) on the blocking pull request.
- Trigger fork CI runs after each sync if additional validation is needed:
  ```bash
  gh workflow run typecheck.yml --repo yulongbai-nov/vscode-copilot-chat
  ```
- Monitor status with:
  ```bash
  gh run list --repo yulongbai-nov/vscode-copilot-chat --limit 5
  ```
- When ready to share changes, open an internal PR against your fork:
  ```bash
  gh pr create --repo yulongbai-nov/vscode-copilot-chat --base personal/main --head feature/type-hierarchy-tool --title "Type hierarchy refresh" --body "Automated refresh against upstream"
  ```

Following this playbook keeps the customized type hierarchy tooling current with minimal manual merging while ensuring each sync is validated before it lands in your fork.
