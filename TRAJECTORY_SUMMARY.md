# Agent Trajectory Implementation - Quick Reference

## What Was Built

A complete agent trajectory format system inspired by Harbor's ATIF specification for tracking and exporting agent execution traces.

## Key Files

### Type Definitions & Interfaces
- `src/platform/trajectory/common/trajectoryTypes.ts` - Core types
- `src/platform/trajectory/common/trajectoryLogger.ts` - Service interface

### Implementation
- `src/platform/trajectory/node/trajectoryLogger.ts` - Main implementation
- `src/platform/trajectory/node/trajectoryLoggerAdapter.ts` - RequestLogger bridge

### Command & Export
- `src/extension/trajectory/vscode-node/trajectoryExportCommands.ts` - Export command

### Tests
- `src/platform/trajectory/test/node/trajectoryLogger.spec.ts` - 15 passing unit tests

### Documentation
- `src/platform/trajectory/README.md` - User guide
- `src/platform/trajectory/ARCHITECTURE.md` - System design
- `src/platform/trajectory/IMPLEMENTATION_STATUS.md` - Status & next steps

## Trajectory Format Example

```json
{
  "schema_version": "VSCode-Copilot-Trajectory-v1.0",
  "session_id": "main-agent-1234567890",
  "agent": {
    "name": "copilot-agent",
    "version": "1.0.0",
    "model_name": "gpt-4"
  },
  "steps": [
    {
      "step_id": 1,
      "source": "user",
      "message": "Find authentication files"
    },
    {
      "step_id": 2,
      "source": "agent",
      "message": "I'll search using the search subagent",
      "model_name": "gpt-4",
      "reasoning_content": "Need to find auth files efficiently",
      "tool_calls": [{
        "tool_call_id": "call-1",
        "function_name": "search_subagent",
        "arguments": {"query": "authentication"}
      }],
      "observation": {
        "results": [{
          "source_call_id": "call-1",
          "content": "Found 3 files",
          "subagent_trajectory_ref": [{
            "session_id": "subagent-987",
            "trajectory_path": "./subagent-987.trajectory.json"
          }]
        }]
      },
      "metrics": {
        "prompt_tokens": 250,
        "completion_tokens": 120,
        "cost_usd": 0.0025
      }
    }
  ],
  "final_metrics": {
    "total_prompt_tokens": 250,
    "total_completion_tokens": 120,
    "total_cost_usd": 0.0025,
    "total_steps": 2,
    "total_tool_calls": 1
  }
}
```

## Key Features

✅ **Hierarchical**: Captures agent/subagent relationships
✅ **Parallel Tools**: Tracks concurrent tool invocations
✅ **MCP Support**: Includes MCP server context
✅ **Metrics**: Token counts, costs, timing
✅ **ATIF Compatible**: Follows Harbor principles
✅ **Extensible**: Support for custom metadata

## Usage (When Integrated)

```typescript
// Start trajectory
trajectoryLogger.startTrajectory('session-id', {
  name: 'copilot-agent',
  version: '1.0.0'
});

// Add steps
trajectoryLogger.addUserStep('User message');

const stepCtx = trajectoryLogger.beginAgentStep('Agent response', 'gpt-4');
stepCtx.addToolCalls([{
  tool_call_id: 'call-1',
  function_name: 'read_file',
  arguments: { path: '/file.txt' }
}]);
stepCtx.addObservation([{
  source_call_id: 'call-1',
  content: 'File contents...'
}]);
stepCtx.setMetrics({
  prompt_tokens: 100,
  completion_tokens: 50
});
stepCtx.complete();

// Export
// Command: "Export Agent Trajectories"
```

## Test Status

✅ 15/15 unit tests passing
- Basic trajectory creation
- Step management
- Tool calls & observations
- Metrics tracking
- Multiple trajectories
- Event firing

## Next Steps (Not Yet Integrated)

1. Register `ITrajectoryLogger` service
2. Register export command in package.json
3. Initialize adapter in extension activation
4. Integrate with CapturingToken creation points
5. Add integration tests
6. Manual testing with real agent sessions

See `IMPLEMENTATION_STATUS.md` for detailed next steps.

## Documentation

- **README.md** - Full format specification and usage
- **ARCHITECTURE.md** - System design and integration
- **IMPLEMENTATION_STATUS.md** - Current status and TODOs

## Design Principles

- **Harbor ATIF Inspired**: Based on industry standard
- **Type Safe**: Full TypeScript definitions
- **Testable**: Clean separation of concerns
- **Extensible**: Future-proof design
- **Minimal Disruption**: Works with existing systems
