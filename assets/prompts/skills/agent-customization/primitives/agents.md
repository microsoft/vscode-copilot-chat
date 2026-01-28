# [Custom Agents (.agent.md)](https://code.visualstudio.com/docs/copilot/customization/custom-agents)

Custom personas with specific tools, instructions, and behaviors.

## Locations

| Path | Scope |
|------|-------|
| `.github/agents/*.agent.md` | Workspace |
| `<profile>/agents/*.agent.md` | User profile |

## Frontmatter

```yaml
---
description: "<required>"    # For agent picker and subagent discovery
name: "Agent Name"           # Optional, defaults to filename
tools: ["search", "fetch"]   # Optional: built-in, MCP (<server>/*), extension
model: "Claude Sonnet 4"     # Optional, uses picker default
argument-hint: "Task..."     # Optional, input guidance
infer: true                  # Optional, enable on-demand subagent discovery (default: true)
agents: ["Agent1", "Agent2"] # Optional, restrict allowed subagents by name (omit = all, [] = none)
handoffs: [...]              # Optional, transitions to other agents
---
```

## Tools

Specify tool names in the `tools` array. Sources: built-in tools, tool sets, MCP servers (`<server>/*`), or extension-contributed tools.

To discover available tools, search your current tool list or use the tool search capability.

**Special**: `[]` = no tools, omit = defaults. Body reference: `#tool:<name>`

### Tool Aliases

Common aliases for restricting agent capabilities:

| Alias | Purpose |
|-------|---------|
| `shell` | Execute shell commands |
| `read` | Read file contents |
| `edit` | Edit files (exact tools vary) |
| `search` | Search files or text |
| `custom-agent` | Invoke other custom agents as subagents |
| `web` | Fetch URLs and web search |
| `todo` | Create and manage task lists |

### Common Restriction Patterns

```yaml
# Read-only agent (no editing, no execution)
tools: ["read", "search"]

# MCP-only agent
tools: ["myserver/*"]

# No terminal access
tools: ["read", "edit", "search"]

# Planning agent (research only)
tools: ["search", "web", "read"]
```

For the full list of available tools, see the [VS Code documentation](https://code.visualstudio.com/docs/copilot/customization/custom-agents).

## Template

```markdown
---
description: "Generate implementation plans"
tools: ["search", "fetch", "githubRepo", "usages"]
---
You are in planning mode. Generate plans, don't edit code. Include: Overview, Requirements, Steps, Testing.
```

## Invocation

- **Manual**: Agents dropdown or `Chat: Switch Agent...` command
- **On-demand (subagent)**: When `infer: true`, parent agent can delegate based on `description` match—like skills and instructions

## When to Use

**Key Signal**: Orchestrated multi-stage processes with role-based tool restrictions. Different stages need different capabilities or strict handoffs.

## Domain Examples

| Domain | Example Workflow |
|--------|------------------|
| Engineering | planner → implementer → reviewer → deployer |
| Product | research → strategy → execution → measurement |
| Analytics | scope → build → analyze → report |
| Support | triage → troubleshoot → escalate → close |
| Content | research → write → edit → publish |

## Creation Process

### 1. Gather Requirements

- What role or persona should this agent embody?
- What specific tools does this role need (and which should it NOT have)?
- Should this be workspace-specific or personal (user profile)?
- Will this agent hand off to other agents?

### 2. Determine Location

| Scope | Path |
|-------|------|
| Workspace | `.github/agents/<name>.agent.md` |
| User profile | `<profile>/agents/<name>.agent.md` |

### 3. Create the File

```markdown
---
description: "<role description for agent picker>"
tools: ["<minimal tool set>"]
---
You are a <role>. Your responsibilities:
- <primary responsibility>
- <constraints on behavior>

<Specific instructions for this role>
```

### 4. Configure Handoffs (optional)

If this agent is part of a workflow:
```yaml
handoffs:
  - agent: "next-stage-agent"
    condition: "When <trigger condition>"
```

## Core Principles

1. **Single role per agent**: Each agent embodies one persona with focused responsibilities
2. **Minimal tool set**: Only include tools required for the role—excess tools dilute focus and increase risk
3. **Clear boundaries**: Define what the agent should NOT do as clearly as what it should do
4. **Explicit handoffs**: When workflows span agents, define clear transition triggers
5. **Discoverable via description**: The `description` field drives agent picker display—make it actionable
6. **Keyword-rich for subagent discovery**: When `infer: true`, the `description` determines automatic delegation—include trigger words and use cases so the parent agent knows when to invoke this subagent

## Anti-patterns

- **Swiss-army agents**: Agents with many tools that try to do everything
- **Missing constraints**: Agents without clear boundaries on what they shouldn't attempt
- **Role confusion**: Description doesn't match the persona defined in the body
- **Circular handoffs**: Agent A hands to B which hands back to A without progress criteria
- **Tool sprawl**: Using `tools: []` to disable all tools when specific restrictions would suffice
- **Vague subagent descriptions**: Generic descriptions like "A helpful agent" that don't help the parent decide when to delegate—use phrases like "use proactively after code changes" for clear triggers