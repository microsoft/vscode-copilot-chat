# Claude Agent SDK: Summary and Title Generation Investigation

## Executive Summary

**Answer: The Claude Agent SDK does NOT provide built-in automatic conversation title or summary generation.** 

The SDK does expose some summary-related message types (`SDKToolUseSummaryMessage` and `SDKTaskNotificationMessage`), but these are:
1. **Tool summaries** - Summaries of what specific tools accomplished, not conversation summaries
2. **Task notifications** - Notifications about task completion with summaries, not conversation titles

Title and summary generation for conversations appears to be a **layer on top** that applications like Claude Code add themselves, not a core SDK feature.

## Detailed Findings

### 1. SDK Message Types Related to "Summary"

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.39) exposes two message types with "summary" in them:

#### `SDKToolUseSummaryMessage`
```typescript
export declare type SDKToolUseSummaryMessage = {
    type: 'tool_use_summary';
    summary: string;
    preceding_tool_use_ids: string[];
    uuid: UUID;
    session_id: string;
};
```

**Purpose**: Provides a summary of what tools were used and what they accomplished. This is NOT a conversation summary - it's a tool execution summary.

#### `SDKTaskNotificationMessage`
```typescript
export declare type SDKTaskNotificationMessage = {
    type: 'system';
    subtype: 'task_notification';
    task_id: string;
    status: 'completed' | 'failed' | 'stopped';
    output_file: string;
    summary: string;  // Summary of the task output
    uuid: UUID;
    session_id: string;
};
```

**Purpose**: Notifies about task completion with a summary of the task's output. This is task-specific, not a conversation-level summary.

### 2. SDK Features Related to Sessions

The SDK provides robust session management features but NO automatic title/summary generation:

- **Session IDs**: Each session has a unique `session_id`
- **Session Resumption**: Can resume previous sessions by providing `session_id`
- **Session Forking**: Can fork sessions to create new conversation branches
- **Result Messages**: Contains `result` string and `stop_reason` but NO title or summary

#### `SDKResultSuccess`
```typescript
export declare type SDKResultSuccess = {
    type: 'result';
    subtype: 'success';
    duration_ms: number;
    duration_api_ms: number;
    is_error: boolean;
    num_turns: number;
    result: string;  // The final result, but NOT a title or summary
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;
    modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    structured_output?: unknown;
    uuid: UUID;
    session_id: string;
};
```

### 3. Remote Session Title (Push to Claude.ai)

There is ONE reference to `remoteSessionTitle` in the SDK tools:

```typescript
// From sdk-tools.d.ts
export interface ExitPlanModeInput {
  pushToRemote?: boolean;
  remoteSessionId?: string;
  remoteSessionUrl?: string;
  remoteSessionTitle?: string;  // Title when pushing to remote Claude.ai
  [k: string]: unknown;
}
```

**Purpose**: This is for when a session is pushed to the remote Claude.ai service. It allows specifying a title for that remote session. This is NOT automatic generation - the caller must provide the title.

### 4. How VS Code Copilot Chat Currently Handles Titles

The VS Code Copilot Chat extension already implements its own conversation title generation:

**File**: `src/extension/prompt/node/title.ts`

```typescript
export class ChatTitleProvider implements vscode.ChatTitleProvider {
    async provideChatTitle(
        context: vscode.ChatContext,
        token: vscode.CancellationToken,
    ): Promise<string | undefined> {
        // Uses TitlePrompt to generate a title from the first user message
        const endpoint = await this.endpointProvider.getChatEndpoint('copilot-fast');
        const { messages } = await renderPromptElement(
            this.instantiationService, 
            endpoint, 
            TitlePrompt, 
            { userRequest: firstRequest.prompt }
        );
        const response = await endpoint.makeChatRequest2({
            debugName: 'title',
            messages,
            // ... other options
        }, token);
        // Returns the generated title
        return title;
    }
}
```

**How it works**: Makes a separate LLM call with a specialized prompt to generate a title from the conversation context.

### 5. How Claude Code Likely Implements Title/Summary Generation

Based on research and community tools:

1. **Custom Prompts**: Claude Code uses custom system prompts for title and summary generation (see [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts))

2. **Separate API Calls**: Makes additional API calls to Claude to generate titles/summaries when needed

3. **Community Pattern**: Tools like [claude-mem](https://github.com/thedotmack/claude-mem) demonstrate the pattern:
   - Monitor conversation progress
   - At key points (e.g., reaching token limit, session end), trigger a summarization prompt
   - Store the summary/title for later use

4. **Structured Outputs**: Can use the SDK's structured outputs feature to request summaries in a specific format:
   ```
   Title: [descriptive title]
   Goal: [single-sentence goal]
   Decisions: [bullet points]
   Open tasks: [bullet points]
   Blockers: [bullet points]
   Resume: [how to continue]
   ```

### 6. Current Integration Status

The VS Code Claude integration does **NOT** currently use or handle:
- ❌ `SDKToolUseSummaryMessage` - Not processed in message handlers
- ❌ `SDKTaskNotificationMessage` - Not processed in message handlers  
- ❌ `remoteSessionTitle` - Not used when pushing to remote
- ❌ Automatic conversation summaries - Not implemented
- ❌ Automatic conversation titles - Not implemented for Claude sessions

**Current Message Processing** (`src/extension/agents/claude/node/claudeCodeAgent.ts`):
```typescript
if (message.type === 'assistant') {
    // Handle assistant messages
} else if (message.type === 'user') {
    // Handle user messages
} else if (message.type === 'result') {
    // Handle result messages
}
// No handling for 'tool_use_summary' or 'task_notification'
```

### 7. Recommendations

If you want to implement conversation title/summary generation for Claude sessions:

#### Option 1: Follow VS Code's Pattern (Recommended)
Use the existing `ChatTitleProvider` pattern:
1. Create a specialized prompt for title generation
2. Make a separate LLM call with the conversation context
3. Use a fast model (like `copilot-fast`) for cost efficiency
4. Integrate with VS Code's chat title API

#### Option 2: Implement SDK Message Handlers
Handle the SDK's summary message types:
1. Add handlers for `SDKToolUseSummaryMessage` in the message processing loop
2. Add handlers for `SDKTaskNotificationMessage` 
3. Use these for showing what tools accomplished, not for conversation titles

#### Option 3: Custom Summary Generation
Implement custom summary generation:
1. Create hooks that trigger at session end or key milestones
2. Use `SessionEnd` hook to generate a summary prompt
3. Make an API call to generate the summary/title
4. Store in session metadata for future reference

## Conclusion

**The Claude Agent SDK does NOT provide automatic conversation title or summary generation out of the box.** What it does provide are:
- Tool execution summaries (what tools did)
- Task completion notifications
- Session management primitives

Applications like Claude Code implement title and summary generation as a **separate layer on top** of the SDK by:
1. Making additional API calls with custom prompts
2. Using structured output requests
3. Triggering generation at appropriate points in the conversation lifecycle

The VS Code Copilot Chat extension already has title generation implemented for regular chat sessions. To add it for Claude sessions, follow the same pattern with a separate LLM call.
