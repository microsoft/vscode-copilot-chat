# Type Hierarchy Maintenance Spec

## Overview
This document formalizes the maintenance workflow for the customized type hierarchy tooling. The goal is to keep the fork synchronized with `microsoft/vscode-copilot-chat` while preserving local enhancements implemented in:
- [../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L78-L137](../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L78-L137)
- [../src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts#L32-L190](../src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts#L32-L190)

## Objectives
- Provide a repeatable branch strategy that separates upstream tracking (`main-upstream`), integration (`personal/main`), and feature work (`feature/type-hierarchy-tool`).
- Automate the rebase-and-validate cycle using GH CLI and NPM tooling.
- Reduce future merge conflicts through rerere and structural isolation of custom code.
- Supply documentation and action plan artifacts to guide future maintenance.

## Non-Goals
- Changing the runtime behavior of the TypeScript hierarchy provider.
- Altering upstream release or packaging processes.
- Replacing existing CI pipelines.

## System Context
```
Upstream repo (origin/main) --> main-upstream (local tracking)
                                   |
                                   v
                            personal/main (integration)
                                   |
                                   v
                 feature/type-hierarchy-tool (active customization)
```

## Key Workflows
1. **Sync and Rebase**
   - Pull upstream changes via `gh repo sync`.
   - Rebase integration and feature branches while reusing conflict resolutions through `rerere`.
   - Run `npm run typecheck` to validate language tooling remains stable.

2. **Patch Queue Fallback**
   - Export customized commits as patches for manual inspection when rebases become noisy.
   - Reapply patches using `git am --3way` to isolate problematic hunks.

3. **Automation Script**
   - Provide a reusable script (`script/update-type-hierarchy.sh`) that runs the sync → rebase → validate pipeline end-to-end and exposes environment switches (`SKIP_FORK_SYNC`, `AUTO_RESOLVE_STRATEGY`, `SIMULATE_CONFLICT`).
4. **GitHub Action Orchestration**
   - Expose the maintenance flow through [../.github/workflows/type-hierarchy-maintenance.yml#L1-L39](../.github/workflows/type-hierarchy-maintenance.yml#L1-L39) so the update can run in CI each night and on-demand.
   - Rely on the agent workflow at [../.github/workflows/type-hierarchy-maintenance-agent.yml#L16-L200](../.github/workflows/type-hierarchy-maintenance-agent.yml#L16-L200) to attempt automated conflict resolution and generate reports.
   - Provide a manual Copilot escalation path via [../.github/workflows/copilot-maintenance-delegate.yml#L1-L58](../.github/workflows/copilot-maintenance-delegate.yml#L1-L58), which posts an `@copilot` comment on the specified pull request.

## Acceptance Criteria
- Maintenance playbook published at [../docs/TYPE-HIERARCHY-MAINTENANCE.md](../docs/TYPE-HIERARCHY-MAINTENANCE.md).
- Generalized maintenance guidance published at [../docs/FEATURE-MAINTENANCE-GUIDE.md](../docs/FEATURE-MAINTENANCE-GUIDE.md) so future features can reuse the automation strategy.
- Spec (this document) and execution plan finalized.
- Automation script committed and executable (`chmod +x script/update-type-hierarchy.sh`).
- GitHub Action defined at [../.github/workflows/type-hierarchy-maintenance.yml#L1-L39](../.github/workflows/type-hierarchy-maintenance.yml#L1-L39) invoking the maintenance script on both schedule and manual dispatch.
- Remediation agent defined at [../.github/workflows/type-hierarchy-maintenance-agent.yml#L16-L200](../.github/workflows/type-hierarchy-maintenance-agent.yml#L16-L200) that records failure context and opens a follow-up PR when automation cannot resolve conflicts silently.
- Copilot delegate workflow available at [../.github/workflows/copilot-maintenance-delegate.yml#L1-L58](../.github/workflows/copilot-maintenance-delegate.yml#L1-L58) for human supervised escalations.
- Example run documented in plan notes showing successful typecheck.

## Validation Plan
- Verify rebase workflow on a dry run against `origin/main`.
- Confirm `npm run typecheck` passes post-rebase.
- Capture rerere cache footprint for recurring conflicts and ensure no unintended code changes.
- Exercise both the remediation workflow and the Copilot delegate by simulating a failure and confirming the generated artifacts.

## References
- [Git rerere documentation](https://git-scm.com/docs/git-rerere)
- [GitHub CLI sync reference](https://cli.github.com/manual/gh_repo_sync)
- Implementation sources listed under **Overview**.
