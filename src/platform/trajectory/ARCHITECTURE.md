# Trajectory System Architecture

## Overview

The trajectory system provides structured logging and export capabilities for agent execution traces in VS Code Copilot Chat. It captures the complete interaction history including user messages, agent responses, tool calls, and observations in a format suitable for analysis, evaluation, and UI rendering.

## Design Goals

1. **Hierarchical Structure**: Properly represent agent/subagent relationships
2. **Parallel Tool Calls**: Track multiple concurrent tool invocations
3. **MCP Integration**: Include MCP server context for MCP tools
4. **Harbor ATIF Compatibility**: Follow industry standard format where possible
5. **Minimal Disruption**: Integrate with existing logging infrastructure
6. **Extensibility**: Support future enhancements via `extra` fields

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────┐
│                  Extension Layer                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │   TrajectoryExportCommands                        │  │
│  │   - VS Code command registration                 │  │
│  │   - File save dialog handling                    │  │
│  │   - Multi-trajectory export                      │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│                  Platform Layer                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │   ITrajectoryLogger (Service Interface)          │  │
│  │   - startTrajectory()                            │  │
│  │   - addUserStep() / addSystemStep()              │  │
│  │   - beginAgentStep() → IAgentStepContext         │  │
│  │   - getTrajectory() / getAllTrajectories()       │  │
│  └───────────────────────────────────────────────────┘  │
│                        │                                 │
│                        ▼                                 │
│  ┌───────────────────────────────────────────────────┐  │
│  │   TrajectoryLogger (Implementation)              │  │
│  │   - TrajectoryBuilder                            │  │
│  │   - AgentStepContext                             │  │
│  │   - Trajectory construction logic                │  │
│  └───────────────────────────────────────────────────┘  │
│                        │                                 │
│                        ▼                                 │
│  ┌───────────────────────────────────────────────────┐  │
│  │   TrajectoryLoggerAdapter                        │  │
│  │   - Bridges RequestLogger to TrajectoryLogger    │  │
│  │   - Converts logged entries to trajectory steps  │  │
│  │   - Handles CapturingToken mapping               │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│              Existing Infrastructure                     │
│  ┌───────────────────────────────────────────────────┐  │
│  │   IRequestLogger                                 │  │
│  │   - Existing chat request logging                │  │
│  │   - CapturingToken grouping                      │  │
│  │   - Tool call logging                            │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

```
User Interaction
       │
       ▼
ChatRequest (with CapturingToken)
       │
       ▼
┌──────────────────────────────┐
│   Request Logger             │
│   - logs requests            │
│   - logs tool calls          │
│   - groups by CapturingToken │
└──────────────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ TrajectoryLoggerAdapter      │
│  - monitors RequestLogger    │
│  - converts to trajectory    │
│  - tracks session mapping    │
└──────────────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│   TrajectoryLogger           │
│   - builds trajectory        │
│   - maintains hierarchy      │
│   - calculates metrics       │
└──────────────────────────────┘
       │
       ▼
   Trajectory JSON
```

## Integration Strategy

### Phase 1: Foundation (Completed)

- [x] Define trajectory types and interfaces
- [x] Implement `ITrajectoryLogger` service
- [x] Create `TrajectoryBuilder` for incremental construction
- [x] Add unit tests
- [x] Document format

### Phase 2: Integration (Completed)

- [x] Create `TrajectoryLoggerAdapter` to bridge existing logs
- [x] Register `ITrajectoryLogger` as a service
- [x] Add command contribution for export
- [x] Update `package.json` with new commands
- [x] Pass `subAgentInvocationId` and `subAgentName` through `CapturingToken`
- [x] Use `subAgentName` as agent name in subagent trajectories
- [x] Generate correct subagent filenames with UUID session IDs

### Phase 3: Enhancement (Current)

