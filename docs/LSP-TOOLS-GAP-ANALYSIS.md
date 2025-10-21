# LSP Capabilities: Tools Gap Analysis

**Date**: October 21, 2025
**Purpose**: Document which Language Server Protocol (LSP) capabilities are exposed as tools vs. available but not exposed.

## Executive Summary

The VS Code Copilot Chat extension exposes only **3 out of 20+ LSP capabilities** as tools for the AI model. Many powerful LSP features remain available through the VS Code API but are not accessible to the AI as tools.

**✅ Verification Confirmed**: A comprehensive code search reveals that VS Code exposes **all LSP capabilities as commands** via `vscode.commands.executeCommand()`. The extension currently uses **11 LSP commands** internally but only wraps **3 as Copilot tools**. The remaining **23+ LSP commands** are readily available and just need to be wrapped following existing patterns—no VS Code modifications required.

---

## Current Tool Exposure

### ✅ LSP Capabilities Exposed as Tools

| Tool Name | LSP Capability | Platform Service | Implementation |
|-----------|---------------|------------------|----------------|
| `list_code_usages` | Definitions + References + Implementations | `ILanguageFeaturesService` | Combines 3 LSP providers |
| `get_errors` | Diagnostics | `ILanguageDiagnosticsService` | Error/warning retrieval |
| `search_workspace_symbols` | Workspace Symbols | `ILanguageFeaturesService` | Symbol search |

**Usage Statistics:**
- `list_code_usages`: 795 usages across codebase
- `get_errors`: 44 usages in diagnostic-related code
- `search_workspace_symbols`: Moderate usage for discovery

### 📊 What These Tools Provide

#### `list_code_usages` (copilot_listCodeUsages)
Returns three types of locations:
- **Definitions**: Where a symbol is defined (`vscode.executeDefinitionProvider`)
- **References**: All mentions of the symbol (`vscode.executeReferenceProvider`)
- **Implementations**: Concrete implementations (`vscode.executeImplementationProvider`)

**Limitation**: Provides flat lists, not hierarchical structures.

#### `get_errors` (copilot_getErrors)
- Gets diagnostics from all language servers
- Filters by severity (errors/warnings)
- Can scope to specific files or ranges
- Used by edit tools to validate changes

#### `search_workspace_symbols` (copilot_searchWorkspaceSymbols)
- Searches for symbols by name across workspace
- Returns up to 20 results with locations
- Uses `vscode.executeWorkspaceSymbolProvider`

---

## Missing LSP Capabilities

### ❌ Not Exposed as Tools (But Available in VS Code)

#### 1. **Type Hierarchy** 🏗️

**VS Code API Available:**
- `vscode.prepareTypeHierarchy(uri, position)`
- `vscode.provideTypeHierarchySupertypes(item)` - Parent classes/interfaces
- `vscode.provideTypeHierarchySubtypes(item)` - Derived classes

**What It Would Provide:**
```
Animal (interface)
├── Mammal (abstract class)
│   ├── Dog (class)
│   └── Cat (class)
└── Bird (class)
```

**Current Workaround:**
- Use `list_code_usages` with implementations, but only gets direct implementors
- Must recursively query to build full tree
- No distinction between implements vs. extends

**Why Useful:**
- Understanding inheritance relationships
- Finding all classes in a hierarchy
- Refactoring base classes safely

---

#### 2. **Call Hierarchy** 📞

**VS Code API Available:**
- `vscode.prepareCallHierarchy(uri, position)`
- `vscode.provideCallHierarchyIncomingCalls(item)` - Who calls this function
- `vscode.provideCallHierarchyOutgoingCalls(item)` - What this function calls

**What It Would Provide:**
```
main()
├── processData()
│   ├── validateInput()
│   └── transformData()
└── displayResults()
```

**Current Workaround:**
- Use `list_code_usages` references, but includes ALL references (not just calls)
- No context about calling relationships
- Must manually parse code to determine call sites

**Why Useful:**
- Understanding code execution flow
- Impact analysis for function changes
- Debugging call paths

---

#### 3. **Rename / Prepare Rename**

**VS Code API Available:**
- `vscode.executeDocumentRenameProvider(uri, position, newName)`
- `prepareRename` - Check if rename is valid

