# OTel Instrumentation Comparison: Copilot Chat vs Claude Code vs Gemini CLI

A feature-by-feature comparison of OpenTelemetry instrumentation across three AI coding tools.

**References:**
- [Claude Code — Monitoring Usage](https://code.claude.com/docs/en/monitoring-usage)
- [Gemini CLI — Observability with OpenTelemetry](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md)
- [Copilot Chat — Agent Monitoring](./agent_monitoring.md)

---

## Feature Matrix

| Feature | Copilot Chat | Claude Code | Gemini CLI |
|---|:---:|:---:|:---:|
| **Traces / Spans** | Full hierarchy (`invoke_agent` → `chat` → `execute_tool`) | None | Flat spans (no parent-child) |
| **GenAI Semantic Conventions** | `gen_ai.*` standard attributes | Custom `claude_code.*` namespace only | `gen_ai.*` + custom `gemini_cli.*` |
| **Span parent-child relationships** | Yes — automatic context propagation | N/A | No nested spans |
| **Metrics** | Histograms + counters | Counters only | Histograms + counters |
| **Events / Logs** | Session, tool, agent turn, inference details | User prompt, tool result, API request/error, tool decision | Session, tool, API, file ops, chat compression, model routing, agent, extensions |
| **LLM call spans** | `chat {model}` with full attributes | None | Flat `gen_ai` trace span |
| **Tool execution spans** | `execute_tool {tool_name}` with timing | None (tool_result event only) | None (tool_call log only) |
| **Agent orchestration spans** | `invoke_agent {agent_name}` wrapping all child spans | None | `gemini_cli.agent.start`/`.finish` events (no span) |
| **Time-to-first-token** | `copilot_chat.time_to_first_token` metric + span attribute | Not available | Not available |
| **Token usage (standard)** | `gen_ai.client.token.usage` histogram | `claude_code.token.usage` counter | `gen_ai.client.token.usage` histogram |
| **Token usage details** | input, output, cache_read | input, output, cacheRead, cacheCreation | input, output, thought, cache, tool |
| **Operation duration (standard)** | `gen_ai.client.operation.duration` histogram | Not available | `gen_ai.client.operation.duration` histogram |
| **Content capture** | Full content, no truncation, opt-in | Prompt content opt-in (`OTEL_LOG_USER_PROMPTS`) | Prompt opt-in (`logPrompts`), 160KB truncation limit |
| **Content on spans** | Yes — `gen_ai.input/output.messages` on spans | N/A (no spans) | Yes — on trace spans |
| **File exporter fallback** | JSON-lines file exporter | Not available | JSON-lines file exporter |
| **Console exporter** | Yes | Yes | Not standalone (through collector) |
| **OTLP/HTTP** | Yes (default) | Yes | Yes |
| **OTLP/gRPC** | Yes | Yes | Yes (default) |
| **Prometheus exporter** | Not available | Yes | Not directly (via collector) |
| **VS Code settings UI** | Yes — 5 settings under `github.copilot.chat.otel.*` | N/A (CLI config) | N/A (CLI settings.json) |
| **Env var activation** | `COPILOT_OTEL_ENABLED` or `OTEL_EXPORTER_OTLP_ENDPOINT` | `CLAUDE_CODE_ENABLE_TELEMETRY` | `GEMINI_TELEMETRY_ENABLED` |
| **Per-signal endpoint overrides** | Not yet | Yes (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `..._LOGS_ENDPOINT`) | Not available |
| **Metrics cardinality control** | Not yet | Yes (`OTEL_METRICS_INCLUDE_SESSION_ID`, `..._VERSION`, `..._ACCOUNT_UUID`) | Not available |
| **Export interval controls** | Not yet (fixed 10s metrics) | Yes (`OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_LOGS_EXPORT_INTERVAL`) | Not available |
| **Dynamic auth headers** | `OTEL_EXPORTER_OTLP_HEADERS` (static) | Dynamic headers helper script with refresh | Not available |
| **Event sequence counter** | Not yet | Yes (`event.sequence` on all events) | Not available |
| **Event correlation ID** | Via trace context (traceId / spanId) | `prompt.id` on all events | `prompt_id` on logs |
| **Cost metrics** | Not available (token counts only) | `claude_code.cost.usage` in USD | Not available |
| **Active time tracking** | Not available | `claude_code.active_time.total` | Not available |
| **Lines of code metrics** | Not available | `claude_code.lines_of_code.count` | `gemini_cli.lines.changed` |
| **Git commit/PR metrics** | Not available | `claude_code.commit.count`, `claude_code.pull_request.count` | Not available |
| **File operation tracking** | Not available | Not available | `gemini_cli.file_operation` log + `gemini_cli.file.operation.count` metric |
| **Model routing telemetry** | Not available | Not available | `gemini_cli.model_routing` log + latency metric |
| **Chat compression tracking** | Not available | Not available | `gemini_cli.chat_compression` log + metric |
| **Extension lifecycle tracking** | Not available | Not available | `gemini_cli.extension_install/uninstall/enable/disable` |
| **API error events** | Error status on `chat` span | `claude_code.api_error` event | `gemini_cli.api_error` log |
| **Tool decision events** | Not available | `claude_code.tool_decision` event | Via `decision` attr on tool call |
| **OS/arch resource attrs** | Not yet | Yes (`os.type`, `os.version`, `host.arch`) | Not available |
| **Managed/admin config** | Not yet | Yes (managed settings file) | Not available |
| **Pre-built monitoring dashboard** | Not available | [ROI monitoring guide repo](https://github.com/anthropics/claude-code-monitoring-guide) | Google Cloud Monitoring dashboard template |
| **GCP direct export** | Not available | Not available | Yes (`target: "gcp"`) |
| **Approval mode tracking** | Not available | Not available | `approval_mode_switch`, `approval_mode_duration` |
| **Performance profiling** | Not available | Not available | `gemini_cli.startup.duration`, `gemini_cli.memory.usage`, `gemini_cli.cpu.usage` |
| **Zero overhead when disabled** | Yes (no-op service, no SDK loaded) | Yes | Yes |
| **Buffer + flush on startup** | Yes (buffer until SDK ready, flush on shutdown) | Yes | Yes |

---

## Where Copilot Chat Is Superior

1. **Full trace hierarchy**: The only tool with true parent-child span relationships. See exactly how an agent invocation decomposes into LLM calls and tool executions in Jaeger/Grafana. Claude Code has no traces. Gemini CLI has flat traces.

2. **GenAI semantic convention compliance**: Uses standard `gen_ai.*` attributes per the OTel spec. Claude Code uses a custom `claude_code.*` namespace for metrics/events that doesn't follow the convention.

3. **Span-level content capture**: Full prompt/response content is captured directly on spans (not just as separate events), enabling inspection of any span in Jaeger to see the exact messages that were sent and received.

4. **Time-to-first-token metric**: Dedicated `copilot_chat.time_to_first_token` histogram for monitoring perceived latency — neither Claude Code nor Gemini CLI provide this.

5. **Agent turn-level metrics**: `copilot_chat.agent.turn.count` and `copilot_chat.agent.invocation.duration` histograms give statistical distributions, not just counts.

6. **VS Code settings integration**: Configuration via the native VS Code settings UI, with markdown descriptions and type validation. CLI tools can only use environment variables or config files.

7. **No content truncation**: When content capture is enabled, full messages are recorded without truncation. Gemini CLI applies a 160KB global limit with fair-share truncation.

8. **Cross-boundary trace propagation**: Automatic context propagation across subagent invocations, so child agent activities appear under the same trace.

---

## What's Missing vs Claude Code

| Feature | Status | Notes |
|---|---|---|
| Per-signal OTLP endpoint overrides | Planned | `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` |
| Metrics cardinality control | Planned | `OTEL_METRICS_INCLUDE_SESSION_ID`, `OTEL_METRICS_INCLUDE_VERSION` |
| Configurable export intervals | Planned | `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_LOGS_EXPORT_INTERVAL` |
| `event.sequence` counter | Planned | Monotonic counter for ordering events without clock sync |
| Cost metrics | Not planned | Token counts are exported; cost is a backend concern |
| Active time tracking | Not planned | VS Code-specific; different interaction model than CLI |
| Lines of code metrics | Not planned | Available via VS Code SCM API separately |
| Commit/PR counters | Not planned | Available via VS Code Git extension |
| Tool decision events | Not planned | VS Code handles tool permissions via extension API |
| Dynamic auth header scripts | Not planned | Use `OTEL_EXPORTER_OTLP_HEADERS` for static headers |
| OS/arch resource attributes | Planned | `os.type`, `os.version`, `host.arch` |
| Managed settings (admin config) | Not planned | Enterprise config handled via VS Code policies |
| Prometheus exporter | Not planned | Use OTLP → Prometheus via collector |

---

## What's Missing vs Gemini CLI

| Feature | Status | Notes |
|---|---|---|
| File operation tracking | Not planned | Different architecture — tools already tracked via `execute_tool` spans |
| Model routing telemetry | Not planned | Copilot uses server-side model routing |
| Chat compression tracking | Not planned | Context management differs in VS Code |
| Extension lifecycle events | Not planned | VS Code has its own extension telemetry |
| Performance profiling (CPU/memory) | Not planned | VS Code has its own performance profiling tools |
| Startup duration metrics | Not planned | Extension activation timing available via VS Code dev tools |
| GCP direct export | Not planned | Use OTLP exporters with any backend |
| Approval mode tracking | Not applicable | Different permission model |
| Pre-built monitoring dashboard | Not yet | Consider creating dashboard templates |
