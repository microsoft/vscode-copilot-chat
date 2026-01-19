# Claude Code Integration

This folder contains the Claude Code integration for VS Code Chat. It enables users to open a new Chat window and interact with a Claude Code instance directly within VS Code. **VS Code provides the UI, Claude Code provides the smarts.**

## Official Documentation

> **Important:** For the most up-to-date information on the Claude Agent SDK, always refer to the official documentation:
>
> - **[Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)** - General SDK concepts, capabilities, and getting started guide
> - **[Agent SDK Quickstart](https://platform.claude.com/docs/en/agent-sdk/quickstart)** - Step-by-step guide to building your first agent
> - **[TypeScript SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)** - Complete API reference for the TypeScript SDK including all functions, types, and interfaces
> - **[TypeScript V2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)** - Preview of the simplified V2 interface with session-based send/stream patterns
>
> The SDK package is `@anthropic-ai/claude-agent-sdk`. The official documentation covers tools, hooks, subagents, MCP integration, permissions, sessions, and more.

## Overview

The Claude Code integration allows VS Code's chat interface to communicate with Claude Code, Anthropic's agentic coding assistant. When a user sends a message in a VS Code Chat window using this integration, the message is routed to a Claude Code session that can:

- Read and analyze code
- Execute shell commands
- Edit files
- Search the workspace
- Manage tasks and todos

All interactions are displayed through VS Code's native chat UI, providing a seamless experience.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         VS Code Chat UI                          │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ClaudeAgentManager                           │
│  - Manages language model server lifecycle                       │
│  - Routes requests to appropriate sessions                       │
│  - Resolves prompts with file references                         │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ClaudeCodeSession                           │
│  - Maintains a single Claude Code conversation                   │
│  - Processes messages (assistant, user, result)                  │
│  - Handles tool invocation and confirmation                      │
│  - Queues multiple requests for sequential processing            │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Claude Code SDK (@anthropic-ai)                 │
│  - Communicates with Claude Code                                 │
│  - Manages tool hooks (pre/post tool use)                        │
│  - Handles message streaming                                     │
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### `node/claudeCodeAgent.ts`

**ClaudeAgentManager**
- Entry point for handling chat requests from VS Code
- Starts and manages the language model server (`LanguageModelServer`)
- Creates and caches `ClaudeCodeSession` instances by session ID
- Resolves prompts by replacing VS Code references (files, locations) with actual paths
- Provides `rewindFiles` method to revert file changes to a previous message state

**ClaudeCodeSession**
- Represents a single Claude Code conversation session
- Manages a queue of incoming requests from VS Code Chat
- Uses an async iterable to feed prompts to Claude Code SDK
- Processes three message types:
  - **Assistant messages**: Text responses and tool use requests
  - **User messages**: Tool results from executed tools
  - **Result messages**: Session completion or error states
- Handles tool confirmation dialogs via VS Code's chat API
- Auto-approves safe operations (file edits in workspace)
- Tracks external edits to show proper diffs
- Enables file checkpointing for rollback functionality
- Provides `rewindFiles` method to restore files to their state at a specific user message

### `node/claudeCodeSdkService.ts`

**IClaudeCodeSdkService / ClaudeCodeSdkService**
- Thin wrapper around the `@anthropic-ai/claude-agent-sdk`
- Provides dependency injection for testability
- Enables mocking in unit tests

### `node/claudeCodeSessionService.ts`

**IClaudeCodeSessionService / ClaudeCodeSessionService**
- Loads and manages persisted Claude Code sessions from disk
- Reads `.jsonl` session files from `~/.claude/projects/<workspace-slug>/`
- Builds message chains from leaf nodes to reconstruct full conversations
- Provides session caching with mtime-based invalidation
- Used to resume previous Claude Code conversations

### `common/claudeTools.ts`

Defines Claude Code's tool interface:
- **ClaudeToolNames**: Enum of all supported tool names (Bash, Read, Edit, Write, etc.)
- **Tool input interfaces**: Type definitions for each tool's input parameters
- **claudeEditTools**: List of tools that modify files (Edit, MultiEdit, Write, NotebookEdit)
- **getAffectedUrisForEditTool**: Extracts file URIs that will be modified by edit operations

### `common/toolInvocationFormatter.ts`

Formats tool invocations for display in VS Code's chat UI:
- Creates `ChatToolInvocationPart` instances with appropriate messaging
- Handles tool-specific formatting (Bash commands, file reads, searches, etc.)
- Suppresses certain tools from display (TodoWrite, Edit, Write) where other UI handles them

## Message Flow

1. **User sends message** in VS Code Chat
2. **ClaudeAgentManager** receives the request and routes to existing or new session
3. **ClaudeCodeSession** queues the request and feeds the prompt to Claude Code SDK
4. **Claude Code SDK** returns streaming messages:
   - Text content → rendered as markdown in chat
   - Tool use requests → shown as progress, then confirmed via VS Code's confirmation API
   - Tool results → formatted and displayed in chat
5. **Result message** signals turn completion, request is resolved

## Tool Confirmation

Claude Code tools require user confirmation before execution:
- **Auto-approved**: File edits (Edit, Write, MultiEdit) are auto-approved if the file is within the workspace
- **Manual confirmation**: All other tools show a confirmation dialog via `CoreConfirmationTool`
- **Denied tools**: User denial sends a "user declined" message back to Claude Code

## Session Persistence

Claude Code sessions are persisted to `~/.claude/projects/<workspace-slug>/` as `.jsonl` files. The `ClaudeCodeSessionService` can:
- Load all sessions for the current workspace
- Resume a previous session by ID
- Cache sessions with mtime-based invalidation

## File Checkpointing and Rollback

The integration enables file checkpointing to support rolling back edits:

**How it works:**
- File checkpointing is enabled automatically via the `enableFileCheckpointing: true` option when starting a Claude session
- The Claude SDK creates backups of files before they are modified during the session
- Each user message in the conversation can serve as a restore point

**API Methods:**
- `ClaudeCodeSession.rewindFiles(userMessageId, dryRun?)`: Rewinds tracked files to their state at a specific user message
  - `userMessageId`: UUID of the user message to rewind to
  - `dryRun` (optional): When `true`, previews changes without modifying files
  - Returns: `RewindFilesResult` with information about which files were changed and statistics
- `ClaudeAgentManager.rewindFiles(sessionId, userMessageId, dryRun?)`: Manager-level method to rewind files in a specific session

**Use Cases:**
- Revert unwanted edits made by Claude
- Experiment with different approaches by rolling back to earlier states
- Preview changes before committing to them using dry-run mode

## Testing

Unit tests are located in `node/test/`:
- `claudeCodeAgent.spec.ts`: Tests for agent and session logic
- `claudeCodeSessionService.spec.ts`: Tests for session loading and persistence
- `mockClaudeCodeSdkService.ts`: Mock SDK service for testing
- `fixtures/`: Sample `.jsonl` session files for testing

## Configuration

The integration respects VS Code settings:
- `github.copilot.advanced.claudeCodeDebugEnabled`: Enables debug logging from Claude Code SDK

## Dependencies

- `@anthropic-ai/claude-agent-sdk`: Official Claude Code SDK
- `@anthropic-ai/sdk`: Anthropic API types
- Internal services: `ILogService`, `IConfigurationService`, `IWorkspaceService`, `IToolsService`, etc.
