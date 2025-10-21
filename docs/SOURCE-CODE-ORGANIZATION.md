# Source Code Organization

This document describes the organization and structure of the source code under the `src/` directory of the GitHub Copilot Chat extension.

> **Visual Guide**: See [ARCHITECTURE-DIAGRAMS.md](./ARCHITECTURE-DIAGRAMS.md) for visual dependency and cross-usage diagrams.

## Overview

The codebase is organized into three main top-level directories:

- **`extension/`** - Extension-specific implementations and features
- **`platform/`** - Platform-agnostic services and shared functionality
- **`util/`** - Common utility functions and helpers
- **`lib/`** - Library entry points for standalone usage

## Directory Structure

### `src/extension/`

Contains all VS Code extension-specific code and feature implementations. This layer depends on VS Code APIs and provides the user-facing functionality.

#### Core Extension Components

- **`extension/`** - Extension activation and lifecycle management
  - `vscode/` - VS Code-specific extension code
  - `vscode-node/` - Node.js runtime components for the extension
  - `vscode-worker/` - Web worker components

#### AI Agents & Models

- **`agents/`** - AI agent implementations
  - `claude/` - Claude AI integration
  - `copilotcli/` - Copilot CLI agent
  - `node/` - Node.js-based agents

#### Chat & Conversation Features

- **`chat/`** - Chat UI and interaction handling
  - `vscode-node/` - VS Code chat implementation
- **`chatSessions/`** - Chat session management
  - `vscode/` - VS Code session handling
  - `vscode-node/` - Node.js session persistence
- **`conversation/`** - Conversation logic and state management
  - `common/` - Shared conversation types
  - `node/` - Node.js conversation processing
  - `vscode-node/` - VS Code conversation integration
- **`conversationStore/`** - Conversation persistence layer
  - `node/` - File-based conversation storage

#### Code Editing & Completion

- **`completions/`** - Code completion functionality
  - `common/` - Shared completion logic
  - `vscode-node/` - VS Code completion provider
- **`inlineChat/`** - Inline chat editor widget
  - `node/` - Core inline chat logic
  - `vscode-node/` - VS Code inline chat UI
  - `test/` - Unit tests
- **`inlineCompletion/`** - Inline code completion suggestions
  - `node/` - Completion generation logic
- **`inlineCompletionPrompt/`** - Prompt engineering for completions
  - `common/` - Shared prompt templates
  - `node/` - Prompt generation logic
- **`inlineEdits/`** - Next Edit Suggestions (NES) feature
  - `common/` - Shared edit types
  - `node/` - Edit generation and application
  - `vscode-node/` - VS Code edit integration
  - `test/` - Unit tests

#### Code Intelligence & Context

- **`context/`** - Context gathering for AI requests
  - `node/` - Context extraction logic
  - `vscode/` - VS Code context providers
- **`languageContextProvider/`** - Language-specific context
  - `vscode-node/` - Language service integration
- **`typescriptContext/`** - TypeScript-specific context
  - `common/` - Shared TypeScript types
  - `serverPlugin/` - TypeScript language server plugin
  - `vscode-node/` - VS Code TypeScript integration
  - `DEVELOPMENT.md` - Development guide
- **`relatedFiles/`** - Related file discovery
  - `node/` - File relationship analysis
  - `vscode-node/` - VS Code file navigation

#### Search & Discovery

- **`search/`** - Code search functionality
  - `vscode-node/` - VS Code search integration
- **`workspaceChunkSearch/`** - Chunked workspace search
  - `node/` - Search indexing and querying
  - `vscode-node/` - VS Code workspace search
- **`workspaceSemanticSearch/`** - Semantic code search
  - `node/` - Embedding-based search

#### Intent Detection & Commands

- **`intents/`** - User intent classification
  - `common/` - Intent types and definitions
  - `node/` - Intent detection logic
  - `vscode-node/` - VS Code intent handling
  - `test/` - Unit tests
