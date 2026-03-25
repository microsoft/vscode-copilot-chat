# OTel → ATIF: Unified Trajectory Export Architecture

> **Status**: Proposal
> **Author**: @zhichli
> **Date**: 2026-03-24
> **Related**: [vscode#294050](https://github.com/microsoft/vscode/issues/294050) (trajectory logger memory leak)

## Problem Statement

Three interconnected problems motivate this work:

1. **No ATIF trajectories for background agent (CLI)**: The copilot CLI runtime SDK emits OTel spans natively, but these are not converted to ATIF format. The MSBench platform and eval-ext analysis both expect ATIF `trajectory.json`. Currently, background agent evaluations produce empty or degraded trajectory data.

2. **Trajectory logger causes memory leaks**: The `TrajectoryLoggerAdapter` maintains unbounded `processedEntries`, `processedToolCalls`, `lastUserMessageBySession`, and `requestToStepContext` Maps/Sets that grow indefinitely. A user ETW trace showed **735MB** held by the trajectory logger Map ([vscode#294050](https://github.com/microsoft/vscode/issues/294050#issuecomment-4036381440)).

3. **Dual data pipelines**: Today we maintain two parallel capture systems—`RequestLogger → TrajectoryLoggerAdapter → TrajectoryLogger` (ATIF) and `IOTelService` (OTel spans)—that capture overlapping data. This is redundant, hard to maintain, and the source of the memory issues.

## Current Architecture — Full Data Flow Map

### Agent Instrumentation Sources (4 agent types)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        AGENT INSTRUMENTATION LAYER                              │
│                                                                                 │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Foreground Agent │  │ CLI In-Process   │  │ CLI Terminal │  │ Claude Code │ │
│  │ (toolCallingLoop)│  │ (copilotcli SDK) │  │ (subprocess) │  │ (subprocess)│ │
│  │                  │  │                  │  │              │  │             │ │
│  │ Creates spans    │  │ SDK creates own  │  │ Own OTel SDK │  │ Own OTel    │ │
│  │ directly via     │  │ spans, bridged   │  │ exports to   │  │ (no bridge) │ │
│  │ IOTelService     │  │ via BridgeSpan-  │  │ OTLP endpoint│  │ Synthetic   │ │
│  │                  │  │ Processor →      │  │ (independent │  │ spans from  │ │
│  │ Also produces    │  │ IOTelService     │  │  traces)     │  │ msg loop    │ │
│  │ RequestLogger    │  │                  │  │              │  │             │ │
│  │ entries (legacy) │  │ No RequestLogger │  │ No bridge    │  │ No bridge   │ │
│  └────────┬─────────┘  └────────┬─────────┘  └──────┬───────┘  └──────┬──────┘ │
│           │                     │                    │                 │        │
│           │  OTel spans         │  OTel spans        │ OTel spans     │ spans  │
│           │  + RequestLogger    │  (via bridge)      │ (standalone)   │        │
└───────────┼─────────────────────┼────────────────────┼─────────────────┼────────┘
            │                     │                    │                 │
            └──────────┬──────────┘                    │                 │
                       │ (in-process)                  │ (out-of-proc)  │
                       ▼                               ▼                 ▼
```

### Data Capture Layer (extension host process)

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │                        EXTENSION HOST PROCESS                                │
 │                                                                              │
 │  ┌──────────────────────────────────────────────────────────────────────────┐│
 │  │  IOTelService  (InMemoryOTelService or NodeOTelService)                 ││
 │  │  ├─ invoke_agent spans    ├─ chat spans       ├─ execute_tool spans     ││
 │  │  ├─ execute_hook spans    ├─ content_event    └─ user_message events    ││
 │  │  │                                                                      ││
 │  │  │  Events:                                                             ││
 │  │  │  ├─ onDidCompleteSpan: Event<ICompletedSpanData>                     ││
 │  │  │  └─ onDidEmitSpanEvent: Event<ISpanEventData>                        ││
 │  │  └──────────────────────────────────────────────────────────────────────┘│
 │  │                    │                                                      │
 │  │     ┌──────────────┼──────────────┬──────────────┬──────────────┐        │
 │  │     │              │              │              │              │        │
 │  │     ▼              ▼              ▼              ▼              ▼        │
 │  │                                                                          │
 │  │  ┌── STORE ① ──┐ ┌── STORE ② ──┐ ┌── STORE ③ ─┐ ┌── STORE ④ ────────┐ │
 │  │  │DebugLog     │ │DebugFile    │ │ FileSpan   │ │ TrajectoryLogger  │ │
 │  │  │Provider     │ │LoggerSvc    │ │ Exporter   │ │ Adapter ⚠️ LEAKS  │ │
 │  │  │(in-memory)  │ │(JSONL disk) │ │(JSONL disk)│ │ (in-memory)       │ │
 │  │  ├─────────────┤ ├─────────────┤ ├────────────┤ ├───────────────────┤ │
 │  │  │ICompleted   │ │IDebugLog    │ │ReadableSpan│ │RequestLogger      │ │
 │  │  │SpanData[]   │ │Entry{}      │ │ JSON       │ │→ ITrajectoryStep[]│ │
 │  │  │(≤10K spans) │ │per-session  │ │(raw OTel)  │ │per-session Map    │ │
 │  │  │             │ │.jsonl files │ │single file │ │                   │ │
 │  │  │Bounded      │ │Buffered +   │ │Append-only │ │UNBOUNDED ⚠️      │ │
 │  │  │evicts oldest│ │auto-flush 4s│ │stream      │ │Sets/Maps grow     │ │
 │  │  │sessions     │ │             │ │            │ │indefinitely       │ │
 │  │  └──────┬──────┘ └──────┬──────┘ └──────┬─────┘ └──────┬────────────┘ │
 │  │         │               │               │              │               │
 │  │         │               │               │              │               │
 │  │  ┌── EXPORT ─────────────────────────────────────────────────────────┐  │
 │  │  │      │               │               │              │             │  │
 │  │  │      ▼               ▼               ▼              ▼             │  │
 │  │  │                                                                   │  │
 │  │  │ OTLP Export   (opt-in, via BatchSpanProcessor → OTLP gRPC/HTTP)  │  │
 │  │  │ → App Insights / Jaeger / Tempo / OTel Collector                  │  │
 │  │  │                                                                   │  │
 │  │  └──────────────────────────────────────────────────────────────────┘  │
 │  │                                                                        │
 │  └────────────────────────────────────────────────────────────────────────┘│
 └──────────────────────────────────────────────────────────────────────────────┘
```

### Consumers (who reads which store?)

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                              CONSUMERS                                      │
 │                                                                             │
 │  ┌─ FROM STORE ① (OTelChatDebugLogProvider, in-memory) ──────────────────┐ │
 │  │                                                                        │ │
 │  │  ┌──────────────────────────┐    ┌──────────────────────────────────┐  │ │
 │  │  │ VS Code Debug Panel      │    │ Debug Log Export (OTLP JSON)    │  │ │
 │  │  │ (ChatDebugEditor)        │    │ (provideChatDebugLogExport)     │  │ │
 │  │  │                          │    │                                  │  │ │
 │  │  │ API: ChatDebugLogProvider│    │ User clicks "Export" → OTLP     │  │ │
 │  │  │ • provideChatDebugLog()  │    │ JSON file with spans + metadata │  │ │
 │  │  │   → streams events       │    │                                  │  │ │
 │  │  │ • resolveChatDebugLog-   │    │ Also supports Import:           │  │ │
 │  │  │   Event() → lazy detail  │    │ OTLP JSON → in-memory spans    │  │ │
 │  │  │                          │    │                                  │  │ │
 │  │  │ Shows: timeline, flow-   │    └──────────────────────────────────┘  │ │
 │  │  │ chart, event tree, detail│                                          │ │
 │  │  └──────────────────────────┘                                          │ │
 │  └────────────────────────────────────────────────────────────────────────┘ │
 │                                                                             │
 │  ┌─ FROM STORE ② (ChatDebugFileLoggerService, JSONL on disk) ────────────┐ │
 │  │                                                                        │ │
 │  │  ┌──────────────────────────────────────────────────────────────────┐  │ │
 │  │  │ Troubleshoot Skill                                                │  │ │
 │  │  │ (assets/prompts/skills/troubleshoot/SKILL.md)                     │  │ │
 │  │  │                                                                    │  │ │
 │  │  │ Agent reads JSONL files via read_file tool:                        │  │ │
 │  │  │   debug-logs/<sessionId>/main.jsonl                                │  │ │
 │  │  │   debug-logs/<sessionId>/runSubagent-*.jsonl                       │  │ │
 │  │  │                                                                    │  │ │
 │  │  │ Parses IDebugLogEntry lines:                                       │  │ │
 │  │  │   { ts, dur, sid, type, name, spanId, parentSpanId, status, attrs }│  │ │
 │  │  │                                                                    │  │ │
 │  │  │ Uses grep/jq patterns to search for errors, latency, tool issues   │  │ │
 │  │  └──────────────────────────────────────────────────────────────────┘  │ │
 │  └────────────────────────────────────────────────────────────────────────┘ │
 │                                                                             │
 │  ┌─ FROM STORE ③ (FileSpanExporter, raw OTel JSONL) ─────────────────────┐ │
 │  │                                                                        │ │
 │  │  ┌────────────────────────────┐                                        │ │
 │  │  │ Offline Analysis           │  Currently: no structured consumer.    │ │
 │  │  │ (manual / ad-hoc)          │  Raw ReadableSpan JSON lines.          │ │
 │  │  │                            │  Eval harness CAN enable this via      │ │
 │  │  │ Set via env var:           │  COPILOT_OTEL_FILE_EXPORTER_PATH       │ │
 │  │  │ COPILOT_OTEL_FILE_         │  but does not auto-process output.     │ │
 │  │  │ EXPORTER_PATH              │                                        │ │
 │  │  └────────────────────────────┘                                        │ │
 │  └────────────────────────────────────────────────────────────────────────┘ │
 │                                                                             │
 │  ┌─ FROM STORE ④ (TrajectoryLogger, in-memory ATIF) ─────────────────────┐ │
 │  │                                                                        │ │
 │  │  ┌─────────────────────┐  ┌───────────────────┐  ┌──────────────────┐ │ │
 │  │  │ exportTrajectories  │  │ Eval Harness      │  │ Eval-Ext         │ │ │
 │  │  │ VS Code Command     │  │ (MSBench)         │  │ (Analysis)       │ │ │
 │  │  │                     │  │                   │  │                  │ │ │
 │  │  │ Writes ATIF JSON:   │  │ Calls export cmd  │  │ Parses ATIF      │ │ │
 │  │  │ trajectory.json     │──▶ copies to         │──▶ trajectory.json  │ │ │
 │  │  │ + subagent files    │  │ trajectories/     │  │ for grading +    │ │ │
 │  │  │                     │  │                   │  │ visualization    │ │ │
 │  │  │ ⚠️ FOREGROUND ONLY │  │ Also: legacy      │  │                  │ │ │
 │  │  │ CLI has no ATIF!    │  │ transformVSC-     │  │ Also parses      │ │ │
 │  │  │                     │  │ OutputToTrajectory│  │ chat-export-logs │ │ │
 │  │  └─────────────────────┘  └───────────────────┘  └──────────────────┘ │ │
 │  └────────────────────────────────────────────────────────────────────────┘ │
 │                                                                             │
 │  ┌─ FROM OTLP EXPORT (network, opt-in) ──────────────────────────────────┐ │
 │  │                                                                        │ │
 │  │  ┌────────────────────────┐    ┌──────────────────────────────────┐    │ │
 │  │  │ OTel Collector         │    │ App Insights (Azure Monitor)    │    │ │
 │  │  │ (eval harness manages) │───▶│ Kusto queries for telemetry     │    │ │
 │  │  │ localhost:4318         │    │ analysis across eval runs       │    │ │
 │  │  └────────────────────────┘    └──────────────────────────────────┘    │ │
 │  └────────────────────────────────────────────────────────────────────────┘ │
 └─────────────────────────────────────────────────────────────────────────────┘
```

### Per-Agent Coverage Matrix

```
                    Store ①        Store ②        Store ③        Store ④
                    DebugPanel     JSONL Files    FileExporter   ATIF Logger
                    (in-memory)    (disk)         (disk, opt-in) (in-memory)
 ┌─────────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
 │ Foreground      │ ✅ spans     │ ✅ entries   │ ✅ if enabled│ ✅ ATIF      │
 │ Agent           │ via direct   │ via span→    │ via          │ via Request- │
 │                 │ IOTelService │ IDebugLog-   │ FileSpan-    │ Logger→      │
 │                 │              │ Entry convert│ Exporter     │ Adapter      │
 ├─────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
 │ CLI In-Process  │ ✅ spans     │ ✅ entries   │ ✅ if enabled│ ❌ NO ATIF   │
 │ (copilotcli)    │ via Bridge   │ via bridge→  │ via          │ No Request-  │
 │                 │ SpanProcessor│ IOTelService │ FileSpan-    │ Logger for   │
 │                 │ → IOTelSvc   │ → file logger│ Exporter     │ CLI spans    │
 ├─────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
 │ CLI Terminal    │ ❌ separate  │ ❌ separate  │ ❌ separate  │ ❌ NO ATIF   │
 │ (subprocess)    │ process,     │ process,     │ process,     │              │
 │                 │ no bridge    │ no bridge    │ own exporter │              │
 ├─────────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
 │ Claude Code     │ ✅ synthetic │ ✅ entries   │ ✅ if enabled│ ❌ NO ATIF   │
 │ (subprocess)    │ spans from   │ via synth→   │              │ No Request-  │
 │                 │ msg loop     │ IOTelService │              │ Logger       │
 └─────────────────┴──────────────┴──────────────┴──────────────┴──────────────┘

 Legend: ✅ = data flows to this store    ❌ = no data path exists
```

### Memory & Lifecycle Characteristics

```
 ┌─────────────────┬─────────────┬───────────────┬──────────────┬───────────────┐
 │                 │ Store ①     │ Store ②       │ Store ③      │ Store ④       │
 │                 │ DebugPanel  │ JSONL Files   │ FileExporter │ ATIF Logger   │
 ├─────────────────┼─────────────┼───────────────┼──────────────┼───────────────┤
 │ Storage         │ In-memory   │ Disk (JSONL)  │ Disk (JSONL) │ In-memory     │
 │ Medium          │ array       │ per-session   │ single file  │ Map + Sets    │
 ├─────────────────┼─────────────┼───────────────┼──────────────┼───────────────┤
 │ Bounded?        │ ✅ 10K cap  │ ✅ by disk    │ ✅ by disk   │ ❌ UNBOUNDED  │
 │                 │ evicts old  │               │              │ grows forever │
 │                 │ sessions    │               │              │ ⚠️ 735MB seen │
 ├─────────────────┼─────────────┼───────────────┼──────────────┼───────────────┤
 │ Schema          │ ICompleted- │ IDebugLog-    │ ReadableSpan │ ITrajectory-  │
 │                 │ SpanData    │ Entry (compact│ (full OTel   │ Step (ATIF    │
 │                 │ (OTel)      │ 8 fields)     │ SDK JSON)    │ v1.5)         │
 ├─────────────────┼─────────────┼───────────────┼──────────────┼───────────────┤
 │ Write Pattern   │ Push on     │ Buffer +      │ Append-only  │ Accumulate    │
 │                 │ span.end()  │ flush every 4s│ write-through│ on event      │
 ├─────────────────┼─────────────┼───────────────┼──────────────┼───────────────┤
 │ Read Pattern    │ Query by    │ Agent reads   │ No structured│ Query all at  │
 │                 │ session,    │ files via     │ reader       │ export time   │
 │                 │ lazy resolve│ read_file tool│ (manual/jq)  │               │
 ├─────────────────┼─────────────┼───────────────┼──────────────┼───────────────┤
 │ Cleanup         │ Eviction    │ By session    │ File delete  │ clearTrajec-  │
 │                 │ on overflow │ lifecycle     │              │ tory() manual │
 │                 │             │               │              │ (rarely done) │
 ├─────────────────┼─────────────┼───────────────┼──────────────┼───────────────┤
 │ Always On?      │ ✅ Yes      │ ✅ Yes        │ ❌ Opt-in    │ ✅ Yes        │
 │                 │ (InMemory-  │ (auto-starts  │ (env var or  │ (always       │
 │                 │ OTelService)│ per session)  │ config)      │ subscribes)   │
 └─────────────────┴─────────────┴───────────────┴──────────────┴───────────────┘
```

### End-to-End: Eval Harness Trajectory Flow

```
 DURING AGENT RUN                              AFTER AGENT COMPLETES
 ══════════════                                ═════════════════════

 Agent executes                                vsCodeApplication.ts
 ├─ LLM call                                  ├─ _exportAtifTrajectories()
 │  └─ chat span → IOTelService               │  └─ cmd: exportTrajectories
 │     ├─→ Store ① (debug panel)              │     └─ Store ④ → ATIF files
 │     ├─→ Store ② (JSONL file)               │        (foreground only!)
 │     ├─→ Store ③ (file exporter, if on)     │
 │     └─→ Store ④ (trajectory adapter)       ├─ _exportVscFullLogs()
 │                                             │  └─ chat-export-logs.json
 ├─ Tool call                                  │     (legacy fallback)
 │  └─ execute_tool span → same 4 stores      │
 │                                             ├─ _flushOTel()
 ├─ Subagent                                   │  └─ BatchSpanProcessor flush
 │  └─ invoke_agent span → same stores        │     (Store ③ + OTLP)
 │                                             │
 └─ User message                               └─ Exit VS Code process
    └─ span event → Store ① + ②

                                               run-agent.sh (post-process)
                                               ├─ IF atif-trajectories/ has files:
                                               │  └─ copy to OUTPUT/trajectories/
                                               ├─ ELSE:
                                               │  └─ transformVSCOutputToTrajectory
                                               │     (chat-export-logs → legacy format)
                                               │
                                               └─ OUTPUT/trajectories/
                                                  ├─ trajectory.json (ATIF or legacy)
                                                  └─ *.trajectory.json (subagents)
                                                     │
                                                     ▼
                                               ┌─────────────────────┐
                                               │ MSBench Grading     │
                                               │ eval.json           │
                                               ├─────────────────────┤
                                               │ Eval-Ext Analysis   │
                                               │ trajectoryParser.ts │
                                               └─────────────────────┘
```

**Key observation**: OTel spans already capture a superset of the data in ATIF trajectories. The `ICompletedSpanData` interface contains all the fields needed for ATIF conversion: operation name, tool name, arguments, result, tokens, timing, model name, reasoning content, parent/child hierarchy, and session IDs.

## Proposed Architecture: OTel SQLite Store + ATIF Export

Replace Stores ①②④ with a single SQLite database. The `exportTrajectories` command reads
from SQLite instead of the legacy `TrajectoryLogger`, producing ATIF for ALL agent types.

### Design Principles

- **`node:sqlite` (`DatabaseSync`)** — Node.js built-in since 22.14.0, zero external dependency. VS Code Insiders ships Node 22.21.1. Same library `copilot-agent-runtime` uses for its session store + chronicle feature.
- **Synchronous write-through** — INSERT on `span.end()`, no in-memory buffering. Eliminates the unbounded accumulation that caused the 735MB leak.
- **WAL mode + `busy_timeout = 3000`** — concurrent read/write safe. Same pragmas as CLI runtime's `SessionStore`.
- **Schema versioning** — migration table for future upgrades (pattern from CLI runtime `sessionStore.ts`).
- **`setAuthorizer()` for read-only queries** — same pattern CLI runtime uses for chronicle. Enables safe Copilot SQL tool (`#traces`).
- **Traces only** — spans + attributes + events. No OTel metrics or logs (cloud-analytics signals, not local-analysis data).
- **`runInTransaction()` for batch writes** — wrap multiple INSERTs in BEGIN/COMMIT for atomic commits (pattern from CLI runtime).

### Before → After

```
 BEFORE (4 parallel stores)
 ──────────────────────────
 IOTelService ──┬──→ ① OTelChatDebugLogProvider  (in-memory, 10K cap)
 onDidComplete- ├──→ ② ChatDebugFileLoggerSvc    (JSONL on disk)
 Span           ├──→ ③ FileSpanExporter           (JSONL, opt-in)
 RequestLogger ─┴──→ ④ TrajectoryLoggerAdapter   (in-memory, LEAKS ⚠️)

 AFTER (1 store, N consumers)
 ────────────────────────────
 IOTelService.onDidCompleteSpan
       │
       ▼
 OTelSqliteStore (node:sqlite DatabaseSync, always-on)
       │
       ├──→ ATIF Export:  SELECT → span tree → trajectory.json (all agents)
       └──→ Eval Harness: calls exportTrajectories cmd (unchanged)

 KEPT: Stores ①② (debug panel, troubleshoot skill) — unchanged, owned by other teams
 KEPT (opt-in): FileSpanExporter (JSONL), OTLP Export (network)
```

### SQLite Schema

Designed from `ICompletedSpanData`, `ISpanEventRecord`, and the GenAI semantic convention
attributes defined in `genAiAttributes.ts`. The schema faithfully represents our OTel data model —
not a generic schema borrowed from elsewhere.

**Design approach**: Frequently-queried GenAI attributes are denormalized into the `spans` table
for indexed access. All attributes (including denormalized ones) are stored in the key-value
`span_attributes` table for full fidelity. Content attributes (`gen_ai.output.messages`,
`gen_ai.tool.call.arguments`, etc.) are large strings loaded only on demand from `span_attributes`.

```sql
-- Schema version tracking
-- (Pattern from copilot-agent-runtime sessionStore.ts)
CREATE TABLE schema_version (version INTEGER NOT NULL);

-- ── Core spans ──────────────────────────────────────────────────────────────
-- 1:1 mapping from ICompletedSpanData.
-- Denormalized columns are extracted from ICompletedSpanData.attributes at INSERT
-- time using attribute keys from GenAiAttr and CopilotChatAttr.

CREATE TABLE spans (
    -- ICompletedSpanData core fields
    span_id           TEXT PRIMARY KEY,           -- .spanId
    trace_id          TEXT NOT NULL,              -- .traceId
    parent_span_id    TEXT,                       -- .parentSpanId
    name              TEXT NOT NULL,              -- .name
    start_time_ms     INTEGER NOT NULL,           -- .startTime (epoch ms)
    end_time_ms       INTEGER NOT NULL,           -- .endTime (epoch ms)
    status_code       INTEGER NOT NULL DEFAULT 0, -- .status.code (SpanStatusCode enum)
    status_message    TEXT,                       -- .status.message

    -- Denormalized: GenAiAttr (gen_ai.* semantic conventions)
    operation_name    TEXT,     -- GenAiAttr.OPERATION_NAME     'gen_ai.operation.name'
    provider_name     TEXT,     -- GenAiAttr.PROVIDER_NAME      'gen_ai.provider.name'
    agent_name        TEXT,     -- GenAiAttr.AGENT_NAME         'gen_ai.agent.name'
    conversation_id   TEXT,     -- GenAiAttr.CONVERSATION_ID    'gen_ai.conversation.id'
    request_model     TEXT,     -- GenAiAttr.REQUEST_MODEL      'gen_ai.request.model'
    response_model    TEXT,     -- GenAiAttr.RESPONSE_MODEL     'gen_ai.response.model'
    input_tokens      INTEGER, -- GenAiAttr.USAGE_INPUT_TOKENS  'gen_ai.usage.input_tokens'
    output_tokens     INTEGER, -- GenAiAttr.USAGE_OUTPUT_TOKENS 'gen_ai.usage.output_tokens'
    cached_tokens     INTEGER, -- GenAiAttr.USAGE_CACHE_READ    'gen_ai.usage.cache_read.input_tokens'
    reasoning_tokens  INTEGER, -- GenAiAttr.USAGE_REASONING_TOKENS 'gen_ai.usage.reasoning_tokens'
    tool_name         TEXT,     -- GenAiAttr.TOOL_NAME          'gen_ai.tool.name'
    tool_call_id      TEXT,     -- GenAiAttr.TOOL_CALL_ID       'gen_ai.tool.call.id'
    tool_type         TEXT,     -- GenAiAttr.TOOL_TYPE          'gen_ai.tool.type'

    -- Denormalized: CopilotChatAttr (copilot_chat.* extension-specific)
    chat_session_id   TEXT,     -- CopilotChatAttr.CHAT_SESSION_ID 'copilot_chat.chat_session_id'
    turn_index        INTEGER, -- CopilotChatAttr.TURN_INDEX      'copilot_chat.turn.index'
    ttft_ms           REAL      -- CopilotChatAttr.TIME_TO_FIRST_TOKEN 'copilot_chat.time_to_first_token'
);

-- ── All span attributes (key-value) ────────────────────────────────────────
-- Full fidelity: every entry from ICompletedSpanData.attributes.
-- Content attributes (gen_ai.output.messages, gen_ai.tool.call.arguments,
-- gen_ai.tool.call.result, copilot_chat.reasoning_content, etc.) live here —
-- loaded on demand for debug panel detail view and ATIF message/observation fields.

CREATE TABLE span_attributes (
    span_id TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    value   TEXT,   -- JSON-encoded for string[] attributes, plain string for scalars
    PRIMARY KEY (span_id, key)
);

-- ── Span events ────────────────────────────────────────────────────────────
-- 1:1 mapping from ISpanEventRecord[].
-- User messages arrive as 'user_message' events on chat spans (ISpanEventData).

CREATE TABLE span_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    span_id       TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE,
    name          TEXT NOT NULL,       -- ISpanEventRecord.name
    timestamp_ms  INTEGER NOT NULL,    -- ISpanEventRecord.timestamp (epoch ms)
    attributes    TEXT                  -- JSON-serialized ISpanEventRecord.attributes
);

-- ── Indexes ────────────────────────────────────────────────────────────────
-- Optimized for three access patterns:
-- 1. Debug panel: list events for a session (conversation_id / chat_session_id)
-- 2. ATIF export: get all spans for a trace (trace_id)
-- 3. Cleanup: delete old data by time (start_time_ms)

CREATE INDEX idx_spans_trace          ON spans(trace_id);
CREATE INDEX idx_spans_conversation   ON spans(conversation_id);
CREATE INDEX idx_spans_chat_session   ON spans(chat_session_id);
CREATE INDEX idx_spans_operation      ON spans(operation_name);
CREATE INDEX idx_spans_start_time     ON spans(start_time_ms);
CREATE INDEX idx_span_events_span     ON span_events(span_id);
```

### OTel → ATIF Conversion (from SQLite)

#### Step Construction from Span Tree

```
SELECT * FROM spans WHERE trace_id = :traceId ORDER BY start_time_ms
  → build parent/child tree using parent_span_id
  → walk tree depth-first:

invoke_agent span (root)
├── chat span #1                    → agent step
│   │  message = SELECT value FROM span_attributes WHERE key = 'gen_ai.output.messages'
│   │  reasoning = SELECT value FROM span_attributes WHERE key = 'copilot_chat.reasoning_content'
│   │  metrics from denormalized columns (input_tokens, output_tokens, etc.)
│   └── [user_message event]        → user step (from span_events)
├── execute_tool span #1            → tool_call on agent step
│   │  function_name = spans.tool_name
│   │  arguments = SELECT value FROM span_attributes WHERE key = 'gen_ai.tool.call.arguments'
│   │  result = SELECT value FROM span_attributes WHERE key = 'gen_ai.tool.call.result'
├── chat span #2                    → next agent step
└── execute_tool with child invoke_agent → subagent_trajectory_ref (recursive)
```

#### Field Mapping

| ATIF Field | SQLite Source |
|---|---|
| `session_id` | `spans.chat_session_id` or `spans.conversation_id` on root invoke_agent |
| `agent.name` | `spans.agent_name` from invoke_agent span |
| `agent.model_name` | `spans.response_model` from first chat child |
| `step.message` | `span_attributes` where key = `gen_ai.output.messages` |
| `step.reasoning_content` | `span_attributes` where key = `copilot_chat.reasoning_content` |
| `step.model_name` | `spans.response_model` |
| `step.metrics.*` | Denormalized columns: `input_tokens`, `output_tokens`, `cached_tokens`, `ttft_ms` |
| `step.metrics.duration_ms` | `end_time_ms - start_time_ms` |
| `tool_call.function_name` | `spans.tool_name` |
| `tool_call.arguments` | `span_attributes` where key = `gen_ai.tool.call.arguments` |
| `observation.content` | `span_attributes` where key = `gen_ai.tool.call.result` |

## Implementation Plan

### Phase 1: OTel SQLite Store + ATIF Export (chat only)

**Goal**: Add `OTelSqliteStore`, update `exportTrajectories`, retire legacy pipeline.

**Chat extension:**
1. `OTelSqliteStore` — subscribes to `onDidCompleteSpan`, INSERTs using `node:sqlite` `DatabaseSync`
2. Update `exportTrajectories` command: SQLite source → span tree → ATIF v1.6
3. ATIF types bump to v1.6
4. Remove `TrajectoryLoggerAdapter` + `TrajectoryLogger`

**Eval harness:** No changes needed. Eval already calls `exportTrajectories` command — same contract, just works for CLI now too.

**Size**: ~600 LOC new, ~600 LOC deleted = **0 net**

## Task Breakdown

| # | Task | Size | Repo |
|---|------|------|------|
| 1 | `OTelSqliteStore`: schema + INSERT + cleanup using `node:sqlite` | ~300 LOC | chat |
| 2 | SQLite → ATIF converter (SELECT → span tree → `IAgentTrajectory`) | ~200 LOC | chat |
| 3 | Update `exportTrajectories` command to use SQLite | ~50 LOC | chat |
| 4 | Bump `trajectoryTypes.ts` to ATIF v1.6 | ~30 LOC | chat |
| 5 | Remove `TrajectoryLoggerAdapter` + `TrajectoryLogger` | -600 LOC | chat |
| 6 | Tests | ~200 LOC | chat |
| 7 | Docs | ~20 LOC | chat |

## Open Questions

1. **`node:sqlite` availability**: Is `--experimental-sqlite` / `DatabaseSync` available in VS Code's extension host process (Node 22.21.1)? CLI runtime enables it via `NODE_OPTIONS` in Dockerfile. Need to verify. Fallback: `sql.js` (WASM, ~1.5MB, async API).

2. **Content capture in production**: ATIF export needs `captureContent=true` for message text. In eval this is always on. In production users have it off — ATIF would be structural-only (tool calls, metrics, no message content). Acceptable.

3. **ATIF v1.6 multimodal**: The new `ContentPart` types (text + image) are defined but not emitted by any current OTel span. Future-proofing for when tools produce screenshots.

