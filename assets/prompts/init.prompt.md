---
name: init
description: Generate or update workspace instructions file for AI coding agents
argument-hint: Optionally specify a focus area or pattern to document for agents
agent: agent
---
Related skill: `agent-customization`. Load and follow **workspace-instructions.md** for template, principles, and anti-patterns.

Bootstrap workspace instructions (`.github/copilot-instructions.md` or `AGENTS.md` if already present).

## Workflow

1. **Discover existing conventions**
   Search: `**/{.github/copilot-instructions.md,AGENT.md,AGENTS.md,CLAUDE.md,.cursorrules,.windsurfrules,.clinerules,.cursor/rules/**,.windsurf/rules/**,.clinerules/**,README.md}`

2. **Explore the codebase** via subagent, 1-3 in parallel if needed
   Find essential knowledge that helps an AI agent be immediately productive:
   - Build/test commands (agents run these automatically)
   - Architecture decisions and component boundaries
   - Project-specific conventions that differ from common practices
   - Potential pitfalls or common development environment issues
   - Key files/directories that exemplify patterns

3. **Generate or merge**
   - New file: Use template from workspace-instructions.md, include only relevant sections
   - Existing file: Preserve valuable content, update outdated sections, remove duplication

4. **Iterate**
   - Ask for feedback on unclear or incomplete sections
   - If the workspace is complex, suggest applyTo-based instructions for specific areas (e.g., frontend, backend, tests)

Once finalized, suggest example prompts to see it in action, and propose related agent-customizations to create next (`/create-(agent|hook|instruction|prompt|skill) …`), explaining the customization and how it would be used in practice.
