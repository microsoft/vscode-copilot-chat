# TypeScript Type Hierarchy VS Code Registration Plan

## Background
The repository now ships an in-process TypeScript type hierarchy provider that queries the TypeScript compiler API directly. The provider already powers Copilot tools but the VS Code "Show Type Hierarchy" command still routes to the built-in language server, returning empty results for TS/JS files.

### Current Implementation Reference
File: [../src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts#L32-L44](../src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts#L32-L44)
```typescript
	const context = await this.host.getContext(uri, token);
	if (!context) {
		return [];
	}

	const declaration = this.findDeclarationAtPosition(context, position);
```

File: [../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L79-L85](../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L79-L85)
```typescript
	const document = await this.tryGetDocument(uri);
	if (document && this.shouldUseTypeScriptProvider(document)) {
		this.updateTypeScriptSnapshot(document);
		this.fireTypeScriptTelemetry();
		const cancellation = new vscode.CancellationTokenSource();
```

## Problem Statement
- The VS Code command palette still executes `vscode.prepareTypeHierarchy`, which lacks TypeScript support, so users see empty trees in the Extension Development Host.
- Without a registered provider, the Copilot implementation cannot round-trip subtype queries initiated from VS Code UI constructs that depend on the command.

## Goals
- Register a VS Code `TypeHierarchyProvider` for `typescript`, `typescriptreact`, `javascript`, and `javascriptreact` documents.
- Reuse `ILanguageFeaturesService` so Copilot tool calls and VS Code UI share the same caching, telemetry, and cancellation pathways.
- Respect document snapshots for unsaved edits and ensure disposal logic mirrors existing provider lifecycle.

## Non-Goals
- Modifying the TypeScript provider’s symbol resolution or subtype search algorithms.
- Supporting non-TypeScript languages beyond the existing LSP delegation path.
- Introducing new telemetry events beyond the existing `copilot.typeHierarchy.typescript.used` signal.

## Proposed Approach

### 1. VS Code Adapter Contribution
- Add `TypeHierarchyContribution` under `src/extension/languages/vscode-node/typeHierarchy.contribution.ts` implementing `IExtensionContribution`.
- Within the constructor, register a `vscode.languages.registerTypeHierarchyProvider` for selector `[{ scheme: 'file', language: 'typescript' }, { scheme: 'file', language: 'typescriptreact' }, { scheme: 'file', language: 'javascript' }, { scheme: 'file', language: 'javascriptreact' }, { scheme: 'untitled', language: 'typescript' }, { scheme: 'untitled', language: 'typescriptreact' }]` to cover unsaved buffers.
- Adapter methods should delegate to `ILanguageFeaturesService.prepareTypeHierarchy`, `getTypeHierarchySupertypes`, and `getTypeHierarchySubtypes`, wiring cancellation tokens to VS Code’s infrastructure.
- Reuse the snapshot updater in `LanguageFeaturesServiceImpl` by letting the service continue tracking documents; the adapter should be a thin `vscode.TypeHierarchyProvider` wrapper.

### 2. Contribution Wiring
- Export the new contribution from `src/extension/languages/vscode-node/index.ts` (if present) or directly add to `vscodeNodeContributions` in `src/extension/extension/vscode-node/contributions.ts` so it loads in both standard and agent-hosted sessions.
- Ensure the contribution disposes the registration via `_register` to align with existing contribution patterns.

### 3. Service Enhancements (If Needed)
- Extend `LanguageFeaturesServiceImpl` only if the adapter needs additional helpers (e.g., to accept external cancellation tokens). The current API already covers the necessary calls, so changes are expected to be minimal.
- Confirm the telemetry guard remains single-fire by routing the first adapter invocation through existing service methods.

### 4. Testing Strategy
- Add integration coverage similar to existing language tests by spinning up the extension host and invoking `vscode.commands.executeCommand('vscode.prepareTypeHierarchy', ...)` against TS fixtures.
- Augment the unit suite in [../src/platform/languages/typescript/test/vscode/typescriptTypeHierarchyProvider.spec.ts#L78-L116](../src/platform/languages/typescript/test/vscode/typescriptTypeHierarchyProvider.spec.ts#L78-L116)
```typescript
	const [animalItem] = await provider.prepare(uri, animalPosition, cancellationToken);
	const subtypes = await provider.subtypes(animalItem, cancellationToken);
	const subtypeNames = subtypes.map(item => item.name);

	expect(subtypeNames).toContain('Dog');
```
- Manual verification: launch the Extension Development Host, place the caret on a class or interface, run "Show Type Hierarchy", and confirm the new tree displays supertypes and subtypes.

## Milestones
1. Implement adapter contribution and register it during activation.
2. Create or update integration tests to cover command execution.
3. Validate manually inside the Extension Development Host.
4. Roll the change out behind existing telemetry monitoring.

## Risks & Mitigations
- **Double-fetching snapshots:** Ensure adapter relies on `ILanguageFeaturesService` to avoid divergent caches.
- **Command priority conflicts:** Verify only one provider matches the selector by checking the TypeScript extension registration; fall back gracefully if VS Code rejects duplicate registrations.
- **Performance regression:** Cap response fan-out using the provider’s existing dedupe and cancellation logic; monitor telemetry for latency spikes.

## Validation & Rollout
- Automated: Run `npm run typecheck`, `npm run lint`, `npm run tsfmt`, and targeted Vitest suites for the provider.
- Manual: Smoke-test hierarchy navigation on a multi-file TypeScript project (e.g., this repository) in the Extension Development Host.
- Post-merge: Watch the `copilot.typeHierarchy.typescript.used` telemetry bucket for command-triggered usage.

## Approvals
- Reviewers: Copilot Chat extension maintainers responsible for language features.
- Once the document is approved, proceed with implementation on `feature/type-hierarchy-tool`.
