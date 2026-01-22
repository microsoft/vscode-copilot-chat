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

The TreeView builds a tree structure using the `buildHierarchicalTree()` method:

```typescript
// Simplified logic from buildHierarchicalTree()
private buildHierarchicalTree(): (ChatPromptItem | TreeChildItem)[] {
    // Create ChatPromptItems for all tokens and collect entries
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

    // Collect prompt items and apply flattening/promotion logic
    // ...
}
```

### Grouping Behavior

1. **Token reuse** - If the same `CapturingToken` is used in different contexts, entries get grouped together (marked with "Continued...")

2. **No token** - Entries without a token appear as top-level items

3. **Single child flattening** - When `flattenSingleChild` is true and only one entry exists, it's promoted to the top level

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

**Current State:** Subagent tools create standalone `CapturingToken` instances that appear as siblings to the parent request.

**Why It's Challenging:** Tool invocation happens outside the parent's `captureInvocation()` context, so there's no way to access the parent token via AsyncLocalStorage.

**Potential Solutions to Investigate:**
1. **Pass token explicitly via tool context** - Add the parent token to `IBuildPromptContext` or `LanguageModelToolInvocationOptions` so tools can access it without relying on AsyncLocalStorage
2. **Wrap tool invocation in parent context** - Ensure `ToolCallingLoop.invokeToolInternal()` runs within the parent's `captureInvocation()` scope
3. **Post-hoc linking** - Associate subagent entries with parents after the fact using a correlation ID (e.g., `subAgentInvocationId`)
4. **Different grouping strategy** - Group by conversation/turn ID rather than token hierarchy
