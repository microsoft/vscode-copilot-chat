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

**Important**: All hook input field names use **snake_case** (e.g., `tool_name`, `tool_input`, `tool_use_id`), not camelCase.

### Common Input Fields

Tool-based hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`) receive:
- `tool_name` (string) - The name of the tool being invoked
- `tool_input` (object) - The input parameters for the tool
- `tool_use_id` (string) - Unique identifier for this tool invocation
- `cwd` (string) - Current working directory

`PostToolUse` additionally receives:
- `tool_response` (string) - The output from the tool execution

`PostToolUseFailure` receives `error` and `is_interrupt` instead of `tool_response`.

### Common Output Fields

All hooks can return:
- `continue` (boolean) - Whether to continue execution (default: true)
- `stopReason` (string) - Reason for stopping (if continue is false)
- `hookSpecificOutput` (object) - Hook-specific output fields (see below)

### Hook-Specific Output

**PreToolUse** hook returns permissions via `hookSpecificOutput`:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "Needs user confirmation",
    "updatedInput": { "path": "/safe/path" },
    "additionalContext": "Remember to validate the path"
  }
}
```

**PostToolUse** hook returns additional context via `hookSpecificOutput`:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Tool completed successfully. Next steps: verify the output."
  }
}
```

### Complete Examples

**PreToolUse Input Example:**
```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "npm install", "mode": "sync" },
  "tool_use_id": "toolu_01abc123",
  "cwd": "/workspace/project"
}
```

**PostToolUse Input Example:**
```json
{
  "tool_name": "Edit",
  "tool_input": { "file_path": "/workspace/src/app.ts", "old_str": "const x = 1;", "new_str": "const x = 2;" },
  "tool_use_id": "toolu_01xyz789",
  "tool_response": "File /workspace/src/app.ts updated successfully",
  "cwd": "/workspace/project"
}
```

### Common Tool Names

When filtering tool-based hooks by `tool_name`, use these values:

**File Operations:**
- `Edit` - Edit existing files
- `MultiEdit` - Edit multiple files
- `Write` - Create new files
- `Read` - Read file contents
- `NotebookEdit` - Edit Jupyter notebooks

**Code Search & Navigation:**
- `Grep` - Search file contents
- `Glob` - Find files by pattern
- `LS` - List directory contents

**Execution:**
- `Bash` - Run shell commands
- `BashOutput` - Get shell command output
- `KillBash` - Stop shell command
- `Task` - Run sub-agent task

**Special:**
- `EnterPlanMode` - Enter planning mode
- `ExitPlanMode` - Exit planning mode
- `TodoWrite` - Write to-do items
- `WebFetch` - Fetch web pages
- `WebSearch` - Search the web
- `AskUserQuestion` - Ask the user a question

### Exit Codes

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
