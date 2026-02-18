# OpenTelemetry Instrumentation for VS Code Copilot Chat

> **One-liner:** Add opt-in OTel GenAI semantic convention instrumentation to the Copilot Chat extension and eval runtime, dual-writing all existing file outputs (for MSBench/ZIP/extension compatibility) AND streaming the same data to any OTLP-compatible backend for real-time observability.

**Status:** Draft
**Date:** 2025-02-18
**Authors:** @zhichli

---

## Decisions Log

| # | Decision | Choice | Notes |
|---|---|---|---|
| D1 | Buffer + flush | **Yes, chat extension only** | Eval configures via env; no code changes in eval repo |
| D2 | Exporter strategy | **OTLP HTTP + gRPC + File fallback** | All in chat extension; eval sets env vars |
| D3 | Resource attributes | **Version + Session + Benchmark via env** | Extension sets `service.version`, `session.id`; benchmark IDs via `OTEL_RESOURCE_ATTRIBUTES` |
| D4 | Env precedence | **Layered (Gemini-style)** | Strict endpoint parsing (origin for gRPC, href for HTTP) |
| D5 | HTTP auto-instrumentation | **Optional behind env flag** | Default: manual spans only; `COPILOT_OTEL_HTTP_INSTRUMENTATION=true` to enable |
| D6 | Span coverage | **Full: root + LLM + tool** | `invoke_agent`, `chat`, `execute_tool` per GenAI conventions |
| D7 | Content capture | **Full content, no truncation, no external storage** | Opt-in via `COPILOT_OTEL_CAPTURE_CONTENT=true`; send all messages and tool args/results on attributes |
| D8 | Logs bridge | **Optional behind env flag** | Severity + trace/span correlation; `COPILOT_OTEL_LOG_LEVEL` controls level |
| D9 | Eval OTel | **Yes, dual-write** | Eval runtime also emits OTel (eval spans, assertion events, metrics) alongside existing file outputs |
| D10 | Code changes scope | **Both repos** | Chat ext: agent OTel. Eval repo: eval harness OTel. All existing files kept for MSBench/ZIP compat |
| D11 | File output strategy | **Keep all files, add OTel on top** | trajectory.json, eval.json, custom_metrics.json, logs, configs all still produced as files |
| D12 | Event ordering | **Add `event.sequence`** | Monotonic counter per session for ordering events without relying on timestamps (learned from Claude Code) |
| D13 | Cardinality controls | **Env-configurable** | `OTEL_METRICS_INCLUDE_SESSION_ID`, `OTEL_METRICS_INCLUDE_VERSION` to control metric dimensions |
| D14 | Export intervals | **Configurable via standard env** | `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_LOGS_EXPORT_INTERVAL` for shorter intervals during debugging |
| D15 | OS/arch resource attrs | **Include by default** | `os.type`, `os.version`, `host.arch` on all signals for platform debugging |

---

## 1. Problem Statement & Motivation

### Current Eval Pain Points

| Pain Point | Impact |
|---|---|
| **No real-time visibility** — All data (trajectory, metrics, logs) only available after ZIP download from MSBench | Cannot debug or monitor in-progress runs |
| **Token/cost metrics are incomplete** — No aggregated totals, no per-model cost tracking, no histogram | Hard to compare runs or models at a glance |
| **Two incompatible chat export formats** — Legacy format (trajectory + timing) and new format (per-step tool calls) carry different data | Fragile pipeline, format-dependent parsing |
| **TTFT/TTLT only from legacy format** — Timing metrics require old `debug.exportAllPromptLogsAsJson` to succeed | Timing metrics silently missing on failure |
| **Large ZIP sizes** — SQLite DB with full file contents, video, full VS Code logs, multiple export formats | Slow download/analysis cycle |
| **Fragmented assertion results** — Per-step traces scattered across `vsc-output/steps/{N}/assertions/{M}/` directories | Hard to correlate with agent decisions |
| **No standard format** — Custom JSON schemas for trajectory/metrics → custom tooling required | Not interoperable with existing observability tools |

### Why OpenTelemetry?

- **Vendor-neutral OTLP protocol** — Export to Jaeger, Grafana, Azure Monitor, Datadog, etc.
- **GenAI semantic conventions** — Purpose-built attributes and spans for LLM applications
- **Real-time streaming** — Data exported during the run, not after
- **Rich correlation** — Trace IDs link spans to metrics and logs automatically
- **Ecosystem** — Standard dashboards, alerting, and analysis tooling

---

## 2. Principles

