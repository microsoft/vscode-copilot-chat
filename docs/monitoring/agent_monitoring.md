# Monitoring Agent Usage with OpenTelemetry

Copilot Chat can export **traces**, **metrics**, and **events** via [OpenTelemetry](https://opentelemetry.io/) (OTel) — giving you real-time visibility into agent interactions, LLM calls, tool executions, and token usage.

All signal names and attributes follow the [OTel GenAI Semantic Conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/), so the data works with any OTel-compatible backend: Jaeger, Grafana, Azure Monitor, Datadog, Honeycomb, and more.

## Quick Start

Set these environment variables before launching VS Code:

```bash
# Enable OTel and point to a local collector
export COPILOT_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Launch VS Code
code .
```

That's it. Traces, metrics, and events start flowing to your collector.

> **Tip:** To get started quickly with a local trace viewer, run [Jaeger](https://www.jaegertracing.io/) in Docker:
> ```bash
> docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest
> ```
> Then open http://localhost:16686 and look for service `copilot-chat`.

---

## Configuration

### VS Code Settings

Open **Settings** (`Ctrl+,`) and search for `copilot otel`:

| Setting | Type | Default | Description |
|---|---|---|---|
| `github.copilot.chat.otel.enabled` | boolean | `false` | Enable OTel emission |
| `github.copilot.chat.otel.exporterType` | string | `"otlp-http"` | `otlp-http`, `otlp-grpc`, `console`, or `file` |
| `github.copilot.chat.otel.otlpEndpoint` | string | `"http://localhost:4318"` | OTLP collector endpoint |
| `github.copilot.chat.otel.captureContent` | boolean | `false` | Capture full prompt/response content |
| `github.copilot.chat.otel.outfile` | string | `""` | File path for JSON-lines output |

### Environment Variables

Environment variables **always take precedence** over VS Code settings.

| Variable | Default | Description |
|---|---|---|
| `COPILOT_OTEL_ENABLED` | `false` | Enable OTel. Also enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. |
| `COPILOT_OTEL_ENDPOINT` | — | OTLP endpoint URL (takes precedence over `OTEL_EXPORTER_OTLP_ENDPOINT`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | Standard OTel OTLP endpoint URL |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | `http/protobuf`, `grpc`, or `http/json` |
| `COPILOT_OTEL_PROTOCOL` | — | Override OTLP protocol (`grpc` or `http`). Falls back to `OTEL_EXPORTER_OTLP_PROTOCOL`. |
| `OTEL_SERVICE_NAME` | `copilot-chat` | Service name in resource attributes |
| `OTEL_RESOURCE_ATTRIBUTES` | — | Extra resource attributes (`key1=val1,key2=val2`) |
| `COPILOT_OTEL_CAPTURE_CONTENT` | `false` | Capture full prompt/response content |
| `COPILOT_OTEL_LOG_LEVEL` | `info` | Min log level: `trace`, `debug`, `info`, `warn`, `error` |
| `COPILOT_OTEL_FILE_EXPORTER_PATH` | — | Write all signals to this file (JSON-lines) |
| `COPILOT_OTEL_HTTP_INSTRUMENTATION` | `false` | Enable HTTP-level OTel instrumentation |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | Auth headers (e.g., `Authorization=Bearer token`) |

### Activation

OTel is **off by default** with zero overhead. It activates when:

- `COPILOT_OTEL_ENABLED=true`, or
- `OTEL_EXPORTER_OTLP_ENDPOINT` is set, or
- `github.copilot.chat.otel.enabled` is `true`

If `telemetry.telemetryLevel` is `off`, OTel is disabled regardless of other settings.

---

## What Gets Exported

### Traces

Copilot Chat emits a hierarchical span tree for each agent interaction:

```
invoke_agent copilot                           [~15s]
  ├── chat gpt-4o                              [~3s]  (LLM requests tool calls)
  ├── execute_tool readFile                    [~50ms]
  ├── execute_tool runCommand                  [~2s]
  ├── chat gpt-4o                              [~4s]  (LLM generates final response)
  └── (span ends)
```

**`invoke_agent`** — wraps the entire agent orchestration (all LLM calls + tool executions).

| Attribute | Requirement | Example |
|---|---|---|
| `gen_ai.operation.name` | Required | `invoke_agent` |
| `gen_ai.provider.name` | Required | `github` |
| `gen_ai.agent.name` | Required | `copilot` |
| `gen_ai.conversation.id` | Required | `a1b2c3d4-...` |
| `gen_ai.request.model` | Recommended | `gpt-4o` |
| `gen_ai.response.model` | Recommended | `gpt-4o-2024-08-06` |
| `gen_ai.usage.input_tokens` | Recommended | `12500` |
| `gen_ai.usage.output_tokens` | Recommended | `3200` |
| `copilot_chat.turn_count` | Always | `4` |
| `error.type` | On error | `Error` |
| `gen_ai.input.messages` | Opt-in (captureContent) | `[{"role":"user",...}]` |
| `gen_ai.output.messages` | Opt-in (captureContent) | `[{"role":"assistant",...}]` |
| `gen_ai.tool.definitions` | Opt-in (captureContent) | `[{"type":"function",...}]` |

**`chat`** — one span per LLM API call (span kind: `CLIENT`).

| Attribute | Requirement | Example |
|---|---|---|
| `gen_ai.operation.name` | Required | `chat` |
| `gen_ai.provider.name` | Required | `github` |
| `gen_ai.request.model` | Required | `gpt-4o` |
| `gen_ai.conversation.id` | Required | `a1b2c3d4-...` |
| `gen_ai.request.max_tokens` | Always | `2048` |
| `gen_ai.request.temperature` | When set | `0.1` |
| `gen_ai.request.top_p` | When set | `0.95` |
| `copilot_chat.request.max_prompt_tokens` | Always | `128000` |
| `gen_ai.response.id` | On response | `chatcmpl-abc123` |
| `gen_ai.response.model` | On response | `gpt-4o-2024-08-06` |
| `gen_ai.response.finish_reasons` | On response | `["stop"]` |
| `gen_ai.usage.input_tokens` | On response | `1500` |
| `gen_ai.usage.output_tokens` | On response | `250` |
| `copilot_chat.time_to_first_token` | On response | `450` |
| `server.address` | When available | `api.github.com` |
| `copilot_chat.debug_name` | When available | `agentMode` |
| `error.type` | On error | `TimeoutError` |
| `gen_ai.input.messages` | Opt-in (captureContent) | `[{"role":"system",...}]` |
| `gen_ai.system_instructions` | Opt-in (captureContent) | `[{"type":"text",...}]` |

**`execute_tool`** — one span per tool invocation (span kind: `INTERNAL`).

| Attribute | Requirement | Example |
|---|---|---|
| `gen_ai.operation.name` | Required | `execute_tool` |
| `gen_ai.tool.name` | Required | `readFile` |
| `gen_ai.tool.type` | Required | `function` or `extension` (MCP tools) |
| `gen_ai.tool.call.id` | Recommended | `call_abc123` |
| `gen_ai.tool.description` | When available | `Read the contents of a file` |
| `error.type` | On error | `FileNotFoundError` |
| `gen_ai.tool.call.arguments` | Opt-in (captureContent) | `{"filePath":"/src/index.ts"}` |
| `gen_ai.tool.call.result` | Opt-in (captureContent) | `(file contents or summary)` |

### Metrics

#### GenAI Convention Metrics

| Metric | Type | Unit | Description |
|---|---|---|---|
| `gen_ai.client.operation.duration` | Histogram | s | LLM API call duration |
| `gen_ai.client.token.usage` | Histogram | tokens | Token counts (input/output) |

**`gen_ai.client.operation.duration` attributes:**

| Attribute | Description |
|---|---|
| `gen_ai.operation.name` | Operation type (e.g., `chat`) |
| `gen_ai.provider.name` | Provider (e.g., `github`, `anthropic`) |
| `gen_ai.request.model` | Requested model |
| `gen_ai.response.model` | Resolved model (if different) |
| `server.address` | Server hostname |
| `server.port` | Server port |
| `error.type` | Error class (if failed) |

**`gen_ai.client.token.usage` attributes:**

| Attribute | Description |
|---|---|
| `gen_ai.operation.name` | Operation type |
| `gen_ai.provider.name` | Provider name |
| `gen_ai.token.type` | `input` or `output` |
| `gen_ai.request.model` | Requested model |
| `gen_ai.response.model` | Resolved model |
| `server.address` | Server hostname |

#### Extension-Specific Metrics

| Metric | Type | Unit | Description |
|---|---|---|---|
| `copilot_chat.tool.call.count` | Counter | calls | Tool invocations by name and success |
| `copilot_chat.tool.call.duration` | Histogram | ms | Tool execution latency |
| `copilot_chat.agent.invocation.duration` | Histogram | s | Agent mode end-to-end duration |
| `copilot_chat.agent.turn.count` | Histogram | turns | LLM round-trips per agent invocation |
| `copilot_chat.session.count` | Counter | sessions | Chat sessions started |
| `copilot_chat.time_to_first_token` | Histogram | s | Time to first SSE token |

**`copilot_chat.tool.call.count` attributes:** `gen_ai.tool.name`, `success` (boolean)

**`copilot_chat.tool.call.duration` attributes:** `gen_ai.tool.name`

**`copilot_chat.agent.invocation.duration` attributes:** `gen_ai.agent.name`

**`copilot_chat.agent.turn.count` attributes:** `gen_ai.agent.name`

**`copilot_chat.time_to_first_token` attributes:** `gen_ai.request.model`

### Events

#### `gen_ai.client.inference.operation.details`

Emitted after each LLM API call with full inference metadata.

| Attribute | Description |
|---|---|
| `gen_ai.operation.name` | Always `chat` |
| `gen_ai.request.model` | Requested model |
| `gen_ai.response.model` | Resolved model |
| `gen_ai.response.id` | Response ID |
| `gen_ai.response.finish_reasons` | Stop reasons (e.g., `["stop"]`) |
| `gen_ai.usage.input_tokens` | Input token count |
| `gen_ai.usage.output_tokens` | Output token count |
| `gen_ai.request.temperature` | Temperature (if set) |
| `gen_ai.request.max_tokens` | Max tokens (if set) |
| `error.type` | Error class (if failed) |
| `gen_ai.input.messages` | Full prompt messages (captureContent only) |
| `gen_ai.system_instructions` | System prompt (captureContent only) |
| `gen_ai.tool.definitions` | Tool schemas (captureContent only) |

#### `copilot_chat.session.start`

Emitted when a new chat session begins.

| Attribute | Description |
|---|---|
| `session.id` | Session identifier |
| `gen_ai.request.model` | Initial model |
| `gen_ai.agent.name` | Chat participant name |

#### `copilot_chat.tool.call`

Emitted when a tool invocation completes.

| Attribute | Description |
|---|---|
| `gen_ai.tool.name` | Tool name |
| `duration_ms` | Execution time in milliseconds |
| `success` | `true` or `false` |
| `error.type` | Error class (if failed) |

#### `copilot_chat.agent.turn`

Emitted for each agent LLM round-trip.

| Attribute | Description |
|---|---|
| `turn.index` | Turn number (0-indexed) |
| `gen_ai.usage.input_tokens` | Input tokens this turn |
| `gen_ai.usage.output_tokens` | Output tokens this turn |
| `tool_call_count` | Number of tool calls this turn |

### Resource Attributes

All signals carry:

| Attribute | Value |
|---|---|
| `service.name` | `copilot-chat` (configurable via `OTEL_SERVICE_NAME`) |
| `service.version` | Extension version |
| `session.id` | Unique per VS Code window |

Add custom resource attributes with `OTEL_RESOURCE_ATTRIBUTES`:

```bash
export OTEL_RESOURCE_ATTRIBUTES="team.id=platform,department=engineering"
```

These custom attributes are included in all traces, metrics, and events, allowing you to:

- Filter metrics by team or department
- Create team-specific dashboards and alerts
- Track usage across organizational boundaries

> **Note:** `OTEL_RESOURCE_ATTRIBUTES` uses comma-separated `key=value` pairs. Values cannot contain spaces, commas, or semicolons. Use percent-encoding for special characters (e.g., `org.name=John%27s%20Org`).

---

## Content Capture

By default, **no prompt content, responses, or tool arguments are captured** — only metadata like model names, token counts, and durations.

To capture full content:

```bash
export COPILOT_OTEL_CAPTURE_CONTENT=true
```

This populates these span attributes:

| Attribute | Content |
|---|---|
| `gen_ai.input.messages` | Full prompt messages (JSON) |
| `gen_ai.output.messages` | Full response messages (JSON) |
| `gen_ai.system_instructions` | System prompt |
| `gen_ai.tool.definitions` | Tool schemas |
| `gen_ai.tool.call.arguments` | Tool input arguments |
| `gen_ai.tool.call.result` | Tool output |

Content is captured in full with no truncation.

> **Warning:** Content capture may include sensitive information such as code, file contents, and user prompts. Only enable in trusted environments.

---

## Example Configurations

**OTLP/gRPC:**

```bash
export COPILOT_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
```

**Remote collector with authentication:**

```bash
export COPILOT_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com:4318
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer your-token"
```

**File-based output (offline / CI):**

```bash
export COPILOT_OTEL_ENABLED=true
export COPILOT_OTEL_FILE_EXPORTER_PATH=/tmp/copilot-otel.jsonl
```

**Console output (quick debugging):**

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "console"
}
```

---

## Subagent Trace Propagation

When an agent invokes a subagent (e.g., via the `runSubagent` tool), Copilot Chat automatically propagates the trace context so the subagent's `invoke_agent` span is parented to the calling agent's `execute_tool` span. This produces a connected trace tree:

```
invoke_agent copilot                           [~30s]
  ├── chat gpt-4o                              [~3s]
  ├── execute_tool runSubagent                 [~20s]
  │   └── invoke_agent Explore                 [~18s]   ← child via trace context
  │       ├── chat gpt-4o                      [~2s]
  │       ├── execute_tool searchFiles         [~200ms]
  │       ├── execute_tool readFile            [~50ms]
  │       └── chat gpt-4o                      [~3s]
  ├── chat gpt-4o                              [~4s]
  └── (span ends)
```

This propagation works across async boundaries — the parent's trace context is stored when `runSubagent` starts and retrieved when the subagent begins its `invoke_agent` span.

---

## Interpreting the Data

**Traces** — Visualize the full agent execution in Jaeger or Grafana Tempo. Each `invoke_agent` span contains child `chat` and `execute_tool` spans, making it easy to identify bottlenecks and debug failures. Subagent invocations appear as nested `invoke_agent` spans under `execute_tool runSubagent`.

**Metrics** — Track token usage trends by model and provider, monitor tool success rates via `copilot_chat.tool.call.count`, and watch perceived latency with `copilot_chat.time_to_first_token`. All metrics carry the same resource attributes (`service.name`, `service.version`, `session.id`) for consistent filtering.

**Events** — `copilot_chat.session.start` tracks session creation. `copilot_chat.tool.call` events provide per-invocation timing and error details. `gen_ai.client.inference.operation.details` gives the full LLM call record including token usage and, when content capture is enabled, the complete prompt/response messages. Use `gen_ai.conversation.id` to correlate all signals belonging to the same session.

---

## Initialization & Buffering

The OTel SDK is loaded asynchronously via dynamic imports to avoid blocking extension startup. Events emitted before initialization completes are buffered (up to 1,000 items) and replayed once the SDK is ready. If initialization fails, buffered events are discarded and all subsequent calls become no-ops — the extension continues to function normally.

First successful span export is logged to the console (`[OTel] First span batch exported successfully via ...`) to confirm end-to-end connectivity.

---

## Backend Setup & Verification

Copilot Chat's OTel data works with any OTLP-compatible backend. This section covers setup and verification for recommended backends.

### OTel Collector + Azure Application Insights

[Azure Application Insights](https://learn.microsoft.com/en-us/azure/azure-monitor/app/app-insights-overview) ingests OTel traces, metrics, and logs through an [OTel Collector](https://opentelemetry.io/docs/collector/) with the `azuremonitor` exporter. This repo includes a ready-to-use collector setup in `docs/monitoring/`.

**1. Start the collector:**

```bash
# Set your App Insights connection string (from Azure Portal → App Insights → Overview)
export APPLICATIONINSIGHTS_CONNECTION_STRING="InstrumentationKey=...;IngestionEndpoint=..."

# Start the OTel Collector
cd docs/monitoring
docker compose up -d
```

**2. Verify the collector is healthy:**

```bash
# Should return 200
curl -s -o /dev/null -w "%{http_code}" http://localhost:4328/v1/traces \
  -X POST -H "Content-Type: application/json" -d '{"resourceSpans":[]}'
```

**3. Launch VS Code:**

```bash
COPILOT_OTEL_ENABLED=true \
COPILOT_OTEL_CAPTURE_CONTENT=true \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4328 \
code .
```

**4. Generate telemetry** — Send a chat message in Copilot Chat (e.g., "explain this file" in agent mode).

**5. Verify in App Insights:**

- **Traces:** Application Insights → Transaction search → filter by "Trace" or "Request".

- **Logs:** Application Insights → Logs:
  ```kql
  traces
  | where timestamp > ago(1h)
  | where message contains "GenAI" or message contains "copilot_chat"
  | project timestamp, message, customDimensions
  | order by timestamp desc
  ```

- **Metrics:** Application Insights → Metrics → "Custom" namespace, or via Logs:
  ```kql
  customMetrics
  | where timestamp > ago(1h)
  | where name startswith "gen_ai" or name startswith "copilot_chat"
  | summarize avg(value), count() by name
  ```

> **Note:** Traces typically appear within 1-2 minutes. Metrics may take 5-10 minutes.

**Collector config** (`docs/monitoring/otel-collector-config.yaml`):

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
      grpc:
        endpoint: 0.0.0.0:4317

exporters:
  azuremonitor:
    connection_string: "${APPLICATIONINSIGHTS_CONNECTION_STRING}"
  debug:
    verbosity: basic

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [azuremonitor, debug]
    metrics:
      receivers: [otlp]
      exporters: [azuremonitor, debug]
```

> **Note:** The docker-compose maps ports to `4328`/`4327` on the host to avoid conflicts. Adjust in `docker-compose.yaml` if needed. Add additional exporters (e.g., `otlphttp/jaeger`) to fan out to multiple backends.

**Troubleshooting:**

```bash
docker logs monitoring-otel-collector-1 --tail 30
# "Everything is ready" = started successfully
# "error" lines = check connection string or network
```

### Langfuse

[Langfuse](https://langfuse.com/) is an open-source LLM observability platform with native OTLP ingestion and support for [OTel GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/). See the [Langfuse docs](https://langfuse.com/docs/opentelemetry/introduction) for full details on capabilities and limitations.

**Setup:**

```bash
export COPILOT_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/api/public/otel
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(echo -n '<public-key>:<secret-key>' | base64)"
export COPILOT_OTEL_CAPTURE_CONTENT=true
```

Replace `<public-key>` and `<secret-key>` with your Langfuse API keys from **Settings → API Keys**.

**Verify:** Open Langfuse → **Traces**. You should see `invoke_agent` traces with nested `chat` and `execute_tool` spans.

> **Note:** Langfuse requires `http/protobuf` (the default) — gRPC is not supported.

### Other Backends

Any OTLP-compatible backend works with Copilot Chat's OTel output. Some options:

| Backend | Description |
|---|---|
| **[Jaeger](https://www.jaegertracing.io/)** | Open-source distributed tracing platform |
| **[Grafana Tempo](https://grafana.com/oss/tempo/) + [Prometheus](https://prometheus.io/)** | Open-source traces + metrics stack |
| **[Datadog](https://www.datadoghq.com/)** | Cloud observability platform with OTLP ingest |
| **[Honeycomb](https://www.honeycomb.io/)** | Observability platform for high-cardinality data |
| **[Elastic](https://www.elastic.co/observability)** | Search-powered observability |

Refer to each backend's documentation for OTLP ingestion setup.

---

## Security & Privacy

- **Off by default.** No OTel data is emitted unless explicitly enabled. When disabled, the OTel SDK is not loaded at all — zero runtime overhead.
- **No content by default.** Prompts, responses, and tool arguments require opt-in via `captureContent`.
- **No PII in default attributes.** Session IDs, model names, and token counts are not personally identifiable.
- **Respects VS Code telemetry.** If `telemetry.telemetryLevel` is `off`, OTel is disabled regardless of other settings.
- **User-configured endpoints.** Data goes only where you point it — no phone-home behavior.
- **Dynamic imports only.** OTel SDK packages are loaded on-demand, ensuring zero bundle impact when disabled.
