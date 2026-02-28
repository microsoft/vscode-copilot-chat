# OTel PR Sprint Plan — Diff-Check Findings

PR: #3917 `feat(otel): Add OpenTelemetry GenAI instrumentation to Copilot Chat`

---

## Reference: gemini-cli OTel Patterns (use as north star)

Key patterns from `gemini-cli/packages/core/src/telemetry/` that we should align with:

| Pattern | gemini-cli | copilot-chat (current) | Gap |
|---------|-----------|----------------------|-----|
| **Content truncation** | 160KB global limit with fair-share algorithm across parts (`semantic.ts:limitTotalLength`) | No size limit — `JSON.stringify` unbounded | **Critical** |
| **Metric instrument caching** | Module-level `let toolCallCounter: Counter \| undefined` — created once at init, reused forever (`metrics.ts:594+`) | `new GenAiMetrics(this._otelService)` per call — 17+ throwaway objects per agent run | **P1** |
| **Span helper** | `runInDevTraceSpan()` wraps operation with auto-end, error status, exception recording | Manual try/catch/finally across 6+ files — inconsistent patterns | Acceptable (different arch) |
| **Event buffering** | Pre-init queue with `bufferTelemetryEvent()`, flushed sequentially (`sdk.ts`) | Buffer with 1000-cap and batch drain — ✅ already good | OK |
| **Sampling** | No explicit sampling (AlwaysOn default) | Same — no sampling config | Both lack it |
| **Shutdown** | Graceful flush + disable all providers | Flush + disable — ✅ similar | OK |
| **Error handling** | `span.setStatus(ERROR)` + `span.recordException()` + re-throw | Same pattern — ✅ consistent | OK |
| **GenAI conventions** | Full `gen_ai.*` attributes, `toInputMessages()`/`toOutputMessages()` with truncation | Full attributes, formatters present but no truncation | Truncation gap |

---

## Phase 1 — Critical Fixes (Security & Perf)

### 1.1 ~~Remove OTel env vars from launch.json~~ ✅ DONE

Removed `COPILOT_OTEL_ENABLED`, `COPILOT_OTEL_CAPTURE_CONTENT`, and `OTEL_EXPORTER_OTLP_ENDPOINT` from both launch configs. launch.json now matches main branch state.

### 1.2 ~~No size limit / truncation on captured content attributes~~ ✅ DONE

Added `truncateForOTel()` utility (64KB default) in `messageFormatters.ts`. Applied to all JSON.stringify calls in genAiEvents, toolCallingLoop, chatMLFetcher, anthropicProvider, geminiNativeProvider, toolsService. Tests added.

### 1.3 ~~`GenAiMetrics` instantiated per-call~~ ✅ DONE

Converted all GenAiMetrics methods to static. Zero allocations per metric recording.

### 1.4 ~~`storeTraceContext` setTimeout leak~~ ✅ DONE

Added timer tracking in `_traceContextTimers` Map, clearTimeout on retrieval and shutdown, 100-entry cap with LRU eviction.

---

## ToolCallingLoop Subclass Coverage Check

All `ToolCallingLoop` subclasses pass `@IOTelService otelService` to the super constructor and inherit the `run()` method which creates the `invoke_agent` span. Verified:

| Subclass | File | `otelService` wired? |
|----------|------|---------------------|
| `DefaultToolCallingLoop` | `defaultIntentRequestHandler.ts` | ✅ |
| `CodebaseToolCallingLoop` | `codebaseToolCalling.ts` | ✅ |
| `McpToolCallingLoop` | `mcpToolCallingLoop.tsx` | ✅ |
| `SearchSubagentToolCallingLoop` | `searchSubagentToolCallingLoop.ts` | ✅ |
| `TestToolCallingLoop` | `toolCallingLoopHooks.spec.ts` | ✅ |

All subclasses inherit `run()` → `startActiveSpan('invoke_agent ...')` → `_runLoop()`, so agent-level instrumentation is consistent.

---

## Phase 2 — Robustness & Best Practices

### 2.1 `as any` in OTel-instrumented BYOK providers

