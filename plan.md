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
Phase 1: Wire spans into chat ext code  ← DONE
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

---

## Next Fixes — Span Hierarchy & Context Propagation

### Fix 1: BYOK chat spans appearing as separate traces (INVESTIGATED — likely false alarm)

**Observed:** When using BYOK endpoints, `chat` spans appeared separate from `invoke_agent`.

**Investigation findings (2026-02-26):**

Traced the full call chain for both CAPI and BYOK paths:

- **CAPI path:** `invoke_agent` `startActiveSpan` → `_runLoop` → `runOne` → `DefaultToolCallingLoop.fetch()` → `ChatEndpoint._makeChatRequest2()` → `_chatMLFetcher.fetchOne()` → `fetchMany()` → `_doFetchAndStreamChat()` → `startSpan("chat ...")`. Every step is a clean `await` — no async context breaks.

- **BYOK path:** `invoke_agent` `startActiveSpan` → `_runLoop` → `runOne` → `DefaultToolCallingLoop.fetch()` → `ExtensionContributedChatEndpoint.makeChatRequest2()` → `startSpan("chat ...")`. Also a clean `await` chain in the same process.

- **IPC crossings exist** in both paths (`vscode.lm.invokeTool` and `languageModel.sendRequest` each cross ExtHost→MainThread→ProviderExtHost), BUT these happen **after** both spans are already created in the same ext host process. `AsyncLocalStorage` is lost across IPC, but that doesn't affect span parenting since `startSpan()` captures the active context at creation time.

- **Conclusion:** `chat` spans created inside the `invoke_agent` callback WILL automatically be children of `invoke_agent`. The separate traces observed were likely from **non-agent chat requests** (title generation, progress messages, inline chat, subagent) that run outside any `invoke_agent` scope.

**Status:** No code fix needed. Monitor in next test session to confirm.

### Fix 2: Subagent `invoke_agent` span not linked to parent agent span

**Problem:** When `runSubagent` tool is invoked, it creates a new `invoke_agent` span for the subagent. This subagent span appears as a separate trace root (e.g., 12 spans for main agent, 6 spans for subagent) rather than being a child of the parent agent's `execute_tool runSubagent` span.

**Root cause:** The subagent receives a new `ChatRequest` from VS Code, which triggers a new chat participant handler. This new handler call is dispatched by VS Code as a separate async invocation — it does NOT run inside the parent agent's `startActiveSpan` callback. The `execute_tool runSubagent` span is in the parent agent's process, but the subagent's `invoke_agent` span is created in a fresh async context (new VS Code chat request).

Specifically, the VS Code `lm.invokeTool("runSubagent", ...)` crosses IPC (ExtHost → MainThread → ExtHost), and the subagent's chat request is dispatched as a new `ChatRequestHandler` invocation. Even if both run in the same Node.js process, the IPC round-trip + new request dispatch loses `AsyncLocalStorage` context.

**Fix approach (Option 1 — parent-child propagation):**
1. When `execute_tool runSubagent` is invoked, capture the current trace context (traceId + spanId) and pass it as metadata in the subagent invocation options.
2. In the subagent's `ToolCallingLoop.run()`, check for this parent context and create the `invoke_agent` span with an explicit parent, forming one connected trace.
3. This requires adding an optional `parentSpanContext` field to `SpanOptions` and updating `IOTelService.startActiveSpan` to accept it.

**Implementation sketch:**
```typescript
// In execute_tool for runSubagent — capture context
const traceContext = otelService.getActiveSpanContext(); // { traceId, spanId }
// Pass via subagent invocation metadata

// In subagent's ToolCallingLoop.run() — restore context
const parentContext = this.options.request.parentTraceContext;
this._otelService.startActiveSpan(`invoke_agent ${agentName}`, {
    kind: SpanKind.INTERNAL,
    parentContext, // links to parent trace
    attributes: { ... },
}, async (span) => { ... });
```

---

## Known Gaps — Upstream / API Limitations

These gaps cannot be fixed in Copilot Chat alone. They require changes in VS Code core or the BYOK provider extensions.

### Gap 1: BYOK chat spans report `gen_ai.usage.input_tokens=0` and `gen_ai.usage.output_tokens=0`

**Affected spans:** All `chat` spans from `ExtensionContributedChatEndpoint` (BYOK models like Claude, Gemini via extension-contributed endpoints).

**Root cause:** The VS Code `LanguageModelChat` API (`vscode.lm`) does not expose token usage from BYOK providers. `ExtensionContributedChatEndpoint` hardcodes `usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }` because the streaming `response.stream` does not include usage data.

