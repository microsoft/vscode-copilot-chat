# Type Hierarchy Integration Decision

## Context
We recently landed the TypeScript-specific hierarchy infrastructure inside the Copilot Chat extension. The provider resolves compiler-backed supertypes and subtypes and is already invoked by Copilot tools. The key code paths are:
- Provider entry point in [../src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts#L32-L40](../src/platform/languages/typescript/vscode/typescriptTypeHierarchyProvider.ts#L32-L40):
  ```typescript
  const context = await this.host.getContext(uri, token);
  if (!context) {
      return [];
  }

  const declaration = this.findDeclarationAtPosition(context, position);
  if (!declaration) {
      return [];
  }
  ```
- Service routing layer in [../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L81-L87](../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L81-L87):
  ```typescript
  this.updateTypeScriptSnapshot(document);
  this.fireTypeScriptTelemetry();
  const cancellation = new vscode.CancellationTokenSource();
  ```
  ```typescript
  try {
      return await this.typeScriptHierarchyProvider.prepare(uri, position, cancellation.token);
  } finally {
      cancellation.dispose();
  }
  ```
  `LanguageFeaturesServiceImpl` finalises the cancellation token and falls back to the built-in command pathway when the selector does not match TypeScript files [../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L85-L116](../src/platform/languages/vscode/languageFeaturesServicesImpl.ts#L85-L116).
- Copilot tool integration in [../src/extension/tools/node/typeHierarchyTool.tsx#L42-L48](../src/extension/tools/node/typeHierarchyTool.tsx#L42-L48):
  ```typescript
  const hierarchyItems = await this.languageFeaturesService.prepareTypeHierarchy(uri, position);

  if (hierarchyItems.length === 0) {
      const message = l10n.t`No type hierarchy found at the specified location`;
      const toolResult = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(message)]);
      toolResult.toolResultMessage = new MarkdownString(message);
      return toolResult;
  }
  ```
  The tool subsequently expands the results into full supertype/subtype trees using the same service hooks [../src/extension/tools/node/typeHierarchyTool.tsx#L52-L64](../src/extension/tools/node/typeHierarchyTool.tsx#L52-L64).

These references show the tight coupling between the provider, the language features service, telemetry, and the Copilot tool surface.

## Options Considered
1. **Keep the provider infrastructure inside the Copilot Chat extension (current approach).**
2. **Spin the provider into a standalone VS Code extension and have Copilot consume it as a dependency.**
3. **Implement a minimal shared package but register separate providers from both Copilot Chat and a new extension.**

## Evaluation
### Shared Service Integration
- The Copilot tool already depends on `ILanguageFeaturesService` methods (`prepareTypeHierarchy`, `getTypeHierarchySupertypes`, `getTypeHierarchySubtypes`). Moving the provider elsewhere would require introducing new IPC or API bridges back into Copilot to keep the tool functional.
- `LanguageFeaturesServiceImpl` coordinates snapshot updates and one-shot telemetry (`copilot.typeHierarchy.typescript.used`). A standalone plugin would either duplicate this logic or expose new callbacks just to keep Copilot’s telemetry accurate.

### Lifecycle & Maintenance
- During activation we manage snapshots, cancellation tokens, and disposal centrally. Keeping everything in one extension makes it easier to maintain consistent lifecycle semantics when we register the upcoming VS Code provider.
- A separate extension would need its own host abstraction and would still have to reason about Copilot-specific concepts (e.g., tool invocation) to avoid regressions.

### VS Code Registration Feature
- The planned registration adapter simply forwards VS Code type hierarchy requests to `ILanguageFeaturesService`. If we split the provider into another extension, we would still have to load that extension within Copilot, handle activation timing, and reconcile duplicate registrations. Keeping the implementation unified ensures the command and agent tool use the same cache and telemetry path with zero coordination overhead.

### Telemetry & Diagnostics
- The provider uses Copilot’s telemetry service directly, and the data we gather is only meaningful inside Copilot usage analytics. Moving the provider would either fragment telemetry or require complicated cross-extension communication that negates the benefit of separation.

## Decision
**We will keep the TypeScript type hierarchy provider infrastructure inside the Copilot Chat extension** and layer the VS Code registration feature on top of the existing `ILanguageFeaturesService` implementation. This minimizes duplication, keeps telemetry accurate, and guarantees that the forthcoming UI integration and existing agent workflows share the same behavior.

## Follow-Up Actions
- Proceed with the registration work outlined in [TYPE-HIERARCHY-VSCODE-REGISTRATION-SPEC.md](./TYPE-HIERARCHY-VSCODE-REGISTRATION-SPEC.md).
- After wiring the VS Code adapter, add integration coverage to verify `vscode.prepareTypeHierarchy` resolves through the Copilot provider.
- Monitor the existing telemetry bucket to confirm command-based invocations show up once the registration ship completes.