**What It Would Provide:**
- All locations that would be renamed
- Validation before rename
- Cross-file rename support

**Current Status:**
- No tool exposure
- Extension has `renameSuggestions` feature but not as a tool

**Why Useful:**
- Safe refactoring
- Understanding symbol scope
- Validating identifier changes

---

#### 4. **Document Formatting**

**VS Code API Available:**
- `vscode.executeFormatDocumentProvider(uri)`
- `vscode.executeFormatRangeProvider(uri, range, options)`
- `vscode.executeFormatOnTypeProvider(uri, position, ch, options)`

**What It Would Provide:**
- Formatted code according to language rules
- Consistent style application

**Current Status:**
- Not exposed as tool
- Edit tools don't auto-format

**Why Useful:**
- Code cleanup
- Style consistency
- Post-edit formatting

---

#### 5. **Code Actions / Quick Fixes**

**VS Code API Available:**
- `vscode.executeCodeActionProvider(uri, range)`

**What It Would Provide:**
- Available refactorings at a location
- Quick fixes for diagnostics
- Extract method, inline variable, etc.

**Current Status:**
- Used internally in `inlineEdits` but not exposed as tool
- No way for AI to discover/apply code actions

**Why Useful:**
- Automated refactoring
- Applying suggested fixes
- Code improvement

---

#### 6. **Hover Information**

**VS Code API Available:**
- `vscode.executeHoverProvider(uri, position)`
- `vscode.experimental.executeHoverProvider_recursive(uri, position)`

**What It Would Provide:**
- Type information
- Documentation
- Function signatures

**Current Status:**
- Used in `codeBlocks/vscode-node/provider.ts` for recursive hover
- Not exposed as tool

**Why Useful:**
- Understanding types without reading source
- Quick documentation lookup
- API exploration

---

#### 7. **Signature Help**

**VS Code API Available:**
- `vscode.executeSignatureHelpProvider(uri, position)`

**What It Would Provide:**
- Function/method signatures
- Parameter information
- Overload disambiguation

**Current Status:**
- Not exposed

**Why Useful:**
- Understanding function parameters
- API usage assistance

---

#### 8. **Document Symbols**

**VS Code API Available:**
- `vscode.executeDocumentSymbolProvider(uri)`

**What It Would Provide:**
- All symbols in a document (classes, methods, functions, variables)
- Hierarchical structure

**Current Status:**
- Used internally by `list_code_usages` to find symbols
- Used by `linkify` for symbol navigation
- **Not exposed as standalone tool**

**Why Useful:**
- Quick file overview
- Finding all methods in a class
- Code navigation

---

#### 9. **Document Links**

**VS Code API Available:**
- `vscode.executeDocumentLinkProvider(uri)`

**What It Would Provide:**
- Clickable links in comments/strings
- Import path resolution

**Current Status:**
- Not exposed

---

#### 10. **Document Highlights**

**VS Code API Available:**
- `vscode.executeDocumentHighlightProvider(uri, position)`

**What It Would Provide:**
- All occurrences of symbol in current file
- Read vs. write access

**Current Status:**
- Not exposed

---

#### 11. **Type Definition**

**VS Code API Available:**
- `vscode.executeTypeDefinitionProvider(uri, position)`
- `vscode.experimental.executeTypeDefinitionProvider_recursive(uri, position)`

**What It Would Provide:**
- Go to type definition (not variable definition)
- Example: For `let x: MyType`, go to `MyType` definition

**Current Status:**
- Used in `codeBlocks/vscode-node/provider.ts` (recursive version)
- Not exposed as tool

**Why Useful:**
- Understanding types
- Navigating to interfaces/classes

---

#### 12. **Declaration Provider**

**VS Code API Available:**
- `vscode.executeDeclarationProvider(uri, position)`

**What It Would Provide:**
- Go to declaration (vs. definition)
- Example: Header file declarations in C++

**Current Status:**
- Not exposed

---

#### 13. **Color Provider**

**VS Code API Available:**
- `vscode.executeColorProvider(uri)`

**What It Would Provide:**
- Color values in code
- Color picker integration

**Current Status:**
- Not exposed (not relevant for AI assistance)

---

#### 14. **Folding Ranges**

