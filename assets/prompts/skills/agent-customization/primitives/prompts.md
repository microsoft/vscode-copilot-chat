# [Prompts (.prompt.md)](https://code.visualstudio.com/docs/copilot/customization/prompt-files)

Reusable task templates triggered on-demand in chat.

## Locations

| Path | Scope |
|------|-------|
| `.github/prompts/*.prompt.md` | Workspace |
| `<profile>/prompts/*.prompt.md` | User profile |

## Frontmatter

```yaml
---
description: "<required>"    # Prompt description
name: "Prompt Name"          # Optional, defaults to filename
agent: "agent"               # Optional: ask, edit, agent, or custom agent
tools: ["search", "fetch"]   # Optional: built-in, MCP (<server>/*), extension
model: "Claude Sonnet 4"     # Optional, uses picker default
argument-hint: "Task..."     # Optional, input guidance
---
```

## Variables

| Syntax | Description |
|--------|-------------|
| `${workspaceFolder}` | Workspace path |
| `${file}`, `${fileBasename}` | Current file |
| `${selection}`, `${selectedText}` | Editor selection |
| `${input:varName}` | Prompt user for input |
| `${input:varName:placeholder}` | With placeholder text |

**Context references**: Use Markdown links for files, `#tool:<name>` for tools.

## Template

```markdown
---
name: "Create React Form"
description: "Generate a React form component"
argument-hint: "Provide form requirements"
---
Generate a React form component with the following requirements:
- Use TypeScript and functional components
- Include form validation
- Follow existing patterns in #tool:codebase
```

## Invocation

- Chat: Type `/` → select prompt (add extra info: `/create-form formName=MyForm`)
- Command: `Chat: Run Prompt...`
- Editor: Open prompt file → play button in title bar

**Tip**: Use `chat.promptFilesRecommendations` to show prompts as actions when starting a new chat.

## Tool Priority

When prompt references an agent, tools are resolved: prompt tools → agent tools → default agent tools.

## When to Use

**Key Signal**: Single focused task with parameterized inputs. Reusable prompt run once per task with different inputs each time.

- Generate test cases for specific code
- Summarize metrics with custom parameters
- Create READMEs from specs
- One-off generation tasks

## Creation Process

### 1. Gather Requirements

- What specific task should this prompt accomplish?
- What inputs/variables does the user need to provide?
- Should this be workspace-specific or personal (user profile)?
- Does it need specific tools or a particular agent mode?

### 2. Determine Location

| Scope | Path |
|-------|------|
| Workspace | `.github/prompts/<name>.prompt.md` |
| User profile | `<profile>/prompts/<name>.prompt.md` |

### 3. Create the File

```markdown
---
description: "<what this prompt does>"
argument-hint: "<guidance for user input>"
---
<Clear task instructions with ${variables} for user input>

<Examples of expected output if helpful>
```

### 4. Test the Prompt

- Ask the user to invoke with `/prompt-name` in chat
- Confirm output matches intended behavior

## Core Principles

1. **Single task focus**: One prompt = one well-defined task; don't combine unrelated operations
2. **Clear input contract**: Use `${input:varName:placeholder}` with descriptive placeholders
3. **Output examples**: Show expected output format when quality depends on specific structure
4. **Reuse over duplication**: Reference instruction files instead of copying guidelines
5. **Appropriate tooling**: Only specify `tools` when the task requires more than defaults

## Anti-patterns

- **Multi-task prompts**: Combining "create and test and deploy" in one prompt
- **Missing context**: Prompts that assume knowledge not provided in variables
- **Hardcoded values**: Embedding specific file paths or names instead of using variables
- **Vague descriptions**: Descriptions that don't help users understand when to use the prompt
- **Over-tooling**: Specifying many tools when the task only needs search or file access