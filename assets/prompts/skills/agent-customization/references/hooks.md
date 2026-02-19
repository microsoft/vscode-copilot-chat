# [Hooks (.json)](https://code.visualstudio.com/docs/copilot/customization/hooks)

Deterministic lifecycle automation for agent sessions. Use hooks to enforce policy, automate validation, and inject runtime context.

## Locations

| Path | Scope |
|------|-------|
| `.github/hooks/*.json` | Workspace (team-shared) |
| `.claude/settings.local.json` | Workspace local (not committed) |
| `.claude/settings.json` | Workspace |
| `~/.claude/settings.json` | User profile |

Hooks from all configured locations are collected and executed; workspace and user hooks do not override each other.

## Hook Events

| Event | Trigger |
|------|-------|
| `SessionStart` | First prompt of a new agent session |
| `UserPromptSubmit` | User submits a prompt |
| `PreToolUse` | Before tool invocation |
| `PostToolUse` | After successful tool invocation |
| `PreCompact` | Before context compaction |
| `SubagentStart` | Subagent starts |
| `SubagentStop` | Subagent ends |
| `Stop` | Agent session ends |

## Configuration Format

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "./scripts/validate-tool.sh",
        "timeout": 15
      }
    ]
  }
}
```

Each hook command supports:
- `type` (must be `command`)
- `command` (default)
- `windows`, `linux`, `osx` (platform overrides)
- `cwd`, `env`, `timeout`

## Input / Output Contract

Hooks receive JSON on stdin and can return JSON on stdout.

**IMPORTANT:** All field names use **snake_case** (e.g., `tool_name`, `tool_input`, `tool_use_id`), not camelCase.

### Common Input Fields

All hook events receive these common fields:
- `timestamp` (string): ISO 8601 timestamp
- `hookEventName` (string): Event type (e.g., "PreToolUse", "PostToolUse")
- `sessionId` (string, optional): Session identifier
- `transcript_path` (string, optional): Path to session transcript file
- `cwd` (string, optional): Working directory for the hook command

### PreToolUse Hook

**Input fields:**
- `tool_name` (string): Name of the tool being invoked
- `tool_input` (object): Tool input parameters
- `tool_use_id` (string): Unique identifier for this tool invocation

**Output format:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "Needs user confirmation",
    "updatedInput": { ... },
    "additionalContext": "Extra context for the agent"
  }
}
```

Fields in `hookSpecificOutput`:
- `permissionDecision`: `allow` | `ask` | `deny` (controls tool execution)
- `permissionDecisionReason`: Human-readable explanation
- `updatedInput`: Modified tool input to use instead
- `additionalContext`: Extra context injected into agent's prompt

### PostToolUse Hook

**Input fields:**
- `tool_name` (string): Name of the tool that was invoked
- `tool_input` (object): Tool input parameters
- `tool_use_id` (string): Unique identifier for this tool invocation
- `tool_response` (string): The output returned by the tool

**Output format:**
```json
{
  "decision": "block",
  "reason": "Tool output violates policy",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Filtered result: ..."
  }
}
```

Fields in output:
- `decision`: Set to `"block"` to prevent tool result from reaching the agent
- `reason`: Human-readable explanation for blocking
- `hookSpecificOutput.additionalContext`: Context injected into agent's prompt (replaces or augments tool response)

### Common Output Fields

All hook types support:
- `continue` (boolean): Set to `false` to stop processing remaining hooks
- `stopReason` (string): Message to display when stopping execution
- `systemMessage` (string): Warning message shown to user (deprecated for PostToolUse, use `additionalContext` instead)

### Common Tool Names

Common `tool_name` values VS Code emits:
- **File Operations**: `Read`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`
- **Search**: `Glob`, `Grep`, `LS`
- **Execution**: `Bash`, `BashOutput`, `KillBash`, `Task`
- **Network**: `WebFetch`, `WebSearch`
- **Planning**: `EnterPlanMode`, `ExitPlanMode`, `TodoWrite`
- **User Interaction**: `AskUserQuestion`

Exit codes:
- `0` success
- `2` blocking error
- Other values produce non-blocking warnings

## Hooks vs Other Customizations

| Primitive | Behavior |
|------|-------|
| Instructions / Prompts / Skills / Agents | Guidance (non-deterministic) |
| Hooks | Runtime enforcement and deterministic automation |

Use hooks when behavior must be guaranteed (for example: block dangerous commands, force validation, auto-inject context).

## Core Principles

1. Keep hooks small and auditable
2. Validate and sanitize hook inputs
3. Avoid hardcoded secrets in scripts
4. Prefer workspace hooks for team policy, user hooks for personal automation

## Anti-patterns

- Running long hooks that block normal flow
- Using hooks where plain instructions are sufficient
- Letting agents edit hook scripts without approval controls
