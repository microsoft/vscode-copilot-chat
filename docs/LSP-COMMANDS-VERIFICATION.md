# LSP Commands Verification Report

**Date**: October 21, 2025
**Purpose**: Document verification that VS Code exposes all LSP capabilities as commands

---

## Summary

✅ **VERIFIED**: All Language Server Protocol (LSP) capabilities are exposed as VS Code commands through `vscode.commands.executeCommand()`. The extension currently uses only a subset of these commands.

---

## Methodology

This verification was conducted through:

1. **Code Search**: Searched extension codebase for `vscode.execute*` patterns
2. **Command Enumeration**: Listed all known LSP command names from VS Code API
3. **Usage Analysis**: Identified which commands are currently used vs. available
4. **Pattern Matching**: Searched for `executeCommand` calls throughout the codebase

---

## Findings

### Currently Used LSP Commands in Extension

The extension **actively uses 11 LSP commands**:

#### Core Language Services (5 commands)
Located in `src/platform/languages/vscode/languageFeaturesServicesImpl.ts`:

```typescript
// Used in ILanguageFeaturesService implementation
1. vscode.executeDefinitionProvider
2. vscode.executeImplementationProvider
3. vscode.executeReferenceProvider
4. vscode.executeWorkspaceSymbolProvider
5. vscode.executeDocumentSymbolProvider
```

#### Experimental Recursive Providers (4 commands)
Located in `src/extension/codeBlocks/provider.ts`:

```typescript
// Used for deep code block analysis
6. vscode.experimental.executeHoverProvider_recursive
7. vscode.experimental.executeDefinitionProvider_recursive
8. vscode.experimental.executeImplementationProvider_recursive
9. vscode.experimental.executeTypeDefinitionProvider_recursive
```

#### Specialized Commands (2 commands)
```typescript
// Code actions - used in inlineEdits/vscodeWorkspace.ts
10. vscode.executeCodeActionProvider

// Notebook support - used in notebook service
11. vscode.executeNotebookVariableProvider
```

### Available But Not Used LSP Commands

**23+ additional LSP commands** are available in VS Code but not currently used by the extension:

#### High Priority - Hierarchy Commands ⭐

**Call Hierarchy (3 commands)**:
- `vscode.prepareCallHierarchy` - Initialize call hierarchy at a position
- `vscode.provideIncomingCalls` - Get functions that call this function
- `vscode.provideOutgoingCalls` - Get functions called by this function

**Type Hierarchy (3 commands)**:
- `vscode.prepareTypeHierarchy` - Initialize type hierarchy at a position
- `vscode.provideSupertypes` - Get parent classes/interfaces
- `vscode.provideSubtypes` - Get child classes/implementations

#### Navigation (2 commands)
- `vscode.executeTypeDefinitionProvider` - Go to type definition (non-recursive)
- `vscode.executeDeclarationProvider` - Go to declaration

#### Code Actions & Lens (2 commands)
- `vscode.executeCodeLensProvider` - Get code lenses
- *(Code action provider already used)*

#### Formatting (3 commands)
- `vscode.executeFormatDocumentProvider` - Format entire document
- `vscode.executeFormatRangeProvider` - Format selection
- `vscode.executeFormatOnTypeProvider` - Format on character typed

#### Information & Documentation (3 commands)
- `vscode.executeHoverProvider` - Get hover information (non-recursive version)
- `vscode.executeSignatureHelpProvider` - Get function signature help
- `vscode.executeCompletionItemProvider` - Get completion suggestions

#### Refactoring (2 commands)
- `vscode.executeDocumentRenameProvider` - Perform rename
- `vscode.prepareRename` - Validate rename possibility

#### UI & Decoration (7 commands)
- `vscode.executeDocumentHighlightProvider` - Highlight symbol occurrences
- `vscode.executeDocumentLinkProvider` - Find clickable links
- `vscode.executeColorProvider` - Find color decorators
- `vscode.executeFoldingRangeProvider` - Get code folding ranges
- `vscode.executeSelectionRangeProvider` - Smart selection expansion
- `vscode.executeDocumentSemanticTokenProvider` - Semantic highlighting
- `vscode.executeInlayHintProvider` - Get inline hints

---

## Analysis of run_vscode_command Tool

The extension includes a `run_vscode_command` tool (implemented in `src/extension/tools/node/vscodeCmdTool.tsx`) that can execute arbitrary VS Code commands. However, it is **not suitable** for exposing LSP capabilities:

### Limitations of run_vscode_command

1. **Limited Availability**
   - Condition: `when: "config.github.copilot.chat.newWorkspaceCreation.enabled"`
   - Only works during workspace creation flows
   - Not available in normal chat conversations

2. **No Return Values**
   - Can execute commands but cannot capture results
   - LSP commands return rich data structures (locations, hierarchies, diagnostics)
   - Tool can only report success/failure messages

