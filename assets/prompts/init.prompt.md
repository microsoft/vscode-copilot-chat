---
name: init
description: Generate or update workspace instructions file for AI coding agents
argument-hint: Optionally specify a focus area or pattern to document for agents
agent: agent
---
Related skill: `agent-customization`.

Generate or update workspace instructions (`.github/copilot-instructions.md` as first choice, or `AGENTS.md` if it is already present) for guiding AI coding agents in this workspace.

## Discovery

Search for existing AI conventions using this glob pattern: `**/{.github/copilot-instructions.md,AGENT.md,AGENTS.md,CLAUDE.md,.cursorrules,.windsurfrules,.clinerules,.cursor/rules/**,.windsurf/rules/**,.clinerules/**,README.md}`

Then, start a subagent to research essential knowledge that helps an AI agent be immediately productive. Only include sections the workspace benefits from—skip any that don't apply:

```markdown
# Project Guidelines

## Code Style
{Language and formatting preferences - reference key files that exemplify patterns}

## Architecture
{Major components, service boundaries, data flows, the "why" behind structural decisions}

## Build and Test
{Commands to install, build, test - agents will attempt to run these automatically}

## Project Conventions
{Patterns that differ from common practices - include specific examples from the codebase}

## Integration Points
{External dependencies and cross-component communication}

## Security
{Sensitive areas and auth patterns}
```

## Guidelines

- If `.github/copilot-instructions.md`/`AGENTS.md` exists, merge intelligently—preserve valuable content while updating outdated sections
- If `AGENTS.md` exists, prefer updating it; for monorepos, use nested files per package (closest file to edited code wins)
- Write concise, actionable instructions (~20-50 lines) using markdown structure
- Link specific examples from the codebase when describing patterns
- Reference key files/directories that exemplify important patterns
- Avoid generic advice ("write tests", "handle errors")—focus on THIS project's specific approaches
- Document only discoverable patterns, not aspirational practices
- List build/test commands explicitly—agents will attempt to run them automatically

Update `.github/copilot-instructions.md`/`AGENTS.md`, then ask for feedback on unclear or incomplete sections to iterate.