**Cascading effect:** `invoke_agent` spans also show `input_tokens=0` and `output_tokens=0` for BYOK sessions, because the token accumulation listener relies on `response.usage.prompt_tokens`.

**Fix suggestion (VS Code core):**
- Add a `usage` property to `LanguageModelChatResponse` that providers can populate after streaming completes.
- Alternatively, allow providers to emit usage data via a `LanguageModelUsagePart` in the stream.
- File: `src/vscode-dts/vscode.d.ts` — `LanguageModelChatResponse` interface.
- BYOK providers (Anthropic SDK, Gemini) already receive usage data in their API responses but have no way to surface it through the VS Code LM API.

### Gap 2: First programmatic tool call has empty `gen_ai.tool.call.id`

**Affected spans:** `execute_tool` spans for tools invoked programmatically (e.g., `manage_todo_list` called from code, not from model output).

**Root cause:** Programmatic tool calls don't have a `chatStreamToolCallId` because they weren't requested by the model — there's no tool call ID from an LLM response.

**Status:** Expected behavior. Per OTel spec, `gen_ai.tool.call.id` is "Recommended if available". Empty string is acceptable for non-model-triggered tool calls.

### Gap 3: `execute_tool` spans missing `gen_ai.provider.name`

**Affected spans:** All `execute_tool` spans.

**Root cause:** The OTel GenAI spec for `execute_tool` spans does not include `gen_ai.provider.name` as an attribute — it's not part of the execute_tool semantic convention. Tool execution is provider-agnostic.

**Status:** By design. Not a gap.

### Gap 4: Duplicate orphan `chat` spans from `CopilotLanguageModelWrapper` (BYOK provider path)

**Affected traces:** When using Azure BYOK (or any model routed through `CopilotLanguageModelWrapper`), each agent LLM call produces **two** `chat` spans — one from the consumer side (`extChatEndpoint.ts`) nested under `invoke_agent`, and one from the provider side (`chatMLFetcher.ts` via `CopilotLanguageModelWrapper`) as a standalone orphan trace.

**Root cause:** The BYOK flow has two IPC hops:
1. `extChatEndpoint` → `vscode.lm.sendRequest()` → IPC → MainThread
2. MainThread → IPC → `CopilotLanguageModelWrapper.$startChatRequest()` → `chatMLFetcher.fetchMany()`

