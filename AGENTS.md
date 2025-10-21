# Repository Guidelines

## Project Structure & Module Organization
- Source lives in `src/extension/` (VS Code activation, chat services, agent tooling) and `src/lib/` (shared utilities). Update `src/**` first, then refresh `chat-lib/` artifacts via the scripts in `script/`.
- Tests reside in `test/`: use `test/simulation/**` for agent workflows and `test/extension/**` for VS Code harness checks. Keep fixtures under their existing directories to respect Git LFS rules.
- Automation scripts sit in `script/`, while packaged assets are stored in `resources/` and `assets/`. Place new prompt components under `src/extension/**/prompt/` with the existing `.prompt.tsx` suffix.

## Build, Test, and Development Commands
- `npm run compile` produces a fast esbuild bundle for local iteration; pair with `npm run watch` to rebuild on change.
- `npm run build` emits the production bundle to `dist/`; use `npm run package` to generate a VSIX for manual verification.
- Quality gates: `npm run typecheck`, `npm run lint`, and `npm run tsfmt`. Run all three before submitting changes.
- Execute `npm run test:unit`, `npm run test:extension`, and `npm run simulate-ci` to cover logic, VS Code integration, and agent-mode regressions respectively.

## Coding Style & Naming Conventions
- TypeScript and TSX files enforce hard tabs; ESLint blocks spaces and requires the Microsoft license header on new sources.
- Prefer `PascalCase` for classes/components, `camelCase` for functions and locals, and `SCREAMING_CASE` only for constants mirroring VS Code APIs.
- Format TypeScript via `npm run tsfmt`; rely on Prettier solely for Markdown or JSON edits.

## Testing Guidelines
- Write Vitest specs in `*.spec.ts`, using fakes from `src/lib/testUtils` to isolate external services.
- Agent simulations live in `*.stest.ts`; after intentional behavior changes, update baselines with `npm run simulate-update-baseline`.
- If assets fail to load, run `git lfs pull` to restore large fixtures.

## Commit & Pull Request Guidelines
- Follow the log format `scope: short imperative summary (#issue)` to keep changelog automation consistent.
- PRs should list the validation commands you ran, link relevant issues, and attach screenshots or transcripts for UX changes.
- Squash or rebase before opening a PR, and flag any breaking API updates for coordination with agent-mode owners.

## Security & Configuration Tips
- Run `npm run setup`, `npm run get_env`, or `npm run get_token` to provision secrets locally. Never commit `.env` or credential files.
- Store API keys in VS Code secret storage or environment variables, and scrub logs before sharing simulation output outside the team.
