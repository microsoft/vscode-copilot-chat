# OpenCode Integration Specification

## Overview

This document provides a comprehensive specification for integrating OpenCode as a chat session provider in VS Code, following the established patterns from the Claude SDK integration.

## Background: Claude Integration Analysis

### Claude Architecture Components

The Claude integration consists of several key components that work together to provide a seamless chat experience:

#### 1. ClaudeAgentManager (`claudeCodeAgent.ts`)
- **Purpose**: Main orchestrator for Claude interactions
- **Key Responsibilities**:
  - Manages language model server lifecycle (`LanguageModelServer`)
  - Handles incoming `vscode.ChatRequest` from VS Code
  - Creates and manages `ClaudeCodeSession` instances
  - Processes tool permission requests with user confirmations
  - Resolves chat prompts and references
  - Error handling for Claude CLI errors

#### 2. ClaudeCodeSessionService (`claudeCodeSessionService.ts`)
- **Purpose**: Session persistence and management
- **Key Responsibilities**:
  - Reads session data from `~/.claude/projects/<folder-slug>/` directory
  - Parses JSONL files containing session messages and metadata
  - Implements caching with file modification time validation
  - Builds session chains from parent-child message relationships
  - Strips attachments from stored messages
  - Generates session labels from summaries or first user message

#### 3. ClaudeChatSessionContentProvider (`claudeChatSessionContentProvider.ts`)
- **Purpose**: VS Code chat session integration
- **Key Responsibilities**:
  - Implements `vscode.ChatSessionContentProvider` interface
  - Converts Claude SDK messages to VS Code chat history format
  - Handles tool invocations and results formatting
  - Manages session continuity between requests
  - Processes tool results and updates pending invocations

#### 4. ClaudeChatSessionItemProvider (`claudeChatSessionItemProvider.ts`)
- **Purpose**: Session list management for VS Code UI
- **Key Responsibilities**:
  - Implements `vscode.ChatSessionItemProvider` interface
  - Provides list of available Claude sessions to VS Code
  - Handles creation of new sessions
  - Manages bidirectional session ID mapping (internal ↔ Claude)
  - Tracks unresolved sessions until Claude session ID is available

#### 5. Tool Integration
- **Purpose**: Format and display tool invocations
- **Key Features**:
  - Comprehensive tool support (bash, file operations, web search, etc.)
  - User confirmation dialogs for potentially dangerous operations
  - Auto-approval for safe operations (reading/writing approved files)
  - Formatted tool result display in VS Code chat interface
  - Special handling for TodoWrite tool integration

### Claude Integration Flow

1. **Registration**: `ChatSessionsContrib` registers Claude providers with VS Code.
2. **Session Listing**: VS Code requests the list of available sessions → `provideChatSessionItems()`.
3. **Session Creation**: User creates a new session → `provideNewChatSessionItem()`.
4. **Content Loading**: VS Code requests session content → `provideChatSessionContent()`.
5. **Request Handling**: New user messages → `ClaudeAgentManager.handleRequest()`.
6. **Tool Execution**: Tools invoked with permission handling.
7. **Response Streaming**: Real-time streaming back to VS Code.
8. **Persistence**: Claude SDK handles automatic session persistence.

## OpenCode Integration Plan

### OpenCode Architecture Overview

OpenCode uses a **server/client architecture** instead of a direct SDK:

- **Server**: `opencode serve` runs as headless HTTP server exposing OpenAPI endpoints
- **Client**: Node.js client library communicates with server via HTTP
- **API**: RESTful API with WebSocket events for real-time updates
- **Sessions**: Server-managed sessions with message persistence
- **Tools**: Built-in tool ecosystem similar to Claude

### Proposed OpenCode Integration Architecture

#### 1. OpenCodeServerManager (`opencode/node/opencodeServerManager.ts`)

**Purpose**: Manage OpenCode server lifecycle (equivalent to `LanguageModelServer` for Claude)

```typescript
export class OpenCodeServerManager extends Disposable {
  private _server: OpenCodeServer | undefined;

  // Similar to LanguageModelServer but for OpenCode
  async start(): Promise<{ url: string; port: number }>;
  async stop(): Promise<void>;
  getConfig(): IOpenCodeServerConfig;
  isRunning(): boolean;
}

interface IOpenCodeServerConfig {
  url: string;
  port: number;
  hostname: string;
}

class OpenCodeServer {
  constructor(
    private readonly config: IOpenCodeServerConfig,
    private readonly workspaceFolder: string
  );

  async start(): Promise<void>;
  async stop(): Promise<void>;
  getUrl(): string;
}
```

