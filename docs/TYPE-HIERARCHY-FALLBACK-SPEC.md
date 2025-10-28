# TypeScript Type Hierarchy Provider Specification

**Version:** 2.0  
**Date:** October 27, 2025  
**Status:** Proposed  
**Author:** GitHub Copilot

## Executive Summary

We will restore the Copilot Chat type hierarchy tool for TypeScript and JavaScript by registering a dedicated VS Code type hierarchy provider that talks directly to the TypeScript compiler API. The provider reuses the TypeScript language service already shipped with the workspace to compute accurate supertype and subtype information, avoids heuristic parsing, and keeps the existing LSP-based behaviour for other languages.

## Problem Statement

- The extension currently delegates all type hierarchy calls to `vscode.prepareTypeHierarchy`, `vscode.provideSupertypes`, and `vscode.provideSubtypes`.
- The TypeScript language server does not implement these LSP commands, so Copilot Chat returns empty results for TypeScript/JavaScript—the primary user scenario.
- Previous proposals relied on regular-expression fallbacks that were inaccurate, difficult to maintain, and risked user trust.

## Goals

- Provide precise type hierarchy data for `.ts`, `.tsx`, `.js`, and `.jsx` files.
- Keep the existing LSP pathway for other languages without regressions.
- Minimise latency by reusing the TypeScript compiler program already loaded by the workspace.
- Surface telemetry when the TypeScript provider is used.

## Non-Goals

- Implement hierarchy heuristics for languages without compiler support.
- Ship a generic fallback for supertypes/subtypes based on textual analysis.
- Replace or fork the built-in TypeScript extension.

## Solution Overview

```
┌───────────────────────────────────────────────────────────────┐
│  Copilot Chat Type Hierarchy Request (URI, position, direction)│
└──────────────────────────┬─────────────────────────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────────┐
        │LanguageFeaturesServicesImpl.prepare/next │
        └───────────────┬──────────────────────────┘
                        │
        ┌───────────────▼───────────────┐
        │ Language Router               │
        │ - checks document language id │
        └───────────────┬───────────────┘
                        │
      ┌─────────────────▼──────────────────┐
      │TypeScriptTypeHierarchyProvider     │
      │ - TypeScript files                 │
      └─────────────────┬──────────────────┘
                        │
        ┌───────────────▼───────────────┐
        │TypeScript Service Host        │
        │ - wraps tsserverlibrary       │
        │ - shares program per project  │
        └───────────────┬───────────────┘
                        │
               ┌────────▼────────┐
               │ ts.TypeChecker  │
               │ + LS APIs       │
               └─────────────────┘
```

For non-TypeScript documents, the router continues to call the built-in LSP commands. For TypeScript/JavaScript documents, the new provider computes the hierarchy inside the extension process, using the TypeScript compiler API for supertypes and built-in implementation lookups for subtypes.

## Core Components

### 1. `TypeScriptTypeHierarchyProvider` (new)
**Location:** `src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts` (new file)  
**Responsibilities:**
- Implements the `TypeHierarchyProvider` interface (`prepare`, `supertypes`, `subtypes`).
- Knows how to resolve a TypeScript program and type checker for a document.
- Converts TypeScript symbols into `vscode.TypeHierarchyItem` objects.
- Caches computed hierarchies per symbol to avoid re-computation during a session.

### 2. `TypeScriptServiceHost` (new helper)
**Location:** `src/platform/languages/typescript/vscode/typescriptServiceHost.ts` (new file)  
**Responsibilities:**
- Wraps `typescript/lib/tsserverlibrary` to expose a `ts.LanguageService` per project.
- Mirrors the file system by delegating to VS Code text documents (synchronised text snapshots).
- Supports `synchronize(fileUri)` to ensure the language service sees latest edits.
- Offers helpers:
  - `getProgramFor(uri: vscode.Uri): ts.Program | undefined`
  - `getLanguageServiceFor(uri: vscode.Uri): ts.LanguageService | undefined`

### 3. Language Router (existing file change)
**Location:** `src/platform/languages/vscode/languageFeaturesServicesImpl.ts`  
**Changes:**
- When `document.languageId` is one of `typescript`, `typescriptreact`, `javascript`, `javascriptreact`, dispatch to the TypeScript provider.
- Otherwise, call existing LSP commands.
- Adds telemetry event `copilot.typeHierarchy.typescript.used`.

## Detailed Behaviour

### prepareTypeHierarchy (TypeScript)
1. Ensure the document is open and synchronised with `TypeScriptServiceHost`.
2. Retrieve the `ts.Program` and `ts.TypeChecker`.
3. Find the deepest node covering the offset via `ts.getTouchingPropertyName`.
4. Walk up the AST until a class, interface, type alias, enum, or mixin declaration is found.
5. Build a `TypeHierarchyItem`:
   - `uri`: document location.
   - `range`: node `getStart` / `getEnd`.
   - `selectionRange`: identifier span.
   - `detail`: fully qualified name with type parameters.
   - `kind`: map from declaration kind to `SymbolKind`.
6. Cache the symbol `ts.Symbol` ID keyed by `(file, position)` for reuse.

