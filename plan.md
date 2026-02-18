# Implementation Plan: OTel Instrumentation — E2E Demo

This plan implements [`spec.md`](spec.md). The goal is a **complete end-to-end demo pipeline**:

1. **Chat extension** emits OTel traces/metrics/logs natively (agent spans, LLM calls, tool calls)
2. **Eval runtime** emits OTel traces/metrics/events (eval run span, assertion results, patch metrics, environment snapshots)
3. Both send to **Azure App Insights + Managed Grafana** via OTLP env vars
4. **say_hello benchmark** (or full VSCBench) validates the pipeline end-to-end
5. All existing file outputs (**trajectory.json, eval.json, custom_metrics.json**, etc.) continue to be produced unchanged

---

## Implementation Order

```
Phase 0: Foundation (Chat ext)          ← DONE
Phase 1: Wire spans into chat ext code  ← Next
Phase 2: Eval repo OTel instrumentation
Phase 3: Azure backend + env config
Phase 4: Build VSIX + run say_hello E2E demo
```

Phases 1 and 2 can proceed in parallel. Phase 3 is config-only. Phase 4 validates everything.

---

## Phase 0 — Foundation (service scaffold + SDK bootstrap)

### 0.1 Add OTel dependencies

**File:** `package.json`

Add to `dependencies`:
```jsonc
"@opentelemetry/api": "^1.9.0",
"@opentelemetry/api-logs": "^0.57.0",
"@opentelemetry/sdk-trace-node": "^1.30.0",
"@opentelemetry/sdk-metrics": "^1.30.0",
"@opentelemetry/sdk-logs": "^0.57.0",
"@opentelemetry/resources": "^1.30.0",
"@opentelemetry/semantic-conventions": "^1.30.0",
"@opentelemetry/exporter-trace-otlp-http": "^0.57.0",
"@opentelemetry/exporter-logs-otlp-http": "^0.57.0",
"@opentelemetry/exporter-metrics-otlp-http": "^0.57.0",
"@opentelemetry/exporter-trace-otlp-grpc": "^0.57.0",
"@opentelemetry/exporter-logs-otlp-grpc": "^0.57.0",
"@opentelemetry/exporter-metrics-otlp-grpc": "^0.57.0"
```

**Verification:** `npm install` succeeds, `npm run compile` succeeds, bundle size increase < 200KB gzipped.

### 0.2 Create configuration types and resolver

**New file:** `src/platform/otel/common/otelConfig.ts`

```typescript
export interface OTelConfig {
  enabled: boolean;
  exporterType: 'otlp-grpc' | 'otlp-http' | 'console' | 'file';
  otlpEndpoint: string;
  captureContent: boolean;
  outfile?: string;
}

export function resolveOTelConfig(
  settings: Partial<OTelConfig>,
  env: Record<string, string | undefined>,
  vscodeTelemetryLevel: string,
): OTelConfig;
```

Logic:
1. Check VS Code `telemetry.telemetryLevel` — if `off`, force `enabled: false`.
2. Env vars override settings: `COPILOT_CHAT_OTEL_ENABLED` > setting, `OTEL_EXPORTER_OTLP_ENDPOINT` > setting.
3. Return frozen config object.

**Verification:** Unit test `src/platform/otel/common/otelConfig.test.ts` covering env override precedence, telemetry-level kill switch.

### 0.3 Create `IOTelService` interface and DI registration

**New file:** `src/platform/otel/common/otelService.ts`

```typescript
import { createServiceIdentifier } from '../../../util/common/services';
import type { Tracer, Meter } from '@opentelemetry/api';
import type { Logger } from '@opentelemetry/api-logs';

export const IOTelService = createServiceIdentifier<IOTelService>('IOTelService');

export interface IOTelService {
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly logger: Logger;
  readonly config: OTelConfig;

  /** Initialize the SDK. Called once during extension activation. */
  initialize(): Promise<void>;

  /** Gracefully shut down the SDK. Called during extension deactivation. */
  shutdown(): Promise<void>;

  /** Force flush all pending data. */
  flush(): Promise<void>;
}
```

**New file:** `src/platform/otel/node/otelServiceImpl.ts`

