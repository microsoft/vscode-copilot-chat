# Chat Debug Events: End-to-End Flow

This document describes how OTel-based chat debug events are collected, written to JSONL files, exported/imported, and displayed in the Agent Debug Panel.

---

## High-Level Architecture

```
 ┌─────────────────────────── Event Sources ───────────────────────────┐
 │  LLM Requests       Tool Calls        Subagent Invocations         │
 │  (chatMLFetcher)    (EXECUTE_TOOL)    (INVOKE_AGENT spans)         │
 │                                                                     │
 │  User Messages                  VS Code Core Events                 │
 │  (span events)                  (discovery, skills)                 │
 └──────────────────────────────────┬──────────────────────────────────┘
                                    │
                                    ▼
 ┌───────────────────── IOTelService Layer ─────────────────────────┐
 │                                                                 │
 │                        IOTelService                             │
 │                            │                                    │
 │                            ▼                                    │
 │                       ISpanHandle                               │
 │                      /           \                              │
 │                end()               addEvent()                   │
 │                  /                       \                      │
 │                 ▼                         ▼                     │
 │       onDidCompleteSpan         onDidEmitSpanEvent              │
 │                │                         │                      │
 └────────────────┼─────────────────────────┼──────────────────────┘
                  │                         │
                  ├───────────────┐     ┌───────────────┤
                  │               │     │               │
                  ▼               ▼     ▼               ▼
 ┌────────────────────────────────────────┐   ┌────────────────────────────────────────┐
 │ OTelChatDebugLogProvider               │   │ ChatDebugFileLoggerService             │
 │ (in-memory span store, 10K cap)        │   │ (JSONL writer)                         │
 │                                        │   │                                        │
 │ onDidCompleteSpan ──►                  │   │ onDidCompleteSpan ──►                  │
 │   store span + stream to panel         │   │   write completed entry to buffer      │
 │   (ModelTurn / ToolCall / Subagent)    │   │                                        │
 │                                        │   │ onDidEmitSpanEvent ──►                 │
 │ onDidEmitSpanEvent ──►                 │   │   write real-time entry to buffer      │
 │   stream UserMessage to panel          │   │                                        │
 └──────────┬──────────┬──────────────────┘   └───────────────────┬────────────────────┘
            │          │                                          │
            ▼          ▼                                          ▼
 ┌──────────────┐ ┌────────────────┐           ┌──────────────────────────────────┐
 │ Agent Debug  │ │ OTLP JSON      │           │ JSONL Files on Disk (every 4s)   │
 │ Panel        │ │ Export         │           │ debug-logs/{session}/*.jsonl     │
 └──────────────┘ └────────┬───────┘           └──────────────────────────────────┘
         ▲                 │
         │                 ▼
         │        ┌────────────────┐
         │        │ .json file     │
         │        └────────┬───────┘
         │                 │ (Import: user opens)
         │                 ▼
         │        otlpJsonToSpans()
         │                 │
         └─────────────────┘
           imported session → panel
```

---

## 1. OTel Event Collection

### Service Initialization

```
  Extension Activation (services.ts)
                │
                ▼
     ┌─── COPILOT_OTEL_ENABLED? ───┐
     │                              │
     ▼ true                         ▼ false (default)
 ┌────────────────────┐   ┌──────────────────────────┐
 │ NodeOTelService    │   │ InMemoryOTelService      │
 │ - OTel SDK         │   │ - AsyncLocalStorage      │
 │ - Batch processors │   │ - No SDK dependency      │
 │ - OTLP exporters   │   │ - Zero-cost when unused  │
 └────────┬───────────┘   └─────────┬────────────────┘
          │                         │
          └──────────┬──────────────┘
                     ▼
          Register as IOTelService
            (builder.define)
```

### Span Lifecycle During a Chat Request

