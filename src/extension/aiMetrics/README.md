# AI Metrics Dashboard

A local developer dashboard for visualizing personal GitHub Copilot usage metrics. All data is stored locally and never leaves your machine.

## Features

- **Token Usage Tracking**: Monitor total tokens consumed, tokens by model, and cache efficiency
- **Model Distribution**: See which AI models you use most frequently
- **Code Acceptance Metrics**: Track acceptance rates for NES and completions
- **Feature Usage**: Monitor chat messages, NES opportunities, and completions
- **Performance Metrics**: View average and P95 latencies (TTFT, fetch time)

## Configuration

### Enable Metrics Collection

Add to your VS Code settings:

```json
{
  "github.copilot.metrics.enabled": true,
  "github.copilot.metrics.retentionDays": 90
}
```

### Settings

- `github.copilot.metrics.enabled` (boolean, default: `false`)
  - Enable local AI metrics collection
  - Data is stored in VS Code's global state
  - No data is sent to external services

- `github.copilot.metrics.retentionDays` (number, default: `90`, min: `7`, max: `365`)
  - Number of days to retain metrics data
  - Old data is automatically pruned on extension activation
  - Default is 90 days

## Usage

1. **Enable metrics collection** in settings (see above)

2. **Use Copilot normally**:
   - Chat with Copilot
   - Accept/reject NES suggestions
   - Use code completions
   - All relevant telemetry events are captured

3. **View the dashboard**:
   - Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
   - Type: "View AI Metrics Dashboard"
   - Or run command: `github.copilot.viewMetrics`

4. **Select time range**:
   - Today
   - Last 7 Days (default)
   - Last 30 Days
   - All Time

5. **Refresh metrics**:
   - Click the "Refresh" button
   - Metrics are computed on-demand (no background processing)

## Dashboard Sections

### Overview Cards

- **Total Tokens**: Total tokens consumed with cache ratio
- **Acceptance Rate**: NES suggestion acceptance percentage
- **Top Model**: Most frequently used AI model
- **Total Events**: Number of metric events collected

### Detailed Charts

- **Tokens by Model**: Breakdown of token usage across different models
- **Tokens by Feature**: Token usage by Copilot feature (chat, NES, completions)
- **Feature Usage**: Counts for chat messages, NES opportunities, and completions
- **Performance Metrics**: Average and P95 latencies

## Data Storage

- **Location**: VS Code global state
- **Schema**: `aiMetrics.events.<YYYY-MM-DD>[]`
- **Format**: Events grouped by day for efficient storage
- **Privacy**: All data stays local, never transmitted

## Architecture

### Components

- **Domain Model** (`src/extension/aiMetrics/common/metrics.ts`)
  - Metric type definitions
  - Data structures for aggregated metrics

- **Storage Service** (`src/extension/aiMetrics/node/aiMetricsStorageService.ts`)
  - Stores events in VS Code global state
  - Provides query and aggregation methods
  - Handles data pruning

- **Telemetry Collector** (`src/extension/aiMetrics/common/aiMetricsCollector.ts`)
  - Intercepts telemetry events
  - Extracts metric-relevant data
  - Forwards to storage service

- **Dashboard Panel** (`src/extension/aiMetrics/vscode-node/aiMetricsDashboardPanel.ts`)
  - Webview-based UI
  - On-demand metric computation
  - Theme-aware styling

### Event Types

- **TokenUsage**: Tracks token consumption
- **ModelUsage**: Records model usage
- **CodeAcceptance**: Captures acceptance/rejection events
- **FeatureUsage**: Monitors feature usage
- **Performance**: Collects latency metrics

## Development

### Running Tests

```bash
npm run test:unit -- src/extension/aiMetrics/test
```

### Building

```bash
npm run compile
```

## Notes

- Metrics collection has minimal performance impact
- Dashboard only computes metrics when manually refreshed
- No background processing or scheduled tasks
- All data is local and under your control
