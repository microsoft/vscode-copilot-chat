# C4 Architecture Diagrams
## GitHub Copilot Chat Extension for VS Code

This document contains C4 model architecture diagrams at all four levels: Context, Container, Component, and Code.

---

## 1. Level 1: System Context Diagram

The System Context diagram shows GitHub Copilot Chat in relation to its users and external systems.

```mermaid
flowchart TB
    subgraph Users["Users"]
        Developer["Developer<br/>Uses VS Code for coding"]
    end

    subgraph CopilotChat["GitHub Copilot Chat Extension"]
        Extension["Copilot Chat<br/>VS Code Extension<br/>Provides AI assisted coding"]
    end

    subgraph ExternalSystems["External Systems"]
        VSCode["Visual Studio Code<br/>IDE Platform<br/>Provides extension hosting"]
        GitHubCopilot["GitHub Copilot Service<br/>AI Backend<br/>Provides AI model access"]
        GitHub["GitHub Platform<br/>Code Hosting<br/>Provides authentication and repos"]
        Anthropic["Anthropic API<br/>AI Provider<br/>Provides Claude models"]
        MCPServers["MCP Servers<br/>Tool Providers<br/>Provides external tools"]
    end

    Developer -->|"Uses chat and inline features"| Extension
    Extension -->|"Runs within"| VSCode
    Extension -->|"Sends prompts receives completions"| GitHubCopilot
    Extension -->|"Authenticates fetches repo data"| GitHub
    Extension -->|"Uses Claude Agent SDK"| Anthropic
    Extension -->|"Invokes external tools"| MCPServers
```

### Context Diagram Description

| Element | Type | Description |
|---------|------|-------------|
| Developer | User | Primary user who interacts with the chat interface |
| Copilot Chat | System | The VS Code extension providing AI assistance |
| VS Code | External System | The IDE that hosts the extension |
| GitHub Copilot Service | External System | Backend AI service for model inference |
| GitHub Platform | External System | Authentication and repository access |
| Anthropic API | External System | Alternative AI provider for Claude models |
| MCP Servers | External System | Model Context Protocol servers for tools |

---

## 2. Level 2: Container Diagram

The Container diagram shows the high-level components within the Copilot Chat extension.

```mermaid
flowchart TB
    subgraph VSCodeApp["VS Code Application"]
        subgraph CopilotExtension["GitHub Copilot Chat Extension"]
            ChatUI["Chat UI Container<br/>TypeScript React<br/>Handles user interaction"]
            ExtCore["Extension Core<br/>TypeScript<br/>Business logic and orchestration"]
            PlatformSvc["Platform Services<br/>TypeScript<br/>Cross cutting concerns"]
            AgentRuntime["Agent Runtime<br/>TypeScript<br/>Autonomous task execution"]
        end

        subgraph VSCodeAPI["VS Code APIs"]
            ChatAPI["Chat API<br/>Chat participants and responses"]
            LMAPI["Language Model API<br/>Model invocation and tools"]
            EditorAPI["Editor API<br/>Document and workspace access"]
        end
    end

    subgraph External["External Services"]
        CopilotBackend["Copilot Backend<br/>REST and Streaming<br/>AI model inference"]
        ClaudeSDK["Claude Agent SDK<br/>SDK<br/>Agentic capabilities"]
        MCPProtocol["MCP Protocol<br/>JSON RPC<br/>Tool invocation"]
    end

    ChatUI -->|"Sends requests"| ExtCore
    ExtCore -->|"Uses services"| PlatformSvc
    ExtCore -->|"Delegates autonomous tasks"| AgentRuntime
    ExtCore -->|"Uses"| ChatAPI
    ExtCore -->|"Uses"| LMAPI
    ExtCore -->|"Uses"| EditorAPI
    AgentRuntime -->|"Calls"| ClaudeSDK
    PlatformSvc -->|"Sends API requests"| CopilotBackend
    AgentRuntime -->|"Connects to"| MCPProtocol
```

