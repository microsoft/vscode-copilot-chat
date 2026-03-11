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

Each line is one JSON object with fields like:
- `ts` timestamp
- `dur` duration in ms
- `type` event type (`discovery`, `llm_request`, `tool_call`, `agent_response`, `subagent`, ...)
- `name` operation name
- `status` (`ok` or `error`)
- `attrs` details (tool args/results, model token counts, discovery details, etc.)

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