- **`commands/`** - Slash command implementations
  - `node/` - Command handlers
- **`prompts/`** - Prompt templates and management
  - `node/` - Prompt loading and rendering
- **`prompt/`** - Prompt engineering and construction
  - `common/` - Shared prompt utilities
  - `node/` - Prompt generation
  - `vscode-node/` - VS Code prompt integration
  - `test/` - Unit tests

#### Tools & Integrations

- **`tools/`** - AI tool definitions and execution
  - `common/` - Tool interfaces
  - `node/` - Tool implementations
  - `vscode-node/` - VS Code tool integration
  - `test/` - Unit tests
- **`mcp/`** - Model Context Protocol integration
  - `vscode-node/` - MCP server communication
  - `test/` - Unit tests
- **`notebook/`** - Jupyter notebook support
  - `vscode-node/` - VS Code notebook integration

#### Authentication & Configuration

- **`authentication/`** - User authentication
  - `vscode-node/` - GitHub authentication
- **`byok/`** - Bring Your Own Key (custom API keys)
  - `common/` - BYOK interfaces
  - `node/` - Key management
  - `vscode-node/` - VS Code settings integration
- **`configuration/`** - Extension configuration
  - `vscode-node/` - Settings management
- **`settingsSchema/`** - Settings schema definition
  - `vscode-node/` - JSON schema generation

#### UI Components & Features

- **`codeBlocks/`** - Code block rendering in chat
  - `node/` - Code block parsing
  - `vscode-node/` - VS Code code block UI
- **`linkify/`** - Link detection and rendering
  - `common/` - Link parsing
  - `vscode-node/` - VS Code link integration
  - `test/` - Unit tests
- **`contextKeys/`** - VS Code context key management
  - `vscode-node/` - Context key providers
- **`getting-started/`** - Onboarding and getting started
  - `common/` - Onboarding flow
  - `vscode-node/` - VS Code walkthrough

#### Version Control & Review

- **`git/`** - Git integration
  - `common/` - Git operations
  - `vscode/` - VS Code Git API usage
- **`review/`** - Code review features
  - `node/` - Review logic
- **`replay/`** - Session replay functionality
  - `common/` - Replay types
  - `vscode-node/` - VS Code replay UI

#### Workspace & File Management

- **`ignore/`** - .gitignore and file filtering
  - `vscode-node/` - Ignore pattern handling
- **`promptFileContext/`** - File context for prompts
  - `vscode-node/` - File content extraction
- **`workspaceRecorder/`** - Workspace state recording
  - `common/` - Recording interfaces
  - `vscode-node/` - VS Code workspace tracking

#### Testing & Debugging

- **`testing/`** - Test runner integration
  - `common/` - Test interfaces
  - `node/` - Test execution
  - `vscode/` - VS Code test explorer
- **`onboardDebug/`** - Debugging onboarding
  - `common/` - Debug types
  - `node/` - Debug logic
  - `vscode/` - VS Code debug integration
  - `vscode-node/` - Debug session management
  - `test/` - Unit tests
- **`test/`** - Testing utilities
  - `common/` - Shared test helpers
  - `node/` - Node.js test utilities
  - `vscode-node/` - VS Code test helpers

#### Other Features

- **`renameSuggestions/`** - AI-powered rename suggestions
  - `common/` - Rename interfaces
  - `node/` - Rename generation
  - `test/` - Unit tests
- **`survey/`** - User feedback surveys
  - `vscode-node/` - Survey UI
- **`telemetry/`** - Usage telemetry
  - `common/` - Telemetry events
  - `vscode/` - VS Code telemetry integration
- **`log/`** - Logging infrastructure
  - `vscode-node/` - VS Code output channel
- **`api/`** - Public API surface
  - `vscode/` - Extension API
- **`xtab/`** - Cross-tab communication
  - `common/` - Message types
  - `node/` - Message handling
  - `test/` - Unit tests

