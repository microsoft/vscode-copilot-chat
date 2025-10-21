# Architecture Diagrams

This document contains architectural diagrams showing the dependency structure and cross-usage patterns of the GitHub Copilot Chat extension codebase.

## Table of Contents

- [Layer Dependency Architecture](#layer-dependency-architecture)
- [Feature Module Dependencies](#feature-module-dependencies)
- [Chat System Architecture](#chat-system-architecture)
- [Code Intelligence Pipeline](#code-intelligence-pipeline)
- [Authentication and API Flow](#authentication-and-api-flow)
- [Inline Editing System](#inline-editing-system)

---

## Layer Dependency Architecture

This diagram shows the high-level layering of the codebase and how different layers depend on each other.

```mermaid
flowchart TB
    subgraph Extension["Extension Layer (src/extension/)"]
        direction TB
        ExtChat["Chat UI & Sessions"]
        ExtCompletion["Completions & Inline Edits"]
        ExtTools["Tools & MCP"]
        ExtContext["Context Providers"]
        ExtCommands["Commands & Intents"]
    end

    subgraph Platform["Platform Layer (src/platform/)"]
        direction TB
        PlatAuth["Authentication"]
        PlatChat["Chat Services"]
        PlatSearch["Search & Indexing"]
        PlatGit["Git & GitHub"]
        PlatLang["Language Services"]
        PlatNet["Networking"]
    end

    subgraph Util["Utility Layer (src/util/)"]
        direction TB
        UtilCommon["Common Utilities"]
        UtilNode["Node.js Utilities"]
        UtilVS["VS Code Utilities"]
    end

    subgraph External["External Dependencies"]
        direction TB
        VSCode["VS Code API"]
        OpenAI["OpenAI/LLM APIs"]
        GitHub["GitHub APIs"]
        TreeSitter["Tree-sitter"]
    end

    Extension --> Platform
    Platform --> Util

    Extension --> VSCode
    Platform --> OpenAI
    Platform --> GitHub
    Platform --> TreeSitter

    ExtChat -.-> PlatChat
    ExtCompletion -.-> PlatChat
    ExtTools -.-> PlatNet
    ExtContext -.-> PlatSearch
    ExtContext -.-> PlatLang
    ExtCommands -.-> PlatChat

    PlatAuth -.-> PlatNet
    PlatSearch -.-> PlatGit
    PlatLang -.-> UtilCommon

    style Extension fill:#e1f5ff
    style Platform fill:#fff4e6
    style Util fill:#f3e5f5
    style External fill:#e8f5e9
```

---

## Feature Module Dependencies

This diagram shows how major feature modules depend on each other and platform services.

```mermaid
flowchart LR
    subgraph Features["Feature Modules"]
        direction TB
        Chat["Chat\n(chat/)"]
        InlineChat["Inline Chat\n(inlineChat/)"]
        Completion["Completions\n(completions/)"]
        InlineEdits["Inline Edits/NES\n(inlineEdits/)"]
        Tools["Tools\n(tools/)"]
        Context["Context\n(context/)"]
        Intents["Intents\n(intents/)"]
        Search["Search\n(search/)"]
    end

    subgraph PlatformServices["Platform Services"]
        direction TB
        ChatService["Chat Service\n(platform/chat)"]
        AuthService["Auth Service\n(platform/authentication)"]
        SearchService["Search Service\n(platform/search)"]
        GitService["Git Service\n(platform/git)"]
        LangService["Language Service\n(platform/languages)"]
        NetworkService["Network Service\n(platform/networking)"]
        EmbedService["Embeddings\n(platform/embeddings)"]
    end

    Chat --> ChatService
    Chat --> Context
    Chat --> Intents
    Chat --> Tools

    InlineChat --> Chat
    InlineChat --> Context
    InlineChat --> ChatService

    Completion --> ChatService
    Completion --> Context

    InlineEdits --> ChatService
    InlineEdits --> Context
    InlineEdits --> GitService

    Tools --> NetworkService
    Tools --> ChatService

    Context --> SearchService
    Context --> LangService
    Context --> GitService

    Intents --> ChatService

    Search --> SearchService
    Search --> EmbedService

    ChatService --> AuthService
    ChatService --> NetworkService
    SearchService --> EmbedService
    GitService --> SearchService

    style Features fill:#e3f2fd
    style PlatformServices fill:#fff3e0
```

---

## Chat System Architecture

This diagram shows the architecture of the chat system and how messages flow through the system.

```mermaid
flowchart TB
    User["User Input"]

    subgraph UI["UI Layer (extension/)"]
        ChatView["Chat View\n(chat/)"]
        InlineChatWidget["Inline Chat Widget\n(inlineChat/)"]
        SessionManager["Session Manager\n(chatSessions/)"]
    end

    subgraph Processing["Processing Layer"]
        IntentDetector["Intent Detector\n(intents/)"]
        ContextGatherer["Context Gatherer\n(context/)"]
        PromptBuilder["Prompt Builder\n(prompt/)"]
        ToolExecutor["Tool Executor\n(tools/)"]
    end

    subgraph Services["Platform Services"]
        ChatService["Chat Service\n(platform/chat)"]
        AuthService["Auth Service\n(platform/authentication)"]
        NetworkService["Network Service\n(platform/networking)"]
    end

    subgraph External["External APIs"]
        LLMEndpoint["LLM API\n(OpenAI/Claude)"]
    end

    subgraph Storage["Storage"]
        ConversationStore["Conversation Store\n(conversationStore/)"]
    end

    User --> ChatView
    User --> InlineChatWidget

    ChatView --> SessionManager
    InlineChatWidget --> SessionManager

    SessionManager --> IntentDetector
    IntentDetector --> ContextGatherer
    ContextGatherer --> PromptBuilder
    PromptBuilder --> ToolExecutor

    ToolExecutor --> ChatService
    ChatService --> AuthService
    ChatService --> NetworkService
    NetworkService --> LLMEndpoint

    SessionManager --> ConversationStore

    LLMEndpoint -.response.-> ChatService
    ChatService -.response.-> ToolExecutor
    ToolExecutor -.response.-> SessionManager
    SessionManager -.response.-> ChatView
    SessionManager -.response.-> InlineChatWidget

    style UI fill:#e1f5ff
    style Processing fill:#fff4e6
    style Services fill:#f3e5f5
    style External fill:#e8f5e9
    style Storage fill:#fce4ec
```

---

## Code Intelligence Pipeline

This diagram shows how code intelligence features gather and process information.

```mermaid
flowchart TB
    subgraph Sources["Information Sources"]
        ActiveEditor["Active Editor\n(VS Code)"]
        OpenFiles["Open Files"]
        WorkspaceFiles["Workspace Files"]
        GitHistory["Git History"]
        TSServer["TypeScript Server"]
        LSP["Language Servers"]
    end

    subgraph Extraction["Context Extraction"]
        EditorContext["Editor Context\n(context/)"]
        FileContext["File Context\n(promptFileContext/)"]
        TSContext["TypeScript Context\n(typescriptContext/)"]
        LangContext["Language Context\n(languageContextProvider/)"]
        GitContext["Git Context\n(git/)"]
    end

    subgraph Processing["Processing & Analysis"]
        Parser["Code Parser\n(platform/parser)"]
        Chunker["Chunker\n(platform/chunking)"]
        Embeddings["Embeddings\n(platform/embeddings)"]
        TFIDF["TF-IDF\n(platform/tfidf)"]
        RelatedFiles["Related Files\n(relatedFiles/)"]
    end

    subgraph Search["Search & Retrieval"]
        ChunkSearch["Chunk Search\n(workspaceChunkSearch/)"]
        SemanticSearch["Semantic Search\n(workspaceSemanticSearch/)"]
        CodeSearch["Code Search\n(platform/search)"]
        RemoteSearch["Remote Search\n(platform/remoteSearch)"]
    end

    subgraph Output["Context Output"]
        PromptContext["Prompt Context"]
        CompletionContext["Completion Context"]
        ChatContext["Chat Context"]
    end

    ActiveEditor --> EditorContext
    OpenFiles --> FileContext
    WorkspaceFiles --> FileContext
    GitHistory --> GitContext
    TSServer --> TSContext
    LSP --> LangContext

    EditorContext --> Parser
    FileContext --> Parser
    TSContext --> Parser
    LangContext --> Parser
    GitContext --> RelatedFiles

    Parser --> Chunker
    Chunker --> Embeddings
    Chunker --> TFIDF

    Embeddings --> SemanticSearch
    TFIDF --> ChunkSearch
    Parser --> CodeSearch

    ChunkSearch --> PromptContext
    SemanticSearch --> PromptContext
    CodeSearch --> PromptContext
    RemoteSearch --> PromptContext
    RelatedFiles --> PromptContext

    PromptContext --> CompletionContext
    PromptContext --> ChatContext

    style Sources fill:#e8f5e9
    style Extraction fill:#e1f5ff
    style Processing fill:#fff4e6
    style Search fill:#f3e5f5
    style Output fill:#fce4ec
```

---

## Authentication and API Flow

This diagram shows how authentication and API requests flow through the system.

```mermaid
flowchart TB
    subgraph Client["Client Layer"]
        Feature["Feature Request\n(chat/completions/tools)"]
    end

    subgraph Auth["Authentication Layer"]
        AuthService["Auth Service\n(platform/authentication)"]
        TokenManager["Token Manager\n(copilotTokenManager)"]
        TokenStore["Token Store\n(copilotTokenStore)"]
        BYOK["BYOK Service\n(byok/)"]
    end

    subgraph Network["Network Layer"]
        EndpointService["Endpoint Service\n(platform/endpoint)"]
        DomainService["Domain Service"]
        NetworkService["Network Service\n(platform/networking)"]
        CAPIClient["CAPI Client\n(capiClient)"]
        FetcherService["Fetcher Service"]
    end

    subgraph External["External Services"]
        GitHubAuth["GitHub OAuth"]
        CopilotAPI["Copilot API"]
        OpenAIAPI["OpenAI API"]
        CustomAPI["Custom API\n(BYOK)"]
    end

    subgraph Observability["Observability"]
        Telemetry["Telemetry\n(platform/telemetry)"]
        RequestLogger["Request Logger\n(platform/requestLogger)"]
        LogService["Log Service\n(platform/log)"]
    end

    Feature --> AuthService
    AuthService --> TokenManager
    TokenManager --> TokenStore
    AuthService --> BYOK

    AuthService --> GitHubAuth

    TokenManager -.token.-> EndpointService
    BYOK -.token.-> EndpointService

    EndpointService --> DomainService
    DomainService --> NetworkService
    NetworkService --> FetcherService
    FetcherService --> CAPIClient

    CAPIClient --> CopilotAPI
    CAPIClient --> OpenAIAPI
    CAPIClient --> CustomAPI

    NetworkService --> RequestLogger
    NetworkService --> Telemetry
    RequestLogger --> LogService
    Telemetry --> LogService

    CopilotAPI -.response.-> CAPIClient
    OpenAIAPI -.response.-> CAPIClient
    CustomAPI -.response.-> CAPIClient

    CAPIClient -.response.-> Feature

    style Client fill:#e1f5ff
    style Auth fill:#fff4e6
    style Network fill:#f3e5f5
    style External fill:#e8f5e9
    style Observability fill:#fce4ec
```

---

## Inline Editing System

This diagram shows the architecture of the inline editing and Next Edit Suggestions (NES) system.

```mermaid
flowchart TB
    subgraph Input["User Interaction"]
        TypeEvent["Typing Event"]
        SaveEvent["Save Event"]
        NavigateEvent["Navigation Event"]
    end

    subgraph Detection["Edit Detection"]
        EditTracker["Edit Tracker\n(workspaceEditTracker)"]
        HistoryTracker["History Tracker\n(nesXtabHistoryTracker)"]
        ObservableWorkspace["Observable Workspace\n(observableWorkspace)"]
        ObservableGit["Observable Git\n(observableGit)"]
    end

    subgraph Analysis["Context Analysis"]
        EditorState["Editor State"]
        FileState["File State"]
        GitState["Git State"]
        HistoryContext["History Context\n(nesHistoryContextProvider)"]
        XtabProvider["Xtab Provider\n(xtab/)"]
    end

    subgraph Generation["Edit Generation"]
        PromptGen["Prompt Generation\n(inlineCompletionPrompt/)"]
        NextEditProvider["Next Edit Provider\n(inlineEdits/nextEditProvider)"]
        ChatMLFetcher["ChatML Fetcher\n(prompt/chatMLFetcher)"]
    end

    subgraph LLM["LLM Services"]
        ChatService["Chat Service\n(platform/chat)"]
        NetworkService["Network Service\n(platform/networking)"]
        LLMEndpoint["LLM Endpoint"]
    end

    subgraph Application["Edit Application"]
        DiffService["Diff Service\n(platform/diff)"]
        EditService["Edit Service\n(platform/editing)"]
        InlineEditUI["Inline Edit UI\n(inlineEdits/)"]
    end

    subgraph Feedback["User Feedback Loop"]
        Accept["Accept Edit"]
        Reject["Reject Edit"]
        TelemetryBuilder["Telemetry Builder\n(nextEditProviderTelemetry)"]
    end

    TypeEvent --> EditTracker
    SaveEvent --> EditTracker
    NavigateEvent --> EditTracker

    EditTracker --> ObservableWorkspace
    EditTracker --> ObservableGit
    EditTracker --> HistoryTracker

    ObservableWorkspace --> EditorState
    ObservableWorkspace --> FileState
    ObservableGit --> GitState
    HistoryTracker --> HistoryContext
    HistoryTracker --> XtabProvider

    EditorState --> PromptGen
    FileState --> PromptGen
    GitState --> PromptGen
    HistoryContext --> PromptGen
    XtabProvider --> PromptGen

    PromptGen --> NextEditProvider
    NextEditProvider --> ChatMLFetcher
    ChatMLFetcher --> ChatService
    ChatService --> NetworkService
    NetworkService --> LLMEndpoint

    LLMEndpoint -.suggestion.-> NextEditProvider
    NextEditProvider --> DiffService
    DiffService --> EditService
    EditService --> InlineEditUI

    InlineEditUI --> Accept
    InlineEditUI --> Reject
    Accept --> TelemetryBuilder
    Reject --> TelemetryBuilder
    Accept -.feedback.-> HistoryTracker
    Reject -.feedback.-> HistoryTracker

    style Input fill:#e8f5e9
    style Detection fill:#e1f5ff
    style Analysis fill:#fff4e6
    style Generation fill:#f3e5f5
    style LLM fill:#fce4ec
    style Application fill:#f1f8e9
    style Feedback fill:#fff9c4
```

---

## Cross-Module Usage Patterns

This diagram shows common usage patterns across different modules.

```mermaid
flowchart TB
    subgraph Consumers["Feature Consumers"]
        Chat["Chat"]
        InlineChat["Inline Chat"]
        Completions["Completions"]
        InlineEdits["Inline Edits"]
        Tools["Tools"]
        Commands["Commands"]
    end

    subgraph SharedServices["Shared Platform Services"]
        Auth["Authentication"]
        Config["Configuration"]
        Log["Logging"]
        Telemetry["Telemetry"]
        Network["Networking"]
        FileSystem["File System"]
    end

    subgraph ContextProviders["Context Providers"]
        Editor["Editor Context"]
        Workspace["Workspace Context"]
        Git["Git Context"]
        Language["Language Context"]
        TypeScript["TypeScript Context"]
    end

    subgraph SearchIndexing["Search & Indexing"]
        ChunkSearch["Chunk Search"]
        SemanticSearch["Semantic Search"]
        Embeddings["Embeddings"]
        Parser["Parser"]
    end

    Chat --> Auth
    InlineChat --> Auth
    Completions --> Auth
    InlineEdits --> Auth
    Tools --> Auth
    Commands --> Auth

    Chat --> Network
    Completions --> Network
    InlineEdits --> Network
    Tools --> Network

    Chat --> Log
    InlineChat --> Log
    Completions --> Log
    InlineEdits --> Log

    Chat --> Telemetry
    Completions --> Telemetry
    InlineEdits --> Telemetry

    Chat --> Editor
    InlineChat --> Editor
    Completions --> Editor
    InlineEdits --> Editor

    Chat --> Workspace
    InlineChat --> Workspace
    Tools --> Workspace
    Commands --> Workspace

    Chat --> Language
    Completions --> Language
    InlineEdits --> Language

    InlineEdits --> Git
    Commands --> Git

    Completions --> TypeScript
    InlineEdits --> TypeScript

    Chat --> ChunkSearch
    Chat --> SemanticSearch

    ChunkSearch --> Embeddings
    SemanticSearch --> Embeddings
    ChunkSearch --> Parser
    SemanticSearch --> Parser

    style Consumers fill:#e1f5ff
    style SharedServices fill:#fff4e6
    style ContextProviders fill:#f3e5f5
    style SearchIndexing fill:#e8f5e9
```

---

## Notes

- **Solid arrows** (→) indicate direct dependencies
- **Dotted arrows** (-.→) indicate optional or conditional dependencies
- **Bidirectional arrows** indicate two-way communication
- Color coding groups related components by architectural layer

---

## Related Documentation

- [SOURCE-CODE-ORGANIZATION.md](./SOURCE-CODE-ORGANIZATION.md) - Detailed source code structure
- [TECHNICAL-OVERVIEW.md](./TECHNICAL-OVERVIEW.md) - High-level technical overview
- [AGENT-MODE.md](./AGENT-MODE.md) - Agent mode documentation
- [tools.md](./tools.md) - Tool system documentation
