# High-Level Design (HLD)
## GitHub Copilot Chat Extension for VS Code

---

## 1. Executive Summary

### 1.1 Purpose
GitHub Copilot Chat is a Visual Studio Code extension that provides conversational AI assistance for software development. It enables developers to interact with AI models through natural language, receiving help with code generation, explanation, debugging, refactoring, and autonomous task execution.

### 1.2 Key Business Value
- **Increased Developer Productivity**: Automates repetitive coding tasks and provides instant code suggestions
- **Knowledge Accessibility**: Provides context-aware explanations of code and documentation
- **Quality Improvement**: Offers code review, testing suggestions, and best practices
- **Reduced Context Switching**: Integrates AI assistance directly into the development environment

### 1.3 Target Users
- Software developers using Visual Studio Code
- Development teams seeking AI-assisted coding capabilities
- Organizations looking to improve developer efficiency

---

## 2. System Overview

### 2.1 High-Level Architecture Diagram

```mermaid
flowchart TB
    subgraph User_Interface["User Interface Layer"]
        ChatUI["Chat Panel Interface"]
        InlineChat["Inline Chat Ctrl_I"]
        InlineEdits["Inline Edit Suggestions"]
        AgentMode["Agent Mode Autonomous"]
    end

    subgraph Extension_Core["Extension Core Layer"]
        ConversationMgr["Conversation Manager"]
        PromptEngine["Prompt Engine TSX"]
        IntentRouter["Intent Router"]
        ToolsOrchestrator["Tools Orchestrator"]
        ContextResolver["Context Resolver"]
    end

    subgraph AI_Integration["AI Integration Layer"]
        EndpointProvider["Endpoint Provider"]
        ModelSelector["Model Selector"]
        ClaudeAgent["Claude Agent Integration"]
        MCPConnector["MCP Connector"]
    end

    subgraph External_Services["External Services"]
        GitHubCopilot["GitHub Copilot API"]
        OpenAI["OpenAI Models"]
        Anthropic["Anthropic Claude"]
        GitHubAPI["GitHub API"]
    end

    subgraph Platform_Services["Platform Services Layer"]
        AuthService["Authentication Service"]
        TelemetryService["Telemetry Service"]
        ConfigService["Configuration Service"]
        WorkspaceService["Workspace Service"]
        SearchService["Search Service"]
    end

    ChatUI --> ConversationMgr
    InlineChat --> ConversationMgr
    InlineEdits --> ContextResolver
    AgentMode --> ToolsOrchestrator

    ConversationMgr --> PromptEngine
    ConversationMgr --> IntentRouter
    IntentRouter --> ToolsOrchestrator
    ToolsOrchestrator --> ContextResolver

    PromptEngine --> EndpointProvider
    EndpointProvider --> ModelSelector
    ModelSelector --> ClaudeAgent
    ModelSelector --> MCPConnector

    ClaudeAgent --> Anthropic
    EndpointProvider --> GitHubCopilot
    EndpointProvider --> OpenAI
    MCPConnector --> GitHubAPI

    ConversationMgr --> AuthService
    ToolsOrchestrator --> WorkspaceService
    ContextResolver --> SearchService
    Extension_Core --> TelemetryService
    Extension_Core --> ConfigService
```

---

## 3. Core Capabilities

### 3.1 Chat Interface
**Functional Description**: The primary user interaction point where developers can have conversations with AI about their code.

| Feature | Description | User Benefit |
|---------|-------------|--------------|
| Natural Language Input | Type questions or requests in plain English | No learning curve for interaction |
| Code Context Awareness | Automatically includes relevant code in prompts | More accurate, contextual responses |
| Multi-turn Conversations | Maintains conversation history | Natural, iterative problem-solving |
| Participant System | Route requests to specialized agents | Expert responses for specific domains |

### 3.2 Inline Chat
**Functional Description**: AI assistance directly within the code editor without switching contexts.

| Feature | Description | User Benefit |
|---------|-------------|--------------|
| Quick Invocation | Trigger with Ctrl+I keyboard shortcut | Instant access without disruption |
| Selection-based Context | Works with selected code | Focused assistance on specific code |
| Inline Suggestions | Shows suggestions within editor | Seamless editing experience |
| Intent Detection | Automatically identifies user intent | Faster, more relevant responses |

### 3.3 Agent Mode
**Functional Description**: Autonomous AI agent that can perform multi-step tasks without constant user intervention.

| Feature | Description | User Benefit |
|---------|-------------|--------------|
| Multi-step Execution | Chains multiple actions together | Complex tasks completed automatically |
| Tool Calling | Uses tools to read, write, search, and execute | Full development capability |
| Self-correction | Analyzes errors and adjusts approach | Resilient task completion |
| Progress Tracking | Shows todo list and progress | Visibility into agent actions |

### 3.4 Language Model Integration
**Functional Description**: Connects to multiple AI model providers for flexibility and capability.

