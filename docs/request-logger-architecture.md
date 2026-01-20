# Request Logger Architecture

## Overview

The Request Logger system is responsible for tracking and displaying all AI-related requests, tool calls, and prompt traces made by the GitHub Copilot Chat extension. It consists of two main components in separate files:

1. **`RequestLogger`** ([src/extension/prompt/vscode-node/requestLoggerImpl.ts](../src/extension/prompt/vscode-node/requestLoggerImpl.ts)) - The main logging implementation that stores entries
2. **`RequestLogTree`** ([src/extension/log/vscode-node/requestLogTree.ts](../src/extension/log/vscode-node/requestLogTree.ts)) - The VS Code TreeView that displays the logs in the "Copilot Chat" view

The logger and TreeView are decoupled - the TreeView subscribes to `onDidChangeRequests` events and calls `getRequests()` to retrieve entries for display.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Entry Points                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  chatMLFetcher    toolCallingLoop    endpointProvider    promptRenderer     │
│       │                  │                  │                  │            │
│       ▼                  ▼                  ▼                  ▼            │
│    addEntry()      logToolCall()     logModelListCall()  addPromptTrace()   │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RequestLogger                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  _entries: LoggedInfo[]                                             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                │                                            │
│                                ▼                                            │
│                    _onDidChangeRequests.fire()                              │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          RequestLogTree                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ChatRequestProvider.getChildren()                                  │    │
│  │                                                                     │    │
│  │  Iterates through getRequests()                                     │    │
│  │  Groups by CapturingToken (AsyncLocalStorage context)               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Components

### 1. Entry Types (`LoggedInfoKind`)

| Kind | Class | Description |
|------|-------|-------------|
| `LoggedInfoKind.Request` | `LoggedRequestInfo` | Chat ML requests (success, failure, cancellation) |
| `LoggedInfoKind.ToolCall` | `LoggedToolCall` | Tool invocations and their results |
| `LoggedInfoKind.Element` | `LoggedElementInfo` | Prompt-TSX element traces |

### 2. Request Grouping with `CapturingToken`

The system uses **Node.js AsyncLocalStorage** to group related requests together:

```typescript
// In requestLogger.ts
const requestLogStorage = new AsyncLocalStorage<CapturingToken>();

// Usage - wraps an async operation to associate a token
public captureInvocation<T>(request: CapturingToken, fn: () => Promise<T>): Promise<T> {
    return requestLogStorage.run(request, () => fn());
}
```

When a request is logged, it captures the current `CapturingToken` from the async context:

```typescript
protected get currentRequest() {
    return requestLogStorage.getStore();
}
```

The `CapturingToken` includes:
- `label`: Display name for the parent tree element
- `icon`: Optional icon
- `flattenSingleChild`: Whether to flatten single-child groups
- `promoteMainEntry`: Whether to make the parent item clickable
- `parentToken`: Optional parent `CapturingToken` used to build hierarchical groupings of related requests in the tree

### 3. Entry Storage and Event Flow

```typescript
// In requestLoggerImpl.ts
private readonly _entries: LoggedInfo[] = [];

private async _addEntry(entry: LoggedInfo): Promise<boolean> {
    this._entries.push(entry);

    // Trim to max entries (configurable)
    const maxEntries = this._configService.getConfig(ConfigKey.Advanced.RequestLoggerMaxEntries);
    if (this._entries.length > maxEntries) {
        this._entries.shift();
    }

    // Notify listeners (triggers treeview refresh)
    this._onDidChangeRequests.fire();
    return true;
}
```

---

## TreeView Grouping Logic

The TreeView builds a hierarchical tree structure using the `buildHierarchicalTree()` method:

```typescript
// Simplified logic from buildHierarchicalTree()
private buildHierarchicalTree(): (ChatPromptItem | TreeChildItem)[] {
    // First pass: Create ChatPromptItems for all tokens and collect entries
    for (const currReq of this.requestLogger.getRequests()) {
        if (currReq.token) {
            // Get or create ChatPromptItem for this token
            let promptItem = tokenToPromptItem.get(currReq.token);
            if (!promptItem) {
                promptItem = ChatPromptItem.create(currReq, currReq.token, seen.has(currReq.token));
                tokenToPromptItem.set(currReq.token, promptItem);
            }
            promptItem.children.push(this.logToTreeItem(currReq));
        }
    }

    // Second pass: Build hierarchy using parentToken relationships
    for (const [token, promptItem] of tokenToPromptItem) {
        if (token.parentToken) {
            const parentPromptItem = tokenToPromptItem.get(token.parentToken);
            if (parentPromptItem) {
                parentPromptItem.children.push(promptItem); // Nest under parent
            }
        }
    }

    // Third pass: Collect root-level items (those without parents)
    // ...
}
```

### Hierarchical Grouping

Tokens with a `parentToken` are nested under their parent's `ChatPromptItem`, creating a tree structure that reflects the logical hierarchy of requests (e.g., subagent requests nested under the parent conversation).

### Grouping Edge Cases

1. **Token hierarchy** - Child tokens (created via `createChild()`) are nested under their parent token's tree item

2. **Token reuse** - If the same `CapturingToken` is used in different contexts, entries get grouped together (marked with "Continued...")

3. **No token** - Entries without a token appear as top-level items

4. **Orphan parent tokens** - If a token has a `parentToken` but that parent isn't in the entry set, the token appears at the root level

---

## Related Files

| File | Purpose |
|------|---------|
| [requestLoggerImpl.ts](../src/extension/prompt/vscode-node/requestLoggerImpl.ts) | Main logger implementation |
| [requestLogger.ts](../src/platform/requestLogger/node/requestLogger.ts) | Base class and interfaces |
| [requestLogTree.ts](../src/extension/log/vscode-node/requestLogTree.ts) | TreeView implementation |
| [capturingToken.ts](../src/platform/requestLogger/common/capturingToken.ts) | Token for grouping requests |
| [toolCallingLoop.ts](../src/extension/intents/node/toolCallingLoop.ts) | Tool call logging |

---

## Future Improvements

### Subagent Nesting in Tree View

**Goal:** Display subagent calls (e.g., `search_subagent`, `runSubagent`) nested under the parent request that invoked them, rather than as separate top-level items.

**Current State:** The infrastructure exists (`CapturingToken.createChild()`, `parentToken`, `buildHierarchicalTree()`), but subagent tools create standalone tokens that appear as siblings to the parent request.

**Attempted Approach:**
```typescript
// In searchSubagentTool.ts invoke()
const parentToken = this.requestLogger.currentToken;
const searchSubagentToken = parentToken
    ? parentToken.createChild(label, 'search')
    : new CapturingToken(label, 'search', false);
```

**Why It Didn't Work:** The `currentToken` is `undefined` when the tool's `invoke()` method runs, likely because:
1. Tool invocation happens outside the parent's `captureInvocation()` context
2. The tool calling loop may create a new async context boundary
3. The `IToolsService.invokeTool()` call chain doesn't preserve the AsyncLocalStorage context

**Potential Solutions to Investigate:**
1. **Pass token explicitly via tool context** - Add the parent token to `IBuildPromptContext` or `LanguageModelToolInvocationOptions` so tools can access it without relying on AsyncLocalStorage
2. **Wrap tool invocation in parent context** - Ensure `ToolCallingLoop.invokeToolInternal()` runs within the parent's `captureInvocation()` scope
3. **Post-hoc linking** - Associate subagent entries with parents after the fact using a correlation ID (e.g., `subAgentInvocationId`)
4. **Different grouping strategy** - Group by conversation/turn ID rather than token hierarchy