```typescript
async prepare(uri: vscode.Uri, position: vscode.Position): Promise<vscode.TypeHierarchyItem[]> {
	const context = await this.host.getContext(uri);
	const node = context.findDeclaration(position);
	if (!node) {
		return [];
	}

	const item = this.toHierarchyItem(context, node);
	return item ? [item] : [];
}
```

### getSupertypes (TypeScript)
1. Rehydrate the cached `ts.Symbol` for the item; if absent, resolve again from the item’s span.
2. Use `checker.getDeclaredTypeOfSymbol(symbol)` to obtain `ts.InterfaceType`.
3. Call `checker.getBaseTypes(interfaceType)` for classes/interfaces.
4. For mixins (`ts.ExpressionWithTypeArguments`), resolve via `checker.getTypeAtLocation`.
5. Convert each base type’s declaration to `TypeHierarchyItem`.
6. Support JavaScript by enabling `allowJs` and skipping declarations without heritage clauses.

### getSubtypes (TypeScript)
1. Call `languageService.getImplementationAtPosition(fileName, position)`; this covers classes extending the target and interfaces being implemented.
2. For each implementation location:
   - Synchronise file content.
   - Resolve the containing declaration node via the Type Checker.
   - Skip non-class/interface declarations.
3. Deduplicate results via `(file, node pos)`.
4. When the target is an interface, fetch classes that implement it; when the target is a class, include subclasses and mixins.

### Capability Detection

- Before registering the provider, ensure the workspace has the built-in TypeScript extension enabled (`vscode.extensions.getExtension('vscode.typescript-language-features')`).
- If the TypeScript API is unavailable, fall back to LSP (resulting in empty hierarchy, identical to today).

### Telemetry & Logging

- Log at info level when the TypeScript provider is used the first time per session.
- Emit telemetry with counts for `prepare`, `supertypes`, `subtypes`, and duration buckets.

## Implementation Plan

### Phase 1 – Infrastructure (1 day)
- Add `typescript` (tsserverlibrary) to extension dependencies if not already bundled.
- Implement `TypeScriptServiceHost` with file synchronisation and caching.
- Write thin wrappers to obtain `ts.Program` and `ts.TypeChecker`.

### Phase 2 – Provider (1 day)
- Implement `TypeScriptTypeHierarchyProvider`.
- Translate TypeScript declarations into `TypeHierarchyItem`.
- Handle mixins, enums, and type aliases gracefully (return empty for unsupported kinds).

### Phase 3 – Integration (0.5 day)
- Update `languageFeaturesServicesImpl` to route TypeScript requests.
- Add telemetry plumbing.
- Ensure disposables clean up the TypeScript host on extension shutdown.

### Phase 4 – Testing & Hardening (1 day)
- Unit tests for node selection, base type extraction, and subtype discovery.
- Integration tests using fixtures under `test/extension/typeHierarchy/`.
- Manual verification against large TS projects (`vscode`, `typescript` repo subsets).

## Testing Strategy

- **Unit Tests** (`test/unit/typescriptTypeHierarchyProvider.spec.ts`):
  - Node resolution for nested classes/interfaces.
  - Base type extraction with generics, mixins, and interfaces.
  - Subtype extraction using mocked `getImplementationAtPosition`.
- **Extension Tests** (`test/extension/typeHierarchy/typescriptTypeHierarchy.test.ts`):
  - Prepare + supertypes + subtypes across multiple files.
  - JavaScript files with JSDoc annotations.
  - React `.tsx` components.
- **Manual Checklist**:
  - `class Dog extends Animal implements Friendly`.
  - `class Foo extends mixin(Base)` (ensure mixin support is graceful).
  - Interface inheritance chain (`interface B extends A`).
  - JS prototypes via `class` syntax.
  - Large project smoke test to monitor latency (<150 ms target for prepare).

## Performance Considerations

- The TypeScript program is already maintained by the language service; reuse avoids reparsing files.
- Cache prepared `TypeHierarchyItem` objects per `(file, position)` for 30 seconds; clear caches when files change.
- Bound implementation fan-out: limit to 200 subtype entries per request and surface a “truncated” flag for telemetry.
- Respect VS Code cancellation tokens to abort long-running traversals.

## Risks & Mitigations

- **Risk:** TypeScript API shape changes.  
  **Mitigation:** Depend on the `typescript` npm version bundled with the workspace; add compile-time guards and fall back to LSP if the API is missing.
- **Risk:** Memory pressure from multiple language services.  
  **Mitigation:** Share one `LanguageService` per TS project and dispose when the workspace closes.
- **Risk:** Mixed JS/TS projects without `tsconfig`.  
  **Mitigation:** Default to an inferred project (`ts.createProjectService`) just like TS extension; warn once if root configuration is missing.

## Future Enhancements

- Upstream a proper Type Hierarchy request to `tsserver` and consume it here.
- Share the provider with Copilot agent mode via `chat-lib` once stabilised.
- Expose configuration keys (`copilot.typeHierarchy.typescript.maxSubtypes`, etc.) if needed after telemetry review.
