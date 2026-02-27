# Monitoring Agent Usage with OpenTelemetry

Learn how to enable and configure OpenTelemetry (OTel) for Copilot Chat to observe agent interactions, LLM calls, tool executions, and token usage.

Copilot Chat exports **traces**, **metrics**, and **events/logs** via OpenTelemetry — the vendor-neutral, industry-standard observability framework. It provides a **full span hierarchy** showing parent-child relationships across agent invocations, LLM calls, and tool executions.

---

## Key Benefits

- **Real-time debugging**: Observe agent behavior as it happens — identify bottlenecks, failures, and unexpected tool call patterns without waiting for post-run analysis.
- **Performance monitoring**: Track LLM response times (including time-to-first-token), tool execution latency, and token consumption per model.
- **Full execution traces**: See the complete parent-child span hierarchy — `invoke_agent` → `chat` → `execute_tool` — with automatic correlation.
- **Usage analytics**: Understand interaction patterns, model usage, and tool adoption across sessions.
- **Universal compatibility**: Export to any OpenTelemetry backend (Jaeger, Grafana, Azure Monitor, Datadog, Honeycomb, etc.) with no vendor lock-in.
- **Standards-first**: All signal names and attributes follow the [OTel GenAI Semantic Conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/), making data interoperable with any GenAI-aware observability tooling.

---

## Quick Start

### Option 1: Environment Variables (recommended)

Set these environment variables before launching VS Code:

```bash
# 1. Enable OTel
export COPILOT_OTEL_ENABLED=true

# 2. Set OTLP endpoint
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# 3. Optional: choose protocol (default: http)
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf   # or: grpc

# 4. Optional: capture full message content (sensitive!)
export COPILOT_OTEL_CAPTURE_CONTENT=true

# 5. Optional: auth headers for remote collector
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer your-token"

# 6. Launch VS Code
code .
```

### Option 2: VS Code Settings

Open **Settings** (`Ctrl+,`) and search for `copilot otel`:

| Setting | Type | Default | Description |
|---|---|---|---|
| `github.copilot.chat.otel.enabled` | `boolean` | `false` | Master switch for OTel emission |
| `github.copilot.chat.otel.exporterType` | `string` | `"otlp-http"` | Exporter: `otlp-http`, `otlp-grpc`, `console`, or `file` |
| `github.copilot.chat.otel.otlpEndpoint` | `string` | `"http://localhost:4318"` | OTLP collector endpoint URL |
| `github.copilot.chat.otel.captureContent` | `boolean` | `false` | Capture input/output messages, system instructions, tool definitions |
| `github.copilot.chat.otel.outfile` | `string` | `""` | File path for JSON-lines file exporter output |

> **Note:** Environment variables always take precedence over VS Code settings.

### Option 3: File-Based Output (offline / CI)

For local debugging without a collector:

```bash
export COPILOT_OTEL_ENABLED=true
export COPILOT_OTEL_FILE_EXPORTER_PATH=/tmp/copilot-otel.jsonl
code .
```

All spans, logs, and metrics are appended as JSON lines to the specified file.

---

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `COPILOT_OTEL_ENABLED` | `false` | Enable OTel instrumentation. Also enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP endpoint URL. When set, automatically enables OTel. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | Protocol: `http/protobuf`, `grpc`, or `http/json` |
| `OTEL_SERVICE_NAME` | `copilot-chat` | Service name in OTel resource attributes |
| `OTEL_RESOURCE_ATTRIBUTES` | — | Extra resource attrs as `key1=val1,key2=val2` |
| `COPILOT_OTEL_CAPTURE_CONTENT` | `false` | Capture full prompt/response content (no truncation) |
| `COPILOT_OTEL_LOG_LEVEL` | `info` | Minimum log level to bridge to OTel (`trace`, `debug`, `info`, `warn`, `error`) |
| `COPILOT_OTEL_HTTP_INSTRUMENTATION` | `false` | Enable HTTP auto-instrumentation for request-level timing |
| `COPILOT_OTEL_FILE_EXPORTER_PATH` | — | Write spans/logs/metrics to this file (overrides exporter type to `file`) |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | Auth headers for OTLP endpoint (e.g., `Authorization=Bearer token`) |

### Precedence Order

Configuration is resolved with layered precedence (highest first):

1. `COPILOT_OTEL_*` environment variables
2. `OTEL_EXPORTER_OTLP_*` standard environment variables
3. VS Code settings (`github.copilot.chat.otel.*`)
4. Defaults