```
  User sends message
       │
       ▼
  Chat Request Handler
       │
       │  startSpan("chat gpt-4o", {kind: CLIENT, attributes: {model, conversationId, ...}})
       ▼
  IOTelService ──────► returns ISpanHandle
       │
       │  addEvent("user_message", {content})
       │  ──► fires onDidEmitSpanEvent immediately (real-time)
       │
       ▼
  chatMLFetcher._doFetchAndStreamChat()
       │
       │  HTTP request (SSE stream) ──────► LLM Endpoint
       │                                        │
       │  ◄────── Streaming tokens... ──────────┘
       │
       │  On first token: setAttribute("copilot_chat.time_to_first_token", 342)
       │
       │  ◄────── Stream complete
       │
       │  setAttributes({input_tokens, output_tokens, response_model, ...})
       │  end()
       │
       ▼
  IOTelService fires onDidCompleteSpan
       with ICompletedSpanData {spanId, traceId, parentSpanId,
                                name, startTime, endTime,
                                status, attributes, events}
```

### Span Hierarchy (Nested Traces)

```
  Root Span: CHAT (chat gpt-4o)              traceId: abc-123
       │
       ├── Child: EXECUTE_TOOL (read_file)
       │
       ├── Child: EXECUTE_TOOL (grep_search)
       │
       └── Child: INVOKE_AGENT (Explore subagent)
              │
              ├── Grandchild: CHAT (subagent LLM call)
              │
              └── Grandchild: EXECUTE_TOOL (semantic_search)
```

All spans share the same `traceId`. Parent-child links are maintained via `AsyncLocalStorage` for correct propagation across concurrent async operations.

---

## 2. Agent Debug Panel Flow

### Data Flow: OTel → Debug Panel

```
  ┌──── IOTelService ────┐
  │                      │
  │ onDidCompleteSpan    │
  │ onDidEmitSpanEvent   │
  └──────┬───────────────┘
         │
         │  _onSpanCompleted() / _onSpanEvent()
         ▼
  ┌──── OTelChatDebugLogProviderContribution ──────────────────────────┐
  │                                                                    │
  │   In-Memory Span Store (bounded 10K spans)                         │
  │          │                                                         │
  │          ▼                                                         │
  │   Session → Span Index Map                                        │
  │          │                                                         │
  │          ▼                                                         │
  │   otelSpanToChatDebugEvent() converts to:                          │
  │     ├── ChatDebugToolCallEvent                                     │
  │     ├── ChatDebugModelTurnEvent                                    │
  │     ├── ChatDebugUserMessageEvent                                  │
  │     ├── ChatDebugAgentResponseEvent                                │
  │     ├── ChatDebugSubagentInvocationEvent                           │
  │     └── ChatDebugGenericEvent                                      │
  │          │                                                         │
  │          ▼                                                         │
  │   Progress Callback (real-time streaming)                          │
  │                                                                    │
  └──────────┬─────────────────────────────────────────────────────────┘
             │
             ▼
  ┌──── VS Code Debug Panel ──────────┐
  │                                    │
  │   Agent Debug Panel UI             │
  │   (built-in webview)               │
  │          │                         │
  │          │ resolveChatDebugLog-     │
  │          │ Event() for details     │
  │          ▼                         │
  │   Detail Resolution (on-demand)    │
  └────────────────────────────────────┘
```

### Span-to-Event Type Mapping

| Source Span | Debug Event Type | Key Attributes |
|---|---|---|
| `CHAT` span | `ChatDebugModelTurnEvent` | model, token counts, TTFT |
| `EXECUTE_TOOL` span | `ChatDebugToolCallEvent` | tool name, args, result |
| `INVOKE_AGENT` span | `ChatDebugSubagentInvocationEvent` | agent name, duration |
| User message `addEvent()` | `ChatDebugUserMessageEvent` | message content |
| CHAT output extraction | `ChatDebugAgentResponseEvent` | response content |
| Core/discovery events | `ChatDebugGenericEvent` | event-specific |

### Memory Management

```
  New Span Arrives
       │
       ▼
  totalSpans > 10,000?
       │
       ├── No ──► Store in _allSpans[], Index in _sessionSpanMap
       │
       └── Yes ──► Evict Oldest Sessions (preserves active session)
                       │
                       ▼
                   Async Compaction (yields to event loop)
                       │
                       ▼
                   Store in _allSpans[], Index in _sessionSpanMap
```

