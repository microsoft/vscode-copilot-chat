# OTel Instrumentation for All Agents — Implementation Plan

> **Spec**: [agent-otel-spec.md](agent-otel-spec.md)
> **Issue**: [microsoft/vscode#298832](https://github.com/microsoft/vscode/issues/298832)
> **Last Updated**: 2026-03-18

---

## Overview

Instrument all agent execution paths in VS Code Copilot Chat with OTel traces, achieving parity with the foreground agent's span hierarchy. Single user configuration point drives all agents.

**Delivery**: Three isolated PRs, each shippable independently.

| PR | Scope | Branch | Owner |
|---|---|---|---|
| **PR 1** | Copilot CLI OTel (in-process + terminal) | `zhichli/cliOtel` | @zhichli |
| **PR 2** | Claude Code OTel (traces + subprocess metrics) | TBD | TBD |
| **PR 3** | Documentation updates | TBD (or folded into PR 1/2) | TBD |

---

## PR 1: Copilot CLI OTel

**Branch**: `zhichli/cliOtel`

### PR 1 — Task A: Config derivation helper

- **Files**: New `src/platform/otel/common/agentOTelEnv.ts`
- **What**: Create `deriveCopilotCliOTelEnv(config: OTelConfig)` that maps from the extension's resolved `OTelConfig` to CLI-specific env vars. Also create `deriveClaudeOTelEnv(config: OTelConfig)` (placed here for future PR 2 to consume).
- **Design principle**: Never overwrite env vars the user has set explicitly (`if (!process.env[key])` guard).
- **Validation**: Unit test in `src/platform/otel/common/test/agentOTelEnv.spec.ts` with enabled/disabled configs, file exporter, gRPC vs HTTP, capture content, and existing env var override scenarios.

```typescript
export function deriveCopilotCliOTelEnv(config: OTelConfig): Record<string, string>;
export function deriveClaudeOTelEnv(config: OTelConfig): Record<string, string>;
```

### PR 1 — Task B: Enable SDK OTel on LocalSessionManager

- **Files**: `src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts`
- **What**: Inject `IOTelService`. Before `new internal.LocalSessionManager(...)`, if `otelService.config.enabled`, spread `deriveCopilotCliOTelEnv(config)` into `process.env`. The SDK ctor reads env vars and creates `OtelLifecycle`.
- **Validation**: After construction, `sessionManager.otel?.enabled === true` when extension OTel is enabled.

### PR 1 — Task C: Extension wrapper `invoke_agent copilotcli` span + traceparent

- **Files**: `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`, `src/extension/chatSessions/copilotcli/node/copilotCli.ts`
- **What**:
  1. Inject `IOTelService` into `CopilotCLISession`.
  2. In `_handleRequestImpl()`, wrap the body in `startActiveSpan('invoke_agent copilotcli', { kind: SpanKind.INTERNAL, attributes: { gen_ai.operation.name, gen_ai.agent.name, copilot_chat.session_id, copilot_chat.chat_session_id, gen_ai.request.model } })`.
  3. Inject the span's trace context via `sessionManager.otel?.updateParentTraceContext(sessionId, traceparent)` so SDK's internal spans become children.
  4. On `session.error`, set `span.setStatus(SpanStatusCode.ERROR)`.
  5. End span on request completion.
- **In copilotCli.ts**: Add optional `traceparent`/`tracestate` to `toSessionOptions()` for `SessionOptions`.
- **Validation**: SDK's internal `invoke_agent` / `chat` / `execute_tool` spans appear as children of the extension's wrapper span in trace output.

### PR 1 — Task D: Extension-side metrics from SDK events

- **Files**: `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`
- **What**: In existing event handlers:
  - `assistant.usage` → accumulate token counts on `invoke_agent` span attributes, record `GenAiMetrics.recordTokenUsage()`
  - `tool.execution_start` / `tool.execution_complete` → record `GenAiMetrics.recordToolCallCount()`, `recordToolCallDuration()`, `emitToolCallEvent()`
  - `session.error` → `span.setStatus(ERROR)`, `span.setAttribute(StdAttr.ERROR_TYPE, errorType)`
- **Validation**: Extension-side metrics augment SDK's own OTel data; verify in file exporter output.

### PR 1 — Task E: Forward OTel env vars to terminal CLI sessions

- **Files**: `src/extension/chatSessions/vscode-node/copilotCLITerminalIntegration.ts`
- **What**: In `getCommonTerminalOptions()`, accept resolved `OTelConfig`. If enabled, spread `deriveCopilotCliOTelEnv(config)` into `options.env` alongside `GH_TOKEN` / `COPILOT_GITHUB_TOKEN`.
- **Note**: Terminal CLI traces are independent root traces — no parent link to extension spans.
- **Validation**: Open "New Copilot CLI Session" with OTel enabled → verify `COPILOT_OTEL_ENABLED` and `OTEL_EXPORTER_OTLP_ENDPOINT` are in the terminal's env → verify spans appear in collector.

### PR 1 — Task F: Unit tests for Copilot CLI OTel

- **Files**: New `src/extension/chatSessions/copilotcli/node/test/copilotcliOtel.spec.ts`
- **What**: Mock `IOTelService`. Verify:
  - Wrapper `invoke_agent` span created and ended around `handleRequest`
  - `traceparent` passed to SDK via `otel.updateParentTraceContext()`
  - Token usage metrics recorded from `assistant.usage` events
  - Tool call metrics recorded from `tool.execution_*` events
  - Error events set span ERROR status
  - No spans created when OTel is disabled (noop `IOTelService`)

### PR 1 — Files Changed

| File | Change |
|---|---|
| `src/platform/otel/common/agentOTelEnv.ts` | **NEW** — Env var derivation helpers |
| `src/platform/otel/common/test/agentOTelEnv.spec.ts` | **NEW** — Unit tests for helpers |
| `src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts` | Inject `IOTelService`, set env vars before SDK init |
| `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts` | Inject `IOTelService`, wrapper span, traceparent, event-based metrics |
| `src/extension/chatSessions/copilotcli/node/copilotCli.ts` | Add `traceparent`/`tracestate` to `toSessionOptions()` |
| `src/extension/chatSessions/vscode-node/copilotCLITerminalIntegration.ts` | Forward OTel env vars to terminal sessions |
| `src/extension/chatSessions/copilotcli/node/test/copilotcliOtel.spec.ts` | **NEW** — CLI OTel tests |

---

## PR 2: Claude Code OTel

**Branch**: TBD (separate from PR 1)
**Dependency**: Consumes `deriveClaudeOTelEnv()` from PR 1's `agentOTelEnv.ts`.

### PR 2 — Task A: `invoke_agent claude` span in ClaudeCodeSession

- **Files**: `src/extension/chatSessions/claude/node/claudeCodeAgent.ts`
- **What**: Inject `IOTelService`. Wrap the query lifecycle (`_processMessages` loop) in `startActiveSpan('invoke_agent claude', { kind: SpanKind.INTERNAL, attributes: { gen_ai.operation.name, gen_ai.agent.name, copilot_chat.session_id, gen_ai.request.model } })`. On error, `span.setStatus(ERROR)`. On completion, `span.end()`.
- **Validation**: Enable OTel file exporter → run Claude session → verify `invoke_agent claude` span in output.

### PR 2 — Task B: Bridge span context to ClaudeLanguageModelServer

- **Files**: `src/extension/chatSessions/claude/node/claudeLanguageModelServer.ts`, `src/extension/chatSessions/claude/node/claudeSessionStateService.ts`
- **What**: Store the `invoke_agent` span's `TraceContext` in `IClaudeSessionStateService` keyed by sessionId. In `handleAuthedMessagesRequest()`, retrieve it and wrap `makeChatRequest2()` in `IOTelService.runWithTraceContext()`.
- **Why**: Makes `chatMLFetcher`'s `chat {model}` spans auto-parent to `invoke_agent claude` via AsyncLocalStorage.
- **Validation**: Verify `chat claude-sonnet-4` spans appear as children of `invoke_agent claude`.

### PR 2 — Task C: `execute_tool` spans from Claude hooks

- **Files**: `src/extension/chatSessions/claude/node/hooks/toolHooks.ts`
- **What**:
  - `PreToolUse` hook: create `execute_tool {tool_name}` span via `IOTelService.startSpan()`, store in `Map<tool_use_id, ISpanHandle>`
  - `PostToolUse` hook: retrieve span, set attributes (tool name, success, duration), record metrics (`GenAiMetrics.recordToolCallCount`, `recordToolCallDuration`), emit `emitToolCallEvent`, then `span.end()`
  - `PostToolUseFailure` hook: retrieve span, `setStatus(ERROR)`, `recordException()`, end span
- **Validation**: Tool calls produce `execute_tool` spans nested under `invoke_agent`.

### PR 2 — Task D: Forward OTel config to Claude subprocess

- **Files**: `src/extension/chatSessions/claude/node/claudeCodeAgent.ts`
- **What**: When building subprocess env, if `otelService.config.enabled`, spread `deriveClaudeOTelEnv(config)` into the env block. This enables Claude SDK's metrics and events export (`claude_code.token.usage`, `claude_code.tool_result`, etc.).
- **Note**: File exporter mode is not supported by Claude SDK — skip `COPILOT_OTEL_FILE_EXPORTER_PATH`.
- **Validation**: With OTel enabled, verify Claude subprocess receives `CLAUDE_CODE_ENABLE_TELEMETRY=1` and correct `OTEL_*` vars.

### PR 2 — Task E: Unit tests for Claude OTel

- **Files**: New `src/extension/chatSessions/claude/node/test/claudeOtel.spec.ts`
- **What**: Mock `IOTelService`. Verify:
  - `invoke_agent claude` span created/ended
  - Trace context stored in session state service
  - `execute_tool` spans created from Pre/PostToolUse hooks
  - Error handling (PostToolUseFailure sets ERROR)
  - Subprocess env var derivation
  - No spans when OTel disabled

### PR 2 — Files Changed

| File | Change |
|---|---|
| `src/extension/chatSessions/claude/node/claudeCodeAgent.ts` | Inject `IOTelService`, `invoke_agent` span, subprocess OTel env |
| `src/extension/chatSessions/claude/node/claudeLanguageModelServer.ts` | Retrieve trace context, wrap requests in `runWithTraceContext` |
| `src/extension/chatSessions/claude/node/claudeSessionStateService.ts` | Store/retrieve `TraceContext` per session |
| `src/extension/chatSessions/claude/node/hooks/toolHooks.ts` | Create `execute_tool` spans in Pre/PostToolUse hooks |
| `src/extension/chatSessions/claude/node/test/claudeOtel.spec.ts` | **NEW** — Claude OTel tests |

---

## PR 3: Documentation

**Branch**: TBD (can fold into PR 1 or PR 2)

### PR 3 — Task A: Update monitoring architecture docs

- **File**: `docs/monitoring/agent_monitoring_arch.md`
- **What**: Add "Background Agents" section covering:
  - Asymmetric architecture (why copilotcli leverages SDK, claude creates ext-side spans)
  - Span hierarchy diagrams for each agent
  - Attribute namespace differences (`copilot_chat.*` vs `github.copilot.*` vs `claude_code.*`)
  - Trace context propagation patterns
  - Known limitations (duplicate `invoke_agent` for copilotcli, no file exporter for Claude, terminal CLI independent traces)

### PR 3 — Task B: Update user-facing monitoring guide

- **File**: `docs/monitoring/agent_monitoring.md`
- **What**: Add section "Background Agent Monitoring" covering:
  - That the same settings/env vars enable OTel for all agents automatically
  - What users see in their trace viewer (multiple `service.name` values)
  - How to filter by agent type
  - Terminal CLI traces are independent
  - Per-agent override via env vars

### PR 3 — Files Changed

| File | Change |
|---|---|
| `docs/monitoring/agent_monitoring_arch.md` | Add background agent architecture section |
| `docs/monitoring/agent_monitoring.md` | Add background agent user guide section |

---

## Execution Order

```
PR 1 (Copilot CLI) ← current branch, start immediately
  Task A (config helper) → Task B (SDK OTel enable) → Task C (wrapper span + traceparent)
  Task D (event metrics) — parallel with Task C
  Task E (terminal env) — parallel with Task C
  Task F (tests) — after C, D, E

PR 2 (Claude Code) ← separate branch, can start after PR 1 merges (uses agentOTelEnv.ts)
  Task A (invoke_agent) → Task B (context bridge) → Task C (tool spans)
  Task D (subprocess env) — parallel with Task A
  Task E (tests) — after A, B, C, D

PR 3 (Docs) ← can start any time, merge after PR 1 and/or PR 2
  Task A + Task B — parallel
```

---

## Validation Checklist

### Copilot CLI (PR 1)

- [ ] Enable `github.copilot.chat.otel.enabled` → foreground + CLI both produce spans
- [ ] `invoke_agent copilotcli` span wraps SDK's internal spans in trace viewer
- [ ] SDK's `chat` and `execute_tool` spans appear as children via `traceparent`
- [ ] Token usage and tool metrics appear on extension-side span
- [ ] Error sessions produce spans with ERROR status
- [ ] "New Copilot CLI Session" terminal receives OTel env vars
- [ ] Terminal CLI produces independent root traces
- [ ] File exporter mode works for CLI
- [ ] Existing user env vars are not overwritten
- [ ] OTel disabled → no spans, no env var mutation, zero overhead

### Claude Code (PR 2)

- [ ] `invoke_agent claude` span wraps full session lifecycle
- [ ] `chat claude-sonnet-4` spans from `chatMLFetcher` auto-parent to `invoke_agent`
- [ ] `execute_tool` spans from hooks nest correctly
- [ ] Subprocess receives `CLAUDE_CODE_ENABLE_TELEMETRY=1` and `OTEL_*` vars
- [ ] Claude metrics (`claude_code.token.usage`, etc.) appear in collector
- [ ] Error sessions produce spans with ERROR status
- [ ] OTel disabled → no spans, no env var mutation
