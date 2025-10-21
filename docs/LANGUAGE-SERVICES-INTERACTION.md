# Language Services Interaction Diagrams

This document illustrates how different components of the VS Code Copilot Chat extension interact with the language services (`ILanguageFeaturesService` and `ILanguageDiagnosticsService`) to provide AI-powered coding assistance.

## Overview

The extension uses two main language services:

1. **ILanguageFeaturesService** - Accesses VS Code's language servers for definitions, implementations, references, symbols, etc.
2. **ILanguageDiagnosticsService** - Accesses VS Code's diagnostics (errors, warnings, hints)

These services are consumed by:
- **Tools** (get_errors, usages, workspace_symbols)
- **Prompt Elements** (symbol context, definitions, references)
- **Context Resolvers** (selection helpers, fix suggestions)
- **Edit Operations** (validation after file changes)

## 1. Get Errors Tool - Diagnostic Retrieval Flow

This diagram shows how the `get_errors` tool retrieves and processes diagnostics from the workspace.

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Agent as Agent/Chat
    participant GetErrorsTool
    participant DiagSvc as ILanguageDiagnosticsService
    participant VSCode as VS Code Language Servers
    participant WorkspaceSvc as IWorkspaceService

    User->>Agent: Ask about errors
    Agent->>GetErrorsTool: invoke(filePaths?, ranges?)

    alt Get all diagnostics
        GetErrorsTool->>DiagSvc: getAllDiagnostics()
        DiagSvc->>VSCode: languages.getDiagnostics()
        VSCode-->>DiagSvc: [Uri, Diagnostic[]][]
        DiagSvc-->>GetErrorsTool: All diagnostics
        Note over GetErrorsTool: Filter by severity<br/>(Error, Warning only)
    else Get specific file diagnostics
        loop For each file path
            GetErrorsTool->>DiagSvc: getDiagnostics(uri)
            DiagSvc->>VSCode: languages.getDiagnostics(uri)
            VSCode-->>DiagSvc: Diagnostic[]
            DiagSvc-->>GetErrorsTool: File diagnostics

            opt If range specified
                Note over GetErrorsTool: Filter diagnostics<br/>by range intersection
            end
        end
    end

    loop For each diagnostic result
        GetErrorsTool->>WorkspaceSvc: openTextDocumentAndSnapshot(uri)
        WorkspaceSvc-->>GetErrorsTool: TextDocumentSnapshot
        Note over GetErrorsTool: Attach document context<br/>and language info
    end

    GetErrorsTool->>GetErrorsTool: renderPromptElementJSON<br/>(DiagnosticToolOutput)
    GetErrorsTool-->>Agent: ToolResult with formatted diagnostics
    Agent-->>User: Display errors with context
```

## 2. Usages Tool - Symbol Analysis Flow

This diagram shows how the `usages` tool finds definitions, references, and implementations of a symbol.

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Agent as Agent/Chat
    participant UsagesTool
    participant LangSvc as ILanguageFeaturesService
    participant VSCode as VS Code Language Servers

    User->>Agent: "Show usages of MyClass"
    Agent->>UsagesTool: invoke(symbolName, filePaths?)

    alt File paths provided
        loop For each file
            UsagesTool->>LangSvc: getDocumentSymbols(uri)
            LangSvc->>VSCode: executeCommand<br/>(vscode.executeDocumentSymbolProvider)
            VSCode-->>LangSvc: DocumentSymbol[]
            LangSvc-->>UsagesTool: Symbols in file
            Note over UsagesTool: Find symbol by name
        end
    else No file paths
        UsagesTool->>LangSvc: getWorkspaceSymbols(symbolName)
        LangSvc->>VSCode: executeCommand<br/>(vscode.executeWorkspaceSymbolProvider)
        VSCode-->>LangSvc: SymbolInformation[]
        LangSvc-->>UsagesTool: Matching symbols
    end

    Note over UsagesTool: Locate definition position

    par Parallel Language Server Queries
        UsagesTool->>LangSvc: getDefinitions(uri, position)
        LangSvc->>VSCode: executeCommand<br/>(vscode.executeDefinitionProvider)
        VSCode-->>LangSvc: Location[]
        LangSvc-->>UsagesTool: Definitions
    and
        UsagesTool->>LangSvc: getReferences(uri, position)
        LangSvc->>VSCode: executeCommand<br/>(vscode.executeReferenceProvider)
        VSCode-->>LangSvc: Location[]
        LangSvc-->>UsagesTool: References
    and
        UsagesTool->>LangSvc: getImplementations(uri, position)
        LangSvc->>VSCode: executeCommand<br/>(vscode.executeImplementationProvider)
        VSCode-->>LangSvc: Location[]
        LangSvc-->>UsagesTool: Implementations
    end

    UsagesTool->>UsagesTool: renderPromptElementJSON<br/>(UsagesOutput)
    UsagesTool-->>Agent: ToolResult with usages
    Agent-->>User: Display definitions, references,<br/>implementations
```

