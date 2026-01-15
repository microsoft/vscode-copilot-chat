# Agent Trajectory Implementation Summary

## What Has Been Implemented

### 1. Core Type Definitions (`trajectoryTypes.ts`)

A complete type system inspired by Harbor's ATIF specification:

- `IAgentTrajectory` - Root trajectory object
- `IAgentInfo` - Agent configuration
- `ITrajectoryStep` - Individual execution steps (system/user/agent)
- `IToolCall` - Tool invocation structure with MCP and parallel execution support
- `IObservation` - Tool results with subagent references
- `IStepMetrics` - Token usage, cost, and timing data
- `IFinalMetrics` - Aggregate statistics
- `ISubagentTrajectoryRef` - Hierarchical subagent linking

**Key Features:**
- Schema version: `VSCode-Copilot-Trajectory-v1.0`
- File extension: `.trajectory.json`
- Supports hierarchical agent structures
- Tracks parallel tool calling
- Includes MCP server context
- Compatible with Harbor ATIF principles

### 2. Service Interface (`trajectoryLogger.ts`)

Service interface `ITrajectoryLogger` defining the contract for trajectory logging:

- `startTrajectory()` - Initialize a new trajectory session
- `addSystemStep()` / `addUserStep()` - Add simple steps
- `beginAgentStep()` - Start an agent step with context
- `IAgentStepContext` - Builder pattern for complex agent steps with tools
- `getTrajectory()` / `getAllTrajectories()` - Retrieve trajectories
- Event system for trajectory updates

### 3. Concrete Implementation (`trajectoryLogger.ts` in node/)

Full implementation of the trajectory logger:

- `TrajectoryLogger` - Main service implementation
- `TrajectoryBuilder` - Incremental trajectory construction
- `AgentStepContext` - Context for building complex agent steps
- Automatic metric aggregation (tokens, costs, tool counts)
- Support for multiple concurrent trajectories (main + subagents)
- Event firing for UI updates

### 4. Adapter Layer (`trajectoryLoggerAdapter.ts`)

Bridge between existing `RequestLogger` and new `TrajectoryLogger`:

- Monitors request logger events
- Converts logged entries to trajectory format
- Maps `CapturingToken` to trajectory sessions
- Extracts tool call information
- Processes observation results
- Handles subagent metadata

**Note:** This adapter provides automatic conversion but may need refinement based on actual usage patterns.

### 5. Integration Support (`trajectoryLoggerIntegration.ts`)

Alternative integration approach (may be deprecated in favor of adapter):

- Direct integration with request logger
- Session ID stack management
- CapturingToken to session ID mapping

### 6. Export Command (`trajectoryExportCommands.ts`)

VS Code command for exporting trajectories:

- Command: `github.copilot.chat.debug.exportTrajectories`
- Handles single trajectory export
- Handles multiple trajectory export (main + subagents)
- File save dialog integration
- Post-export actions (reveal in explorer, open file)

### 7. Comprehensive Unit Tests

15 passing unit tests covering:

- Basic trajectory creation
- Step management (system, user, agent)
- Tool calls and observations
- Subagent references
- Metrics tracking
- Final metrics aggregation
- Multiple trajectory handling
- Event firing

### 8. Documentation

Two comprehensive documentation files:

**README.md:**
- User-facing documentation
- Complete schema reference
- Usage examples
- Token accounting model
- Subagent handling
- Example trajectories

**ARCHITECTURE.md:**
- System architecture
- Component diagrams
- Data flow
- Integration strategy
- Edge case handling
- Testing strategy

## What Still Needs to Be Done

### 1. Service Registration

**Priority: HIGH**

Register `ITrajectoryLogger` service in the dependency injection container:

```typescript
// In service registration (e.g., extension activation)
serviceCollection.set(ITrajectoryLogger, new SyncDescriptor(TrajectoryLogger));
```

**Files to modify:**
- Look for service registration patterns in existing code
- Likely in extension activation or service initialization

### 2. Contribution Registration

**Priority: HIGH**

Register the export command contribution:

```typescript
// Register TrajectoryExportCommands contribution
instantiationService.createInstance(TrajectoryExportCommands);
```

**Files to modify:**
- Extension contribution registration
- Command registration system

### 3. Update package.json

**Priority: HIGH**

Add command definition:

```json
{
  "contributes": {
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
}
```

### 4. Integrate with CapturingToken Creation

**Priority: MEDIUM**

Start trajectory tracking when `CapturingToken` is created:

**Files to modify:**
- `src/extension/prompt/node/defaultIntentRequestHandler.ts`
- `src/extension/tools/node/searchSubagentTool.ts`
- Any other files creating `CapturingToken`

**Changes needed:**
```typescript
// When creating a CapturingToken for agent execution
const token = new CapturingToken(label, icon, false);

// Start trajectory
if (trajectoryLogger.hasActiveTrajectory() || shouldStartNewTrajectory) {
  const sessionId = generateSessionId(label);
  trajectoryLogger.startTrajectory(sessionId, {
    name: agentName,
    version: extensionVersion,
    model_name: model
  });
}
```

### 5. Enhance ToolCallingLoop Integration

**Priority: MEDIUM**

Extend `ToolCallingLoop` to populate trajectory data:

**Files to modify:**
- `src/extension/intents/node/toolCallingLoop.ts`