Implementation:
- Creates `NodeSDK`-equivalent setup with `BatchSpanProcessor`, `BatchLogRecordProcessor`, `PeriodicExportingMetricReader`.
- Exporter selection based on `OTelConfig.exporterType` (supports `otlp-http`, `otlp-grpc`, `console`, `file`).
- gRPC exporters use GZIP compression.
- Resource attributes: `service.name=copilot-chat`, `service.version`, `session.id`.
- If `enabled: false`, all providers are `NoopTracerProvider`, `NoopMeterProvider`, `NoopLoggerProvider` — zero overhead.
- **Buffer + flush:** Telemetry events are buffered via `bufferTelemetryEvent()` until SDK is initialized. Explicit `flush()` and `shutdown()` methods ensure all pending data is exported before process exit (adopted from Gemini CLI).
- **File exporter fallback:** When `COPILOT_OTEL_FILE_EXPORTER_PATH` is set, `FileSpanExporter`, `FileLogExporter`, and `FileMetricExporter` append JSON-lines to a local file for CI/offline debugging.
- **Env precedence:** `COPILOT_OTEL_*` env vars > `OTEL_EXPORTER_OTLP_*` standard env vars > VS Code settings > defaults. Endpoint parsing uses origin for gRPC (strip path) and full href for HTTP.

**New file:** `src/platform/otel/common/nullOtelService.ts`

No-op implementation for tests and web extension.

**Registration:** Wire into `IInstantiationService` during extension activation (in `src/extension/extension/vscode/extension.ts` or equivalent contribution).

**Verification:** Integration test — activate extension with `otel.enabled: true` + `console` exporter, verify spans appear in stdout.

### 0.4 Create semantic convention constants

**New file:** `src/platform/otel/common/genAiAttributes.ts`

```typescript
// gen_ai.operation.name values
export const GenAiOperationName = {
  CHAT: 'chat',
  INVOKE_AGENT: 'invoke_agent',
  EXECUTE_TOOL: 'execute_tool',
  EMBEDDINGS: 'embeddings',
} as const;

// gen_ai.provider.name values
export const GenAiProviderName = {
  OPENAI: 'openai',
} as const;

// gen_ai.token.type values
export const GenAiTokenType = {
  INPUT: 'input',
  OUTPUT: 'output',
} as const;

// gen_ai.tool.type values
export const GenAiToolType = {
  FUNCTION: 'function',
  EXTENSION: 'extension',
} as const;

// Attribute key constants (avoids typo bugs)
export const GenAiAttr = {
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  CONVERSATION_ID: 'gen_ai.conversation.id',
  RESPONSE_ID: 'gen_ai.response.id',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  REQUEST_TOP_P: 'gen_ai.request.top_p',
  TOKEN_TYPE: 'gen_ai.token.type',
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_TYPE: 'gen_ai.tool.type',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  TOOL_DESCRIPTION: 'gen_ai.tool.description',
  TOOL_CALL_ARGUMENTS: 'gen_ai.tool.call.arguments',
  TOOL_CALL_RESULT: 'gen_ai.tool.call.result',
  AGENT_NAME: 'gen_ai.agent.name',
  AGENT_ID: 'gen_ai.agent.id',
  INPUT_MESSAGES: 'gen_ai.input.messages',
  OUTPUT_MESSAGES: 'gen_ai.output.messages',
  SYSTEM_INSTRUCTIONS: 'gen_ai.system_instructions',
  TOOL_DEFINITIONS: 'gen_ai.tool.definitions',
  OUTPUT_TYPE: 'gen_ai.output.type',
} as const;
```

**Verification:** Compile check — consumers import constants, typos caught at build time.

---

## Phase 1 — Traces (Inference + Tool spans)

### 1.1 Instrument LLM inference calls

**Files to modify:**
- `src/platform/endpoint/node/chatEndpoint.ts` (or wherever `IChatMLFetcher.fetchOne/fetchMany` is invoked)
- `src/platform/chat/common/chatMLFetcher.ts`

**Approach:**

Wrap the chat completion call in an inference span:

```typescript
// Pseudocode for the instrumentation point
async function fetchWithOTel(request, config, otelService) {
  const span = otelService.tracer.startSpan(`chat ${request.model}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      [GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
      [GenAiAttr.PROVIDER_NAME]: GenAiProviderName.OPENAI,
      [GenAiAttr.REQUEST_MODEL]: request.model,
      [GenAiAttr.CONVERSATION_ID]: request.sessionId,
      [GenAiAttr.REQUEST_TEMPERATURE]: request.temperature,
      [GenAiAttr.REQUEST_MAX_TOKENS]: request.maxTokens,
      'server.address': endpointHost,
      'server.port': endpointPort,
    },
  });

  try {
    const response = await originalFetch(request);

    span.setAttributes({
      [GenAiAttr.RESPONSE_MODEL]: response.model,
      [GenAiAttr.RESPONSE_ID]: response.id,
      [GenAiAttr.RESPONSE_FINISH_REASONS]: response.finishReasons,
      [GenAiAttr.USAGE_INPUT_TOKENS]: response.usage?.promptTokens,
      [GenAiAttr.USAGE_OUTPUT_TOKENS]: response.usage?.completionTokens,
    });

    if (otelService.config.captureContent) {
      // Full content, no truncation (D7)
      span.setAttribute(GenAiAttr.INPUT_MESSAGES, JSON.stringify(toInputMessages(request.messages)));
      span.setAttribute(GenAiAttr.OUTPUT_MESSAGES, JSON.stringify(toOutputMessages(response.choices)));
      span.setAttribute(GenAiAttr.SYSTEM_INSTRUCTIONS, JSON.stringify(toSystemInstructions(request.systemMessage)));
    }

    span.setStatus({ code: SpanStatusCode.OK });
    return response;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.setAttribute('error.type', error.constructor?.name ?? 'Error');
    span.recordException(error);
    throw error;
  } finally {
    span.end();
  }
}
```

**Message format helpers:**

**New file:** `src/platform/otel/common/messageFormatters.ts`

Converters from internal message types to the OTel GenAI JSON schema:
- `toInputMessages(messages)` → `[{ role, parts: [{ type: "text", content }] }]`
- `toOutputMessages(choices)` → `[{ role: "assistant", parts: [...], finish_reason }]`
- `toSystemInstructions(systemMsg)` → `[{ type: "text", content }]`
- `toToolDefinitions(tools)` → `[{ type: "function", name, description, parameters }]`

**Verification:**
- Unit test: mock tracer, assert span attributes match spec for success and error paths.
- Integration test: send a chat request with console exporter, inspect span JSON for all required/recommended attributes.

### 1.2 Instrument tool invocations

**File to modify:** `src/extension/tools/vscode-node/toolsService.ts` (`ToolsService.invokeTool`)

**Approach:**

Wrap `vscode.lm.invokeTool()` in an `execute_tool` span:

```typescript
async invokeTool(name, options, token) {
  const span = this.otelService.tracer.startSpan(`execute_tool ${name}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      [GenAiAttr.OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
      [GenAiAttr.TOOL_NAME]: name,
      [GenAiAttr.TOOL_TYPE]: isMcpTool ? GenAiToolType.EXTENSION : GenAiToolType.FUNCTION,
      [GenAiAttr.TOOL_CALL_ID]: options.toolCallId,
    },
  });

  try {
    const result = await vscode.lm.invokeTool(getContributedToolName(name), options, token);
    span.setStatus({ code: SpanStatusCode.OK });
    // Full content, no truncation (D7)
    if (this.otelService.config.captureContent) {
      span.setAttribute(GenAiAttr.TOOL_CALL_ARGUMENTS, JSON.stringify(options.arguments));
      span.setAttribute(GenAiAttr.TOOL_CALL_RESULT, JSON.stringify(result));
    }
    return result;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.setAttribute('error.type', error.constructor?.name ?? '_OTHER');
    span.recordException(error);
    throw error;
  } finally {
    span.end();
  }
}
```

**Verification:** Unit test with mock tracer, verify span name, attributes, error recording.

### 1.3 Instrument agent invocations

**File to modify:** Agent mode orchestration code (likely in `src/extension/conversation/` or agent handler).

Create a parent `invoke_agent` span that becomes the active context, so inference and tool spans are children:

```typescript
async function runAgentMode(participantId, sessionId, otelService) {
  return otelService.tracer.startActiveSpan(
    `invoke_agent ${participantId}`,
    { kind: SpanKind.INTERNAL, attributes: {
      [GenAiAttr.OPERATION_NAME]: GenAiOperationName.INVOKE_AGENT,
      [GenAiAttr.PROVIDER_NAME]: GenAiProviderName.OPENAI,
      [GenAiAttr.AGENT_NAME]: participantId,
      [GenAiAttr.CONVERSATION_ID]: sessionId,
    }},
    async (span) => {
      try {
        const result = await executeAgentLoop(/* ... */);
        span.setAttributes({
          [GenAiAttr.USAGE_INPUT_TOKENS]: result.totalInputTokens,
          [GenAiAttr.USAGE_OUTPUT_TOKENS]: result.totalOutputTokens,
          [GenAiAttr.RESPONSE_FINISH_REASONS]: [result.finishReason],
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute('error.type', error.constructor?.name ?? '_OTHER');
        throw error;
      } finally {
        span.end();
      }
    }
  );
}
```

**Verification:** Integration test — run multi-turn agent interaction, verify parent-child span hierarchy.

---

## Phase 2 — Metrics

### 2.1 Initialize metric instruments

**New file:** `src/platform/otel/common/genAiMetrics.ts`

```typescript
export class GenAiMetrics {
  readonly operationDuration: Histogram;
  readonly tokenUsage: Histogram;
  readonly toolCallCount: Counter;
  readonly toolCallDuration: Histogram;
  readonly agentDuration: Histogram;
  readonly agentTurnCount: Histogram;
  readonly sessionCount: Counter;
  readonly timeToFirstToken: Histogram;

  constructor(meter: Meter) {
    this.operationDuration = meter.createHistogram('gen_ai.client.operation.duration', {
      description: 'GenAI operation duration.',
      unit: 's',
      advice: {
        explicitBucketBoundaries: [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92],
      },
    });

    this.tokenUsage = meter.createHistogram('gen_ai.client.token.usage', {
      description: 'Number of input and output tokens used.',
      unit: '{token}',
      advice: {
        explicitBucketBoundaries: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864],
      },
    });

    this.toolCallCount = meter.createCounter('copilot_chat.tool.call.count', {
      description: 'Tool invocations, by tool name and success.',
      unit: '{call}',
    });

    this.toolCallDuration = meter.createHistogram('copilot_chat.tool.call.duration', {
      description: 'Tool execution latency.',
      unit: 'ms',
    });

    this.agentDuration = meter.createHistogram('copilot_chat.agent.invocation.duration', {
      description: 'Agent mode end-to-end duration.',
      unit: 's',
    });

    this.agentTurnCount = meter.createHistogram('copilot_chat.agent.turn.count', {
      description: 'Number of LLM round-trips per agent invocation.',
      unit: '{turn}',
    });

    this.sessionCount = meter.createCounter('copilot_chat.session.count', {
      description: 'Chat sessions started.',
      unit: '{session}',
    });

    this.timeToFirstToken = meter.createHistogram('copilot_chat.time_to_first_token', {
      description: 'Time from request sent to first SSE token received.',
      unit: 's',
    });
  }
}
```

### 2.2 Record metrics at instrumentation points

At each span end, also record the corresponding metric:

```typescript
// After inference span ends:
genAiMetrics.operationDuration.record(durationSec, {
  [GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
  [GenAiAttr.PROVIDER_NAME]: GenAiProviderName.OPENAI,
  [GenAiAttr.REQUEST_MODEL]: request.model,
  [GenAiAttr.RESPONSE_MODEL]: response.model,
  'server.address': host,
  ...(errorType ? { 'error.type': errorType } : {}),
});

genAiMetrics.tokenUsage.record(inputTokens, {
  [GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
  [GenAiAttr.PROVIDER_NAME]: GenAiProviderName.OPENAI,
  [GenAiAttr.TOKEN_TYPE]: GenAiTokenType.INPUT,
  [GenAiAttr.REQUEST_MODEL]: request.model,
});

genAiMetrics.tokenUsage.record(outputTokens, {
  [GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
  [GenAiAttr.PROVIDER_NAME]: GenAiProviderName.OPENAI,
  [GenAiAttr.TOKEN_TYPE]: GenAiTokenType.OUTPUT,
  [GenAiAttr.REQUEST_MODEL]: request.model,
});
```

**Verification:** Unit test — mock meter, verify `record()` called with correct attribute sets and values.

---

## Phase 3 — Events (Logs)

### 3.1 Emit `gen_ai.client.inference.operation.details` event

**New file:** `src/platform/otel/common/genAiEvents.ts`

```typescript
export function emitInferenceDetailsEvent(
  logger: Logger,
  config: OTelConfig,
  request: { model, messages, systemMessage, tools, config },
  response: { id, model, choices, usage, finishReasons },
  error?: { type: string, message: string },
): void {
  const attributes: LogAttributes = {
    'event.name': 'gen_ai.client.inference.operation.details',
    [GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
    [GenAiAttr.REQUEST_MODEL]: request.model,
    [GenAiAttr.RESPONSE_MODEL]: response?.model,
    [GenAiAttr.RESPONSE_ID]: response?.id,
    [GenAiAttr.RESPONSE_FINISH_REASONS]: response?.finishReasons,
    [GenAiAttr.USAGE_INPUT_TOKENS]: response?.usage?.promptTokens,
    [GenAiAttr.USAGE_OUTPUT_TOKENS]: response?.usage?.completionTokens,
    [GenAiAttr.REQUEST_TEMPERATURE]: request.config?.temperature,
    [GenAiAttr.REQUEST_MAX_TOKENS]: request.config?.maxTokens,
  };

  if (error) {
    attributes['error.type'] = error.type;
  }

  // Full content, no truncation (D7)
  if (config.captureContent) {
    attributes[GenAiAttr.INPUT_MESSAGES] = JSON.stringify(toInputMessages(request.messages));
    attributes[GenAiAttr.OUTPUT_MESSAGES] = JSON.stringify(toOutputMessages(response?.choices));
    attributes[GenAiAttr.SYSTEM_INSTRUCTIONS] = JSON.stringify(toSystemInstructions(request.systemMessage));
    attributes[GenAiAttr.TOOL_DEFINITIONS] = JSON.stringify(toToolDefinitions(request.tools));
  }

  logger.emit({
    body: `GenAI operation details for ${request.model}.`,
    attributes,
  });
}
```

**Where called:** Same instrumentation point as the inference span (Phase 1.1), after the span attributes are set but before `span.end()`.

### 3.2 Extension-specific log events

| Event | Where emitted |
|---|---|
| `copilot_chat.session.start` | `ChatParticipantRequestHandler` constructor / first request |
| `copilot_chat.session.end` | Session disposal |
| `copilot_chat.tool.call` | `ToolsService.invokeTool` completion |
| `copilot_chat.agent.turn` | After each LLM round-trip in agent loop |

Each follows the same `logger.emit({ body, attributes })` pattern with extension-specific attributes.

**Verification:** Unit tests for each event emitter. Integration test with console exporter verifying JSON output.

---

## Phase 4 — Embeddings Span

### 4.1 Instrument embedding calls

**File to modify:** Wherever `workspaceSemanticSearch` or embedding generation calls happen.

Wrap in a span:

```typescript
const span = otelService.tracer.startSpan(`embeddings ${embeddingModel}`, {
  kind: SpanKind.CLIENT,
  attributes: {
    [GenAiAttr.OPERATION_NAME]: GenAiOperationName.EMBEDDINGS,
    [GenAiAttr.PROVIDER_NAME]: GenAiProviderName.OPENAI,
    [GenAiAttr.REQUEST_MODEL]: embeddingModel,
    'server.address': host,
  },
});
// ... call, set usage.input_tokens, end span
```

**Verification:** Unit test.

---

## Phase 5 — Configuration UI + Contribution

### 5.1 Register settings in `package.json`

Add to `contributes.configuration`:

```jsonc
{
  "copilotChat.telemetry.otel.enabled": {
    "type": "boolean",
    "default": false,
    "description": "Enable OpenTelemetry trace/metric/log emission for Copilot Chat operations."
  },
  "copilotChat.telemetry.otel.exporterType": {
    "type": "string",
    "enum": ["otlp-grpc", "otlp-http", "console", "file"],
    "default": "otlp-http",
    "description": "OTel exporter type."
  },
  "copilotChat.telemetry.otel.otlpEndpoint": {
    "type": "string",
    "default": "http://localhost:4318",
    "description": "OTLP collector endpoint URL."
  },
  "copilotChat.telemetry.otel.captureContent": {
    "type": "boolean",
    "default": false,
    "description": "Capture input/output messages, system instructions, and tool definitions in telemetry (contains PII)."
  },
  "copilotChat.telemetry.otel.outfile": {
    "type": "string",
    "default": "",
    "description": "File path for file-based exporter output."
  }
}
```

### 5.2 Create OTel lifecycle contribution

**New file:** `src/extension/otel/otelContrib.ts`

An `IExtensionContribution` that:
1. Reads settings via `IConfigurationService`.
2. Calls `IOTelService.initialize()` on activation.
3. Calls `IOTelService.shutdown()` on deactivation.
4. Listens for configuration changes and logs a warning that restart is required.

**Verification:** Activate extension, change setting, verify warning notification.

---

## Phase 6 — File Exporters

### 6.1 Implement file exporters

**New file:** `src/platform/otel/node/fileExporters.ts`

Port from gemini-cli pattern — `FileSpanExporter`, `FileLogExporter`, `FileMetricExporter` that append JSON-lines to a file:

```typescript
export class FileSpanExporter implements SpanExporter {
  private writeStream: fs.WriteStream;
  constructor(filePath: string) { this.writeStream = fs.createWriteStream(filePath, { flags: 'a' }); }
  export(spans: ReadableSpan[], cb: (result: ExportResult) => void): void {
    const data = spans.map(s => JSON.stringify(s) + '\n').join('');
    this.writeStream.write(data, err => cb({ code: err ? ExportResultCode.FAILED : ExportResultCode.SUCCESS }));
  }
  shutdown(): Promise<void> { return new Promise(r => this.writeStream.end(r)); }
}
// Similar for FileLogExporter, FileMetricExporter
```

**Verification:** Unit test — write spans to temp file, read back and verify JSON structure.

---

## Phase 7 — Testing & Validation

### 7.1 Unit tests

| Test file | Covers |
|---|---|
| `src/platform/otel/common/otelConfig.test.ts` | Config resolution, env var precedence, telemetry level kill switch |
| `src/platform/otel/common/genAiAttributes.test.ts` | Constant correctness (compile-time check mostly) |
| `src/platform/otel/common/messageFormatters.test.ts` | Input/output/system message conversion to OTel schema |
| `src/platform/otel/common/genAiMetrics.test.ts` | Metric recording with correct attributes |
| `src/platform/otel/common/genAiEvents.test.ts` | Event emission with and without content capture |
| `src/platform/otel/node/fileExporters.test.ts` | File write/read round-trip |
| `src/platform/otel/node/otelServiceImpl.test.ts` | SDK initialization, shutdown, no-op when disabled |

### 7.2 Integration tests

| Test | Scenario |
|---|---|
| Inference span e2e | Send chat request → verify span in console exporter output |
| Tool span e2e | Trigger tool call → verify span name, attributes |
| Agent span hierarchy | Run agent mode → verify parent invoke_agent, child chat + tool spans |
| Metrics collection | After chat request → verify `gen_ai.client.token.usage` and `gen_ai.client.operation.duration` recorded |
| Content capture off | Default config → verify `gen_ai.input.messages` NOT in span attributes |
| Content capture on | Set `captureContent: true` → verify messages present |
| Kill switch | Set `telemetry.telemetryLevel: off` → verify zero spans emitted |

### 7.3 Validation against OTel spec

Automated check: Parse exported spans/metrics/events and validate attribute names and types against the GenAI semconv registry.

---

## Dependency Graph (Updated for E2E Demo)

```
Phase 0 (Foundation — Chat ext)         ← DONE
  ├── 0.1 Dependencies
  ├── 0.2 Config
  ├── 0.3 IOTelService + impl
  └── 0.4 Constants
         │
    ┌────┴────────────────────────────┐
    ▼                                 ▼
Phase 1 (Chat ext wiring)      Phase 2 (Eval repo OTel)
  ├── 1.1 DI registration        ├── E1. Add OTel deps
  ├── 1.2 Inference span          ├── E2. OTel SDK init
  ├── 1.3 Tool span               ├── E3. eval.run root span
  ├── 1.4 Agent span              ├── E4. gen_ai.evaluation.result events
  ├── 1.5 Metrics recording       ├── E5. Patch/timing metrics
  └── 1.6 Events + log bridge     └── E6. Environment events
         │                                 │
         └────────────┬───────────────────┘
                      ▼
              Phase 3 (Azure backend config)
                ├── A1. Azure App Insights connection string
                ├── A2. Managed Grafana dashboard
                └── A3. Docker env var wiring
                      │
                      ▼
              Phase 4 (E2E Demo)
                ├── D1. Build chat ext VSIX
                ├── D2. Run say_hello benchmark
                ├── D3. Verify traces in App Insights
                ├── D4. Verify metrics in Grafana
                └── D5. Run full VSCBench set (optional)
```

---

## Phase 2 — Eval Repo OTel Instrumentation

> **Repo:** `vscode-copilot-evaluation`
> **Principle:** Dual-write. All existing file outputs unchanged. OTel is additive.

### E1. Add OTel dependencies to eval repo

**File:** `vscode-copilot-evaluation/package.json`

```jsonc
"@opentelemetry/api": "^1.9.0",
"@opentelemetry/api-logs": "^0.57.0",
"@opentelemetry/sdk-trace-node": "^1.30.0",
"@opentelemetry/sdk-metrics": "^1.30.0",
"@opentelemetry/sdk-logs": "^0.57.0",
"@opentelemetry/resources": "^1.30.0",
"@opentelemetry/semantic-conventions": "^1.30.0",
"@opentelemetry/exporter-trace-otlp-http": "^0.57.0",
"@opentelemetry/exporter-logs-otlp-http": "^0.57.0",
"@opentelemetry/exporter-metrics-otlp-http": "^0.57.0"
```

### E2. OTel SDK initialization

**New file:** `vscode-copilot-evaluation/src/otel/evalOtelService.ts`

- Init `NodeTracerProvider`, `MeterProvider`, `LoggerProvider` with OTLP HTTP exporters
- Resource attributes from env: `service.name=copilot-eval`, `benchmark.id`, `benchmark.name`, model info
- **Also include** `os.type`, `os.version`, `host.arch` (from Claude Code learnings)
- Respect `OTEL_METRIC_EXPORT_INTERVAL` and `OTEL_LOGS_EXPORT_INTERVAL` for tunable export intervals
- Respect `OTEL_EXPORTER_OTLP_HEADERS` for Azure auth
- Respect `OTEL_METRICS_INCLUDE_SESSION_ID` / `OTEL_METRICS_INCLUDE_VERSION` cardinality controls
- Gated by `OTEL_EXPORTER_OTLP_ENDPOINT` env var (no-op when unset)
- Maintain an `event.sequence` counter (monotonic, per-session) for all emitted events
- Flush before process exit
- Call `initEvalOTel()` at top of `VSCodeApplication.launch()` before any work

### E3. Root span: `eval.run {benchmark_name}`

**File:** `vscode-copilot-evaluation/src/vsCodeApplication.ts`

Wrap `launch()` in a root span:
```typescript
const span = tracer.startSpan(`eval.run ${benchmarkName}`, { kind: SpanKind.INTERNAL });
try {
  // ... existing launch() body ...
  span.setAttributes({
    'eval.resolved': evalResult.resolved,
    'eval.assertion_count': totalAssertions,
    'eval.assertions_passed': passedAssertions,
  });
  span.setStatus({ code: SpanStatusCode.OK });
} catch (error) {
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.recordException(error);
  // Emit eval.error event
  logger.emit({ body: 'eval.error', attributes: { ... } });
  throw error;
} finally {
  span.end();
  await otelService.flush();
}
```

### E4. Assertion results as `gen_ai.evaluation.result` events

**File:** `vscode-copilot-evaluation/src/sqliteAssertionDatabase.ts` (or wrapper)

After each assertion executes:
```typescript
logger.emit({
  body: `gen_ai.evaluation.result`,
  attributes: {
    'event.name': 'gen_ai.evaluation.result',
    'event.sequence': eventSequence++,  // monotonic counter (D12)
    'gen_ai.evaluation.name': assertion.comment || `assertion_${index}`,
    'gen_ai.evaluation.score.value': passed ? 1.0 : 0.0,
    'gen_ai.evaluation.score.label': passed ? 'pass' : 'fail',
    'gen_ai.evaluation.explanation': `${assertion.comment}\nQuery: ${assertion.query}${error ? '\nError: ' + error : ''}`,
    ...(responseId ? { 'gen_ai.response.id': responseId } : {}),
    ...(assertionError ? { 'error.type': 'assertion_error' } : {}),
  },
});
```

### E5. Patch and timing metrics

**File:** `vscode-copilot-evaluation/src/customMetrics.ts` (add OTel recording alongside file write)

After `customMetrics.export()`, also record:
```typescript
meter.createHistogram('eval.patch.size_bytes').record(patchSizeBytes, resourceAttrs);
meter.createHistogram('eval.patch.lines_changed').record(linesChanged, resourceAttrs);
meter.createHistogram('eval.patch.files_changed').record(filesChanged, resourceAttrs);
meter.createHistogram('eval.run.duration').record(elapsedSec, resourceAttrs);
```

### E6. Environment and config events

**File:** `vscode-copilot-evaluation/src/vsCodeApplication.ts`

At run start, emit environment snapshots:
```typescript
// After VS Code launches and version/extensions info is collected
logger.emit({ body: 'eval.environment.extensions', attributes: { 'event.name': 'eval.environment.extensions', extensions: JSON.stringify(extensionsInfo) } });
logger.emit({ body: 'eval.environment.settings', attributes: { 'event.name': 'eval.environment.settings', settings: JSON.stringify(settingsInfo) } });
logger.emit({ body: 'eval.config', attributes: { 'event.name': 'eval.config', config: JSON.stringify(benchmarkConfig) } });

// At run end
logger.emit({ body: 'eval.patch.diff', attributes: { 'event.name': 'eval.patch.diff', diff: patchDiffContent } });
```

---

## Phase 3 — Azure Backend Configuration

### A1. Azure App Insights as OTLP endpoint

Azure Monitor supports OTLP natively. Set connection string via env:

```yaml
# In Docker env / benchmark config
OTEL_EXPORTER_OTLP_ENDPOINT: "https://<region>.applicationinsights.azure.com/v1/track"
OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf"
APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=<key>;IngestionEndpoint=https://<region>.in.applicationinsights.azure.com/"
```

Alternative: Use Azure Monitor OpenTelemetry Exporter:
```jsonc
// Add to both repos if Azure-native export preferred
"@azure/monitor-opentelemetry-exporter": "^1.0.0-beta.27"
```

### A2. Managed Grafana dashboard

- Connect Azure Managed Grafana to App Insights data source
- Pre-built dashboard panels:
  - **Trace waterfall**: `eval.run` → `invoke_agent` → `chat` → `execute_tool` hierarchy
  - **Token usage**: `gen_ai.client.token.usage` histogram by model
  - **Operation latency**: `gen_ai.client.operation.duration` p50/p95/p99
  - **Eval results**: `gen_ai.evaluation.result` events pass/fail rates
  - **Patch metrics**: `eval.patch.*` across runs

### A3. Docker env var wiring

**File:** `vscode-copilot-evaluation/scripts/run-agent.sh`

Add OTel env vars before launching VS Code:
```bash
# OTel config — forwarded to both chat extension and eval runtime
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-}"
export OTEL_EXPORTER_OTLP_PROTOCOL="${OTEL_EXPORTER_OTLP_PROTOCOL:-http/protobuf}"
export COPILOT_OTEL_CAPTURE_CONTENT="${COPILOT_OTEL_CAPTURE_CONTENT:-true}"
export COPILOT_OTEL_LOG_LEVEL="${COPILOT_OTEL_LOG_LEVEL:-info}"
export OTEL_RESOURCE_ATTRIBUTES="benchmark.id=${INSTANCE_ID:-unknown},benchmark.name=$(basename ${AGENT_BENCHMARK_CONFIG_PATH:-unknown} .yaml)"
```

---

## Phase 4 — E2E Demo Validation

### D1. Build chat extension VSIX

```bash
cd vscode-copilot-chat
npm run compile
# Package as VSIX (or use the existing build pipeline)
```

### D2. Run say_hello benchmark locally

```bash
cd vscode-copilot-evaluation

# Set OTel endpoint (local Jaeger for quick test, or Azure App Insights)
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export COPILOT_OTEL_CAPTURE_CONTENT="true"
export OTEL_RESOURCE_ATTRIBUTES="benchmark.id=local-test,benchmark.name=say_hello"

# Run the benchmark
npx vsc-eval agent \
  --config-path benchmarks/external/say_hello/agent.benchmark.config.vscode.agent.yaml
```

### D3. Verify traces

- Open Jaeger UI (or Azure App Insights → Transaction Search)
- Find `eval.run say_hello` root span
- Verify child spans: `invoke_agent copilot-chat` → `chat gpt-*` → `execute_tool *`
- Check `gen_ai.evaluation.result` events on the eval span

### D4. Verify metrics

- Open Grafana (or App Insights → Metrics)
- Check `gen_ai.client.token.usage`, `gen_ai.client.operation.duration`
- Check `eval.patch.lines_changed`, `eval.assertion.count`

### D5. Optional: full VSCBench run

```bash
# Run full benchmark set via MSBench/Docker
# OTel env vars propagated through Docker compose
python benchmarks/dataset_create.py
# ... trigger MSBench run with OTel env vars in config
```

---

## Rollout Strategy

1. **E2E Demo** (today) — Local Jaeger or Azure App Insights with say_hello benchmark
2. **Internal dogfooding** — Enable for eval team with Azure backend
3. **Insiders ring** — Chat ext OTel for VS Code Insiders users
4. **GA** — Document setup guide, keep default off

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Bundle size bloat from OTel packages | Tree-shake, measure in CI, set 200KB budget |
| Performance regression from span creation | No-op providers when disabled; batch processors for async export |
| Breaking existing telemetry | OTel is additive; zero changes to `ITelemetryService` code paths |
| Breaking existing file outputs | Dual-write: all files still produced unchanged |
| PII leakage via content capture | Off by default; requires explicit user opt-in; respects VS Code telemetry level |
| OTel semconv breaking changes | Pin `@opentelemetry/semantic-conventions` version; support `OTEL_SEMCONV_STABILITY_OPT_IN` env var |
| Azure OTLP compatibility | Test with local Jaeger first; Azure Monitor OTLP is GA |