## 3. Symbol at Cursor - Context Enhancement Flow

This diagram shows how prompt elements enrich context with symbol information.

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Agent as Agent/Chat
    participant SymbolAtCursor as SymbolAtCursor<br/>Prompt Element
    participant ParserSvc as IParserService
    participant LangSvc as ILanguageFeaturesService
    participant VSCode as VS Code Language Servers

    User->>Agent: Ask question with cursor<br/>on symbol
    Agent->>SymbolAtCursor: prepare(sizing, progress)

    Note over SymbolAtCursor: Get active editor<br/>document and selection

    SymbolAtCursor->>SymbolAtCursor: selectScope()
    Note over SymbolAtCursor: Determine scope:<br/>identifier, expression,<br/>statement, or function

    SymbolAtCursor->>ParserSvc: getSymbols(document, range)
    ParserSvc-->>SymbolAtCursor: TreeSitter symbols

    Note over SymbolAtCursor: Find symbol at position

    SymbolAtCursor->>LangSvc: getDefinitions(uri, position)
    LangSvc->>VSCode: executeCommand<br/>(vscode.executeDefinitionProvider)
    VSCode-->>LangSvc: Location/LocationLink[]
    LangSvc-->>SymbolAtCursor: Definitions

    Note over SymbolAtCursor: Report progress:<br/>"Searching for relevant references..."

    loop For each definition
        SymbolAtCursor->>LangSvc: getReferences(uri, position)
        LangSvc->>VSCode: executeCommand<br/>(vscode.executeReferenceProvider)
        VSCode-->>LangSvc: Location[]
        LangSvc-->>SymbolAtCursor: References

        Note over SymbolAtCursor: Filter out self-references,<br/>deduplicate by location
    end

    SymbolAtCursor-->>Agent: State with symbol,<br/>definitions, references
    Agent->>SymbolAtCursor: render(state, sizing)
    SymbolAtCursor-->>Agent: Prompt with enriched context
    Agent-->>User: Response with symbol context
```

## 4. File Edit Validation - Diagnostic Monitoring Flow

This diagram shows how edit operations validate changes using diagnostics.

```mermaid
sequenceDiagram
    autonumber
    participant Agent
    participant EditTool as Edit Tool<br/>(replace_string,<br/>insert_edit, etc.)
    participant FileOps as File Operations
    participant DiagSvc as ILanguageDiagnosticsService
    participant VSCode as VS Code Language Servers
    participant EditResult as EditFileToolResult

    Agent->>EditTool: invoke(file edits)

    loop For each file to edit
        Note over EditTool: Store existing diagnostics
        EditTool->>DiagSvc: getDiagnostics(uri)
        DiagSvc->>VSCode: languages.getDiagnostics(uri)
        VSCode-->>DiagSvc: Diagnostic[]
        DiagSvc-->>EditTool: Existing diagnostics

        EditTool->>FileOps: applyEdit(uri, edit)
        FileOps-->>EditTool: Edit applied
    end

    Note over EditTool: Wait for language servers<br/>to update diagnostics

    EditTool->>EditResult: new EditFileToolResult(files)

    loop For each edited file
        EditResult->>DiagSvc: waitForNewDiagnostics(uri, token, 2000ms)

        DiagSvc->>DiagSvc: Listen to<br/>onDidChangeDiagnostics event

        alt Diagnostics changed
            VSCode->>DiagSvc: DiagnosticChangeEvent
            DiagSvc->>VSCode: languages.getDiagnostics(uri)
            VSCode-->>DiagSvc: Updated Diagnostic[]
            DiagSvc-->>EditResult: New diagnostics
        else Timeout (2000ms)
            DiagSvc->>VSCode: languages.getDiagnostics(uri)
            VSCode-->>DiagSvc: Current Diagnostic[]
            DiagSvc-->>EditResult: Current diagnostics
        end

        Note over EditResult: Compare with<br/>existing diagnostics<br/>Filter new errors

        opt If new errors found
            Note over EditResult: Format diagnostics<br/>for display with<br/>file context
        end
    end

    EditResult-->>Agent: ToolResult with<br/>validation status

    opt If new errors detected
        Agent->>Agent: Consider auto-fix
        Note over Agent: May trigger fix intent<br/>or ask user
    end
