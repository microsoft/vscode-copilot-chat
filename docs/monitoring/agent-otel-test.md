# OTel Instrumentation — Manual Test Plan

> **PR**: [#4507](https://github.com/microsoft/vscode-copilot-chat/pull/4507)
> **Spec**: [agent-otel-spec.md](agent-otel-spec.md)
> **Last Updated**: 2026-03-18

---

## Prerequisites

### Local OTel Stack (Aspire Dashboard)

```bash
docker run --rm -d \
  -p 18888:18888 \
  -p 4317:18889 \
  --name aspire-dashboard \
  mcr.microsoft.com/dotnet/aspire-dashboard:latest
```

- Dashboard UI: http://localhost:18888
- OTLP gRPC endpoint: `localhost:4317`

### VS Code Configuration (for all tests unless noted)

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "otlp-grpc",
  "github.copilot.chat.otel.otlpEndpoint": "http://localhost:4317"
}
```

### Teardown

```bash
docker stop aspire-dashboard
```

---

## Test Matrix

### A. Foreground Agent (baseline — already working)

| # | Scenario | Steps | Expected | Config |
|---|----------|-------|----------|--------|
| A1 | Basic agent mode request | 1. Open Copilot Chat in Agent mode<br>2. Send "List files in this directory"<br>3. Wait for completion | Aspire shows `invoke_agent copilot` span with child `chat` and `execute_tool` spans | Settings: OTel enabled, gRPC |
| A2 | Subagent trace propagation | 1. Agent mode<br>2. Send prompt that triggers `@Explore` subagent<br>3. Wait for completion | Aspire shows nested `invoke_agent Explore` under `execute_tool runSubagent` | Settings: OTel enabled |
| A3 | Error handling | 1. Agent mode<br>2. Trigger a request that causes an error (e.g., cancel mid-stream) | Error span with `SpanStatusCode.ERROR` visible in Aspire | Settings: OTel enabled |

### B. Copilot CLI Background Agent (in-process SDK)

| # | Scenario | Steps | Expected | Config |
|---|----------|-------|----------|--------|
| B1 | Basic CLI session | 1. Open Copilot Chat<br>2. Start a Copilot CLI session (background agent)<br>3. Send "What files are in this project?"<br>4. Wait for completion | Aspire shows:<br>- `invoke_agent copilotcli` span (extension wrapper)<br>- SDK's `invoke_agent` span as child (if SDK OTel activated)<br>- SDK's `chat` and `execute_tool` spans | Settings: OTel enabled, gRPC |
| B2 | Tool execution spans | 1. CLI session<br>2. Send "Read the contents of package.json"<br>3. Wait for tool to execute | `execute_tool` span(s) visible with tool name, arguments, result | Settings: OTel enabled |
| B3 | Token usage on spans | 1. CLI session<br>2. Send any prompt<br>3. Check span attributes | `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` set on span | Settings: OTel enabled |
| B4 | Error session | 1. CLI session<br>2. Trigger an error (e.g., invalid model, network disconnect)<br>3. Check spans | `invoke_agent copilotcli` span has ERROR status | Settings: OTel enabled |
| B5 | OTel disabled — no spans | 1. Disable OTel in settings<br>2. Run a CLI session<br>3. Check Aspire | No new spans appear in Aspire from the CLI session | Settings: OTel **disabled** |
| B6 | File exporter mode | 1. Set `COPILOT_OTEL_FILE_EXPORTER_PATH=/tmp/cli-otel.jsonl`<br>2. Run a CLI session<br>3. Check file | File contains `invoke_agent` spans with correct attributes | Env var: file exporter |
| B7 | Env var override | 1. Set `COPILOT_OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317` as env vars<br>2. Don't set any VS Code settings<br>3. Run CLI session | Spans appear in Aspire (env vars take precedence) | Env vars only |
| B8 | Content capture | 1. Enable `captureContent`<br>2. Run CLI session<br>3. Check span attributes | `gen_ai.input.messages` and `gen_ai.output.messages` populated on spans | Settings: OTel + captureContent |

### C. Copilot CLI Terminal ("New Copilot CLI Session")

| # | Scenario | Steps | Expected | Config |
|---|----------|-------|----------|--------|
| C1 | Terminal session with OTel | 1. Enable OTel in settings<br>2. Chat menu → "New Copilot CLI Session"<br>3. Send a prompt in the terminal<br>4. Check Aspire | Independent root `invoke_agent` span from the CLI binary (service.name = `github-copilot`) | Settings: OTel enabled, gRPC |
| C2 | Terminal session — env forwarded | 1. Enable OTel in settings<br>2. Open "New Copilot CLI Session"<br>3. In the terminal, run `env | grep COPILOT_OTEL` | `COPILOT_OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` are set | Settings: OTel enabled |
| C3 | Terminal session — OTel disabled | 1. Disable OTel in settings<br>2. Open "New Copilot CLI Session"<br>3. Run `env | grep COPILOT_OTEL` | No `COPILOT_OTEL_ENABLED` in env | Settings: OTel **disabled** |
| C4 | Terminal traces are independent | 1. Enable OTel<br>2. Run a foreground agent request AND a terminal CLI session simultaneously<br>3. Check Aspire | Terminal CLI traces have different `service.name` (`github-copilot`) and are NOT children of foreground agent spans | Settings: OTel enabled |

### D. Debug Panel (Agent Debug Log)

| # | Scenario | Steps | Expected | Config |
|---|----------|-------|----------|--------|
| D1 | Debug panel shows CLI spans | 1. Open a Copilot CLI session<br>2. Send a prompt<br>3. Open Agent Debug Log panel | Debug panel shows user_message, chat, execute_tool entries for the CLI session | Settings: OTel **disabled** (debug panel works regardless) |
| D2 | Debug panel shows Claude spans | 1. Open a Claude Code session<br>2. Send a prompt<br>3. Open Agent Debug Log panel | Debug panel shows user_message, execute_tool entries for the Claude session | Settings: OTel **disabled** |
| D3 | Debug panel spans NOT in export | 1. Enable OTel (gRPC to Aspire)<br>2. Run a CLI or Claude session<br>3. Check Aspire traces | Aspire does NOT show `content_event` or `user_message` operation names.<br>Only `invoke_agent`, `chat`, `execute_tool` appear. | Settings: OTel enabled, gRPC |
| D4 | Debug panel + OTel both work | 1. Enable OTel<br>2. Run a CLI session<br>3. Check both Aspire AND Debug panel | Both show data. Debug panel has all spans (including debug-only). Aspire only has GenAI-conventional spans. | Settings: OTel enabled |
| D5 | Debug panel for foreground agent | 1. Run a foreground agent request<br>2. Open Agent Debug Log | Debug panel shows the same span hierarchy as Aspire (user messages, model turns, tool calls) | Settings: OTel enabled |

### E. Configuration & User Experience

| # | Scenario | Steps | Expected | Config |
|---|----------|-------|----------|--------|
| E1 | Kill switch: telemetry off | 1. Set `telemetry.telemetryLevel` to `off`<br>2. Enable OTel settings<br>3. Run any agent | No spans exported to Aspire. OTel is fully disabled. | telemetry.telemetryLevel=off |
| E2 | Settings take effect on restart | 1. Start VS Code with OTel disabled<br>2. Enable OTel in settings<br>3. Run an agent<br>4. Check Aspire | No spans (config resolved at activation). Restart VS Code → spans appear. | Settings change mid-session |
| E3 | Env vars override settings | 1. Set `github.copilot.chat.otel.enabled = false` in settings<br>2. Set `COPILOT_OTEL_ENABLED=true` env var<br>3. Launch VS Code<br>4. Run any agent | Spans appear in Aspire (env var overrides setting) | Settings: disabled, Env: enabled |
| E4 | Per-agent env var override | 1. Enable OTel in settings<br>2. Set `CLAUDE_CODE_ENABLE_TELEMETRY=0` in env<br>3. Run both CLI and Claude sessions | CLI spans appear in Aspire. Claude subprocess does NOT export its own metrics/events. | Settings: enabled, Claude env: disabled |
| E5 | gRPC vs HTTP endpoint | 1. Start Jaeger: `docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest`<br>2. Set endpoint to `http://localhost:4318` with `otlp-http`<br>3. Run agent<br>4. Check Jaeger | Spans appear in Jaeger at http://localhost:16686 | Settings: otlp-http |
| E6 | Console exporter | 1. Set `exporterType: "console"`<br>2. Run agent<br>3. Check Developer Tools console | Span data printed to console output | Settings: console exporter |
| E7 | Invalid endpoint | 1. Set endpoint to `http://localhost:9999` (nothing listening)<br>2. Run agent<br>3. Check extension behavior | Extension works normally. Warning logged: `[OTel] Span export failed`. No crash. | Settings: bad endpoint |
| E8 | OTel service.name filtering | 1. Enable OTel<br>2. Run foreground + CLI + terminal sessions<br>3. In Aspire, filter by service.name | `copilot-chat` shows foreground + CLI wrapper spans. `github-copilot` shows SDK/terminal spans. | Settings: OTel enabled |

