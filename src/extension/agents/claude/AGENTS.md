# Claude Code Integration

This folder contains the Claude Code integration for VS Code Chat. It enables users to open a new Chat window and interact with a Claude Code instance directly within VS Code. **VS Code provides the UI, Claude Code provides the smarts.**

## Official Claude Agent SDK Documentation

> **Important:** For the most up-to-date information on the Claude Agent SDK, always refer to the official documentation:
>
> - **[Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)** - General SDK concepts, capabilities, and getting started guide
> - **[Agent SDK Quickstart](https://platform.claude.com/docs/en/agent-sdk/quickstart)** - Step-by-step guide to building your first agent
> - **[TypeScript SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)** - Complete API reference for the TypeScript SDK including all functions, types, and interfaces
> - **[TypeScript V2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)** - Preview of the simplified V2 interface with session-based send/stream patterns
>
> The SDK package is `@anthropic-ai/claude-agent-sdk`. The official documentation covers tools, hooks, subagents, MCP integration, permissions, sessions, and more.

### Core SDK Features

**Getting Started:**
- [Overview](https://platform.claude.com/docs/en/agent-sdk/overview) - Learn about the Agent SDK architecture and core concepts
- [Quickstart](https://platform.claude.com/docs/en/agent-sdk/quickstart) - Get up and running with your first agent in minutes

**Core SDK Implementation:**
- [TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript) - Main TypeScript SDK reference for building agents
- [TypeScript v2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview) - Preview of upcoming v2 API with enhanced features
- [Streaming vs Single Mode](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) - Choose between streaming responses or single-turn completions

**User Interaction & Control:**
- [Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions) - Control what actions Claude can take with user approval flows
- [User Input](https://platform.claude.com/docs/en/agent-sdk/user-input) - Collect clarifications and decisions from users during execution
- [Hooks](https://platform.claude.com/docs/en/agent-sdk/hooks) - Execute custom logic at key points in the agent lifecycle

**State & Session Management:**
- [Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions) - Manage conversation history and context across interactions
- [File Checkpointing](https://platform.claude.com/docs/en/agent-sdk/file-checkpointing) - Save and restore file states for undo/redo functionality

**Advanced Features:**
- [Structured Outputs](https://platform.claude.com/docs/en/agent-sdk/structured-outputs) - Get reliable JSON responses with schema validation
- [Modifying System Prompts](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts) - Customize Claude's behavior and instructions
- [MCP](https://platform.claude.com/docs/en/agent-sdk/mcp) - Connect to Model Context Protocol servers for extended capabilities
- [Custom Tools](https://platform.claude.com/docs/en/agent-sdk/custom-tools) - Build your own tools to extend Claude's functionality

**Agent Composition & UX:**
- [Subagents](https://platform.claude.com/docs/en/agent-sdk/subagents) - Compose complex workflows by delegating to specialized agents
- [Slash Commands](https://platform.claude.com/docs/en/agent-sdk/slash-commands) - Add custom `/commands` for quick actions
- [Skills](https://platform.claude.com/docs/en/agent-sdk/skills) - Package reusable agent capabilities as installable modules
- [Todo Tracking](https://platform.claude.com/docs/en/agent-sdk/todo-tracking) - Help Claude manage and display task progress
- [Plugins](https://platform.claude.com/docs/en/agent-sdk/plugins) - Extend the SDK with community-built integrations

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

### `node/claudeCodeSdkService.ts`

**IClaudeCodeSdkService / ClaudeCodeSdkService**
- Thin wrapper around the `@anthropic-ai/claude-agent-sdk`
- Provides dependency injection for testability
- Enables mocking in unit tests

### `node/sessionParser/claudeCodeSessionService.ts`

**IClaudeCodeSessionService / ClaudeCodeSessionService**
- Loads and manages persisted Claude Code sessions from disk
- Reads `.jsonl` session files from `~/.claude/projects/<workspace-slug>/`
- Builds message chains from leaf nodes to reconstruct full conversations
- Discovers and parses subagent sessions from `{session-id}/subagents/agent-*.jsonl`
- Provides session caching with mtime-based invalidation
- Used to resume previous Claude Code conversations
- See `node/sessionParser/README.md` for detailed documentation

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

## Testing

Unit tests are located in `node/test/`:
- `claudeCodeAgent.spec.ts`: Tests for agent and session logic
- `claudeCodeSessionService.spec.ts`: Tests for session loading and persistence
- `mockClaudeCodeSdkService.ts`: Mock SDK service for testing
- `fixtures/`: Sample `.jsonl` session files for testing

## Extension Registries

The Claude integration uses several registries to organize and manage extensibility points:

### Hook Registry

**Location:** `node/hooks/claudeHookRegistry.ts`

The hook registry allows registering custom hooks that execute at key points in the agent lifecycle. Hooks are organized by `HookEvent` type from the Claude SDK.

**Key Features:**
- Register handlers using `registerClaudeHook(hookEvent, ctor)`
- Handlers are constructed via dependency injection using `IInstantiationService`
- Hook instances are built from the registry and passed to the Claude SDK
- Multiple handlers can be registered for the same event

**Example Hook Events:**
- `'PreToolUse'` - Before a tool is executed
- `'PostToolUse'` - After a tool completes
- `'SubagentStart'` - When a subagent starts
- `'SubagentEnd'` - When a subagent completes
- `'SessionStart'` - When a session begins
- `'SessionEnd'` - When a session ends

**Current Hook Handlers:**
- `loggingHooks.ts` - Logging hooks for debugging and telemetry
- `sessionHooks.ts` - Session lifecycle management
- `subagentHooks.ts` - Subagent lifecycle tracking
- `toolHooks.ts` - Tool execution tracking and processing

### Slash Command Registry

**Location:** `vscode-node/slashCommands/claudeSlashCommandRegistry.ts`

The slash command registry manages custom slash commands available in Claude chat sessions. Commands allow users to trigger specific functionality via `/commandname` syntax.

**Key Features:**
- Register handlers using `registerClaudeSlashCommand(handler)`
- Each handler implements `IClaudeSlashCommandHandler` interface
- Commands can optionally register with VS Code Command Palette
- Handlers receive arguments, response stream, and cancellation token

**Handler Interface:**
```typescript
interface IClaudeSlashCommandHandler {
	readonly commandName: string;        // Command name (without /)
	readonly description: string;         // Human-readable description
	readonly commandId?: string;          // Optional VS Code command ID
	handle(args: string, stream: ChatResponseStream | undefined, token: CancellationToken): Promise<ChatResult | void>;
}
```

**UI Patterns for Slash Commands:**

Slash commands often need to present choices or gather input from users. When doing so, prefer the simpler one-shot APIs over the more complex builder APIs:

- **Prefer:** `vscode.window.showQuickPick()` - Simple function call that returns the selected item(s)
- **Avoid:** `vscode.window.createQuickPick()` - More complex, requires manual lifecycle management

- **Prefer:** `vscode.window.showInputBox()` - Simple function call that returns the entered text
- **Avoid:** `vscode.window.createInputBox()` - More complex, requires manual lifecycle management

The `show*` APIs are sufficient for most slash command use cases and result in cleaner, more maintainable code. Only use `create*` APIs when you need advanced features like dynamic item updates, multi-step wizards, or custom event handling.

**Current Slash Commands:**
- `/hooks` - Configure Claude Agent hooks for tool execution and events (from `hooksCommand.ts`)
- `/memory` - Open memory files (CLAUDE.md) for editing (from `memoryCommand.ts`)
- `/agents` - Create and manage specialized Claude agents (from `agentsCommand.ts`)
- `/terminal` - Create a terminal with Claude CLI configured to use Copilot Chat endpoints (from `terminalCommand.ts`) _Temporarily disabled pending legal review_

### Tool Permission Handlers

**Location:** `node/toolPermissionHandlers/` and `common/toolPermissionHandlers/`

Tool permission handlers control what actions Claude can take without user confirmation. They define the approval logic for various tool operations.

**Key Features:**
- Auto-approve safe operations (e.g., file edits within workspace)
- Request user confirmation for potentially dangerous operations
- Handlers are organized by platform (common, node, vscode-node)

**Handler Types:**
- **Common handlers** (`common/toolPermissionHandlers/`):
  - `bashToolHandler.ts` - Controls bash/shell command execution
  - `exitPlanModeHandler.ts` - Manages plan mode transitions

- **Node handlers** (`node/toolPermissionHandlers/`):
  - `editToolHandler.ts` - Handles file edit operations (Edit, Write, MultiEdit)

- **VS Code-Node handlers** (`vscode-node/toolPermissionHandlers/`):
  - `askUserQuestionHandler.ts` - Handles user question prompts via VS Code QuickPick UI

**Auto-approval Rules:**
- File edits are auto-approved if the file is within the workspace
- All other tools show a confirmation dialog via VS Code's chat API
- User denials send appropriate messages back to Claude

**Extending the Registries:**

To add new functionality:

1. **New Hook Handler:**
   - Create a class implementing `HookCallbackMatcher`
   - Call `registerClaudeHook(hookEvent, YourHandler)` at module load time
   - Import your handler module in `node/hooks/index.ts`

2. **New Slash Command:**
   - Create a class implementing `IClaudeSlashCommandHandler`
   - Call `registerClaudeSlashCommand(YourHandler)` at module load time
   - Import your command module in `vscode-node/slashCommands/index.ts`
   - If providing a `commandId`, register the command in `package.json`:
     ```json
     {
       "command": "copilot.claude.yourCommand",
       "title": "Your Command Title",
       "category": "Claude Agent"
     }
     ```

3. **New Tool Permission Handler:**
   - Create handler in appropriate directory (common/node/vscode-node)
   - Implement tool approval logic
   - Import your handler module in `index.ts` to trigger registration

## Configuration

The integration respects VS Code settings:
- `github.copilot.advanced.claudeCodeDebugEnabled`: Enables debug logging from Claude Code SDK

## Upgrading Anthropic SDK Packages

This section documents the process for upgrading the Anthropic SDK packages used in the Claude integration.

### Packages

| Package | Description |
|---------|-------------|
| `@anthropic-ai/claude-agent-sdk` | Official Claude Agent SDK - provides the core agent runtime, tools, hooks, sessions, and message streaming |
| `@anthropic-ai/sdk` | Anthropic API SDK - provides base types, API client, and message structures used by the agent SDK |

### Upgrade Process

#### 1. Check Current Versions and Changelog

Before upgrading, review the current versions in `package.json` and check the release notes:

- **Claude Agent SDK Releases**: https://github.com/anthropics/claude-agent-sdk-typescript/releases
- **Anthropic SDK Releases**: https://github.com/anthropics/anthropic-sdk-typescript/releases

#### 2. Summarize All Changes

Create a consolidated summary of changes between your current version and the target version. Group changes by category, not by individual version:

**Summary Format:**
```markdown
### `@anthropic-ai/package-name` (oldVersion → newVersion)

#### Features
- **Category:** Description of new feature or capability

#### Bug Fixes
- Description of what was fixed

#### Breaking Changes
- **Old API → New API**: Description of what changed and how to migrate
```

**How to Create the Summary:**
1. **Read the GitHub Release Notes**: Go through each release between your versions
2. **Consolidate by Category**: Group all features together, all bug fixes together, etc.
3. **Identify Breaking Changes**: Look for:
   - Removed or renamed exports
   - Changed function signatures
   - Modified type definitions
   - Deprecated APIs that have been removed
4. **Document Migration Steps**: For breaking changes, include the old and new patterns
5. **Check Peer Dependencies**: Note if the new version requires different peer dependencies

#### 3. List Important Changes

Categorize changes by impact level:

**Critical (Must Address Before Merge):**
- Breaking API changes that will cause compilation errors
- Removed types or functions currently in use
- Changed behavior of core functionality (sessions, streaming, tools)

**Important (Should Address):**
- Deprecated APIs that should be migrated
- New recommended patterns replacing old ones
- Performance improvements that require code changes

**Nice to Have (Can Address Later):**
- New optional features
- Additional type exports
- Enhanced error messages

#### 4. Update Package Versions

```bash
# Update to latest
npm install @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk
```

#### 5. Fix Compilation Errors

After updating, check for compilation errors:

1. Run the `start-watch-tasks` VS Code task to see real-time compilation errors
2. Address any type errors in the following key files:
   - `node/claudeCodeAgent.ts` - Session and message handling
   - `node/claudeCodeSdkService.ts` - SDK wrapper
   - `node/claudeCodeSessionService.ts` - Session persistence
   - `common/claudeTools.ts` - Tool type definitions
   - `node/hooks/*.ts` - Hook implementations
   - `vscode-node/slashCommands/*.ts` - Slash command handlers
   - `node/toolPermissionHandlers/*.ts` - Permission handlers

#### 6. Things to Test

After upgrading, verify the following functionality works correctly:

**Core Functionality:**
- [ ] Starting a new Claude chat session
- [ ] Sending messages and receiving responses
- [ ] Streaming responses render correctly in the chat UI
- [ ] Session persistence and resumption works

**Tool Operations:**
- [ ] `Read` tool - Reading files displays content correctly
- [ ] `Edit` tool - File edits apply correctly with proper diffs
- [ ] `Write` tool - New files are created correctly
- [ ] `Bash` tool - Shell commands execute and return output
- [ ] `Glob` tool - File pattern matching works
- [ ] `Grep` tool - Content search works
- [ ] `WebFetch` tool - URL fetching works (if applicable)

**Tool Confirmation:**
- [ ] Auto-approval works for workspace files
- [ ] Confirmation dialogs appear for dangerous operations
- [ ] Denying a tool sends appropriate message to Claude
- [ ] Tool invocation formatting displays correctly in chat

**Hooks:**
- [ ] `PreToolUse` hooks fire before tool execution
- [ ] `PostToolUse` hooks fire after tool completion
- [ ] `SessionStart`/`SessionEnd` hooks work correctly
- [ ] Logging hooks capture expected data

**Slash Commands:**
- [ ] `/hooks` command works
- [ ] `/memory` command works
- [ ] `/agents` command works
- [ ] (If enabled) `/terminal` command works

**Edge Cases:**
- [ ] Cancellation during streaming works correctly
- [ ] Error handling for failed tool operations
- [ ] Large file handling
- [ ] Multi-turn conversations maintain context
- [ ] Subagent execution (if used)

**Regression Testing:**
- [ ] Run unit tests: `npm run test:unit` (filter to claude-related tests)
- [ ] Run integration tests for the Claude agent
- [ ] Manual testing in VS Code with various prompts

#### 7. Update Documentation

After a successful upgrade:

1. Update this `AGENTS.md` if any architectural changes occurred
2. Update type definitions in `common/claudeTools.ts` if tools changed
3. Document any new features or capabilities added
4. Update the "Official Claude Agent SDK Documentation" links if URLs changed

### Troubleshooting Common Issues

**Type Errors After Upgrade:**
- Check if types were renamed (common: `Message` → `ContentBlock`, etc.)
- Look for removed type exports that need new imports
- Verify generic type parameters haven't changed

**Session Loading Failures:**
- Session file format may have changed between major versions
- Check `ClaudeCodeSessionService` for compatibility issues
- May need to clear old session files during major upgrades

**Hook Registration Failures:**
- Hook event names may have changed
- Check `HookEvent` type for valid event strings
- Verify hook callback signatures match new SDK expectations

**Tool Execution Errors:**
- Tool input schemas may have changed
- Check tool result handling for new error types
- Verify tool confirmation flow hasn't changed

## Dependencies

- `@anthropic-ai/claude-agent-sdk`: Official Claude Code SDK
- `@anthropic-ai/sdk`: Anthropic API types
- Internal services: `ILogService`, `IConfigurationService`, `IWorkspaceService`, `IToolsService`, etc.
