# Type Hierarchy Path Compatibility Plan

## Context

The Type Hierarchy feature adds TypeScript-specific orchestration inside the language services layer. Two core entry points currently import Node.js built-ins via the `node:` protocol, which breaks our web-targeted bundles and the esbuild gate used by merge validation.

Language bootstrap imports `node:path` to normalize snapshot keys: [../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L6-L24](../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L6-L24)

```typescript
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TypeScriptServiceHost } from '../typescript/vscode/typescriptServiceHost';
import { TypeScriptTypeHierarchyProvider } from '../typescript/vscode/typescriptTypeHierarchyProvider';
import { ITelemetryService } from '../../telemetry/common/telemetry';
```

The TypeScript host relies on `node:path` utilities when locating `tsconfig.json` and script snapshots: [../src/platform/languages/typescript/vscode/typescriptServiceHost.ts#L6-L118](../src/platform/languages/typescript/vscode/typescriptServiceHost.ts#L6-L118)

```typescript
import * as path from 'node:path';
import * as ts from 'typescript';
import type * as vscode from 'vscode';

interface ITypeScriptProject {
	readonly key: string;
	readonly rootDir: string;
```

Tests also reference `node:path`, which is fine for Node-driven Vitest runs but needs an explicit plan to keep hermetic behavior: [../src/platform/languages/typescript/test/vscode/typescriptTypeHierarchyProvider.spec.ts#L6-L74](../src/platform/languages/typescript/test/vscode/typescriptTypeHierarchyProvider.spec.ts#L6-L74)

```typescript
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
	class Position {
```

## Goals

- Restore esbuild parity so the feature compiles for both desktop (Node) and web/simulation bundles.
- Leverage our existing runtime-agnostic path helpers rather than layering additional bundler aliases.
- Preserve test ergonomics while keeping imports explicit for Node-only utilities such as `os`.

## Proposed Changes

1. **Adopt VS Path Shim**
   Replace `node:path` imports in runtime code with `src/util/vs/base/common/path`. This module mirrors Node semantics and already underpins other cross-environment services.

2. **Normalize Access Points**
   Introduce a tiny adapter inside `TypeScriptServiceHost` to unify Node and web invocations. Most existing method calls (`path.normalize`, `path.dirname`, `path.join`) map 1:1 to the shim. Any missing APIs will be polyfilled via helper functions (for example `isAbsolute`).

3. **Guard Node-only Branches**
   Audit the host for direct `ts.sys` file IO usage. Where we depend on Node-only behavior (e.g., reading from disk), ensure the feature falls back to VS Code commands or early exit in web contexts. This prevents runtime failures if the web worker lacks `ts.sys` capabilities.

4. **Test Updates**
   Keep Vitest suites on `node:path` because they execute under Node. Document the rationale inline and add a descriptive comment so future contributors know the divergence is intentional.

5. **Documentation**
   Share this plan in PR discussions and reference the doc when reviewers ask about the cross-platform strategy.

## Validation

- `npm run compile`
- `npm run test:unit -- src/platform/languages/typescript/test/vscode/typescriptTypeHierarchyProvider.spec.ts`
- Web worker smoke: `npm run test:extension -- --grep "Type Hierarchy"` (ensures bundle compatibility)

## Work Breakdown

| Step | Description |
| --- | --- |
| 1 | Swap runtime imports to the VS path shim and adjust typings |
| 2 | Add helper functions if the shim lacks parity with required APIs |
| 3 | Run compile + targeted tests, fix regressions |
| 4 | Submit PR referencing this document |

## Risks & Mitigations

- **Missing Path API**: The shim might not export every helper we use. Mitigation: create wrapper functions or default to `posix`/`win32` variants available in the copy.
- **Performance**: The shim is pure TypeScript/JS; watch for hot-path regressions when registering large workspaces. We'll profile `prepare` on sizable repos if regressions surface.
- **Web Behavior Gaps**: TypeScript language service may still expect Node APIs. If we detect failures, gate the TypeScript-specific hierarchy provider to desktop until we ship a proper web story.

## Timeline

The changes are scoped to a single branch (`fix/type-hierarchy-cross-platform-path`) with one to two days of iteration, primarily covering code swaps, adapter verification, and test runs.