3. **Requires User Confirmation**
   - Each command execution needs explicit approval
   - Impractical for multi-step operations

4. **Weak Typing**
   - Arguments typed as `any[]`
   - No schema validation or type safety
   - Error-prone for complex parameter structures

### Code Evidence

From `src/extension/tools/node/vscodeCmdTool.tsx`:

```typescript
export const vscodeCmdTool = declareTool({
	name: ToolName.RunVSCodeCommand,
	// ...
	when: 'config.github.copilot.chat.newWorkspaceCreation.enabled',
	// ...
	execute: async (input, stream, context) => {
		// Validates command exists
		const allCommands = await workbenchService.getAllCommands(
			/* filterByPreCondition */ true
		);

		// Executes but cannot return values
		await runCommandExecutionService.runCommand(input.commandId, input.args);

		return stream.code(`Command executed successfully: ${input.commandId}`);
	}
});
```

---

## Recommended Approach for Adding LSP Tools

Instead of using `run_vscode_command`, follow the **established pattern** used by existing LSP tools:

### Step 1: Extend ILanguageFeaturesService

Add new methods to the platform service interface:

```typescript
// src/platform/languages/languageFeatures.ts
export interface ILanguageFeaturesService {
	// Existing methods...
	getDefinitions(uri: URI, position: Position): Promise<Location[]>;

	// NEW: Add hierarchy methods
	prepareCallHierarchy(uri: URI, position: Position): Promise<CallHierarchyItem[]>;
	getCallHierarchyIncomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]>;
	getCallHierarchyOutgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]>;
}
```

### Step 2: Implement in Service Layer

Call VS Code commands from the implementation:

```typescript
// src/platform/languages/vscode/languageFeaturesServicesImpl.ts
export class LanguageFeaturesService implements ILanguageFeaturesService {
	async prepareCallHierarchy(uri: URI, position: Position): Promise<CallHierarchyItem[]> {
		return vscode.commands.executeCommand(
			'vscode.prepareCallHierarchy',
			uri,
			position
		) as Promise<CallHierarchyItem[]>;
	}
}
```

### Step 3: Create Tool Wrapper

Build a tool that uses the service:

```typescript
// src/extension/tools/node/callHierarchyTool.tsx
export const callHierarchyTool = declareTool({
	name: ToolName.GetCallHierarchy,
	description: 'Get the call hierarchy for a function',
	parameters: z.object({
		filePath: z.string(),
		line: z.number(),
		character: z.number()
	}),
	execute: async (input, stream, context) => {
		const items = await languageFeaturesService.prepareCallHierarchy(
			URI.file(input.filePath),
			new Position(input.line, input.character)
		);
		// Format and return results
		return stream.code(formatCallHierarchy(items));
	}
});
```

### Step 4: Register in package.json

Add tool schema to VS Code extension manifest:

```json
{
	"contributes": {
		"languageModelTools": [
			{
				"name": "copilot_getCallHierarchy",
				"displayName": "Get Call Hierarchy",
				"description": "Get incoming and outgoing calls for a function",
				"inputSchema": {
					"type": "object",
					"properties": {
						"filePath": { "type": "string" },
						"line": { "type": "number" },
						"character": { "type": "number" }
					}
				}
			}
		]
	}
}
```

---

## Benefits of This Approach

✅ **Type Safety**: Full TypeScript type checking and validation
✅ **Return Values**: Capture and format LSP results properly
✅ **Always Available**: Works in all chat contexts, not just workspace creation
✅ **Consistent Patterns**: Follows existing tool architecture
✅ **Error Handling**: Proper exception handling and user messages
✅ **Testable**: Can write unit tests for service and tool layers
✅ **Maintainable**: Clear separation of concerns (service → tool → registration)

---

## Conclusion

**All LSP capabilities are already available in VS Code** through the command API. The extension's limited LSP tool exposure is a **packaging issue, not a capability gap**. Adding new LSP tools requires:

1. No modifications to VS Code source code
2. No new VS Code APIs or permissions
3. Simply wrapping existing `vscode.commands.executeCommand()` calls
4. Following the established service → tool → registration pattern

The 23+ unused LSP commands represent immediate opportunities to enhance Copilot's code understanding and navigation capabilities.

---

## References

- **Main Documentation**: [LSP-TOOLS-GAP-ANALYSIS.md](./LSP-TOOLS-GAP-ANALYSIS.md)
- **Implementation Examples**:
  - `src/extension/tools/node/usagesTool.tsx` - Reference for LSP tool patterns
  - `src/platform/languages/vscode/languageFeaturesServicesImpl.ts` - Service implementation
  - `src/extension/tools/common/toolNames.ts` - Tool name registration
  - `package.json` - Tool schema registration

- **VS Code API Documentation**:
  - [VS Code Commands](https://code.visualstudio.com/api/references/commands)
  - [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
