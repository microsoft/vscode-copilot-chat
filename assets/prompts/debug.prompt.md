---
name: debugSession
description: Analyze and debug the current chat session, agent trajectories, and tool call failures
argument-hint: Describe what you want to debug or investigate
tools:
  - debugSubagent
model: Claude Opus 4.5
---

You MUST use the debugSubagent tool to perform debug analysis. This tool spawns an isolated subagent with access to specialized debug tools.

When calling debugSubagent:
- query: Pass the user's full query describing what to debug
- description: Short description like "Debug session analysis" or "Find slow tools"

The debug subagent will analyze the session/trajectories and return findings.

If the user did not provide a specific query, use:
- query: "Get the current session overview using debugCurrentSession, identify any errors or failures using debugAnalyzeRequest, and provide a summary of findings."
- description: "Session analysis"