```

## 5. Symbol Definitions - Advanced Context Resolution

This diagram shows how complex prompts gather multiple types of symbol information.

```mermaid
sequenceDiagram
    autonumber
    participant Agent
    participant SymbolDefs as SymbolDefinitions<br/>Prompt Element
    participant ParserSvc as IParserService
    participant LangSvc as ILanguageFeaturesService
    participant VSCode as VS Code Language Servers
    participant WorkspaceSvc as IWorkspaceService

    Agent->>SymbolDefs: prepare()

    Note over SymbolDefs: Get document and selection<br/>(or active editor)

    par Parse selection for different types
        SymbolDefs->>ParserSvc: getFunctionReferences(doc, selection)
        ParserSvc-->>SymbolDefs: Function references
    and
        SymbolDefs->>ParserSvc: getClassReferences(doc, selection)
        ParserSvc-->>SymbolDefs: Class references
    and
        SymbolDefs->>ParserSvc: getTypeReferences(doc, selection)
        ParserSvc-->>SymbolDefs: Type references
    end

    rect rgb(220, 240, 255)
        Note over SymbolDefs: Find implementations for<br/>function references

        loop For each function reference
            SymbolDefs->>LangSvc: getImplementations(uri, position)
            LangSvc->>VSCode: executeCommand<br/>(vscode.executeImplementationProvider)
            VSCode-->>LangSvc: Location[]
            LangSvc-->>SymbolDefs: Implementations

            alt No implementations found
                SymbolDefs->>LangSvc: getDefinitions(uri, position)
                LangSvc->>VSCode: executeCommand<br/>(vscode.executeDefinitionProvider)
                VSCode-->>LangSvc: Location[]
                LangSvc-->>SymbolDefs: Definitions
            end
        end
    end

    rect rgb(240, 255, 220)
        Note over SymbolDefs: Find class declarations

        loop For each class reference
            SymbolDefs->>LangSvc: getImplementations(uri, position)
            LangSvc->>VSCode: executeImplementationProvider
            VSCode-->>LangSvc: Implementations
            LangSvc-->>SymbolDefs: Class implementations

            alt No implementations
                SymbolDefs->>LangSvc: getDefinitions(uri, position)
                LangSvc->>VSCode: executeDefinitionProvider
                VSCode-->>LangSvc: Definitions
                LangSvc-->>SymbolDefs: Class definitions
            end
        end
    end

    rect rgb(255, 240, 220)
        Note over SymbolDefs: Find type declarations

        loop For each type reference
            SymbolDefs->>LangSvc: getImplementations(uri, position)
            LangSvc->>VSCode: executeImplementationProvider
            VSCode-->>LangSvc: Implementations
            LangSvc-->>SymbolDefs: Type implementations

            alt No implementations
                SymbolDefs->>LangSvc: getDefinitions(uri, position)
                LangSvc->>VSCode: executeDefinitionProvider
                VSCode-->>LangSvc: Definitions
                LangSvc-->>SymbolDefs: Type definitions
            end
        end
    end

    loop For each found location
        SymbolDefs->>WorkspaceSvc: openTextDocument(uri)
        WorkspaceSvc-->>SymbolDefs: Document content
        Note over SymbolDefs: Extract code excerpts
    end

    SymbolDefs-->>Agent: State with categorized<br/>implementations
    Agent->>SymbolDefs: render(state, sizing)
    SymbolDefs-->>Agent: Formatted prompt with:<br/>- Function implementations<br/>- Class declarations<br/>- Type declarations