**Changes needed:**
- Add trajectory step context at the start of each iteration
- Populate tool calls with execution mode (parallel/sequential)
- Add observations with results
- Set metrics from response

### 6. Subagent Trajectory Tracking

**Priority: MEDIUM**

Ensure subagent tools properly register their trajectories:

**Files to modify:**
- `src/extension/tools/node/searchSubagentTool.ts`
- `src/extension/prompt/node/searchSubagentToolCallingLoop.ts`

**Changes needed:**
- Create trajectory for subagent
- Register subagent trajectory with parent
- Include session ID in tool metadata

### 7. MCP Tool Integration

**Priority: LOW**

Add MCP server context to MCP tool calls:

**Files to modify:**
- `src/extension/mcp/vscode-node/mcpToolCallingLoop.tsx`

**Changes needed:**
- Include MCP server name in tool call
- Track MCP-specific metadata

### 8. Adapter Initialization

**Priority: HIGH**

Initialize the `TrajectoryLoggerAdapter` to start automatic conversion:

**Files to modify:**
- Extension activation
- Service initialization

**Changes needed:**
```typescript
// After services are registered
const adapter = instantiationService.createInstance(TrajectoryLoggerAdapter);
// Adapter automatically starts monitoring RequestLogger
```

### 9. Integration Testing

**Priority: MEDIUM**

Create integration tests:

- Test adapter with actual request logger
- Test export command with real trajectories
- Test subagent trajectory linking
- Test parallel tool call tracking

### 10. End-to-End Testing

**Priority: LOW**

Test complete scenarios:

- Simple agent interaction → export → verify JSON
- Agent with tool calls → export → verify structure
- Agent with subagent → export → verify both files
- Parallel tool calls → export → verify execution mode

### 11. UI Enhancements (Future)

**Priority: LOW** (Post-MVP)

- Trajectory tree view in debug view
- Trajectory visualization
- Trajectory replay functionality
- Cost analysis view

## Recommended Implementation Order

1. **Service & Command Registration** (HIGH priority, quick)
   - Register `ITrajectoryLogger` service
   - Register `TrajectoryExportCommands` contribution
   - Update `package.json`

2. **Adapter Initialization** (HIGH priority, quick)
   - Initialize `TrajectoryLoggerAdapter` in extension activation
   - Test with existing request logs

3. **Basic Testing** (HIGH priority, medium)
   - Manual test: start agent, make some tool calls, export trajectory
   - Verify JSON structure matches schema

4. **CapturingToken Integration** (MEDIUM priority, medium)
   - Add trajectory start in `DefaultIntentRequestHandler`
   - Test with main agent execution

5. **Subagent Integration** (MEDIUM priority, medium)
   - Update `SearchSubagentTool` to track trajectories
   - Test subagent trajectory export

6. **Refinements** (LOW priority, ongoing)
   - Add MCP tracking
   - Improve parallel tool call detection
   - Add more metrics

## Testing Strategy

### Manual Testing Steps

1. **Basic Export:**
   ```
   - Start VS Code with extension
   - Open a workspace
   - Trigger an agent interaction
   - Run "Export Agent Trajectories" command
   - Verify exported JSON file
   ```

2. **Tool Call Tracking:**
   ```
   - Trigger agent with tool calls (e.g., file reading)
   - Export trajectory
   - Verify tool_calls and observation fields
   ```

3. **Subagent Tracking:**
   ```
   - Trigger agent that uses search subagent
   - Export trajectories
   - Verify both main and subagent files
   - Verify subagent_trajectory_ref linking
   ```

4. **Metrics Verification:**
   ```
   - Export trajectory after agent interaction
   - Verify step metrics (tokens, cost, duration)
   - Verify final_metrics aggregation
   ```

### Automated Testing

- Unit tests: Already complete (15 tests passing)
- Integration tests: To be added
- E2E tests: To be added

## Known Limitations & Trade-offs

1. **Adapter Approach:** The current adapter monitors existing request logs and converts them. This means:
   - Some information may be lost in translation
   - Timing may not be perfectly accurate
   - Better integration would involve direct trajectory API calls

2. **Subagent Tracking:** Currently relies on tool metadata. A more robust approach would:
   - Have subagent tools directly register trajectories
   - Use a parent-child session relationship

3. **Parallel Tool Detection:** Currently relies on metadata. Better detection would:
   - Analyze tool call timestamps
   - Use execution context information

4. **MCP Tracking:** Minimal support currently. Full support would:
   - Track MCP server lifecycle
   - Include MCP protocol messages
   - Track tool definitions from MCP servers

## Migration Path from Debug Logs

The new trajectory format is designed to eventually replace or complement the existing debug log export:

- **Short term:** Both systems coexist
- **Medium term:** Trajectory becomes primary export format
- **Long term:** Debug logs deprecated in favor of structured trajectories

Users currently relying on `exportAllPromptLogsAsJsonCommand` can:
- Continue using it (no breaking changes)
- Gradually migrate to trajectory export
- Use both for comparison during transition

## Conclusion

The trajectory system provides a solid foundation for structured agent logging and analysis. The core implementation is complete and tested. The remaining work focuses on integration with existing systems and refinement based on real-world usage.

**Next immediate steps:**
1. Register services and commands
2. Initialize adapter
3. Manual testing
4. Iterate based on feedback
