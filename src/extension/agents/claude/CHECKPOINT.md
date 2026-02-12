# Claude Agent Checkpoint/Rollback Feature

This document explains the checkpoint and rollback capability added to the Claude Agent integration in VS Code Copilot Chat.

## Overview

The Claude Agent now supports checkpoint-based file restoration, allowing users to revert files to their state at any previous point in the conversation. This is powered by the Claude Agent SDK's built-in file checkpointing feature.

## How It Works

### File Checkpointing

When file checkpointing is enabled (`enableFileCheckpointing: true`), the Claude Agent SDK:
1. **Tracks file modifications**: Before modifying any file, the SDK creates a backup
2. **Creates checkpoints**: Each user message in the conversation becomes a checkpoint
3. **Maintains history**: All checkpoints are preserved for the duration of the session
4. **Enables restoration**: Files can be restored to any previous checkpoint state

### User Message Tracking

The extension tracks user message UUIDs automatically:
- Each user message generates a unique UUID in the Claude SDK
- These UUIDs are stored in chronological order
- Synthetic messages (internal to SDK) are excluded
- The list of checkpoints grows throughout the conversation

### Restoration Process

1. User requests checkpoint restoration via `/checkpoint` command
2. System shows available checkpoints (numbered 1, 2, 3, etc.)
3. User selects a checkpoint to restore
4. System performs dry-run to preview changes
5. User confirms the restoration
6. Files are restored to the checkpoint state

## Usage

### Slash Command

The `/checkpoint` slash command is available in Claude Agent chat sessions:

```
/checkpoint              # Shows interactive checkpoint picker
/checkpoint 1            # Restore to checkpoint 1 (most recent)
/checkpoint 2            # Restore to checkpoint 2 (second most recent)
/checkpoint <uuid>       # Restore to specific checkpoint by UUID
```

### Command Palette

You can also access checkpoint functionality via:
- Command: **Claude Agent: Restore Checkpoint** (`copilot.claude.checkpoint`)

### Workflow Example

1. Start a conversation with Claude Agent
2. Ask Claude to make file modifications
3. Continue the conversation with more changes
4. Realize you want to revert to an earlier state
5. Type `/checkpoint` in chat
6. Select the checkpoint to restore from the picker
7. Review the preview (files to change, lines added/removed)
8. Confirm the restoration

## Technical Details

### Implementation

**File**: `src/extension/agents/claude/node/claudeCodeAgent.ts`
- Enabled `enableFileCheckpointing: true` in SDK options
- Added `_userMessageIds` array to track checkpoints
- Modified `handleUserMessage()` to capture UUIDs
- Added `getUserMessageIds()` method for checkpoint access
- Added `rewindToCheckpoint()` method for restoration

**File**: `src/extension/agents/claude/vscode-node/slashCommands/checkpointCommand.ts`
- Implemented `/checkpoint` slash command
- Interactive QuickPick UI for checkpoint selection
- Dry-run preview with file/line statistics
- Confirmation dialog before restoration
- Detailed success/error messaging

### API Methods

**ClaudeCodeSession.getUserMessageIds()**
```typescript
public getUserMessageIds(): readonly string[]
```
Returns an array of user message UUIDs that can be used as checkpoint IDs.

**ClaudeCodeSession.rewindToCheckpoint()**
```typescript
public async rewindToCheckpoint(
  userMessageId: string,
  dryRun = false
): Promise<{
  success: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}>
```
Restores files to their state at the specified checkpoint.
- `userMessageId`: UUID of the checkpoint to restore to
- `dryRun`: If true, preview changes without modifying files
- Returns: Result with success status, error message (if any), and change statistics

**ClaudeAgentManager.getSession()**
```typescript
public getSession(sessionId: string): ClaudeCodeSession | undefined
```
Retrieves an active Claude session for checkpoint operations.

## Relationship to VS Code's Internal Checkpoint Feature

### What VS Code Has (Internal Only)

VS Code core has a sophisticated checkpoint system for its built-in chat editing:
- `IChatEditingCheckpointTimeline` interface
- Checkpoint UI in chat history
- "Restore Checkpoint" action
- Integration with chat history navigation
- Configuration: `chat.checkpoints.enabled`

### What Extensions Cannot Access

**The VS Code checkpoint API is NOT exposed to extensions**. Specifically:
- ❌ No proposed API for `IChatEditingCheckpointTimeline`
- ❌ Cannot create checkpoints in VS Code's timeline
- ❌ Cannot trigger VS Code's checkpoint restoration
- ❌ Cannot use `MenuId.ChatMessageCheckpoint` menu
- ❌ Cannot access internal checkpoint state

### What the Claude Agent Implements

**Separate, extension-level checkpoint system** using Claude SDK:
- ✅ File checkpointing via Claude Agent SDK
- ✅ Independent checkpoint management
- ✅ Own UI (slash commands, QuickPick)
- ✅ Session-scoped checkpoints
- ❌ No integration with VS Code checkpoint UI
- ❌ Does not restore chat history (only files)

This means:
1. Claude Agent checkpoints work independently
2. They don't appear in VS Code's checkpoint timeline
3. They can't be accessed via VS Code's restore button
4. They provide file restoration only (not chat state)
5. They work entirely through the extension's own UI

## Limitations

1. **Session-scoped**: Checkpoints are only available during the active session
   - Checkpoints are lost when the session ends
   - No persistence across VS Code restarts
   - Each new conversation starts fresh

2. **File changes only**: Checkpoints restore file states but not:
   - Chat message history
   - Tool invocation state
   - Conversation context
   - Model configuration changes

3. **No VS Code integration**: 
   - Cannot access VS Code's internal checkpoint UI
   - Separate from VS Code's checkpoint system
   - Extension-specific commands/UI only

4. **Session context**: Current implementation needs proper session context tracking
   - Placeholder for getting current session ID
   - Needs integration with chat widget context
   - May require additional plumbing for production use

## Future Enhancements

Potential improvements for this feature:

1. **Session Context Tracking**
   - Properly track current chat session
   - Associate checkpoints with chat requests
   - Enable checkpoint creation from response context

2. **Persistent Checkpoints**
   - Store checkpoints to disk
   - Restore checkpoints across sessions
   - Integration with Claude session persistence

3. **Advanced UI**
   - Show checkpoint diff previews
   - Visualize checkpoint timeline
   - Inline checkpoint markers in chat history
   - Quick restore buttons in responses

4. **Checkpoint Management**
   - Name/label checkpoints
   - Add checkpoint descriptions
   - Selective file restoration
   - Checkpoint comparison

5. **Integration Options**
   - Git integration for checkpoint commits
   - Workspace state snapshots
   - Undo/redo stack integration

## Conclusion

The Claude Agent checkpoint feature provides file restoration capability using the Claude SDK's built-in checkpointing. While it cannot integrate with VS Code's internal checkpoint system (not exposed to extensions), it offers a practical solution for reverting file changes made during Claude conversations.

The feature is accessible via the `/checkpoint` slash command and provides an interactive UI for selecting and restoring checkpoints with preview and confirmation.