### Container Descriptions

| Container | Technology | Purpose |
|-----------|------------|---------|
| Chat UI Container | TypeScript/TSX | Renders chat interface, handles user input |
| Extension Core | TypeScript | Core business logic, intent routing, prompt building |
| Platform Services | TypeScript | Authentication, telemetry, configuration, search |
| Agent Runtime | TypeScript | Tool calling loop, autonomous task execution |
| Copilot Backend | REST/Streaming | AI model inference and response streaming |
| Claude Agent SDK | SDK | Anthropic's agentic coding assistant |
| MCP Protocol | JSON-RPC | External tool provider communication |

---

## 3. Level 3: Component Diagram

### 3.1 Extension Core Components

```mermaid
flowchart TB
    subgraph ExtensionCore["Extension Core Container"]
        subgraph Conversation["Conversation Management"]
            ChatParticipants["Chat Participants<br/>Routes to handlers"]
            ConversationStore["Conversation Store<br/>Persists history"]
            SessionContext["Session Context<br/>Manages state"]
        end

        subgraph IntentProcessing["Intent Processing"]
            IntentService["Intent Service<br/>Resolves user intent"]
            IntentHandlers["Intent Handlers<br/>Execute specific intents"]
            ToolCallingLoop["Tool Calling Loop<br/>Agentic execution"]
        end

        subgraph PromptEngineering["Prompt Engineering"]
            PromptRenderer["Prompt Renderer<br/>Renders TSX prompts"]
            PromptRegistry["Prompt Registry<br/>Model specific prompts"]
            ContextResolver["Context Resolver<br/>Gathers code context"]
        end

        subgraph ToolsManagement["Tools Management"]
            ToolsService["Tools Service<br/>Tool invocation"]
            ToolRegistry["Tool Registry<br/>Tool registration"]
            ToolConfirmation["Tool Confirmation<br/>User approval"]
        end
    end

    ChatParticipants -->|"Stores turns"| ConversationStore
    ChatParticipants -->|"Resolves intent"| IntentService
    IntentService -->|"Creates"| IntentHandlers
    IntentHandlers -->|"Builds prompts"| PromptRenderer
    IntentHandlers -->|"Runs loop"| ToolCallingLoop
    PromptRenderer -->|"Gets prompts"| PromptRegistry
    PromptRenderer -->|"Gets context"| ContextResolver
    ToolCallingLoop -->|"Invokes"| ToolsService
    ToolsService -->|"Looks up"| ToolRegistry
    ToolsService -->|"Requests approval"| ToolConfirmation
```

### 3.2 Platform Services Components

```mermaid
flowchart TB
    subgraph PlatformServices["Platform Services Container"]
        subgraph Authentication["Authentication"]
            AuthService["Auth Service<br/>GitHub OAuth"]
            TokenManager["Token Manager<br/>Token refresh"]
        end

        subgraph AIEndpoints["AI Endpoints"]
            EndpointProvider["Endpoint Provider<br/>Model selection"]
            ChatFetcher["Chat Fetcher<br/>API requests"]
            StreamProcessor["Stream Processor<br/>Response streaming"]
        end

        subgraph WorkspaceOps["Workspace Operations"]
            WorkspaceService["Workspace Service<br/>File operations"]
            SearchService["Search Service<br/>Code search"]
            GitService["Git Service<br/>Version control"]
        end

        subgraph Monitoring["Monitoring"]
            TelemetryService["Telemetry Service<br/>Usage analytics"]
            LogService["Log Service<br/>Debug logging"]
            ErrorReporter["Error Reporter<br/>Error tracking"]
        end
    end

    AuthService -->|"Provides tokens"| TokenManager
    TokenManager -->|"Authenticates"| ChatFetcher
    EndpointProvider -->|"Selects model"| ChatFetcher
    ChatFetcher -->|"Streams"| StreamProcessor
    WorkspaceService -->|"Indexes"| SearchService
    WorkspaceService -->|"Tracks changes"| GitService
    ChatFetcher -->|"Reports"| TelemetryService
    TelemetryService -->|"Logs"| LogService
```

