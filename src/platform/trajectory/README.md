# Agent Trajectory Format

This document describes the Agent Trajectory Format used in VS Code Copilot Chat for capturing, analyzing, and replaying agent execution traces.

## Overview

The trajectory format is inspired by the [Harbor ATIF (Agent Trajectory Interchange Format)](https://harborframework.com/docs/trajectory-format) specification, adapted for VS Code Copilot Chat's specific requirements including:

- Hierarchical agent/subagent relationships
- Parallel tool calling support
- MCP (Model Context Protocol) integration
- Token usage and cost tracking
- Proper correlation of tool calls with their results

## Schema Version

Current schema version: `ATIF-v1.5`

File extension: `.trajectory.json`

## Core Concepts

### Trajectory

A **trajectory** represents the complete execution history of an agent session, including all interactions, tool calls, and observations. Each trajectory is self-contained and can be exported, imported, and analyzed independently.

### Steps

A trajectory consists of a sequence of **steps**, each representing one interaction turn. Steps can be:

- **System steps**: System prompts or initialization messages
- **User steps**: Messages from the user
- **Agent steps**: Responses from the AI agent, including reasoning, tool calls, and observations

### Tool Calls and Observations

**Tool calls** represent actions taken by the agent (e.g., reading a file, searching code, or delegating to a subagent). Each tool call is correlated with an **observation** containing the result of that action.

### Subagent Trajectories

When an agent delegates work to a subagent (e.g., search subagent), the subagent's execution is captured in its own trajectory file. The parent trajectory contains a reference to the subagent trajectory, maintaining the hierarchical relationship.

## Trajectory Structure

### Root Object

```typescript
interface IAgentTrajectory {
  schema_version: string;           // "ATIF-v1.5"
  session_id: string;               // Unique session identifier
  agent: IAgentInfo;                // Agent configuration
  steps: ITrajectoryStep[];         // Sequential execution steps
  final_metrics?: IFinalMetrics;    // Aggregate statistics
  notes?: string;                   // Optional notes
  continued_trajectory_ref?: string; // Reference to continuation
  extra?: Record<string, unknown>;  // Custom metadata
}
```

### Agent Information

```typescript
interface IAgentInfo {
  name: string;                     // e.g., "copilot-agent"
  version: string;                  // e.g., "1.0.0"
  model_name?: string;              // Default model (e.g., "gpt-4")
  tool_definitions?: IToolDefinition[]; // Available tools
  extra?: Record<string, unknown>;  // Custom configuration
}
```

### Trajectory Step

```typescript
interface ITrajectoryStep {
  step_id: number;                  // Sequential step number (starts at 1)
  timestamp?: string;               // ISO 8601 timestamp
  source: 'system' | 'user' | 'agent'; // Step originator
  model_name?: string;              // Model used (agent steps only)
  message: string;                  // Step content
  reasoning_content?: string;       // Agent reasoning (agent steps only)
  tool_calls?: IToolCall[];         // Tools invoked (agent steps only)
  observation?: IObservation;       // Results from tools/system events
  metrics?: IStepMetrics;           // Token counts and costs
  extra?: Record<string, unknown>;  // Custom step metadata
}
```

### Tool Call

```typescript
interface IToolCall {
  tool_call_id: string;             // Unique identifier
  function_name: string;            // Tool name (e.g., "read_file")
  arguments: Record<string, unknown>; // Tool arguments
}
```

### Observation

```typescript
interface IObservation {
  results: IObservationResult[];    // Array of tool results
}

interface IObservationResult {
  source_call_id?: string;          // Corresponding tool_call_id
  content?: string;                 // Result content
  subagent_trajectory_ref?: ISubagentTrajectoryRef[]; // Subagent reference
}
```

### Subagent Reference

```typescript
interface ISubagentTrajectoryRef {
  session_id: string;               // Subagent session ID
  trajectory_path?: string;         // Path to subagent trajectory file
  extra?: Record<string, unknown>;  // Subagent metadata
}
```

### Step Metrics

```typescript
interface IStepMetrics {
  prompt_tokens?: number;           // Total input tokens
  completion_tokens?: number;       // Generated tokens
  cached_tokens?: number;           // Cached input tokens
  cost_usd?: number;                // Cost in USD
  time_to_first_token_ms?: number;  // Latency metric
  duration_ms?: number;             // Total step duration
  extra?: Record<string, unknown>;  // Provider-specific metrics
}
```

### Final Metrics

```typescript
interface IFinalMetrics {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number;
  total_cost_usd?: number;
  total_steps?: number;
  total_tool_calls?: number;
  extra?: Record<string, unknown>;
}
```

## Usage

### Exporting Trajectories

Use the VS Code command palette:

1. Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Search for "Export Agent Trajectories"
3. Choose export location

**Command ID**: `github.copilot.chat.debug.exportTrajectories`

This will export all tracked trajectories in the current session. If there are multiple trajectories (e.g., main agent + subagents), each will be exported to a separate file.

### Programmatic Access

```typescript
import { ITrajectoryLogger } from 'platform/trajectory/common/trajectoryLogger';

// Start tracking a trajectory
trajectoryLogger.startTrajectory('my-session-id', {
  name: 'my-agent',
  version: '1.0.0',
  model_name: 'gpt-4'
});

// Add a user step
trajectoryLogger.addUserStep('Hello, agent!');

// Add an agent step with tool calls
const stepContext = trajectoryLogger.beginAgentStep(
  'I will read the file for you.',
  'gpt-4'
);

stepContext.addToolCalls([{
  tool_call_id: 'call-1',
  function_name: 'read_file',
  arguments: { path: '/path/to/file.txt' }
}]);

stepContext.addObservation([{
  source_call_id: 'call-1',
  content: 'File contents here...'
}]);

stepContext.setMetrics({
  prompt_tokens: 150,
  completion_tokens: 75,
  duration_ms: 1200
});

stepContext.complete();

// Get the complete trajectory
const trajectory = trajectoryLogger.getTrajectory();
```

## Token Accounting

The trajectory format follows the Harbor ATIF token accounting model:

- **`prompt_tokens`**: Total input tokens including both cached and non-cached
- **`cached_tokens`**: Subset of `prompt_tokens` that were cache hits
- **`completion_tokens`**: Tokens generated by the model

**Cost calculation:**
```
non_cached_tokens = prompt_tokens - cached_tokens
cost = (non_cached_tokens × input_price) +
       (cached_tokens × cached_price) +
       (completion_tokens × output_price)
```

## Handling Subagents

When an agent delegates to a subagent:

1. The subagent creates its own trajectory with a unique session ID
2. The parent agent adds a tool call with the subagent's function name
3. The observation result includes a `subagent_trajectory_ref`
4. Both trajectories are exported separately but remain linked via session IDs

Example:
```json
{
  "tool_calls": [{
    "tool_call_id": "call-search-1",
    "function_name": "search_subagent",
    "arguments": { "query": "find auth code" }
  }],
  "observation": {
    "results": [{
      "source_call_id": "call-search-1",
      "subagent_trajectory_ref": [{
        "session_id": "search-subagent-123",
        "trajectory_path": "./search-subagent-123.trajectory.json"
      }]
    }]
  }
}
```

## Parallel Tool Calls

When multiple tools are called in parallel:

```json
{
  "tool_calls": [
    {
      "tool_call_id": "call-1",
      "function_name": "read_file",
      "arguments": { "path": "/file1.txt" },
      "execution_mode": "parallel"
    },
    {
      "tool_call_id": "call-2",
      "function_name": "read_file",
      "arguments": { "path": "/file2.txt" },
      "execution_mode": "parallel"
    }
  ],
  "observation": {
    "results": [
      { "source_call_id": "call-1", "content": "File 1 contents" },
      { "source_call_id": "call-2", "content": "File 2 contents" }
    ]
  }
}
```

## MCP Tool Calls

MCP (Model Context Protocol) tool calls include server context:

```json
{
  "tool_calls": [{
    "tool_call_id": "call-mcp-1",
    "function_name": "github_search",
    "arguments": { "repo": "microsoft/vscode", "query": "bug" },
    "mcp_server": "github-mcp-server"
  }]
}
```

## Example Trajectory

```json
{
  "schema_version": "ATIF-v1.5",
  "session_id": "main-agent-1234567890",
  "agent": {
    "name": "copilot-agent",
    "version": "1.0.0",
    "model_name": "gpt-4"
  },
  "steps": [
    {
      "step_id": 1,
      "timestamp": "2024-01-15T10:30:00.000Z",
      "source": "user",
      "message": "Find all authentication-related files"
    },
    {
      "step_id": 2,
      "timestamp": "2024-01-15T10:30:01.000Z",
      "source": "agent",
      "message": "I'll search for authentication files using the search subagent.",
      "model_name": "gpt-4",
      "reasoning_content": "The user wants auth files. I should use search_subagent to find them efficiently.",
      "tool_calls": [{
        "tool_call_id": "call-search-1",
        "function_name": "search_subagent",
        "arguments": {
          "query": "authentication files",
          "description": "Find auth-related code"
        }
      }],
      "observation": {
        "results": [{
          "source_call_id": "call-search-1",
          "content": "Found 3 files: auth.ts, login.ts, token.ts",
          "subagent_trajectory_ref": [{
            "session_id": "search-subagent-987654321",
            "trajectory_path": "./search-subagent-987654321.trajectory.json"
          }]
        }]
      },
      "metrics": {
        "prompt_tokens": 250,
        "completion_tokens": 120,
        "cached_tokens": 50,
        "cost_usd": 0.0025,
        "duration_ms": 1500
      }
    }
  ],
  "final_metrics": {
    "total_prompt_tokens": 250,
    "total_completion_tokens": 120,
    "total_cached_tokens": 50,
    "total_cost_usd": 0.0025,
    "total_steps": 2,
    "total_tool_calls": 1
  }
}
```

## Differences from Harbor ATIF

While inspired by Harbor ATIF, this format has some VS Code-specific adaptations:

1. **MCP Support**: Added `mcp_server` field to tool calls
2. **Parallel Execution**: Added `execution_mode` field to distinguish parallel tool calls
3. **Provider-Specific Metrics**: Uses `extra` field in metrics for provider-specific data
4. **Subagent Integration**: Tightly integrated with VS Code's CapturingToken system
5. **File Extension**: Uses `.trajectory.json` instead of generic `.json`

## Future Enhancements

Planned improvements:

- [ ] Trajectory replay in UI
- [ ] Trajectory visualization with tree view
- [ ] Trajectory comparison and diffing
- [ ] Cost analysis and optimization suggestions
- [ ] Integration with evaluation pipelines
- [ ] Export to other formats (ATIF, MiniSweAgent, etc.)

## See Also

- [Harbor ATIF Specification](https://harborframework.com/docs/trajectory-format)
- [Harbor RFC 0001](https://github.com/laude-institute/harbor/blob/main/docs/rfcs/0001-trajectory-format.md)
- VS Code Copilot Chat Request Logger (`src/platform/requestLogger/`)
- Trajectory Types (`src/platform/trajectory/common/trajectoryTypes.ts`)