**Key Responsibilities**:
- Spawn and manage the `opencode serve` child process.
- Pass necessary arguments to the `opencode serve` command (e.g., `--port`, `--hostname`).
- Monitor the server's stdout and stderr streams for logging and health checking.
- Handle server process termination, restarts, and error recovery.
- Provide the server's URL and port to other components like `OpenCodeAgentManager`.
- Manage workspace-specific configurations and pass them to the server via the `OPENCODE_CONFIG_CONTENT` environment variable.

#### 2. OpenCodeAgentManager (`opencode/node/opencodeAgentManager.ts`)

**Purpose**: Main orchestrator (equivalent to `ClaudeAgentManager`)

```typescript
export class OpenCodeAgentManager extends Disposable {
  private _serverManager: OpenCodeServerManager;
  private _client: OpencodeClient | undefined;

  async handleRequest(
    sessionId: string | undefined,
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult & { sessionId?: string }>;

  private async getClient(): Promise<OpencodeClient>;
  private resolvePrompt(request: vscode.ChatRequest): string;
  private handleToolPermissions(toolName: string, input: any): Promise<boolean>;
}
```

**Key Responsibilities**:
- Manage OpenCode server lifecycle via `OpenCodeServerManager`
- Create and configure `OpencodeClient` instances
- Handle incoming VS Code chat requests
- Process tool permissions and confirmations
- Convert VS Code requests to OpenCode API calls
- Stream responses back to VS Code
- Error handling and recovery

#### 3. OpenCodeSessionService (`opencode/node/opencodeSessionService.ts`)

**Purpose**: Session management and persistence (equivalent to `ClaudeCodeSessionService`)

```typescript
export interface IOpenCodeSessionService {
  getAllSessions(token: CancellationToken): Promise<readonly IOpenCodeSession[]>;
  getSession(sessionId: string, token: CancellationToken): Promise<IOpenCodeSession | undefined>;
  createSession(options?: CreateSessionOptions): Promise<IOpenCodeSession>;
}

export interface IOpenCodeSession {
  id: string;
  label: string;
  messages: readonly OpenCodeMessage[];
  timestamp: Date;
  status: 'active' | 'idle' | 'completed' | 'error';
}

export class OpenCodeSessionService implements IOpenCodeSessionService {
  constructor(
    @IOpenCodeServerManager private serverManager: IOpenCodeServerManager,
    @ILogService private logService: ILogService
  );

  // Use OpenCode HTTP API instead of reading files directly
  async getAllSessions(token: CancellationToken): Promise<readonly IOpenCodeSession[]>;
  async getSession(sessionId: string, token: CancellationToken): Promise<IOpenCodeSession | undefined>;
}
```

**Key Differences from Claude**:
- Uses HTTP API calls instead of reading JSONL files
- Server-managed sessions instead of file-based persistence
- Real-time session updates via WebSocket events
- Built-in session status tracking

#### 4. OpenCodeChatSessionContentProvider (`opencode/vscode-node/opencodeContentProvider.ts`)

**Purpose**: VS Code integration (equivalent to `ClaudeChatSessionContentProvider`)

```typescript
export class OpenCodeChatSessionContentProvider implements vscode.ChatSessionContentProvider {
  constructor(
    private readonly agentManager: OpenCodeAgentManager,
    private readonly sessionStore: OpenCodeSessionDataStore,
    @IOpenCodeSessionService private readonly sessionService: IOpenCodeSessionService
  );

  async provideChatSessionContent(
    internalSessionId: string,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatSession>;

  private buildChatHistory(session: IOpenCodeSession): (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[];
  private convertMessageToVSCode(message: OpenCodeMessage): vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2;
}
```

**Key Responsibilities**:
- Convert OpenCode messages to VS Code chat format
- Handle session continuity and state management
- Process tool invocations and results
- Manage real-time updates via OpenCode events

#### 5. OpenCodeChatSessionItemProvider (`opencode/vscode-node/opencodeItemProvider.ts`)