---

## 3. JSONL Debug File Writing

### Architecture

```
  ┌────── OTel Events ──────────────────────┐
  │                                          │
  │  onDidCompleteSpan                       │
  │  onDidEmitSpanEvent                      │
  │  onCoreDebugEvent (VS Code API)          │
  └─────────────┬────────────────────────────┘
                │
                ▼
  ┌────── ChatDebugFileLoggerService ───────────────────────────────┐
  │                                                                 │
  │  startSession(sessionId) ─── registers session for buffering    │
  │                                                                 │
  │  _spanToEntry()  ────────── span → structured debug entry       │
  │       │                                                         │
  │       ▼                                                         │
  │  _bufferEntry()  ────────── JSON.stringify(entry) + "\n"        │
  │       │                     appends to in-memory buffer[]       │
  │       │                     attrs truncated to max 5000 chars   │
  │       ▼                                                         │
  │  _writeToFile()  ────────── setInterval every 4000ms            │
  │       │                     drains buffer → fs.appendFile()     │
  │       │                                                         │
  │  _truncateLogFile() ─────── if file > 100MB, keep newest 60MB  │
  │                             preserves line boundaries           │
  └───────┼─────────────────────────────────────────────────────────┘
          │
          ▼
  ┌────── File System ─────────────────┐
  │                                     │
  │  debug-logs/                        │
  │    {sessionId}/                     │
  │      main.jsonl                     │
  │      title-{uuid}.jsonl            │
  │      categorization-{uuid}.jsonl   │
  └─────────────────────────────────────┘
```

### JSONL Entry Structure

Each line in a `.jsonl` file is a single JSON object:

```json
{
  "ts": 1692381954123,
  "dur": 245,
  "sid": "abc-123-...",
  "type": "tool_call",
  "name": "find_files",
  "spanId": "span-456-...",
  "parentSpanId": "span-123-...",
  "status": "ok",
  "attrs": {
    "args": "{...}",
    "result": "{...}"
  }
}
```

### Event Type Mapping for JSONL

| Source Span Name | JSONL `type` | Captured `attrs` |
|---|---|---|
| `EXECUTE_TOOL` | `tool_call` | args (≤5KB), result |
| `CHAT` | `llm_request` | model, input/output tokens, TTFT |
| `INVOKE_AGENT` (sub) | `subagent` | agent name, duration |
| User message event | `user_message` | message content |
| CHAT output | `agent_response` | response content |
| Core event | `discovery` / `generic` | event-specific |
| Child session ref | `child_session_ref` | child session id |

### Write Pipeline

```
  IOTelService                ChatDebugFileLoggerService         In-Memory Buffer        File System
       │                              │                               │                      │
       │                       Session started                        │                      │
       │                              │                               │                      │
       │  onDidCompleteSpan(span)     │                               │                      │
       │─────────────────────────────►│                               │                      │
       │                              │                               │                      │
       │                        _spanToEntry(span)                    │                      │
       │                              │                               │                      │
       │                        _bufferEntry(entry)                   │                      │
       │                              │  JSON.stringify + "\n"        │                      │
       │                              │──────────────────────────────►│                      │
       │                              │                               │                      │
       │                              │        ... buffer accumulates entries ...             │
       │                              │                               │                      │
       │                              │  ┌─── Every 4000ms ───┐      │                      │
       │                              │  │   Drain buffer      │      │                      │
       │                              │  │                     │      │                      │
       │                              │  │   buffered lines    │◄─────│                      │
       │                              │  │                     │      │                      │
       │                              │  │   fs.appendFile()   │──────│─────────────────────►│
       │                              │  └─────────────────────┘      │                      │
       │                              │                               │                      │
       │                       Session ended                          │                      │
       │                              │  Final drain                  │                      │
       │                              │──────────────────────────────►│                      │
       │                              │  fs.appendFile (remaining)    │─────────────────────►│
       │                              │                               │                      │
       │                              │  If file > 100MB:             │                      │
       │                              │  _truncateLogFile()           │                      │
       │                              │  Keep newest 60MB             │─────────────────────►│
       │                              │  Preserve line boundaries     │                      │
```

