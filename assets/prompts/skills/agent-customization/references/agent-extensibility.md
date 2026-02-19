# Agent Extensibility

## [Custom Agents (.agent.md)](https://code.visualstudio.com/docs/copilot/customization/custom-agents)

Custom personas with specific tools, instructions, and behaviors. Use for orchestrated workflows with role-based tool restrictions.

### Locations

| Path | Scope |
|------|-------|
| `.github/agents/*.agent.md` | Workspace |
| `<profile>/agents/*.agent.md` | User profile |

### Frontmatter

```yaml
---
description: "<required>"    # For agent picker and subagent discovery
name: "Agent Name"           # Optional, defaults to filename
tools: ["search", "web"]     # Optional: aliases, MCP (<server>/*), extension tools
model: "Claude Sonnet 4"     # Optional, supports array for fallback
argument-hint: "Task..."     # Optional, input guidance
agents: ["Agent1", "Agent2"] # Optional, restrict allowed subagents (omit = all, [] = none)
user-invocable: true         # Optional, show in agent picker (default: true)
disable-model-invocation: false  # Optional, prevent subagent invocation (default: false)
handoffs: [...]              # Optional, transitions to other agents
---
```

### Invocation Control

| Attribute | Default | Effect |
|-----------|---------|--------|
| `user-invocable: false` | `true` | Hide from agent picker, only accessible as subagent |
| `disable-model-invocation: true` | `false` | Prevent other agents from invoking as subagent |

### Tool Aliases

| Alias | Purpose |
|-------|---------|
| `execute` | Run shell commands |
| `read` | Read file contents |
| `edit` | Edit files |
| `search` | Search files or text |
| `agent` | Invoke custom agents as subagents |
| `web` | Fetch URLs and web search |
| `todo` | Manage task lists |

Common patterns: `["read", "search"]` (read-only), `["myserver/*"]` (MCP only), `[]` (conversational only)

### Template

```markdown
---
description: "{Use when... trigger phrases for subagent discovery}"
tools: ["{minimal set of tool aliases}"]
user-invocable: false
---
You are a specialist at {specific task}. Your job is to {clear purpose}.

## Constraints
- DO NOT {thing this agent should never do}
- ONLY {the one thing this agent does}

## Approach
1. {Step one}
2. {Step two}

## Output Format
{Exactly what this agent should return}
```

## [Skills (SKILL.md)](https://code.visualstudio.com/docs/copilot/customization/agent-skills)

Folders of instructions, scripts, and resources that agents load on-demand for specialized tasks.

### Structure

```
.github/skills/<skill-name>/
├── SKILL.md           # Required (name must match folder)
├── scripts/           # Executable code
├── references/        # Docs loaded as needed
└── assets/            # Templates, boilerplate
```

### Locations

| Path | Scope |
|------|-------|
| `.github/skills/<name>/` | Project |
| `.agents/skills/<name>/` | Project |
| `.claude/skills/<name>/` | Project |
| `~/.copilot/skills/<name>/` | Personal |
| `~/.agents/skills/<name>/` | Personal |
| `~/.claude/skills/<name>/` | Personal |

### SKILL.md Format

```yaml
---
name: skill-name              # Required: 1-64 chars, lowercase alphanumeric + hyphens, must match folder
description: 'What and when to use. Max 1024 chars.'
argument-hint: 'Optional hint shown for slash invocation'
user-invocable: true          # Optional: show as slash command (default: true)
disable-model-invocation: false # Optional: disable automatic model-triggered loading
---
```

### Progressive Loading

1. **Discovery** (~100 tokens): Agent reads `name` and `description`
2. **Instructions** (<5000 tokens): Loads `SKILL.md` body when relevant
3. **Resources**: Additional files load only when referenced

### Template

```markdown
---
name: webapp-testing
description: 'Test web applications using Playwright. Use for verifying frontend, debugging UI, capturing screenshots.'
---

# Web Application Testing

## When to Use
- Verify frontend functionality
- Debug UI behavior

## Procedure
1. Start the web server
2. Run [test script](./scripts/test.js)
3. Review screenshots in `./screenshots/`
```

### Slash Command Behavior

| Configuration | Slash command | Auto-loaded |
|---|---|---|
| Default (both omitted) | Yes | Yes |
| `user-invocable: false` | No | Yes |
| `disable-model-invocation: true` | Yes | No |
| Both set | No | No |

## Core Principles (Both Types)

1. **Keyword-rich descriptions**: Include trigger words for discovery
2. **Single role/task**: One persona per agent, one workflow per skill
3. **Minimal tools**: Only include what the role needs—excess tools dilute focus
4. **Clear boundaries**: Define what the agent should NOT do
5. **Progressive loading**: Keep SKILL.md under 500 lines; use reference files

## Anti-patterns

- **Swiss-army agents**: Too many tools, tries to do everything
- **Vague descriptions**: "A helpful agent" doesn't guide delegation—be specific
- **Name mismatch**: Skill folder name doesn't match `name` field
- **Monolithic SKILL.md**: Everything in one file instead of references
- **Circular handoffs**: A → B → A without progress criteria
- **Role confusion**: Agent description doesn't match body persona