| Provider | Models Supported | Use Case |
|----------|------------------|----------|
| GitHub Copilot | GPT-4, GPT-4o, GPT-5 | General coding assistance |
| Anthropic | Claude 3, Claude 4 | Complex reasoning, agentic tasks |
| Google | Gemini Pro, Gemini Ultra | Alternative model options |
| BYOK | Custom API keys | Enterprise flexibility |

---

## 4. Technology Stack

### 4.1 Primary Technologies

| Category | Technology | Purpose |
|----------|------------|---------|
| Language | TypeScript | Primary development language |
| Runtime | Node.js | Extension host environment |
| UI Framework | TSX (prompt-tsx) | Prompt composition and rendering |
| Build System | ESBuild | Fast bundling and compilation |
| Testing | Vitest | Unit and integration testing |
| API Protocol | VS Code Extension API | Editor integration |

### 4.2 Key Dependencies

| Dependency | Purpose |
|------------|---------|
| @vscode/prompt-tsx | TSX-based prompt composition |
| @anthropic-ai/claude-agent-sdk | Claude agent integration |
| tree-sitter-wasm | Code parsing and analysis |
| VS Code Proposed APIs | Advanced chat and model features |

---

## 5. System Layers

### 5.1 Layer Architecture

```mermaid
flowchart TB
    subgraph Presentation["Presentation Layer"]
        direction LR
        UI1["Chat Views"]
        UI2["Inline Chat"]
        UI3["Status Items"]
        UI4["Quick Picks"]
    end

    subgraph Business["Business Logic Layer"]
        direction LR
        BL1["Intent Processing"]
        BL2["Prompt Building"]
        BL3["Tool Execution"]
        BL4["Context Resolution"]
    end

    subgraph Integration["Integration Layer"]
        direction LR
        INT1["AI Model APIs"]
        INT2["GitHub APIs"]
        INT3["VS Code APIs"]
        INT4["MCP Servers"]
    end

    subgraph Platform["Platform Services Layer"]
        direction LR
        PS1["Authentication"]
        PS2["Configuration"]
        PS3["Telemetry"]
        PS4["File System"]
    end

    subgraph Infrastructure["Infrastructure Layer"]
        direction LR
        INF1["Service Container"]
        INF2["Event System"]
        INF3["Logging"]
        INF4["Caching"]
    end

    Presentation --> Business
    Business --> Integration
    Business --> Platform
    Integration --> Platform
    Platform --> Infrastructure
```

### 5.2 Layer Responsibilities

| Layer | Responsibility | Key Components |
|-------|---------------|----------------|
| **Presentation** | User interaction, UI rendering | Chat panels, inline widgets, status bars |
| **Business Logic** | Core functionality, workflow orchestration | Intents, prompts, tool calling loop |
| **Integration** | External system communication | Model APIs, GitHub, MCP protocol |
| **Platform Services** | Cross-cutting concerns | Auth, config, telemetry, workspace |
| **Infrastructure** | Foundation services | DI container, events, logging |

---

## 6. Runtime Environments

### 6.1 Supported Environments

The extension supports multiple VS Code runtime environments:

| Environment | Description | Limitations |
|-------------|-------------|-------------|
| **Desktop (Node.js)** | Full-featured extension on desktop VS Code | None |
| **Web Worker** | Browser-based VS Code (vscode.dev) | No Node.js APIs, limited file access |
| **Remote** | VS Code with remote development | Network-dependent features |

### 6.2 Environment-Specific Code Organization

```mermaid
flowchart TB
    subgraph Common_Layer["common Layer"]
        Common["JavaScript Only No Runtime APIs"]
    end

    subgraph Node_Layer["node Layer"]
        Node["Node_js APIs file system processes"]
    end

    subgraph VSCode_Layer["vscode Layer"]
        VSCode["VS Code Extension APIs"]
    end

    subgraph Combined_Layers["Combined Layers"]
        VSCodeNode["vscode_node Desktop Full Featured"]
        VSCodeWorker["vscode_worker Web Limited Features"]
    end

    Common --> Node
    Common --> VSCode
    Node --> VSCodeNode
    VSCode --> VSCodeNode
    VSCode --> VSCodeWorker
    Common --> VSCodeWorker
```

---

## 7. Key Workflows

### 7.1 Chat Request Processing

```mermaid
sequenceDiagram
    participant User
    participant ChatUI as Chat UI
    participant ChatParticipant as Chat Participant
    participant Intent as Intent Handler
    participant Prompt as Prompt Engine
    participant Model as AI Model
    participant Tools as Tool Executor

    User->>ChatUI: Types message
    ChatUI->>ChatParticipant: handleRequest
    ChatParticipant->>Intent: routeToIntent
    Intent->>Prompt: buildPrompt
    Prompt->>Model: sendRequest
    Model-->>Intent: responseStream

    alt Tool Call Required
        Intent->>Tools: invokeTool
        Tools-->>Intent: toolResult
        Intent->>Model: continueWithResult
    end

    Intent-->>ChatUI: finalResponse
    ChatUI-->>User: Display response
```