### File Organization on Disk

```
${storageUri}/debug-logs/
├── {sessionId1}/
│   ├── main.jsonl                     ← Primary chat session
│   ├── title-{uuid}.jsonl            ← Child: title generation
│   ├── categorization-{uuid}.jsonl   ← Child: intent categorization
│   └── summarize-{uuid}.jsonl        ← Child: summarization
├── {sessionId2}/
│   └── main.jsonl
```

---

## 4. Export / Import Flow

### Export Flow

```
  User clicks "Export" in Agent Debug Panel
       │
       ▼
  Agent Debug Panel
       │  provideChatDebugLogExport(sessionResource)
       ▼
  OTelChatDebugLogProvider
       │  Collect all spans for session from _allSpans[]
       │
       │  spansToOtlpJson(spans, sessionId)
       ▼
  otlpFormatConversion
       │  Wraps in OTLP envelope:
       │    resourceSpans → scopeSpans → spans
       │  Adds copilotChat metadata
       │
       │  JSON.stringify() → TextEncoder.encode()
       ▼
  Uint8Array (OTLP JSON bytes)
       │
       ▼
  VS Code save file dialog
       │
       ▼
  .json file saved to disk
```

### OTLP Export Format

```json
{
  "resourceSpans": [{
    "resource": {
      "attributes": [
        {"key": "service.name", "value": {"stringValue": "copilot-chat"}},
        {"key": "session.id", "value": {"stringValue": "session-123"}}
      ]
    },
    "scopeSpans": [{
      "scope": {"name": "copilot-chat"},
      "spans": [
        {
          "traceId": "hex...",
          "spanId": "hex...",
          "parentSpanId": "hex...",
          "name": "chat gpt-4o",
          "kind": 3,
          "startTimeUnixNano": "1692381954123000000",
          "endTimeUnixNano": "1692381954368000000",
          "attributes": [
            {"key": "gen_ai.request.model", "value": {"stringValue": "gpt-4o"}}
          ],
          "status": {"code": 1}
        }
      ]
    }]
  }],
  "copilotChat": {
    "exportedAt": "2026-03-17T...",
    "exporterVersion": "",
    "sessionId": "session-123",
    "sessionTitle": "Derived from spans"
  }
}
```

### Import Flow

```
  User opens .json file / Drag & drop
       │
       ▼
  VS Code
       │  resolveChatDebugLogImport(data: Uint8Array)
       ▼
  OTelChatDebugLogProvider
       │
       │  otlpJsonToSpans(data)
       ▼
  otlpFormatConversion
       │  Decode UTF-8 → parse JSON
       │  Supports JSON & JSONL formats
       │  Extract spans from resourceSpans
       │
       │  returns ICompletedSpanData[]
       ▼
  OTelChatDebugLogProvider
       │  Generate import session ID:
       │    "import:{sourceSessionId}:{timestamp}"
       │  Store in _importedSessions map
       │
       │  returns Import session URI
       ▼
  VS Code opens debug panel with imported session
       │  provideChatDebugLog(importedSessionURI)
       ▼
  Stream imported spans as ChatDebugEvents
       │
       ▼
  Agent Debug Panel displays imported session
```

---

## 5. Complete End-to-End Flow