1. **Standards-first** — All signal names, attributes, and units follow the [OTel GenAI Semantic Conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/) (development status). Custom attributes are namespaced under `copilot_chat.*`.
2. **Additive, non-breaking** — The new OTel layer sits alongside the existing `ITelemetryService` (GitHub + MSFT App Insights). No existing telemetry is removed or modified.
3. **Off by default, opt-in** — All OTel emission is gated behind `OTEL_EXPORTER_OTLP_ENDPOINT` env var (or VS Code setting). When disabled, the overhead is zero (no-op providers).
4. **Sensitive data is never captured by default** — `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, and `gen_ai.tool.definitions` are only populated when the user explicitly opts in via `COPILOT_OTEL_CAPTURE_CONTENT=true`. Full content, no truncation.
5. **Extension-host safe** — Only Node-compatible OTel packages are used, and all OTel work runs off the hot path via batched processors.
6. **Buffer + flush** — Telemetry is buffered during startup and flushed explicitly on shutdown to prevent data loss (adopted from Gemini CLI pattern).

---

## 3. Semantic Convention Reference

This spec targets the latest *development* versions of the OTel GenAI semantic conventions:

| Convention | URL | Status |
|---|---|---|
| GenAI Spans | https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-spans.md | Development |
| GenAI Agent Spans | https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-agent-spans.md | Development |
| GenAI Metrics | https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-metrics.md | Development |
| GenAI Events | https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-events.md | Development |

---

## 4. Current State: Chat Extension Instrumentation Points

| Signal | Key Location | Data Available |
|---|---|---|
| LLM request/response | `ChatMLFetcherImpl._fetchWithInstrumentation()` | model, tokens (in/out/cached/reasoning), TTFT, TTLT, finish reason, messages |
| Tool execution | `getToolResult()` in `toolCalling.tsx` | tool name, ID, args, result content, success/failure, duration, token count |
| Agent loop | `ToolCallingLoop.run()` / `runOne()` | iteration index, session ID, tool call rounds, stop reasons |
| Request handling | `ChatParticipantRequestHandler` | session ID, message ID, location, intent, history |
| Existing telemetry | `ChatMLFetcherTelemetrySender` | All success/error/cancellation measurements (2 destinations: Microsoft 1DS + GitHub) |
| Log service | `ILogService` via VS Code output channels | Structured trace/debug/info/warn/error |
| Request logger | `IRequestLogger` with `AsyncLocalStorage` | Full request lifecycle, cross-IPC correlation |
| Session transcript | `ISessionTranscriptService` | Structured events (session.start, user.message, tool.execution_*, assistant.*) |

### ID Correlation Map

| ID | Origin | Scope | Maps To |
|---|---|---|---|
| `sessionId` | `Conversation` constructor (UUID) | Conversation | `gen_ai.conversation.id` |
| `turn.id` / `messageId` | `Turn.fromRequest()` | Turn | OTel span attribute |
| `ourRequestId` | `ChatMLFetcherImpl.fetchMany()` (UUID) | LLM call | `gen_ai.response.id` |
| `headerRequestId` | Response headers | Server | Span attribute |
| `gitHubRequestId` | `x-github-request-id` header | Server | Span attribute |
| `toolCall.id` | LLM response | Tool call | `gen_ai.tool.call.id` |

---

## 5. Architecture Overview

```
┌───────────────────────────────────────────────────────────────────────┐
│                     VS Code Copilot Chat Extension                    │
│                                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │ Chat        │  │ Chat ML      │  │ Tools       │  │ Agent Mode │ │
│  │ Participants│  │ Fetcher/     │  │ Service     │  │ Orchestr.  │ │
│  │             │  │ Endpoint     │  │             │  │            │ │
│  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘  └─────┬──────┘ │
│         │                │                  │               │        │
│         ▼                ▼                  ▼               ▼        │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │                   IOTelService (new DI service)                 │ │
│  │                                                                 │ │
│  │  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌──────────────────┐ │ │
│  │  │ Tracer  │  │ Meter    │  │ Logger  │  │ Semantic Helpers │ │ │
│  │  │ (spans) │  │ (metrics)│  │ (events)│  │ (attribute maps) │ │ │
│  │  └────┬────┘  └────┬─────┘  └────┬────┘  └──────────────────┘ │ │
│  └───────┼─────────────┼────────────┼────────────────────────────┘  │
│          │             │            │                                │
│          ▼             ▼            ▼                                │
│  ┌─────────────────────────────────────────────────────┐            │
│  │        OTel SDK (BatchSpanProcessor,                │            │
│  │        BatchLogRecordProcessor,                     │            │
│  │        PeriodicExportingMetricReader)                │            │
│  └───────────────────────┬─────────────────────────────┘            │
│                          │                                           │
│  ┌───────────────────────▼─────────────────────────────┐            │
│  │              Exporter Layer (configurable)           │            │
│  │  ┌──────────┐  ┌───────────┐  ┌──────────────────┐ │            │
│  │  │ OTLP/    │  │ Console   │  │ File (JSON-line) │ │            │
│  │  │ gRPC/HTTP│  │           │  │                  │ │            │
│  │  └──────────┘  └───────────┘  └──────────────────┘ │            │
│  └─────────────────────────────────────────────────────┘            │
│                                                                      │
│  ┌──────────────────────────────────────────────────────┐           │
│  │ Existing ITelemetryService (GH + MSFT) — unchanged   │           │
│  └──────────────────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 6. Traces / Spans