### 3.3 Agent Runtime Components

```mermaid
flowchart TB
    subgraph AgentRuntime["Agent Runtime Container"]
        subgraph CoreAgent["Core Agent"]
            AgentManager["Agent Manager<br/>Request routing"]
            AgentSession["Agent Session<br/>Session state"]
            MessageProcessor["Message Processor<br/>Response handling"]
        end

        subgraph ClaudeIntegration["Claude Integration"]
            ClaudeSdkService["Claude SDK Service<br/>SDK wrapper"]
            ClaudeHooks["Hook Registry<br/>Lifecycle hooks"]
            SessionService["Session Service<br/>Session persistence"]
        end

        subgraph ToolExecution["Tool Execution"]
            PermissionHandlers["Permission Handlers<br/>Approval logic"]
            ToolFormatters["Tool Formatters<br/>UI formatting"]
            EditTracking["Edit Tracking<br/>File change tracking"]
        end

        subgraph ExtensionPoints["Extension Points"]
            SlashCommands["Slash Commands<br/>User commands"]
            MCPConnector["MCP Connector<br/>External tools"]
        end
    end

    AgentManager -->|"Creates"| AgentSession
    AgentSession -->|"Uses"| ClaudeSdkService
    ClaudeSdkService -->|"Triggers"| ClaudeHooks
    AgentSession -->|"Persists"| SessionService
    AgentSession -->|"Processes"| MessageProcessor
    MessageProcessor -->|"Checks"| PermissionHandlers
    MessageProcessor -->|"Formats"| ToolFormatters
    PermissionHandlers -->|"Tracks"| EditTracking
    AgentManager -->|"Handles"| SlashCommands
    AgentManager -->|"Connects"| MCPConnector
```

---

## 4. Level 4: Code Diagrams

### 4.1 Chat Request Processing

```mermaid
classDiagram
    class ChatRequest {
        +prompt: string
        +command: string
        +references: ChatReference[]
        +toolReferences: ToolReference[]
        +attempt: number
        +location: ChatLocation
    }

    class ChatParticipantHandler {
        -intentService: IIntentService
        -conversationStore: IConversationStore
        +handleRequest(request: ChatRequest, context: ChatContext, stream: ChatResponseStream, token: CancellationToken): Promise~ChatResult~
    }

    class IIntentService {
        <<interface>>
        +resolveIntent(request: ChatRequest): IIntent
        +getIntentHandler(intent: IIntent): IIntentInvocation
    }

    class IIntentInvocation {
        <<interface>>
        +buildPrompt(context: IBuildPromptContext, token: CancellationToken): Promise~IBuildPromptResult~
    }

    class ChatResponseStream {
        +markdown(value: string): void
        +anchor(uri: URI, title: string): void
        +button(command: Command): void
        +progress(value: string): void
        +reference(reference: URI): void
    }

    ChatParticipantHandler --> ChatRequest : receives
    ChatParticipantHandler --> IIntentService : uses
    IIntentService --> IIntentInvocation : creates
    ChatParticipantHandler --> ChatResponseStream : writes to
```

### 4.2 Prompt Rendering

```mermaid
classDiagram
    class PromptRenderer {
        -accessor: ServicesAccessor
        -endpoint: IChatEndpoint
        -elementClass: PromptElementClass
        -props: PromptProps
        +render(progress: Progress, token: CancellationToken): Promise~RenderPromptResult~
    }

    class PromptElement~Props~ {
        <<abstract>>
        #props: Props
        +render(state: State, sizing: PromptSizing): PromptPiece
        +prepare(): Promise~State~
    }

    class SystemMessage {
        +priority: number
        +render(): PromptPiece
    }

    class UserMessage {
        +priority: number
        +render(): PromptPiece
    }

    class AssistantMessage {
        +priority: number
        +render(): PromptPiece
    }

    class RenderPromptResult {
        +messages: ChatMessage[]
        +tokenCount: number
        +references: ChatReference[]
    }

    PromptRenderer --> PromptElement : renders
    PromptElement <|-- SystemMessage
    PromptElement <|-- UserMessage
    PromptElement <|-- AssistantMessage
    PromptRenderer --> RenderPromptResult : produces
```

