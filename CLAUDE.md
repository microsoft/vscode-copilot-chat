# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **GitHub Copilot Chat** extension for Visual Studio Code. It provides conversational AI assistance, an autonomous coding agent with extensive tooling, inline editing capabilities, and advanced AI-powered features integrated directly into VS Code.

**Key capabilities**: Chat interface, inline chat (`Ctrl+I`), agent mode (autonomous multi-step tasks), edit mode, code completions, language model integration (GPT-4, Claude, Gemini, etc.), and context-aware workspace understanding.

## Development Commands

### Setup
```bash
npm install                    # Install dependencies
npm run get_token             # Get authentication token (required for first-time setup)
npm run setup                 # Run both get_env and get_token
```

### Building and Development
```bash
npm run compile               # Development build
npm run build                 # Production build
npm run watch                 # Run all watch tasks in parallel
```

**Critical for validation**: ALWAYS monitor the `start-watch-tasks` VS Code task for real-time compilation errors. This runs multiple watch processes (`watch:tsc-extension`, `watch:tsc-extension-web`, `watch:tsc-simulation-workbench`, `watch:esbuild`). Never use the `compile` task alone to verify your changes - it doesn't catch all errors.

```bash
npm run typecheck            # Type-check all TypeScript without emitting files
npm run lint                 # Run ESLint (must have zero warnings)
npm run prettier             # Format code with Prettier
```

### Testing
```bash
npm test                           # Run all tests
npm run test:unit                  # Unit tests (Vitest)
npm run test:extension             # VS Code integration tests
npm run simulate                   # Simulation tests (LLM-based, uses cache)
npm run simulate-require-cache     # Ensure simulation cache is populated (for CI)
npm run simulate-update-baseline   # Update simulation test baseline
```

**Important**: Simulation tests are expensive and stochastic. They run 10 times each and use cached LLM responses from `test/simulation/cache/`. PRs will fail if cache layers are missing - VS Code team members must regenerate them.

### Running the Extension
- **Desktop**: Use "Launch Copilot Extension - Watch Mode" or "Launch Copilot Extension" debug configuration in VS Code
- **Web**:
  1. Ensure `"browser": "./dist/web"` in package.json
  2. Run `npm run web`
  3. Open `http://localhost:3000`
  4. Set `chat.experimental.serverlessWebEnabled` to `true`

## Architecture

### Layer Structure
Code is organized into runtime layers that define which APIs are available:
- `common`: Pure JavaScript, no runtime dependencies (can import VS Code types but not runtime)
- `vscode`: VS Code API access
- `node`: Node.js APIs and modules
- `vscode-node`: Both VS Code and Node.js APIs
- `worker`: Web Worker APIs
- `vscode-worker`: VS Code APIs in Web Worker context

**Goal**: Maximize code in `common` and `vscode` layers for cross-platform compatibility.

### Top-Level Directory Structure

```
src/
├── extension/    # Main extension features (chat, agents, tools, context, search, etc.)
├── platform/     # Shared platform services (search, parsing, telemetry, git, workspace)
└── util/         # Common utilities and VS Code API abstractions
```

**Dependency rules**:
- `util/` can't import from `platform/` or `extension/`
- `platform/` can import from `util/`
- `extension/` can import from both `util/` and `platform/`

### Extension Entry Points

The extension has separate entry points for different runtime environments:
- `src/extension/extension/vscode-node/extension.ts` - Node.js extension host (desktop)
- `src/extension/extension/vscode-worker/extension.ts` - Web Worker extension host (web/serverless)
- `src/extension/extension/vscode/extension.ts` - Shared activation logic

**Contributions and Services** are automatically registered from:
- `*/vscode/contributions.ts` and `*/vscode/services.ts` (cross-platform)
- `*/vscode-node/contributions.ts` and `*/vscode-node/services.ts` (Node.js only)
- `*/vscode-worker/contributions.ts` and `*/vscode-worker/services.ts` (Web Worker only)

### Key Subsystems

**Chat System** (`src/extension/conversation/`):
- Chat participants: Default agent, workspace agent, setup agent
- Request processing: Input parsing → Context resolution → Prompt construction → Model interaction → Response processing → Action execution
- Multiple AI providers with model selection, quota management, and fallbacks