Endpoint parsing rules: For gRPC, only the origin (scheme://host:port) is used. For HTTP, the full URL href is preserved.

### Activation

OTel is **off by default**. It activates when any of these conditions are met:

- `COPILOT_OTEL_ENABLED=true`
- `OTEL_EXPORTER_OTLP_ENDPOINT` is set
- `github.copilot.chat.otel.enabled` is `true` in VS Code settings

When disabled, `IOTelService` uses a no-op implementation with **zero overhead** — no OTel SDK packages are loaded, no spans are created.

### Kill Switch

OTel respects the global VS Code telemetry level. If `telemetry.telemetryLevel` is set to `off`, OTel is disabled regardless of other configuration.

---

## Traces (Spans)

Copilot Chat emits a hierarchical span tree following the OTel GenAI semantic conventions.

### Span Hierarchy

```
invoke_agent copilot                           [INTERNAL, ~15s]
  ├── chat gpt-4o                              [CLIENT, ~3s]
  │     (model requests tool calls)
  ├── execute_tool readFile                    [INTERNAL, ~50ms]
  ├── execute_tool runCommand                  [INTERNAL, ~2s]
  ├── chat gpt-4o                              [CLIENT, ~4s]
  │     (model generates final response)
  └── (span ends with final finish reason)
```

### `invoke_agent` Span (Agent Mode)

Created when the tool-calling loop starts. Wraps the entire agent orchestration.

| Attribute | Description | Example |
|---|---|---|
| `gen_ai.operation.name` | `"invoke_agent"` | `invoke_agent` |
| `gen_ai.provider.name` | LLM provider | `github` |
| `gen_ai.agent.name` | Participant ID | `copilot`, `workspace` |
| `gen_ai.conversation.id` | Chat session ID | `a1b2c3d4-...` |
| `gen_ai.request.model` | Model used | `gpt-4o` |
| `gen_ai.response.model` | Resolved model | `gpt-4o-2024-08-06` |
| `gen_ai.usage.input_tokens` | Aggregated input tokens across all turns | `12500` |
| `gen_ai.usage.output_tokens` | Aggregated output tokens across all turns | `3200` |
| `copilot_chat.turn_count` | Number of LLM round-trips | `4` |
| `gen_ai.input.messages` | User prompt (opt-in) | `[{"role":"user",...}]` |
| `gen_ai.output.messages` | Agent response (opt-in) | `[{"role":"assistant",...}]` |
| `gen_ai.tool.definitions` | Available tools (opt-in) | `[{"type":"function",...}]` |

**Span name:** `invoke_agent {gen_ai.agent.name}`
**Span kind:** `INTERNAL`

### `chat` Span (per LLM Call)

Created for each API call to the Copilot/LLM endpoint. Child of `invoke_agent` when in agent mode.

| Attribute | Description | Example |
|---|---|---|
| `gen_ai.operation.name` | `"chat"` | `chat` |
| `gen_ai.provider.name` | LLM provider | `github` |
| `gen_ai.request.model` | Requested model | `gpt-4o` |
| `gen_ai.response.model` | Resolved model from response | `gpt-4o-2024-08-06` |
| `gen_ai.response.id` | Completion ID | `chatcmpl-abc123` |
| `gen_ai.response.finish_reasons` | Finish reasons | `["stop"]` |
| `gen_ai.usage.input_tokens` | Prompt tokens | `1500` |
| `gen_ai.usage.output_tokens` | Completion tokens | `250` |
| `gen_ai.usage.cache_read.input_tokens` | Cached prompt tokens | `800` |
| `copilot_chat.time_to_first_token` | TTFT in ms | `450` |
| `copilot_chat.debug_name` | Request debug name | `agentMode` |
| `server.address` | API host | `api.github.com` |
| `server.port` | API port | `443` |
| `error.type` | Error class (on failure) | `HttpError` |
| `gen_ai.input.messages` | Full prompt (opt-in) | `[{"role":"system",...}]` |
| `gen_ai.output.messages` | Full response (opt-in) | `[{"role":"assistant",...}]` |
| `gen_ai.system_instructions` | System prompt (opt-in) | `[{"type":"text",...}]` |

**Span name:** `chat {gen_ai.request.model}`
**Span kind:** `CLIENT`

### `execute_tool` Span (per Tool Invocation)

Created for each tool call. Child of `invoke_agent` or `chat` span.

| Attribute | Description | Example |
|---|---|---|
| `gen_ai.operation.name` | `"execute_tool"` | `execute_tool` |
| `gen_ai.tool.name` | Tool name | `readFile`, `runCommand` |
| `gen_ai.tool.type` | `"function"` or `"extension"` | `function` |
| `gen_ai.tool.call.id` | Tool call ID from model | `call_abc123` |
| `gen_ai.tool.description` | Tool description | `Read file contents` |
| `gen_ai.tool.call.arguments` | Tool arguments (opt-in) | `{"path":"/src/..."}` |
| `gen_ai.tool.call.result` | Tool result (opt-in) | `"file contents..."` |
| `error.type` | Error class (on failure) | `FileNotFoundError` |

**Span name:** `execute_tool {gen_ai.tool.name}`
**Span kind:** `INTERNAL`

### Cross-Boundary Trace Propagation

When an agent invokes a subagent, trace context is automatically propagated so child spans appear under the same trace. This uses an internal trace context store keyed by request ID.

---

## Metrics

### GenAI Convention Metrics (standard)

| Metric Name | Type | Unit | Description |
|---|---|---|---|
| `gen_ai.client.operation.duration` | Histogram | `s` | Duration of each LLM API call |
| `gen_ai.client.token.usage` | Histogram | `{token}` | Token counts per call (input/output) |

**Common attributes on GenAI metrics:**

| Attribute | Description |
|---|---|
| `gen_ai.operation.name` | `chat`, `invoke_agent`, `execute_tool` |
| `gen_ai.provider.name` | `github` |
| `gen_ai.request.model` | Requested model |
| `gen_ai.response.model` | Resolved model |
| `gen_ai.token.type` | `input` or `output` (on `token.usage` only) |
| `server.address` | API host |
| `error.type` | Error class (on `operation.duration` only) |

### Extension-Specific Metrics

| Metric Name | Type | Unit | Description |
|---|---|---|---|
| `copilot_chat.tool.call.count` | Counter | `{call}` | Tool invocations by tool name and success/failure |
| `copilot_chat.tool.call.duration` | Histogram | `ms` | Tool execution latency by tool name |
| `copilot_chat.agent.invocation.duration` | Histogram | `s` | Agent mode end-to-end duration |
| `copilot_chat.agent.turn.count` | Histogram | `{turn}` | LLM round-trips per agent invocation |
| `copilot_chat.session.count` | Counter | `{session}` | Chat sessions started |
| `copilot_chat.time_to_first_token` | Histogram | `s` | Time from request sent to first SSE token |

---

## Events (Logs)

Events are emitted via the OTel logs protocol. All events carry standard resource attributes.

### GenAI Standard Event

| Event Name | When Emitted | Description |
|---|---|---|
| `gen_ai.client.inference.operation.details` | After each LLM call | Full inference details: model, tokens, finish reasons, messages (opt-in) |

### Extension-Specific Events

| Event Name | When Emitted | Key Attributes |
|---|---|---|
| `copilot_chat.session.start` | New chat session | `session.id`, model, participant |
| `copilot_chat.tool.call` | Tool invocation completes | tool name, duration_ms, success/failure |
| `copilot_chat.agent.turn` | Each agent LLM round-trip | turn index, input/output tokens, tool call count |

---

## Resource Attributes

All spans, metrics, and events carry these resource-level attributes:

| Attribute | Value | Source |
|---|---|---|
| `service.name` | `copilot-chat` | Config (overridable via `OTEL_SERVICE_NAME`) |
| `service.version` | Extension version | `package.json` |
| `session.id` | Unique per VS Code session | VS Code API |

Additional resource attributes from `OTEL_RESOURCE_ATTRIBUTES` (comma-separated key=value pairs) are merged in. Example:

```bash
export OTEL_RESOURCE_ATTRIBUTES="team.id=platform,department=engineering"
```

---

## Content Capture

By default, **no prompt content, responses, or tool arguments are captured** — only metadata (model names, token counts, durations, tool names).

To enable full content capture:

```bash
export COPILOT_OTEL_CAPTURE_CONTENT=true
```

Or in VS Code settings:

```json
{
  "github.copilot.chat.otel.captureContent": true
}
```

When enabled, the following attributes are populated on spans and events:

| Attribute | Where | Content |
|---|---|---|
| `gen_ai.input.messages` | `chat` and `invoke_agent` spans | Full prompt messages as JSON |
| `gen_ai.output.messages` | `chat` and `invoke_agent` spans | Full response messages as JSON |
| `gen_ai.system_instructions` | `chat` spans | System prompt |
| `gen_ai.tool.definitions` | `invoke_agent` spans | Tool schemas |
| `gen_ai.tool.call.arguments` | `execute_tool` spans | Tool input arguments |
| `gen_ai.tool.call.result` | `execute_tool` spans | Tool output result |

Content is captured in full — **no truncation** is applied.

> **Warning:** Content capture may include sensitive information such as code, file contents, and user prompts. Only enable in trusted environments.

---

## Local Development Setup

### Using Jaeger (traces + UI)

```bash
# Start Jaeger all-in-one with OTLP support
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  jaegertracing/jaeger:latest

# Configure Copilot Chat
export COPILOT_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Launch VS Code and use chat
code .

# View traces at http://localhost:16686
# Look for service: copilot-chat
```

### Using Console Exporter (quick debugging)

```bash
export COPILOT_OTEL_ENABLED=true
```

Then set in VS Code settings:

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "console"
}
```

Spans, metrics, and logs are printed to the extension host output channel.

### Using File Exporter

```bash
export COPILOT_OTEL_ENABLED=true
export COPILOT_OTEL_FILE_EXPORTER_PATH=./copilot-otel.jsonl
code .