### 4.3 Tool Calling Loop

```mermaid
classDiagram
    class ToolCallingLoop {
        -options: IToolCallingLoopOptions
        -endpointProvider: IEndpointProvider
        -toolsService: IToolsService
        +run(stream: ChatResponseStream, token: CancellationToken): Promise~ChatResult~
        #buildPrompt(context: IBuildPromptContext): Promise~IBuildPromptResult~
        #invokeTools(toolCalls: ToolCall[]): Promise~ToolResult[]~
    }

    class IToolCallingLoopOptions {
        +conversation: Conversation
        +toolCallLimit: number
        +onHitToolCallLimit: ToolCallLimitBehavior
        +streamParticipants: ResponseStreamParticipant[]
        +request: ChatRequest
    }

    class IToolsService {
        <<interface>>
        +getTool(name: string): LanguageModelTool
        +invokeTool(name: string, input: unknown, token: CancellationToken): Promise~ToolResult~
    }

    class ToolCall {
        +id: string
        +name: string
        +input: unknown
    }

    class ToolResult {
        +content: ToolResultContent[]
        +metadata: ToolResultMetadata
    }

    ToolCallingLoop --> IToolCallingLoopOptions : configured by
    ToolCallingLoop --> IToolsService : uses
    IToolsService --> ToolCall : processes
    IToolsService --> ToolResult : returns
```

### 4.4 Claude Agent Session

```mermaid
classDiagram
    class ClaudeAgentManager {
        -sessions: Map~string_ClaudeCodeSession~
        -languageModelServer: LanguageModelServer
        -instantiationService: IInstantiationService
        +handleRequest(request: ChatRequest, stream: ChatResponseStream, token: CancellationToken): Promise~ChatResult~
        +getOrCreateSession(sessionId: string): ClaudeCodeSession
    }

    class ClaudeCodeSession {
        -sdk: ClaudeCodeSdkService
        -hookRegistry: ClaudeHookRegistry
        -requestQueue: AsyncQueue~QueuedRequest~
        +processRequest(prompt: string, token: CancellationToken): AsyncIterable~Message~
        -processAssistantMessage(message: AssistantMessage): void
        -processToolUse(toolUse: ToolUse): Promise~boolean~
    }

    class ClaudeCodeSdkService {
        -sdk: ClaudeAgentSDK
        +createSession(options: SessionOptions): Session
        +streamConversation(prompt: string): AsyncIterable~Message~
    }

    class ClaudeHookRegistry {
        -hooks: Map~HookEvent_HookHandler[]~
        +registerHook(event: HookEvent, handler: HookHandler): void
        +invokeHooks(event: HookEvent, data: HookData): Promise~void~
    }

    ClaudeAgentManager --> ClaudeCodeSession : manages
    ClaudeCodeSession --> ClaudeCodeSdkService : uses
    ClaudeCodeSession --> ClaudeHookRegistry : triggers
```

---

## 5. Data Flow Diagrams

### 5.1 Complete Request Flow