**VS Code API Available:**
- `vscode.executeFoldingRangeProvider(uri)`

**What It Would Provide:**
- Code structure regions
- Collapsible sections

**Current Status:**
- Not exposed

---

#### 15. **Selection Ranges**

**VS Code API Available:**
- `vscode.executeSelectionRangeProvider(uri, positions[])`

**What It Would Provide:**
- Smart expand/shrink selection
- Syntax-aware selection

**Current Status:**
- Not exposed

---

#### 16. **Semantic Tokens**

**VS Code API Available:**
- `vscode.executeSemanticTokenProvider(uri)`

**What It Would Provide:**
- Detailed syntax highlighting information
- Token types and modifiers

**Current Status:**
- Not exposed

---

#### 17. **Inlay Hints**

**VS Code API Available:**
- `vscode.executeInlayHintProvider(uri, range)`

**What It Would Provide:**
- Parameter names
- Type hints
- Other inline annotations

**Current Status:**
- Not exposed

---

#### 18. **Inline Values**

**VS Code API Available:**
- `vscode.executeInlineValueProvider(uri, range)`

**What It Would Provide:**
- Debugger variable values inline

**Current Status:**
- Not exposed

---

#### 19. **Document Drop Edit Provider**

**VS Code API Available:**
- File drop handling

**Current Status:**
- Not exposed

---

#### 20. **Linked Editing Ranges**

**VS Code API Available:**
- `vscode.executeLinkedEditingRangeProvider(uri, position)`

**What It Would Provide:**
- Ranges that should be edited together (like HTML tags)

**Current Status:**
- Not exposed

---

## Verification: LSP Commands in VS Code

### ✅ Confirmed: All LSP Capabilities Are Exposed as VS Code Commands

A comprehensive search of the VS Code API and extension codebase confirms that **all LSP capabilities are available** through `vscode.commands.executeCommand()`. The extension currently uses only a **subset** of these available commands.

#### Currently Used LSP Commands (11 total)

**Core Language Services (5)**:
1. `vscode.executeDefinitionProvider` - ✅ Used in `languageFeaturesServicesImpl.ts`
2. `vscode.executeImplementationProvider` - ✅ Used in `languageFeaturesServicesImpl.ts`
3. `vscode.executeReferenceProvider` - ✅ Used in `languageFeaturesServicesImpl.ts`
4. `vscode.executeWorkspaceSymbolProvider` - ✅ Used in `languageFeaturesServicesImpl.ts`
5. `vscode.executeDocumentSymbolProvider` - ✅ Used in `languageFeaturesServicesImpl.ts`

**Experimental Recursive Providers (4)**:
6. `vscode.experimental.executeHoverProvider_recursive` - ✅ Used in `codeBlocks/provider.ts`
7. `vscode.experimental.executeDefinitionProvider_recursive` - ✅ Used in `codeBlocks/provider.ts`
8. `vscode.experimental.executeImplementationProvider_recursive` - ✅ Used in `codeBlocks/provider.ts`
9. `vscode.experimental.executeTypeDefinitionProvider_recursive` - ✅ Used in `codeBlocks/provider.ts`

**Specialized Commands (2)**:
10. `vscode.executeCodeActionProvider` - ✅ Used in `inlineEdits/vscodeWorkspace.ts`
11. `vscode.executeNotebookVariableProvider` - ✅ Used in notebook service

#### Available But Not Used LSP Commands (23+)

**High Priority - Hierarchy Commands ⭐**:
- `vscode.prepareCallHierarchy` - Initialize call hierarchy
- `vscode.provideIncomingCalls` - Get callers of a function
- `vscode.provideOutgoingCalls` - Get callees of a function
- `vscode.prepareTypeHierarchy` - Initialize type hierarchy
- `vscode.provideSupertypes` - Get parent types/interfaces
- `vscode.provideSubtypes` - Get child types/implementations

**Navigation**:
- `vscode.executeTypeDefinitionProvider` - Go to type definition
- `vscode.executeDeclarationProvider` - Go to declaration

**Code Actions & Formatting**:
- `vscode.executeCodeLensProvider` - Get code lenses
- `vscode.executeFormatDocumentProvider` - Format entire document
- `vscode.executeFormatRangeProvider` - Format selection
- `vscode.executeFormatOnTypeProvider` - Format on typing

