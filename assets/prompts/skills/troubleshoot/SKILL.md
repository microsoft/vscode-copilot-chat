---
name: troubleshoot
description: Investigate unexpected chat agent behavior by analyzing direct debug logs in JSONL files. Use when users ask why something happened, why a request was slow, why tools or subagents were used or skipped, or why instructions/skills/agents did not load.
---

# Troubleshoot

## Purpose

This skill investigates and explains unexpected chat agent behavior using direct log files.

Use this skill for questions like:
- Why did this request take so long?
- Why was a tool or subagent called?
- Why did instruction/skill/agent files not load?
- Why was a tool call blocked or failed?
- Why did the model not follow expectations?

Base conclusions on evidence from logs. Do not guess.

## Data Source

Use direct debug log files written by Copilot Chat:

`User/workspaceStorage/{workspaceHash}/GitHub.copilot-chat/debug-logs/{sessionId}.jsonl`

{{DEBUG_LOG_RUNTIME_CONTEXT}}

Each line is a JSON object. Common fields: `ts` (epoch ms), `dur` (duration ms), `sid` (session ID), `type`, `name`, `spanId`, `parentSpanId`, `status` (`ok`|`error`), `attrs` (type-specific details).

### Event Type Reference with Examples

#### discovery — customization file loading (instructions, skills, agents, hooks)
```jsonl
{"ts":1773200251309,"dur":0,"sid":"62f52dec","type":"discovery","name":"Load Instructions","spanId":"2cb1f2f4","status":"ok","attrs":{"details":"Resolved 0 instructions in 0.0ms | folders: [/c:/Users/user/.copilot/instructions, /workspace/.github/instructions]","category":"discovery","source":"core"}}
{"ts":1773200251415,"dur":0,"sid":"62f52dec","type":"discovery","name":"Load Agents","spanId":"38a897d8","status":"ok","attrs":{"details":"Resolved 3 agents in 0.0ms | loaded: [Plan, Ask, Explore] | folders: [/workspace/.github/agents]","category":"discovery","source":"core"}}
{"ts":1773200251431,"dur":0,"sid":"62f52dec","type":"discovery","name":"Load Skills","spanId":"472eb225","status":"ok","attrs":{"details":"Resolved 6 skills in 0.0ms | loaded: [agent-customization, troubleshoot, ...]","category":"discovery","source":"core"}}
```
Key attrs: `details` (human-readable summary with folder paths, loaded items, skip reasons), `category` (always `"discovery"`), `source` (`"core"`).

#### tool_call — tool invocation (success or failure)
```jsonl
{"ts":1773200222647,"dur":4,"sid":"62f52dec","type":"tool_call","name":"manage_todo_list","spanId":"000000000000000b","parentSpanId":"0000000000000003","status":"ok","attrs":{"args":"{\"operation\":\"read\"}","result":"No todo list found."}}
{"ts":1773200234047,"dur":8937,"sid":"62f52dec","type":"tool_call","name":"run_in_terminal","spanId":"000000000000000d","parentSpanId":"0000000000000003","status":"error","attrs":{"args":"{\"command\":\"echo rama\"}","result":"ERROR: conpty.node missing","error":"A native exception occurred during launch"}}
```
Key attrs: `args` (JSON string of tool input), `result` (tool output or error text), `error` (present when `status:"error"`).

#### llm_request — model round-trip
```jsonl
{"ts":1773200231010,"dur":3001,"sid":"62f52dec","type":"llm_request","name":"chat:gpt-4o","spanId":"000000000000000c","parentSpanId":"0000000000000003","status":"ok","attrs":{"model":"gpt-4o","inputTokens":15025,"outputTokens":126,"ttft":1987}}
```
Key attrs: `model`, `inputTokens`, `outputTokens`, `ttft` (time to first token in ms), `error` (when failed).

