# [Workspace Instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)

Guidelines that automatically apply to all chat requests across your entire workspace.

## File Types (Choose One)

Workspaces should have **only one** of these files—not both:

| File | Purpose |
|------|---------||
| `.github/copilot-instructions.md` | Project-wide coding standards and preferences (Recommended) |
| `AGENTS.md` | Same, but using an open standard |

## copilot-instructions.md

Single file at workspace root that applies to every chat request automatically.

**Location**: `.github/copilot-instructions.md`

### Template

```markdown
# Project Guidelines

## Code Style
- Use TypeScript strict mode
- Prefer functional components in React
- Follow existing patterns in the codebase

## Architecture
- Services use dependency injection
- All public APIs need JSDoc documentation

## Testing
- Write unit tests for business logic
- Use integration tests for API endpoints
```

### Cross-Editor Support

This file is also detected by GitHub Copilot in Visual Studio and GitHub.com, enabling shared instructions across editors.

## AGENTS.md

Instructions for projects using multiple AI agents. Placed at workspace root or in subfolders.

**Location**: Workspace root, or subfolders. Use `AGENTS.md` files in subfolders for different parts of your project (e.g., frontend vs backend).

## When to Use

- **General coding standards** that apply everywhere
- **Team preferences** shared through version control
- **Project-wide requirements** like testing standards or documentation rules

**Key Signal**: Context that's always available. Standards, guidelines, and expectations that apply broadly across work.

## Domain Examples

| Domain | Examples |
|--------|----------|
| Engineering | TypeScript strict mode, test coverage, accessibility (WCAG 2.1 AA) |
| Product | User stories in briefs, accessibility/i18n in specs |
| Data | SQL query comments, metric definitions linked |
| Support | Empathetic tone, escalation includes impact/context |
| Design | Use shared component library, include error states |

## Creation Process

### 1. Assess Existing Instructions

Check if a workspace instructions file already exists:
- `.github/copilot-instructions.md`
- `AGENTS.md` at workspace root

If one exists, update it rather than creating a second file. Workspaces should only have one.

### 2. Choose File Type (If None Exists)

| File | Best For |
|------|----------|
| `copilot-instructions.md` (Recommended) | VS Code/GitHub Copilot-specific, cross-editor support |
| `AGENTS.md` | Open standard, supports subfolder organization |

### 3. Create or Update

**For copilot-instructions.md**:
```
.github/copilot-instructions.md
```

**For AGENTS.md** (supports hierarchy):
```
/AGENTS.md              # Root-level defaults
/frontend/AGENTS.md     # Frontend-specific
/backend/AGENTS.md      # Backend-specific
```

### 4. Structure Content

Research existing guidelines and conventions in the workspace using a subagent as needed.

```markdown
# Project Guidelines

## Code Style
<Language and formatting preferences>

## Architecture
<Patterns and structure conventions>

## Testing
<Coverage and testing requirements>
```

## Core Principles

1. **Concise and actionable**: Every line should guide behavior—remove filler prose
2. **Project-specific focus**: Include conventions not obvious from reading the code
3. **Link, don't duplicate**: Reference READMEs, ADRs, and docs instead of copying
4. **Keep current**: Update when practices change—stale instructions cause confusion

## Anti-patterns

- **Using both file types**: Having both `copilot-instructions.md` and `AGENTS.md` in the same workspace
- **Duplicating project docs**: Copying README or CONTRIBUTING content instead of linking to them
- **Obvious instructions**: Stating conventions already enforced by linters or obvious from code
- **Verbose prose**: Long explanations instead of clear, scannable guidelines
- **Stale content**: Instructions that no longer match actual project practices
- **Kitchen sink**: Trying to include every possible guideline instead of focusing on what matters most