# After a session, inspect the output
cat copilot-otel.jsonl | jq .
```

---

## Example Configurations

### OTLP/HTTP (default)

```bash
export COPILOT_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

### OTLP/gRPC

```bash
export COPILOT_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
```

### Remote Collector with Authentication

```bash
export COPILOT_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com:4318
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer your-token"
```

### Full Content + Custom Resource Attributes

```bash
export COPILOT_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export COPILOT_OTEL_CAPTURE_CONTENT=true
export OTEL_RESOURCE_ATTRIBUTES="team.id=platform,environment=dev"
```

---

## Security & Privacy

- **Off by default.** No OTel data is emitted unless explicitly enabled.
- **No content by default.** Prompt messages, responses, and tool arguments are only captured when `COPILOT_OTEL_CAPTURE_CONTENT=true`.
- **No PII in default attributes.** Session IDs, model names, and token counts are not personally identifiable.
- **Respects VS Code telemetry.** If the global `telemetry.telemetryLevel` is `off`, OTel is also disabled.
- **User-configured endpoints.** Data is only sent to endpoints you configure — there is no phone-home behavior.
- **Additive only.** OTel sits alongside existing telemetry (`ITelemetryService`). No existing telemetry is removed or modified.

---

## Interpreting the Data

### Trace Analysis

