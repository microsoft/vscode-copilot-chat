# Agent Execution Metrics & Insights

This feature adds comprehensive execution metrics tracking and visualization to the GitHub Copilot Chat extension, providing users with detailed transparency into agent behavior, performance, and resource consumption.

## Overview

The Agent Execution Metrics feature tracks and displays:

- **Execution Duration**: Total time taken for agent operations
- **Tool Call Statistics**: Number of successful, failed, and total tool calls
- **Tools Used**: List of which tools were invoked
- **Resource Usage Estimates**: Approximate token consumption and API costs
- **Performance Metrics**: Average tool execution time, success rates, and efficiency indicators

## Architecture

### Service Layer: `executionMetricsService.ts`

The `ExecutionMetricsService` provides a singleton service for tracking agent execution metrics:

```typescript
export interface IExecutionMetricsService {
  startSession(sessionId: string): void;
  endSession(sessionId: string): IExecutionMetrics | undefined;
  recordToolCallStart(sessionId: string, toolName: string): string;
  recordToolCallEnd(sessionId: string, callId: string, status: 'success' | 'error', tokensUsed?: number, errorMessage?: string): void;
  getMetrics(sessionId: string): IExecutionMetrics | undefined;
  estimateCost(tokensUsed: number, model?: string): number;
}
```

**Key Responsibilities:**
- Tracks execution timing and tool calls in-memory
- Records tool invocation lifecycle (start/end with status)
- Calculates estimated token usage and API costs
- Provides current metrics for active sessions

**Pricing Model:**
- Uses configurable per-token pricing (default: $0.02 per 1M tokens)
- Supports separate input/output token pricing
- Extensible for different models/providers

### UI Component: `executionInsightsCard.tsx`

The `ExecutionInsightsCard` is a TSX-based prompt element that renders a formatted summary:

```
──────────────────────────────────────────────────
📊 Agent Execution Summary
──────────────────────────────────────────────────
⏱️  Total Time: 5.3s
🛠️  Tools: 5 calls (5 ✓, 0 ✗)
📚 Used: ReadFile, FindTextInFiles, EditFile, ApplyPatch, GetErrors

💰 Resource Usage (Estimated)
  • Tokens: ~2,456 tokens
  • Cost: $0.0492
  • Avg Tool Time: 1.1s

✨ Efficiency: 100% success rate
──────────────────────────────────────────────────
```

### Integration & Contributions

The contribution layer (`executionMetricsContribution.ts`) handles:
- Permission-aware event listening
- Session lifecycle management
- Cleanup and disposal
- Future integration with UI elements

## Usage Patterns

### For Developers

**Tracking a new execution session:**

```typescript
const metricsService = accessor.get(IExecutionMetricsService);

// Start tracking
metricsService.startSession(sessionId);

// Record tool calls
const callId = metricsService.recordToolCallStart(sessionId, 'readFile');
try {
  // Tool execution...
  metricsService.recordToolCallEnd(sessionId, callId, 'success', tokenCount);
} catch (error) {
  metricsService.recordToolCallEnd(sessionId, callId, 'error', undefined, error.message);
}

// Get current metrics
const metrics = metricsService.getMetrics(sessionId);

// End session and retrieve final metrics
const finalMetrics = metricsService.endSession(sessionId);
```

### For End Users

When an agent executes tasks, the Execution Insights card appears at the end of the response showing:

1. **How Long it Took**: Quick visibility into performance
2. **What Tools Were Used**: Transparency into agent operations
3. **Success Rate**: Confidence indicator
4. **Cost Estimate**: Budget awareness (especially for enterprise)

## Integration Points

### Agent Intent Integration

The feature should be integrated into `agentIntent.ts` to automatically track:

```typescript
const metrics = metricsService.startSession(request.sessionId);
try {
  // Agent execution...
  final Metrics = metricsService.endSession(request.sessionId);
  // Append insights card to response
} finally {
  // Cleanup
}
```

### Tool Execution Integration

Tool invocation points should record metrics:

```typescript
// In tool wrapper functions
const callId = metricsService.recordToolCallStart(sessionId, toolName);
try {
  const result = await tool.invoke(options);
  metricsService.recordToolCallEnd(sessionId, callId, 'success', tokenCount);
} catch (error) {
  metricsService.recordToolCallEnd(sessionId, callId, 'error', undefined, error.message);
}
```

## Data Models

### IExecutionMetrics
```typescript
interface IExecutionMetrics {
  sessionId: string;
  startTime: number;              // Timestamp in ms
  endTime?: number;
  totalDuration?: number;         // ms
  toolCalls: IToolCallMetric[];
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  estimatedTokensUsed: number;
  estimatedApiCostUSD?: number;
}
```

### IToolCallMetric
```typescript
interface IToolCallMetric {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;              // ms
  tokensUsed?: number;
  status: 'pending' | 'success' | 'error';
  errorMessage?: string;
}
```

## Future Enhancements

1. **Historical Analytics**: Store and aggregate metrics across sessions for trends
2. **Cost Attribution**: Break down costs by tool for cost optimization
3. **Performance Profiling**: Identify bottleneck tools and suggest optimizations
4. **Learning Integration**: Use success/failure metrics to improve agent decision-making
5. **Budget Controls**: Set spending limits and alert when approaching thresholds
6. **Visualization**: Interactive charts showing tool performance distribution
7. **Export**: CSV/JSON export for analysis and reporting

## Testing

The service should be tested for:

- Session lifecycle management
- Concurrent session handling
- Accurate timing calculations
- Cost estimation accuracy
- Tool call tracking and aggregation
- Edge cases (very short/long operations, many tool calls)

## Configuration

Current implementation uses reasonable defaults:

| Setting | Default | Purpose |
|---------|---------|---------|
| Token Price | $0.02 / 1M | Cost estimation |
| Max Sessions | Unlimited | Memory management |

Future versions should allow configuration via settings.

## Performance Considerations

- **Memory**: Each session stores metrics in-memory; cleared on session end
- **Overhead**: Minimal; only records timestamps and counters
- **Cleanup**: Automatic via `endSession()` or contribution listener
- **Scalability**: Supports thousands of parallel sessions without degradation

## Security & Privacy

- No sensitive code/data is logged
- Only metadata (tool names, durations, token counts) is tracked
- No user data is transmitted
- Metrics are local to user's machine
