# GitHub Copilot Chat – Project Instructions

## Tech Stack & Architecture
- **TypeScript** (primary), **TSX** (prompt components), **Node.js** runtime
- Uses **VS Code Extension API** (with proposed APIs), **ESBuild** for bundling, **Vitest** for unit tests
- Supports multiple AI models (OpenAI, Anthropic/Claude, Gemini, etc.)
- Key features: conversational chat, inline editing, agent mode, semantic/AI search, workspace context, and code review

## Build & Test Commands
- **Install dependencies:** `npm install`
- **Development build:** `npm run compile`
- **Watch mode (recommended for dev):** `npm run watch` (runs `start-watch-tasks`)
- **Unit tests:** `npm run test:unit`
- **Integration tests:** `npm run test:extension`
- **Simulation tests:** `npm run simulate`
- **Always check the `start-watch-tasks` output for compilation errors before running scripts or tests**

## Project Structure
- `src/extension/` – Main extension features (chat, inline chat, agents, context, prompts, search, authentication, UI, etc.)
- `src/platform/` – Shared platform services (chat, OpenAI, embeddings, parser, search, telemetry, workspace, git)
- `src/util/` – Common utilities and VS Code abstractions
- `test/` – Unit, integration, and simulation tests
- `assets/` – Icons and visual assets
- `build/`, `dist/` – Build outputs
- `docs/`, `CONTRIBUTING.md` – Documentation and dev guide
- Key configs: `package.json`, `tsconfig.json`, `.esbuild.ts`, `vite.config.ts`

## Coding Conventions
- **Tabs** for indentation
- **PascalCase** for types/enums, **camelCase** for variables/functions
- **"double quotes"** for user-visible strings, **'single quotes'** for internal
- Use arrow functions (`=>`), always use curly braces for blocks
- Use dependency injection/services (e.g., `IInstantiationService`), not direct Node/VS Code APIs
- Prefer `URI` over string file paths

## Development Tips
- Features are grouped by functionality, not technical layer
- Tests and fixtures are close to implementation
- Use `.tsx` with `vscpp`/`vscppf` for prompt components
- See `src/extension/agents/claude/AGENTS.md` for Claude agent integration details

## Key Entry Points
- Add chat features: `src/extension/conversation/`
- Edit inline chat: `src/extension/inlineChat/`, `src/extension/inlineEdits/`
- Context/prompt logic: `src/extension/context/`, `src/extension/prompts/`
- AI/model endpoints: `src/extension/endpoint/`, `src/extension/tools/`
- Tests: `test/`, `src/extension/testing/`

## Best Practices
- Monitor watch task output for errors
- Use services and helpers for file/URI handling
- Follow VS Code and project-specific coding standards

For more, see `README.md` and `CONTRIBUTING.md`.