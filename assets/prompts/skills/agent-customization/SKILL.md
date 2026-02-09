---
name: agent-customization
description: 'Create, update, review, fix, or debug VS Code agent customization files (.instructions.md, .prompt.md, .agent.md, SKILL.md, copilot-instructions.md, AGENTS.md). Use for: saving coding preferences; troubleshooting why instructions/skills/agents are ignored or not invoked; configuring applyTo patterns; defining tool restrictions; creating custom agent modes or specialized workflows; packaging domain knowledge; fixing YAML frontmatter syntax.'
---

# Agent Customization

## Decision Flow

| Primitive | When to Use |
|-----------|-------------|
| Workspace Instructions | Always-on, applies everywhere in the project |
| File Instructions | Explicit via `applyTo` patterns, or on-demand via `description` |
| MCP | Integrates external systems, APIs, or data |
| Custom Agents | Subagents for context isolation, or multi-stage workflows with tool restrictions |
| Prompts | Single focused task with parameterized inputs |
| Skills | On-demand workflow with bundled assets (scripts/templates) |

## Quick Reference

Consult the reference docs for templates, domain examples, advanced frontmatter options, asset organization, anti-patterns, and creation checklists.

| Type | File | Location | Reference |
|------|------|----------|-----------|
| Workspace Instructions | `copilot-instructions.md`, `AGENTS.md` | `.github/` or root | [Link](./primitives/workspace-instructions.md) |
| File Instructions | `*.instructions.md` | `.github/instructions/` | [Link](./primitives/instructions.md) |
| Prompts | `*.prompt.md` | `.github/prompts/` | [Link](./primitives/prompts.md) |
| Custom Agents | `*.agent.md` | `.github/agents/` | [Link](./primitives/agents.md) |
| Skills | `SKILL.md` | `.github/skills/<name>/`, `.agents/skills/<name>/`, `.claude/skills/<name>/` | [Link](./primitives/skills.md) |

**User-level**: `{{USER_PROMPTS_FOLDER}}/` (*.prompt.md, *.instructions.md, *.agent.md; not skills)
Customizations roam with user's settings sync

## Creation Process

If you need to explore or validate patterns in the codebase, use a read-only subagent. If the ask-questions tool is available, use it to interview the user and clarify requirements.

Follow these steps when creating any customization file.

### 1. Determine Scope

Ask the user where they want the customization:
- **Workspace**: For project-specific, team-shared customizations → `.github/` folder
- **User profile**: For personal, cross-workspace customizations → `{{USER_PROMPTS_FOLDER}}/`

### 2. Choose the Right Primitive

Use the Decision Flow above to select the appropriate file type based on the user's need.

### 3. Create the File

Create the file directly at the appropriate path:
- Use the location tables in each reference file
- Include required frontmatter as needed
- Add the body content following the templates

### 4. Validate

After creating:
- Confirm the file is in the correct location
- Verify frontmatter syntax (YAML between `---` markers)
- Check that `description` is present and meaningful

## Edge Cases

**Instructions vs Skill?** Does this apply to *most* work, or *specific* tasks? Most → Instructions. Specific → Skill.

**Skill vs Prompt?** Multi-step workflow with bundled assets → Skill. Single focused task with inputs → Prompt.

**Skill vs Custom Agent?** Same capabilities for all steps → Skill. Need context isolation (subagent returns single output) or different tool restrictions per stage → Custom Agent.
