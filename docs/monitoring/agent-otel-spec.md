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

---

## 3. Architecture

### 3.1 Why Asymmetric

Each background agent has fundamentally different capabilities:

| | Copilot CLI in-process | Copilot CLI terminal | Claude Code SDK |
|---|---|---|---|
| **Process model** | Same process (extension host) | Separate terminal process | Child process (Node fork) |
| **Built-in OTel** | Full (`OtelLifecycle` — traces + metrics) | Full (standalone CLI binary) | Metrics + events only (**no traces**) |
| **LLM request path** | SDK internal HTTP client (opaque) | SDK internal HTTP client (opaque) | `ClaudeLanguageModelServer` → `chatMLFetcher` (extension-controlled) |
| **Tool events** | `session.on('tool.execution_start/complete')` | N/A (no extension visibility) | `PreToolUse` / `PostToolUse` hooks |
| **Config mechanism** | `process.env` mutation before SDK ctor | `TerminalOptions.env` | Subprocess env inheritance |
| **Trace context linkage** | `traceparent` via `SessionOptions` / `OtelLifecycle.updateParentTraceContext()` | Independent root traces (long-lived session) | `TraceContext` stored in `IClaudeSessionStateService`, bridged via `runWithTraceContext()` |

### 3.2 Approach Per Agent

| Agent | Strategy | What extension creates | What SDK creates |
|---|---|---|---|
| **Copilot CLI in-process** | Leverage SDK's built-in `OtelLifecycle` | Wrapper `invoke_agent copilotcli` span + extension metrics from SDK events | Full `invoke_agent` → `chat` → `execute_tool` internally |
| **Copilot CLI terminal** | Forward OTel env vars to terminal process | Nothing (terminal process is independent) | Full `invoke_agent` → `chat` → `execute_tool` internally |
| **Claude Code** | Extension-side traces + SDK metrics/events | `invoke_agent claude` span + `execute_tool` spans from hooks | `chat` spans come free via `chatMLFetcher` proxy; SDK exports metrics + events from subprocess |

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

#### Copilot CLI in-process (SDK OTel + extension wrapper)

```
invoke_agent copilotcli (INTERNAL)       ← copilotcliSession.ts [NEW]
│   copilot_chat.session_id, copilot_chat.chat_session_id
│
└── [traceparent linked] ──→
    invoke_agent (CLIENT)                ← SDK OtelLifecycle (internal)
    │   github.copilot.* attributes
    ├── chat gpt-4o (CLIENT)             ← SDK (full model/token/TTFT data)
    │   ├── execute_tool bash (INTERNAL) ← SDK
    │   └── execute_tool edit_file (INTERNAL)
    ├── chat gpt-4o (CLIENT)
    └── ...
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

#### Claude Code (extension-side traces + SDK metrics/events)

```
invoke_agent claude (INTERNAL)           ← claudeCodeAgent.ts [NEW]
│   copilot_chat.session_id, copilot_chat.chat_session_id
│
├── chat claude-sonnet-4 (CLIENT)        ← chatMLFetcher.ts (FREE via proxy)
├── execute_tool Read (INTERNAL)         ← toolHooks.ts PreToolUse/PostToolUse [NEW]
├── chat claude-sonnet-4 (CLIENT)        ← chatMLFetcher.ts
├── execute_tool Edit (INTERNAL)
└── ...

Claude subprocess exports independently (to same endpoint):
  [metrics] claude_code.token.usage, claude_code.cost.usage, ...
  [events]  claude_code.tool_result, claude_code.api_request, ...
```

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

Tool spans: `PreToolUse` hook creates `execute_tool` span → `PostToolUse` hook ends it. Spans parent to the `invoke_agent` span via active context.

---

## 7. Data Completeness Matrix

| Signal | Foreground | Copilot CLI in-process | Copilot CLI terminal | Claude Code |
|---|---|---|---|---|
| `invoke_agent` span | ✅ | ✅ (ext wrapper + SDK internal) | ✅ (SDK) | ✅ (ext) |
| `chat` span per LLM call | ✅ | ✅ (SDK) | ✅ (SDK) | ✅ (chatMLFetcher via proxy) |
| `execute_tool` span | ✅ | ✅ (SDK) | ✅ (SDK) | ✅ (ext, from hooks) |
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
| Two OTel SDK instances in same process (copilotcli) | Span parenting confusion | SDK uses W3C propagator (HTTP), extension uses AsyncLocalStorage (in-process) — independent |
| `process.env` mutation for CLI SDK config | Affects extension host | Only set OTel-specific vars when enabled; set before SDK ctor; don't overwrite existing vars |
| Duplicate `invoke_agent` spans (copilotcli) | Visual noise in trace viewer | Different `service.name` + distinct attribute namespaces; document in user guide |
| `chatMLFetcher` chat spans for Claude need active parent | Orphaned spans | `runWithTraceContext()` bridges HTTP handler boundary |
| Claude subprocess OTel creates separate connection | Extra resources | Acceptable; subprocess lifecycle is independent |
| SDK OTel internals may change | Breaking on SDK update | `OtelLifecycle` is in published `.d.ts`; `SessionOptions.traceparent` is documented API |
| File exporter not supported by Claude SDK | Inconsistent in file mode | Document limitation; Claude metrics/events only available via OTLP |

---

## 9. Future Work (Out of Scope)

- **Layer B (SDK request IDs)**: Copilot CLI SDK exposes `X-Request-Id` / `X-GitHub-Request-ID` from CAPI responses for server-side correlation
- **Layer C (SDK TracerProvider)**: Copilot CLI SDK accepts `TracerProvider` directly (no env var dance)
- **Claude SDK native traces**: If Claude Code adds native traces, extension delegates instead of creating them
- **Per-agent VS Code settings**: If user demand arises for separate enable/endpoint per agent
- **OTel Collector**: If attribute normalization across agent namespaces becomes required