**Agent Mode** (`src/extension/intents/node/`):
- Registered as a VS Code chat participant with special "agent mode" designation
- Uses `vscode.lm.invokeTool` API for tool invocation
- Main files: `agentPrompt.tsx`, `agentInstructions.tsx`, `toolCallingLoop.ts`
- Tool selection logic in `getTools` in `agentIntent.ts`

**Tools** (`src/extension/tools/`):
- Implements VS Code's Language Model Tool API
- Tool schemas defined in `package.json` under `languageModelTools`
- Tool names in `toolNames.ts`, implementations in `tools/node/`
- Some tools implement extended `ICopilotTool` interface for custom behavior
- See `docs/tools.md` for tool development guidelines

**Inline Chat** (`src/extension/inlineChat/` and `src/extension/inlineEdits/`):
- Triggered with `Ctrl+I`
- Features: Hint system, intent detection, context collection, streaming edits
- Version 2 with improved UX and hide-on-request functionality

**Context & Intelligence**:
- `context/` - Context resolution for workspace analysis
- `typescriptContext/` - TypeScript-specific analysis
- `relatedFiles/` - Related file discovery
- `workspaceSemanticSearch/` - Semantic search across workspace
- `workspaceChunkSearch/` - Chunked search for large codebases

**Prompts** (`src/extension/prompts/`):
- TSX-based prompt framework using `@vscode/prompt-tsx`
- Supports dynamic composition with token budget management via `priority` (like `zIndex`)
- Components: `SystemMessage`, `UserMessage`, `AssistantMessage`, `SafetyRules`
- Render with `PromptRenderer` - can do async `prepare()` then sync `render()`

## Coding Standards

### TypeScript Conventions
- **Indentation**: Use **tabs**, not spaces
- **Naming**: `PascalCase` for types/enums, `camelCase` for functions/methods/variables
- **Strings**: "double quotes" for user-visible/localized, 'single quotes' for internal
- **Functions**: Use arrow functions `=>` over anonymous functions
- **Arrow function params**: Only use parens when necessary: `x => x + x` ✓, `(x) => x + x` ✗
- **Conditionals**: Always use curly braces, opening brace on same line
- **Types**: Use proper types, avoid `any`, use `readonly` whenever possible
- **Scope**: Don't export types/functions unless needed across components

### React/JSX
- Custom JSX factory: `vscpp` (not React.createElement)
- Fragment factory: `vscppf`
- Configured in `tsconfig.json`

### Architecture Patterns
- **Service-oriented**: Dependency injection via `IInstantiationService`
- **Contribution-based**: Features self-register through contribution system
- **Event-driven**: Extensive use of VS Code events and disposables
- **Layered**: Clear separation between platform services and extension features

### Best Practices
- Use services instead of direct Node.js or VS Code APIs (e.g., `IFileService` instead of `fs`)
- Always use `URI` type instead of string paths - many URI helpers available
- Import from `util/vs/` for microsoft/vscode utilities (readonly, copied by script)
- Extensive VS Code proposed APIs enabled - see `enabledApiProposals` in package.json

## Special Considerations

### Debugging and Troubleshooting
Use "Show Chat Debug View" command to inspect:
- Full prompts sent to models
- Enabled tools for each request
- Model responses and tool calls
- Detailed request/response logs

⚠️ **Warning**: Debug logs may contain personal information. Review before sharing.

### VS Code API Updates
When updating proposed APIs:
- **Breaking changes**: Update API version in proposal .d.ts, update `enabledApiProposals` in package.json (e.g., `lmTools@2`), adopt changes immediately
- **Additive changes**: Update `engines.vscode` date field in package.json (e.g., `^1.91.0-20240624`)

### Utilities from microsoft/vscode
Don't manually copy utilities from the vscode repo. Instead:
1. Add module to list in `script/setup/copySources.ts`
2. Run `npx tsx script/setup/copySources.ts`
3. Sources appear in `src/util/vs/` (readonly, don't edit there)

### Web Compatibility
Avoid in web worker extension hosts:
- Direct Node.js API usage (`require`, `process.env`, `fs`)
- Node.js-only modules
- Dependencies on extensions unavailable in web (e.g., `vscode.Git`)

### Git LFS and Tree Sitter
- Git LFS required for running tests
- Tree Sitter WASM prebuilds from https://github.com/microsoft/vscode-tree-sitter-wasm

## File References

When explaining code locations, use the format `file_path:line_number` for easy navigation:
```
The client error handling is in src/services/process.ts:712
```