### 4.1 Inference Span (per LLM call)

Created in the chat endpoint / `IChatMLFetcher` layer, wrapping each call to the Copilot API.

| Attribute | Source | Requirement |
|---|---|---|
| `gen_ai.operation.name` | `"chat"` | Required |
| `gen_ai.provider.name` | `"openai"` (Copilot proxies OpenAI-compatible API) | Required |
| `gen_ai.request.model` | Request model name (e.g. `gpt-4o`) | Cond. Required |
| `gen_ai.response.model` | Response model header | Recommended |
| `gen_ai.conversation.id` | Chat session ID from `ChatParticipantRequestHandler` | Cond. Required |
| `gen_ai.response.id` | Completion ID from SSE response | Recommended |
| `gen_ai.response.finish_reasons` | `["stop"]`, `["length"]`, etc. | Recommended |
| `gen_ai.usage.input_tokens` | From usage metadata | Recommended |
| `gen_ai.usage.output_tokens` | From usage metadata | Recommended |
| `gen_ai.request.temperature` | From request config | Recommended |
| `gen_ai.request.max_tokens` | From request config | Recommended |
| `gen_ai.request.top_p` | From request config | Recommended |
| `server.address` | Copilot API host | Recommended |
| `server.port` | Copilot API port | Cond. Required |
| `error.type` | HTTP status or exception class | Cond. Required |
| `gen_ai.input.messages` | Full prompt (Opt-In only) | Opt-In |
| `gen_ai.output.messages` | Full response (Opt-In only) | Opt-In |
| `gen_ai.system_instructions` | System prompt (Opt-In only) | Opt-In |
| `gen_ai.tool.definitions` | Tool schemas (Opt-In only) | Opt-In |

**Span name:** `chat {gen_ai.request.model}` (e.g. `chat gpt-4o`)
**Span kind:** `CLIENT`

### 4.2 Invoke Agent Span (Agent Mode)

Created in the agent / conversation orchestration layer when Agent Mode is activated.

| Attribute | Source | Requirement |
|---|---|---|
| `gen_ai.operation.name` | `"invoke_agent"` | Required |
| `gen_ai.provider.name` | `"openai"` | Required |
| `gen_ai.agent.name` | Participant ID (e.g. `copilot`, `workspace`, `terminal`) | Cond. Required |
| `gen_ai.agent.id` | Internal agent/participant ID | Cond. Required |
| `gen_ai.conversation.id` | Session ID | Cond. Required |
| `gen_ai.request.model` | Model being used | Cond. Required |
| `gen_ai.usage.input_tokens` | Aggregated across turns | Recommended |
| `gen_ai.usage.output_tokens` | Aggregated across turns | Recommended |
| `gen_ai.response.finish_reasons` | Final turn finish reason | Recommended |

**Span name:** `invoke_agent {gen_ai.agent.name}`
**Span kind:** `INTERNAL` (in-process agent orchestration)

### 4.3 Execute Tool Span (per tool invocation)

Created in `IToolsService.invokeTool()`, wrapping each tool call.

| Attribute | Source | Requirement |
|---|---|---|
| `gen_ai.operation.name` | `"execute_tool"` | Required |
| `gen_ai.tool.name` | Tool name (e.g. `readFile`, `runCommand`, `searchWeb`) | Recommended |
| `gen_ai.tool.type` | `"function"` for native tools, `"extension"` for MCP tools | Recommended |
| `gen_ai.tool.call.id` | Tool call ID from model response | Recommended |
| `gen_ai.tool.description` | Tool description string | Recommended |
| `gen_ai.tool.call.arguments` | Tool arguments JSON (Opt-In only) | Opt-In |
| `gen_ai.tool.call.result` | Tool result (Opt-In only) | Opt-In |
| `error.type` | Exception class or error code | Cond. Required |

**Span name:** `execute_tool {gen_ai.tool.name}`
**Span kind:** `INTERNAL`

### 4.4 Embeddings Span (semantic search)

