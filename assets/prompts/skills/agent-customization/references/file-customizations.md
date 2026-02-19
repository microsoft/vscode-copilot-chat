# File Customizations

## [Workspace Instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)

Guidelines that automatically apply to all chat requests across your entire workspace.

### File Types (Choose One)

| File | Location | Purpose |
|------|----------|---------|
| `copilot-instructions.md` | `.github/` | Project-wide standards (recommended, cross-editor) |
| `AGENTS.md` | Root or subfolders | Open standard, monorepo hierarchy support |

Use **only one**—not both.

### AGENTS.md Hierarchy

For monorepos, the closest file in the directory tree takes precedence:

```
/AGENTS.md              # Root defaults
/frontend/AGENTS.md     # Frontend-specific (overrides root)
/backend/AGENTS.md      # Backend-specific (overrides root)
```

### Template

```markdown
# Project Guidelines

## Code Style
{Language and formatting preferences—reference key files that exemplify patterns}

## Architecture
{Major components, service boundaries, the "why" behind structural decisions}

## Build and Test
{Commands to install, build, test—agents will attempt to run these}

## Conventions
{Patterns that differ from common practices—include specific examples}
```

For large repos, link to detailed docs instead of embedding: `See docs/TESTING.md for test conventions.`

## [File Instructions (.instructions.md)](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)

Guidelines loaded on-demand when relevant to the current task, or explicitly when files match a pattern.

### Locations

| Path | Scope |
|------|-------|
| `.github/instructions/*.instructions.md` | Workspace |
| `<profile>/instructions/*.instructions.md` | User profile |

### Frontmatter

```yaml
---
description: "<required>"    # For on-demand discovery—keyword-rich
name: "Instruction Name"     # Optional, defaults to filename
applyTo: "**/*.ts"           # Optional, auto-attach for matching files
---
```

### Discovery Modes

| Mode | Trigger | Use Case |
|------|---------|----------|
| **On-demand** (`description`) | Agent detects task relevance | Task-based: migrations, refactoring, API work |
| **Explicit** (`applyTo`) | Files matching glob in context | File-based: language standards, framework rules |
| **Manual** | `Add Context` → `Instructions` | Ad-hoc attachment |

### Template

```markdown
---
description: "Use when writing database migrations, schema changes, or data transformations. Covers safety checks and rollback patterns."
---
# Migration Guidelines

- Always create reversible migrations
- Test rollback before merging
- Never drop columns in the same release as code removal
```

Note the "Use when..." pattern in the description—this helps on-demand discovery.

### applyTo Patterns

```yaml
applyTo: "**"                           # ALWAYS included (use with caution—burns context tokens)
applyTo: "**/*.py"                      # All Python files
applyTo: ["src/**", "lib/**"]           # Multiple patterns (OR)
applyTo: "src/api/**/*.ts"              # Specific folder + extension
```

Applied when creating or modifying matching files, not for read-only operations.

## [Prompts (.prompt.md)](https://code.visualstudio.com/docs/copilot/customization/prompt-files)

Reusable task templates triggered on-demand in chat. Single focused task with parameterized inputs.

### Locations

| Path | Scope |
|------|-------|
| `.github/prompts/*.prompt.md` | Workspace |
| `<profile>/prompts/*.prompt.md` | User profile |

### Frontmatter

```yaml
---
description: "<recommended>"
name: "Prompt Name"          # Optional, defaults to filename
argument-hint: "Task..."     # Optional: hint shown in chat input
agent: "agent"               # Optional: ask, agent, plan, or custom agent
model: "GPT-5 (copilot)"     # Optional: selected model, or fallback array
tools: ["search", "web"]     # Optional: built-in, tool sets, MCP, extension
---
```

### Template

```markdown
---
description: "Generate test cases for selected code"
agent: "agent"
---
Generate comprehensive test cases for the provided code:
- Include edge cases and error scenarios
- Follow existing test patterns in the codebase
```

**Context references**: Use Markdown links for files (`[config](./config.json)`) and `#tool:<name>` for tools.

### Invocation

- **Chat**: Type `/` → select from prompts and skills
- **Command**: `Chat: Run Prompt...`

**Tip**: Use `chat.promptFilesRecommendations` to show prompts as actions when starting a new chat.

## Core Principles (All File Types)

1. **Keyword-rich descriptions**: Include trigger words for on-demand discovery
2. **One concern per file**: Separate files for testing, styling, documentation
3. **Concise and actionable**: Share context window—keep focused
4. **Show, don't tell**: Brief code examples over lengthy explanations
5. **Link, don't embed**: Reference docs instead of copying

## Anti-patterns

- **Vague descriptions**: "Helpful coding tips" doesn't enable discovery
- **Overly broad applyTo**: `"**"` with content only relevant to specific files
- **Using both workspace file types**: Having both `copilot-instructions.md` and `AGENTS.md`
- **Kitchen sink workspace instructions**: Everything instead of what matters most
- **Multi-task prompts**: "create and test and deploy" in one prompt
- **Mixing concerns**: Testing + API design + styling in one file