**Purpose**: Session list management (equivalent to `ClaudeChatSessionItemProvider`)

```typescript
export class OpenCodeChatSessionItemProvider implements vscode.ChatSessionItemProvider {
  constructor(
    private readonly sessionStore: OpenCodeSessionDataStore,
    @IOpenCodeSessionService private readonly sessionService: IOpenCodeSessionService
  );

  async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]>;
  async provideNewChatSessionItem(options: NewSessionOptions): Promise<vscode.ChatSessionItem>;
}
```

**Key Responsibilities**:
- Implements the `vscode.ChatSessionItemProvider` interface.
- Fetches the list of available `opencode` sessions from the `OpenCodeSessionService`.
- Converts the `IOpenCodeSession` objects into `vscode.ChatSessionItem` objects for display in the VS Code UI.
- Handles the creation of new chat sessions when requested by the user, invoking `OpenCodeSessionService.createSession`.
- Manages the mapping between VS Code's internal session IDs and `opencode`'s session IDs.

#### 6. Tool Integration (`opencode/common/opencodeTools.ts`)

**Purpose**: Tool formatting and handling (equivalent to Claude's tool system)

```typescript
export enum OpenCodeToolNames {
  Shell = 'shell',
  FindFiles = 'find_files',
  FindText = 'find_text',
  FindSymbols = 'find_symbols',
  ReadFile = 'read_file',
  WriteFile = 'write_file',
  EditFile = 'edit_file',
  // ... other tools
}

export function createFormattedToolInvocation(
  toolInvocation: OpenCodeToolInvocation,
  toolResult?: OpenCodeToolResult
): ChatToolInvocationPart | undefined;
```

### Implementation Differences from Claude

#### Server Management
- **Claude**: Uses language model server with nonce-based auth
- **OpenCode**: Uses headless HTTP server with standard REST API
- **Implementation**: Create `OpenCodeServerManager` to handle `opencode serve` lifecycle

#### Session Persistence
- **Claude**: File-based JSONL storage with manual parsing
- **OpenCode**: Server-managed sessions via HTTP API
- **Implementation**: Use OpenCode's session API endpoints instead of file reading

#### Real-time Updates
- **Claude**: Polling and message streaming via SDK
- **OpenCode**: WebSocket events for real-time session updates
- **Implementation**: Subscribe to OpenCode events for live session updates

#### Tool System
- **Claude**: Built into SDK with permission callbacks
- **OpenCode**: HTTP API endpoints with similar tool ecosystem
- **Implementation**: Map OpenCode tools to VS Code tool invocation format

#### Authentication
- **Claude**: API key based with local storage, using a nonce for the local server.
- **OpenCode**: The `opencode serve` process appears to handle authentication based on the configuration passed via the `OPENCODE_CONFIG_CONTENT` environment variable. There is no explicit auth token passed as a command-line argument.
- **Implementation**:
  - The `OpenCodeServerManager` will be responsible for creating the necessary configuration for authentication.
  - This configuration will be passed to the `opencode serve` process through the `OPENCODE_CONFIG_CONTENT` environment variable.
  - The `OpenCodeAgentManager` and its `OpenCodeClient` will need to use the same configuration to authenticate with the server.

## Detailed Implementation Steps

This document breaks down the implementation of the OpenCode integration into a series of sequential steps that can be delegated to background agents.

## [x] Phase 1: Core Infrastructure

### [x] Step 1.1: Create `OpenCodeServerManager`
- **Task:** Create the file `src/extension/agents/opencode/node/opencodeServerManager.ts`.
- **Details:**
    - Define the `OpenCodeServerManager` class.
    - Implement the `start`, `stop`, `getConfig`, and `isRunning` methods based on the `createOpencodeServer` function from the `opencode` SDK.
    - The `start` method should spawn the `opencode serve` process and handle its lifecycle.
    - Add logging for the server's stdout and stderr.

### [x] Step 1.2: Implement `OpenCodeClient`
- **Task:** Create a client to communicate with the `opencode` server. This could be a new class or an integration of an existing SDK.
- **Details:**
    - Create a file `src/extension/agents/opencode/node/opencodeClient.ts`.
    - Implement methods for making API calls to the `opencode` server (e.g., for sessions, tools, etc.).
    - Handle authentication based on the `OPENCODE_CONFIG_CONTENT` environment variable.

### [x] Step 1.3: Create `IOpenCodeSessionService`
- **Task:** Create the `IOpenCodeSessionService` interface and its implementation.
- **Details:**
    - Create the file `src/extension/agents/opencode/node/opencodeSessionService.ts`.
    - Define the `IOpenCodeSessionService` interface with methods like `getAllSessions`, `getSession`, and `createSession`.
    - Implement the `OpenCodeSessionService` class, which will use the `OpenCodeClient` to interact with the server's session endpoints.

## Phase 2: VS Code Integration

### Step 2.1: Create `OpenCodeAgentManager`
- **Task:** Create the `OpenCodeAgentManager` class.
- **Details:**
    - Create the file `src/extension/agents/opencode/node/opencodeAgentManager.ts`.
    - This class will be the main orchestrator for `opencode` chat requests.
    - It will use the `OpenCodeServerManager` to manage the server and the `OpenCodeClient` to send requests.
    - Implement the `handleRequest` method to process `vscode.ChatRequest` objects.

### Step 2.2: Implement `OpenCodeChatSessionContentProvider`
- **Task:** Implement the `vscode.ChatSessionContentProvider` interface.
- **Details:**
    - Create the file `src/extension/agents/opencode/vscode-node/opencodeContentProvider.ts`.
    - Implement the `provideChatSessionContent` method to fetch session history from the `OpenCodeSessionService` and convert it to the VS Code chat format.

### Step 2.3: Implement `OpenCodeChatSessionItemProvider`
- **Task:** Implement the `vscode.ChatSessionItemProvider` interface.
- **Details:**
    - Create the file `src/extension/agents/opencode/vscode-node/opencodeItemProvider.ts`.
    - Implement the `provideChatSessionItems` method to list available sessions and `provideNewChatSessionItem` to create new sessions.

### Step 2.4: Implement Tool Integration
- **Task:** Create the necessary files for tool integration.
- **Details:**
    - Create `src/extension/agents/opencode/common/opencodeTools.ts` to define the tool names and interfaces.
    - Create `src/extension/agents/opencode/common/toolInvocationFormatter.ts` to format tool invocations for the chat UI.

## Phase 3: Registration and Testing

### Step 3.1: Register Providers
- **Task:** Register the `opencode` chat providers with VS Code.
- **Details:**
    - Create `src/extension/agents/opencode/vscode-node/opencodeContribution.ts`.
    - In this file, create a class that registers the `OpenCodeChatSessionContentProvider` and `OpenCodeChatSessionItemProvider`.

### Step 3.2: Write Unit Tests
- **Task:** Write unit tests for the new components.
- **Details:**
    - Create test files under `src/extension/agents/opencode/node/test/`.
    - Write tests for `OpenCodeServerManager`, `OpenCodeAgentManager`, and `OpenCodeSessionService`.

### Step 3.3: Write Integration Tests
- **Task:** Write integration tests for the `opencode` integration.
- **Details:**
    - Create integration tests that use a mock `opencode` server to test the end-to-end flow.

## Phase 4: Advanced Features

### Step 4.1: Implement Real-time Updates
- **Task:** Implement WebSocket event handling for real-time updates.
- **Details:**
    - Extend the `OpenCodeClient` to connect to the server's WebSocket endpoint.
    - Update the `OpenCodeChatSessionContentProvider` to handle real-time events and update the chat view accordingly.

### Step 4.2: Add Configuration Settings
- **Task:** Add `opencode`-specific settings to the extension's `package.json` and handle them in the code.
- **Details:**
    - Add the `OpenCodeConfiguration` settings to `package.json`.
    - Use the `IConfigurationService` to read the settings and configure the `OpenCodeServerManager` and other components.

## File Structure

```
src/extension/agents/opencode/
├── spec.md                                    # This specification document
├── common/
│   ├── opencodeTools.ts                       # Tool definitions and types
│   └── toolInvocationFormatter.ts             # Tool formatting utilities
├── node/
│   ├── opencodeServerManager.ts               # Server lifecycle management
│   ├── opencodeAgentManager.ts                # Main agent orchestrator
│   ├── opencodeSessionService.ts              # Session management service
│   └── test/
│       ├── opencodeAgentManager.spec.ts
│       ├── opencodeSessionService.spec.ts
│       └── fixtures/
└── vscode-node/
    ├── opencodeContentProvider.ts             # VS Code content provider
    ├── opencodeItemProvider.ts                # VS Code item provider
    └── opencodeContribution.ts                # Registration and contribution
```

## Dependencies

### Required Packages
- `@opencode/sdk` or equivalent HTTP client library
- WebSocket client for real-time events
- Standard VS Code extension dependencies

### VS Code API Requirements
- `vscode.chat.registerChatSessionItemProvider`
- `vscode.chat.registerChatSessionContentProvider`
- Proposed chat sessions API extensions

## Configuration Schema

```typescript
interface OpenCodeConfiguration {
  // Server settings
  server: {
    hostname: string;          // Default: "127.0.0.1"
    port: number;             // Default: 4096 (or 0 for a random port)
    timeout: number;          // Default: 5000ms
    autoStart: boolean;       // Default: true
    logLevel: "debug" | "info" | "warn" | "error"; // Default: "info"
    logFilePath?: string;     // Optional path to a log file
    // The `config` object to be passed to the `opencode serve` process
    // The structure of this object is defined by the `Config` type in the opencode SDK.
    config?: any;
  };

  // Session settings
  session: {
    autoSave: boolean;        // Default: true
    maxHistory: number;       // Default: 100
    enableRealTimeSync: boolean; // Default: true
  };

  // Tool settings
  tools: {
    enablePermissions: boolean;    // Default: true
    autoApproveReadOnly: boolean; // Default: true
    dangerousToolsConfirm: boolean; // Default: true
  };

  // Model and agent settings
  defaultModel?: string;
  defaultAgent?: string;

  // Workspace specific
  workspace: {
    enableProjectAnalysis: boolean; // Default: true
    watchFiles: boolean;           // Default: true
  };
}
```

## Migration Path

### From Claude Integration
1. Follow established patterns from Claude implementation
2. Reuse VS Code integration patterns and interfaces
3. Adapt tool system to OpenCode's API structure
4. Maintain consistent user experience across agents

### Incremental Rollout
1. Start with basic session management
2. Add tool integration incrementally
3. Implement advanced features after core stability
4. Add configuration and customization options

## Success Criteria

### Functional Requirements
- [ ] OpenCode server lifecycle management
- [ ] Session creation, persistence, and recovery
- [ ] Real-time message streaming and updates
- [ ] Tool invocation with permission handling
- [ ] VS Code chat interface integration
- [ ] Error handling and recovery mechanisms

### Performance Requirements
- [ ] Server startup time < 5 seconds
- [ ] Session loading time < 2 seconds
- [ ] Real-time message latency < 500ms
- [ ] Memory usage comparable to Claude integration

### User Experience Requirements
- [ ] Consistent with Claude integration patterns
- [ ] Intuitive session management
- [ ] Clear tool permission dialogs
- [ ] Responsive real-time updates
- [ ] Comprehensive error messages

## Risk Mitigation

### Technical Risks
1. **Server Stability**: Implement health checking and auto-recovery
2. **API Changes**: Version lock OpenCode dependencies, handle graceful degradation
3. **Performance**: Add caching, optimization, and monitoring
4. **Tool Security**: Comprehensive permission system with safe defaults

### Integration Risks
1. **VS Code API Changes**: Follow proposed API evolution, maintain backwards compatibility
2. **Extension Conflicts**: Namespace isolation, careful resource management
3. **User Experience**: Extensive testing, gradual feature rollout

This specification provides a comprehensive roadmap for integrating OpenCode as a chat session provider in VS Code, leveraging the proven patterns from the Claude integration while adapting to OpenCode's unique server/client architecture.

## Implementation Notes

To fully implement this integration, the developer or coding agent will need to understand the specific details of the `opencode` server's API and configuration. This information is not fully available in this specification.

Therefore, it is recommended to clone the `opencode` repository from GitHub and analyze its source code:

**Repository:** `https://github.com/sst/opencode`

Key areas to investigate in the repository include:
- The structure of the `Config` object, which is passed to the server for configuration.
- The OpenAPI specification or the server's routing logic to understand the available API endpoints for sessions, tools, etc.
- The WebSocket implementation to understand the event names and data structures for real-time updates.
