# Type Hierarchy Maintenance Playbook

This note documents how to keep the customized type hierarchy tooling in sync with upstream without hand-merging every upgrade. It assumes the TypeScript-first flow implemented in [../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L78-L137](../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L78-L137) and [../src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts#L32-L140](../src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts#L32-L140).

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
Drop the following helper at `script/update-type-hierarchy.sh` in your fork to codify the flow:
```bash
#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

origin_branch="origin/main"
stack_branch="personal/main"
feature_branch="feature/type-hierarchy-tool"

gh repo sync yulongbai-nov/vscode-copilot-chat --branch main

git fetch origin

git switch "$stack_branch"
git rebase "$origin_branch"

git switch "$feature_branch"
git rebase "$stack_branch"

npm run typecheck

echo "✅ type hierarchy stack rebased and validated"```
Mark it executable (`chmod +x script/update-type-hierarchy.sh`) and run whenever upstream advances.

## GitHub Actions Integration
- Run the dedicated maintenance workflow [../.github/workflows/type-hierarchy-maintenance.yml#L1-L29](../.github/workflows/type-hierarchy-maintenance.yml#L1-L29) when you want CI to execute the update script:
  ```yaml
  jobs:
    maintenance:
      runs-on: ubuntu-latest
      steps:
        - name: Checkout repository
          uses: actions/checkout@v4
  ```
- Trigger fork CI runs after each sync:
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