- [x] Integrate with `CapturingToken` creation points
- [x] Add trajectory tracking in `ToolCallingLoop`
- [x] Enhance subagent tool implementations (via VS Code core's runSubagentTool)
- [ ] Add MCP-specific tracking

### Phase 4: Visualization

- [ ] Create trajectory tree view provider
- [ ] Add trajectory viewer UI
- [ ] Implement trajectory replay functionality

## Key Integration Points

### 1. CapturingToken Creation

Trajectory sessions are started when a `CapturingToken` is created. For subagent requests, VS Code core provides the `subAgentInvocationId` and `subAgentName`:

```typescript
// In DefaultIntentRequestHandler
const capturingToken = new CapturingToken(
  this.request.prompt,
  'comment',
  false,
  false,
  this.request.subAgentInvocationId,  // UUID from VS Code core (for subagents)
  this.request.subAgentName,           // Description from runSubagent args
);

// Execute with capturing
const resultDetails = await this._requestLogger.captureInvocation(
  capturingToken,
  () => this.runWithToolCalling(intentInvocation)
);
```

The `TrajectoryLoggerAdapter` automatically:
- Uses `subAgentInvocationId` as session ID (if present)
- Uses `subAgentName` as agent name (if present, otherwise "Github Copilot Chat")

### 2. Tool Call Logging

The `ToolCallingLoop.logToolResult()` method already logs tool calls. The adapter listens to these events:

```typescript
// Already exists in ToolCallingLoop
this._requestLogger.logToolCall(
  toolCallId,
  toolName,
  arguments,
  result,
  thinking
);

// Adapter automatically converts to trajectory
```

### 3. Subagent Tracking

Subagent tracking is handled automatically through VS Code core's `runSubagentTool`:

1. VS Code core generates a unique `subAgentInvocationId` (UUID) for each subagent invocation
2. The `subAgentName` (from runSubagent's `description` argument) identifies the subagent type
3. Both are passed to the chat extension via `IChatAgentRequest`
4. The `CapturingToken` stores these values for trajectory correlation
5. `TrajectoryLoggerAdapter` uses `subAgentInvocationId` as the session ID and `subAgentName` as the agent name

**Data Flow:**
```
runSubagentTool (VS Code core)
    │
    ├── subAgentInvocationId: invocation.callId (UUID)
    ├── subAgentName: args.description
    └── toolMetadata: { subAgentInvocationId }
    │
    ▼
IChatAgentRequest → ChatRequest API
    │
    ▼
CapturingToken (chat extension)
    │
    ├── subAgentInvocationId  → session_id in trajectory
    └── subAgentName          → agent.name in trajectory
    │
    ▼
TrajectoryLoggerAdapter
    │
    ├── Main trajectory: adds subagent_trajectory_ref with session_id = UUID
    └── Subagent trajectory: session_id = UUID, agent.name = subAgentName
```

**Resulting File Names:**
- Main: `{user-prompt-slug}-{session-id}.trajectory.json`
- Subagent: `subagent-{description}-{subAgentInvocationId}.trajectory.json`

**Example:**
```typescript
// VS Code core (runSubagentTool.ts) - already implemented
const agentRequest: IChatAgentRequest = {
  // ...
  subAgentInvocationId: invocation.callId,  // UUID like "abc123-def456-..."
  subAgentName: args.description,            // e.g., "search_subagent"
};
toolResult.toolMetadata = { subAgentInvocationId: invocation.callId };

// Chat extension (defaultIntentRequestHandler.ts)
const capturingToken = new CapturingToken(
  this.request.prompt,
  'comment',
  false,
  false,
  this.request.subAgentInvocationId,  // Used as session ID
  this.request.subAgentName,           // Used as agent name
);

// trajectoryLoggerAdapter.ts - uses these values
const sessionId = entry.token.subAgentInvocationId ?? generateSessionId();
const agentName = entry.token.subAgentName ?? 'Github Copilot Chat';
```

### 4. MCP Tool Tracking

MCP tools should include server information in tool calls:

```typescript
// In McpToolCallingLoop
const toolCall: IToolCall = {
  tool_call_id: callId,
  function_name: toolName,
  arguments: toolArgs,
  mcp_server: this.mcpServerName
};

stepContext.addToolCalls([toolCall]);
```

## Service Registration

The trajectory logger needs to be registered as a service in the DI container:

```typescript
// In service registration
serviceCollection.set(ITrajectoryLogger, new SyncDescriptor(TrajectoryLogger));

// Adapter needs both services
const adapter = new TrajectoryLoggerAdapter(
  accessor.get(IRequestLogger),
  accessor.get(ITrajectoryLogger)
);
```

## Command Registration

Add to `package.json`:

```json
{
  "commands": [
    {
      "command": "github.copilot.chat.debug.exportTrajectories",
      "title": "Export Agent Trajectories",
      "category": "GitHub Copilot"
    }
  ],
  "menus": {
    "commandPalette": [
      {
        "command": "github.copilot.chat.debug.exportTrajectories",
        "when": "github.copilot.activated"
      }
    ]
  }
}
```

## Handling Edge Cases

### Multiple Parallel Tool Calls

When a model returns multiple tool calls in one response:

```typescript
const stepContext = trajectoryLogger.beginAgentStep(message, model);

// Add all tool calls at once
stepContext.addToolCalls(toolCalls.map(tc => ({
  tool_call_id: tc.id,
  function_name: tc.name,
  arguments: tc.arguments,
  execution_mode: 'parallel' // Mark as parallel
})));

// Add observations for each
stepContext.addObservation(observations);
stepContext.complete();
```

### Thinking/Reasoning Content

Extract from deltas or thinking data:

```typescript
let reasoningContent: string | undefined;
if (thinkingData?.text) {
  reasoningContent = Array.isArray(thinkingData.text)
    ? thinkingData.text.join('\n')
    : thinkingData.text;
}

const stepContext = trajectoryLogger.beginAgentStep(
  message,
  model,
  reasoningContent
);
```

### Session Continuation

If a session is continued after context clearing:

```typescript
// Old trajectory
const oldTrajectory = trajectoryLogger.getTrajectory();

// Start new trajectory with reference
trajectoryLogger.startTrajectory(newSessionId, agentInfo);
const newTrajectory = trajectoryLogger.getTrajectory();
if (newTrajectory) {
  newTrajectory.continued_trajectory_ref = oldTrajectory?.session_id;
}
```

## Testing Strategy

### Unit Tests

- Trajectory builder logic
- Step context operations
- Metrics calculation
- Event firing

### Integration Tests

- Adapter with request logger
- Tool call conversion
- Subagent references
- MCP tool tracking

### End-to-End Tests

- Complete agent session
- Export functionality
- Multi-trajectory scenarios
- File format validation

## Performance Considerations

1. **Lazy Evaluation**: Only build full trajectory when needed (export time)
2. **Memory Management**: Limit trajectory retention (configurable max size)
3. **Async Operations**: Make file writes non-blocking
4. **Batch Processing**: Group multiple updates before firing events

## Security Considerations

1. **PII Redaction**: Consider redacting sensitive data in exports
2. **File Permissions**: Ensure exported files have appropriate permissions
3. **Path Validation**: Validate export paths to prevent directory traversal
4. **Token Limits**: Respect configured limits for trajectory size

## Future Enhancements

### Trajectory Replay

Load a trajectory and replay it in the UI:
- Show step-by-step execution
- Highlight tool calls and results
- Display metrics and timing

### Trajectory Comparison

Compare two trajectories:
- Show differences in steps
- Compare metrics (tokens, cost, duration)
- Identify optimization opportunities

### Evaluation Integration

Use trajectories for agent evaluation:
- Export to evaluation frameworks
- Track success metrics
- A/B test different prompts/tools

### Format Conversion

Convert between trajectory formats:
- Export to Harbor ATIF
- Export to MiniSweAgent format
- Import from other formats

## References

- [Harbor ATIF Specification](https://harborframework.com/docs/trajectory-format)
- [RFC 0001: Trajectory Format](https://github.com/laude-institute/harbor/blob/main/docs/rfcs/0001-trajectory-format.md)
- VS Code Copilot Chat Architecture (`CONTRIBUTING.md`)