```mermaid
flowchart TB
    subgraph UserInput["User Input"]
        ChatInput["Chat Message"]
        InlineInput["Inline Ctrl I"]
        AgentInput["Agent Task"]
    end

    subgraph RequestProcessing["Request Processing"]
        ParseRequest["Parse Request"]
        ResolveContext["Resolve Context"]
        DetectIntent["Detect Intent"]
    end

    subgraph PromptBuilding["Prompt Building"]
        SelectPrompt["Select Prompt Template"]
        RenderPrompt["Render TSX Prompt"]
        FitBudget["Fit Token Budget"]
    end

    subgraph ModelInteraction["Model Interaction"]
        SelectModel["Select Model"]
        SendRequest["Send to API"]
        StreamResponse["Stream Response"]
    end

    subgraph ToolProcessing["Tool Processing"]
        ParseTools["Parse Tool Calls"]
        ConfirmTools["Confirm Tools"]
        ExecuteTools["Execute Tools"]
        FormatResults["Format Results"]
    end

    subgraph ResponseDelivery["Response Delivery"]
        RenderResponse["Render to UI"]
        ApplyEdits["Apply Code Edits"]
        UpdateHistory["Update History"]
    end

    ChatInput --> ParseRequest
    InlineInput --> ParseRequest
    AgentInput --> ParseRequest

    ParseRequest --> ResolveContext
    ResolveContext --> DetectIntent
    DetectIntent --> SelectPrompt

    SelectPrompt --> RenderPrompt
    RenderPrompt --> FitBudget
    FitBudget --> SelectModel

    SelectModel --> SendRequest
    SendRequest --> StreamResponse
    StreamResponse --> ParseTools

    ParseTools -->|Has Tools| ConfirmTools
    ConfirmTools -->|Approved| ExecuteTools
    ExecuteTools --> FormatResults
    FormatResults --> RenderPrompt

    ParseTools -->|No Tools| RenderResponse
    StreamResponse --> RenderResponse
    RenderResponse --> ApplyEdits
    ApplyEdits --> UpdateHistory
```

### 5.2 Authentication Flow

```mermaid
flowchart TB
    subgraph InitialAuth["Initial Authentication"]
        CheckSession["Check Existing Session"]
        RedirectOAuth["Redirect to GitHub OAuth"]
        HandleCallback["Handle OAuth Callback"]
        StoreTokens["Store Tokens Securely"]
    end

    subgraph TokenRefresh["Token Refresh"]
        CheckExpiry["Check Token Expiry"]
        RefreshToken["Refresh Access Token"]
        UpdateStorage["Update Stored Tokens"]
    end

    subgraph APIUsage["API Usage"]
        GetToken["Get Current Token"]
        AttachHeader["Attach Auth Header"]
        SendRequest["Send API Request"]
        HandleError["Handle Auth Errors"]
    end

    CheckSession -->|No Session| RedirectOAuth
    RedirectOAuth --> HandleCallback
    HandleCallback --> StoreTokens
    CheckSession -->|Has Session| CheckExpiry

    CheckExpiry -->|Expired| RefreshToken
    RefreshToken --> UpdateStorage
    CheckExpiry -->|Valid| GetToken

    GetToken --> AttachHeader
    AttachHeader --> SendRequest
    SendRequest -->|401 Error| HandleError
    HandleError --> RefreshToken
```

---

## 6. Deployment Architecture

### 6.1 Extension Packaging

```mermaid
flowchart TB
    subgraph SourceCode["Source Code"]
        TSFiles["TypeScript Files"]
        TSXFiles["TSX Prompt Files"]
        Assets["Static Assets"]
    end

    subgraph BuildProcess["Build Process"]
        TSCompile["TypeScript Compile"]
        ESBuild["ESBuild Bundle"]
        CopyAssets["Copy Assets"]
    end

    subgraph OutputArtifacts["Output Artifacts"]
        DistExtension["dist/extension.js Desktop"]
        DistWeb["dist/web.js Web Worker"]
        PackageJSON["package.json Manifest"]
        L10N["l10n/ Localizations"]
    end

    subgraph Distribution["Distribution"]
        VSIX["VSIX Package"]
        Marketplace["VS Code Marketplace"]
    end

    TSFiles --> TSCompile
    TSXFiles --> TSCompile
    TSCompile --> ESBuild
    Assets --> CopyAssets
    ESBuild --> DistExtension
    ESBuild --> DistWeb
    CopyAssets --> L10N
    DistExtension --> VSIX
    DistWeb --> VSIX
    PackageJSON --> VSIX
    L10N --> VSIX
    VSIX --> Marketplace
```

