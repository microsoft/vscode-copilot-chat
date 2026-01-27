# [File-Specific Instructions (.instructions.md)](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)

Conditional guidelines that apply to specific file types, folders, or tasks using glob patterns.

## Locations

| Path | Scope |
|------|-------|
| `.github/instructions/*.instructions.md` | Workspace |
| `<profile>/instructions/*.instructions.md` | User profile (cross-workspace) |

## Frontmatter

```yaml
---
description: "<required>"    # For on-demand discovery (like skills)
name: "Instruction Name"     # Optional, defaults to filename
applyTo: "**/*.ts"           # Optional, explicit trigger for file patterns
---
```

## applyTo Patterns

| Pattern | Effect |
|---------|--------|
| `"**"` | Always include |
| `"**/*.ts"` | Match .ts files |
| `["src/**", "lib/**"]` | Match multiple (OR) |
| `"**/test/**"` | Match paths containing test |
| `"src/api/**/*.ts"` | Match specific folder + extension |

**Trigger**: Applied when creating or modifying files that match the pattern. Not applied for read-only operations.

**No applyTo**: Instructions can still be loaded implicitly via `description` matching, or manually attached via `Add Context > Instructions`.

## Template

```markdown
---
description: "TypeScript coding standards"
applyTo: "**/*.ts"
---
# TypeScript Guidelines

- Use `interface` for object shapes, `type` for unions
- Avoid `any`, enable strict mode
- JSDoc for public APIs
- Reference tools with #tool:<name> syntax
```

## Examples

### Language-Specific

```yaml
# python-standards.instructions.md
---
description: "Python coding standards"
applyTo: "**/*.py"
---
```

### Framework-Specific

```yaml
# react-components.instructions.md
---
description: "React component patterns"
applyTo: ["src/components/**", "src/pages/**"]
---
```

### Folder-Specific

```yaml
# backend-api.instructions.md
---
description: "Backend API conventions"
applyTo: "src/api/**"
---
```

### Task-Based (On-Demand)

```yaml
# database-migrations.instructions.md
---
description: "Database migration patterns and best practices"
# No applyTo—loaded implicitly when the agent detects migration-related tasks
---
```

## Invocation

- **Explicit (applyTo)**: Auto-attaches when files matching the glob pattern are in context (creating/modifying)
- **Implicit (description)**: Agent loads on-demand when the description fits the current task—like skills
- **Manual**: Chat view → `Add Context` → `Instructions`
- **Configure**: Chat view → gear icon → `Chat Instructions`
- **New file**: `Chat: New Instructions File` command

## Settings

| Setting | Purpose |
|---------|---------|
| `chat.instructionsFilesLocations` | Additional folders to search for `.instructions.md` |

## Task-Specific Settings (deprecated)

Prefer `.instructions.md` files. Legacy settings for specific workflows:

| Setting | Scenario |
|---------|----------|
| `github.copilot.chat.reviewSelection.instructions` | Code review |
| `github.copilot.chat.commitMessageGeneration.instructions` | Commit messages |
| `github.copilot.chat.pullRequestDescriptionGeneration.instructions` | PR descriptions |

## When to Use

- **Language-specific rules** (Python style, TypeScript patterns) → use `applyTo`
- **Framework conventions** (React, Vue, backend frameworks) → use `applyTo`
- **Folder-based guidelines** (frontend vs backend, tests vs source) → use `applyTo`
- **Task-focused instructions** (API development, migrations, refactoring) → rely on `description` for on-demand loading

**Key Signal**: Use `applyTo` when the instruction is file-based; use a descriptive `description` when the instruction is task-based.

## Creation Process

### 1. Gather Requirements

- **File-based or task-based?** Use `applyTo` for file patterns; omit for task-focused instructions loaded via `description`
- What file types, folders, or patterns should this apply to?
- What coding standards, conventions, or guidelines are needed? Research current codebase using a subagent if needed.
- Should this be workspace-specific or personal (user profile)?

### 2. Determine Location

| Scope | Path |
|-------|------|
| Workspace | `.github/instructions/<name>.instructions.md` |
| User profile | `<profile>/instructions/<name>.instructions.md` |

### 3. Create the File

```markdown
---
description: "<clear, concise description>"
applyTo: "<glob pattern or array>"  # Optional—omit for task-based instructions
---
# <Title>

<Guidelines organized by topic>
```

### 4. Verify Activation

- For `applyTo` patterns: Create or edit a matching file to confirm auto-attachment
- For `description`-based: Perform a task matching the description and verify the instruction is loaded
- For manual instructions: Add via `Add Context > Instructions` in chat

## Core Principles

1. **Keyword-rich descriptions**: The `description` frontmatter is how instructions are discovered—include relevant trigger words and use cases
2. **One concern per file**: Layer multiple instruction files for different concerns (e.g., separate files for testing, styling, documentation)
3. **Concise and actionable**: Instructions share context window with conversation—keep them focused
4. **Show, don't tell**: Include brief code examples over lengthy explanations
5. **Pattern precision**: Use specific `applyTo` patterns to avoid over-matching (e.g., `src/api/**/*.ts` not `**/*.ts`)
6. **Reference, don't duplicate**: Use `#tool:<name>` and Markdown links instead of copying content

## Anti-patterns

- **Vague descriptions**: Generic descriptions that don't help discovery (e.g., "Helpful coding tips")
- **Overly broad patterns**: `applyTo: "**"` with content only relevant to specific files
- **Duplicating project docs**: Copying README or CONTRIBUTING content instead of linking
- **Mixing concerns**: Combining unrelated guidelines (testing + API design + styling) in one file
- **Stale instructions**: Guidelines that contradict current codebase patterns
- **Verbose prose**: Long paragraphs instead of actionable bullet points