#### Common Files

- **`common/`** - Shared constants and contributions
  - `constants.ts` - Extension constants (intents, commands)
  - `contributions.ts` - VS Code contribution points
- **VS Code Type Definitions** - Various `vscode.proposed.*.d.ts` files for proposed VS Code APIs

---

### `src/platform/`

Contains platform-agnostic business logic and services. This layer is designed to be reusable across different environments (VS Code, CLI, etc.) and minimizes dependencies on specific platform APIs.

#### Authentication & Tokens

- **`authentication/`** - Authentication services
  - `common/` - Auth interfaces and types
  - `node/` - Token management
  - `vscode-node/` - VS Code auth integration
  - `test/` - Auth tests

#### Chat & Interaction

- **`chat/`** - Core chat functionality
  - `common/` - Chat types, quota management, interaction service
  - `vscode/` - VS Code chat participants
  - `test/` - Chat tests

#### AI & Language Models

- **`openai/`** - OpenAI API client
  - `node/` - OpenAI integration
- **`embeddings/`** - Embedding generation and management
  - `common/` - Embedding interfaces
  - `test/` - Embedding tests
- **`tokenizer/`** - Token counting for LLMs
  - `node/` - Tokenizer implementation
  - `test/` - Tokenizer tests
- **`thinking/`** - Extended thinking capabilities
  - `common/` - Thinking interfaces

#### Code Analysis & Editing

- **`parser/`** - Code parsing utilities
  - `node/` - Tree-sitter based parsing
  - `test/` - Parser tests
- **`diff/`** - Diff generation and application
  - `common/` - Diff interfaces
  - `node/` - Diff algorithms
- **`editing/`** - Code editing utilities
  - `common/` - Edit types
  - `node/` - Edit application
- **`multiFileEdit/`** - Multi-file editing
  - `common/` - Multi-file edit coordination
- **`inlineEdits/`** - Platform-agnostic inline edit logic
  - `common/` - Edit types and interfaces
  - `test/` - Edit tests
- **`inlineCompletions/`** - Inline completion types
  - `common/` - Completion interfaces

#### Search & Indexing

- **`search/`** - Search infrastructure
  - `common/` - Search interfaces
  - `vscode/` - VS Code search
  - `vscode-node/` - Node.js search implementation
- **`remoteSearch/`** - Remote code search
  - `common/` - Remote search types
  - `node/` - Remote search client
  - `test/` - Search tests
- **`remoteCodeSearch/`** - GitHub code search
  - `common/` - Code search interfaces
  - `node/` - Code search implementation
  - `vscode-node/` - VS Code integration
- **`workspaceChunkSearch/`** - Chunked search
  - `common/` - Chunking interfaces
  - `node/` - Chunk indexing
  - `test/` - Chunking tests
- **`urlChunkSearch/`** - URL-based chunk search
  - `node/` - URL chunk search
- **`tfidf/`** - TF-IDF ranking
  - `node/` - TF-IDF implementation
- **`chunking/`** - Code chunking utilities
  - `common/` - Chunking interfaces
  - `node/` - Chunking algorithms

#### Version Control & Git

- **`git/`** - Git operations
  - `common/` - Git interfaces
  - `vscode/` - VS Code Git API
  - `test/` - Git tests
- **`github/`** - GitHub API integration
  - `common/` - GitHub types
  - `node/` - GitHub client
- **`remoteRepositories/`** - Remote repository support
  - `common/` - Remote repo interfaces
  - `vscode/` - VS Code remote repo integration

#### Workspace & Files

- **`workspace/`** - Workspace management
  - `common/` - Workspace interfaces
  - `vscode/` - VS Code workspace API
- **`filesystem/`** - File system operations
  - `common/` - File system interfaces
  - `node/` - Node.js file operations
  - `vscode/` - VS Code file system