#### agent_response — model output (text + tool calls)
```jsonl
{"ts":1773200234011,"dur":0,"sid":"62f52dec","type":"agent_response","name":"agent_response","spanId":"agent-msg-000000000000000c","parentSpanId":"0000000000000003","status":"ok","attrs":{"response":"[{\"role\":\"assistant\",\"parts\":[{\"type\":\"text\",\"content\":\"Running your command now.\"},{\"type\":\"tool_call\",\"name\":\"run_in_terminal\",\"arguments\":\"{...}\"}]}]"}}
```
Key attrs: `response` (JSON-encoded array of message parts; may be truncated).

#### user_message — user input
```jsonl
{"ts":1773200251345,"dur":0,"sid":"62f52dec","type":"user_message","name":"user_message","spanId":"000000000000000f","status":"ok","attrs":{"content":"using subagent count .md"}}
```
Key attrs: `content` (the user's message text).

#### subagent — subagent invocation
```jsonl
{"ts":1773200254954,"dur":7921,"sid":"62f52dec","type":"subagent","name":"Explore","spanId":"0000000000000014","parentSpanId":"0000000000000013","status":"ok","attrs":{"agentName":"Explore"}}
```
Key attrs: `agentName`, `description` (optional), `error` (when failed).

#### generic — miscellaneous events
```jsonl
{"ts":1773200260000,"dur":0,"sid":"62f52dec","type":"generic","name":"some-event","spanId":"abc123","status":"ok","attrs":{"details":"Additional context","category":"some-category"}}
```

### Reading the event hierarchy

Events form a tree via `spanId`/`parentSpanId`. A typical chain:
1. `user_message` (spanId: `X`) — the user's turn
2. `llm_request` (parentSpanId: `X`) — model call for that turn
3. `agent_response` (parentSpanId: `X`) — what the model returned
4. `tool_call` (parentSpanId: `X`) — tool executed from the response
5. Another `llm_request` (parentSpanId: `X`) — next model call after tool result

Subagent calls create nested hierarchies: the `tool_call` for `runSubagent` (spanId: `Y`) becomes the parent for a child `subagent` span, which in turn parents its own `llm_request`/`tool_call` events.

## Tooling Strategy (important)

Prefer fast search tools over full-file reads:

1. Use `file_search` to locate candidate `.jsonl` files.
2. Use `grep_search` to narrow by key signals (`"type":"tool_call"`, `"status":"error"`, `"type":"discovery"`, `"dur":`, model/tool names, session id, etc.).
3. Use `read_file` only for small targeted ranges once relevant locations are identified.

Do not read entire large JSONL files unless absolutely required.

## Investigation Workflow

1. Identify likely log file(s)
- Find debug-logs directories and session files.
- If session id is known, prioritize that file.

2. Triage quickly with grep
- Errors: `"status":"error"`
- Latency: high `"dur"`
- Discovery issues: `"type":"discovery"` and `details`/skip reasons
- Tool behavior: `"type":"tool_call"`
- Model behavior: `"type":"llm_request"`

3. Read only relevant slices
- Pull exact lines around suspicious events.
- Correlate with `spanId` / `parentSpanId` when needed.

4. Determine root cause
- Pick the most likely cause from evidence.
- If multiple factors contribute, order by impact.

5. Provide remediation
- Offer concrete next steps when possible.

## Network Issue Investigation

If you suspect network connectivity or authentication problems (e.g., repeated request timeouts, 401/403 errors, or model endpoint failures in the logs), run the VS Code command `github.copilot.debug.collectDiagnostics`. This opens an untitled editor with a comprehensive diagnostics report including:
- Authentication and token status
- Network reachability checks
- Proxy and certificate configuration
- Extension and environment details

After running the command, wait a few seconds for the diagnostics report to finish writing, then read the content of the opened untitled file and use it to diagnose the network issue.

## Response Guidelines

Your response should include:
1. What happened
2. Why it happened
3. Evidence summary from logs
4. Actionable next steps

Do not expose internal workflow chatter (for example, avoid narrating each tool step in detail). Present findings clearly and directly.

## Important Rules

- Never assume causality without evidence.
- Prefer `grep_search` first, `read_file` second.
- Keep log access targeted and efficient.
- If you suspect network issues, run `github.copilot.debug.collectDiagnostics` and read the resulting diagnostics file before concluding.
- If no clear cause is found, say so explicitly and provide best-effort next checks.
