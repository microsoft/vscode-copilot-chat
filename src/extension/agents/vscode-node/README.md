# LanguageModelServer Refactoring

## Overview

The `LanguageModelServer` has been refactored to separate protocol-specific logic from the generic server functionality using an adapter pattern.

## Architecture

### Before (Original Code)
The original `LanguageModelServer` class had several issues:
- Mixed OpenAI and Anthropic protocol handling in the same methods
- Duplicate message conversion logic
- Protocol-specific response formatting embedded in the server
- Hard to extend for new API formats

### After (Refactored Code)

#### 1. Generic Server (`langModelServer.ts`)
The main `LanguageModelServer` class now focuses on:
- HTTP request/response handling
- VS Code language model selection and invocation
- Generic streaming orchestration
- Error handling and logging

#### 2. Protocol Adapters (`adapters/`)
**`ProtocolAdapter` Interface (`types.ts`)**
```typescript
interface ProtocolAdapter {
  parseRequest(body: string): ParsedRequest;
  formatStreamResponse(part: VSCodePart, context: StreamingContext): StreamEventData[];
  generateFinalEvents(context: StreamingContext): StreamEventData[];
  getContentType(): string;
}
```

**`OpenAIAdapter` (`openaiAdapter.ts`)**
- Handles OpenAI Chat Completions API format
- Converts OpenAI messages to VS Code format
- Formats responses as OpenAI-compatible server-sent events

**`AnthropicAdapter` (`anthropicAdapter.ts`)**
- Handles Anthropic Messages API format
- Converts Anthropic messages to VS Code format
- Formats responses as Anthropic-compatible server-sent events
- Supports complex streaming events (message_start, content_block_start, etc.)

#### 3. Shared Types (`types.ts`)
- `ParsedRequest`: Normalized request format for VS Code
- `StreamingContext`: Maintains state during streaming
- `StreamEventData`: Generic event format

## Benefits

1. **Separation of Concerns**: Server logic is separate from protocol-specific conversion
2. **Extensibility**: Easy to add new API formats (Claude, Gemini, etc.) by implementing new adapters
3. **Testability**: Each adapter can be tested independently
4. **Maintainability**: Protocol-specific logic is contained and easier to debug
5. **Code Reuse**: Common server functionality shared across all protocols

## Usage

The server automatically selects the appropriate adapter based on the request URL:
- `/v1/chat/completions` → `OpenAIAdapter`
- `/anthropic-chat` → `AnthropicAdapter`
- `/` (legacy) → `OpenAIAdapter`

## Future Extensions

To add support for a new API format:
1. Create a new adapter class implementing `ProtocolAdapter`
2. Add message conversion logic in `parseRequest()`
3. Add response formatting in `formatStreamResponse()` and `generateFinalEvents()`
4. Register the adapter in the server constructor

Example:
```typescript
class GeminiAdapter implements ProtocolAdapter {
  // Implementation...
}

// In server constructor:
this.adapters.set('/gemini-chat', new GeminiAdapter());
```
