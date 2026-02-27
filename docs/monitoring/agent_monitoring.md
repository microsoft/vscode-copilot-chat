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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP endpoint URL |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | `http/protobuf`, `grpc`, or `http/json` |
| `OTEL_SERVICE_NAME` | `copilot-chat` | Service name in resource attributes |
| `OTEL_RESOURCE_ATTRIBUTES` | — | Extra resource attributes (`key1=val1,key2=val2`) |
| `COPILOT_OTEL_CAPTURE_CONTENT` | `false` | Capture full prompt/response content |
| `COPILOT_OTEL_LOG_LEVEL` | `info` | Min log level: `trace`, `debug`, `info`, `warn`, `error` |
| `COPILOT_OTEL_FILE_EXPORTER_PATH` | — | Write all signals to this file (JSON-lines) |
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

| Attribute | Example |
|---|---|
| `gen_ai.agent.name` | `copilot` |
| `gen_ai.conversation.id` | `a1b2c3d4-...` |
| `gen_ai.request.model` | `gpt-4o` |
| `gen_ai.usage.input_tokens` | `12500` |
| `gen_ai.usage.output_tokens` | `3200` |
| `copilot_chat.turn_count` | `4` |

**`chat`** — one span per LLM API call.

| Attribute | Example |
|---|---|
| `gen_ai.request.model` | `gpt-4o` |
| `gen_ai.response.id` | `chatcmpl-abc123` |
| `gen_ai.usage.input_tokens` | `1500` |
| `gen_ai.usage.output_tokens` | `250` |
| `copilot_chat.time_to_first_token` | `450` |
| `server.address` | `api.github.com` |

**`execute_tool`** — one span per tool invocation.

| Attribute | Example |
|---|---|
| `gen_ai.tool.name` | `readFile` |
| `gen_ai.tool.call.id` | `call_abc123` |
| `error.type` | `FileNotFoundError` |

### Metrics

| Metric | Type | Unit | Description |
|---|---|---|---|
| `gen_ai.client.operation.duration` | Histogram | s | LLM API call duration |
| `gen_ai.client.token.usage` | Histogram | tokens | Token counts (input/output) |
| `copilot_chat.tool.call.count` | Counter | calls | Tool invocations by name and success |
| `copilot_chat.tool.call.duration` | Histogram | ms | Tool execution latency |
| `copilot_chat.agent.invocation.duration` | Histogram | s | Agent mode end-to-end duration |
| `copilot_chat.agent.turn.count` | Histogram | turns | LLM round-trips per agent invocation |
| `copilot_chat.session.count` | Counter | sessions | Chat sessions started |
| `copilot_chat.time_to_first_token` | Histogram | s | Time to first SSE token |

### Events

| Event | When Emitted |
|---|---|
| `gen_ai.client.inference.operation.details` | After each LLM call (model, tokens, finish reasons) |
| `copilot_chat.session.start` | New chat session begins |
| `copilot_chat.tool.call` | Tool invocation completes |
| `copilot_chat.agent.turn` | Each agent LLM round-trip |

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

## Interpreting the Data

**Traces** — Visualize the full agent execution in Jaeger or Grafana Tempo. Each `invoke_agent` span contains child `chat` and `execute_tool` spans, making it easy to identify bottlenecks and debug failures.

**Metrics** — Track token usage trends by model, monitor tool success rates via `copilot_chat.tool.call.count`, and watch perceived latency with `copilot_chat.time_to_first_token`.

**Events** — `copilot_chat.session.start` tracks session creation. `copilot_chat.tool.call` events provide per-invocation timing and error details. `gen_ai.client.inference.operation.details` gives the full LLM call record when content capture is enabled.

---

## Security & Privacy

- **Off by default.** No OTel data is emitted unless explicitly enabled.
- **No content by default.** Prompts, responses, and tool arguments require opt-in.
- **No PII in default attributes.** Session IDs, model names, and token counts are not personally identifiable.
- **Respects VS Code telemetry.** If `telemetry.telemetryLevel` is `off`, OTel is also disabled.
- **User-configured endpoints.** Data goes only where you point it — no phone-home behavior.