Created in `IWorkspaceSemanticSearch` when embedding generation is invoked.

| Attribute | Source | Requirement |
|---|---|---|
| `gen_ai.operation.name` | `"embeddings"` | Required |
| `gen_ai.provider.name` | `"openai"` | Required |
| `gen_ai.request.model` | Embedding model name | Cond. Required |
| `gen_ai.usage.input_tokens` | From usage data | Recommended |

**Span name:** `embeddings {gen_ai.request.model}`
**Span kind:** `CLIENT`

### 4.5 Span Hierarchy Example (Agent Mode)

```
invoke_agent copilot                                    [INTERNAL, ~15s]
  ├── chat gpt-4o                                       [CLIENT, ~3s]
  │     (model requests tool calls)
  ├── execute_tool readFile                             [INTERNAL, ~50ms]
  ├── execute_tool runCommand                           [INTERNAL, ~2s]
  ├── chat gpt-4o                                       [CLIENT, ~4s]
  │     (model generates final response)
  └── (span ends with final finish_reason)
```

---

## 7. Metrics

### 5.1 Required Metrics (OTel GenAI convention)

| Metric | Type | Unit | Description |
|---|---|---|---|
| `gen_ai.client.operation.duration` | Histogram | `s` | Duration of each LLM API call |
| `gen_ai.client.token.usage` | Histogram | `{token}` | Input and output token counts per call |

**Bucket boundaries:**
- `gen_ai.client.operation.duration`: `[0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92]`
- `gen_ai.client.token.usage`: `[1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864]`

**Common metric attributes:**

| Attribute | Requirement |
|---|---|
| `gen_ai.operation.name` | Required |
| `gen_ai.provider.name` | Required |
| `gen_ai.request.model` | Cond. Required |
| `gen_ai.response.model` | Recommended |
| `server.address` | Recommended |
| `server.port` | Cond. Required |
| `error.type` | Cond. Required (on `operation.duration` only) |
| `gen_ai.token.type` | Required (on `token.usage` only, values: `input`, `output`) |

### 5.2 Extension-Specific Metrics

| Metric | Type | Unit | Description |
|---|---|---|---|
| `copilot_chat.tool.call.count` | Counter | `{call}` | Tool invocations, by tool name and success |
| `copilot_chat.tool.call.duration` | Histogram | `ms` | Tool execution latency |
| `copilot_chat.agent.invocation.duration` | Histogram | `s` | Agent mode end-to-end duration |
| `copilot_chat.agent.turn.count` | Histogram | `{turn}` | Number of LLM round-trips per agent invocation |
| `copilot_chat.session.count` | Counter | `{session}` | Chat sessions started |
| `copilot_chat.time_to_first_token` | Histogram | `s` | Time from request sent to first SSE token received |
| `copilot_chat.inline_chat.duration` | Histogram | `s` | Inline chat (Ctrl+I) operation duration |

---

## 8. Events (Logs)

### 6.1 OTel GenAI Standard Event

| Event Name | When Emitted |
|---|---|
| `gen_ai.client.inference.operation.details` | After each LLM call completes (success or error) |