**Files:**
- `anthropicProvider.ts:498` — `(msg.content as any[])?.filter?.((p: any) => ...)`
- `geminiNativeProvider.ts:354` — same pattern

These exist in content-capture blocks added by this PR. The `LanguageModelChatMessage.content` type is `(LanguageModelTextPart | LanguageModelToolResultPart | ...)[]` — a proper type-narrowing `instanceof` check is already used but the outer cast defeats type safety.

**Fix:** Type the iterable properly: `const parts = msg.content as ReadonlyArray<LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart>` or use the VS Code API type.

### 2.2 Repeated `_otelTraceContext` type assertion pattern

**Files:** `anthropicProvider.ts:100`, `geminiNativeProvider.ts:83`, `languageModelAccess.ts:554`

The pattern `(options as { modelOptions?: { _otelTraceContext?: { traceId: string; spanId: string } } }).modelOptions?._otelTraceContext` is duplicated 3 times with identical inline type. This should be a shared interface.

**Fix:** Define `interface OTelModelOptions { _otelTraceContext?: TraceContext; _capturingTokenCorrelationId?: string }` in a shared location and use it in all three providers.

### 2.3 Missing sampling / head-based sampling configuration

**File:** `otelServiceImpl.ts`, `otelConfig.ts`

The `NodeTracerProvider` is created with no sampler config — defaults to `AlwaysOnSampler`. In high-throughput scenarios (fast tool loops, many LLM calls), this means every single operation is traced. Users have no way to reduce volume without disabling entirely.

**Fix:** Add `COPILOT_OTEL_TRACE_SAMPLE_RATE` env var (float 0.0–1.0, default 1.0). Wire `TraceIdRatioBasedSampler` into the `NodeTracerProvider` constructor. Add to config schema and docs.

### 2.4 ~~`BufferedSpanHandle._ops` unbounded~~ ✅ DONE

Added 200-op cap. `end()` always buffered regardless of cap for span lifecycle correctness.

### 2.5 `_createSpan` doesn't honor `parentTraceContext` for non-active spans

**File:** `otelServiceImpl.ts` (line ~380)

`startSpan()` calls `_createSpan()` which ignores `options.parentTraceContext`. Only `startActiveSpan()` handles it. This means tool spans created via `startSpan()` with a `parentTraceContext` won't be linked.

**Fix:** In `_createSpan()`, if `options?.parentTraceContext` is set and `_otelApi` is available, create the span within a remote context (same pattern as `startActiveSpan`).

### 2.6 File exporter `safeStringify` on span objects may produce huge output

**File:** `fileExporters.ts`

`JSON.stringify(span)` on a `ReadableSpan` serializes the entire span including all attributes, events, and links. With content capture enabled, a single span could be megabytes. The write stream has no backpressure handling.

**Fix:** Add a max-size check per record before writing. If `data.length > MAX_FILE_RECORD_SIZE`, truncate or skip and log a warning.

### 2.7 ~~`DiagnosticSpanExporter` logs on every failure~~ ✅ DONE

Rate-limited to once per 60s via `_lastFailureLogTime` tracking.

---

## Phase 3 — Essential Tests

### 3.1 End-to-end agent trace hierarchy test (CRITICAL)

**Missing test coverage:** No test verifies the full `invoke_agent → chat → execute_tool → chat` span hierarchy is correctly assembled. The toolCallingLoop test changes only add `IOTelService` to the DI container — no assertions on trace output.

**Test plan:**
- Create `src/platform/otel/common/test/agentTraceHierarchy.spec.ts`
- Mock an `IOTelService` that captures all `startSpan`/`startActiveSpan` calls with names and parent contexts
- Verify: `invoke_agent copilot` is root span
- Verify: `chat gpt-4o` spans are children of `invoke_agent`
- Verify: `execute_tool readFile` spans are children of `invoke_agent`
- Verify: subagent `invoke_agent Explore` gets same traceId as parent via `storeTraceContext`/`getStoredTraceContext`

### 3.2 BYOK provider span emission tests (Anthropic + Gemini)