- **`ignore/`** - Ignore pattern handling
  - `common/` - Ignore interfaces
  - `node/` - Ignore file parsing
  - `vscode/` - VS Code ignore integration
  - `vscode-node/` - Combined implementation
- **`heatmap/`** - File edit frequency tracking
  - `common/` - Heatmap interfaces
  - `vscode/` - VS Code integration
  - `test/` - Heatmap tests
- **`workspaceRecorder/`** - Workspace change recording
  - `common/` - Recording interfaces
- **`workspaceState/`** - Workspace state persistence
  - `common/` - State interfaces

#### Configuration & Environment

- **`configuration/`** - Configuration management
  - `common/` - Config interfaces
  - `vscode/` - VS Code settings
  - `test/` - Config tests
- **`env/`** - Environment detection
  - `common/` - Environment interfaces
  - `vscode/` - VS Code environment
  - `vscode-node/` - Node.js environment
- **`customInstructions/`** - Custom instructions
  - `common/` - Instruction types
- **`devcontainer/`** - Dev container support
  - `common/` - Dev container detection

#### Networking & API

- **`networking/`** - HTTP client and networking
  - `common/` - Networking interfaces
  - `node/` - Node.js HTTP client
  - `vscode-node/` - VS Code networking
  - `test/` - Networking tests
- **`endpoint/`** - API endpoint management
  - `common/` - Endpoint interfaces
  - `node/` - Endpoint discovery
  - `vscode-node/` - VS Code integration
  - `test/` - Endpoint tests
- **`nesFetch/`** - Next Edit Suggestions fetcher
  - `common/` - NES fetch interfaces
  - `node/` - NES API client

#### UI & Interaction

- **`dialog/`** - Dialog utilities
  - `common/` - Dialog interfaces
  - `vscode/` - VS Code dialogs
- **`notification/`** - Notification system
  - `common/` - Notification interfaces
  - `vscode/` - VS Code notifications
- **`workbench/`** - Workbench integration
  - `common/` - Workbench interfaces
  - `vscode/` - VS Code workbench
  - `test/` - Workbench tests
- **`tabs/`** - Tab management
  - `common/` - Tab interfaces
  - `vscode/` - VS Code tab API
- **`open/`** - Opening files and URLs
  - `common/` - Open interfaces
  - `vscode/` - VS Code open API
- **`interactive/`** - Interactive window support
  - `common/` - Interactive interfaces
  - `vscode/` - VS Code interactive window

#### Development Tools

- **`terminal/`** - Terminal integration
  - `common/` - Terminal interfaces
  - `vscode/` - VS Code terminal
- **`debug/`** - Debugging support
  - `common/` - Debug interfaces
  - `vscode/` - VS Code debug API
- **`tasks/`** - Task runner integration
  - `common/` - Task interfaces
  - `vscode/` - VS Code tasks
- **`testing/`** - Test framework integration
  - `common/` - Testing interfaces
  - `node/` - Test execution
  - `vscode/` - VS Code test API
  - `test/` - Testing tests
- **`commands/`** - Command infrastructure
  - `common/` - Command interfaces
  - `vscode/` - VS Code commands

#### Language Support

- **`languages/`** - Language service integration
  - `common/` - Language interfaces
  - `vscode/` - VS Code language features
- **`languageServer/`** - Language server protocol
  - `common/` - LSP types
- **`languageContextProvider/`** - Language context
  - `common/` - Context provider interfaces
- **`notebook/`** - Notebook support
  - `common/` - Notebook interfaces
  - `vscode/` - VS Code notebook API
  - `test/` - Notebook tests

#### Observability & Diagnostics

- **`telemetry/`** - Telemetry infrastructure
  - `common/` - Telemetry events
  - `node/` - Telemetry client
  - `vscode-node/` - VS Code telemetry
  - `test/` - Telemetry tests
- **`log/`** - Logging services
  - `common/` - Log interfaces
  - `vscode/` - VS Code logging
  - `test/` - Log tests