```
  User sends chat message
       │
       ▼
 ┌──── 1. EVENT COLLECTION ────────────────────────────────────────────┐
 │                                                                     │
 │   Chat Request Handler                                              │
 │        │                                                            │
 │        ▼                                                            │
 │   IOTelService.startSpan("chat gpt-4o", {kind, attributes})        │
 │        │                                                            │
 │        ▼                                                            │
 │   ISpanHandle                                                       │
 │     ├── setAttribute(key, value)     (during request processing)    │
 │     ├── addEvent("user_message")     (fires onDidEmitSpanEvent)     │
 │     └── end()                        (fires onDidCompleteSpan)      │
 │                                                                     │
 └─────────────┬──────────────────┬────────────────────────────────────┘
               │                  │
               ▼                  ▼
 ┌──── 2. EVENT DISTRIBUTION ─────────────────────────────────────────┐
 │                                                                     │
 │   onDidCompleteSpan ──────┬──────── onDidEmitSpanEvent              │
 │                           │                                         │
 └───────────────┬───────────┼────────────────────┬────────────────────┘
                 │           │                    │
     ┌───────────┘           │                    └───────────┐
     │                       │                                │
     ▼                       ▼                                ▼
 ┌──── 3a. AGENT DEBUG PANEL ──────┐  ┌──── 3b. JSONL FILE WRITING ───┐
 │                                  │  │                                │
 │  OTelChatDebugLogProvider        │  │  ChatDebugFileLoggerService    │
 │       │                          │  │       │                        │
 │       ▼                          │  │       ▼                        │
 │  In-Memory Store (10K limit)     │  │  Span → Debug Entry           │
 │       │                          │  │       │                        │
 │       ▼                          │  │       ▼                        │
 │  Span → ChatDebugEvent          │  │  In-Memory Buffer              │
 │       │                          │  │       │                        │
 │       ▼                          │  │       │ (every 4s)             │
 │  VS Code Debug Panel UI         │  │       ▼                        │
 │       │                          │  │  fs.appendFile()               │
 │       │                          │  │       │                        │
 └───────┼──────────────────────────┘  │       ▼                        │
         │                             │  debug-logs/{session}/         │
         │                             │    main.jsonl                  │
         │                             │                                │
         │                             └────────────────────────────────┘
         │
         ▼
 ┌──── 4. EXPORT / IMPORT ────────────────────────────────────────────┐
 │                                                                     │
 │   In-Memory Store                                                   │
 │        │                                                            │
 │        ▼  (Export)                                                  │
 │   spansToOtlpJson() ──► OTLP JSON (Uint8Array) ──► .json file      │
 │                                                                     │
 │   .json file ──► otlpJsonToSpans() ──► Imported Sessions Store      │
 │        ▲  (Import)                          │                       │
 │        │                                    ▼                       │
 │        │                          Agent Debug Panel                 │
 └─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Configuration

| Setting | Default | Purpose |
|---|---|---|
| `github.copilot.chat.agentDebugLog.enabled` | `false` | Enable OTel event collection |
| `github.copilot.chat.agentDebugLog.fileLogging.enabled` | `false` | Enable JSONL file writing |
| `github.copilot.chat.agentDebugLog.fileLogging.flushIntervalMs` | `4000` | Buffer flush interval (min 2000ms) |
| `COPILOT_OTEL_ENABLED` env var | `false` | Use full OTel SDK with OTLP export |

## 7. Key Source Files

| File | Role |
|---|---|
| `src/platform/otel/common/otelService.ts` | `IOTelService` interface definition |
| `src/platform/otel/node/inMemoryOTelService.ts` | Default in-memory OTel implementation |
| `src/platform/otel/node/otelServiceImpl.ts` | Full OTel SDK implementation (`NodeOTelService`) |
| `src/extension/trajectory/vscode-node/otelChatDebugLogProvider.ts` | Debug panel provider — span storage, streaming, export/import |
| `src/extension/trajectory/vscode-node/otelSpanToChatDebugEvent.ts` | Span → `ChatDebugEvent` conversion |
| `src/extension/trajectory/vscode-node/otlpFormatConversion.ts` | OTLP JSON serialization/deserialization |
| `src/extension/chat/vscode-node/chatDebugFileLoggerService.ts` | JSONL file writer service |
| `src/platform/chat/common/chatDebugFileLoggerService.ts` | `IChatDebugFileLoggerService` interface |
| `src/extension/extension/vscode-node/services.ts` | Service initialization & registration |