**Missing:** The Anthropic and Gemini BYOK providers have 80+ lines of OTel instrumentation each, but the test changes in `geminiNativeProvider.spec.ts` only add `NoopOTelService` to constructor calls — zero assertions on span attributes.

**Test plan:**
- Add tests that use a capturing mock (records `startSpan` calls, attribute sets, status codes)
- Verify `chat {model}` span is created with `SpanKind.CLIENT`
- Verify token usage attributes are set on success
- Verify `SpanStatusCode.ERROR` and `error.type` on failure
- Verify content capture is gated on `captureContent` config

### 3.3 chatMLFetcher OTel span lifecycle test

**Missing:** chatMLFetcher creates a span in `_doFetch`, returns the handle to `fetchMany`, where it's enriched and ended. No test verifies this two-phase lifecycle.

**Test plan:**
- Verify span is created with correct model and conversation ID
- Verify span is ended after response processing
- Verify span is ended on error path (not leaked)
- Verify `otelSpan` returned from `_doFetch` matches what `fetchMany` enriches

### 3.4 Content capture truncation test (after 2.2 fix)

Once the truncation utility is added (Phase 1.2), test:
- Strings under limit pass through unchanged
- Strings over limit are truncated with ellipsis marker
- Edge cases: empty string, exactly at limit

### 3.5 Buffer cap behavior test

**File:** `otelServiceImpl.ts` — the `_MAX_BUFFER_SIZE = 1000` cap

**Partially covered** by noop tests but NOT by NodeOTelService tests. Need to verify:
- When buffer is full, new `startSpan` returns noop handle
- When buffer is full, `recordMetric` and `incrementCounter` are silently dropped
- After init completes, buffer is drained correctly

### 3.6 `runWithTraceContext` propagation test for CopilotLanguageModelWrapper

**Missing:** `languageModelAccess.ts` propagates OTel context through `runWithTraceContext` but no test verifies that chat spans created inside the wrapper inherit the parent trace.

---

## Phase 4 — Cleanup

### 4.1 Remove `console.info` / `console.error` — use ILogService

**Files:** `otelServiceImpl.ts` (lines ~161, ~399, ~402, ~541, ~545)

The codebase convention is to use `ILogService` for all logging. `console.info` and `console.error` bypass log level filtering and telemetry. The `OTelContrib` class has `ILogService` but `NodeOTelService` doesn't (it's not DI-managed).

**Fix:** Accept an optional log callback `(level: string, msg: string) => void` in the constructor, or accept that these are bootstrap-level logs. At minimum, remove `console.info` for first-log-emitted (line 402) which fires on every session.

### 4.2 ~~Docker-compose port comment inconsistency~~ ✅ DONE

Updated `agent_monitoring.md` to say `http://localhost:16687`.

### 4.3 ConfigKey definitions unused in runtime

**File:** `configurationService.ts` (ConfigKey additions)

`ConfigKey.OTelEnabled`, `ConfigKey.OTelExporterType`, etc. are defined but the actual config reading in `services.ts` goes through `workspace.getConfiguration('github.copilot.chat.otel')` directly. The ConfigKey constants are orphaned.

**Fix:** Either wire `services.ts` to use `IConfigurationService.get(ConfigKey.OTelEnabled)` or remove the ConfigKey definitions.

---

## Priority Order

| Priority | Items | Risk if Skipped |
|----------|-------|----------------|
| P0 (before merge) | ~~1.1~~ ✅, ~~1.2~~ ✅ | ~~Security/data leak in debug; silent span loss in production~~ |
| P1 (before merge) | ~~1.3~~ ✅, ~~1.4~~ ✅, ~~2.7~~ ✅ | ~~GC pressure in hot paths; timer leaks; log flood~~ |
| P2 (fast follow) | 2.1–2.3, 2.5–2.6, 3.1–3.3, 3.5–3.6 (~~2.4~~ ✅) | Type safety, test coverage for regressions |
| P3 (backlog) | 3.4, 4.1, ~~4.2~~ ✅, 4.3 | Polish, consistency |