### 6.2 Runtime Environment

```mermaid
flowchart TB
    subgraph Desktop["Desktop VS Code"]
        NodeHost["Node_js Extension Host"]
        DesktopExt["Desktop Extension vscode_node"]
        LocalFS["Local File System"]
        Terminal["Integrated Terminal"]
    end

    subgraph WebBrowser["Web Browser"]
        WorkerHost["Web Worker Extension Host"]
        WebExt["Web Extension vscode_worker"]
        VirtualFS["Virtual File System"]
    end

    subgraph Remote["Remote Development"]
        RemoteHost["Remote Extension Host"]
        SSHConnection["SSH Connection"]
        RemoteFS["Remote File System"]
    end

    NodeHost --> DesktopExt
    DesktopExt --> LocalFS
    DesktopExt --> Terminal

    WorkerHost --> WebExt
    WebExt --> VirtualFS

    RemoteHost --> SSHConnection
    SSHConnection --> RemoteFS
```

---

## 7. Integration Architecture

### 7.1 External System Integrations

```mermaid
flowchart TB
    subgraph CopilotChat["Copilot Chat Extension"]
        Core["Extension Core"]
    end

    subgraph GitHubIntegration["GitHub Integration"]
        GitHubAuth["GitHub OAuth 2.0"]
        CopilotAPI["Copilot API REST and WebSocket"]
        RepoAPI["Repository API REST"]
        PRAPI["Pull Request API REST"]
    end

    subgraph AnthropicIntegration["Anthropic Integration"]
        ClaudeAPI["Claude API REST"]
        AgentSDK["Agent SDK Library"]
    end

    subgraph MCPIntegration["MCP Integration"]
        MCPServer1["File System MCP"]
        MCPServer2["Database MCP"]
        MCPServerN["Custom MCP Servers"]
    end

    subgraph VSCodeIntegration["VS Code Integration"]
        ExtensionAPI["Extension API"]
        ChatAPI["Chat API Proposed"]
        LMAPI["Language Model API Proposed"]
        WorkspaceAPI["Workspace API"]
    end

    Core <-->|"OAuth HTTPS"| GitHubAuth
    Core <-->|"REST WebSocket"| CopilotAPI
    Core <-->|"REST"| RepoAPI
    Core <-->|"REST"| PRAPI

    Core <-->|"REST Streaming"| ClaudeAPI
    Core <-->|"Library"| AgentSDK

    Core <-->|"JSON RPC"| MCPServer1
    Core <-->|"JSON RPC"| MCPServer2
    Core <-->|"JSON RPC"| MCPServerN

    Core <-->|"API"| ExtensionAPI
    Core <-->|"API"| ChatAPI
    Core <-->|"API"| LMAPI
    Core <-->|"API"| WorkspaceAPI
```

---

## 8. Scaling Considerations

### 8.1 Request Processing Scalability

```mermaid
flowchart TB
    subgraph LoadManagement["Load Management"]
        RequestQueue["Request Queue"]
        RateLimiter["Rate Limiter"]
        CircuitBreaker["Circuit Breaker"]
    end

    subgraph Processing["Processing"]
        Worker1["Request Worker 1"]
        Worker2["Request Worker 2"]
        WorkerN["Request Worker N"]
    end

    subgraph Caching["Caching Layer"]
        TokenCache["Token Cache"]
        EmbeddingCache["Embedding Cache"]
        ResultCache["Result Cache"]
    end

    RequestQueue --> RateLimiter
    RateLimiter --> CircuitBreaker
    CircuitBreaker --> Worker1
    CircuitBreaker --> Worker2
    CircuitBreaker --> WorkerN

    Worker1 --> TokenCache
    Worker2 --> EmbeddingCache
    WorkerN --> ResultCache
```

---

*Next Document: [04-ARCHITECTURE-DECISION-RECORDS.md](./04-ARCHITECTURE-DECISION-RECORDS.md)*
