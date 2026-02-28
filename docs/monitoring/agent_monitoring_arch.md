# OTel Instrumentation — Developer Guide

This document describes the architecture, code structure, and conventions for the OpenTelemetry instrumentation in the Copilot Chat extension. It is intended for developers contributing to or maintaining this codebase.

For user-facing configuration and usage, see [agent_monitoring.md](agent_monitoring.md).

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                VS Code Copilot Chat Extension                    │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────┐ │
│  │ ChatML      │  │ Tool Calling │  │ Tools    │  │ Prompts  │ │
│  │ Fetcher     │  │ Loop         │  │ Service  │  │          │ │
│  └──────┬──────┘  └──────┬───────┘  └────┬─────┘  └────┬─────┘ │
│         │                │               │              │       │
│         ▼                ▼               ▼              ▼       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  IOTelService (DI)                        │   │
│  │  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌───────────┐ │   │
│  │  │ Tracer  │  │ Meter    │  │ Logger  │  │ Semantic  │ │   │
│  │  │ (spans) │  │ (metrics)│  │ (events)│  │ Helpers   │ │   │
│  │  └────┬────┘  └────┬─────┘  └────┬────┘  └───────────┘ │   │
│  └───────┼─────────────┼────────────┼──────────────────────┘   │
│          ▼             ▼            ▼                           │
│  ┌─────────────────────────────────────────────┐               │
│  │  OTel SDK (BatchSpanProcessor,              │               │
│  │  BatchLogRecordProcessor,                   │               │
│  │  PeriodicExportingMetricReader)             │               │
│  └──────────────────┬──────────────────────────┘               │
│                     ▼                                          │
│  ┌─────────────────────────────────────────────┐               │
│  │  Exporters: OTLP/HTTP | OTLP/gRPC |        │               │
│  │             Console   | File (JSON-lines)   │               │
│  └─────────────────────────────────────────────┘               │
└──────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
src/platform/otel/
├── common/
│   ├── otelService.ts          # IOTelService interface + ISpanHandle
│   ├── otelConfig.ts           # Config resolution (env → settings → defaults)
│   ├── noopOtelService.ts      # Zero-cost no-op implementation
│   ├── genAiAttributes.ts      # GenAI semantic convention attribute keys
│   ├── genAiEvents.ts          # Event emitter helpers
│   ├── genAiMetrics.ts         # GenAiMetrics class (metric recording)
│   ├── messageFormatters.ts    # Message → OTel JSON schema converters
│   ├── index.ts                # Public API barrel export
│   └── test/                   # Unit tests
└── node/
    ├── otelServiceImpl.ts      # NodeOTelService (real SDK implementation)
    ├── fileExporters.ts        # File-based span/log/metric exporters
    └── test/                   # Unit tests

src/extension/otel/
└── vscode-node/
    └── otelContrib.ts          # Lifecycle contribution (shutdown hook)
```

### Instrumentation Points

| File | What Gets Instrumented |
|---|---|
| `src/extension/prompt/node/chatMLFetcher.ts` | `chat` spans — one per LLM API call. Used by standard CAPI endpoints **and** all OpenAI-compatible BYOK providers (Azure, OpenAI, Ollama, OpenRouter, xAI, CustomOAI) via `CopilotLanguageModelWrapper` → `endpoint.makeChatRequest` |
| `src/extension/byok/vscode-node/anthropicProvider.ts` | `chat` spans — BYOK Anthropic requests (native SDK, instrumented directly) |
| `src/extension/byok/vscode-node/geminiNativeProvider.ts` | `chat` spans — BYOK Gemini requests (native SDK, instrumented directly) |
| `src/extension/intents/node/toolCallingLoop.ts` | `invoke_agent` spans — wraps agent orchestration |
| `src/extension/tools/vscode-node/toolsService.ts` | `execute_tool` spans — one per tool invocation |
| `src/extension/prompts/node/panel/toolCalling.tsx` | Tool call event emission from prompt layer |
| `src/extension/extension/vscode-node/services.ts` | Service registration (config → NodeOTelService or NoopOTelService) |

---

## Service Layer

### `IOTelService` Interface

The core abstraction. All consumers depend on this interface, never on the OTel SDK directly. It exposes methods for starting spans, recording metrics, emitting log records, managing trace context propagation, and lifecycle (`flush`/`shutdown`).

### Implementations

| Class | When Used | Characteristics |
|---|---|---|
| `NoopOTelService` | OTel disabled (default) | All methods are empty. Zero cost. |
| `NodeOTelService` | OTel enabled | Full SDK with dynamic imports, buffering, batched processors. |

### Registration

In `services.ts`, the config is resolved from env + settings, then the appropriate implementation is registered:

```typescript
const otelConfig = resolveOTelConfig({ env: process.env, ... });
if (otelConfig.enabled) {
  const { NodeOTelService } = require('.../otelServiceImpl');
  builder.define(IOTelService, new NodeOTelService(otelConfig));
} else {
  builder.define(IOTelService, new NoopOTelService(otelConfig));
}
```

The `require()` (not `import()`) is intentional here — it avoids loading the SDK at all when disabled, while the `NodeOTelService` constructor internally uses `import()` for all OTel packages.

---

## Configuration Resolution

`resolveOTelConfig()` in `otelConfig.ts` implements layered precedence:

1. `COPILOT_OTEL_*` env vars (highest)
2. `OTEL_EXPORTER_OTLP_*` standard env vars
3. VS Code settings (`github.copilot.chat.otel.*`)
4. Defaults (lowest)

Kill switch: If `telemetry.telemetryLevel === 'off'`, returns a disabled config regardless.

Endpoint parsing: gRPC → origin only (`scheme://host:port`). HTTP → full href.

