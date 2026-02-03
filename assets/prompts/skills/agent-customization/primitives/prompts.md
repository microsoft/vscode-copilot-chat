# [Prompts (.prompt.md)](https://code.visualstudio.com/docs/copilot/customization/prompt-files)

Reusable task templates triggered on-demand in chat. Single focused task with parameterized inputs.

## Locations

| Path | Scope |
|------|-------|
| `.github/prompts/*.prompt.md` | Workspace |
| `<profile>/prompts/*.prompt.md` | User profile |

## Frontmatter

```yaml
---
description: "<required>"    # Prompt description for discovery
name: "Prompt Name"          # Optional, defaults to filename
agent: "agent"               # Optional: ask, edit, agent, or custom agent
tools: ["search", "web"]     # Optional: built-in, MCP (<server>/*), extension
model: "Claude Sonnet 4"     # Optional, uses picker default
---
```

## Template

```markdown
---
description: "Generate test cases for selected code"
agent: "agent"
---
Generate comprehensive test cases for the provided code:
- Include edge cases and error scenarios
- Follow existing test patterns in the codebase
- Use descriptive test names
```

**Context references**: Use Markdown links for files (`[config](./config.json)`) and `#tool:<name>` for tools.

## Invocation

- **Chat**: Type `/` → select prompt
- **Command**: `Chat: Run Prompt...`
- **Editor**: Open prompt file → play button

**Tip**: Use `chat.promptFilesRecommendations` to show prompts as actions when starting a new chat.

## When to Use

- Generate test cases for specific code
- Create READMEs from specs
- Summarize metrics with custom parameters
- One-off generation tasks

## Core Principles

1. **Single task focus**: One prompt = one well-defined task
2. **Output examples**: Show expected format when quality depends on structure
3. **Reuse over duplication**: Reference instruction files instead of copying

## Anti-patterns

- **Multi-task prompts**: "create and test and deploy" in one prompt
- **Vague descriptions**: Descriptions that don't help users understand when to use
- **Over-tooling**: Many tools when the task only needs search or file access