### 7.2 Agent Mode Execution

```mermaid
sequenceDiagram
    participant User
    participant Agent as Agent Mode
    participant ToolLoop as Tool Calling Loop
    participant Tools as Tools Service
    participant Workspace as Workspace

    User->>Agent: Start task
    Agent->>ToolLoop: initializeLoop

    loop Until Complete
        ToolLoop->>ToolLoop: buildPrompt
        ToolLoop->>ToolLoop: callModel

        alt Tool Call
            ToolLoop->>Tools: executeTool
            Tools->>Workspace: performAction
            Workspace-->>Tools: result
            Tools-->>ToolLoop: toolResult
        end

        alt Confirmation Required
            ToolLoop->>User: requestConfirmation
            User-->>ToolLoop: approve or deny
        end
    end

    ToolLoop-->>Agent: taskComplete
    Agent-->>User: finalResult
```

---

## 8. Security Considerations

### 8.1 Authentication Flow

| Step | Description | Security Measure |
|------|-------------|------------------|
| 1 | GitHub OAuth authentication | OAuth 2.0 with PKCE |
| 2 | Token storage | VS Code Secret Storage API |
| 3 | API requests | Bearer token in headers |
| 4 | Token refresh | Automatic refresh before expiry |

### 8.2 Data Handling

| Data Type | Handling | Retention |
|-----------|----------|-----------|
| Code Context | Sent to AI models | Not persisted |
| Conversation History | Local storage only | User-controlled |
| Telemetry | Anonymized metrics | Per Microsoft policy |
| Credentials | Encrypted storage | Session-based |

---

## 9. Performance Characteristics

### 9.1 Key Metrics

| Metric | Target | Description |
|--------|--------|-------------|
| Time to First Token | < 1 second | How quickly AI starts responding |
| Extension Activation | < 500ms | Time to load extension |
| Memory Usage | < 150MB | Typical memory footprint |
| Tool Execution | < 2 seconds | Average tool call duration |

### 9.2 Optimization Strategies

- **Lazy Loading**: Components loaded on demand
- **Caching**: Token and context caching
- **Streaming**: Response streaming for perceived speed
- **Background Processing**: Non-blocking operations

---

## 10. Extensibility Points

### 10.1 Extension Points

| Extension Point | Purpose | How to Use |
|-----------------|---------|------------|
| Chat Participants | Add custom chat agents | VS Code Chat API |
| Language Model Tools | Add new agent capabilities | VS Code LM Tool API |
| MCP Servers | External tool providers | Model Context Protocol |
| Custom Instructions | User-defined AI behavior | Settings and files |

### 10.2 Integration Capabilities

```mermaid
flowchart LR
    subgraph Extension["Copilot Chat Extension"]
        Core["Core Extension"]
    end

    subgraph ExtPoints["Extension Points"]
        Participants["Chat Participants"]
        Tools["LM Tools"]
        MCP["MCP Servers"]
        Instructions["Custom Instructions"]
    end

    subgraph External["External Extensions"]
        Ext1["GitHub PR Extension"]
        Ext2["Custom MCP Server"]
        Ext3["Third Party Tools"]
    end

    Core --> Participants
    Core --> Tools
    Core --> MCP
    Core --> Instructions

    Ext1 --> Participants
    Ext2 --> MCP
    Ext3 --> Tools
```

---

## 11. Deployment and Distribution

### 11.1 Distribution Channels

| Channel | Audience | Update Frequency |
|---------|----------|-----------------|
| VS Code Marketplace | General users | Stable releases |
| Pre-release Channel | Early adopters | Weekly updates |
| Insider Builds | Internal testing | Daily builds |

### 11.2 Version Compatibility

| VS Code Version | Copilot Chat Version | Notes |
|-----------------|---------------------|-------|
| 1.109+ | Latest | Full feature support |
| 1.100-1.108 | Limited | Reduced API support |
| < 1.100 | Not supported | Minimum version required |

---

## 12. Glossary

| Term | Definition |
|------|------------|
| **Agent Mode** | Autonomous AI that executes multi-step tasks using tools |
| **Chat Participant** | A specialized handler for chat requests (e.g., @workspace) |
| **Intent** | The detected purpose of a user's chat message |
| **MCP** | Model Context Protocol - standard for AI tool communication |
| **Prompt-TSX** | TSX-based framework for composing AI prompts |
| **Tool** | A capability the AI can invoke (e.g., read file, run terminal) |
| **BYOK** | Bring Your Own Key - using custom API credentials |

---

*Next Document: [02-LOW-LEVEL-DESIGN.md](./02-LOW-LEVEL-DESIGN.md)*