This event carries the full request/response details including `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, token usage, model parameters, and finish reasons — following the exact attribute schema from the GenAI events spec.

### 6.2 Extension-Specific Events

| Event Name | When Emitted | Key Attributes |
|---|---|---|
| `copilot_chat.session.start` | New chat session begins | `session.id`, model, participant, mode |
| `copilot_chat.session.end` | Chat session ends | `session.id`, turn count, total tokens |
| `copilot_chat.tool.call` | Each tool invocation completes | tool name, duration, success, error |
| `copilot_chat.agent.turn` | Each agent → LLM → tool round-trip | turn number, tokens, tool calls in turn |

---

## 9. Resource Attributes

All spans, metrics, and events carry these resource-level attributes:

| Attribute | Value | Source |
|---|---|---|
| `service.name` | `copilot-chat` (chat ext) / `copilot-eval` (eval runtime) | Config |
| `service.version` | Extension version / eval runtime version | `package.json` |
| `session.id` | Unique per VS Code session | Runtime |
| `os.type` | `linux`, `darwin`, `windows` | `process.platform` |
| `os.version` | OS version string | `os.release()` |
| `host.arch` | `amd64`, `arm64` | `process.arch` |
| `telemetry.sdk.name` | `opentelemetry` | SDK |
| `telemetry.sdk.language` | `nodejs` | SDK |

---

## 10. Configuration & Activation

### Environment Variables (primary activation method)

| Variable | Default | Description |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset) | OTLP endpoint URL. When set, enables OTel. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | `http/protobuf`, `grpc`, or `http/json` |
| `OTEL_SERVICE_NAME` | `copilot-chat` | Service name in OTel resource |
| `OTEL_RESOURCE_ATTRIBUTES` | (none) | Extra resource attrs (e.g., `benchmark.id=...`) |
| `COPILOT_OTEL_CAPTURE_CONTENT` | `false` | Enable full content attributes (messages, tool args/results) — no truncation |
| `COPILOT_OTEL_LOG_LEVEL` | `info` | Min log level to bridge to OTel (`trace`/`debug`/`info`/`warn`/`error`) |
| `COPILOT_OTEL_HTTP_INSTRUMENTATION` | `false` | Enable HTTP auto-instrumentation for request-level timing |
| `COPILOT_OTEL_FILE_EXPORTER_PATH` | (unset) | When set, export spans/logs/metrics to this local file (fallback) |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Metrics export interval in ms (set to `10000` for debugging) |
| `OTEL_LOGS_EXPORT_INTERVAL` | `5000` | Logs/events export interval in ms |
| `OTEL_METRICS_INCLUDE_SESSION_ID` | `true` | Include `session.id` in metric dimensions (disable if cardinality is a concern) |
| `OTEL_METRICS_INCLUDE_VERSION` | `false` | Include `service.version` in metric dimensions |
| `OTEL_EXPORTER_OTLP_HEADERS` | (none) | Auth headers for OTLP endpoint (e.g., `Authorization=Bearer token`) |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | (none) | Override endpoint for metrics only (when different from traces/logs) |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | (none) | Override endpoint for logs only |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | `gen_ai_latest_experimental` | Use latest GenAI conventions |

### VS Code Settings (optional, lower priority than env vars)

All under the `copilotChat.telemetry.otel` namespace:

| Setting | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Master switch for OTel emission |
| `exporterType` | `"otlp-grpc"` \| `"otlp-http"` \| `"console"` \| `"file"` | `"otlp-http"` | Exporter backend |
| `otlpEndpoint` | `string` | `"http://localhost:4318"` | OTLP collector endpoint |
| `captureContent` | `boolean` | `false` | Opt-in content capture |
| `outfile` | `string` | `undefined` | File path for file exporter output |

### Precedence Order

Following Gemini-style layered env precedence:
1. `COPILOT_OTEL_*` env vars (highest)
2. `OTEL_EXPORTER_OTLP_*` standard env vars
3. VS Code settings
4. Defaults (lowest)

Endpoint parsing: origin for gRPC (strip path), full href for HTTP.

---

## 11. Dual-Write Strategy & Eval Runtime OTel

### Core Principle: Keep All Files, Add OTel On Top

All existing output files continue to be produced for backward compatibility with MSBench dashboards, ZIP-based post-run analysis, and the VSCBench Explorer extension. **OTel emission is additive** — it streams the same data to a remote backend in parallel.

### Signal Map: Every Output File → OTel Equivalent

| Output File | Produced By | Keep as File? | Also Emit to OTel? | OTel Signal Type | OTel Source |
|---|---|---|---|---|---|
| `trajectory.json` | Eval runtime | **Yes** (MSBench) | **Yes** | Traces (`invoke_agent` → `chat` → `execute_tool`) | Chat extension |
| `chat-export-logs.json` | Chat ext | **Yes** | **Yes** | `chat` spans + `gen_ai.client.inference.operation.details` events | Chat extension |
| `chat-turns/*.json` | Eval runtime | **Yes** | **Yes** | `chat` spans with `gen_ai.input/output.messages` | Chat extension |
| `custom_metrics.json` (timing) | Eval runtime | **Yes** (MSBench) | **Yes** | `gen_ai.client.operation.duration`, `copilot_chat.time_to_first_token` | Chat extension |
| `custom_metrics.json` (patch) | Eval runtime | **Yes** (MSBench) | **Yes** | `eval.patch.*` metrics | Eval runtime |
| `eval.json` | Eval runtime | **Yes** (MSBench) | **Yes** | `gen_ai.evaluation.result` events (per assertion) | Eval runtime |
| `version.json` | Eval runtime | **Yes** | **Yes** | Resource attributes on eval root span | Eval runtime |
| `extensions-info.json` | Eval runtime | **Yes** | **Yes** | `eval.environment.extensions` event | Eval runtime |
| `setting-info.json` | Eval runtime | **Yes** | **Yes** | `eval.environment.settings` event | Eval runtime |
| `configs/*.yaml` | Eval runtime | **Yes** | **Yes** | `eval.config` event | Eval runtime |
| `patch.diff` | Eval runtime | **Yes** | **Yes** | `eval.patch.diff` event (full diff as attribute) | Eval runtime |
| `error.json` | Both | **Yes** | **Yes** | Span status ERROR + `eval.error` event | Both |
| `extension-host.log` | Chat ext | **Yes** | **Yes** | OTel log bridge (severity + trace/span correlation) | Chat extension |
| `full-logs.log` | VS Code | **Yes** | No (too noisy) | — | — |
| `capi-proxy.log` | Eval runtime | **Yes** | Optional | `eval.proxy.*` spans if needed | Eval runtime |
| `session.sqlite` | Eval runtime | **Yes** | No (derived from above) | — | — |
| `screen_recording.mp4` | Eval runtime | **Yes** (local only) | **Ref only** | `eval.video.path` attr on root span | Eval runtime |
| `final-screenshot.jpeg` | Eval runtime | **Yes** (local only) | **Ref only** | `eval.screenshot.path` attr on root span | Eval runtime |

### Eval Runtime OTel Signals (new, in eval repo)

#### Span Hierarchy & Metadata Placement

Per the OTel spec, `gen_ai.evaluation.result` events **SHOULD be parented to the GenAI operation span being evaluated**. Our hierarchy:

```
eval.run {benchmark_name}                              ← Eval root span (INTERNAL)
│  benchmark.id, benchmark.name, model.id, model.vendor
│  vscode.version, copilot_chat.version, eval.resolved
│  eval.config (benchmark YAML as attribute)
│
├── [invoke_agent copilot-chat]                        ← Chat ext root span (linked via trace context)
│   ├── [chat gpt-5.2-codex]                          ← LLM span (has gen_ai.response.id)
│   ├── [execute_tool read_file]
│   ├── [chat gpt-5.2-codex]
│   └── ...
│
├── gen_ai.evaluation.result (event)                   ← Per-assertion event, parented to eval.run
│   ├── gen_ai.evaluation.name = "json_file_exists"
│   ├── gen_ai.evaluation.score.value = 1.0
│   ├── gen_ai.evaluation.score.label = "pass"
│   ├── gen_ai.evaluation.explanation = "Agent created JSON file..."
│   └── gen_ai.response.id = <linked to last chat span>
│
├── gen_ai.evaluation.result (event)                   ← Another assertion
│   ├── gen_ai.evaluation.name = "json_valid_content"
│   ├── gen_ai.evaluation.score.value = 1.0
│   ├── gen_ai.evaluation.score.label = "pass"
│   └── gen_ai.evaluation.explanation = "JSON contains camelCase keys..."
│
├── gen_ai.evaluation.result (event)                   ← Failed assertion example
│   ├── gen_ai.evaluation.name = "python_validation"
│   ├── gen_ai.evaluation.score.value = 0.0
│   ├── gen_ai.evaluation.score.label = "fail"
│   ├── gen_ai.evaluation.explanation = "Command exited with code 1"
│   └── error.type = "assertion_failed"
│
├── eval.environment.extensions (event)                ← Environment snapshot
├── eval.environment.settings (event)
├── eval.config (event)                                ← Benchmark config
└── eval.patch.diff (event)                            ← Code changes
```

**Where metadata lives:**

| Metadata | Where | Why |
|---|---|---|
| `benchmark.id`, `benchmark.name` | Resource attributes on all eval signals | Low-cardinality, same for entire run |
| `model.id` (e.g., `gpt-5.2-codex`), `model.vendor` (e.g., `copilot`) | Resource attributes | Same model for entire eval run |
| `vscode.version`, `vscode.commit`, `copilot_chat.version` | Resource attributes | Environment info, same for entire run |
| `eval.resolved` (true/false) | `eval.run` span attribute | Overall pass/fail, set at span end |
| `eval.config` (benchmark YAML) | `eval.config` event attribute OR `eval.run` span attribute | Benchmark-specific config |
| Per-assertion details | `gen_ai.evaluation.result` event attributes | Different per assertion |

#### `gen_ai.evaluation.result` Event (per OTel semconv)

Each assertion produces one event following the **exact** OTel schema:

| Attribute | Requirement | Source | Example |
|---|---|---|---|
| `gen_ai.evaluation.name` | **Required** | Assertion comment or auto-generated name | `"json_file_exists"`, `"python_validation"` |
| `gen_ai.evaluation.score.value` | **Cond. Required** | 1.0 for pass, 0.0 for fail | `1.0` |
| `gen_ai.evaluation.score.label` | **Cond. Required** | `"pass"` or `"fail"` | `"pass"` |
| `gen_ai.evaluation.explanation` | **Recommended** | Assertion comment + SQL query + error details | `"Agent created JSON file from YAML. Query: SELECT COUNT(*) > 0 FROM files WHERE path = 'example.json'"` |
| `gen_ai.response.id` | **Recommended** | Last `chat` span's response ID (correlates eval to agent output) | `"chatcmpl-abc123"` |
| `error.type` | **Cond. Required** | Set when assertion errors (not just fails) | `"assertion_error"`, `"sql_error"` |

#### Traces

| Span Name | Kind | Key Attributes |
|---|---|---|
| `eval.run {benchmark_name}` | INTERNAL (root) | `eval.resolved`, `eval.assertion_count`, `eval.assertions_passed`, `eval.duration_sec` |

#### Metrics

| Metric | Type | Unit | Description |
|---|---|---|---|
| `eval.patch.size_bytes` | Histogram | bytes | Size of generated patch.diff |
| `eval.patch.lines_changed` | Histogram | lines | Additions + deletions |
| `eval.patch.files_changed` | Histogram | files | Files changed per run |
| `eval.assertion.count` | Counter | assertions | Total assertions, by passed/failed |
| `eval.run.duration` | Histogram | seconds | Total eval run wall clock |

#### Environment & Config Events

| Event Name | When | Key Attributes |
|---|---|---|
| `eval.environment.extensions` | Run start | List of installed extensions (JSON) |
| `eval.environment.settings` | Run start | VS Code settings snapshot (JSON) |
| `eval.config` | Run start | Benchmark config + user overrides (JSON) |
| `eval.patch.diff` | Run end | Full patch.diff content |
| `eval.error` | On error | `type`, `message`, `trace` |

#### Resource Attributes (on all eval signals)

| Attribute | Source |
|---|---|
| `service.name` | `copilot-eval` |
| `service.version` | Eval runtime version |
| `benchmark.id` | Instance ID from MSBench |
| `benchmark.name` | Test name (e.g., `convert_to_json_prompt_file`) |
| `vscode.version` | From `version.json` |
| `vscode.commit` | From `version.json` |
| `copilot_chat.version` | From `version.json` |
| `model.id` | From eval result (e.g., `gpt-5.2-codex`) |
| `model.vendor` | From eval result (e.g., `copilot`) |

### Docker Environment Variables

```yaml
environment:
  # Chat extension OTel (forwarded to VS Code process)
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318"
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf"
  COPILOT_OTEL_CAPTURE_CONTENT: "true"
  COPILOT_OTEL_LOG_LEVEL: "info"
  OTEL_RESOURCE_ATTRIBUTES: "benchmark.id=${INSTANCE_ID},benchmark.name=${TEST_NAME}"

  # Eval runtime OTel (same endpoint, different service.name)
  EVAL_OTEL_ENABLED: "true"
  EVAL_OTEL_SERVICE_NAME: "copilot-eval"
```

---

## 12. Non-Goals

1. **Remove or replace file outputs** — All existing files (trajectory.json, eval.json, custom_metrics.json, logs, configs, video, screenshots) continue to be produced. OTel is purely additive.
2. **Replace existing MS/GH telemetry** — `ITelemetryService` (1DS + GitHub) remains unchanged.
3. **Server-side metrics** — Only client-side (`gen_ai.client.*`) metrics.
4. **Blanket HTTP auto-instrumentation** — Optional behind env flag, not default.
5. **Web extension support** — Node.js only for initial implementation.
6. **Custom collector/backend** — Users bring their own.
7. **Production monitoring/alerting** — For eval and debugging only.
8. **Streaming chunk-level events** — Buffered/aggregated data only.
9. **Bundle size > 200KB** — Tree-shaken, dynamic import when disabled.
10. **Cost calculation** — Token counts exported; cost is a backend concern.
11. **Inline completions** — Only chat/agent mode.
12. **Claude Agent SDK path** — Follow-up, not Phase 1.
13. **Content truncation / external storage** — Full content, no truncation.
14. **Video/screenshots in OTel** — Binary files stay local; only path references in spans.

---

## 13. Security & Privacy

- **Content capture is opt-in.** Never recorded unless `COPILOT_OTEL_CAPTURE_CONTENT=true`.
- **No PII in default attributes.** Session IDs, model names, and token counts are not PII.
- **OTLP endpoints are user-configured.** No phone-home.
- **Extension telemetry consent.** Respects VS Code's global `telemetry.telemetryLevel`. If disabled globally, OTel is also disabled.

---

## 14. Lessons from Gemini CLI

Gemini CLI (`packages/core/src/telemetry/`) implements all three OTel pillars natively.

### Adopted

| Pattern | Gemini Implementation | Our Adaptation |
|---|---|---|
| **Buffer + flush** | `bufferTelemetryEvent()` queues until SDK ready; `flushTelemetry()` ensures export on exit | Same in `IOTelService` |
| **OTLP gRPC + HTTP** | Both via config; gRPC uses GZIP | Same; default HTTP/protobuf |
| **File exporter fallback** | `FileSpanExporter` / `FileLogExporter` / `FileMetricExporter` append JSON | Adopt for CI/offline |
| **Layered env precedence** | `GEMINI_TELEMETRY_OTLP_ENDPOINT` > settings > `OTEL_EXPORTER_OTLP_ENDPOINT` | Same with `COPILOT_OTEL_*` prefix |
| **Dual-write metrics** | GenAI + custom counters | Same: `gen_ai.*` + `copilot_chat.*` |
| **Convention attribute helpers** | `getConventionAttributes()` | Same: centralized builder |
| **Resource attributes** | `service.name`, `service.version`, `session.id` | Same + benchmark IDs via env |
| **Logs alongside metrics** | Every domain event emits both log + metric | Same pattern |

### Adapted

| Pattern | Gemini | Our Change |
|---|---|---|
| **Content truncation** | 160KB global limit, fair-share truncation | **Full content, no truncation** |
| **HTTP auto-instrumentation** | Always on | **Optional behind env flag** |
| **Dev tracing wrapper** | `runInDevTraceSpan()` with custom attrs | Use standard GenAI span conventions |
| **SDK choice** | Full `NodeSDK` | Individual providers with dynamic import |

### Skipped

| Pattern | Why |
|---|---|
| Direct GCP exporters | Vendor-specific; we use generic OTLP |
| Credential-aware init | Extension already authenticated |
| ClearcutLogger | Google-internal |
| UI telemetry service | Terminal CLI, not VS Code extension |

---

## 15. Lessons from Claude Code

Claude Code ([monitoring docs](https://code.claude.com/docs/en/monitoring-usage)) exports metrics + events via OTel (no traces/spans). Key patterns we adopt or skip:

### Adopted from Claude Code

| Pattern | Claude Code | Our Adaptation |
|---|---|---|
| **`event.sequence` counter** | Monotonic counter per session for event ordering | Add to all events — critical for reconstructing agent trajectory from events without relying on clock sync |
| **Per-signal endpoint overrides** | `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` independently | Support standard per-signal endpoint env vars |
| **Cardinality controls** | `OTEL_METRICS_INCLUDE_SESSION_ID`, `OTEL_METRICS_INCLUDE_VERSION` | Adopt same env vars — lets teams reduce cardinality for production backends |
| **Export interval controls** | `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_LOGS_EXPORT_INTERVAL` | Adopt — shorter intervals for debugging, defaults for production |
| **OS/arch resource attrs** | `os.type`, `os.version`, `host.arch` | Adopt — useful for diagnosing platform-specific issues in eval |
| **Auth headers** | `OTEL_EXPORTER_OTLP_HEADERS` for bearer tokens | Adopt standard env var — needed for Azure App Insights |

### Where We Go Beyond Claude Code

| Area | Claude Code | Our Advantage |
|---|---|---|
| **Traces/spans** | No spans at all — metrics + events only | Full span hierarchy: `invoke_agent` → `chat` → `execute_tool` with parent-child relationships |
| **GenAI semconv** | Custom `claude_code.*` namespace only | Standard `gen_ai.*` attributes per OTel GenAI semantic conventions |
| **`gen_ai.evaluation.result`** | Not applicable | Per-assertion eval events following OTel semconv exactly |
| **File exporter fallback** | Not available | `FileSpanExporter` / `FileLogExporter` for offline/CI |
| **Dual-write strategy** | Not applicable | Keep all MSBench files AND emit OTel |

### Skipped from Claude Code

| Pattern | Why |
|---|---|
| Prometheus exporter | OTLP covers pull-based via collector; adds complexity |
| `cost.usage` metric | Token counts sufficient; pricing is a backend concern |
| Dynamic headers helper script | Over-engineered; can add later if needed |
| `active_time.total` metric | Not relevant for automated eval runs |

---

## 16. Open Questions

1. **Bundle size approval** — Will the team accept ~200KB of OTel dependencies?
2. **OTel Collector in Docker** — Sidecar vs. direct remote export?
3. **Trace sampling** — 100% for eval; sampling for other use cases?
4. **Claude agent path** — Phase 1 or follow-up?
5. **Context propagation across IPC** — Verify OTel context works with existing `AsyncLocalStorage` / `storeCapturingTokenForCorrelation` mechanism.
6. **CAPI proxy instrumentation** — Should the eval CAPI proxy also emit spans?