- **`requestLogger/`** - HTTP request logging
  - `node/` - Request logger

#### UI Utilities

- **`review/`** - Code review infrastructure
  - `common/` - Review interfaces
  - `vscode/` - VS Code review UI
- **`scopeSelection/`** - Scope selection utilities
  - `common/` - Selection interfaces
  - `vscode-node/` - VS Code selection
- **`settingsEditor/`** - Settings editor utilities
  - `common/` - Settings editor interfaces
- **`releaseNotes/`** - Release notes display
  - `common/` - Release note types
  - `vscode/` - VS Code release notes
- **`survey/`** - Survey infrastructure
  - `common/` - Survey types
  - `vscode/` - VS Code survey UI

#### Advanced Features

- **`editSurvivalTracking/`** - Edit survival tracking
  - `common/` - Tracking interfaces
  - `test/` - Tracking tests
- **`snippy/`** - Snippet management
  - `common/` - Snippet types
- **`projectTemplatesIndex/`** - Project templates
  - `common/` - Template index
- **`prompts/`** - Prompt utilities
  - `common/` - Prompt helpers
- **`image/`** - Image processing
  - `common/` - Image interfaces
  - `node/` - Image utilities

#### Testing Support

- **`test/`** - Platform test utilities
  - `common/` - Shared test helpers
  - `node/` - Node.js test utilities
- **`simulationTestContext/`** - Simulation testing
  - `common/` - Simulation context

#### Extension Integration

- **`extensions/`** - Extension API integration
  - `common/` - Extension interfaces
  - `vscode/` - VS Code extension API
- **`extContext/`** - Extension context
  - `common/` - Context management

---

### `src/util/`

Contains pure utility functions and helpers that are used throughout the codebase.

#### `util/common/`

Platform-agnostic utility functions:

- **`arrays.ts`** - Array manipulation utilities
- **`async.ts`** - Async/await helpers and promise utilities
- **`cache.ts`** - Caching utilities
- **`debounce.ts`** - Debouncing and throttling
- **`errors.ts`** - Error handling utilities
- **`lock.ts`** - Locking mechanisms
- **`time.ts`** - Time and date utilities
- **`types.ts`** - TypeScript type utilities
- **`result.ts`** - Result type (like Rust's Result)
- **`racePromise.ts`** - Promise racing utilities

Code-related utilities:

- **`diff.ts`** - Diff utilities
- **`range.ts`** - Range manipulation
- **`annotatedLineRange.ts`** - Line range with annotations
- **`fileSystem.ts`** - File system utilities
- **`fileTree.ts`** - File tree structures
- **`glob.ts`** - Glob pattern utilities
- **`languages.ts`** - Language detection
- **`markdown.ts`** - Markdown processing
- **`notebooks.ts`** - Notebook utilities
- **`tokenizer.ts`** - Tokenization utilities

AI/ML utilities:

- **`anomalyDetection.ts`** - Anomaly detection algorithms
- **`chatResponseStreamImpl.ts`** - Chat response streaming
- **`imageUtils.ts`** - Image processing utilities

Infrastructure utilities:

- **`crypto.ts`** - Cryptographic utilities
- **`progress.ts`** - Progress reporting
- **`progressRecorder.ts`** - Progress recording
- **`services.ts`** - Service container pattern
- **`taskSingler.ts`** - Task deduplication
- **`telemetryCorrelationId.ts`** - Telemetry correlation
- **`tracing.ts`** - Distributed tracing
- **`variableLengthQuantity.ts`** - VLQ encoding
- **`vscodeVersion.ts`** - VS Code version utilities
- **`pathRedaction.ts`** - Path redaction for privacy
- **`timeTravelScheduler.ts`** - Deterministic scheduling for tests

Debug/Development:

- **`debugValueEditorGlobals.ts`** - Debug value editor globals

Type definitions:

- **`globals.d.ts`** - Global type definitions

#### `util/node/`

Node.js-specific utilities:

- **`crypto.ts`** - Node.js crypto utilities
- **`jsonFile.ts`** - JSON file reading/writing
- **`ports.ts`** - Port availability checking
- **`worker.ts`** - Worker thread utilities

#### `util/vs/`

Vendored utilities from VS Code:

- **`base/`** - Base utilities from VS Code
- **`editor/`** - Editor utilities
- **`platform/`** - Platform utilities
- **`workbench/`** - Workbench utilities
- Various type definition files for VS Code internals

#### `util/test/`

Testing utilities for the util layer.

---

### `src/lib/`

Library entry points for using Copilot Chat functionality outside of the VS Code extension context.

- **`lib/node/chatLibMain.ts`** - Main entry point for the chat library
  - Provides standalone access to chat, completion, and inline edit functionality
  - Used for testing and non-VS Code integrations

---

## Architectural Patterns

### Layering

The codebase follows a clear layering strategy:

1. **`util/`** - Pure functions, no dependencies
2. **`platform/`** - Business logic, minimal platform dependencies
3. **`extension/`** - VS Code-specific implementations
4. **`lib/`** - Standalone library interfaces

Dependencies flow downward only: `extension` → `platform` → `util`

### Environment Separation

Code is organized by execution environment:

- **`common/`** - Shared code that runs anywhere
- **`node/`** - Node.js runtime code
- **`vscode/`** - VS Code API-dependent code (browser or Node.js)
- **`vscode-node/`** - VS Code API + Node.js runtime code
- **`vscode-worker/`** - VS Code Web Worker code

This allows the same feature to have different implementations for different environments while sharing common logic.

### Service Pattern

The codebase uses dependency injection with service interfaces:

- Platform services are defined as interfaces in `platform/*/common/`
- Implementations are in `platform/*/node/` or `platform/*/vscode/`
- Extension code consumes services through interfaces

This pattern enables testability and environment flexibility.

### Feature Organization

Each major feature is organized into its own directory with:

- Core logic in `platform/`
- VS Code integration in `extension/`
- Tests colocated with the code
- Common types shared between layers

---

## Key Technologies

- **TypeScript** - Primary language
- **VS Code Extension API** - UI and integration
- **Tree-sitter** - Code parsing
- **Node.js** - Runtime for extension host
- **OpenAI API** - LLM integration
- **GitHub APIs** - Authentication and code search
- **Model Context Protocol (MCP)** - Tool integration

---

## Testing

Tests are colocated with the code being tested:

- Unit tests in `test/` subdirectories
- Platform tests for business logic
- Extension tests for VS Code integration
- Test utilities in `util/test/` and `platform/test/`

---

## Build and Deployment

The extension is built using:

- TypeScript compiler for type checking
- Bundler (esbuild/webpack) for packaging
- VS Code extension packaging (vsce)
- Separate builds for different environments (desktop, web)

The `src/extension/extension/` directory contains the main entry points for different build targets.

---

## Contributing

When adding new features:

1. Place platform-agnostic logic in `platform/`
2. Place VS Code-specific code in `extension/`
3. Create reusable utilities in `util/`
4. Follow the environment separation pattern
5. Use service interfaces for dependencies
6. Colocate tests with implementation
7. Document public APIs

---

## Related Documentation

- [TECHNICAL-OVERVIEW.md](./TECHNICAL-OVERVIEW.md) - High-level technical overview
- [AGENT-MODE.md](./AGENT-MODE.md) - Agent mode documentation
- [tools.md](./tools.md) - Tool system documentation
- [typescriptContext/DEVELOPMENT.md](../src/extension/typescriptContext/DEVELOPMENT.md) - TypeScript context development

---

*This documentation reflects the structure as of the current codebase version. For the most up-to-date information, please refer to the source code itself.*