---

## Span Conventions

### Naming

Follow the OTel GenAI conventions:

| Operation | Span Name | Kind |
|---|---|---|
| Agent orchestration | `invoke_agent {agent_name}` | `INTERNAL` |
| LLM API call | `chat {model}` | `CLIENT` |
| Tool execution | `execute_tool {tool_name}` | `INTERNAL` |

### Attributes

Use the constants from `genAiAttributes.ts`:

```typescript
import { GenAiAttr, GenAiOperationName, CopilotChatAttr, StdAttr } from '../../platform/otel/common/index';

span.setAttributes({
  [GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
  [GenAiAttr.REQUEST_MODEL]: model,
  [GenAiAttr.USAGE_INPUT_TOKENS]: inputTokens,
  [StdAttr.ERROR_TYPE]: error.constructor.name,
});
```

### Error Handling

On error, set both status and `error.type`:

```typescript
span.setStatus(SpanStatusCode.ERROR, error.message);
span.setAttribute(StdAttr.ERROR_TYPE, error.constructor.name);
```

### Content Capture

Always gate content capture on `otel.config.captureContent`:

```typescript
if (this._otelService.config.captureContent) {
  span.setAttribute(GenAiAttr.INPUT_MESSAGES, JSON.stringify(messages));
}
```

---

## Adding Instrumentation to New Code

### Pattern: Wrapping an Operation with a Span

```typescript
class MyService {
  constructor(@IOTelService private readonly _otel: IOTelService) {}

  async doWork(): Promise<Result> {
    return this._otel.startActiveSpan(
      'execute_tool myTool',
      { kind: SpanKind.INTERNAL, attributes: { [GenAiAttr.TOOL_NAME]: 'myTool' } },
      async (span) => {
        try {
          const result = await this._actualWork();
          span.setStatus(SpanStatusCode.OK);
          return result;
        } catch (err) {
          span.setStatus(SpanStatusCode.ERROR, err instanceof Error ? err.message : String(err));
          span.setAttribute(StdAttr.ERROR_TYPE, err instanceof Error ? err.constructor.name : 'Error');
          throw err;
        }
      },
    );
  }
}
```

### Pattern: Recording Metrics

Use `GenAiMetrics` for standard metric recording:

```typescript
const metrics = new GenAiMetrics(this._otelService);
metrics.recordTokenUsage(1500, 'input', {
  operationName: GenAiOperationName.CHAT,
  providerName: GenAiProviderName.GITHUB,
  requestModel: 'gpt-4o',
});
metrics.recordToolCallCount('readFile', true);
metrics.recordTimeToFirstToken('gpt-4o', 0.45);
```

### Pattern: Emitting Events

```typescript
import { emitToolCallEvent, emitInferenceDetailsEvent } from '../../platform/otel/common/index';

emitToolCallEvent(this._otelService, 'readFile', 50, true);
emitInferenceDetailsEvent(this._otelService, { model: 'gpt-4o' }, { inputTokens: 1500 });
```

### Pattern: Cross-Boundary Trace Propagation

When spawning a subagent, store the current trace context and retrieve it in the child:

```typescript
// Parent: store context before spawning subagent
const traceContext = this._otelService.getActiveTraceContext();
if (traceContext) {
  this._otelService.storeTraceContext(`subagent:${requestId}`, traceContext);
}

// Child: retrieve and use as parent
const parentCtx = this._otelService.getStoredTraceContext(`subagent:${requestId}`);
return this._otelService.startActiveSpan('invoke_agent child', { parentTraceContext: parentCtx }, async (span) => {
  // child spans are now part of the same trace
});
```

---

## Buffering & Initialization

`NodeOTelService` buffers operations during async SDK initialization. Once init completes, the buffer is drained in order; on failure, it is discarded and all future calls become no-ops. `BufferedSpanHandle` captures span mutations during this window and replays them onto the real span once available.

---

## Exporters

Four exporter types are supported: OTLP/HTTP (default), OTLP/gRPC, Console (stdout), and File (JSON-lines). All OTel SDK packages are dynamically imported — none are loaded when OTel is disabled. `DiagnosticSpanExporter` wraps the span exporter to log the first successful export (confirms connectivity).

---

## GenAI Semantic Convention Reference

All attribute names follow [OTel GenAI Semantic Conventions](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/).

Constants are defined in `genAiAttributes.ts`:

- `GenAiAttr.*` — Standard `gen_ai.*` attribute keys
- `CopilotChatAttr.*` — Extension-specific `copilot_chat.*` keys
- `StdAttr.*` — Standard OTel keys (`error.type`, `server.address`, `server.port`)
- `GenAiOperationName.*` — Operation name values (`chat`, `invoke_agent`, `execute_tool`)
- `GenAiProviderName.*` — Provider values (`github`, `openai`, `anthropic`)

Message formatting helpers in `messageFormatters.ts` convert internal message types to the OTel JSON schema:

- `toInputMessages()` — CAPI messages → OTel input format
- `toOutputMessages()` — Model response choices → OTel output format
- `toSystemInstructions()` — System message → OTel system instruction format
- `toToolDefinitions()` — Tool schemas → OTel tool definition format

---

## Testing

Unit tests live alongside the source:

```
src/platform/otel/common/test/
├── genAiEvents.spec.ts
├── genAiMetrics.spec.ts
├── messageFormatters.spec.ts
├── noopOtelService.spec.ts
└── otelConfig.spec.ts

src/platform/otel/node/test/
├── fileExporters.spec.ts
└── traceContextPropagation.spec.ts
```

Run with: `npm test -- --grep "OTel"`
