---
name: init
description: Generate or update workspace instructions file for AI coding agents
argument-hint: Optionally specify a focus area or pattern to document for agents
agent: agent
---
Related skill: `agent-customization`. Load and follow **workspace-instructions.md** for template, principles, and anti-patterns.

Bootstrap workspace instructions (`.github/copilot-instructions.md` or `AGENTS.md` if already present).

Shorter is better. Unnecessary content actively hurts agent performance and increases cost. A very short file, or recommending no file, is a valid outcome.

## Workflow

1. **Discover existing conventions**
   Search: `**/{.github/copilot-instructions.md,AGENT.md,AGENTS.md,CLAUDE.md,.cursorrules,.windsurfrules,.clinerules,.cursor/rules/**,.windsurf/rules/**,.clinerules/**,README.md}`

2. **Explore the codebase** via subagent, 1-3 in parallel if needed
   Look for things an agent genuinely **cannot** discover from config files, imports, or code:
   - Non-standard or surprising build/test setup (skip anything obvious from `package.json`)
   - Architectural decisions that contradict what agents would assume from reading the code
   - Project-specific conventions that differ from common practices
   - Environment pitfalls or gotchas that cause silent failures

   Also inventory existing documentation (`docs/**/*.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, etc.) to identify topics that should be linked, not duplicated.

3. **Filter ruthlessly**
   Apply the **inclusion test** from workspace-instructions.md to every candidate item. Each must be:
   - **Undiscoverable**: agent can't find it from config files, imports, or code
   - **Stable**: won't go stale when files are renamed or code changes
   - **Global**: applies to every task type in this repo

   Discard anything that fails. Track items that are valuable but not global; these become skill or instruction suggestions.

4. **Generate or merge**
   - New file: Use template from workspace-instructions.md, include only sections that survived filtering
   - Existing file: Preserve valuable content, **remove** content that fails the inclusion test, update outdated sections
   - Follow the **Link, don't embed** principle from workspace-instructions.md

5. **Iterate**
   - Ask for feedback on unclear or incomplete sections
   - For task-specific patterns that failed the globality test, suggest creating skills or `applyTo`-based file instructions instead
   - If the workspace is complex, suggest applyTo-based instructions for specific areas (e.g., frontend, backend, tests)

Once finalized, suggest example prompts to see it in action, and propose related agent-customizations to create next (`/create-(agent|hook|instruction|prompt|skill) …`), explaining the customization and how it would be used in practice.
