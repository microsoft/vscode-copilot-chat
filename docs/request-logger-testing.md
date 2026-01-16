# Request Logger Testing Initiative

## Goal

Create comprehensive tests for the `RequestLogger` so that an AI agent can exercise and identify issues with request logging functionality. This enables automated detection and fixing of bugs in the request logging system.

## Background

The `RequestLogger` is responsible for:
- Logging all LLM requests made during chat conversations
- Tracking tool calls and their arguments/responses
- Grouping related requests under parent tokens via `captureInvocation()`
- Exporting logged data for debugging and analysis

### Key Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Request Flow                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Outside captureInvocation:        Inside captureInvocation:     │
│  ┌──────────────────────┐         ┌──────────────────────────┐  │
│  │ logModelListCall()   │         │  captureInvocation(token)│  │
│  │ → token = undefined  │         │  ┌────────────────────┐  │  │
│  │ → TOP-LEVEL ENTRY    │         │  │ addEntry()         │  │  │
│  └──────────────────────┘         │  │ → token = parent   │  │  │
│                                   │  │ → GROUPED          │  │  │
│                                   │  ├────────────────────┤  │  │
│                                   │  │ logToolCall()      │  │  │
│                                   │  │ → token = parent   │  │  │
│                                   │  │ → GROUPED          │  │  │
│                                   │  └────────────────────┘  │  │
│                                   └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Core Problem: Context Loss Across Async Boundaries

### The Issue

The `RequestLogger` uses `AsyncLocalStorage` to propagate the current `CapturingToken` through the call stack. This works well **within** a single async context, but fails when:

1. **Subagents** - A child request is spawned that runs independently
2. **Background operations** - Model list fetches, auth refreshes, etc.
3. **Deferred work** - Callbacks scheduled via setTimeout, separate Promise chains

When work escapes the `captureInvocation()` context, entries appear as "orphans" at the top level instead of being grouped under their logical parent.

### Symptoms
- Two top-level entries appear instead of one grouped conversation
- Subagent requests appear disconnected from the parent that spawned them
- Background operations (model list, etc.) appear as separate top-level items

## Test Coverage

### Unit Tests

**Location:** `src/platform/requestLogger/test/node/requestLogger.spec.ts`

| Test | Description |
|------|-------------|
| `entries outside captureInvocation have no parent token` | Verifies entries added without context have `token = undefined` |
| `entries inside captureInvocation have the parent token` | Verifies entries get the parent token from context |
| `all entries inside same captureInvocation share the same parent token` | Verifies multiple entries/tool calls share one parent |
| `entries before, inside, and after captureInvocation are grouped correctly` | Tests the full grouping behavior |
| `nested captureInvocation uses innermost token` | Verifies nested contexts work correctly |
| `tool calls get parent token from captureInvocation context` | Verifies `logToolCall()` respects context |
| `logModelListCall outside captureInvocation creates top-level entry` | Documents the background operation behavior |
| **`async work scheduled outside captureInvocation loses parent context`** | **Documents the context loss problem** |
| **`demonstrates how explicit token passing could solve the orphan problem`** | **Shows the desired fix behavior** |
| `clear removes all entries` | Tests the `clear()` utility method |

**Run with:** `npm run test:unit -- src/platform/requestLogger/test/node/requestLogger.spec.ts`

## Key Files

| File | Purpose |
|------|---------|
| `src/platform/requestLogger/node/requestLogger.ts` | Interface definitions, `AbstractRequestLogger` base class |
| `src/extension/prompt/vscode-node/requestLoggerImpl.ts` | Real `RequestLogger` implementation |
| `src/platform/requestLogger/test/node/testRequestLogger.ts` | Test double that stores entries |
| `src/platform/requestLogger/common/capturingToken.ts` | `CapturingToken` class for grouping |
| `src/platform/requestLogger/node/nullRequestLogger.ts` | No-op logger used in tests by default |

## Proposed Fix: Hierarchical Token System

### Design Principles

1. **All logged entries should belong to a logical group** - no orphans at the top level for user-initiated actions
2. **Subagents should be linked to their parent** - the token hierarchy should reflect the request hierarchy
3. **Background operations should be distinguishable** - but still grouped appropriately
4. **Explicit token passing for cross-boundary work** - when AsyncLocalStorage context is lost, pass tokens explicitly

### Implementation: Add Parent Token Reference

#### 1. Update `CapturingToken` to support hierarchy

```typescript
// src/platform/requestLogger/common/capturingToken.ts
export class CapturingToken {
  constructor(
    public readonly label: string,
    public readonly icon: string | undefined,
    public readonly flattenSingleChild: boolean,
    public readonly promoteMainEntry: boolean = false,
    /**
     * Parent token for hierarchical grouping.
     * Used to link subagent/child requests to their parent.
     */
    public readonly parentToken?: CapturingToken,
  ) { }

  /**
   * Create a child token that references this as its parent.
   */
  createChild(label: string, icon?: string): CapturingToken {
    return new CapturingToken(label, icon, false, false, this);
  }
}
```

#### 2. Update `IRequestLogger` interface

```typescript
// src/platform/requestLogger/node/requestLogger.ts
export interface IRequestLogger {
  // ... existing methods ...

  /**
   * Get the current capturing token from AsyncLocalStorage.
   * Returns undefined if called outside captureInvocation.
   * Useful for passing tokens explicitly to child operations.
   */
  readonly currentToken: CapturingToken | undefined;
}
```

#### 3. Propagate tokens to subagents

When a subagent is spawned, the parent request should pass its token:

```typescript
// In the runSubagent tool implementation
const parentToken = this.requestLogger.currentToken;
const subagentToken = parentToken?.createChild(`Subagent: ${description}`, 'robot');

// Pass subagentToken to the subagent request
await runSubagentRequest({
  // ... request params ...
  inheritedToken: subagentToken,
});
```

#### 4. Update UI to render hierarchy

In `requestLogTree.ts`, use `parentToken` to build a proper tree structure instead of just grouping by token identity.

### Alternative: Background Operations Category

For operations that are truly background (not part of any user request):

```typescript
// Create a singleton "background" token for system operations
const BACKGROUND_TOKEN = new CapturingToken('Background Operations', 'sync', true);

// Use it for model list fetches, auth refreshes, etc.
await this._requestLogger.captureInvocation(BACKGROUND_TOKEN, async () => {
  this._requestLogger.logModelListCall(requestId, requestMetadata, data);
});
```

This groups all background operations together, clearly separating them from user conversations.

## Implementation Checklist

- [x] Add `parentToken?: CapturingToken` to `CapturingToken` constructor
- [x] Add `createChild()` method to `CapturingToken`
- [x] Expose `currentToken` on `IRequestLogger` interface
- [ ] Update subagent invocation to pass parent token
- [x] Update `requestLogTree.ts` to render token hierarchy
- [x] Add unit tests for hierarchical token behavior
- [ ] Update background operations to use a shared background token

## Running Tests

```bash
# Run all RequestLogger unit tests
npm run test:unit -- src/platform/requestLogger/test/node/requestLogger.spec.ts
```