With a Jaeger or Grafana Tempo backend, you can:

- **Visualize the full agent execution** — See every LLM call and tool invocation as child spans of the `invoke_agent` root span.
- **Identify bottlenecks** — Sort spans by duration to find slow tool executions or LLM calls.
- **Debug failures** — Spans with `ERROR` status include `error.type` attributes and recorded exceptions.
- **Compare models** — Filter by `gen_ai.request.model` to compare latency across different models.

### Metric Analysis

- **Token usage trends** — Track `gen_ai.client.token.usage` over time, broken down by model and input/output.
- **Tool adoption** — Use `copilot_chat.tool.call.count` to understand which tools are used most and their success rates.
- **Agent performance** — `copilot_chat.agent.invocation.duration` and `copilot_chat.agent.turn.count` show how complex agent interactions are.
- **TTFT monitoring** — `copilot_chat.time_to_first_token` reveals perceived latency.

### Event Analysis

- **Session lifecycle** — `copilot_chat.session.start` tracks session creation with model and participant info.
- **Tool patterns** — `copilot_chat.tool.call` events provide per-invocation detail with timing and error info.
- **Inference details** — `gen_ai.client.inference.operation.details` provides the full LLM call record including all messages when content capture is enabled.

---

## Architecture

### Zero-Overhead Design

When OTel is disabled (the default):

- The OTel SDK is **not imported** — zero bundle impact
- `IOTelService` resolves to `NoopOTelService` with empty method bodies
- No spans, metrics, or logs are created
- No async operations or timers are started

When OTel is enabled:

- OTel SDK packages are loaded **dynamically** via `import()` at activation
- Operations are **buffered** during SDK initialization and replayed once ready (up to 1000 items)
- A `DiagnosticSpanExporter` wrapper logs the first successful export for connectivity verification
- All SDK work runs off the hot path via **batched processors** (`BatchSpanProcessor`, `BatchLogRecordProcessor`, `PeriodicExportingMetricReader`)

### Service Layer

```
IOTelService (interface)
├── NoopOTelService   — zero-cost when disabled
└── NodeOTelService   — full OTel SDK, dynamic imports
```

Consumers inject `IOTelService` via the standard DI system and never import OTel SDK types directly:

```typescript
class MyComponent {
  constructor(@IOTelService private readonly _otel: IOTelService) {}

  async doWork() {
    return this._otel.startActiveSpan('my_operation', { kind: SpanKind.INTERNAL }, async (span) => {
      span.setAttribute('key', 'value');
      // ... do work ...
      span.setStatus(SpanStatusCode.OK);
    });
  }
}
```

### Exporter Support

| Exporter | Protocol | When to Use |
|---|---|---|
| `otlp-http` (default) | HTTP/protobuf | Standard OTLP collectors (Jaeger, OTEL Collector) |
| `otlp-grpc` | gRPC | High-throughput scenarios, gRPC-native collectors |
| `console` | stdout | Quick debugging in the extension host output |
| `file` | JSON-lines | Offline analysis, CI pipelines, no network needed |

---

## Service Information

All signals are exported with these resource attributes:

| Attribute | Value |
|---|---|
| `service.name` | `copilot-chat` (configurable via `OTEL_SERVICE_NAME`) |
| `service.version` | Current Copilot Chat extension version |
| `session.id` | Unique per VS Code window session |

**Tracer/Meter/Logger name:** `copilot-chat`