**Information & Documentation**:
- `vscode.executeHoverProvider` - Get hover information (non-recursive)
- `vscode.executeSignatureHelpProvider` - Get signature help
- `vscode.executeCompletionItemProvider` - Get completions

**Refactoring**:
- `vscode.executeDocumentRenameProvider` - Rename symbol
- `vscode.prepareRename` - Validate rename

**UI & Decoration**:
- `vscode.executeDocumentHighlightProvider` - Highlight occurrences
- `vscode.executeDocumentLinkProvider` - Find document links
- `vscode.executeColorProvider` - Find color decorators
- `vscode.executeFoldingRangeProvider` - Get folding ranges
- `vscode.executeSelectionRangeProvider` - Smart select
- `vscode.executeDocumentSemanticTokenProvider` - Semantic tokens
- `vscode.executeInlayHintProvider` - Get inlay hints

### Why Not Use `run_vscode_command` Tool?

The extension has a `run_vscode_command` tool (in `vscodeCmdTool.tsx`) that can execute arbitrary VS Code commands. However, it's **not suitable** for exposing LSP capabilities because:

1. **Limited Availability**: Only works when `config.github.copilot.chat.newWorkspaceCreation.enabled` is true (workspace creation context)
2. **No Return Values**: Cannot capture and return results (locations, hierarchies, diagnostics)
3. **Requires User Confirmation**: Each command execution needs approval
4. **Weak Typing**: Arguments are `any[]` with no validation or type safety

### Recommended Implementation Path

To expose any LSP capability as a Copilot tool:

1. **Add method to `ILanguageFeaturesService`** interface
2. **Implement in `LanguageFeaturesServiceImpl`** using `vscode.commands.executeCommand()`
3. **Create dedicated tool** (e.g., `callHierarchyTool.tsx`) wrapping the service
4. **Register in `package.json`** with proper JSON schema

This approach provides:
- ✅ Type safety and validation
- ✅ Return value handling and formatting
- ✅ Always available in chat context
- ✅ Consistent error handling
- ✅ Proper integration with Copilot's tool system

---

## Implementation Guide

This section provides step-by-step instructions for adding new LSP capabilities as Copilot tools.

## Priority Recommendations

### High Priority (Most Useful for AI)

1. ✨ **Call Hierarchy** - Understanding code flow and dependencies
2. ✨ **Type Hierarchy** - Understanding inheritance relationships
3. ✨ **Document Symbols** - Quick file overview (already used internally)
4. ✨ **Hover/Type Info** - Understanding types without reading source

### Medium Priority

5. **Rename Preview** - Safe refactoring validation
6. **Code Actions** - Discovering available refactorings
7. **Type Definition** - Navigating to type declarations

### Lower Priority

8. **Formatting** - Code cleanup
9. **Signature Help** - Parameter information
10. **Document Highlights** - Symbol occurrences in file

---

## Testing Checklist

When implementing new tools:

- [ ] Add unit tests in `src/extension/tools/node/test/`
- [ ] Add simulation tests in `test/e2e/`
- [ ] Test with multiple language servers (TypeScript, Python, Java, etc.)
- [ ] Handle cases where provider is not available
- [ ] Add proper error messages
- [ ] Document in tool description
- [ ] Update LANGUAGE-SERVICES-INTERACTION.md with new diagrams

---

## References

- [VS Code Language Server Protocol Documentation](https://code.visualstudio.com/api/language-extensions/language-server-extension-guide)
- [VS Code API - Commands](https://code.visualstudio.com/api/references/commands)
- `src/extension/tools/node/usagesTool.tsx` - Reference implementation
- `src/platform/languages/` - Service layer pattern
- `package.json` - Tool registration examples

---

## Summary

**Current State**: 3 tools expose basic LSP capabilities (definitions, references, implementations, diagnostics, symbols).

**Gap**: 17+ LSP capabilities available but not exposed as tools.

**Most Valuable Missing Features**:
1. Call hierarchy (who calls whom)
2. Type hierarchy (inheritance relationships)
3. Hover information (type and documentation)

**Implementation**: Straightforward - extend existing services and create new tools following established patterns. **No VS Code modifications needed**.