The consumer side creates a `chat` span in `extChatEndpoint.ts` (correctly nested under `invoke_agent`). The provider side creates another `chat` span in `chatMLFetcher.ts` (orphan, because it's a new async context from IPC dispatch with `gen_ai.agent.name: "copilotLanguageModelWrapper"`).

**Critical finding (2026-02-26):** The `copilotLanguageModelWrapper` orphan spans are **NOT duplicates** — they are the **actual CAPI HTTP request handlers** with full response data. They contain ALL the data missing from the consumer-side `extChatEndpoint` chat spans:

| Attribute | `extChatEndpoint` span | `copilotLanguageModelWrapper` span |
|-----------|----------------------|-----------------------------------|
| `gen_ai.usage.input_tokens` | missing (0) | **21689** |
| `gen_ai.usage.output_tokens` | missing (0) | **372** |
| `gen_ai.usage.cache_read.input_tokens` | missing | **12928** |
| `gen_ai.response.model` | `gpt-5` | **`gpt-5-2025-08-07`** (actual) |
| `gen_ai.request.temperature` | missing | **0.1** |
| `copilot_chat.time_to_first_token` | approximate | **6663** (from actual HTTP) |

There is a **1:1 correspondence** between wrapper spans and `extChatEndpoint` spans (11 chat spans in agent trace = 11 wrapper spans from the same time window).

**Identified orphan categories** (from `gen_ai.agent.name`):
- `title` — Chat title generation (gpt-4o-mini)
- `progressMessages` — Progress message preview (gpt-4o-mini)
- `promptCategorization` — Intent detection (gpt-4o-mini)
- `copilotLanguageModelWrapper` — BYOK actual HTTP handler (gpt-5) — **has all rich token/model data**

**Fix approach (priority):** Link the `copilotLanguageModelWrapper` spans to the agent trace. Options:
1. **Propagate trace context through `vscode.lm.sendRequest()` IPC** — pass `traceId`/`spanId` in `modelOptions` so the wrapper can use `parentTraceContext` when creating its span. This requires a small change in `extChatEndpoint.ts` (store context) and `CopilotLanguageModelWrapper` (restore context). This would make the wrapper span a child of the `extChatEndpoint` chat span, forming a complete trace with full data.
2. **Suppress `extChatEndpoint` spans entirely for BYOK** — don't create a consumer-side span when the provider will create one with richer data. Simpler but loses the parent-child nesting.
3. **Post-hoc data enrichment** — after the LM API call returns, retrieve token usage from `CopilotLanguageModelWrapper`'s response metadata and set it on the `extChatEndpoint` span. Requires exposing usage data through the LM API response stream.

Option 1 is recommended — it preserves the full trace hierarchy while making token usage visible.

---

## Remaining Work — Metrics & Events Parity

### Current Coverage Matrix

#### Metrics

| Metric (OTel GenAI spec) | CAPI | Azure BYOK (wrapper) | Anthropic BYOK | Gemini BYOK | Status |
|---|---|---|---|---|---|
| `gen_ai.client.operation.duration` | Yes (`chatMLFetcher`) | Yes (via wrapper) | **NO** | **NO** | Need to add to providers |
| `gen_ai.client.token.usage` (input) | Yes | Yes (via wrapper) | **NO** | **NO** | Need to add to providers |
| `gen_ai.client.token.usage` (output) | Yes | Yes (via wrapper) | **NO** | **NO** | Need to add to providers |

| Metric (Extension-specific) | CAPI | Azure BYOK | Anthropic BYOK | Gemini BYOK | Status |
|---|---|---|---|---|---|
| `copilot_chat.tool.call.count` | Yes | Yes | Yes | Yes | Done (in `toolsService.ts`) |
| `copilot_chat.tool.call.duration` | Yes | Yes | Yes | Yes | Done |
| `copilot_chat.agent.invocation.duration` | Yes | Yes | Yes | Yes | Done (in `toolCallingLoop.ts`) |
| `copilot_chat.agent.turn.count` | Yes | Yes | Yes | Yes | Done |
| `copilot_chat.session.count` | Yes | Yes | Yes | Yes | Done |
| `copilot_chat.time_to_first_token` | Yes | Yes (via wrapper) | **NO** | **NO** | Need to add to providers |

#### Events/Logs

| Event (OTel GenAI spec) | CAPI | Azure BYOK (wrapper) | Anthropic BYOK | Gemini BYOK | Status |
|---|---|---|---|---|---|
| `gen_ai.client.inference.operation.details` | Yes (`emitInferenceDetailsEvent`) | Yes (via wrapper) | **NO** | **NO** | Need to add to providers |

| Event (Extension-specific) | CAPI | Azure BYOK | Anthropic BYOK | Gemini BYOK | Status |
|---|---|---|---|---|---|
| `copilot_chat.session.start` | Yes | Yes | Yes | Yes | Done |
| `copilot_chat.tool.call` | Yes | Yes | Yes | Yes | Done |
| `copilot_chat.agent.turn` | Yes | Yes | Yes | Yes | Done |

#### Not Implemented (from spec)

| Signal | Spec | Status | Notes |
|---|---|---|---|
| `gen_ai.server.request.duration` | Metrics spec (server-side) | Skip | We're client-side only |
| `gen_ai.server.time_per_output_token` | Metrics spec (server-side) | Skip | Server metric |
| `gen_ai.server.time_to_first_token` | Metrics spec (server-side) | Skip | Server metric |
| `gen_ai.provider.request.count` | Metrics spec | Skip | Covered by `gen_ai.client.operation.duration` count |
| Log bridge (`ILogService` → OTel) | Spec D8 | Deferred | Optional, low priority |

### Tasks to Complete

#### M1. Add metrics to Anthropic BYOK provider

**File:** `src/extension/byok/vscode-node/anthropicProvider.ts`

After the OTel span enrichment block (where `result.usage` is available), add:
- `GenAiMetrics.recordOperationDuration()` with provider='anthropic'
- `GenAiMetrics.recordTokenUsage()` for input and output
- `GenAiMetrics.recordTimeToFirstToken()` from `result.ttft`

#### M2. Add metrics to Gemini BYOK provider

**File:** `src/extension/byok/vscode-node/geminiNativeProvider.ts`

Same pattern as M1 with provider='gemini'.

#### M3. Add inference details event to Anthropic BYOK provider

**File:** `src/extension/byok/vscode-node/anthropicProvider.ts`

Call `emitInferenceDetailsEvent()` after the span enrichment, passing:
- `request: { model, temperature, maxTokens }`
- `response: { id, model, finishReasons, inputTokens, outputTokens }`

#### M4. Add inference details event to Gemini BYOK provider

**File:** `src/extension/byok/vscode-node/geminiNativeProvider.ts`

Same pattern as M3.

#### M5. (Optional) Log bridge

Bridge `ILogService` output to OTel log records with severity mapping and trace/span correlation. Low priority — deferred.