### F. Cross-Agent Correlation

| # | Scenario | Steps | Expected | Config |
|---|----------|-------|----------|--------|
| F1 | Same trace viewer shows all agents | 1. Enable OTel<br>2. Run foreground agent, then CLI session, then terminal session<br>3. Open Aspire | All three appear as separate traces, each with correct `service.name` and `gen_ai.agent.name` | Settings: OTel enabled |
| F2 | CLI invoke_agent wraps SDK spans | 1. Enable OTel<br>2. Run CLI session with tool calls<br>3. Find the `invoke_agent copilotcli` trace in Aspire | Extension's `invoke_agent copilotcli` span is the root.<br>SDK's `invoke_agent` span is a child (linked via traceparent). | Settings: OTel enabled |

---

## Checklist Summary

### Copilot CLI Background Agent (PR 1 scope)
- [ ] B1: Basic CLI session produces `invoke_agent copilotcli` span
- [ ] B2: Tool execution spans with correct attributes
- [ ] B3: Token usage on spans
- [ ] B4: Error sessions have ERROR status
- [ ] B5: OTel disabled → no spans
- [ ] B6: File exporter works
- [ ] B7: Env var config works
- [ ] B8: Content capture works

### Terminal CLI
- [ ] C1: Terminal produces independent traces
- [ ] C2: OTel env vars forwarded
- [ ] C3: OTel disabled → no env vars
- [ ] C4: Terminal traces are independent from foreground

### Debug Panel Isolation
- [ ] D3: Debug-panel-only spans do NOT appear in OTLP export
- [ ] D4: Debug panel and OTel export both work simultaneously

### User Configuration
- [ ] E1: Kill switch works
- [ ] E2: Settings require restart
- [ ] E3: Env vars override settings
- [ ] E7: Invalid endpoint doesn't crash

### Foreground Agent (regression)
- [ ] A1: Foreground agent still works as before
- [ ] A2: Subagent propagation still works

---

## Notes

- **Aspire Dashboard** is recommended for testing because it receives all signal types (traces, metrics, logs) in a single UI.
- **Jaeger** is good for testing HTTP protocol specifically (test E5).
- For **file exporter** tests, use `cat /tmp/cli-otel.jsonl | python3 -m json.tool` to inspect spans.
- **service.name** values to look for: `copilot-chat` (extension), `github-copilot` (CLI SDK/terminal).
- Terminal CLI `env` printout (tests C2/C3) may require running `printenv | grep OTEL` inside the terminal.
