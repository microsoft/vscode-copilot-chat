# OTel Instrumentation for All Agents — Specification

> **Issue**: [microsoft/vscode#298832](https://github.com/microsoft/vscode/issues/298832)
> **Status**: Draft
> **Last Updated**: 2026-03-18

---

## 1. Problem Statement

The VS Code Copilot Chat extension has **four agent execution paths**, but only the foreground agent has OTel instrumentation:

| Agent | Process Model | OTel Status | LLM Request Path |
|---|---|---|---|
| **Foreground** (toolCallingLoop) | Extension host | Full traces, metrics, events | Extension's `chatMLFetcher` → CAPI |
| **Copilot CLI in-process** (`@github/copilot` SDK) | Extension host (same process) | **None** | SDK internal HTTP client (opaque) |
| **Copilot CLI terminal** ("New Copilot CLI Session") | Separate terminal process | **None** | Standalone `copilot` binary |
| **Claude Code** (`@anthropic-ai/claude-agent-sdk`) | Child process (Node fork) | **None** | `ClaudeLanguageModelServer` proxy → `chatMLFetcher` → CAPI |

Background agent runs are completely invisible to distributed tracing. No spans for LLM calls, tool executions, or session lifecycle. No correlation with foreground agent traces or eval runs.

---

## 2. Goal

All agents produce the `invoke_agent` → `chat` → `execute_tool` span hierarchy, visible in the user's configured OTel backend (Jaeger, Aspire Dashboard, Grafana, etc.), with a **single user-facing configuration point**.

### Non-Goals

- Modifying `copilot-agent-runtime` or Claude Code SDK source code
- Running an in-process OTel Collector or aggregator
- Dynamic OTel toggling mid-session (requires extension restart)
- Per-agent VS Code settings UI (env vars serve as per-agent escape hatch)

### Design Constraint: Debug Panel vs External OTel Isolation

The Agent Debug Log panel uses `InMemoryOTelService` to create spans for its UI (always active, even when user OTel is disabled). These debug-panel spans use non-standard operation names (`content_event`, `user_message`) and attributes (`copilot_chat.markdown_content`, `copilot_chat.debug_name`) that are only meaningful for the VS Code debug panel.

**Hard requirement**: Debug-panel-only spans MUST NOT appear in the user's configured OTel collector. When OTel export is enabled (`NodeOTelService`), only spans following GenAI semantic conventions (`invoke_agent`, `chat`, `execute_tool`) should be exported. Debug-panel spans should remain in-memory only.

**Mechanism**: `NodeOTelService` should filter or tag spans so that debug-panel-only spans (identifiable by non-standard `gen_ai.operation.name` values) are excluded from OTLP export while still being visible to the debug panel via `onDidCompleteSpan`.

---

## 3. Architecture

### 3.1 Why Asymmetric

Each background agent has fundamentally different capabilities:

| | Copilot CLI in-process | Copilot CLI terminal | Claude Code SDK |
|---|---|---|---|
| **Process model** | Same process (extension host) | Separate terminal process | Child process (Node fork) |
| **Built-in OTel** | Full (`OtelLifecycle` — traces + metrics) | Full (standalone CLI binary) | Metrics + events only (**no traces**) |
| **LLM request path** | SDK internal HTTP client (opaque) | SDK internal HTTP client (opaque) | `ClaudeLanguageModelServer` → `chatMLFetcher` (extension-controlled) |
| **Tool events** | `session.on('tool.execution_start/complete')` | N/A (no extension visibility) | `PreToolUse` / `PostToolUse` hooks (**can be disabled**) |
| **Config mechanism** | `process.env` mutation before SDK ctor | `TerminalOptions.env` | Subprocess env inheritance |
| **Trace context linkage** | `traceparent` via `SessionOptions` / `OtelLifecycle.updateParentTraceContext()` | Independent root traces (long-lived session) | `TraceContext` stored in `IClaudeSessionStateService`, bridged via `runWithTraceContext()` |

### 3.2 Approach Per Agent

| Agent | Strategy | What extension creates | What SDK creates | Debug Panel Source |
|---|---|---|---|---|
| **Copilot CLI in-process** | **Bridge SpanProcessor** — SDK creates all spans natively; extension adds a `SpanProcessor` to the SDK's `TracerProvider` that forwards completed spans to `IOTelService.onDidCompleteSpan` (debug panel) | Wrapper `invoke_agent copilotcli` span (parent context) | Full `invoke_agent` → `chat` → `execute_tool` → subagent `invoke_agent` hierarchy | SDK native spans via bridge |
| **Copilot CLI terminal** | Forward OTel env vars to terminal process | Nothing (terminal process is independent) | Full `invoke_agent` → `chat` → `execute_tool` internally | N/A (separate process) |
| **Claude Code** | **Synthetic spans** — extension creates spans from SDK message loop; SDK exports its own metrics/events from subprocess | `invoke_agent claude` span + `execute_tool` spans (from message loop) | `chat` spans from `chatMLFetcher`; SDK exports metrics + events from subprocess | Extension synthetic spans |

> **Why different approaches?** The Copilot CLI SDK runs **in the same process** and creates a rich span hierarchy (subagents, permissions, hooks). A bridge processor captures this hierarchy directly — no manual event mirroring needed. Claude Code runs as a **separate child process** — its internal spans are inaccessible, so the extension must create synthetic spans from its message loop. This is the only option for Claude.

### 3.2.1 Copilot CLI Bridge SpanProcessor Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host Process               │
│                                                                 │
│  ┌──────────────────┐    ┌──────────────────────────────────┐   │
│  │  NodeOTelService  │    │  Copilot CLI SDK (in-process)    │   │
│  │  (Provider A)     │    │                                  │   │
│  │                   │    │  OtelLifecycle → BasicTracerProv  │   │
│  │  tracer A ────────┼──┐ │  (Provider B — global)           │   │
│  │                   │  │ │                                  │   │
│  │  onDidCompleteSpan│  │ │  tracer B: creates full hierarchy│   │
│  │       ▲           │  │ │    invoke_agent                  │   │
│  │       │           │  │ │      chat claude-opus-4.6-1m     │   │
│  │  [bridge fires]   │  │ │        execute_tool task         │   │
│  │       ▲           │  │ │          invoke_agent explore    │   │
│  │       │           │  │ │            execute_tool grep     │   │
│  └───────┼──────────┘  │ │              permission           │   │
│          │              │ │                                  │   │
│  ┌───────┼──────────┐   │ │  SpanProcessors on Provider B:   │   │
│  │ BridgeProcessor  │◄──┼─┤  ├─ BatchSpanProcessor → OTLP   │   │
│  │ (adds            │   │ │  └─ BridgeProcessor → debug panel│   │
│  │  CHAT_SESSION_ID)│   │ └──────────────────────────────────┘   │
│  └──────────────────┘   │                                        │
│                         │                                        │
│  copilotcliSession.ts   │                                        │
│  ┌──────────────────┐   │                                        │
│  │ startActiveSpan   │◄──┘  Root span (Provider A tracer)        │
│  │ 'invoke_agent     │      Injects traceparent → SDK spans      │
│  │  copilotcli'      │      are children of this span            │
│  └──────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘

Data flow:
  SDK span completes → BridgeProcessor.onEnd(ReadableSpan)
    → converts to ICompletedSpanData
    → injects copilot_chat.chat_session_id (from traceId→sessionId map)
    → fires IOTelService.onDidCompleteSpan
    → Debug Panel + File Logger receive full hierarchy
```

### 3.2.2 Approach Decision Rationale

Three approaches were evaluated:

| Approach | Description | Verdict |
|---|---|---|
| **A: Bridge SpanProcessor** | Add SpanProcessor to SDK's TracerProvider; forward completed spans to debug panel | **Selected** — full hierarchy, single source of truth, no duplication |
| **B: Synthetic spans** | Extension listens to SDK events, creates its own spans manually | Rejected for CLI — duplicates SDK work, can never match SDK richness (subagents, permissions, hooks). Used for Claude (only option). |
| **C: SDK callback API** | Modify SDK to emit span completion callbacks | Rejected — requires `copilot-agent-runtime` changes (non-goal) |

Key risks and mitigations for Approach A:

| Risk | Score | Mitigation |
|---|:---:|---|
| SDK provider not ready when bridge attaches | 9 | Hook into `await trackSession()` completion |
| `ReadableSpan.attributes` is readonly | 9 | Bridge creates new `ICompletedSpanData` objects; SDK span unmodified |
| Session ID mapping for `CHAT_SESSION_ID` injection | 6 | Map `traceId → sessionId` from root span; bridge looks up per span |
| OTel SDK version mismatch (extension vs SDK) | 6 | `SpanProcessor` interface is stable; runtime guard with fallback |
| Global TracerProvider override conflict | 6 | Extension stores tracer ref at init; never re-queries global after SDK init |

### 3.3 Span Hierarchy

#### Foreground Agent (reference — already implemented)

```
invoke_agent copilot (INTERNAL)          ← toolCallingLoop.ts
├── chat gpt-4o (CLIENT)                 ← chatMLFetcher.ts
│   ├── execute_tool readFile (INTERNAL) ← toolsService.ts
│   └── execute_tool runCommand (INTERNAL)
├── chat gpt-4o (CLIENT)
└── ...
```

#### Copilot CLI in-process (SDK OTel + Bridge SpanProcessor)

```
invoke_agent copilotcli (INTERNAL)       ← copilotcliSession.ts (tracer A)
│   copilot_chat.session_id, copilot_chat.chat_session_id
│
└── [traceparent linked] ──→
    invoke_agent (CLIENT)                ← SDK OtelSessionTracker (tracer B)
    │   github.copilot.* attributes
    │   + copilot_chat.chat_session_id   ← injected by BridgeProcessor
    ├── chat claude-opus-4.6-1m (CLIENT) ← SDK (full model/token/TTFT data)
    │   ├── execute_tool bash (INTERNAL) ← SDK
    │   │     └── permission (INTERNAL)  ← SDK (permission request/response)
    │   └── execute_tool edit_file (INTERNAL)
    ├── execute_tool task (INTERNAL)     ← SDK
    │   └── invoke_agent explore (CLIENT)← SDK (SUBAGENT!)
    │       └── chat claude-opus-4.6-1m  ← SDK
    │           └── execute_tool grep    ← SDK
    ├── chat claude-opus-4.6-1m (CLIENT)
    └── ...

All spans visible in BOTH Grafana (via OTLP) AND Debug Panel (via bridge).
```

#### Copilot CLI terminal (independent traces)

```
invoke_agent (CLIENT)                    ← standalone copilot binary OTel
│   github.copilot.* attributes
│   service.name = github-copilot
├── chat gpt-4o (CLIENT)
│   ├── execute_tool bash (INTERNAL)
│   └── execute_tool edit_file (INTERNAL)
├── chat gpt-4o (CLIENT)
└── ...

(Independent root traces — no parent link to extension)
```

#### Claude Code (extension-side synthetic spans + SDK metrics/events)

```
invoke_agent claude (INTERNAL)           ← claudeCodeAgent.ts [NEW]
│   copilot_chat.session_id, copilot_chat.chat_session_id
│
├── chat claude-sonnet-4 (CLIENT)        ← chatMLFetcher.ts (FREE, no hooks needed)
├── execute_tool Read (INTERNAL)         ← message loop in claudeCodeAgent.ts (shipped in PR #4505)
├── chat claude-sonnet-4 (CLIENT)        ← chatMLFetcher.ts
├── execute_tool Edit (INTERNAL)         ← message loop (PR #4505)
└── ...

Claude subprocess exports independently (to same collector endpoint):
  [metrics] claude_code.token.usage, claude_code.cost.usage, ...
  [events]  claude_code.tool_result (tool_name, success, duration_ms), ...
  [events]  claude_code.api_request (model, cost_usd, duration_ms, tokens), ...
```

> **`execute_tool` spans** are already shipped via [PR #4505](https://github.com/microsoft/vscode-copilot-chat/pull/4505). They use the `_processMessages()` loop (on `tool_use` / `tool_result` blocks), **not hooks** — so they work regardless of hook settings.

> **Why synthetic for Claude but not CLI?** Claude Code runs as a **separate child process** — the extension cannot access its internal OTel spans. The bridge approach (used for CLI) is impossible. Synthetic spans from the message loop are the only option. The resulting hierarchy is flatter (no subagent nesting, no permission spans) but still useful for debugging.

---

## 4. User Configuration

### 4.1 Single Configuration Point

Users configure OTel **once**. The extension derives agent-specific config for all paths automatically.

#### VS Code Settings (existing — no new settings needed)

```jsonc
// settings.json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "otlp-http",    // otlp-http | otlp-grpc | console | file
  "github.copilot.chat.otel.otlpEndpoint": "http://localhost:4318",
  "github.copilot.chat.otel.captureContent": false,          // prompts, tool args, responses
  "github.copilot.chat.otel.outfile": ""                     // file exporter path (overrides exporterType)
}
```

#### Environment Variables (take precedence over settings)

| Variable | Description |
|---|---|
| `COPILOT_OTEL_ENABLED` | `true` to enable |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint (auto-enables OTel) |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc` or `http` |
| `COPILOT_OTEL_CAPTURE_CONTENT` | `true` to capture message content |
| `COPILOT_OTEL_FILE_EXPORTER_PATH` | File path for JSON-lines output (auto-enables OTel) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth headers (e.g., `Authorization=Bearer token`) |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes (`key1=val1,key2=val2`) |
| `OTEL_SERVICE_NAME` | Override service name (default per-agent) |

#### Precedence

1. `COPILOT_OTEL_*` env vars (highest)
2. `OTEL_EXPORTER_OTLP_*` standard env vars
3. VS Code settings (`github.copilot.chat.otel.*`)
4. Defaults: disabled, `otlp-http`, `localhost:4318`

#### Kill Switch

VS Code `telemetry.telemetryLevel` = `off` → all OTel disabled regardless of other settings.

### 4.2 Config Translation to Each Agent

The extension translates its unified `OTelConfig` into agent-specific env vars. **It never overwrites env vars the user has set explicitly** — this makes env vars the natural per-agent escape hatch.

#### Env Var Translation Table

| Extension Config | Foreground | Copilot CLI Env Var | Claude Code Env Var |
|---|---|---|---|
| `enabled` | `IOTelService` (direct) | `COPILOT_OTEL_ENABLED=true` | `CLAUDE_CODE_ENABLE_TELEMETRY=1` |
| `otlpEndpoint` | `IOTelService` (direct) | `OTEL_EXPORTER_OTLP_ENDPOINT` (shared) | `OTEL_EXPORTER_OTLP_ENDPOINT` (shared) |
| `otlpProtocol` | `IOTelService` (direct) | N/A (HTTP only in CLI SDK) | `OTEL_EXPORTER_OTLP_PROTOCOL` |
| `captureContent` | `IOTelService.config` | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` | `OTEL_LOG_USER_PROMPTS=1` + `OTEL_LOG_TOOL_DETAILS=1` |
| `fileExporterPath` | `IOTelService` (direct) | `COPILOT_OTEL_FILE_EXPORTER_PATH` (shared) | N/A (Claude SDK has no file exporter) |
| `exporterType` | `IOTelService` (direct) | `COPILOT_OTEL_EXPORTER_TYPE` | `OTEL_METRICS_EXPORTER=otlp` + `OTEL_LOGS_EXPORTER=otlp` |
| (auth headers) | via OTel SDK | `OTEL_EXPORTER_OTLP_HEADERS` (inherited) | `OTEL_EXPORTER_OTLP_HEADERS` (inherited) |
| (resource attrs) | via OTel SDK | `OTEL_RESOURCE_ATTRIBUTES` (inherited) | `OTEL_RESOURCE_ATTRIBUTES` (inherited) |

"Shared" = extension and agent both read the same standard env var natively.
"Inherited" = subprocess gets it via `process.env` without explicit forwarding.

#### Config Flow Diagram

```
User configures once
        │
  resolveOTelConfig()  (at extension activation)
        │
        ├──→ Foreground Agent
        │      IOTelService (direct)
        │      Already works ✅
        │
        ├──→ Copilot CLI SDK (in-process)
        │      deriveCopilotCliOTelEnv() → process.env before ctor
        │
        ├──→ Copilot CLI terminal
        │      deriveCopilotCliOTelEnv() → TerminalOptions.env
        │
        └──→ Claude Code subprocess
               deriveClaudeOTelEnv() → child process env
```

#### Per-Agent Override via Env Vars

Advanced users who need per-agent control set agent-specific env vars directly. The extension only sets vars that aren't already present:

```bash
# Enable OTel for foreground + CLI but disable for Claude
export COPILOT_OTEL_ENABLED=true
export CLAUDE_CODE_ENABLE_TELEMETRY=0   # ← extension won't overwrite

# Send CLI to different endpoint than foreground
# (not possible with unified config — CLI shares OTEL_EXPORTER_OTLP_ENDPOINT)
```

### 4.3 Quick Start (User-Facing)

```bash
# Option A: Environment variables
export COPILOT_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Option B: VS Code settings
# github.copilot.chat.otel.enabled = true
# github.copilot.chat.otel.otlpEndpoint = http://localhost:4318

# Option C: File exporter (debug)
export COPILOT_OTEL_FILE_EXPORTER_PATH=/tmp/copilot-otel.jsonl
```

All agents export to the same endpoint. Users see spans from all agents in a single trace viewer.

---

## 5. Attribute Conventions

### 5.1 Extension-Created Spans (foreground, copilotcli wrapper, claude)

Use `copilot_chat.*` namespace:

| Attribute | Value |
|---|---|
| `gen_ai.operation.name` | `invoke_agent` / `execute_tool` |
| `gen_ai.agent.name` | `copilot` / `copilotcli` / `claude` |
| `gen_ai.provider.name` | `github` |
| `gen_ai.conversation.id` | Session ID |
| `gen_ai.request.model` | Requested model (when available) |
| `copilot_chat.session_id` | VS Code conversation session ID |
| `copilot_chat.chat_session_id` | VS Code chat session ID (from CapturingToken) |

### 5.2 Copilot CLI SDK-Created Spans (internal)

Use `github.copilot.*` namespace:

| Attribute | Value |
|---|---|
| `gen_ai.operation.name` | `invoke_agent` / `chat` / `execute_tool` |
| `gen_ai.request.model` | Actual model used |
| `gen_ai.usage.input_tokens` / `output_tokens` | Token counts |
| `github.copilot.cost` | Estimated cost |
| `github.copilot.aiu` | AI units consumed |
| `github.copilot.turn_id` | Turn identifier |
| `github.copilot.turn_count` | LLM round-trips |

### 5.3 Claude SDK Metrics/Events (subprocess)

Use `claude_code.*` namespace:

| Signal | Names |
|---|---|
| Metrics | `claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.session.count`, `claude_code.lines_of_code.count` |
| Events | `claude_code.tool_result`, `claude_code.api_request`, `claude_code.user_prompt`, `claude_code.api_error`, `claude_code.tool_decision` |

### 5.4 `service.name` Values (intentionally different)

| Source | `service.name` | Why separate |
|---|---|---|
| Extension (`IOTelService`) | `copilot-chat` | VS Code extension spans |
| Copilot CLI SDK / terminal | `github-copilot` | SDK/CLI internal spans |
| Claude Code subprocess | `claude-code` | Anthropic SDK metrics/events |

Users filter by `service.name` in their trace viewer to distinguish signal sources.

---

## 6. Trace Context Propagation

### 6.1 Copilot CLI in-process

Extension creates `invoke_agent copilotcli` span → injects `traceparent` → passes via `OtelLifecycle.updateParentTraceContext(sessionId, traceparent)` or `SessionOptions.traceparent`. SDK's internal spans become children of the extension span.

### 6.2 Copilot CLI terminal

No trace context propagation. Terminal sessions are long-lived, user-driven — their traces are independent root traces. Users correlate by time window or `session.id`.

### 6.3 Claude Code

Extension creates `invoke_agent claude` span → stores `TraceContext` in `IClaudeSessionStateService` keyed by `sessionId` → `ClaudeLanguageModelServer.handleAuthedMessagesRequest()` retrieves it → wraps `makeChatRequest2()` in `IOTelService.runWithTraceContext()` → `chatMLFetcher`'s `chat` spans auto-parent via `AsyncLocalStorage`.

`execute_tool` spans are created in the `_processMessages()` loop (on `tool_use`/`tool_result` message blocks), shipped in [PR #4505](https://github.com/microsoft/vscode-copilot-chat/pull/4505). These are hook-independent and work regardless of hook settings.

---

## 7. Data Completeness Matrix

| Signal | Foreground | Copilot CLI in-process | Copilot CLI terminal | Claude Code |
|---|---|---|---|---|
| `invoke_agent` span | ✅ | ✅ (ext wrapper + SDK internal) | ✅ (SDK) | ✅ (ext) |
| `chat` span per LLM call | ✅ | ✅ (SDK) | ✅ (SDK) | ✅ (chatMLFetcher) |
| `execute_tool` span | ✅ | ✅ (SDK) | ✅ (SDK) | ✅ (ext, message loop — PR #4505) |
| Token usage metrics | ✅ | ✅ (SDK + ext events) | ✅ (SDK) | ✅ (chatMLFetcher + SDK metrics) |
| TTFT metric | ✅ | ✅ (SDK) | ✅ (SDK) | ✅ (chatMLFetcher) |
| Cost/AIU | ✅ | ✅ (SDK) | ✅ (SDK) | ✅ (SDK `claude_code.cost.usage`) |
| Error status on spans | ✅ | ✅ (SDK + ext) | ✅ (SDK) | ✅ (ext) |
| Content capture | ✅ | ✅ (SDK, gated) | ✅ (SDK, gated) | ✅ (chatMLFetcher + SDK events, gated) |
| Linked to parent trace | ✅ | ✅ (via traceparent) | ❌ (independent) | ✅ (via runWithTraceContext) |

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Debug-panel spans leak to user's collector | Users see noise (`content_event`, `user_message` spans) in Jaeger/Grafana | `NodeOTelService` must filter debug-panel-only spans from OTLP export; only export GenAI conventional spans (`invoke_agent`, `chat`, `execute_tool`) |
| Two OTel SDK instances in same process (copilotcli) | Span parenting confusion | SDK uses W3C propagator (HTTP), extension uses AsyncLocalStorage (in-process) — independent |
| `process.env` mutation for CLI SDK config | Affects extension host | Only set OTel-specific vars when enabled; set before SDK ctor; don't overwrite existing vars |
| Duplicate `invoke_agent` spans (copilotcli) | Visual noise in trace viewer | Different `service.name` + distinct attribute namespaces; document in user guide |
| `chatMLFetcher` chat spans for Claude need active parent | Orphaned spans | `runWithTraceContext()` bridges HTTP handler boundary |
| Claude subprocess OTel creates separate connection | Extra resources | Acceptable; subprocess lifecycle is independent |
| SDK OTel internals may change | Breaking on SDK update | `OtelLifecycle` is in published `.d.ts`; `SessionOptions.traceparent` is documented API |
| File exporter not supported by Claude SDK | Inconsistent in file mode | Document limitation; Claude metrics/events only available via OTLP |
| Copilot CLI runtime only supports `otlp-http` | Terminal CLI can't export to gRPC-only endpoints | Document limitation; when user configures `otlp-grpc`, terminal CLI still uses HTTP. Backends that serve both protocols on the same port (Aspire) work transparently; backends with separate ports (Jaeger: 4317 gRPC, 4318 HTTP) require the HTTP port. |
| Claude hooks can be disabled | `execute_tool` spans would disappear if using hooks | `execute_tool` spans use message loop (PR #4505), not hooks — unaffected by hook settings |

---

## 9. Future Work (Out of Scope)

- **Layer B (SDK request IDs)**: Copilot CLI SDK exposes `X-Request-Id` / `X-GitHub-Request-ID` from CAPI responses for server-side correlation
- **Layer C (SDK TracerProvider)**: Copilot CLI SDK accepts `TracerProvider` directly (no env var dance)
- **Claude SDK native traces**: If Claude Code adds native OTel traces, extension delegates `chat`/`execute_tool` spans to SDK
- **Per-agent VS Code settings**: If user demand arises for separate enable/endpoint per agent
- **OTel Collector**: If attribute normalization across agent namespaces becomes required