```

## Service Architecture

```mermaid
graph TB
    subgraph "VS Code Core"
        LSP[Language Servers<br/>TypeScript, Python, etc.]
        DiagEngine[Diagnostic Engine]
    end

    subgraph "Platform Services"
        LangFeat[ILanguageFeaturesService<br/>LanguageFeaturesServiceImpl]
        LangDiag[ILanguageDiagnosticsService<br/>LanguageDiagnosticsServiceImpl]
    end

    subgraph "Extension Features"
        Tools[Tools<br/>get_errors, usages,<br/>workspace_symbols]
        Prompts[Prompt Elements<br/>symbol_at_cursor,<br/>definitions, references]
        Context[Context Resolvers<br/>selection helpers,<br/>fix suggestions]
        Edits[Edit Operations<br/>replace_string,<br/>apply_patch]
    end

    LSP -->|Language Server APIs| LangFeat

    DiagEngine -->|Diagnostic APIs| LangDiag

    LangFeat -->|Dependency Injection| Tools
    LangFeat -->|Dependency Injection| Prompts
    LangFeat -->|Dependency Injection| Context

    LangDiag -->|Dependency Injection| Tools
    LangDiag -->|Dependency Injection| Prompts
    LangDiag -->|Dependency Injection| Context
    LangDiag -->|Dependency Injection| Edits

    style LangFeat fill:#e1f5ff
    style LangDiag fill:#ffe1f5
    style LSP fill:#f0f0f0
    style DiagEngine fill:#f0f0f0
```

## Key Patterns

### 1. Service Abstraction
- Extension code depends on `ILanguageFeaturesService` and `ILanguageDiagnosticsService` interfaces
- Implementation details are hidden behind the service layer
- Easy to swap implementations for testing (simulation, mocking)

### 2. Async Language Server Calls
- All language server queries are asynchronous
- Operations can timeout or be cancelled
- Results are processed and formatted for AI consumption

### 3. Parallel Queries
- Multiple language server queries executed in parallel when possible
- Example: Getting definitions, references, and implementations simultaneously
- Improves performance for complex context gathering

### 4. Diagnostic Monitoring
- Edit operations capture diagnostics before changes
- Wait for language servers to update after edits
- Compare new vs. old diagnostics to detect introduced errors
- Enables auto-fix workflows

### 5. Prompt Context Enhancement
- Prompt elements use language services to enrich context
- Symbol information, references, implementations added to prompts
- Helps AI understand code relationships and dependencies

## Usage Statistics

Based on code analysis, here are the primary consumers:

### ILanguageFeaturesService
- **Tools**: 3 tools (usages, workspace_symbols, search)
- **Prompt Elements**: 5 elements (symbol_at_cursor, definitions, references, explain, definition_at_position)
- **Context Resolvers**: 2 resolvers (selection helpers, scope selection)
- **Total Usages**: 37 locations

### ILanguageDiagnosticsService
- **Tools**: 5 tools (get_errors, replace_string, insert_edit, apply_patch, test tools)
- **Prompt Elements**: 3 elements (fix prompts for inline and panel)
- **Context Resolvers**: 2 resolvers (fix selection, user actions)
- **Edit Operations**: 1 result handler (edit validation)
- **Total Usages**: 44 locations

## Related Documentation

- [TECHNICAL-OVERVIEW.md](./TECHNICAL-OVERVIEW.md) - Extension architecture
- [ARCHITECTURE-DIAGRAMS.md](./ARCHITECTURE-DIAGRAMS.md) - High-level diagrams
- [tools.md](./tools.md) - Tool system documentation
