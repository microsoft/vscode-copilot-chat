# Growth Chat Sessions Provider

This document describes the Growth Chat Sessions Provider feature, which is designed to send educational messages to teach users how to use GitHub Copilot.

## Overview

The Growth Chat Sessions Provider is a new chat sessions provider that appears in VS Code's chat interface and can send proactive educational messages to users. It's designed to help with product growth by teaching users about Copilot features they may not be aware of.

## Architecture

The implementation consists of three main components:

### 1. GrowthChatSessionItemProvider

Implements `vscode.ChatSessionItemProvider` to manage the list of growth session items.

- **Location**: `src/extension/chatSessions/vscode-node/growthChatSessionItemProvider.ts`
- **Session Type**: `copilot-growth`
- **Purpose**: Provides the list of available growth sessions (currently returns empty array, but can be extended)

### 2. GrowthChatSessionContentProvider

Implements `vscode.ChatSessionContentProvider` to provide the content for growth sessions.

- **Location**: `src/extension/chatSessions/vscode-node/growthChatSessionContentProvider.ts`
- **Purpose**: Returns empty history for now (read-only sessions for educational purposes)

### 3. GrowthChatSessionParticipant

The main participant that handles sending educational messages.

- **Location**: `src/extension/chatSessions/vscode-node/growthChatSessionParticipant.ts`
- **Key Methods**:
  - `sendNeedsInputMessage(message, actionButton?)`: Sends a "needs-input" educational message, optionally with an action button
  - `sendFeatureTip(tip)`: Sends a feature tip message

## Configuration

The feature is controlled by a configuration setting:

```json
{
  "github.copilot.chat.growthMessages.enabled": false
}
```

Set to `true` to enable the growth messages feature.

## Temporary Commands (For Testing)

Two commands are available for testing the growth messages:

### 1. Show Needs-Input Message
**Command ID**: `github.copilot.growth.showNeedsInputMessage`

Shows a welcome message with an action button to start inline chat:
> 👋 Welcome to Copilot! To get started, try asking a question about your code or selecting some code and using inline chat (Ctrl+I).

### 2. Show Feature Tip
**Command ID**: `github.copilot.growth.showFeatureTip`

Shows a tip about using @workspace and @terminal:
> 💡 **Tip**: You can use @workspace to ask questions about your entire codebase, or @terminal to get help with terminal commands.

## Usage Examples

### Sending a Welcome Message

```typescript
const participant = instantiationService.createInstance(GrowthChatSessionParticipant);
await participant.sendNeedsInputMessage(
  'Welcome to Copilot! Here\'s how to get started...',
  { command: 'inlineChat.start', title: 'Try Inline Chat' }
);
```

### Sending a Feature Tip

```typescript
await participant.sendFeatureTip(
  '💡 Pro Tip: Use @workspace to search your entire codebase!'
);
```

## Future Enhancements

Currently, the growth participant displays messages using VS Code's information messages (`showInformationMessage`). Future enhancements could include:

1. **Direct Chat Integration**: Send messages directly through the chat API when that becomes available
2. **Session Management**: Create actual chat sessions for growth messages
3. **Message Scheduling**: Trigger messages based on user behavior or milestones
4. **Analytics**: Track which messages are most effective at teaching users
5. **Personalization**: Show different messages based on user skill level or usage patterns

## Package.json Contribution

The growth chat session is registered in `package.json` with the following properties:

```json
{
  "type": "copilot-growth",
  "name": "growth",
  "displayName": "Growth",
  "icon": "$(lightbulb)",
  "welcomeTitle": "Learn Copilot",
  "welcomeMessage": "Get tips and learn how to use Copilot effectively",
  "inputPlaceholder": "Ask about Copilot features...",
  "order": 99,
  "description": "Educational messages to help you learn Copilot",
  "when": "config.github.copilot.chat.growthMessages.enabled"
}
```

## Testing

Unit tests are available in:
- `src/extension/chatSessions/vscode-node/test/growthChatSessionParticipant.spec.ts`

Run tests with:
```bash
npm run test:unit -- growthChatSessionParticipant.spec.ts
```

## Related Issues

- [microsoft/vscode#292430](https://github.com/microsoft/vscode/issues/292430) - Proposal for unread notification and educational messages
